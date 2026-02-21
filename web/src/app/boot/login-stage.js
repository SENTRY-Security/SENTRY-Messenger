/* ── login.html — Transition Canvas: Matrix Rain ── */
(function(){
  var cvs, ctx, w, h, raf, columns, drops, running = false;
  var MATRIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789アイウエオカキクケコサシスセソ$@#&%!?<>{}[]';
  var FONT_SIZE = 13;

  function initCanvas(){
    cvs = document.getElementById('tmCanvas');
    if(!cvs) return;
    ctx = cvs.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
  }

  function resize(){
    if(!cvs) return;
    w = cvs.width = cvs.parentElement.clientWidth;
    h = cvs.height = cvs.parentElement.clientHeight;
    initMatrix();
  }

  function initMatrix(){
    columns = Math.floor(w / FONT_SIZE);
    drops = [];
    for(var i=0;i<columns;i++){
      drops[i] = -(Math.random()*80|0);
    }
  }

  function drawMatrix(){
    ctx.font = FONT_SIZE + 'px monospace';
    for(var i=0;i<columns;i++){
      if(drops[i]<0){ drops[i]++; continue; }
      var ch = MATRIX_CHARS[Math.random()*MATRIX_CHARS.length|0];
      var y = drops[i] * FONT_SIZE;
      ctx.fillStyle = 'rgba(16,185,129,0.7)';
      ctx.fillText(ch, i*FONT_SIZE, y);
      if(y > FONT_SIZE){
        ctx.fillStyle = 'rgba(16,185,129,0.08)';
        ctx.fillText(MATRIX_CHARS[Math.random()*MATRIX_CHARS.length|0], i*FONT_SIZE, y - FONT_SIZE);
      }
      drops[i]++;
      if(y > h && Math.random() > 0.975){
        drops[i] = 0;
      }
    }
  }

  function tick(){
    if(!running) return;
    ctx.fillStyle = 'rgba(5,10,20,0.12)';
    ctx.fillRect(0, 0, w, h);
    drawMatrix();
    raf = requestAnimationFrame(tick);
  }

  window.__tmCanvasStart = function(){
    if(running) return;
    running = true;
    initCanvas();
    if(ctx){ ctx.fillStyle='#050a14'; ctx.fillRect(0,0,w,h); }
    tick();
  };
  window.__tmCanvasStop = function(){
    running = false;
    if(raf) cancelAnimationFrame(raf);
    raf = null;
  };
})();

/* ── Brand Text Scramble/Decrypt Animation ── */
(function(){
  var BRAND = 'SENTRY MESSENGER';
  var GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&!?<>{}[]';
  var el, chars, resolved, frame, raf, running;

  function init(){
    el = document.getElementById('tmBrand');
    if(!el) return;
    el.innerHTML = '';
    chars = [];
    resolved = [];
    for(var i=0;i<BRAND.length;i++){
      var span = document.createElement('span');
      span.className = 'char scrambling';
      span.textContent = BRAND[i] === ' ' ? '\u00A0' : GLYPHS[Math.random()*GLYPHS.length|0];
      el.appendChild(span);
      chars.push(span);
      resolved.push(BRAND[i] === ' ');
    }
    frame = 0;
  }

  function tick(){
    if(!running) return;
    frame++;
    var revealIdx = Math.floor(frame / 6); // reveal 1 char every 6 frames (~100ms each)
    for(var i=0;i<chars.length;i++){
      if(BRAND[i] === ' ') continue;
      if(i <= revealIdx){
        if(!resolved[i]){
          chars[i].textContent = BRAND[i];
          chars[i].className = 'char resolved';
          resolved[i] = true;
        }
      } else {
        chars[i].textContent = GLYPHS[Math.random()*GLYPHS.length|0];
      }
    }
    if(revealIdx >= BRAND.length){
      // All resolved — keep stable
      running = false;
      return;
    }
    raf = requestAnimationFrame(tick);
  }

  window.__tmScrambleStart = function(){
    running = true;
    init();
    tick();
  };
  window.__tmScrambleStop = function(){
    running = false;
    if(raf) cancelAnimationFrame(raf);
    // Show final text
    if(el) el.textContent = BRAND;
  };
})();
