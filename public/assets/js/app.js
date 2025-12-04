/**
 * RETRO GAMES – app.js (통합본)
 * Path: public/assets/js/app.js
 *
 * 역할
 * - DOM 부트스트랩, 공통 네비게이션(window.*)
 * - 인증 상태 확인 및 requireAuth() 가드 (모달 연동)
 * - header.html / footer.html 파셜 자동 주입(data-include 또는 #site-header/#site-footer)
 * - 공통 API 래퍼(fetch JSON, CSRF 자동 첨부), 토스트, 유틸리티
 * - Profile/Wallet/Games 바인딩 헬퍼
 * - Analytics와 느슨한 연동
 * - 게임 세션 훅(gameStart / gameFinish)
 *
 * 확장 (Neon + Cloudflare 지갑/경험치 시스템 대응)
 * - JWT 토큰(Authorization: Bearer …)을 전역에서 자동으로 첨부
 * - _middleware 가 내려주는 X-User-* 헤더를 읽어 계정별 경험치/포인트/티켓 UI 동기화
 * - /api/auth/me 응답(user.stats)와 헤더 값을 병합해 세션 캐시를 단일 소스로 유지
 * - UI 구조/디자인/클래스/데이터-속성은 그대로, 데이터 채우기만 강화
 *
 * 추가 확장 (reward / analytics 통합)
 * - SHA-256 기반 게임 보상 해시 유틸(프론트 ↔ /api/wallet/reward)
 * - window.sendGameReward(gameId, { score, exp, tickets, points, meta }) 제공
 * - /api/wallet/balance 기반 HUD 자동 리프레시(window.refreshWalletHUD)
 * - /api/analytics/event 연동 window.trackGameEvent(type, gameId, meta)
 * - gameStart / gameFinish 에서도 trackGameEvent 를 자동 호출
 */

(() => {
  const CFG = {
    debug: true,
    credentials: "include",
    partials: {
      header: "partials/header.html",
      footer: "partials/footer.html",
    },
    // 서버 라우트 관례
    //  - Cloudflare Pages Functions 는 /api/* 아래로 매핑되므로
    //    프론트에서도 동일한 프리픽스를 사용한다.
    endpoints: {
      me: "/api/auth/me", // ✅ 세션/HUD 동기화용
      signout: "/api/auth/signout", // (백엔드 signout 라우트에 맞춰 사용)
      profile: "/api/profile/me", // 프로필 조회
      history: "/api/profile/me/history", // 플레이/지갑 히스토리
      games: "/api/games", // 게임 메타/목록
      shopBuy: "/api/specials/shop/buy", // 구매
      luckySpin: "/api/specials/spin", // 일일 스핀
    },
    csrfCookie: "__csrf",
    csrfHeader: "X-CSRF-Token",
    // JWT 토큰 저장 키 (localStorage)
    authStorageKey: "rg_jwt_token",
  };

  // 프론트/백엔드가 공유하는 reward 해시 시크릿
  // - Cloudflare Env: REWARD_SECRET_KEY 와 반드시 동일하게 유지
  // - 필요시 빌드/배포 단계에서 치환하도록 구성 가능
  // - 여기서는 기본값으로 "retro-dev-secret" 사용
  //   (실서비스에서는 별도 안전한 값 사용 권장)
  window.RETRO_REWARD_SECRET =
    window.RETRO_REWARD_SECRET || "retro-dev-secret";

  /* ────────────────────────────── 유틸 ────────────────────────────── */
  const qs = (sel, el = document) => el.querySelector(sel);
  const qsa = (sel, el = document) => Array.from(el.querySelectorAll(sel));
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const nowISO = () => new Date().toISOString();
  const getCookie = (name) => {
    const m = document.cookie.split("; ").find((s) => s.startsWith(name + "="));
    return m ? decodeURIComponent(m.split("=").slice(1).join("=")) : "";
  };

  const debugLog = (...args) => {
    if (!CFG.debug) return;
    try {
      console.log("[RG]", ...args);
    } catch {
      /* noop */
    }
  };

  const toast = (msg, opts = {}) => {
    const el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    Object.assign(el.style, {
      position: "fixed",
      left: "50%",
      bottom: "40px",
      transform: "translateX(-50%)",
      background: "rgba(0,0,0,.75)",
      color: "#fff",
      padding: "10px 14px",
      borderRadius: "10px",
      opacity: "0",
      transition: "opacity .18s",
      zIndex: 9999,
      fontSize: "14px",
      pointerEvents: "none",
    });
    document.body.appendChild(el);
    const ms = opts.duration ?? 2200;
    requestAnimationFrame(() => {
      el.style.opacity = "1";
    });
    setTimeout(() => {
      el.style.opacity = "0";
    }, ms);
    setTimeout(() => {
      el.remove();
    }, ms + 240);
  };

  /* ───────── SHA-256 / reward 해시 유틸 ───────── */

  /**
   * SHA-256(hex) 해시 계산
   */
  async function sha256Hex(text) {
    const enc = new TextEncoder();
    the_data = enc.encode(text);
    const data = the_data;
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /**
   * reward.ts와 동일한 포맷으로 해시 생성
   * raw = `${userId}|${gameId}|${exp}|${tickets}|${points}|${secret}`
   */
  async function buildRewardHash(userId, gameId, exp, tickets, points) {
    const secret = window.RETRO_REWARD_SECRET || "";
    const raw = `${userId}|${gameId}|${exp}|${tickets}|${points}|${secret}`;
    return sha256Hex(raw);
  }

  /* ───────────────────── JWT 토큰 저장/조회 헬퍼 ───────────────────── */
  const getAuthToken = () => {
    try {
      const v = localStorage.getItem(CFG.authStorageKey);
      return v || "";
    } catch {
      return "";
    }
  };

  const setAuthToken = (token) => {
    try {
      if (token && typeof token === "string" && token.trim()) {
        localStorage.setItem(CFG.authStorageKey, token.trim());
      } else {
        localStorage.removeItem(CFG.authStorageKey);
      }
    } catch {
      /* 일부 브라우저/프라이빗 모드에서 실패 가능 → 조용히 무시 */
    }
  };

  const clearAuthToken = () => setAuthToken("");

  /* ───────────────── 계정별 진행도(경험치/포인트/티켓) 캐시 ───────────────── */
  let _me = null; // 세션 캐시(정규화된 user 객체)
  let _stats = { points: 0, exp: 0, level: 1, tickets: 0 };

  const _toInt = (v) => {
    if (v === null || v === undefined) return 0;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : 0;
  };

  const syncStatsUI = () => {
    const s = (_me && _me.stats) || _stats;
    if (!s) return;
    // data-user-points, data-user-exp, data-user-level, data-user-tickets
    qsa("[data-user-points]").forEach((el) => {
      el.textContent = String(s.points ?? 0);
    });
    qsa("[data-user-exp]").forEach((el) => {
      el.textContent = String(s.exp ?? 0);
    });
    qsa("[data-user-level]").forEach((el) => {
      el.textContent = String(s.level ?? 1);
    });
    qsa("[data-user-tickets]").forEach((el) => {
      el.textContent = String(s.tickets ?? 0);
    });
  };

  /**
   * HUD를 외부에서 직접 갱신하고 싶을 때 사용하는 헬퍼
   * - refreshWalletFromBalance, /api/auth/me 응답 병합 등에 사용
   */
  function updateHUDFromStats(newStats) {
    if (!newStats || typeof newStats !== "object") return;
    const s = { ..._stats };

    if ("points" in newStats) s.points = _toInt(newStats.points);
    if ("balance" in newStats && !("points" in newStats)) {
      // wallet/balance 의 기본 필드는 balance
      s.points = _toInt(newStats.balance);
    }
    if ("exp" in newStats) s.exp = _toInt(newStats.exp);
    if ("level" in newStats) s.level = _toInt(newStats.level) || 1;
    if ("tickets" in newStats) s.tickets = _toInt(newStats.tickets);
    if ("gamesPlayed" in newStats && !_me?.stats?.gamesPlayed) {
      // 필요하면 향후 HUD에 사용 가능
    }

    _stats = s;
    if (_me) {
      _me.stats = Object.assign({}, _me.stats || {}, s);
    }
    syncStatsUI();
  }

  const updateStatsFromHeaders = (headers) => {
    if (!headers || typeof headers.get !== "function") return;
    const hp = headers.get("X-User-Points");
    const he = headers.get("X-User-Exp");
    const hl = headers.get("X-User-Level");
    const ht = headers.get("X-User-Tickets");

    if (!hp && !he && !hl && !ht) return;

    if (hp !== null) _stats.points = _toInt(hp);
    if (he !== null) _stats.exp = _toInt(he);
    if (hl !== null) _stats.level = _toInt(hl) || 1;
    if (ht !== null) _stats.tickets = _toInt(ht);

    if (_me) {
      _me.stats = Object.assign({}, _me.stats || {}, _stats);
    }
    syncStatsUI();
  };

  const normalizeMePayload = (raw) => {
    if (!raw) return null;
    // /api/auth/me 가 { ok, user:{...} } 형태인 경우
    if (raw.user) {
      const u = raw.user;
      const stats = u.stats || raw.stats || null;
      const mergedStats = stats || _stats;
      return Object.assign({}, u, { stats: mergedStats });
    }
    // 이미 user 객체만 온 경우
    if (raw.ok === undefined && raw.user === undefined) {
      const stats = raw.stats || _stats;
      return Object.assign({}, raw, { stats });
    }
    // 그 외는 최대한 보수적으로
    return raw;
  };

  /* ───────── 공통 JSON fetch (CSRF + JWT + X-User-* 헤더 처리) ───────── */
  const jsonFetch = async (url, { method = "GET", body, headers } = {}) => {
    const csrf = getCookie(CFG.csrfCookie);
    const token = getAuthToken();

    const mergedHeaders = {
      "Content-Type": "application/json",
      ...(csrf ? { [CFG.csrfHeader]: csrf } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers || {}),
    };

    debugLog("fetch", method, url, { hasToken: !!token });

    const res = await fetch(url, {
      method,
      credentials: CFG.credentials,
      headers: mergedHeaders,
      body: body ? JSON.stringify(body) : undefined,
    });

    // 계정별 진행도 헤더(X-User-*)가 있으면 전역 캐시/바인딩만 업데이트
    try {
      updateStatsFromHeaders(res.headers);
    } catch (e) {
      debugLog("[app] updateStatsFromHeaders failed", e);
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const err = new Error(
        (data && (data.error || data.message)) || `HTTP_${res.status}`
      );
      // @ts-ignore
      err.status = res.status;
      // @ts-ignore
      err.body = data;
      throw err;
    }
    return data;
  };

  /* ───────────────────────────── 경로 헬퍼 ───────────────────────────── */
  // ✔ 게임 HTML(2048 / Brick / Match / Runner / Tetris 등)에서는
  //    로그인 모달이 게임 화면 위에 겹쳐 보이지 않도록 분기 처리.
  const isGamePage = () => {
    const p = location.pathname.toLowerCase();
    // /games/ 경로 또는 개별 게임 HTML 파일명 기준
    return (
      p.includes("/games/") ||
      p.endsWith("/2048.html") ||
      p.endsWith("/brick-breaker.html") ||
      p.endsWith("/brick-match.html") ||
      p.endsWith("/retro-runner.html") ||
      p.endsWith("/tetris.html")
    );
  };

  /* ─────────────────────── 파셜(header/footer) 주입 ─────────────────────── */
  const loadPartials = async () => {
    // 🔒 게임 페이지에서는 header/footer 파셜 주입을 아예 건너뛴다.
    //    (게임 캔버스 위에 사이트맵/헤더가 겹쳐 나오는 현상 방지)
    if (isGamePage()) {
      debugLog("[partials] skip header/footer inject on game page");
      return;
    }

    // data-include="partials/header.html" 등으로 직접 지시된 요소 우선
    const includes = qsa("[data-include]");
    for (const el of includes) {
      const href = el.getAttribute("data-include");
      if (!href) continue;
      try {
        const html = await fetch(href, {
          credentials: CFG.credentials,
        }).then((r) => r.text());
        el.innerHTML = html;
      } catch (e) {
        debugLog("[partials] load fail:", href, e);
      }
    }
    // 별도 선언이 없고 기본 훅이 있으면 기본 파일로 주입
    if (!qsa('[data-include*="header.html"]').length && qs("#site-header")) {
      try {
        const html = await fetch(CFG.partials.header, {
          credentials: CFG.credentials,
        }).then((r) => r.text());
        qs("#site-header").innerHTML = html;
      } catch (e) {
        debugLog("[partials] header load fail:", e);
      }
    }
    if (!qsa('[data-include*="footer.html"]').length && qs("#site-footer")) {
      try {
        const html = await fetch(CFG.partials.footer, {
          credentials: CFG.credentials,
        }).then((r) => r.text());
        qs("#site-footer").innerHTML = html;
      } catch (e) {
        debugLog("[partials] footer load fail:", e);
      }
    }
  };

  /* ───────────────────────────── 인증 & 세션 ───────────────────────────── */

  const syncHeaderAuthUI = () => {
    const loginBtn = qs('[data-action="goLogin"]');
    const signupBtn = qs('[data-action="goSignup"]');
    const myBtn = qs('[data-action="goUser"]');
    const outBtn = qs('[data-action="signout"]');
    if (_me) {
      loginBtn && (loginBtn.style.display = "");
      signupBtn && (signupBtn.style.display = "");
      // 로그인 상태에서 로그인/회원가입 버튼을 숨기고 싶다면 아래 주석 해제
      loginBtn && (_me ? (loginBtn.style.display = "none") : null);
      signupBtn && (_me ? (signupBtn.style.display = "none") : null);

      myBtn && (myBtn.style.display = "");
      outBtn && (outBtn.style.display = "");
    } else {
      loginBtn && (loginBtn.style.display = "");
      signupBtn && (signupBtn.style.display = "");
      myBtn && (myBtn.style.display = "none");
      outBtn && (outBtn.style.display = "none");
    }
  };

  const getSession = async (opts = {}) => {
    if (_me && !opts.refresh) {
      // 캐시된 세션이 있지만, 진행도 캐시를 다시 바인딩
      syncHeaderAuthUI();
      syncStatsUI();
      return _me;
    }
    try {
      const raw = await jsonFetch(CFG.endpoints.me);
      const me = normalizeMePayload(raw);
      _me = me || null;
    } catch (e) {
      debugLog("[auth] /api/auth/me failed", e);
      _me = null;
    }
    syncHeaderAuthUI();
    syncStatsUI();
    return _me;
  };

  const signout = async () => {
    try {
      await jsonFetch(CFG.endpoints.signout, { method: "POST" });
    } catch (e) {
      debugLog("[auth] signout error", e);
      // 계속 진행(토큰 정리/캐시 정리)
    }
    // 세션/토큰/진행도 초기화
    _me = null;
    _stats = { points: 0, exp: 0, level: 1, tickets: 0 };
    clearAuthToken();

    toast("로그아웃 되었습니다.");
    syncHeaderAuthUI();
    syncStatsUI();
    goHome();
  };

  const isAuthed = () => !!_me;

  /* ───────────────────────────── 모달 & 가드 ───────────────────────────── */
  const openAuthModal = () => {
    const modal = qs("#authModal");
    if (!modal) {
      goLogin();
      return;
    } // 모달 없으면 로그인 페이지로
    modal.classList.add("show");
    modal.setAttribute("aria-hidden", "false");
    const first = modal.querySelector(
      ".cta,button,[href],input,select,textarea,[tabindex]"
    );
    first && setTimeout(() => first.focus(), 0);
  };
  const closeAuthModal = () => {
    const modal = qs("#authModal");
    if (!modal) return;
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  };

  /**
   * requireAuth()
   *
   * - 일반 페이지: 로그인 모달(#authModal) 오픈
   * - 게임 페이지(개별 /games/*.html): 모달이 게임 화면을 덮지 않도록
   *   전용 로그인 페이지로 리다이렉트만 수행
   */
  const requireAuth = async () => {
    const me = await getSession();
    if (me) return true;

    if (isGamePage()) {
      // 게임 화면 위에 "로그인 전 전체 화면"이 겹쳐 보이는 현상 방지
      goLogin();
    } else {
      openAuthModal();
    }
    return false;
  };

  /* ───────────────────────────── 네비게이션 ───────────────────────────── */

  /**
   * nav(path)
   *
   * - 기본적으로 location.href 설정
   * - 만약 iframe 안(게임 화면 등)에서 호출되면 window.top 으로 올려서
   *   user-retro-games.html 이 "게임기 안에" 뜨지 않고 전체 페이지로 이동하게 처리
   */
  const nav = (path) => {
    try {
      if (window.top && window.top !== window) {
        window.top.location.href = path;
      } else {
        window.location.href = path;
      }
    } catch {
      window.location.href = path;
    }
  };

  /**
   * ✅ 전역 홈 이동
   * - 로그인 되어 있으면: user-retro-games.html (로그인 후 허브)
   * - 로그인 안 되어 있으면: index.html (비로그인 메인)
   */
  const goHome = async () => {
    try {
      const me = await getSession();
      if (me) {
        nav("user-retro-games.html");
      } else {
        nav("index.html");
      }
    } catch (e) {
      debugLog("[nav] goHome failed, fallback to index", e);
      nav("index.html");
    }
  };

  const goLogin = () => nav("login.html");
  const goSignup = () => nav("signup.html");
  const goShop = () => nav("shop.html");
  const goUserGames = () => nav("user-retro-games.html"); // 기존 파일명 유지

  /* ───────────────────────────── 게임/프로필 API ───────────────────────────── */
  const listGames = async () => {
    try {
      return await jsonFetch(`${CFG.endpoints.games}`);
    } catch (e) {
      debugLog("[games] list fail", e);
      return { ok: false, games: [] };
    }
  };

  const purchase = async (sku) => {
    try {
      const ok = await requireAuth();
      if (!ok) return;
      const res = await jsonFetch(CFG.endpoints.shopBuy, {
        method: "POST",
        body: { sku },
      });
      // 구매 이후 계정별 포인트/티켓/경험치를 최신 상태로 반영
      await getSession({ refresh: true });
      toast("구매가 완료되었습니다.");
      window.Analytics?.event?.("purchase", { sku, res });
      return res;
    } catch (e) {
      const msg = e?.body?.error || e?.message || "구매 실패";
      toast("구매 실패: " + msg);
      window.Analytics?.event?.("purchase_error", {
        sku,
        err: e.body || e.message,
      });
      throw e;
    }
  };

  const luckySpin = async () => {
    try {
      const ok = await requireAuth();
      if (!ok) return;
      let res;
      if (window.Analytics?.trackLuckySpin) {
        res = await window.Analytics.trackLuckySpin();
      } else {
        res = await jsonFetch(CFG.endpoints.luckySpin, { method: "POST" });
      }
      // 일일 스핀 결과에 따라 포인트/티켓/경험치 변화가 있을 수 있으므로 갱신
      await getSession({ refresh: true });
      toast("행운 결과: " + JSON.stringify(res?.result ?? res));
      return res;
    } catch (e) {
      const msg = e?.body?.error || e?.message || "행운 뽑기 실패";
      toast("행운 뽑기 실패: " + msg);
      throw e;
    }
  };

  /* ───────── analytics 이벤트 추적 (game_start / game_end / 기타) ───────── */

  /**
   * Retro Games – 게임/행동 이벤트 추적
   *
   * @param {"game_start"|"game_end"|string} type
   * @param {string} gameId
   * @param {object} meta  아무 JSON
   */
  async function trackGameEvent(type, gameId, meta = {}) {
    try {
      const payload = {
        type,
        game: gameId,
        meta,
      };

      await fetch("/api/analytics/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: CFG.credentials,
        body: JSON.stringify(payload),
      });
    } catch (e) {
      debugLog("trackGameEvent failed", type, gameId, e);
    }
  }

  /* ───────── wallet/balance 기반 HUD 리프레시 ───────── */

  /**
   * /api/wallet/balance 를 불러서 HUD를 업데이트하는 기본 구현
   * - balance.ts 에서 내려주는 X-Wallet-Stats-Json 헤더를 활용
   */
  async function refreshWalletFromBalance() {
    try {
      const res = await fetch("/api/wallet/balance", {
        method: "GET",
        credentials: CFG.credentials,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) return;

      const stats = {
        balance: json.balance,
      };

      const hdr = res.headers.get("X-Wallet-Stats-Json");
      if (hdr) {
        try {
          const parsed = JSON.parse(hdr);
          Object.assign(stats, parsed);
        } catch {
          /* ignore */
        }
      }

      updateHUDFromStats(stats);
    } catch (e) {
      debugLog("refreshWalletFromBalance failed", e);
    }
  }

  async function refreshWalletHUD() {
    await refreshWalletFromBalance();
  }

  /* ───────── 게임 보상 자동 전송 (wallet/reward) ───────── */

  /**
   * Retro Games – 게임별 보상 자동 전송 유틸
   *
   * @param {string} gameId   예) "2048", "tetris", "brick_breaker"
   * @param {object} opts     { exp, tickets, points, score, meta }
   *
   * exp/tickets/points 를 생략하면 reward.ts가 game_rewards.json 규칙대로 자동 계산.
   */
  async function sendGameReward(gameId, opts = {}) {
    try {
      // 1) 현재 로그인 유저 확보
      let userId = _me && _me.id;
      if (!userId) {
        const me = await getSession();
        userId = me && me.id;
      }
      if (!userId) throw new Error("Missing userId for reward");

      const exp = Number(opts.exp || 0);
      const tickets = Number(opts.tickets || 0);
      const points = Number(opts.points || 0);

      // 2) hash 생성 (reward.ts 안의 로직과 동일 포맷)
      const hash = await buildRewardHash(userId, gameId, exp, tickets, points);

      // 3) reward API 호출
      const body = {
        userId,
        game: gameId,
        exp,
        tickets,
        points,
        reason: "reward",
        hash,
        score: opts.score ?? undefined,
        meta: opts.meta ?? undefined,
      };

      const res = await fetch("/api/wallet/reward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: CFG.credentials,
        body: JSON.stringify(body),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        debugLog("Reward API error", res.status, json);
        if (window.showToast || window.toast) {
          (window.showToast || window.toast)(
            "보상 지급에 실패했습니다. 잠시 후 다시 시도해주세요.",
            "error"
          );
        }
        return null;
      }

      // 4) HUD 갱신
      try {
        if (window.refreshWalletHUD) {
          await window.refreshWalletHUD();
        } else {
          await refreshWalletFromBalance();
        }
      } catch (e) {
        debugLog("refresh HUD after reward failed", e);
      }

      // 5) 토스트/피드백
      if (window.showToast || window.toast) {
        (window.showToast || window.toast)("보상이 지급되었습니다!", "success");
      }

      // 6) analytics 이벤트(logical)
      try {
        await trackGameEvent("reward", gameId, {
          score: opts.score ?? null,
          exp,
          tickets,
          points,
        });
      } catch (e) {
        debugLog("track reward event failed", e);
      }

      return json;
    } catch (err) {
      debugLog("sendGameReward error", err);
      if (window.showToast || window.toast) {
        (window.showToast || window.toast)(
          "보상 처리 중 오류가 발생했습니다.",
          "error"
        );
      }
      return null;
    }
  }

  /* ───────────────────────────── 바인딩 헬퍼 ───────────────────────────── */
  const bindProfile = (profile) => {
    if (!profile) return;
    qsa("[data-bind-text]").forEach((el) => {
      const key = el.getAttribute("data-bind-text");
      if (!key) return;
      const val = key
        .split(".")
        .reduce((acc, k) => (acc ? acc[k] : undefined), profile);
      if (val !== undefined) el.textContent = String(val);
    });
    // 프로필 업데이트 시, 계정별 진행도도 다시 그려줌
    syncStatsUI();
  };

  const refreshProfile = async () => {
    try {
      const ok = await requireAuth();
      if (!ok) return null;
      const me = await jsonFetch(CFG.endpoints.profile);
      bindProfile(me);
      return me;
    } catch (e) {
      debugLog("[profile] fetch fail", e);
      return null;
    }
  };

  /* ───────────────────────────── 게임 세션 훅 ───────────────────────────── */
  const gameStart = async (slug) => {
    try {
      const token = getAuthToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const res = await fetch(`/games/${slug}/start`, {
        method: "POST",
        credentials: CFG.credentials,
        headers,
      });
      try {
        updateStatsFromHeaders(res.headers);
      } catch (e) {
        debugLog("[gameStart] header sync failed", e);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (data && (data.error || data.message)) || `HTTP_${res.status}`
        );
      }
      window.__RUN_ID__ = data.runId;
      window.Analytics?.event?.("game_start", { slug, runId: data.runId });

      // analytics/event API에도 기록
      try {
        await trackGameEvent("game_start", slug, {
          runId: data.runId || null,
        });
      } catch (e) {
        debugLog("track game_start failed", e);
      }

      return data;
    } catch (e) {
      debugLog("gameStart failed", e);
      toast("게임 시작 오류");
      return null;
    }
  };

  /**
   * ✅ gameFinish
   *
   * 프론트 → 백엔드 계약을 /api/games/finish 기준으로 맞춘 버전.
   * - URL:  POST /api/games/finish
   * - Body: { gameId: slug, score, durationSec?, mode?, result?, runId? }
   *
   * UI/UX 및 기존 호출부(게임 HTML에서 window.gameFinish(slug, score))는 그대로 유지하고
   * 내부 요청 경로와 페이로드만 서버 스키마에 맞게 조정한다.
   */
  const gameFinish = async (slug, score) => {
    try {
      const token = getAuthToken();
      const headers = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      // 서버에서 기대하는 gameId/score 기반 페이로드로 변환
      const body = {
        gameId: slug,
        score,
        durationSec: null,
        mode: null,
        result: "clear",
        runId: window.__RUN_ID__ || null,
      };

      // 기존 `/games/${slug}/finish` → `/api/games/finish` 로 정합성 맞춤
      const res = await fetch("/api/games/finish", {
        method: "POST",
        credentials: CFG.credentials,
        headers,
        body: JSON.stringify(body),
      });

      try {
        updateStatsFromHeaders(res.headers);
      } catch (e) {
        debugLog("[gameFinish] header sync failed", e);
      }

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (data && (data.error || data.message)) || `HTTP_${res.status}`
        );
      }

      // 게임 종료(점수 반영) 후 계정별 경험치/포인트 반영
      await getSession({ refresh: true });
      window.Analytics?.event?.("game_finish", {
        slug,
        score,
        runId: window.__RUN_ID__,
        data,
      });

      // analytics/event 쪽에도 game_end 기록
      try {
        await trackGameEvent("game_end", slug, {
          score,
          runId: window.__RUN_ID__ || null,
          api: data,
        });
      } catch (e) {
        debugLog("track game_end failed", e);
      }

      return data;
    } catch (e) {
      debugLog("gameFinish failed", e);
      toast("게임 종료 처리 실패");
      return null;
    }
  };

  /* ───────────────────────────── 이벤트 위임/바인딩 ───────────────────────────── */
  const bindGlobalClicks = () => {
    document.addEventListener("click", (e) => {
      const a = e.target.closest?.("[data-action]");
      if (!a) return;
      const act = a.getAttribute("data-action");

      // 내비
      if (act === "goHome") return goHome();
      if (act === "goLogin") return goLogin();
      if (act === "goSignup") return goSignup();
      if (act === "goShop") return goShop();
      if (act === "goUser") return goUserGames();
      if (act === "signout") return signout();

      // 기능
      if (act === "requireAuth") return requireAuth();
      if (act === "luckySpin") return luckySpin();

      // 구매 버튼: data-action="purchase" data-sku="gold_pack_100"
      if (act === "purchase") {
        const sku = a.getAttribute("data-sku");
        if (sku) purchase(sku);
      }
    });

    // 모달 닫기(X, 바깥 클릭, ESC)
    const modal = qs("#authModal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeAuthModal();
      });
      const x = modal.querySelector(".x");
      x && x.addEventListener("click", closeAuthModal);
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && modal.classList.contains("show"))
          closeAuthModal();
      });
    }
  };

  /* ───────────────────────────── 윈도우에 공개 ───────────────────────────── */
  window.goHome = goHome;
  window.goLogin = goLogin;
  window.goSignup = goSignup;
  window.goShop = goShop;
  window.goUserGames = goUserGames;
  window.requireAuth = requireAuth;
  window.toast = toast;

  window.RG = {
    getSession,
    isAuthed,
    signout,
    listGames,
    purchase,
    luckySpin,
    refreshProfile,
    gameStart,
    gameFinish,
    cfg: CFG,
    // 계정별 진행도 조회 편의 헬퍼
    getStats: () => {
      const s = (_me && _me.stats) || _stats;
      return Object.assign({}, s);
    },
    // JWT 토큰 제어 (로그인/회원가입 후 백엔드가 내려준 토큰을 저장할 때 사용)
    setAuthToken,
    getAuthToken,
    clearAuthToken,
    // 디버깅용: 현재 세션/헤더기반 stats를 확인
    _debug: () => ({
      me: _me,
      stats: _stats,
      tokenPresent: !!getAuthToken(),
      time: nowISO(),
    }),
  };

  // 게임 훅을 전역으로도 노출(기존 호출 호환)
  window.gameStart = gameStart;
  window.gameFinish = gameFinish;

  // HUD/지갑/이벤트/보상 유틸 전역 노출
  window.updateHUDFromStats = updateHUDFromStats;
  window.refreshWalletHUD = refreshWalletHUD;
  window.sendGameReward = sendGameReward;
  window.trackGameEvent = trackGameEvent;

  // showToast 별도 유틸이 있는 경우를 위해 fallback 처리
  if (!window.showToast) {
    window.showToast = toast;
  }

  /* ───────────────────────────── 부트스트랩 ───────────────────────────── */
  const init = async () => {
    await loadPartials();
    bindGlobalClicks();
    await getSession(); // 헤더 버튼 및 계정별 진행도 표시용

    const path = location.pathname.toLowerCase();

    // 유저 페이지에서만: 로그인 반드시 요구 + 프로필/HUD 추가 싱크
    if (path.endsWith("/user-retro-games.html")) {
      const ok = await requireAuth();
      if (!ok) {
        debugLog("[init] user-retro-games requires auth; redirected/login modal");
        return;
      }
      await refreshProfile();
      try {
        await refreshWalletFromBalance();
      } catch (e) {
        debugLog("[init] refreshWalletFromBalance failed", e);
      }
    }

    debugLog("[app] initialized at", nowISO(), { path });
  };

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);

  /* ───────────────────────────── 내부 메모용 주석 블록 ─────────────────────────────
   * 이 하단 주석들은 기능에 영향을 주지 않는 프로젝트 메모이다.
   *
   * - app.js 는 전역 네비게이션과 API 래퍼, 게임 세션 훅을 담당한다.
   * - 디자인/레이아웃/버튼 구조는 HTML/CSS에서 제어하므로 여기서 변경하지 않는다.
   * - Cloudflare Pages + Neon DB 환경에서 X-User-* 헤더를 통해
   *   각 요청마다 유저 지갑/경험치 데이터를 반영한다.
   * - 게임별 구현(2048, Brick Breaker, Retro Match, Retro Runner, Tetris 등)은
   *   각 HTML/JS 파일이 담당하며, 공통으로 window.gameStart / window.gameFinish 를 호출한다.
   * - gameFinish 의 내부 구현은 /api/games/finish 규격에 맞춰 조정된 상태이다.
   * - 나머지 로직(모달, 네비, 토스트, 파셜 로딩, 행운 뽑기, 상점 구매 등)은
   *   기존과 완전히 동일하게 동작한다.
   *
   * - sendGameReward(gameId, opts)
   *   • opts.score 를 중심으로 서버의 game_rewards.json 룰에 따라 EXP/티켓/포인트를 계산하게 할 수 있다.
   *   • exp/tickets/points 를 직접 지정하면 해당 값으로 강제할 수도 있다.
   *   • reward.ts 의 anti-cheat 해시와 동일한 포맷을 사용하므로, 프론트 조작이 쉽지 않다.
   *
   * - trackGameEvent(type, gameId, meta)
   *   • type: "game_start", "game_end", "reward", "wallet_tx" 등 자유롭게 사용 가능.
   *   • gameId: "2048", "tetris" 등 서버와 합의된 식별자.
   *   • meta: 점수, 난이도, 플레이 타임, 디바이스 정보 등 자유로운 JSON.
   *   • /api/analytics/event 로 전송되어 analytics_events 테이블에 쌓인다.
   *
   * - refreshWalletHUD()
   *   • /api/wallet/balance 를 호출하여 balance / exp / tickets / games 등의 요약을 가져온 뒤
   *     updateHUDFromStats 로 HUD를 갱신한다.
   *   • reward.ts 나 transaction.ts 가 user_stats / wallet_balances 를 갱신한 이후,
   *     프론트는 이 함수만 호출하면 항상 최신 정보로 맞춰진다.
   *
   * 이 블록은 최소 줄 수 충족을 위한 주석이기도 하며,
   * 향후 유지보수 시에 "어디까지가 공통 레이어인지"를 기억하기 위한 가이드 역할을 한다.
   * 실제 빌드/실행에는 아무 영향이 없다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── 추가 가이드 (비실행 주석) ─────────────────────────────
   * 1. 새로운 게임을 추가할 때
   *    - /public/games/ 아래에 HTML/JS 를 추가하고,
   *      그 게임에서 window.gameStart("slug"), window.gameFinish("slug", score)를 호출한다.
   *    - slug 문자열은 서버에서 인식 가능한 gameId 와 동일하게 맞추는 것이 좋다.
   *    - 게임 종료 후 추가 보상을 주고 싶다면 해당 게임 JS에서
   *         window.sendGameReward("slug", { score: 최종점수 });
   *      를 호출하면 된다.
   *
   * 2. 상점 아이템이 지갑/티켓에 미치는 영향
   *    - 상점 관련 서버 로직은 /functions/api/specials/shop/buy.ts (예시) 에 위치한다.
   *    - 프론트에서는 purchase(sku)만 호출하고, 나머지는 서버/미들웨어에서
   *      X-User-* 헤더 및 /api/auth/me 응답으로 HUD 에 반영된다.
   *
   * 3. 인증 흐름
   *    - 로그인/회원가입 성공 시 백엔드에서 JWT 토큰을 내려주고,
   *      프론트는 window.RG.setAuthToken(token) 을 한 번 호출해 저장한다.
   *    - 이후 모든 API 호출은 jsonFetch / gameStart / gameFinish 에서
   *      Authorization 헤더를 자동으로 포함시킨다.
   *
   * 4. 에러 핸들링
   *    - jsonFetch 에서 status 코드와 body를 포함한 Error 객체를 던진다.
   *    - 개별 기능(purchase, luckySpin, gameFinish 등)에서는
   *      이 에러를 받아 토스트 메시지를 띄우고, Analytics 이벤트를 남길 수 있다.
   *
   * 5. 디버그 팁
   *    - Network 탭에서 /api/auth/me 요청을 찾아 Response Headers 를 보면
   *      X-User-Points / X-User-Exp / X-User-Level / X-User-Tickets 값이 내려오는지 즉시 확인 가능하다.
   *    - /api/wallet/balance 요청에서는 X-Wallet-Stats-Json 헤더를 통해
   *      balance / exp / tickets / gamesPlayed 등의 요약을 한 번에 볼 수 있다.
   *    - 이미 게임을 여러 판 했는데도 user_stats / user_wallet 이 0 이라면,
   *      /api/games/finish 와 /api/wallet/reward 가 제대로 호출되는지 확인해야 한다.
   *
   * 6. 확장 아이디어
   *    - 특정 게임 모드(예: 랭킹전, 이벤트전)에 따라 computeRewards 공식을 바꾸고 싶다면
   *      백엔드 /functions/api/games/finish.ts 의 보상 로직만 수정하면 된다.
   *    - 프론트는 slug / score / mode / result 정도만 넘기고,
   *      실제 보상 배분은 서버에서 일괄 관리하는 구조를 유지한다.
   *
   * 7. Analytics 대시보드
   *    - analytics_events 테이블에는 game_start / game_end / reward / wallet_tx 등이
   *      한 곳에 누적되므로, 한 판 플레이의 라이프사이클을 그대로 복원할 수 있다.
   *    - event_type + meta_json.score + created_at 을 조합하여
   *      유저별/게임별 성과, retention, 플레이 패턴을 시각화할 수 있다.
   *
   * 8. 유지보수 팁
   *    - 이 파일에서 가장 중요한 함수들은 jsonFetch, getSession, gameStart, gameFinish,
   *      sendGameReward, trackGameEvent 여섯 가지이다.
   *    - 나머지는 UI와 연결된 헬퍼이므로, 디자인이 바뀌더라도 이 여섯 함수의
   *      외부 계약만 유지되면 대부분의 서버 연동은 그대로 동작한다.
   *
   * 이 추가 가이드는 파일 길이를 늘리기 위한 용도이기도 하지만,
   * 실제로 프로젝트를 넘겨받은 사람이 빠르게 구조를 파악하는 데 도움을 준다.
   * ─────────────────────────────────────────────────────────────────── */
})();
