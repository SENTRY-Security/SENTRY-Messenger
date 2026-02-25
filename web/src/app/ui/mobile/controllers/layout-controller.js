/**
 * LayoutController
 * Manages layout state, responsive modes, and keyboard offset handling.
 */

import { BaseController } from './base-controller.js';
import { createKeyboardOffsetManager, isNearBottom } from '../../../features/messages/ui/interactions.js';

const DESKTOP_BREAKPOINT = 768;

export class LayoutController extends BaseController {
    constructor(deps) {
        super(deps);
        this.lastLayoutIsDesktop = null;
        this.keyboardOffsetPx = 0;
        this._keyboardManager = null;
    }

    /**
     * Check if currently in desktop layout.
     * @returns {boolean}
     */
    isDesktopLayout() {
        if (typeof window === 'undefined') return false;
        return window.innerWidth >= DESKTOP_BREAKPOINT;
    }

    /**
     * Apply keyboard offset to scroll container and composer.
     */
    applyKeyboardOffset() {
        if (!this._keyboardManager) {
            this._keyboardManager = createKeyboardOffsetManager({
                scrollEl: this.elements.scrollEl,
                composerEl: this.elements.composer
            });
        }
        this._keyboardManager.setOffset(this.keyboardOffsetPx);
    }

    /**
     * Start viewport guard for iOS keyboard issues.
     */
    startViewportGuard() {
        if (!this._keyboardManager) {
            this._keyboardManager = createKeyboardOffsetManager({
                scrollEl: this.elements.scrollEl,
                composerEl: this.elements.composer
            });
        }
        this._keyboardManager.start();
    }

    /**
     * Apply messages layout based on current state and viewport.
     */
    applyMessagesLayout() {
        if (!this.elements.pane) return;
        const state = this.getMessageState();
        const desktop = this.isDesktopLayout();

        this.elements.pane.classList.toggle('is-desktop', desktop);
        if (desktop) {
            this.elements.pane.classList.remove('list-view');
            this.elements.pane.classList.remove('detail-view');
        } else {
            const mode = state.viewMode === 'detail' ? 'detail' : 'list';
            // Force exclusive classes
            if (mode === 'detail') {
                this.elements.pane.classList.add('detail-view');
                this.elements.pane.classList.remove('list-view');
            } else {
                this.elements.pane.classList.add('list-view');
                this.elements.pane.classList.remove('detail-view');
            }
        }

        try {
            const threadEl = document.querySelector('.messages-thread');
            if (threadEl) {
                const style = window.getComputedStyle(threadEl);
                // Fail-safe: Force display if in detail mode but hidden
                if (!desktop && state.viewMode === 'detail' && style.display === 'none') {
                    threadEl.style.display = 'flex';
                } else if (!desktop && state.viewMode === 'list') {
                    threadEl.style.display = '';
                }
            }
        } catch { /* ignore */ }

        if (this.elements.backBtn) {
            const showBack = !desktop && state.viewMode === 'detail';
            this.elements.backBtn.classList.toggle('hidden', !showBack);
        }

        if (typeof this.elements.composer === 'object' && this.elements.composer) {
            const isDetail = desktop || state.viewMode === 'detail';
            if (isDetail) {
                this.elements.composer.style.position = 'sticky';
                const kbOffset = Math.max(0, Math.floor(this.keyboardOffsetPx));
                this.elements.composer.style.bottom = kbOffset > 0 ? `${kbOffset}px` : '0';
                this.elements.composer.style.left = '0';
                this.elements.composer.style.right = '0';
                this.elements.composer.style.zIndex = '3';
            } else {
                this.elements.composer.style.position = '';
                this.elements.composer.style.bottom = '';
                this.elements.composer.style.left = '';
                this.elements.composer.style.right = '';
                this.elements.composer.style.zIndex = '';
            }
        }

        const currentTab = this.deps.getCurrentTab?.();

        if (currentTab === 'messages') {
            const detail = desktop || state.viewMode === 'detail';
            const topbarEl = document.querySelector('.topbar');
            const navbarEl = this.deps.navbarEl;

            if (topbarEl) {
                if (detail && !desktop) {
                    topbarEl.style.display = 'none';
                } else {
                    topbarEl.style.display = '';
                }
            }

            if (!desktop) {
                const topbar = topbarEl && topbarEl.style.display === 'none' ? null : topbarEl;
                const topOffset = topbar ? topbar.offsetHeight : 0;
                this.elements.pane.style.position = 'fixed';
                this.elements.pane.style.top = `${topOffset}px`;
                this.elements.pane.style.left = '0';
                this.elements.pane.style.right = '0';
                this.elements.pane.style.bottom = '0';
                this.elements.pane.style.height = 'auto';
            } else {
                this.elements.pane.style.position = '';
                this.elements.pane.style.top = '';
                this.elements.pane.style.left = '';
                this.elements.pane.style.right = '';
                this.elements.pane.style.bottom = '';
                this.elements.pane.style.height = '';
            }

            // navbarEl already defined above
            const mainContentEl = this.deps.mainContentEl;

            if (detail) {
                topbarEl?.classList.add('hidden');
                navbarEl?.classList.add('hidden');
                mainContentEl?.classList.add('fullscreen');
                document.body.classList.add('messages-fullscreen');
                document.body.style.overscrollBehavior = 'contain';
            } else {
                topbarEl?.classList.remove('hidden');
                navbarEl?.classList.remove('hidden');
                mainContentEl?.classList.remove('fullscreen');
                document.body.classList.remove('messages-fullscreen');
                document.body.style.overscrollBehavior = '';
            }
        }
    }

    /**
     * Update layout mode, handling transitions between mobile/desktop.
     * @param {Object} options
     * @param {boolean} options.force - Force layout recalculation
     */
    updateLayoutMode({ force = false } = {}) {
        const desktop = this.isDesktopLayout();
        if (!force && this.lastLayoutIsDesktop === desktop) {
            this.applyMessagesLayout();
            this.applyKeyboardOffset();
            return;
        }
        this.lastLayoutIsDesktop = desktop;
        const state = this.getMessageState();
        if (!state.viewMode) {
            state.viewMode = state.activePeerDigest ? 'detail' : 'list';
        }
        if (!desktop && !state.activePeerDigest && state.viewMode !== 'list') {
            state.viewMode = 'list';
        }
        this.applyMessagesLayout();
        this.applyKeyboardOffset();
    }

    /**
     * Initialize keyboard listeners for virtual keyboard handling.
     */
    initKeyboardListeners() {
        if (typeof window === 'undefined' || !window.visualViewport) return;

        const onViewportChange = () => {
            try {
                const vv = window.visualViewport;
                if (!vv) return;
                const heightDiff = window.innerHeight - vv.height;
                const offset = Math.max(0, heightDiff - (vv.offsetTop || 0));
                const wasKeyboardOpen = this.keyboardOffsetPx > 120;
                const isKeyboardOpen = offset > 120;
                this.keyboardOffsetPx = offset;
                this.applyKeyboardOffset();
                // Only scroll to bottom when keyboard transitions from closed→open
                // AND user is already near the bottom.  Previously this fired on
                // every viewport change (including keyboard close), causing the
                // scroll→blur→keyboard-close→scroll-to-bottom death loop.
                if (isKeyboardOpen && !wasKeyboardOpen && this.elements.scrollEl) {
                    if (isNearBottom(this.elements.scrollEl, 150)) {
                        this.elements.scrollEl.scrollTop = this.elements.scrollEl.scrollHeight;
                    }
                }
            } catch (err) {
                this.log({ keyboardOffsetError: err?.message || err });
            }
        };

        window.visualViewport.addEventListener('resize', onViewportChange);
        window.visualViewport.addEventListener('scroll', onViewportChange);
        window.addEventListener('orientationchange', onViewportChange);
        onViewportChange();
    }

    /**
     * Initialize the controller.
     */
    init() {
        super.init();
        this.initKeyboardListeners();
        this.startViewportGuard();
        this.updateLayoutMode({ force: true });
    }
}
