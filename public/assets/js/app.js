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
 * 확장 (신규 Neon + Cloudflare 지갑/경험치 시스템 대응)
 * - JWT 토큰(Authorization: Bearer …)을 전역에서 자동으로 첨부
 * - _middleware 가 내려주는 X-User-* 헤더를 읽어 계정별 경험치/포인트/티켓 UI 동기화
 * - /auth/me 응답(user.stats)와 헤더 값을 병합해 세션 캐시를 단일 소스로 유지
 * - UI 구조/디자인/클래스/데이터-속성은 그대로, 데이터 채우기만 강화
 */

(() => {
  const CFG = {
    debug: true,
    credentials: "include",
    partials: {
      header: "partials/header.html",
      footer: "partials/footer.html",
    },
    // 서버 라우트 관례 (기존 계약 유지)
    endpoints: {
      me: "/auth/me",
      signout: "/auth/signout",
      profile: "/profile/me",
      history: "/profile/me/history",
      games: "/games",
      shopBuy: "/specials/shop/buy", // 구매
      luckySpin: "/specials/spin", // 일일 스핀
    },
    csrfCookie: "__csrf",
    csrfHeader: "X-CSRF-Token",
    // JWT 토큰 저장 키 (localStorage)
    authStorageKey: "rg_jwt_token",
  };

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
    // /auth/me가 { ok, user:{...} } 형태인 경우
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

  /* ─────────────────────── 파셜(header/footer) 주입 ─────────────────────── */
  const loadPartials = async () => {
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
      debugLog("[auth] /auth/me failed", e);
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
  const nav = (path) => {
    location.href = path;
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

  /* ───────────────────────────── 바인딩 헬퍼 ───────────────────────────── */
  const bindProfile = (profile) => {
    if (!profile) return;
    qsa("[data-bind-text]").forEach((el) => {
      const key = el.getAttribute("data-bind-text");
      if (!key) return;
      const val = key.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), profile);
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
      const headers = token
        ? { Authorization: `Bearer ${token}` }
        : {};
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
      return data;
    } catch (e) {
      debugLog("gameStart failed", e);
      toast("게임 시작 오류");
      return null;
    }
  };

  const gameFinish = async (slug, score) => {
    try {
      const token = getAuthToken();
      const headers = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };
      const body = { score, runId: window.__RUN_ID__ };
      const res = await fetch(`/games/${slug}/finish`, {
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
      });
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

  /* ───────────────────────────── 부트스트랩 ───────────────────────────── */
  const init = async () => {
    await loadPartials();
    bindGlobalClicks();
    await getSession(); // 헤더 버튼 및 계정별 진행도 표시용

    const path = location.pathname.toLowerCase();

    // 유저 페이지에서 프로필 바인딩
    if (path.endsWith("/user-retro-games.html")) {
      await refreshProfile();
      // 필요 시: const hist = await jsonFetch(CFG.endpoints.history + '?limit=20');
    }

    debugLog("[app] initialized at", nowISO(), { path });
  };

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
