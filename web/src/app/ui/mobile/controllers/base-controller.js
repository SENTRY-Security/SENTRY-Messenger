/**
 * Base Controller Class
 * Provides common infrastructure for all messages-pane controllers.
 * 
 * All controllers receive a shared `deps` object containing:
 * - elements: DOM element references
 * - sessionStore: Session storage reference
 * - getMessageState: Function to get current message state
 * - updateMessagesUI: Function to trigger UI update
 * - log/logCapped: Logging utilities
 * - Various other shared utilities
 */

/**
 * @typedef {Object} ControllerDeps
 * @property {Object} elements - DOM element references
 * @property {Object} sessionStore - Session store reference
 * @property {Function} getMessageState - Get current message state
 * @property {Function} updateMessagesUI - Trigger UI update
 * @property {Function} updateMessagesStatusUI - Trigger status UI update
 * @property {Function} log - Logging function
 * @property {Function} logCapped - Rate-limited logging
 * @property {Function} showToast - Toast notification
 * @property {Function} showConfirmModal - Confirmation modal
 * @property {Function} getCurrentTab - Get current active tab
 * @property {Function} switchTab - Switch to a tab
 */

export class BaseController {
    /**
     * @param {ControllerDeps} deps - Shared dependencies
     */
    constructor(deps) {
        this.deps = deps;
        this._initialized = false;
    }

    /**
     * Get DOM elements from deps.
     * @returns {Object}
     */
    get elements() {
        return this.deps.elements || {};
    }

    /**
     * Get session store from deps.
     * @returns {Object}
     */
    get sessionStore() {
        return this.deps.sessionStore;
    }

    /**
     * Get current message state.
     * @returns {Object}
     */
    getMessageState() {
        return this.deps.getMessageState?.() || {};
    }

    /**
     * Log a message.
     * @param {*} data - Data to log
     */
    log(data) {
        this.deps.log?.(data);
    }

    /**
     * Rate-limited log.
     * @param {string} key - Log key
     * @param {*} data - Data to log
     * @param {number} limit - Rate limit
     */
    logCapped(key, data, limit = 5) {
        this.deps.logCapped?.(key, data, limit);
    }

    /**
     * Show toast notification.
     * @param {string} message - Toast message
     */
    showToast(message) {
        this.deps.showToast?.(message);
    }

    /**
     * Trigger UI update.
     * @param {Object} args
     */
    updateMessagesUI(args) {
        this.deps.updateMessagesUI?.(args);
    }

    /**
     * Trigger status UI update.
     */
    updateMessagesStatusUI() {
        this.deps.updateMessagesStatusUI?.();
    }

    /**
     * Initialize the controller. Override in subclasses.
     */
    init() {
        if (this._initialized) return;
        this._initialized = true;
    }

    /**
     * Cleanup the controller. Override in subclasses.
     */
    destroy() {
        this._initialized = false;
    }
}

/**
 * Create a controller deps object from initMessagesPane context.
 * This factory function should be called within initMessagesPane to create
 * the shared dependencies object for all controllers.
 * 
 * @param {Object} context - Context object with all required references
 * @returns {ControllerDeps}
 */
export function createControllerDeps(context) {
    return {
        elements: context.elements,
        sessionStore: context.sessionStore,
        getMessageState: context.getMessageState,
        updateMessagesUI: context.updateMessagesUI,
        updateMessagesStatusUI: context.updateMessagesStatusUI,
        log: context.log,
        logCapped: context.logCapped,
        showToast: context.showToast,
        showConfirmModal: context.showConfirmModal,
        getCurrentTab: context.getCurrentTab,
        switchTab: context.switchTab,
        navbarEl: context.navbarEl,
        mainContentEl: context.mainContentEl,
        // Add more shared utilities as needed
        // ...context.extra // Removed spread, explicitly listing below
        ensureConversationIndex: context.ensureConversationIndex,
        getConversationThreads: context.getConversationThreads,
        upsertConversationThread: context.upsertConversationThread,
        threadPeer: context.threadPeer,
        normalizePeerKey: context.normalizePeerKey,
        // MessageFlow facade deps
        loadActiveConversationMessages: context.loadActiveConversationMessages,
        handleTimelineAppend: context.handleTimelineAppend,
        handleIncomingSecureMessage: context.handleIncomingSecureMessage,
        handleVaultAckEvent: context.handleVaultAckEvent,
        handleMessageDecrypted: context.handleMessageDecrypted,
        // ActiveConversation facade deps
        syncConversationThreadsFromContacts: context.syncConversationThreadsFromContacts,
        refreshContactsUnreadBadges: context.refreshContactsUnreadBadges,
        renderConversationList: context.renderConversationList,
        updateComposerAvailability: context.updateComposerAvailability,
        applyMessagesLayout: context.applyMessagesLayout,
        setActiveConversation: context.setActiveConversation,
        handleConversationDelete: context.handleConversationDelete,
        getCurrentTab: context.getCurrentTab,
        setActiveConversation: context.setActiveConversation,
        handleConversationDelete: context.handleConversationDelete,
        getCurrentTab: context.getCurrentTab,
        switchTab: context.switchTab,
        updateThreadAvatar: context.updateThreadAvatar,
        isLatestOutgoingForStatus: context.isLatestOutgoingForStatus,
        resolveRenderEntryCounter: context.resolveRenderEntryCounter,
        // Composer deps
        resolveSecureStatusForUi: context.resolveSecureStatusForUi,
        getCachedSecureStatus: context.getCachedSecureStatus,
        isSubscriptionActive: context.isSubscriptionActive,
        requireSubscriptionActive: context.requireSubscriptionActive,
        appendLocalOutgoingMessage: context.appendLocalOutgoingMessage,
        // Swipe dependencies
        setupSwipe: context.setupSwipe,
        closeSwipe: context.closeSwipe,
        closeOpenSwipe: context.closeOpenSwipe
    };
}
