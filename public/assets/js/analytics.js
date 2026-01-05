/**
 * RETRO GAMES – analytics.js (Unified RC + Account-aware)
 * Path: public/assets/js/analytics.js
 *
 * 정책
 * - 자동 초기화 없음(Consent 후 외부에서 window.Analytics.init(opts) 호출)
 * - collectEndpoint 기본: '/api/analytics/collect'  (Pages Functions 라우트)
 * - <html data-env="production"> 또는 "prod" → debug=false
 * - 전역 API: window.Analytics = {
 *     init, event, flush,
 *     trackGameStart, trackGameFinish, trackLuckySpin,
 *     version
 *   }
 *
 * 확장
 * - 계정별 인식:
 *   - window.RG.getSession() / window.RG.getStats()와 느슨하게 연동
 *   - _middleware 의 X-User-* 헤더를 읽어 유저별 경험치/포인트/티켓/레벨을 업데이트
 *   - 모든 이벤트 payload에 userContext(요약) 포함
 * - UI/UX나 DOM 구조, 버튼/게임 동작은 건드리지 않음
 */
(() => {
  const VERSION = '1.3.0';
  const STORAGE_KEY = 'retro.analytics.queue';
  const SESSION_KEY_PREFIX = 'retro.game.session.';
  const UTM_KEY = 'retro.utm';
  const DEFAULT_FLUSH_MS = 15000; // 15s
  const MAX_QUEUE = 500; // 무한성장 방지

  /** ── 설정 ─────────────────────────────────────────────────────────── */
  const envRaw = (document.documentElement.dataset.env || 'dev').toLowerCase();
  const isProd = envRaw === 'production' || envRaw === 'prod';

  const config = {
    autoPageview: true,
    autoClick: true,
    flushInterval: DEFAULT_FLUSH_MS,
    collectEndpoint: '/api/analytics/collect',
    debug: !isProd,
    credentials: 'include',
  };

  /** ── 계정 컨텍스트(경험치/포인트/티켓/레벨) ─────────────────────────── */
  const userContext = {
    id: null,       // 문자열(유저 ID)
    points: 0,      // 지갑 포인트/코인
    exp: 0,         // 경험치
    level: 1,       // 레벨
    tickets: 0,     // 티켓
  };

  const toInt = (v, def = 0) => {
    if (v === null || v === undefined) return def;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : def;
  };

  const updateUserStats = (stats) => {
    if (!stats || typeof stats !== 'object') return;
    if (stats.points !== undefined) userContext.points = toInt(stats.points, userContext.points);
    if (stats.exp    !== undefined) userContext.exp    = toInt(stats.exp,    userContext.exp);
    if (stats.level  !== undefined) userContext.level  = toInt(stats.level,  userContext.level || 1) || 1;
    if (stats.tickets!== undefined) userContext.tickets= toInt(stats.tickets,userContext.tickets);
  };

  const updateUserFromMePayload = (rawMe) => {
    if (!rawMe) return;
    let me = rawMe;
    // /auth/me 가 { ok:true, user:{...} } 형태인 경우
    if (rawMe.user) me = rawMe.user;

    const id =
      me.id ??
      me.user_id ??
      me.userId ??
      me.sub ??
      null;

    if (id !== null && id !== undefined && String(id).trim() !== '') {
      userContext.id = String(id);
    }

    const stats =
      me.stats ||
      rawMe.stats ||
      null;

    if (stats) updateUserStats(stats);
  };

  const updateUserFromHeaders = (headers) => {
    if (!headers || typeof headers.get !== 'function') return;
    const uid = headers.get('X-User-Id');
    const sp  = headers.get('X-User-Points');
    const se  = headers.get('X-User-Exp');
    const sl  = headers.get('X-User-Level');
    const st  = headers.get('X-User-Tickets');

    if (uid && String(uid).trim() !== '') {
      userContext.id = String(uid);
    }
    if (sp !== null && sp !== undefined) userContext.points = toInt(sp, userContext.points);
    if (se !== null && se !== undefined) userContext.exp    = toInt(se, userContext.exp);
    if (sl !== null && sl !== undefined) userContext.level  = toInt(sl, userContext.level || 1) || 1;
    if (st !== null && st !== undefined) userContext.tickets= toInt(st, userContext.tickets);
  };

  const bootstrapUserContextFromRG = () => {
    try {
      if (window.RG && typeof window.RG.getSession === 'function') {
        // getSession()은 Promise를 반환 (app.js 기준)
        window.RG.getSession().then((me) => {
          if (!me) return;
          updateUserFromMePayload(me);
          // RG.getStats()가 있으면 추가로 한 번 더 맞춰줌
          if (typeof window.RG.getStats === 'function') {
            const s = window.RG.getStats();
            updateUserStats(s);
          }
          if (config.debug) console.debug('[analytics] userContext from RG.getSession', userContext);
        }).catch(() => {});
      } else if (window.RG && typeof window.RG.getStats === 'function') {
        const s = window.RG.getStats();
        updateUserStats(s);
        if (config.debug) console.debug('[analytics] userContext from RG.getStats', userContext);
      }
    } catch (e) {
      if (config.debug) console.warn('[analytics] bootstrapUserContextFromRG failed', e);
    }
  };

  /** ── 유틸 ─────────────────────────────────────────────────────────── */
  const now = () => new Date().toISOString();

  const uuid = () => {
    try {
      const u8 = new Uint8Array(16);
      (self.crypto && crypto.getRandomValues) ? crypto.getRandomValues(u8) : (() => {
        for (let i = 0; i < 16; i++) u8[i] = Math.floor(Math.random() * 256);
      })();
      u8[6] = (u8[6] & 0x0f) | 0x40; // v4
      u8[8] = (u8[8] & 0x3f) | 0x80; // variant
      const hx = b => b.toString(16).padStart(2, '0');
      return `${hx(u8[0])}${hx(u8[1])}${hx(u8[2])}${hx(u8[3])}-${hx(u8[4])}${hx(u8[5])}-${hx(u8[6])}${hx(u8[7])}-${hx(u8[8])}${hx(u8[9])}-${hx(u8[10])}${hx(u8[11])}${hx(u8[12])}${hx(u8[13])}${hx(u8[14])}${hx(u8[15])}`;
    } catch {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = (c === 'x') ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }
  };

  const safeParse = (s, d) => {
    try {
      if (s === null || s === undefined || s === '') return d;
      const v = JSON.parse(s);
      return (v === null || v === undefined) ? d : v;
    } catch {
      return d;
    }
  };

  const getDevice = () => ({
    ua: navigator.userAgent,
    lang: navigator.language,
    dpr: window.devicePixelRatio || 1,
    size: { w: window.innerWidth, h: window.innerHeight },
  });

  const getRef = () => document.referrer || null;

  const getCookie = (name) => {
    try {
      const m = document.cookie.split('; ').find(s => s.startsWith(name + '='));
      return m ? decodeURIComponent(m.split('=').slice(1).join('=')) : '';
    } catch { return ''; }
  };

  /** ── UTM 캡처 ─────────────────────────────────────────────────────── */
  const captureUTM = () => {
    let utm = safeParse(localStorage.getItem(UTM_KEY), null);
    try {
      const url = new URL(window.location.href);
      const params = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'];
      const next = {};
      let has = false;
      for (const p of params) {
        if (url.searchParams.has(p)) {
          next[p] = url.searchParams.get(p);
          has = true;
        }
      }
      if (has) {
        next.ts = now();
        localStorage.setItem(UTM_KEY, JSON.stringify(next));
        utm = next;
      }
    } catch { /* no-op */ }
    return utm;
  };

  /** ── 로컬 큐 ──────────────────────────────────────────────────────── */
  const loadQueue = () => {
    const q = safeParse(localStorage.getItem(STORAGE_KEY), []);
    return Array.isArray(q) ? q : [];
  };
  const saveQueue = (q) => localStorage.setItem(STORAGE_KEY, JSON.stringify(q.slice(-MAX_QUEUE)));

  /** ── enqueue ─────────────────────────────────────────────────────── */
  const enqueue = (type, payload = {}) => {
    const basePayload = payload && typeof payload === 'object' ? payload : { value: payload };
    const item = {
      id: uuid(),
      t: now(),
      type,
      page: location.pathname + location.search,
      ref: getRef(),
      utm: safeParse(localStorage.getItem(UTM_KEY), null),
      device: getDevice(),
      // 계정 컨텍스트(유저별 경험치/포인트/티켓/레벨 요약) 포함
      user: userContext.id ? {
        id: userContext.id,
        points: userContext.points,
        exp: userContext.exp,
        level: userContext.level,
        tickets: userContext.tickets,
      } : null,
      payload: basePayload,
      v: VERSION,
    };
    const q = loadQueue();
    q.push(item);
    saveQueue(q);
    if (config.debug) console.debug('[analytics] queued:', item);
  };

  /** ── flush ───────────────────────────────────────────────────────── */
  const flush = () => {
    const q = loadQueue();
    if (!q.length) return;

    try {
      if (config.collectEndpoint) {
        const body = JSON.stringify({ events: q });
        const csrf = getCookie('__csrf');
        const beaconPayload = new Blob([body], { type: 'application/json' });
        const ok = navigator.sendBeacon?.(config.collectEndpoint, beaconPayload);
        if (!ok) {
          // fetch fallback (keepalive)
          fetch(config.collectEndpoint, {
            method: 'POST',
            credentials: config.credentials,
            headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
            body,
            keepalive: true,
          }).catch(() => {/* swallow */});
        }
      }
      if (config.debug) console.debug(`[analytics] flushed (${q.length})`);
    } finally {
      // 전송 시도 여부와 무관히 비움(중복 전송 방지). 서버측은 idempotent 설계 권장.
      saveQueue([]);
    }
  };

  /** ── 오토 플러시 타이머 ─────────────────────────────────────────── */
  let timer = null;
  const startTimer = () => {
    if (timer) clearInterval(timer);
    timer = setInterval(flush, config.flushInterval);
  };

  /** ── 클릭 트래킹 ─────────────────────────────────────────────────── */
  const clickHandler = (e) => {
    const btn = e.target && (e.target.closest?.('button, .btn, .card, a[href]'));
    if (!btn) return;
    const label =
      btn.getAttribute?.('aria-label') ||
      btn.dataset?.label ||
      (btn.textContent ? btn.textContent.trim().slice(0, 120) : '') ||
      btn.getAttribute?.('href') ||
      'click';
    enqueue('click', { label, tag: btn.tagName, class: (btn.className || null) });
  };

  /** ── 서버 JSON 헬퍼 ──────────────────────────────────────────────── */
  const postJSON = async (url, data) => {
    const csrf = getCookie('__csrf');
    const res = await fetch(url, {
      method: 'POST',
      credentials: config.credentials,
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify(data || {}),
    });

    // 미들웨어에서 계정 헤더(X-User-*)를 내려줄 수 있으므로 바로 반영
    try {
      updateUserFromHeaders(res.headers);
      // RG가 있으면, app.js 쪽 계정 진행도와도 자연스럽게 맞춰짐
      if (window.RG && typeof window.RG.getStats === 'function') {
        const s = window.RG.getStats();
        updateUserStats(s);
      }
    } catch (e) {
      if (config.debug) console.warn('[analytics] header-based userContext update failed', e);
    }

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error || `HTTP_${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }

    // /games/* API가 새 stats를 반환하는 경우를 위해 한번 더 시도
    try {
      if (json && (json.user || json.stats)) {
        updateUserFromMePayload(json);
      }
    } catch {/* no-op */}

    return json;
  };

  const keyForSlug = (slug) => `${SESSION_KEY_PREFIX}${slug}`;

  /** ── 게임 세션 ───────────────────────────────────────────────────── */
  const trackGameStart = async (slug) => {
    enqueue('game_start_click', { slug });
    const existing = sessionStorage.getItem(keyForSlug(slug));
    if (existing) return safeParse(existing, null);

    const json = await postJSON(`/games/${encodeURIComponent(slug)}/start`, {});
    const session = json?.session || null;
    if (session?.id) {
      sessionStorage.setItem(keyForSlug(slug), JSON.stringify(session));
      enqueue('game_start', {
        slug,
        sessionId: session.id,
        started_at: session.started_at,
      });
      if (config.debug) console.info(`[analytics] game start: ${slug} -> ${session.id}`);
    }
    return session;
  };

  const trackGameFinish = async (slug, score) => {
    const stored = safeParse(sessionStorage.getItem(keyForSlug(slug)), null);
    const sessionId = stored?.id;
    if (!sessionId) {
      enqueue('game_finish_missing_session', { slug, score });
      if (config.debug) console.warn('[analytics] missing sessionId; call trackGameStart() first');
      return { ok: false, error: 'NO_SESSION' };
    }
    const json = await postJSON(`/games/${encodeURIComponent(slug)}/finish`, { sessionId, score });

    // 게임 종료 후, 계정별 진행도 변화(경험치/포인트)를 기록
    enqueue('game_finish', {
      slug,
      sessionId,
      score,
      payout: json?.payout ?? null,
      // 이벤트 시점의 계정 요약을 그대로 남겨둠
      userSnapshot: {
        id: userContext.id,
        points: userContext.points,
        exp: userContext.exp,
        level: userContext.level,
        tickets: userContext.tickets,
      },
    });

    sessionStorage.removeItem(keyForSlug(slug));
    if (config.debug) console.info(`[analytics] game finish: ${slug} (${sessionId}) score=${score}`, json);
    return json;
  };

  const trackLuckySpin = async () => {
    const json = await postJSON('/games/lucky-spin', {});
    enqueue('lucky_spin', {
      result: json?.result ?? null,
      userSnapshot: {
        id: userContext.id,
        points: userContext.points,
        exp: userContext.exp,
        level: userContext.level,
        tickets: userContext.tickets,
      },
    });
    return json;
  };

  /** ── 초기화(동의 후 호출) ───────────────────────────────────────── */
  const init = (opts = {}) => {
    if (window.__analytics_inited) return;
    window.__analytics_inited = true;

    Object.assign(config, opts || {});
    captureUTM();
    bootstrapUserContextFromRG();
    startTimer();

    if (config.autoClick) {
      document.addEventListener('click', clickHandler, { passive: true });
    }
    if (config.autoPageview) {
      enqueue('pageview', { title: document.title });
    }

    // 탭 전환/종료 시 안전 플러시
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);

    if (config.debug) console.log('[analytics] initialized', {
      VERSION,
      config,
      envRaw,
      userContext: { ...userContext },
    });
  };

  /** ── 공개 API ───────────────────────────────────────────────────── */
  window.Analytics = {
    init,
    event: enqueue,
    flush,
    trackGameStart,
    trackGameFinish,
    trackLuckySpin,
    version: VERSION,
  };
})();
