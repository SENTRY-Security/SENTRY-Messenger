export function createSwipeManager() {
  let openSwipeItem = null;

  function closeSwipe(item) {
    if (!item) return;
    item.classList.remove('show-delete');
    const content = item.querySelector('.item-content');
    if (content) content.style.transform = '';
    if (openSwipeItem === item) openSwipeItem = null;
  }

  function setupSwipe(li) {
    const content = li.querySelector('.item-content');
    if (!content) return;
    const limit = -72;
    let startX = 0;
    let deltaX = 0;
    let dragging = false;

    const start = (x, target) => {
      if (target && target.closest && target.closest('.item-delete')) return false;
      startX = x;
      deltaX = 0;
      dragging = true;
      if (openSwipeItem && openSwipeItem !== li) closeSwipe(openSwipeItem);
      return true;
    };

    const move = (x) => {
      if (!dragging) return;
      deltaX = x - startX;
      if (deltaX < 0) {
        content.style.transform = `translateX(${Math.max(deltaX, limit)}px)`;
      } else {
        content.style.transform = `translateX(${Math.min(deltaX, 12)}px)`;
      }
    };

    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (deltaX < -40) {
        li.classList.add('show-delete');
        content.style.transform = `translateX(${limit}px)`;
        openSwipeItem = li;
      } else {
        closeSwipe(li);
      }
    };

    li.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      if (!start(e.touches[0].clientX, e.target)) return;
    }, { passive: true });

    li.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      move(e.touches[0].clientX);
    }, { passive: true });

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
