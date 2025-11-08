/**
 * RETRO GAMES – modal.js
 * Path: public/assets/js/modal.js
 *
 * 기능
 * - data-modal-open / data-modal-close / data-modal(컨테이너) 자동 바인딩
 * - Modal.open(id) / Modal.close(id) / Modal.toggle(id) API 제공
 * - ESC / 배경 클릭 닫기, 포커스 트랩, 스크롤 잠금, 포커스 복귀
 * - #authModal 과 app.js의 openAuthModal/closeAuthModal와 호환
 *
 * 요구 CSS (이미 프로젝트에 존재)
 * .modal { display:none; } .modal.show { display:flex; }
 */
(() => {
  const ATTR_OPEN = 'data-modal-open';    // 버튼: data-modal-open="authModal"
  const ATTR_CLOSE = 'data-modal-close';  // 닫기 버튼: data-modal-close(값 무관)
  const ATTR_CONTAINER = 'data-modal';    // 컨테이너: <div class="modal" id="authModal" data-modal>

  const MODAL_OPEN_CLASS = 'show';
  const BODY_LOCK_CLASS = 'modal-open';

  const tabbableSelector = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  const state = {
    current: null,                 // 현재 열린 모달 element
    lastFocused: new Map(),        // modalId -> Element
    scrollY: 0,
  };

  const qs = (s, el = document) => el.querySelector(s);
  const qsa = (s, el = document) => Array.from(el.querySelectorAll(s));

  /* ──────────────── 스크롤 잠금/해제 ──────────────── */
  const lockScroll = () => {
    if (document.body.classList.contains(BODY_LOCK_CLASS)) return;
    state.scrollY = window.scrollY || window.pageYOffset;
    document.body.style.top = `-${state.scrollY}px`;
    document.body.classList.add(BODY_LOCK_CLASS);
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
  };
  const unlockScroll = () => {
    if (!document.body.classList.contains(BODY_LOCK_CLASS)) return;
    document.body.classList.remove(BODY_LOCK_CLASS);
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.width = '';
    window.scrollTo(0, state.scrollY || 0);
  };

  /* ──────────────── 포커스 유틸 ──────────────── */
  const getTabbables = (root) => qsa(tabbableSelector, root).filter(el => !el.hasAttribute('disabled') && el.offsetParent !== null);
  const trapFocus = (e) => {
    const modal = state.current;
    if (!modal) return;
    if (e.key !== 'Tab') return;
    const list = getTabbables(modal);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === modal)) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  };

  /* ──────────────── 열기/닫기 ──────────────── */
  const open = (id) => {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (state.current === modal) return;

    // 현재 열린 모달이 있으면 닫기
    if (state.current) close(state.current.id);

    // 포커스 복귀용 저장
    const active = document.activeElement;
    if (active) state.lastFocused.set(id, active);

    modal.classList.add(MODAL_OPEN_CLASS);
    modal.setAttribute('aria-hidden', 'false');
    modal.style.display = 'flex';

    // 접근성: 라우터/스크린리더 친화
    modal.setAttribute('role', modal.getAttribute('role') || 'dialog');
    modal.setAttribute('aria-modal', 'true');

    state.current = modal;
    lockScroll();

    // 첫 포커스 타겟
    const first = modal.querySelector('.cta, [autofocus], button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    setTimeout(() => {
      (first || modal).focus({ preventScroll: true });
    }, 0);

    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('keydown', trapFocus, true);
    modal.addEventListener('click', onBackdropClick, true);
  };

  const close = (id) => {
    const modal = (typeof id === 'string') ? document.getElementById(id) : id;
    if (!modal) return;
    modal.classList.remove(MODAL_OPEN_CLASS);
    modal.setAttribute('aria-hidden', 'true');
    modal.style.display = 'none';

    // 포커스 복귀
    const last = state.lastFocused.get(modal.id);
    if (last && document.body.contains(last)) {
      setTimeout(() => { try { last.focus({ preventScroll: true }); } catch(_) {} }, 0);
    }
    state.lastFocused.delete(modal.id);

    // 이벤트 해제
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('keydown', trapFocus, true);
    modal.removeEventListener('click', onBackdropClick, true);

    state.current = null;
    unlockScroll();
  };

  const toggle = (id) => {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (modal.classList.contains(MODAL_OPEN_CLASS)) close(id);
    else open(id);
  };

  /* ──────────────── 이벤트 핸들러 ──────────────── */
  const onKeydown = (e) => {
    if (e.key === 'Escape' && state.current) {
      close(state.current.id);
    }
  };
  const onBackdropClick = (e) => {
    if (!state.current) return;
    if (e.target === state.current) {
      close(state.current.id);
    }
  };

  /* ──────────────── 자동 바인딩 ──────────────── */
  const bindDelegates = () => {
    document.addEventListener('click', (e) => {
      const opener = e.target.closest(`[${ATTR_OPEN}]`);
      if (opener) {
        const id = opener.getAttribute(ATTR_OPEN);
        if (id) open(id);
        return;
      }
      const closer = e.target.closest(`[${ATTR_CLOSE}]`);
      if (closer) {
        if (state.current) close(state.current.id);
      }
    });
  };

  /* ──────────────── 초기화 ──────────────── */
  const init = () => {
    // ARIA 기본값 및 tabindex 보정
    qsa(`[${ATTR_CONTAINER}]`).forEach(modal => {
      modal.setAttribute('aria-hidden', modal.classList.contains(MODAL_OPEN_CLASS) ? 'false' : 'true');
      if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');
    });
    bindDelegates();

    // app.js의 openAuthModal/closeAuthModal과 상호 보완
    // 기존 코드에서 openAuthModal()이 존재하더라도, 아래 window.Modal을 사용할 수 있음.
    if (!window.openAuthModal) window.openAuthModal = () => open('authModal');
    if (!window.closeAuthModal) window.closeAuthModal = () => close('authModal');

    // 전역 API
    window.Modal = { open, close, toggle };
  };

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
