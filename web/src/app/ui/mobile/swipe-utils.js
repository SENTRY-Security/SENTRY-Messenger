export function createSwipeManager() {
  let openSwipeItem = null;

  function closeSwipe(item) {
    if (!item) return;
    item.classList.remove('show-delete');
    const content = item.querySelector('.item-content');
    if (content) {
      content.style.transform = '';
      content.style.pointerEvents = '';
    }
    if (openSwipeItem === item) openSwipeItem = null;
  }

  function setupSwipe(li) {
    console.log('[Swipe] setupSwipe called for item', li);
    const content = li.querySelector('.item-content');
    if (!content) return;
    const limit = -72;
    let startX = 0;
    let startY = 0;
    let deltaX = 0;
    let deltaY = 0;
    let dragging = false;
    let isHorizontal = false;
    let isVertical = false;

    // Debug logging helper
    const logSwipe = (msg, data) => {
      console.log(`[Swipe] ${msg}`, data);
    };

    const start = (x, y, target) => {
      if (target && target.closest && target.closest('.item-delete')) return false;
      startX = x;
      startY = y;
      deltaX = 0;
      deltaY = 0;
      dragging = true;
      isHorizontal = false;
      isVertical = false;
      logSwipe('start', { x, y });

      // Do not stop propagation here, let potential clicks bubble until we decide it's a swipe
      if (openSwipeItem && openSwipeItem !== li) closeSwipe(openSwipeItem);
      return true;
    };

    const move = (x, y, e) => {
      if (!dragging) return;
      // Once vertical, stop checking
      if (isVertical) return;

      deltaX = x - startX;
      deltaY = y - startY;

      // Determine direction if not yet decided
      if (!isHorizontal && !isVertical) {
        if (Math.abs(deltaX) > 5 || Math.abs(deltaY) > 5) {
          if (Math.abs(deltaX) > Math.abs(deltaY)) {
            isHorizontal = true;
          } else {
            isVertical = true;
            return; // Let browser handle vertical scroll
          }
        } else {
          // Too small to decide yet
          return;
        }
      }

      if (isHorizontal) {
        logSwipe('move:horizontal', { deltaX, cancelable: e?.cancelable, type: e?.type });
        if (e && e.cancelable) e.preventDefault();
        if (e && e.stopPropagation) {
          logSwipe('move:horizontal:stopping_propagation', {});
          e.stopPropagation(); // Stop bubbling to pull-to-refresh
        }
        if (deltaX < 0) {
          content.style.transform = `translateX(${Math.max(deltaX, limit)}px)`;
        } else {
          content.style.transform = `translateX(${Math.min(deltaX, 12)}px)`;
        }
      }
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      isHorizontal = false;
      isVertical = false;

      if (deltaX < -40) {
        li.classList.add('show-delete');
        content.style.transform = `translateX(${limit}px)`;
        content.style.pointerEvents = 'none';
        openSwipeItem = li;
      } else {
        closeSwipe(li);
      }
    };

    li.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (!start(e.touches[0].clientX, e.touches[0].clientY, e.target)) return;
    }, { passive: true });

    li.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      move(e.touches[0].clientX, e.touches[0].clientY, e);
    }, { passive: false });

    li.addEventListener('touchend', end, { passive: true });
    li.addEventListener('touchcancel', end, { passive: true });

    li.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (e.buttons !== 1) return;
      li.setPointerCapture(e.pointerId);
      if (!start(e.clientX, e.target)) {
        li.releasePointerCapture(e.pointerId);
      }
    });

    li.addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (!li.hasPointerCapture(e.pointerId)) return;
      move(e.clientX);
    });

    li.addEventListener('pointerup', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (li.hasPointerCapture(e.pointerId)) li.releasePointerCapture(e.pointerId);
      end();
    });

    li.addEventListener('pointercancel', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (li.hasPointerCapture(e.pointerId)) li.releasePointerCapture(e.pointerId);
      end();
    });
  }

  document.addEventListener('touchstart', (e) => {
    if (openSwipeItem && !openSwipeItem.contains(e.target)) {
      closeSwipe(openSwipeItem);
    }
  }, { passive: true });

  document.addEventListener('mousedown', (e) => {
    if (openSwipeItem && !openSwipeItem.contains(e.target)) {
      closeSwipe(openSwipeItem);
    }
  });

  function closeOpenSwipe() {
    if (openSwipeItem) closeSwipe(openSwipeItem);
  }

  return { setupSwipe, closeSwipe, closeOpenSwipe };
}
