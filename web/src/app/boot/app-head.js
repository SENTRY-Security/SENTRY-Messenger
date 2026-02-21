// app.html <head> — global guards + version
// Prevent ReferenceError in Safari when inviteBtn is not yet declared
if (typeof inviteBtn === 'undefined') {
  // eslint-disable-next-line no-var
  var inviteBtn = null;
}
window.APP_VERSION = '0.1.21-atomic-fix';
window.APP_BUILD_AT = (function () { try { return new Date(document.lastModified).toISOString(); } catch(e) { return new Date().toISOString(); } })();

// Async CSS loading: switch media="print" → media="all" once loaded
// (replaces inline onload="this.media='all'" which CSP blocks)
(function () {
  var links = document.querySelectorAll('link[rel="stylesheet"][media="print"]');
  for (var i = 0; i < links.length; i++) {
    (function (link) {
      if (link.sheet) { link.media = 'all'; return; }
      link.addEventListener('load', function () { link.media = 'all'; });
    })(links[i]);
  }
})();
