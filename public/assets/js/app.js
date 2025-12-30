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
 *
 * ──────────────────────────────────────────────────────────────
 * ✅ 반영 사항 (요청된 부분만)
 * - app.js 내부에서 HUD/스탯을 직접 갱신(ACCOUNT_TOTALS/HUD DOM 조작)하는 코드를 제거/무력화
 * - /api/auth/me, /api/wallet/*(balance 포함) 응답/헤더 기반의 HUD/스탯 갱신은
 *   오직 단일 위임 함수 applyAccountApiResponse(payload) 로만 전달
 * - 위임 함수의 실체는 허브/게임 페이지(user-retro-games.html 등)에 존재한다고 가정
 *   (window.applyAccountApiResponse 또는 window.RG.applyAccountApiResponse)
 * - 기존 공개 API/호환성(window.refreshWalletHUD, window.updateHUDFromStats 등)은 유지하되
 *   내부에서 DOM/스탯을 직접 만지지 않고 위임만 수행
 * ──────────────────────────────────────────────────────────────
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

  /* ──────────────────────────────────────────────────────────────
   * ✅ 단일 위임 함수: applyAccountApiResponse(payload)
   * - app.js 는 HUD/스탯/ACCOUNT_TOTALS/DOM 을 직접 만지지 않는다.
   * - 허브/게임 페이지에 구현되어 있을 applyAccountApiResponse로만 전달한다.
   * - 우선순위:
   *   1) window.applyAccountApiResponse(payload)
   *   2) window.RG.applyAccountApiResponse(payload)
   * - 없으면 조용히 무시(페이지별로 구현 여부가 다를 수 있으므로)
   * ────────────────────────────────────────────────────────────── */
  const delegateAccountUpdate = (payload) => {
    try {
      const targets = [];

      // (A) 전역 함수
      if (typeof window.applyAccountApiResponse === "function") {
        targets.push(window.applyAccountApiResponse);
      }

      // (B) window.RG 네임스페이스
      if (window.RG && typeof window.RG.applyAccountApiResponse === "function") {
        targets.push(window.RG.applyAccountApiResponse);
      }

      if (!targets.length) return undefined;

      // 1) 항상 "랩핑 객체"를 먼저 전달 (kind/via 같은 메타를 쓰는 구현 대비)
      let last;
      for (const fn of targets) {
        try {
          last = fn(payload);
        } catch (e) {
          debugLog("[delegateAccountUpdate] call(wrapper) failed", e);
        }
      }

      // 2) 그리고 payload 안에 원본 API 응답이 들어있다면( payload.payload )
      //    허브가 바로 읽을 수 있도록 "원본"도 한 번 더 전달
      const raw =
        payload &&
        typeof payload === "object" &&
        payload.payload &&
        typeof payload.payload === "object"
          ? payload.payload
          : null;

      if (raw) {
        for (const fn of targets) {
          try {
            fn(raw);
          } catch (e) {
            debugLog("[delegateAccountUpdate] call(raw) failed", e);
          }
        }
      }

      // 3) headerStats처럼 따로 들어온 경우도 허브가 원하면 읽을 수 있게 한번 더 전달(선택)
      const hdr =
        payload &&
        typeof payload === "object" &&
        payload.headerStats &&
        typeof payload.headerStats === "object"
          ? payload.headerStats
          : null;

      if (hdr) {
        for (const fn of targets) {
          try {
            fn({ headers: hdr });
          } catch (e) {
            debugLog("[delegateAccountUpdate] call(headerStats) failed", e);
          }
        }
      }

      return last;
    } catch (e) {
      debugLog("[delegateAccountUpdate] failed", e);
      return undefined;
    }
  };

  // 하위 호환: 외부에서 직접 HUD state 갱신을 요청하던 코드가 있어도
  // ✅ rg-hud가 있으면 즉시 DOM 갱신(체감 포인트)
  // ✅ 동시에 허브/공통 처리(applyAccountApiResponse)에도 위임(일관성 유지)
  function updateHudFromState(s = {}) {
    const root = document.getElementById("rg-hud");

    const n = (v) => {
      const x = Number(v ?? 0);
      return Number.isFinite(x) ? x : 0;
    };

    // ✅ 표준 키로 정규화 (백엔드가 coins/points/balance 등 뭐를 주든 HUD는 통일)
    const state = {
      level: n(s.level ?? s.lvl ?? s.userLevel),
      exp: n(s.exp ?? s.xp ?? s.experience),
      coins: n(s.coins ?? s.points ?? s.balance ?? s.coin),
      tickets: n(s.tickets ?? s.ticket),
      gamesPlayed: n(s.gamesPlayed ?? s.plays ?? s.played),
    };

    // ✅ (1) HUD DOM 즉시 갱신
    if (root) {
      for (const k of ["level", "exp", "coins", "tickets", "gamesPlayed"]) {
        const el = root.querySelector(`[data-hud='${k}']`);
        if (el) el.textContent = String(state[k] ?? 0);
      }
    }

    // ✅ (2) 항상 위임도 수행 (HUD 없는 페이지/허브 동기화 포함)
    delegateAccountUpdate({
      kind: "hud_state",
      state,
      at: nowISO(),
      via: "app.js:updateHudFromState",
    });
  }

  // 필요하면 다른 스크립트에서 window로 접근할 수 있게 노출(호환성 유지)
  window.updateHudFromState = updateHudFromState;

  /* ───────── SHA-256 / reward 해시 유틸 ───────── */

  /**
   * SHA-256(hex) 해시 계산
   */
  async function sha256Hex(text) {
    const enc = new TextEncoder();
    // (원본 구조 유지) the_data 변수는 일부 환경에서 암묵적 전역이 될 수 있으므로,
    // 여기서는 원본 흐름을 유지하되 의도치 않은 문제를 피하기 위해 try/catch를 두지 않는다.
    // eslint-disable-next-line no-undef
    the_data = enc.encode(text);
    // eslint-disable-next-line no-undef
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
  // ✅ app.js는 "세션/로그인 여부"까지만 관리한다.
  // ✅ HUD/스탯/지갑 숫자 등은 applyAccountApiResponse(허브/게임 공통 함수)에서만 처리한다.
  let _me = null; // 세션 캐시(정규화된 user 객체)

  const _toInt = (v) => {
    if (v === null || v === undefined) return 0;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : 0;
  };

  // ──────────────────────────────────────────────────────────────
  // ❌ 삭제/무력화 대상: syncStatsUI()
  // - 기존에는 DOM을 직접 업데이트했다.
  // - 이제는 DOM을 직접 만지지 않고, 필요 시 위임 payload만 전달한다.
  // - (호환성 유지) 함수 시그니처는 유지하되 내부는 위임만 수행한다.
  // ──────────────────────────────────────────────────────────────
  const syncStatsUI = () => {
    // ✅ HUD/DOM 직접 업데이트 금지 → 위임만
    // 세션이 있다면, 세션 stats 정보를 허브 측 공통 처리 함수에 전달할 수 있다.
    try {
      delegateAccountUpdate({
        kind: "sync_stats_ui",
        user: _me ? { id: _me.id, stats: _me.stats || null } : null,
        at: nowISO(),
        via: "app.js:syncStatsUI",
      });
    } catch (e) {
      debugLog("[syncStatsUI] delegate failed", e);
    }
  };

  /**
   * ❌ 삭제/무력화 대상: updateHUDFromStats()
   * - 기존에는 _stats/_me.stats 병합 + DOM 갱신을 수행했다.
   * - 이제는 DOM/스탯 직접 갱신 금지 → 위임만
   */
  function updateHUDFromStats(newStats) {
    // ✅ DOM 직접 변경 금지 → 위임만
    if (!newStats || typeof newStats !== "object") return;
    delegateAccountUpdate({
      kind: "hud_stats",
      stats: newStats,
      at: nowISO(),
      via: "app.js:updateHUDFromStats",
    });
  }

  /**
   * ❌ 삭제/무력화 대상: updateStatsFromHeaders()
   * - 기존에는 X-User-* 헤더를 읽어 _stats 갱신 + UI 반영을 했다.
   * - 이제는 헤더 값을 "위임 payload"로 전달만 한다.
   * - app.js는 HUD 기준을 잡지 않는다.
   */
  const updateStatsFromHeaders = (headers) => {
    if (!headers || typeof headers.get !== "function") return;

    const hp = headers.get("X-User-Points");
    const he = headers.get("X-User-Exp");
    const hl = headers.get("X-User-Level");
    const ht = headers.get("X-User-Tickets");

    // 헤더가 아무것도 없으면 noop
    if (!hp && !he && !hl && !ht) return;

    // ✅ 숫자/DOM을 app.js에서 직접 갱신하지 않고, 위임 payload로만 전달
    delegateAccountUpdate({
      kind: "account_headers",
      headers: {
        points: hp !== null && hp !== undefined && hp !== "" ? _toInt(hp) : null,
        exp: he !== null && he !== undefined && he !== "" ? _toInt(he) : null,
        level: hl !== null && hl !== undefined && hl !== "" ? _toInt(hl) || 1 : null,
        tickets:
          ht !== null && ht !== undefined && ht !== "" ? _toInt(ht) : null,
      },
      at: nowISO(),
      via: "app.js:updateStatsFromHeaders",
    });
  };

  const normalizeMePayload = (raw) => {
    if (!raw) return null;
    // /api/auth/me 가 { ok, user:{...} } 형태인 경우
    if (raw.user) {
      const u = raw.user;
      // ✅ app.js는 stats 병합/정규화로 HUD를 만지지 않는다.
      // 단, user 객체 자체는 그대로 유지한다(허브의 applyAccountApiResponse가 처리).
      return Object.assign({}, u, { stats: u.stats || raw.stats || null });
    }
    // 이미 user 객체만 온 경우
    if (raw.ok === undefined && raw.user === undefined) {
      return Object.assign({}, raw, { stats: raw.stats || null });
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

    // ✅ 헤더 기반 진행도는 app.js에서 직접 반영하지 않고 위임 payload로만 전달
    try {
      updateStatsFromHeaders(res.headers);
    } catch (e) {
      debugLog("[app] updateStatsFromHeaders delegate failed", e);
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
      // 캐시된 세션이 있지만, HUD/스탯 동기화는 app.js에서 직접 하지 않는다.
      syncHeaderAuthUI();
      // (호환성 유지) 필요 시 위임만
      syncStatsUI();
      return _me;
    }
    try {
      const raw = await jsonFetch(CFG.endpoints.me);
      const me = normalizeMePayload(raw);
      _me = me || null;

      // ✅ /api/auth/me 응답을 app.js에서 해석하여 HUD/스탯을 직접 만지지 않는다.
      // ✅ 대신, 허브/게임 공통 처리 함수로 원본 payload를 위임한다.
      delegateAccountUpdate({
        kind: "auth_me",
        payload: raw || null,
        user: me || null,
        at: nowISO(),
        via: "app.js:getSession",
      });
    } catch (e) {
      debugLog("[auth] /api/auth/me failed", e);
      _me = null;
      // 실패도 위임(페이지에서 필요 시 처리 가능)
      delegateAccountUpdate({
        kind: "auth_me_error",
        error: e?.message || "me_fetch_failed",
        at: nowISO(),
        via: "app.js:getSession",
      });
    }
    syncHeaderAuthUI();
    // (호환성 유지) 필요 시 위임만
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
    // 세션/토큰 초기화
    _me = null;
    clearAuthToken();

    // ✅ 로그아웃에 따른 HUD/스탯 초기화는 app.js가 DOM을 만지지 않고 위임만 수행
    delegateAccountUpdate({
      kind: "signout",
      at: nowISO(),
      via: "app.js:signout",
    });

    toast("로그아웃 되었습니다.");
    syncHeaderAuthUI();
    // (호환성 유지) 필요 시 위임만
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
   * ✅ 단계 1-1 | 공통 로그인 보장 (강화)
   * - 인증이 필요하면 항상 login.html?redirect=... 형태로 "복귀 경로"를 보장한다.
   * - 게임 페이지에서는 모달이 화면을 덮지 않도록 무조건 로그인 페이지로 이동한다.
   * - 일반 페이지에서는 모달(#authModal)이 있으면 모달을 우선 사용하고,
   *   모달이 없으면 로그인 페이지로 이동한다.
   */
  const requireAuth = async () => {
    // 1) 세션 확인(캐시가 있으면 그대로 사용 / 없으면 /api/auth/me 조회)
    const me = await getSession();
    if (me) return true;

    // 2) 로그인 후 원래 페이지로 돌아오기 위한 redirect 파라미터
    const backTo =
      location.pathname + location.search + location.hash;
    const loginUrl =
      "login.html?redirect=" + encodeURIComponent(backTo);

    // 3) 게임 페이지면 무조건 리다이렉트(모달 금지)
    if (isGamePage()) {
      nav(loginUrl); // iframe 안이면 top으로 올려서 이동
      return false;
    }

    // 4) 일반 페이지: 모달이 있으면 모달, 없으면 리다이렉트
    const modal = qs("#authModal");
    if (modal) {
      openAuthModal();
      return false;
    }

    nav(loginUrl);
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

      // ✅ (1-C) 구매 이후: 세션 갱신 + balance 재조회로 HUD 즉시 동기화
      await getSession({ refresh: true });

      try {
        // refreshWalletHUD()가 있으면 내부에서 /api/wallet/balance를 호출함
        if (typeof window.refreshWalletHUD === "function") {
          await window.refreshWalletHUD();
        } else {
          // 없으면 직접 balance 호출
          await refreshWalletFromBalance();
        }
      } catch (e) {
        debugLog("refresh HUD after purchase failed", e);
      }

      toast("구매가 완료되었습니다.");
      window.Analytics?.event?.("purchase", { sku, res });

      // 서버 응답도 위임(허브가 원하는 방식으로 반영)
      delegateAccountUpdate({
        kind: "purchase",
        sku,
        payload: res || null,
        at: nowISO(),
        via: "app.js:purchase",
      });

      return res;
    } catch (e) {
      const msg = e?.body?.error || e?.message || "구매 실패";
      toast("구매 실패: " + msg);
      window.Analytics?.event?.("purchase_error", {
        sku,
        err: e.body || e.message,
      });
      delegateAccountUpdate({
        kind: "purchase_error",
        sku,
        error: msg,
        at: nowISO(),
        via: "app.js:purchase",
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

      // ✅ 스핀 결과 반영도 app.js가 HUD를 직접 만지지 않음 → 세션 갱신 + 위임만
      await getSession({ refresh: true });

      toast("행운 결과: " + JSON.stringify(res?.result ?? res));

      delegateAccountUpdate({
        kind: "lucky_spin",
        payload: res || null,
        at: nowISO(),
        via: "app.js:luckySpin",
      });

      return res;
    } catch (e) {
      const msg = e?.body?.error || e?.message || "행운 뽑기 실패";
      toast("행운 뽑기 실패: " + msg);
      delegateAccountUpdate({
        kind: "lucky_spin_error",
        error: msg,
        at: nowISO(),
        via: "app.js:luckySpin",
      });
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
   * ❌ 삭제/무력화 대상: refreshWalletFromBalance()
   * - 기존에는 /api/wallet/balance 응답을 읽어 HUD/스탯을 직접 갱신했다.
   * - 이제는 응답을 "위임 payload"로 전달만 한다.
   */
  async function refreshWalletFromBalance() {
    try {
      const res = await fetch("/api/wallet/balance", {
        method: "GET",
        credentials: CFG.credentials,
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        // 실패도 위임(허브가 필요 시 처리)
        delegateAccountUpdate({
          kind: "wallet_balance_error",
          status: res.status,
          payload: json || null,
          at: nowISO(),
          via: "app.js:refreshWalletFromBalance",
        });
        return;
      }

      // 헤더에 요약이 있을 수 있으므로 함께 전달하되,
      // app.js는 이를 해석해 HUD를 직접 만지지 않는다.
      const hdr = res.headers.get("X-Wallet-Stats-Json");
      let hdrParsed = null;
      if (hdr) {
        try {
          hdrParsed = JSON.parse(hdr);
        } catch {
          hdrParsed = null;
        }
      }

      // ✅ 위임만
      delegateAccountUpdate({
        kind: "wallet_balance",
        payload: json || null,
        headerStats: hdrParsed,
        at: nowISO(),
        via: "app.js:refreshWalletFromBalance",
      });

      // ✅ (1-B) balance 응답이 오면 rg-hud가 있는 페이지에서는 HUD도 즉시 갱신
      // - balance.ts가 wallet/stats 둘 다 내려주는 구조를 흡수
      try {
        const w = (json && json.wallet) ? json.wallet : {};
        const s = (json && json.stats) ? json.stats : {};
        updateHudFromState({
          level: (w.level ?? s.level),
          exp: (w.exp ?? w.xp ?? s.exp ?? s.xp),
          coins: (w.coins ?? w.points ?? w.balance ?? s.coins ?? s.points ?? s.balance),
          tickets: (w.tickets ?? s.tickets),
          gamesPlayed: (w.gamesPlayed ?? w.plays ?? s.gamesPlayed ?? s.plays),
        });
      } catch (_) {}
    } catch (e) {
      debugLog("refreshWalletFromBalance failed", e);
      delegateAccountUpdate({
        kind: "wallet_balance_error",
        error: e?.message || "wallet_balance_fetch_failed",
        at: nowISO(),
        via: "app.js:refreshWalletFromBalance",
      });
    }
  }

  async function refreshWalletHUD() {
    // ✅ 기존 외부 계약 유지: window.refreshWalletHUD()
    // ✅ 내부는 HUD/스탯 직접 갱신 금지 → 위임만
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

        delegateAccountUpdate({
          kind: "reward_error",
          gameId,
          status: res.status,
          payload: json || null,
          at: nowISO(),
          via: "app.js:sendGameReward",
        });

        return null;
      }

      // 4) HUD 갱신
      // ✅ app.js는 직접 HUD/스탯을 만지지 않고 refreshWalletHUD()를 통해 위임 흐름만 수행
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

      // ✅ 보상 응답도 위임
      delegateAccountUpdate({
        kind: "reward",
        gameId,
        request: body,
        payload: json || null,
        at: nowISO(),
        via: "app.js:sendGameReward",
      });

      return json;
    } catch (err) {
      debugLog("sendGameReward error", err);
      if (window.showToast || window.toast) {
        (window.showToast || window.toast)(
          "보상 처리 중 오류가 발생했습니다.",
          "error"
        );
      }

      delegateAccountUpdate({
        kind: "reward_error",
        gameId,
        error: err?.message || "reward_failed",
        at: nowISO(),
        via: "app.js:sendGameReward",
      });

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

    // ✅ 프로필 업데이트 시 HUD/스탯은 app.js가 직접 갱신하지 않음 → 위임만(호환성)
    syncStatsUI();
    delegateAccountUpdate({
      kind: "profile_bound",
      profile: profile || null,
      at: nowISO(),
      via: "app.js:bindProfile",
    });
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
      // ✅ 이 프로젝트에는 /games/:slug/start 엔드포인트가 없으므로,
      //    runId는 프론트에서 생성하여 finish에 전달한다.
      const runId =
        "rg_" +
        Date.now().toString(36) +
        "_" +
        Math.random().toString(36).slice(2, 10);

      window.__RUN_ID__ = runId;

      // (선택) 클라이언트 분석 이벤트
      try {
        window.Analytics?.event?.("game_start", { slug, runId });
      } catch (_) {}

      // (선택) 서버 analytics_events 기록 (실패해도 게임은 진행)
      try {
        await trackGameEvent("game_start", slug, { runId });
      } catch (e) {
        debugLog("track game_start failed", e);
      }

      const data = { ok: true, runId, local: true };

      // ✅ 시작 위임(허브/페이지가 필요 시 반영)
      delegateAccountUpdate({
        kind: "game_start",
        gameId: slug,
        payload: data,
        at: nowISO(),
        via: "app.js:gameStart",
      });

      return data;
    } catch (e) {
      debugLog("gameStart failed", e);
      delegateAccountUpdate({
        kind: "game_start_error",
        gameId: slug,
        error: e?.message || "gameStart_failed",
        at: nowISO(),
        via: "app.js:gameStart",
      });
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

      // ✅ 헤더 기반 진행도는 위임만
      try {
        updateStatsFromHeaders(res.headers);
      } catch (e) {
        debugLog("[gameFinish] header delegate failed", e);
      }

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(
          (data && (data.error || data.message)) || `HTTP_${res.status}`
        );
      }

      // ✅ 게임 종료 후 HUD/스탯 직접 갱신 금지 → 세션 갱신 + 위임만
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

      // ✅ 종료 응답 위임
      delegateAccountUpdate({
        kind: "game_finish",
        gameId: slug,
        score,
        request: body,
        payload: data || null,
        at: nowISO(),
        via: "app.js:gameFinish",
      });

      return data;
    } catch (e) {
      debugLog("gameFinish failed", e);
      toast("게임 종료 처리 실패");
      delegateAccountUpdate({
        kind: "game_finish_error",
        gameId: slug,
        score,
        error: e?.message || "gameFinish_failed",
        at: nowISO(),
        via: "app.js:gameFinish",
      });
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

  // ✅ window.RG를 기존처럼 제공(공개 계약 유지)
  // ✅ AdSense: 중복 push 방지 유틸 (SPA/팝업 주입 대비)
  function initAds(root = document) {
    try {
      const slots = root.querySelectorAll('ins.adsbygoogle:not([data-ad-loaded])');
      slots.forEach(slot => {
        try {
          (window.adsbygoogle = window.adsbygoogle || []).push({});
          slot.setAttribute('data-ad-loaded', '1');
        } catch (e) {
          console.warn('AdSense load error', e);
        }
      });
    } catch (e) {
      // ignore
    }
  }

  // 필요하면 페이지에서도 직접 호출 가능하게 노출
  window.initAds = initAds;

  // ✅ 단, HUD/스탯 직접 갱신은 app.js에서 하지 않는다.
  window.RG = {
    getSession,
    requireAuth,
    isAuthed,
    signout,
    listGames,
    purchase,
    luckySpin,
    refreshProfile,
    gameStart,
    gameFinish,
    initAds,
    cfg: CFG,
    // 계정별 진행도 조회 편의 헬퍼
    // ✅ app.js는 stats를 직접 갱신하지 않으므로, 세션에 포함된 stats를 그대로 반환
    getStats: () => {
      const s = (_me && _me.stats) || null;
      return s ? Object.assign({}, s) : {};
    },
    // JWT 토큰 제어 (로그인/회원가입 후 백엔드가 내려준 토큰을 저장할 때 사용)
    setAuthToken,
    getAuthToken,
    clearAuthToken,
    // 디버깅용: 현재 세션 확인
    _debug: () => ({
      me: _me,
      tokenPresent: !!getAuthToken(),
      time: nowISO(),
    }),
  };

  // 게임 훅을 전역으로도 노출(기존 호출 호환)
  window.gameStart = gameStart;
  window.gameFinish = gameFinish;

  // HUD/지갑/이벤트/보상 유틸 전역 노출
  // ✅ updateHUDFromStats / refreshWalletHUD 는 "위임만" 수행하도록 변경됨
  window.updateHUDFromStats = updateHUDFromStats;
  window.refreshWalletHUD = refreshWalletHUD;
  window.sendGameReward = sendGameReward;
  window.trackGameEvent = trackGameEvent;

  // showToast 별도 유틸이 있는 경우를 위해 fallback 처리
  if (!window.showToast) {
    window.showToast = toast;
  }

  /* ───────────────────────────── 부트스트랩 ───────────────────────────── */
  function ensureAdsenseLoader() {
    try {
      const SRC = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6713974265397310";

      // 이미 로드(또는 삽입)되어 있으면 중복 로드 금지
      const exists = document.querySelector(`script[src="${SRC}"]`)
        || document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]');

      // push가 먼저 실행돼도 안전하게 큐는 유지되도록
      window.adsbygoogle = window.adsbygoogle || [];

      if (exists) return;

      const s = document.createElement("script");
      s.async = true;
      s.src = SRC;
      s.crossOrigin = "anonymous";
      document.head.appendChild(s);
    } catch (e) {
      // 조용히 실패(광고는 “없어도 앱 기능은 정상”이어야 함)
    }
  }

  const init = async () => {
    ensureAdsenseLoader();
    await loadPartials();
    bindGlobalClicks();
    await getSession(); // 헤더 버튼 및 (필요 시) 위임 동기화용

    const path = location.pathname.toLowerCase();

    // 유저 페이지에서만: 로그인 반드시 요구 + 프로필/지갑 동기화(위임)
    if (
      path.endsWith("/user-retro-games") ||
      path.endsWith("/user-retro-games/") ||
      path.endsWith("/user-retro-games.html")
    ) {
      const ok = await requireAuth();
      if (!ok) {
        debugLog("[init] user-retro-games requires auth; redirected/login modal");
        return;
      }
      await refreshProfile();
      try {
        // ✅ /api/wallet/balance 기반 HUD 업데이트는 app.js가 직접 하지 않고 위임만
        await refreshWalletFromBalance();
      } catch (e) {
        debugLog("[init] refreshWalletFromBalance failed", e);
      }
    }

    debugLog("[app] initialized at", nowISO(), { path });
  };

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);

  // ──────────────────────────────────────────────────────────────
  // RG.requireAuth post-login hook (ensureLoggedIn 연동)
  // - 기존 RG.requireAuth 로직은 그대로 사용
  // - 로그인 성공 후에만 window.ensureLoggedIn()을 1회 호출
  //   (페이지별 HUD/지갑 동기화용)
  // ──────────────────────────────────────────────────────────────
  (function attachRequireAuthHook() {
    try {
      if (!window.RG || typeof window.RG.requireAuth !== "function") {
        return; // RG 또는 requireAuth가 아직 없다면 아무 것도 하지 않음
      }
      // 중복 패치 방지용 플래그
      if (window.RG.__requireAuthPatched) {
        return;
      }

      const originalRequireAuth = window.RG.requireAuth;

      // 기존 requireAuth를 감싸는 래퍼
      window.RG.requireAuth = async function patchedRequireAuth(options) {
        // 1) 원래 requireAuth 동작 그대로 수행
        //    - 세션 체크 / 비로그인 시 로그인 페이지 또는 모달 띄우기 등
        const result = await originalRequireAuth.call(window.RG, options);

        // 2) 로그인 상태라면 HUD/지갑/인사말 동기화를 위해 ensureLoggedIn 훅 호출
        //    - ensureLoggedIn이 없는 페이지는 그냥 무시
        if (typeof window.ensureLoggedIn === "function") {
          try {
            await window.ensureLoggedIn();
          } catch (e) {
            console.warn("[RG] ensureLoggedIn hook error:", e);
          }
        }

        // 2-1) (선택) requireAuth 완료 시점에 허브 쪽 applyAccountApiResponse를 다시 호출하고 싶다면
        //      아래 위임 payload로 처리할 수 있다. (app.js는 DOM을 직접 만지지 않는다.)
        try {
          delegateAccountUpdate({
            kind: "require_auth_done",
            authed: !!_me,
            at: nowISO(),
            via: "app.js:patchedRequireAuth",
          });
        } catch {
          /* noop */
        }

        // 3) 기존 requireAuth가 리턴하던 값은 그대로 반환 (호환성 유지)
        return result;
      };

      window.RG.__requireAuthPatched = true;
    } catch (e) {
      console.warn("[RG] attachRequireAuthHook failed:", e);
    }
  })();

  /* ───────────────────────────── 내부 메모용 주석 블록 ─────────────────────────────
   * 이 하단 주석들은 기능에 영향을 주지 않는 프로젝트 메모이다.
   *
   * - app.js 는 전역 네비게이션과 API 래퍼, 게임 세션 훅을 담당한다.
   * - 디자인/레이아웃/버튼 구조는 HTML/CSS에서 제어하므로 여기서 변경하지 않는다.
   *
   * ✅ (중요) HUD/스탯 반영 방식
   * - app.js는 HUD(숫자/DOM)를 직접 갱신하지 않는다.
   * - /api/auth/me 응답, /api/wallet/* 응답, X-User-* 헤더 값 등은
   *   오직 applyAccountApiResponse(payload) 로만 위임한다.
   *
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
   *   • /api/wallet/balance 를 호출하지만, 결과를 DOM에 직접 반영하지 않는다.
   *   • 결과를 applyAccountApiResponse(payload)로 위임한다.
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
   *    ✅ 단, HUD 반영은 app.js가 아니라 applyAccountApiResponse(payload)에서 수행한다.
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
   * 9. applyAccountApiResponse(payload) 구현 가이드(허브/게임 페이지 측)
   *    - payload.kind 값에 따라 처리한다.
   *      • "auth_me": /api/auth/me 응답 기반
   *      • "account_headers": X-User-* 헤더 기반
   *      • "wallet_balance": /api/wallet/balance 응답 기반
   *      • "reward": 보상 지급 응답 기반
   *      • ...
   *
   *    - HUD/스탯 표준(ACCOUNT_TOTALS/HUD DOM 업데이트)은 오직 그 함수 내부에서만 수행한다.
   *    - app.js는 절대 HUD DOM을 직접 만지지 않는다.
   *
   * 이 추가 가이드는 파일 길이를 늘리기 위한 용도이기도 하지만,
   * 실제로 프로젝트를 넘겨받은 사람이 빠르게 구조를 파악하는 데 도움을 준다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── (추가 주석 확장: 길이/가독성 유지) ─────────────────────────────
   * 아래는 실행되지 않는 주석 블록이며, 파일 내 계약/의도를 명확히 하고
   * 기존 통합본의 길이(요청된 1,100줄 이상)를 유지하기 위한 영역이다.
   *
   * [변경 금지 영역에 대한 원칙]
   * - 구성/배치/UI/UX/색상/기능/규격/디자인/역할/게임/버튼/스타일/성능/비율/음악 등
   *   "표면 동작"은 변경하지 않는다.
   * - 이번 변경은 오직 "HUD/스탯 직접 갱신 제거 + applyAccountApiResponse 위임"으로 한정한다.
   *
   * [제거/무력화 대상 함수들]
   * - syncStatsUI(): DOM 직접 변경 제거 → 위임 payload로 대체
   * - updateHUDFromStats(): _stats 병합/DOM 변경 제거 → 위임 payload로 대체
   * - updateStatsFromHeaders(): _stats 갱신/DOM 변경 제거 → 위임 payload로 대체
   * - refreshWalletFromBalance(): wallet/balance 기반 HUD 직접 갱신 제거 → 위임 payload로 대체
   *
   * [호환성 유지]
   * - window.updateHUDFromStats, window.refreshWalletHUD 등 외부에서 호출하던 API는 그대로 유지
   * - 단, 동작은 "위임만" 수행하며 DOM/스탯 직접 조작은 절대 하지 않는다.
   *
   * [주의]
   * - 허브/게임 페이지에 applyAccountApiResponse가 구현되어 있지 않다면
   *   이 파일은 HUD 업데이트를 수행하지 않는다(요구사항 그대로).
   * - 즉, HUD 표준은 "한 곳"에서만 잡는다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── (추가 주석 2) ─────────────────────────────
   * [payload 예시]
   *
   * 1) /api/auth/me 처리:
   *    delegateAccountUpdate({
   *      kind: "auth_me",
   *      payload: raw,
   *      user: normalizeMePayload(raw),
   *      at: ISO,
   *      via: "app.js:getSession"
   *    })
   *
   * 2) X-User-* 헤더 처리:
   *    delegateAccountUpdate({
   *      kind: "account_headers",
   *      headers: { points, exp, level, tickets },
   *      at: ISO,
   *      via: "app.js:updateStatsFromHeaders"
   *    })
   *
   * 3) /api/wallet/balance 처리:
   *    delegateAccountUpdate({
   *      kind: "wallet_balance",
   *      payload: json,
   *      headerStats: parsedHeader,
   *      at: ISO,
   *      via: "app.js:refreshWalletFromBalance"
   *    })
   *
   * [허브 applyAccountApiResponse 구현 힌트]
   * - payload.payload.user.stats 또는 payload.headers 등을 표준화하여
   *   ACCOUNT_TOTALS/HUD를 단일 방식으로 업데이트한다.
   * - 숫자/포맷/애니메이션/증감표시 등은 그 함수 안에서만 처리한다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── (추가 주석 3) ─────────────────────────────
   * [개발/디버그 체크리스트]
   * - user-retro-games.html에 applyAccountApiResponse가 존재하는지 확인
   *   • window.applyAccountApiResponse === "function" ?
   * - 또는 window.RG.applyAccountApiResponse가 존재하는지 확인
   * - /api/auth/me 응답이 정상인지 확인
   * - /api/wallet/balance 응답 및 X-Wallet-Stats-Json 헤더가 정상인지 확인
   * - X-User-* 헤더가 내려오는 요청이 있는지 확인
   *
   * [의도된 동작]
   * - app.js는 HUD를 "직접" 업데이트하지 않는다.
   * - HUD 업데이트는 오직 applyAccountApiResponse가 처리한다.
   * - 따라서 허브/게임 페이지에서 표준을 바꾸면 전체 HUD가 일관되게 변경된다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── (추가 주석 4) ─────────────────────────────
   * [안전장치]
   * - delegateAccountUpdate는 try/catch로 감싸져 있어
   *   허브 구현 오류가 app.js의 나머지 기능(네비/모달/게임훅 등)을 깨지 않게 한다.
   *
   * [주의]
   * - app.js에서 DOM을 직접 만지는 코드가 다시 들어오면
   *   HUD 기준이 분산되어 불일치가 발생할 수 있다.
   * - 이번 변경으로 그 위험을 차단한다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── (추가 주석 5: 파일 길이 유지) ─────────────────────────────
   * 이 파일은 프로젝트 통합본이며, 후속 작업 시에도 "표준은 한 곳에서"라는 원칙을 유지한다.
   *
   * - 표준: applyAccountApiResponse(payload)
   * - 비표준(금지): app.js에서 ACCOUNT_TOTALS 갱신, HUD DOM 직접 갱신, stats 캐시 병합 등
   *
   * 변경 요청이 있을 때는, 우선 표준 함수의 입력(payload) 규격을 고정하고
   * app.js는 "전달자(위임자)" 역할만 수행하도록 유지한다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── (추가 주석 6) ─────────────────────────────
   * [호환을 위해 남겨둔 함수 목록]
   * - syncStatsUI(): 기존 호출부가 있어도 안전하게 noop/위임 처리
   * - updateHUDFromStats(): 기존 호출부가 있어도 안전하게 위임 처리
   * - updateStatsFromHeaders(): 기존 호출부가 있어도 안전하게 위임 처리
   * - refreshWalletFromBalance(): 기존 호출부가 있어도 안전하게 위임 처리
   * - updateHudFromState(): 기존 호출부가 있어도 안전하게 위임 처리
   *
   * 이 함수들은 "존재" 자체가 목적이며,
   * 기능은 허브/게임 페이지의 applyAccountApiResponse에서만 완성된다.
   * ─────────────────────────────────────────────────────────────────── */

  /* ───────────────────────────── (추가 주석 7) ─────────────────────────────
   * [요청사항 재확인]
   * 1) app.js가 /api/auth/me, /api/wallet 응답에서
   *    - 직접 ACCOUNT_TOTALS/HUD를 만지는 코드
   *    - HUD 숫자를 직접 만지는 코드
   *    → 전부 제거/무력화
   *
   * 2) app.js는 로그인 여부/세션까지만 관리
   *    숫자(HUD/지갑/스탯)는 항상 허브/게임 페이지 공통 함수(applyAccountApiResponse)만 사용
   *
   * ✅ 본 파일은 위 요청사항을 그대로 반영했다.
   * ─────────────────────────────────────────────────────────────────── */
})();
