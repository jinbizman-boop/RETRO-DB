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
 * 확장
 * - 계정별 경험치/포인트/티켓 정보를 백엔드와 동기화
 * - /auth/me 응답(user.stats) + _middleware 의 X-User-* 헤더를 모두 사용
 * - UI 구조/디자인은 그대로 두고, data-user-* 속성이 존재하면 해당 값만 채움
 */

(() => {
  const CFG = {
    debug: true,
    credentials: 'include',
    partials: {
      header: 'partials/header.html',
      footer: 'partials/footer.html',
    },
    // 서버 라우트 관례 (server/src/routes/*)
    endpoints: {
      me: '/auth/me',
      signout: '/auth/signout',
      profile: '/profile/me',
      history: '/profile/me/history',
      games: '/games',
      shopBuy: '/specials/shop/buy', // 구매
      luckySpin: '/specials/spin',   // 일일 스핀
    },
    csrfCookie: '__csrf',
    csrfHeader: 'X-CSRF-Token',
  };

  /* ────────────────────────────── 유틸 ────────────────────────────── */
  const qs  = (sel, el=document) => el.querySelector(sel);
  const qsa = (sel, el=document) => Array.from(el.querySelectorAll(sel));
  const delay = (ms) => new Promise(r=>setTimeout(r, ms));
  const nowISO = () => new Date().toISOString();
  const getCookie = (name) => {
    const m = document.cookie.split('; ').find(s => s.startsWith(name + '='));
    return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : '';
  };

  const toast = (msg, opts={}) => {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    Object.assign(el.style, {
      position:'fixed', left:'50%', bottom:'40px', transform:'translateX(-50%)',
      background:'rgba(0,0,0,.75)', color:'#fff', padding:'10px 14px',
      borderRadius:'10px', opacity:'0', transition:'opacity .18s', zIndex: 9999
    });
    document.body.appendChild(el);
    const ms = opts.duration ?? 2200;
    requestAnimationFrame(() => { el.style.opacity = '1'; });
    setTimeout(()=>{ el.style.opacity='0'; }, ms);
    setTimeout(()=>{ el.remove(); }, ms + 240);
  };

  // 계정별 진행도(경험치/포인트/티켓) 캐시
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
    qsa('[data-user-points]').forEach(el => {
      el.textContent = String(s.points ?? 0);
    });
    qsa('[data-user-exp]').forEach(el => {
      el.textContent = String(s.exp ?? 0);
    });
    qsa('[data-user-level]').forEach(el => {
      el.textContent = String(s.level ?? 1);
    });
    qsa('[data-user-tickets]').forEach(el => {
      el.textContent = String(s.tickets ?? 0);
    });
  };

  const updateStatsFromHeaders = (headers) => {
    if (!headers || typeof headers.get !== 'function') return;
    const hp = headers.get('X-User-Points');
    const he = headers.get('X-User-Exp');
    const hl = headers.get('X-User-Level');
    const ht = headers.get('X-User-Tickets');

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
      const stats =
        u.stats ||
        raw.stats ||
        null;
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

  // 공통 JSON fetch (빈 응답, 오류, CSRF 자동 처리 + X-User-* 헤더로 진행도 갱신)
  const jsonFetch = async (url, { method='GET', body, headers } = {}) => {
    const csrf = getCookie(CFG.csrfCookie);
    const mergedHeaders = {
      'Content-Type': 'application/json',
      ...(csrf ? { [CFG.csrfHeader]: csrf } : {}),
      ...(headers || {}),
    };
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
      if (CFG.debug) console.warn('[app] updateStatsFromHeaders failed', e);
    }

    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && (data.error || data.message)) || `HTTP_${res.status}`);
      err.status = res.status; err.body = data;
      throw err;
    }
    return data;
  };

  /* ─────────────────────── 파셜(header/footer) 주입 ─────────────────────── */
  const loadPartials = async () => {
    // data-include="partials/header.html" 등으로 직접 지시된 요소 우선
    const includes = qsa('[data-include]');
    for (const el of includes) {
      const href = el.getAttribute('data-include');
      if (!href) continue;
      try {
        const html = await fetch(href, { credentials: CFG.credentials }).then(r=>r.text());
        el.innerHTML = html;
      } catch (e) {
        if (CFG.debug) console.warn('[partials] load fail:', href, e);
      }
    }
    // 별도 선언이 없고 기본 훅이 있으면 기본 파일로 주입
    if (!qsa('[data-include*="header.html"]').length && qs('#site-header')) {
      try {
        const html = await fetch(CFG.partials.header, { credentials: CFG.credentials }).then(r=>r.text());
        qs('#site-header').innerHTML = html;
      } catch(e){ if (CFG.debug) console.warn('[partials] header load fail:', e); }
    }
    if (!qsa('[data-include*="footer.html"]').length && qs('#site-footer')) {
      try {
        const html = await fetch(CFG.partials.footer, { credentials: CFG.credentials }).then(r=>r.text());
        qs('#site-footer').innerHTML = html;
      } catch(e){ if (CFG.debug) console.warn('[partials] footer load fail:', e); }
    }
  };

  /* ───────────────────────────── 인증 & 세션 ───────────────────────────── */

  const syncHeaderAuthUI = () => {
    const loginBtn  = qs('[data-action="goLogin"]');
    const signupBtn = qs('[data-action="goSignup"]');
    const myBtn     = qs('[data-action="goUser"]');
    const outBtn    = qs('[data-action="signout"]');
    if (_me) {
      loginBtn && (loginBtn.style.display='none');
      signupBtn && (signupBtn.style.display='none');
      myBtn && (myBtn.style.display='');
      outBtn && (outBtn.style.display='');
    } else {
      loginBtn && (loginBtn.style.display='');
      signupBtn && (signupBtn.style.display='');
      myBtn && (myBtn.style.display='none');
      outBtn && (outBtn.style.display='none');
    }
  };

  const getSession = async (opts={}) => {
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
    } catch {
      _me = null;
    }
    syncHeaderAuthUI();
    syncStatsUI();
    return _me;
  };

  const signout = async () => {
    try {
      await jsonFetch(CFG.endpoints.signout, { method:'POST' });
      _me = null;
      _stats = { points: 0, exp: 0, level: 1, tickets: 0 };
      toast('로그아웃 되었습니다.');
      syncHeaderAuthUI();
      syncStatsUI();
      goHome();
    } catch (e) {
      toast('로그아웃 실패. 잠시 후 다시 시도하세요.');
    }
  };

  const isAuthed = () => !!_me;

  /* ───────────────────────────── 모달 & 가드 ───────────────────────────── */
  const openAuthModal = () => {
    const modal = qs('#authModal');
    if (!modal) { goLogin(); return; } // 모달 없으면 로그인 페이지로
    modal.classList.add('show');
    modal.setAttribute('aria-hidden','false');
    const first = modal.querySelector('.cta,button,[href],input,select,textarea,[tabindex]');
    first && setTimeout(()=>first.focus(), 0);
  };
  const closeAuthModal = () => {
    const modal = qs('#authModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden','true');
  };
  const requireAuth = async () => {
    const me = await getSession();
    if (!me) { openAuthModal(); return false; }
    return true;
  };

  /* ───────────────────────────── 네비게이션 ───────────────────────────── */
  const nav = (path) => { location.href = path; };
  const goHome      = () => nav('index.html');
  const goLogin     = () => nav('login.html');
  const goSignup    = () => nav('signup.html');
  const goShop      = () => nav('shop.html');
  const goUserGames = () => nav('user-retro-games.html'); // 기존 파일명 유지

  /* ───────────────────────────── 게임/프로필 API ───────────────────────────── */
  const listGames = async () => {
    try {
      return await jsonFetch(`${CFG.endpoints.games}`);
    } catch (e) {
      if (CFG.debug) console.warn('[games] list fail', e);
      return { ok:false, games:[] };
    }
  };

  const purchase = async (sku) => {
    try {
      const ok = await requireAuth();
      if (!ok) return;
      const res = await jsonFetch(CFG.endpoints.shopBuy, { method:'POST', body:{ sku } });
      // 구매 이후 계정별 포인트/티켓/경험치를 최신 상태로 반영
      await getSession({ refresh: true });
      toast('구매가 완료되었습니다.');
      window.Analytics?.event?.('purchase', { sku, res });
      return res;
    } catch (e) {
      toast('구매 실패: ' + (e.body?.error || e.message));
      window.Analytics?.event?.('purchase_error', { sku, err: e.body || e.message });
      throw e;
    }
  };

  const luckySpin = async () => {
    try {
      const ok = await requireAuth();
      if (!ok) return;
      let res;
      if (window.Analytics?.trackLuckySpin) {
        res = await Analytics.trackLuckySpin();
      } else {
        res = await jsonFetch(CFG.endpoints.luckySpin, { method:'POST' });
      }
      // 일일 스핀 결과에 따라 포인트/티켓/경험치 변화가 있을 수 있으므로 갱신
      await getSession({ refresh: true });
      toast('행운 결과: ' + JSON.stringify(res?.result ?? res));
      return res;
    } catch (e) {
      toast('행운 뽑기 실패: ' + (e.body?.error || e.message));
      throw e;
    }
  };

  /* ───────────────────────────── 바인딩 헬퍼 ───────────────────────────── */
  const bindProfile = (profile) => {
    if (!profile) return;
    qsa('[data-bind-text]').forEach(el => {
      const key = el.getAttribute('data-bind-text');
      if (!key) return;
      const val = key.split('.').reduce((acc,k)=>acc?.[k], profile);
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
      if (CFG.debug) console.warn('[profile] fetch fail', e);
      return null;
    }
  };

  /* ───────────────────────────── 게임 세션 훅 ───────────────────────────── */
  const gameStart = async (slug) => {
    try {
      const res = await fetch(`/games/${slug}/start`, {
        method: 'POST',
        credentials: CFG.credentials
      });
      const data = await res.json().catch(()=>null);
      if (!res.ok) throw new Error((data && (data.error||data.message)) || `HTTP_${res.status}`);
      window.__RUN_ID__ = data.runId;
      window.Analytics?.event?.('game_start', { slug, runId: data.runId });
      return data;
    } catch (e) {
      console.warn('gameStart failed', e);
      toast('게임 시작 오류');
      return null;
    }
  };

  const gameFinish = async (slug, score) => {
    try {
      const body = { score, runId: window.__RUN_ID__ };
      const res = await fetch(`/games/${slug}/finish`, {
        method: 'POST',
        credentials: CFG.credentials,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(()=>null);
      if (!res.ok) throw new Error((data && (data.error||data.message)) || `HTTP_${res.status}`);
      // 게임 종료(점수 반영) 후 계정별 경험치/포인트 반영
      await getSession({ refresh: true });
      window.Analytics?.event?.('game_finish', { slug, score, runId: window.__RUN_ID__ });
      return data;
    } catch (e) {
      console.warn('gameFinish failed', e);
      toast('게임 종료 처리 실패');
      return null;
    }
  };

  /* ───────────────────────────── 이벤트 위임/바인딩 ───────────────────────────── */
  const bindGlobalClicks = () => {
    document.addEventListener('click', (e) => {
      const a = e.target.closest?.('[data-action]');
      if (!a) return;
      const act = a.getAttribute('data-action');

      // 내비
      if (act === 'goHome')   return goHome();
      if (act === 'goLogin')  return goLogin();
      if (act === 'goSignup') return goSignup();
      if (act === 'goShop')   return goShop();
      if (act === 'goUser')   return goUserGames();
      if (act === 'signout')  return signout();

      // 기능
      if (act === 'requireAuth') return requireAuth();
      if (act === 'luckySpin')   return luckySpin();

      // 구매 버튼: data-action="purchase" data-sku="gold_pack_100"
      if (act === 'purchase') {
        const sku = a.getAttribute('data-sku');
        if (sku) purchase(sku);
      }
    });

    // 모달 닫기(X, 바깥 클릭, ESC)
    const modal = qs('#authModal');
    if (modal) {
      modal.addEventListener('click', (e)=>{ if (e.target === modal) closeAuthModal(); });
      const x = modal.querySelector('.x'); x && x.addEventListener('click', closeAuthModal);
      window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && modal.classList.contains('show')) closeAuthModal(); });
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
    getSession, isAuthed, signout,
    listGames, purchase, luckySpin,
    refreshProfile, gameStart, gameFinish,
    cfg: CFG,
    // 계정별 진행도 조회 편의 헬퍼
    getStats: () => {
      const s = (_me && _me.stats) || _stats;
      return Object.assign({}, s);
    }
  };
  // 게임 훅을 전역으로도 노출(기존 호출 호환)
  window.gameStart  = gameStart;
  window.gameFinish = gameFinish;

  /* ───────────────────────────── 부트스트랩 ───────────────────────────── */
  const init = async () => {
    await loadPartials();
    bindGlobalClicks();
    await getSession(); // 헤더 버튼 및 계정별 진행도 표시용

    const path = location.pathname.toLowerCase();

    // 유저 페이지에서 프로필 바인딩
    if (path.endsWith('/user-retro-games.html')) {
      await refreshProfile();
      // 필요 시: const hist = await jsonFetch(CFG.endpoints.history + '?limit=20');
    }

    if (CFG.debug) console.log('[app] initialized at', nowISO(), { path });
  };

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
