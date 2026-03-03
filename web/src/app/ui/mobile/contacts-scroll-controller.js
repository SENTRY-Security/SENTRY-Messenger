/**
 * contacts-scroll-controller.js
 *
 * Drives progressive hide/show of topbar, navbar, and contact-list-header
 * based on native scroll position and direction.
 *
 * Phase 1 (0 → headerH):     "N個好友" fades out (position-driven)
 * Phase 2 (headerH → barTh):  Search bar scrolls out naturally
 * Phase 3 (> barTh):          Topbar/navbar slide out (position-driven, ~60px)
 *
 * Restore: direction-driven — as soon as user scrolls back toward top,
 * bars animate back immediately.
 */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const BAR_SCROLL_RANGE = 60; // px of scroll past threshold to fully hide bars

export function createContactsScrollController({
  scrollEl,
  headerEl,
  topbarEl,
  navbarEl,
  tabEl,
  contentEl
}) {
  if (!scrollEl) return null;

  /* ---- measurements ---- */
  const headerH = headerEl ? headerEl.offsetHeight : 40;
  const searchWrap = scrollEl.querySelector('.contacts-search-wrap');
  const searchH = searchWrap ? searchWrap.offsetHeight + 8 : 50; // +margin
  const barThreshold = headerH + searchH;

  /* ---- state ---- */
  let prevScrollTop = 0;
  let barsHidden = false;
  let rafId = 0;
  let destroyed = false;

  /* ---- helpers ---- */
  function applyHeaderOpacity(scrollTop) {
    if (!headerEl) return;
    const opacity = clamp(1 - scrollTop / headerH, 0, 1);
    headerEl.style.opacity = String(opacity);
    headerEl.style.visibility = opacity <= 0 ? 'hidden' : '';
  }

  function hideBars(progress) {
    // progress: 0 = fully visible, 1 = fully hidden
    if (topbarEl) {
      topbarEl.style.transition = 'none';
      topbarEl.style.transform = `translateY(${-progress * 100}%)`;
    }
    if (navbarEl) {
      navbarEl.style.transition = 'none';
      navbarEl.style.transform = `translateY(${progress * 100}%)`;
    }
    if (progress >= 1 && !barsHidden) {
      barsHidden = true;
      if (tabEl) tabEl.classList.add('contacts-fullscreen');
      if (contentEl) contentEl.classList.add('contacts-content-fullscreen');
    }
  }

  function showBars() {
    if (!barsHidden) return;
    barsHidden = false;
    if (tabEl) tabEl.classList.remove('contacts-fullscreen');
    if (contentEl) contentEl.classList.remove('contacts-content-fullscreen');
    if (topbarEl) {
      topbarEl.style.transition = 'transform 220ms ease-out';
      topbarEl.style.transform = '';
    }
    if (navbarEl) {
      navbarEl.style.transition = 'transform 220ms ease-out';
      navbarEl.style.transform = '';
    }
  }

  /* ---- main scroll handler ---- */
  function onScroll() {
    if (destroyed) return;
    if (rafId) return; // already scheduled
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (destroyed) return;
      const scrollTop = scrollEl.scrollTop;
      const scrollingDown = scrollTop < prevScrollTop; // toward top = "down"

      // Phase 1: header fade
      applyHeaderOpacity(scrollTop);

      // Phase 3: bar hide/show
      if (scrollTop > barThreshold) {
        if (scrollingDown && barsHidden) {
          // direction-driven restore
          showBars();
        } else if (!scrollingDown && !barsHidden) {
          // position-driven hide
          const progress = clamp((scrollTop - barThreshold) / BAR_SCROLL_RANGE, 0, 1);
          hideBars(progress);
        } else if (!scrollingDown && barsHidden) {
          // already hidden, keep hidden (no-op)
        }
      } else {
        // scrolled back above threshold — bars must be visible
        if (barsHidden) {
          showBars();
        }
        // Also clear any leftover transform from partial hide
        if (topbarEl && topbarEl.style.transform) {
          topbarEl.style.transition = 'transform 220ms ease-out';
          topbarEl.style.transform = '';
        }
        if (navbarEl && navbarEl.style.transform) {
          navbarEl.style.transition = 'transform 220ms ease-out';
          navbarEl.style.transform = '';
        }
      }

      prevScrollTop = scrollTop;
    });
  }

  /* ---- lifecycle ---- */
  scrollEl.addEventListener('scroll', onScroll, { passive: true });
  // initial state
  applyHeaderOpacity(scrollEl.scrollTop);

  function restoreBars() {
    if (barsHidden) showBars();
    // Also force-clear transforms in case of partial state
    if (topbarEl) { topbarEl.style.transition = ''; topbarEl.style.transform = ''; }
    if (navbarEl) { navbarEl.style.transition = ''; navbarEl.style.transform = ''; }
    if (tabEl) tabEl.classList.remove('contacts-fullscreen');
    if (contentEl) contentEl.classList.remove('contacts-content-fullscreen');
    barsHidden = false;
  }

  function isBarsHidden() {
    return barsHidden;
  }

  function destroy() {
    destroyed = true;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    scrollEl.removeEventListener('scroll', onScroll);
    restoreBars();
    if (headerEl) { headerEl.style.opacity = ''; headerEl.style.visibility = ''; }
  }

  return { restoreBars, isBarsHidden, destroy };
}
