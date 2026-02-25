/**
 * Scroll and interaction utilities for messages UI.
 * Extracted from messages-pane.js to reduce file size.
 */

/**
 * Scroll a container element to the bottom.
 * @param {HTMLElement} scrollEl - The scrollable container element
 */
export function scrollToBottom(scrollEl) {
    if (!scrollEl) return;
    scrollEl.scrollTop = scrollEl.scrollHeight;
}

/**
 * Scroll to bottom on next animation frame.
 * @param {HTMLElement} scrollEl - The scrollable container element
 */
export function scrollToBottomSoon(scrollEl) {
    if (typeof requestAnimationFrame === 'function') {
        // Double-RAF ensures layout is complete before scrolling,
        // preventing incorrect scroll position on large DOM updates.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => scrollToBottom(scrollEl));
        });
    } else {
        setTimeout(() => scrollToBottom(scrollEl), 16);
    }
}

/**
 * Check if a scroll container is near the bottom.
 * @param {HTMLElement} scrollEl - The scrollable container element
 * @param {number} threshold - Distance from bottom in pixels to consider "near"
 * @returns {boolean}
 */
export function isNearBottom(scrollEl, threshold = 100) {
    if (!scrollEl) return true;
    const distance = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    return distance <= threshold;
}

/**
 * Capture current scroll anchor for later restoration.
 * @param {HTMLElement} scrollEl - The scrollable container element
 * @param {string} selector - CSS selector for anchor elements
 * @returns {Object|null} Anchor data for restoration
 */
export function captureScrollAnchor(scrollEl, selector = '.message-bubble') {
    if (!scrollEl) return null;
    const items = scrollEl.querySelectorAll(selector);
    if (!items.length) return null;
    const containerRect = scrollEl.getBoundingClientRect();
    for (const item of items) {
        const itemRect = item.getBoundingClientRect();
        if (itemRect.top >= containerRect.top && itemRect.bottom <= containerRect.bottom) {
            return {
                messageId: item.dataset.messageId || null,
                offsetTop: itemRect.top - containerRect.top
            };
        }
    }
    return null;
}

/**
 * Restore scroll position from a captured anchor.
 * @param {HTMLElement} scrollEl - The scrollable container element
 * @param {Object} anchor - Anchor data from captureScrollAnchor
 * @param {string} selector - CSS selector for anchor elements
 */
export function restoreScrollFromAnchor(scrollEl, anchor, selector = '.message-bubble') {
    if (!scrollEl || !anchor?.messageId) return;
    const item = scrollEl.querySelector(`${selector}[data-message-id="${anchor.messageId}"]`);
    if (!item) return;
    const containerRect = scrollEl.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    const currentOffset = itemRect.top - containerRect.top;
    const diff = currentOffset - (anchor.offsetTop || 0);
    scrollEl.scrollTop += diff;
}

/**
 * Update overflow style for messages scroll container.
 * @param {HTMLElement} scrollEl - The scrollable container element
 */
export function updateScrollOverflow(scrollEl) {
    if (!scrollEl) return;
    scrollEl.style.overflowY = 'auto';
}

/**
 * Create a keyboard offset manager for mobile viewport handling.
 * @param {Object} options
 * @param {HTMLElement} options.scrollEl - Scroll container
 * @param {HTMLElement} options.headerEl - Header element
 * @param {HTMLElement} options.composerEl - Composer element
 * @returns {Object} Manager with start/stop/update methods
 */
export function createKeyboardOffsetManager({ scrollEl, headerEl, composerEl } = {}) {
    let keyboardOffsetPx = 0;
    let keyboardActive = false;
    let initialized = false;

    function applyOffset() {
        const kbOffset = Math.max(0, Math.min(360, Math.floor(keyboardOffsetPx)));
        const wasActive = keyboardActive;
        keyboardActive = kbOffset > 120;
        document.documentElement.style.setProperty('--kb-offset', `${kbOffset}px`);
        try {
            document.body.classList.toggle('keyboard-open', keyboardActive);
        } catch { /* ignore */ }
        if (keyboardActive && !wasActive && scrollEl && isNearBottom(scrollEl, 150)) {
            scrollEl.scrollTop = scrollEl.scrollHeight;
        }
    }

    function applyInitialStyles() {
        if (headerEl) {
            headerEl.style.transform = 'translateY(0)';
            headerEl.style.top = '0';
        }
        if (composerEl) {
            composerEl.style.transform = 'translateY(0)';
            composerEl.style.bottom = 'env(safe-area-inset-bottom)';
        }
    }

    return {
        start() {
            if (initialized) return;
            initialized = true;
            applyInitialStyles();
            applyOffset();
        },
        stop() {
            // No-op: no timer to clean up (event-driven via visualViewport)
        },
        setOffset(px) {
            keyboardOffsetPx = px;
            applyOffset();
        },
        isActive() {
            return keyboardActive;
        }
    };
}

/**
 * Sync WebSocket indicator state from a source element.
 * @param {HTMLElement} targetEl - Target indicator element
 * @param {HTMLElement} sourceEl - Source indicator element
 */
export function syncWsIndicator(targetEl, sourceEl) {
    if (!targetEl || !sourceEl) return;
    targetEl.classList.remove('online', 'connecting', 'degraded');
    if (sourceEl.classList.contains('online')) {
        targetEl.classList.add('online');
    } else if (sourceEl.classList.contains('degraded')) {
        targetEl.classList.add('degraded');
    } else if (sourceEl.classList.contains('connecting')) {
        targetEl.classList.add('connecting');
    }
}

/**
 * Create a MutationObserver to mirror WebSocket indicator state.
 * @param {HTMLElement} targetEl - Target indicator element
 * @param {HTMLElement} sourceEl - Source indicator element
 * @returns {MutationObserver|null}
 */
export function createWsIndicatorMirror(targetEl, sourceEl) {
    if (!targetEl || !sourceEl || typeof MutationObserver === 'undefined') return null;
    syncWsIndicator(targetEl, sourceEl);
    const observer = new MutationObserver(() => syncWsIndicator(targetEl, sourceEl));
    observer.observe(sourceEl, { attributes: true, attributeFilter: ['class'] });
    return observer;
}
