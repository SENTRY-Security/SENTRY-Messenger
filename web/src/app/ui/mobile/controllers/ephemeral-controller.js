/**
 * EphemeralController
 * Owner-side controller for ephemeral chat link feature.
 * - Create link modal
 * - Ephemeral conversation list items (timer, colors, dashed border, swipe-delete)
 * - In-conversation timer bar + extend button
 * - WS event handling for ephemeral messages
 */

import { BaseController } from './base-controller.js';
import { ephemeralCreateLink, ephemeralDelete, ephemeralList, ephemeralExtend } from '../../../api/ephemeral.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const EPHEMERAL_TTL_SEC = 600; // 10 minutes

export class EphemeralController extends BaseController {
  constructor(deps) {
    super(deps);
    /** @type {Map<string, {session_id, conversation_id, guest_digest, expires_at, extended_count, created_at}>} */
    this.ephemeralSessions = new Map();
    this._timerInterval = null;
  }

  init() {
    super.init();
    this._bindCreateButton();
    this._bindModalEvents();
    this._startTimerTick();
    this._listenWsEvents();
    // Load active sessions on init
    this._loadSessions();
  }

  destroy() {
    if (this._timerInterval) clearInterval(this._timerInterval);
    super.destroy();
  }

  // ── Load sessions from server ──
  async _loadSessions() {
    try {
      const data = await ephemeralList();
      const sessions = data?.sessions || [];
      this.ephemeralSessions.clear();
      for (const s of sessions) {
        this.ephemeralSessions.set(s.session_id, s);
      }
      this._requestListRender();
    } catch (err) {
      console.warn('[Ephemeral] loadSessions failed', err?.message);
    }
  }

  // ── Create Link Button ──
  _bindCreateButton() {
    const btn = document.getElementById('btnCreateEphemeralLink');
    if (!btn) return;
    btn.addEventListener('click', () => this._showCreateModal());
  }

  async _showCreateModal() {
    const modal = document.getElementById('ephemeralLinkModal');
    if (!modal) return;
    const loading = document.getElementById('ephLinkLoading');
    const result = document.getElementById('ephLinkResult');
    const error = document.getElementById('ephLinkError');
    const urlInput = document.getElementById('ephLinkUrl');
    const copied = document.getElementById('ephLinkCopied');

    // Reset state
    if (loading) loading.style.display = 'flex';
    if (result) result.style.display = 'none';
    if (error) error.style.display = 'none';
    if (copied) copied.style.display = 'none';

    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    try {
      const data = await ephemeralCreateLink({});
      const url = `${location.origin}/e/${data.token}`;
      if (loading) loading.style.display = 'none';
      if (urlInput) urlInput.value = url;
      if (result) result.style.display = 'block';
    } catch (err) {
      if (loading) loading.style.display = 'none';
      if (error) {
        error.textContent = err?.message || t('ephemeral.createLinkFailed');
        error.style.display = 'block';
      }
    }
  }

  _bindModalEvents() {
    const modal = document.getElementById('ephemeralLinkModal');
    if (!modal) return;

    // Close buttons
    modal.querySelectorAll('[data-eph-close]').forEach(el => {
      el.addEventListener('click', () => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        // Reload sessions after creating
        this._loadSessions();
      });
    });

    // Copy button
    const copyBtn = document.getElementById('ephLinkCopy');
    const urlInput = document.getElementById('ephLinkUrl');
    const copied = document.getElementById('ephLinkCopied');
    if (copyBtn && urlInput) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(urlInput.value);
          if (copied) {
            copied.style.display = 'block';
            setTimeout(() => { copied.style.display = 'none'; }, 2000);
          }
        } catch {
          urlInput.select();
          document.execCommand('copy');
          if (copied) {
            copied.style.display = 'block';
            setTimeout(() => { copied.style.display = 'none'; }, 2000);
          }
        }
      });
    }
  }

  // ── Timer Tick (every second) ──
  _startTimerTick() {
    this._timerInterval = setInterval(() => {
      this._updateAllTimers();
    }, 1000);
  }

  _updateAllTimers() {
    const now = Math.floor(Date.now() / 1000);
    let needsRender = false;

    for (const [id, session] of this.ephemeralSessions) {
      const remaining = session.expires_at - now;
      if (remaining <= 0) {
        this.ephemeralSessions.delete(id);
        needsRender = true;
        continue;
      }
      // Update DOM timer directly for performance
      const timerEl = document.querySelector(`[data-eph-session="${id}"] .eph-timer-badge`);
      if (timerEl) {
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        timerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        const colorClass = remaining > 300 ? 'green' : remaining > 120 ? 'yellow' : 'red';
        timerEl.className = 'eph-timer-badge ' + colorClass;
      }

      // Update in-conversation timer if this is the active conversation
      this._updateConvTimer(session, remaining);
    }

    if (needsRender) this._requestListRender();
  }

  _updateConvTimer(session, remaining) {
    const convTimerEl = document.getElementById('ephConvTimerClock');
    const extendBtnEl = document.getElementById('ephConvExtendBtn');
    if (!convTimerEl) return;
    if (convTimerEl.dataset.sessionId !== session.session_id) return;

    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    convTimerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    const cls = remaining > 300 ? '' : remaining > 120 ? 'yellow' : 'red';
    convTimerEl.className = 'eph-conv-timer-clock' + (cls ? ' ' + cls : '');
    if (extendBtnEl) {
      if (remaining <= 300) extendBtnEl.classList.add('visible');
      else extendBtnEl.classList.remove('visible');
    }
  }

  // ── Render ephemeral items in conversation list ──
  /**
   * Called by ConversationListController.renderConversationList().
   * Inserts ephemeral items at the TOP of the conversation list (pinned).
   * @param {HTMLElement} listEl - The <ul> conversation list element
   */
  renderEphemeralItems(listEl) {
    if (!listEl || !this.ephemeralSessions.size) return;

    const now = Math.floor(Date.now() / 1000);
    const sorted = Array.from(this.ephemeralSessions.values())
      .filter(s => s.expires_at > now)
      .sort((a, b) => b.created_at - a.created_at);

    for (const session of sorted) {
      const remaining = session.expires_at - now;
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      const timerText = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      const colorClass = remaining > 300 ? 'green' : remaining > 120 ? 'yellow' : 'red';

      const li = document.createElement('li');
      li.className = 'conversation-item ephemeral';
      li.dataset.ephSession = session.session_id;
      li.dataset.conversationId = session.conversation_id;
      li.style.touchAction = 'pan-y';

      const guestId = (session.guest_digest || '').slice(-4);
      li.innerHTML = `
        <div class="item-content conversation-item-content">
          <div class="conversation-avatar">⏳</div>
          <div class="conversation-content">
            <div class="conversation-row conversation-row-top">
              <span class="conversation-name">${escapeHtml(t('ephemeral.tempChat'))}</span>
              <span class="eph-timer-badge ${colorClass}">${escapeHtml(timerText)}</span>
            </div>
            <div class="conversation-row conversation-row-bottom">
              <span class="conversation-snippet">${escapeHtml(t('ephemeral.guestLabel', { id: guestId }))}</span>
            </div>
          </div>
        </div>
        <button type="button" class="item-delete" aria-label="${escapeHtml(t('ephemeral.deleteTempChat'))}"><i class='bx bx-trash'></i></button>
      `;

      // Click → open ephemeral conversation
      li.querySelector('.item-content')?.addEventListener('click', () => {
        this._openEphemeralConversation(session);
      });

      // Delete button
      li.querySelector('.item-delete')?.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this._deleteSession(session.session_id);
      });

      // Setup swipe
      this.deps.setupSwipe?.(li);

      // Insert at top (before first child)
      if (listEl.firstChild) {
        listEl.insertBefore(li, listEl.firstChild);
      } else {
        listEl.appendChild(li);
      }
    }
  }

  // ── Open ephemeral conversation ──
  _openEphemeralConversation(session) {
    // Use the existing setActiveConversation mechanism
    // The guest_digest serves as the "peer" for the owner
    const peerKey = session.guest_digest;
    this.deps.setActiveConversation?.(peerKey, session.conversation_id, null);
    // Show timer bar in messages thread
    this._showConvTimerBar(session);
  }

  _showConvTimerBar(session) {
    // Inject timer bar into messages header area
    let timerBar = document.getElementById('ephConvTimerBar');
    if (!timerBar) {
      timerBar = document.createElement('div');
      timerBar.id = 'ephConvTimerBar';
      timerBar.className = 'eph-conv-timer-bar';
      timerBar.innerHTML = `
        <span id="ephConvTimerClock" class="eph-conv-timer-clock" data-session-id="">--:--</span>
        <button id="ephConvExtendBtn" class="eph-conv-extend-btn">${escapeHtml(t('ephemeral.extendTime'))}</button>
      `;
      // Insert after messages-header
      const header = document.querySelector('.messages-header');
      if (header && header.parentNode) {
        header.parentNode.insertBefore(timerBar, header.nextSibling);
      }

      // Bind extend button
      document.getElementById('ephConvExtendBtn')?.addEventListener('click', async () => {
        const sid = document.getElementById('ephConvTimerClock')?.dataset?.sessionId;
        if (!sid) return;
        try {
          const data = await ephemeralExtend({ sessionId: sid });
          const s = this.ephemeralSessions.get(sid);
          if (s) s.expires_at = data.expires_at;
        } catch (err) {
          console.warn('[Ephemeral] extend failed', err?.message);
        }
      });
    }

    const clockEl = document.getElementById('ephConvTimerClock');
    if (clockEl) clockEl.dataset.sessionId = session.session_id;
    timerBar.style.display = 'flex';
  }

  hideConvTimerBar() {
    const timerBar = document.getElementById('ephConvTimerBar');
    if (timerBar) timerBar.style.display = 'none';
  }

  /**
   * Check if a conversation ID belongs to an ephemeral session.
   */
  isEphemeralConversation(conversationId) {
    if (!conversationId) return false;
    for (const session of this.ephemeralSessions.values()) {
      if (session.conversation_id === conversationId) return true;
    }
    return false;
  }

  getSessionByConversationId(conversationId) {
    for (const session of this.ephemeralSessions.values()) {
      if (session.conversation_id === conversationId) return session;
    }
    return null;
  }

  // ── Delete ──
  async _deleteSession(sessionId) {
    try {
      await ephemeralDelete({ sessionId });
      this.ephemeralSessions.delete(sessionId);
      this._requestListRender();
      this.hideConvTimerBar();
    } catch (err) {
      console.warn('[Ephemeral] delete failed', err?.message);
    }
  }

  // ── WS Events ──
  _listenWsEvents() {
    // This is called by the WS integration layer
  }

  handleWsMessage(msg) {
    if (!msg?.type) return false;
    switch (msg.type) {
      case 'ephemeral-extended': {
        const session = this.ephemeralSessions.get(msg.sessionId);
        if (session) {
          session.expires_at = msg.expiresAt;
          this._requestListRender();
        }
        return true;
      }
      case 'ephemeral-deleted': {
        this.ephemeralSessions.delete(msg.sessionId);
        this._requestListRender();
        this.hideConvTimerBar();
        return true;
      }
      case 'ephemeral-message': {
        // Forward to the message rendering pipeline
        return false; // Let normal message handler process it
      }
      default:
        return false;
    }
  }

  // ── Helpers ──
  _requestListRender() {
    this.deps.renderConversationList?.();
  }
}
