// Hard-disable zoom gestures (reinforce meta viewport)

export function disableZoom() {
  try {
    // iOS Safari pinch gesture
    const stop = (e) => { e.preventDefault(); };
    ['gesturestart', 'gesturechange', 'gestureend'].forEach(t => {
      document.addEventListener(t, stop, { passive: false });
    });
    // Prevent double-tap zoom
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch < 350) { e.preventDefault(); }
      lastTouch = now;
    }, { passive: false });
    // Ctrl/Meta + wheel zoom (desktop browsers)
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    }, { passive: false });
    // Ctrl/Cmd + +/-/0
    window.addEventListener('keydown', (e) => {
      const k = e.key;
      if ((e.ctrlKey || e.metaKey) && (k === '+' || k === '-' || k === '=' || k === '0')) {
        e.preventDefault();
      }
    });
  } catch { }
}
