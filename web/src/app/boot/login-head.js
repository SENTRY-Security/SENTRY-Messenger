// login.html <head> — e2e detection + version globals
try {
  var params = new URLSearchParams(location.search);
  if (params.get('e2e') === '1') {
    document.documentElement.classList.add('no-anim');
  }
} catch(e) {}
window.APP_VERSION = '0.1.21-atomic-fix';
window.APP_BUILD_AT = (function(){ try { return new Date(document.lastModified).toISOString(); } catch(e) { return new Date().toISOString(); } })();
