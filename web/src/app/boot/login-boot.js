// login.html — API origin + orientation lock + pinch zoom disable + module loader
(function() {
  var apiMeta = document.querySelector('meta[name="api-origin"]');
  var params = new URLSearchParams(location.search);
  window.API_ORIGIN = params.get('api') || (apiMeta ? apiMeta.content : 'https://api.message.sentry.red');
})();

(function(){
  var overlay = document.getElementById('orientationOverlay');
  var docEl = document.documentElement;
  var mq = window.matchMedia('(orientation: portrait)');
  var isMobileLike = function() {
    var touch = navigator.maxTouchPoints || navigator.msMaxTouchPoints || 0;
    var shortEdge = Math.min(window.innerWidth, window.innerHeight);
    var ua = navigator.userAgent || '';
    var looksMobileUA = /iPhone|iPad|Android|Mobile/i.test(ua);
    return shortEdge <= 1024 && (touch > 0 || looksMobileUA);
  };
  function update(){
    if (!isMobileLike()) {
      docEl.classList.remove('orientation-block');
      if (overlay) overlay.setAttribute('aria-hidden','true');
      return;
    }
    var portrait = mq.matches || window.innerHeight >= window.innerWidth;
    if (portrait) {
      docEl.classList.remove('orientation-block');
      if (overlay) overlay.setAttribute('aria-hidden','true');
    } else {
      docEl.classList.add('orientation-block');
      if (overlay) overlay.setAttribute('aria-hidden','false');
    }
  }
  if (mq.addEventListener) mq.addEventListener('change', update); else mq.addListener(update);
  window.addEventListener('orientationchange', update);
  window.addEventListener('resize', update);
  update();
  if (screen.orientation && screen.orientation.lock && isMobileLike()) {
    screen.orientation.lock('portrait').catch(function(){});
  }
})();

(function disablePinchZoom(){
  var prevent = function(evt) { evt.preventDefault(); };
  document.addEventListener('gesturestart', prevent, { passive:false });
  document.addEventListener('gesturechange', prevent, { passive:false });
  document.addEventListener('gestureend', prevent, { passive:false });
})();

(function loadLoginModule(){
  var stamp = window.APP_BUILD_AT || window.APP_VERSION || String(Date.now());
  var script = document.createElement('script');
  script.type = 'module';
  script.src = '/app/ui/login-ui.js?v=' + encodeURIComponent(stamp);
  script.onerror = function() {
    if (script.dataset.retry) return;
    script.dataset.retry = '1';
    var fallback = document.createElement('script');
    fallback.type = 'module';
    fallback.src = '/app/ui/login-ui.js?v=' + Date.now();
    document.body.appendChild(fallback);
  };
  document.body.appendChild(script);
})();
