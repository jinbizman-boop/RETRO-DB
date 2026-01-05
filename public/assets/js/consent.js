/* TELOS – analytics consent banner (standalone JS file)
 * Path: public/assets/js/consent.js
 * Notes:
 *  - No <script> wrapper. Load with: <script defer src="/assets/js/consent.js"></script>
 *  - Calls window.Analytics.init({ collectEndpoint:'/analytics/collect' }) after consent.
 */
(() => {
  'use strict';

  const KEY = 'telos_analytics_consent_v1';

  function hasConsent() {
    try { return localStorage.getItem(KEY) === 'yes'; }
    catch (_e) { return false; }
  }

  function initAnalytics() {
    // Run only if analytics.js exists and exposes init()
    try {
      if (window.Analytics && typeof window.Analytics.init === 'function') {
        window.Analytics.init({ collectEndpoint: '/api/analytics/collect' });
      }
    } catch (_e) { /* noop */ }
  }

  function showBanner() {
    if (hasConsent()) { initAnalytics(); return; }

    const b = document.createElement('div');
    b.id = 'telos-consent-banner';
    b.style.cssText = [
      'position:fixed','left:12px','right:12px','bottom:12px',
      'background:rgba(10,10,20,.95)','color:#fff','padding:12px',
      'border-radius:10px','z-index:99999','box-shadow:0 8px 24px rgba(0,0,0,.35)'
    ].join(';');

    b.innerHTML = [
      '<div style="display:flex;gap:12px;align-items:center;justify-content:space-between;">',
        '<div style="font-size:14px;line-height:1.4">',
          '서비스 품질 향상을 위해 사용 이벤트(페이지/게임/구매/스핀)를 수집합니다. 동의하시겠습니까? ',
          '<a href="/legal/privacy.html" style="color:#8ecaff;text-decoration:underline">자세히</a>',
        '</div>',
        '<div>',
          '<button id="consent-yes" style="margin-right:8px">동의</button>',
          '<button id="consent-no">거부</button>',
        '</div>',
      '</div>'
    ].join('');

    document.body.appendChild(b);

    const onYes = () => {
      try { localStorage.setItem(KEY, 'yes'); } catch (_e) {}
      b.remove();
      initAnalytics();
    };
    const onNo = () => {
      try { localStorage.setItem(KEY, 'no'); } catch (_e) {}
      b.remove();
    };

    const yesBtn = b.querySelector('#consent-yes');
    const noBtn  = b.querySelector('#consent-no');
    if (yesBtn) yesBtn.addEventListener('click', onYes);
    if (noBtn)  noBtn.addEventListener('click', onNo);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', showBanner);
  } else {
    showBanner();
  }
})();
