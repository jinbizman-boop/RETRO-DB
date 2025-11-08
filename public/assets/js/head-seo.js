// public/assets/js/head-seo.js
// Optional fallback to inject /partials/head-seo.html into <head> on static hosting (no SSI/build step).
(function(){
  if (document.querySelector('meta[name="robots"][content]')) return; // assume already present
  fetch('/partials/head-seo.html', { credentials: 'include' })
    .then(function(r){ return r.text(); })
    .then(function(html){
      var tmp = document.createElement('div'); tmp.innerHTML = html;
      // move only link/meta/script children into head (avoid duplicate charset/viewport from page)
      Array.prototype.slice.call(tmp.children).forEach(function(el){
        if (/^(LINK|META|SCRIPT)$/i.test(el.tagName)) document.head.appendChild(el);
      });
    })
    .catch(function(e){ if (window.console) console.warn('[head-seo] inject fail', e); });
})();