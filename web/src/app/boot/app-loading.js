/* ── app.html — App Loading: Matrix Rain ── */
(function(){
  var cvs, ctx, w, h, raf, columns, drops, running = false;
  var CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789アイウエオカキクケコサシスセソ$@#&%!?<>{}[]';
  var FS = 13;
  function init(){
    cvs = document.getElementById('appTmCanvas');
    if(!cvs) return;
    ctx = cvs.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }
  function resize(){
    if(!cvs) return;
    w = cvs.width = cvs.parentElement.clientWidth;
    h = cvs.height = cvs.parentElement.clientHeight;
    columns = Math.floor(w / FS);
    var maxRow = Math.floor(h / FS);
    drops = [];
    for(var i=0;i<columns;i++){
      // 40% of columns start mid-screen so canvas looks pre-populated on load
      drops[i] = Math.random() < 0.4 ? (Math.random()*maxRow|0) : -(Math.random()*80|0);
    }
  }
  function tick(){
    if(!running) return;
    ctx.fillStyle = 'rgba(5,10,20,0.12)';
    ctx.fillRect(0,0,w,h);
    ctx.font = FS + 'px monospace';
    for(var i=0;i<columns;i++){
      if(drops[i]<0){ drops[i]++; continue; }
      var ch = CHARS[Math.random()*CHARS.length|0];
      var y = drops[i] * FS;
      ctx.fillStyle = 'rgba(16,185,129,0.7)';
      ctx.fillText(ch, i*FS, y);
      if(y > FS){
        ctx.fillStyle = 'rgba(16,185,129,0.08)';
        ctx.fillText(CHARS[Math.random()*CHARS.length|0], i*FS, y - FS);
      }
      drops[i]++;
      if(y > h && Math.random() > 0.975) drops[i] = 0;
    }
    raf = requestAnimationFrame(tick);
  }
  // Auto-start — pre-draw several frames so canvas looks populated immediately
  running = true;
  init();
  if(ctx){
    ctx.fillStyle='#050a14'; ctx.fillRect(0,0,w,h);
    // Silently advance a few frames to seed visible characters
    ctx.font = FS + 'px monospace';
    for(var f=0;f<8;f++){
      ctx.fillStyle='rgba(5,10,20,0.12)'; ctx.fillRect(0,0,w,h);
      for(var i=0;i<columns;i++){
        if(drops[i]<0){ drops[i]++; continue; }
        var ch=CHARS[Math.random()*CHARS.length|0];
        var y=drops[i]*FS;
        ctx.fillStyle='rgba(16,185,129,0.7)'; ctx.fillText(ch,i*FS,y);
        if(y>FS){ ctx.fillStyle='rgba(16,185,129,0.08)'; ctx.fillText(CHARS[Math.random()*CHARS.length|0],i*FS,y-FS); }
        drops[i]++;
        if(y>h&&Math.random()>0.975) drops[i]=0;
      }
    }
  }
  tick();
  // Expose stop so __hideLoadingModal can call it
  window.__appTmStop = function(){ running = false; if(raf) cancelAnimationFrame(raf); };
})();

/* ── Loading progress manager ── */
(function () {
  var stages = {
    styles:        { label: 'LOADING INTERFACE...',       progress: 74 },
    scripts:       { label: 'LOADING MODULES...',         progress: 80 },
    account:       { label: 'SYNCING ACCOUNT DATA...',    progress: 86 },
    contacts:      { label: 'SYNCING CONTACTS...',        progress: 92 },
    conversations: { label: 'SYNCING CONVERSATIONS...',   progress: 96 },
    ready:         { label: 'SYSTEM READY',               progress: 100 }
  };
  var bar   = document.getElementById('appLoadingBar');
  var label = document.getElementById('appLoadingLabel');
  var modal = document.getElementById('appLoadingModal');
  var current = 70;
  var fillRAF = null;
  var fillTarget = 0;
  var fillLast = 0;
  var FILL_SPEED = 10;
  function setBarWidth(pct) { if (bar) bar.style.width = pct + '%'; }
  function startSlowFill(target) {
    fillTarget = target;
    if (fillRAF) return;
    fillLast = performance.now();
    function tick(now) {
      var dt = (now - fillLast) / 1000;
      fillLast = now;
      if (current < fillTarget - 0.3) {
        current = Math.min(current + FILL_SPEED * dt, fillTarget - 0.3);
        setBarWidth(current);
        fillRAF = requestAnimationFrame(tick);
      } else {
        fillRAF = null;
      }
    }
    fillRAF = requestAnimationFrame(tick);
  }
  function stopSlowFill() {
    if (fillRAF) { cancelAnimationFrame(fillRAF); fillRAF = null; }
  }
  window.__updateLoadingProgress = function (stageId) {
    var stage = stages[stageId];
    if (!stage || stage.progress <= current) return;
    stopSlowFill();
    current = stage.progress;
    setBarWidth(current);
    if (label) label.textContent = stage.label;
    // Find next stage to slowly fill toward
    var keys = Object.keys(stages);
    var idx = keys.indexOf(stageId);
    if (idx >= 0 && idx < keys.length - 1) {
      startSlowFill(stages[keys[idx + 1]].progress);
    }
  };
  window.__hideLoadingModal = function () {
    stopSlowFill();
    if (typeof window.__appTmStop === 'function') window.__appTmStop();
    if (!modal) return;
    modal.classList.add('glitch-out');
    setTimeout(function () { if (modal.parentNode) modal.parentNode.removeChild(modal); }, 750);
  };
  /* ── Morph progress bar into "Enter" button ── */
  window.__morphToEnterButton = function () {
    stopSlowFill();
    current = 100;
    setBarWidth(100);
    if (label) label.textContent = 'SYSTEM READY';
    setTimeout(function () {
      if (modal) modal.classList.add('morph-enter');
      if (label) { label.textContent = '點擊以啟用安全通訊'; label.style.letterSpacing = '1.5px'; }
    }, 600);
  };
  window.__setSplashStatus = function (msg) {
    var el = document.getElementById('appLoadingStatus');
    if (el) el.textContent = msg || '';
  };
  window.__setSplashAuthorizing = function (active) {
    if (!modal) return;
    var enterLabel = document.getElementById('appEnterLabel');
    if (active) {
      modal.classList.add('morph-authorizing');
      if (enterLabel) enterLabel.textContent = '授權中\u2026';
      if (label) label.textContent = '請在系統視窗中按下「允許」';
    } else {
      modal.classList.remove('morph-authorizing');
      if (enterLabel) enterLabel.textContent = '進 入';
      if (label) { label.textContent = '點擊以啟用安全通訊'; label.style.letterSpacing = '1.5px'; }
    }
  };
  window.__setSplashSuccess = function () {
    if (!modal) return;
    modal.classList.add('morph-success');
    modal.classList.remove('morph-authorizing');
    var enterLabel = document.getElementById('appEnterLabel');
    if (enterLabel) enterLabel.textContent = '\u2713';
    if (label) label.textContent = '授權成功';
    setTimeout(function () { window.__hideLoadingModal(); }, 800);
  };
  // Auto-advance to 'styles' when all async CSS is loaded
  var cssDone = false;
  var cssLinks = document.querySelectorAll('link[rel="stylesheet"][media="print"]');
  var loaded = 0;
  var total = cssLinks.length;
  function markCssDone() {
    if (cssDone) return;
    cssDone = true;
    window.__updateLoadingProgress('styles');
  }
  function onCssLoad() {
    loaded++;
    if (loaded >= total) markCssDone();
  }
  for (var i = 0; i < cssLinks.length; i++) {
    cssLinks[i].addEventListener('load', onCssLoad);
  }
  if (total === 0) markCssDone();
  // Safety: if cached CSS already switched media before this script ran, or onload failed
  setTimeout(function () {
    if (!cssDone) markCssDone();
  }, 3000);
  // Start slow-fill immediately from 70% toward first stage (74%)
  startSlowFill(stages.styles.progress);
})();
