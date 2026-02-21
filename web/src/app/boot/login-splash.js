// login.html — splash screen hide logic
window.__hideLoginSplash = function(){
  var el = document.getElementById('loginSplash');
  if (!el) return;
  el.classList.add('fade-out');
  setTimeout(function(){ if (el.parentNode) el.parentNode.removeChild(el); }, 400);
};
setTimeout(function(){ window.__hideLoginSplash(); }, 8000);
