/**
 * RETRO GAMES – analytics.js (Unified RC)
 * Path: public/assets/js/analytics.js
 *
 * 정책
 * - 자동 초기화 없음(Consent 후 외부에서 window.Analytics.init(opts) 호출)
 * - collectEndpoint 기본: '/analytics/collect'  (서버 라우트 필요)
 * - <html data-env="production"> 또는 "prod" → debug=false
 * - 전역 API: window.Analytics = { init, event, flush, trackGameStart, trackGameFinish, trackLuckySpin, version }
 *
 * 기존 기능은 유지하고, 모듈/전역 혼용·동의배너 핸들러를 제거하여 충돌을 방지.
 */
(() => {
  const VERSION = '1.2.0';
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
    collectEndpoint: '/analytics/collect',
    debug: !isProd,
    credentials: 'include',
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

  const safeParse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

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
  const loadQueue = () => safeParse(localStorage.getItem(STORAGE_KEY), []);
  const saveQueue = (q) => localStorage.setItem(STORAGE_KEY, JSON.stringify(q.slice(-MAX_QUEUE)));

  /** ── enqueue ─────────────────────────────────────────────────────── */
  const enqueue = (type, payload = {}) => {
    const item = {
      id: uuid(),
      t: now(),
      type,
      page: location.pathname + location.search,
      ref: getRef(),
      utm: safeParse(localStorage.getItem(UTM_KEY), null),
      device: getDevice(),
      payload,
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
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error || `HTTP_${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
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
      enqueue('game_start', { slug, sessionId: session.id, started_at: session.started_at });
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
    enqueue('game_finish', { slug, sessionId, score, payout: json?.payout ?? null });
    sessionStorage.removeItem(keyForSlug(slug));
    if (config.debug) console.info(`[analytics] game finish: ${slug} (${sessionId}) score=${score}`, json);
    return json;
  };

  const trackLuckySpin = async () => {
    const json = await postJSON('/games/lucky-spin', {});
    enqueue('lucky_spin', { result: json?.result ?? null });
    return json;
  };

  /** ── 초기화(동의 후 호출) ───────────────────────────────────────── */
  const init = (opts = {}) => {
    if (window.__analytics_inited) return;
    window.__analytics_inited = true;

    Object.assign(config, opts || {});
    captureUTM();
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

    if (config.debug) console.log('[analytics] initialized', { VERSION, config, envRaw });
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
