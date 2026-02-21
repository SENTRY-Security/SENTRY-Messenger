// debug.html — API origin + module loader
window.API_ORIGIN = (document.querySelector('meta[name="api-origin"]') || {}).content || 'https://api.message.sentry.red';

(function loadDebugModule(){
  var stamp = window.APP_BUILD_AT || window.APP_VERSION || String(Date.now());
  var script = document.createElement('script');
  script.type = 'module';
  script.src = '/app/ui/debug-page.js?v=' + encodeURIComponent(stamp);
  script.onerror = function() {
    if (script.dataset.retry) return;
    script.dataset.retry = '1';
    var fallback = document.createElement('script');
    fallback.type = 'module';
    fallback.src = '/app/ui/debug-page.js?v=' + Date.now();
    if (script.integrity) { fallback.integrity = script.integrity; fallback.crossOrigin = 'anonymous'; }
    document.body.appendChild(fallback);
  };
  document.body.appendChild(script);
})();
