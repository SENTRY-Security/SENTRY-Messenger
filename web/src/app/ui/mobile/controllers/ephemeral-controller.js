/**
 * EphemeralController
 * Owner-side controller for ephemeral chat link feature.
 * - Create link modal
 * - Ephemeral conversation list items (timer, colors, dashed border, swipe-delete)
 * - In-conversation timer bar + extend button
 * - WS event handling for ephemeral messages
 * - E2EE: X3DH key exchange + Double Ratchet encrypt/decrypt
 */

import { BaseController } from './base-controller.js';
import { ephemeralCreateLink, ephemeralDelete, ephemeralList, ephemeralExtend, ephemeralRevokeInvite } from '../../../api/ephemeral.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';
import { generateInitialBundle } from '../../../../shared/crypto/prekeys.js';
import { x3dhRespond, drEncryptText, drDecryptText } from '../../../../shared/crypto/dr.js';
import { loadNacl } from '../../../../shared/crypto/nacl.js';
import { saveSettings, DEFAULT_SETTINGS } from '../../../features/settings.js';

const EPHEMERAL_TTL_SEC = 600; // 10 minutes

export class EphemeralController extends BaseController {
  constructor(deps) {
    super(deps);
    /** @type {Map<string, {session_id, conversation_id, guest_digest, expires_at, extended_count, created_at}>} */
    this.ephemeralSessions = new Map();
    this._timerInterval = null;

    // ── E2EE state (memory-only, destroyed with session) ──
    /** @type {Map<string, object>} token → devicePriv (owner's ephemeral keypair, awaiting guest key-exchange) */
    this._pendingInviteKeys = new Map();
    /** @type {Map<string, object>} session_id → DR state (active Double Ratchet sessions) */
    this._drStates = new Map();
    /** @type {Map<string, string>} session_id → token (maps sessions back to invite tokens for key lookup) */
    this._sessionTokenMap = new Map();
    /** @type {Array<{token, expires_at, created_at}>} pending (unconsumed) invites from server */
    this._pendingInvites = [];
    /** @type {boolean} prevents concurrent _generateLink calls */
    this._generating = false;
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
    // Clear all crypto state
    this._drStates.clear();
    this._pendingInviteKeys.clear();
    this._sessionTokenMap.clear();
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
        // Populate sessionTokenMap from server data (covers missed WS notifications)
        if (s.invite_token && !this._sessionTokenMap.has(s.session_id)) {
          this._sessionTokenMap.set(s.session_id, s.invite_token);
        }
      }
      this._pendingInvites = data?.pending_invites || [];
      this._requestListRender();
    } catch (err) {
      console.warn('[Ephemeral] loadSessions failed', err?.message);
    }
  }

  // ── Auto-Logout Warning ──
  _isAutoLogoutEnabled() {
    const ss = this.deps.sessionStore?.settingsState;
    return !!(ss?.autoLogoutOnBackground ?? DEFAULT_SETTINGS.autoLogoutOnBackground);
  }

  /**
   * Show a warning modal if autoLogoutOnBackground is enabled.
   * Returns a Promise that resolves to true if user wants to continue,
   * or false if they cancelled.
   */
  _showAutoLogoutWarning() {
    return new Promise((resolve) => {
      const modal = document.getElementById('ephAutoLogoutWarnModal');
      if (!modal) { resolve(true); return; }

      const toggle = document.getElementById('ephAutoLogoutToggle');
      const continueBtn = document.getElementById('ephAutoLogoutWarnContinue');
      const closeBtns = modal.querySelectorAll('[data-eph-warn-close]');

      // Sync toggle with current setting
      if (toggle) toggle.checked = this._isAutoLogoutEnabled();

      // Show modal
      modal.style.display = 'flex';
      modal.setAttribute('aria-hidden', 'false');

      const cleanup = () => {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        if (toggle) toggle.removeEventListener('change', onToggle);
        if (continueBtn) continueBtn.removeEventListener('click', onContinue);
        closeBtns.forEach(el => el.removeEventListener('click', onCancel));
      };

      const onToggle = async () => {
        const newValue = toggle.checked;
        // Update in-memory settings immediately
        const ss = this.deps.sessionStore;
        if (ss?.settingsState) {
          ss.settingsState = { ...ss.settingsState, autoLogoutOnBackground: newValue };
        }
        // Persist to server
        try {
          await saveSettings(ss.settingsState);
        } catch (err) {
          console.warn('[Ephemeral] save settings failed', err?.message);
        }
      };

      const onContinue = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };

      if (toggle) toggle.addEventListener('change', onToggle);
      if (continueBtn) continueBtn.addEventListener('click', onContinue);
      closeBtns.forEach(el => el.addEventListener('click', onCancel));
    });
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
    const sessionList = document.getElementById('ephLinkSessionList');
    const urlInput = document.getElementById('ephLinkUrl');
    const copied = document.getElementById('ephLinkCopied');

    // Reset link-generation area
    if (loading) loading.style.display = 'flex';
    if (result) result.style.display = 'none';
    if (error) error.style.display = 'none';
    if (copied) copied.style.display = 'none';

    // Always load sessions first so the list is up to date
    await this._loadSessions();

    // Render session list (always visible if there are sessions/invites)
    this._renderSessionListInModal(sessionList);

    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');

    await this._generateLink(loading, result, error, urlInput, sessionList);
  }

  /**
   * Attempt to generate a link. On max-sessions error, show the error hint
   * and keep the session list visible so the user can free a slot.
   */
  async _generateLink(loading, result, error, urlInput, sessionList) {
    // Prevent concurrent generation (e.g. rapid revoke clicks)
    if (this._generating) return;
    this._generating = true;

    if (loading) loading.style.display = 'flex';
    if (result) result.style.display = 'none';
    if (error) error.style.display = 'none';

    try {
      await loadNacl();
      const { devicePriv, bundlePub } = await generateInitialBundle(1, 1);

      const data = await ephemeralCreateLink({ prekeyBundle: bundlePub });
      const url = `${location.origin}/e/${data.token}`;

      this._pendingInviteKeys.set(data.token, devicePriv);

      if (loading) loading.style.display = 'none';
      if (urlInput) urlInput.value = url;
      if (result) result.style.display = 'block';

      // Re-load sessions to show the new pending invite in the list
      await this._loadSessions();
      this._renderSessionListInModal(sessionList);
    } catch (err) {
      if (loading) loading.style.display = 'none';
      const msg = err?.message || '';
      const isMaxSessions = /max\s+\d+\s+active/i.test(msg);
      if (isMaxSessions) {
        if (error) {
          error.innerHTML = `<strong>${escapeHtml(t('ephemeral.maxSessionsReached'))}</strong><br/><span style="font-size:12px">${escapeHtml(t('ephemeral.maxSessionsDesc'))}</span>`;
          error.style.display = 'block';
        }
      } else if (error) {
        error.textContent = msg || t('ephemeral.createLinkFailed');
        error.style.display = 'block';
      }
    } finally {
      this._generating = false;
    }
  }

  /**
   * Render the active ephemeral session list inside the create-link modal.
   * Always shown so user can manage existing sessions alongside link generation.
   */
  _renderSessionListInModal(sessionListEl) {
    if (!sessionListEl) return;

    const now = Math.floor(Date.now() / 1000);
    sessionListEl.innerHTML = '';

    // Merge active sessions + pending invites, sorted by created_at desc
    const sessions = Array.from(this.ephemeralSessions.values())
      .filter(s => s.expires_at > now)
      .map(s => ({ ...s, _type: 'session' }));
    const pendingInvites = (this._pendingInvites || [])
      .filter(inv => inv.expires_at > now)
      .map(inv => ({ ...inv, _type: 'invite' }));
    const all = [...sessions, ...pendingInvites].sort((a, b) => a.created_at - b.created_at);

    all.forEach((item, idx) => {
      const seq = idx + 1;
      const createdTime = this._fmtTime(item.created_at);
      const row = document.createElement('div');

      if (item._type === 'session') {
        const remaining = item.expires_at - now;
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        const timerText = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
        const colorClass = remaining > 300 ? 'green' : remaining > 120 ? 'yellow' : 'red';

        row.className = 'eph-session-row';
        row.dataset.sessionId = item.session_id;
        row.innerHTML = `
          <div class="eph-session-info">
            <span class="eph-session-name">#${seq} · ${escapeHtml(t('ephemeral.tempChat'))}</span>
            <span class="eph-session-meta">${escapeHtml(createdTime)}</span>
            <span class="eph-timer-badge ${colorClass}">${escapeHtml(timerText)}</span>
          </div>
          <button type="button" class="eph-session-terminate">${escapeHtml(t('ephemeral.terminateSession'))}</button>
        `;
        row.querySelector('.eph-session-terminate')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = '…';
          try {
            await this._deleteSession(item.session_id);
            row.remove();
            this._onSlotFreed(sessionListEl);
          } catch {
            btn.disabled = false;
            btn.textContent = t('ephemeral.terminateSession');
          }
        });
      } else {
        row.className = 'eph-session-row eph-session-pending';
        row.dataset.token = item.token;
        row.innerHTML = `
          <div class="eph-session-info">
            <span class="eph-session-name">#${seq} · ${escapeHtml(t('ephemeral.pendingLink'))}</span>
            <span class="eph-session-meta">${escapeHtml(createdTime)}</span>
            <span class="eph-timer-badge pending">${escapeHtml(t('ephemeral.pendingBadge'))}</span>
          </div>
          <button type="button" class="eph-session-terminate">${escapeHtml(t('ephemeral.revokeLink'))}</button>
        `;
        row.querySelector('.eph-session-terminate')?.addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = '…';
          try {
            await ephemeralRevokeInvite({ token: item.token });
            this._pendingInviteKeys.delete(item.token);
            row.remove();
            this._onSlotFreed(sessionListEl);
          } catch {
            btn.disabled = false;
            btn.textContent = t('ephemeral.revokeLink');
          }
        });
      }

      sessionListEl.appendChild(row);
    });

    sessionListEl.style.display = all.length ? 'block' : 'none';
  }

  /** Format unix timestamp to HH:MM local time */
  _fmtTime(ts) {
    const d = new Date(ts * 1000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * Called after a session/invite is removed. Immediately generates a new link.
   */
  async _onSlotFreed(sessionListEl) {
    const loading = document.getElementById('ephLinkLoading');
    const result = document.getElementById('ephLinkResult');
    const error = document.getElementById('ephLinkError');
    const urlInput = document.getElementById('ephLinkUrl');
    const copied = document.getElementById('ephLinkCopied');
    if (copied) copied.style.display = 'none';
    await this._generateLink(loading, result, error, urlInput, sessionListEl);
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
        // Warn if auto-logout is on (user will paste in another app)
        if (this._isAutoLogoutEnabled()) {
          const proceed = await this._showAutoLogoutWarning();
          if (!proceed) return;
        }
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

    // Share button (Web Share API → clipboard fallback)
    const shareBtn = document.getElementById('ephLinkShare');
    if (shareBtn && urlInput) {
      shareBtn.addEventListener('click', async () => {
        // Warn if auto-logout is on (share will switch app)
        if (this._isAutoLogoutEnabled()) {
          const proceed = await this._showAutoLogoutWarning();
          if (!proceed) return;
        }
        const url = urlInput.value;
        const shareText = t('ephemeral.shareText', { url });
        if (navigator.share) {
          try {
            await navigator.share({ title: 'SENTRY Messenger', text: shareText });
          } catch { /* user cancelled */ }
        } else {
          // Fallback: copy full share text to clipboard
          try { await navigator.clipboard.writeText(shareText); } catch { /* ignore */ }
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
        // Clean up crypto state for expired session
        this._drStates.delete(id);
        this._sessionTokenMap.delete(id);
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

  /**
   * Check if a DR session is established for the given session ID.
   */
  hasEncryptionReady(sessionId) {
    return this._drStates.has(sessionId);
  }

  // ── E2EE: Send encrypted message ──
  /**
   * Encrypt and send a message for an ephemeral session.
   * @param {string} sessionId
   * @param {string} text - plaintext message
   */
  async sendEncryptedMessage(sessionId, text) {
    const drSt = this._drStates.get(sessionId);
    if (!drSt) throw new Error('no DR state for session');
    const session = this.ephemeralSessions.get(sessionId);
    if (!session) throw new Error('session not found');

    const senderDeviceId = this.deps.ensureDeviceId?.() || '';
    const packet = await drEncryptText(drSt, text, {
      deviceId: senderDeviceId,
      version: 1
    });

    this.deps.wsSend?.({
      type: 'ephemeral-message',
      conversationId: session.conversation_id,
      header: packet.header,
      iv_b64: packet.iv_b64,
      ciphertext_b64: packet.ciphertext_b64,
      ts: Date.now()
    });
  }

  // ── E2EE: Decrypt incoming message ──
  /**
   * Decrypt an incoming ephemeral message.
   * @returns {{ text: string, ts: number } | null}
   */
  async decryptIncomingMessage(msg) {
    if (!msg?.conversationId) return null;
    const session = this.getSessionByConversationId(msg.conversationId);
    if (!session) return null;
    const drSt = this._drStates.get(session.session_id);
    if (!drSt) return null;

    const plaintext = await drDecryptText(drSt, {
      header: msg.header,
      iv_b64: msg.iv_b64,
      ciphertext_b64: msg.ciphertext_b64
    });
    return { text: plaintext, ts: msg.ts };
  }

  // ── Delete ──
  async _deleteSession(sessionId) {
    try {
      await ephemeralDelete({ sessionId });
      this.ephemeralSessions.delete(sessionId);
      // Clean up crypto state
      this._drStates.delete(sessionId);
      const token = this._sessionTokenMap.get(sessionId);
      if (token) this._pendingInviteKeys.delete(token);
      this._sessionTokenMap.delete(sessionId);
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

  /**
   * Find the owner's private key for a session by looking up the invite token.
   * The session_started event includes the invite_token, which we map at that point.
   */
  _findPrivKeyForSession(sessionId) {
    const token = this._sessionTokenMap.get(sessionId);
    if (!token) return null;
    return this._pendingInviteKeys.get(token) || null;
  }

  handleWsMessage(msg) {
    if (!msg?.type) return false;
    switch (msg.type) {
      case 'ephemeral_session_started': {
        // Guest consumed the link — add session to owner's list
        const sessionData = {
          session_id: msg.sessionId,
          conversation_id: msg.conversationId,
          guest_digest: msg.guestDigest,
          guest_device_id: msg.guestDeviceId,
          expires_at: msg.expiresAt,
          extended_count: 0,
          created_at: Math.floor(Date.now() / 1000)
        };
        this.ephemeralSessions.set(msg.sessionId, sessionData);

        // Map session_id → invite_token for key lookup
        if (msg.inviteToken) {
          this._sessionTokenMap.set(msg.sessionId, msg.inviteToken);
        }

        this._requestListRender();
        return true;
      }
      case 'ephemeral-key-exchange': {
        // Guest sent their public key bundle — complete X3DH as responder
        this._handleKeyExchange(msg).catch(err => {
          console.warn('[Ephemeral] key-exchange failed', err?.message);
        });
        return true;
      }
      case 'ephemeral-key-exchange-ack': {
        // Acknowledgement (owner side doesn't need to act on this)
        return true;
      }
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
        this._drStates.delete(msg.sessionId);
        this._sessionTokenMap.delete(msg.sessionId);
        this._requestListRender();
        this.hideConvTimerBar();
        return true;
      }
      case 'ephemeral-message': {
        // Encrypted message — decrypt and forward to rendering pipeline
        // Decryption is handled by the WS integration layer calling decryptIncomingMessage()
        return false; // Let WS integration handle it
      }
      default:
        return false;
    }
  }

  // ── E2EE: Handle key exchange from guest ──
  async _handleKeyExchange(msg) {
    const sessionId = msg.sessionId;
    let session = this.ephemeralSessions.get(sessionId);

    // Session or key mapping may be missing if the ephemeral_session_started
    // WS notification was lost (e.g. owner's WS was disconnected when the
    // guest consumed the link). Fetch from server to recover.
    if (!session || !this._sessionTokenMap.has(sessionId)) {
      await this._loadSessions();
      session = this.ephemeralSessions.get(sessionId);
    }

    if (!session) {
      console.warn('[Ephemeral] key-exchange: session not found', sessionId);
      return;
    }

    const ownerPriv = this._findPrivKeyForSession(sessionId);
    if (!ownerPriv) {
      console.warn('[Ephemeral] key-exchange: no private key for session', sessionId);
      return;
    }

    await loadNacl();

    // X3DH: Owner as responder
    const drSt = await x3dhRespond(ownerPriv, msg.guestBundle);
    this._drStates.set(sessionId, drSt);

    // Clean up pending invite key (no longer needed)
    const token = this._sessionTokenMap.get(sessionId);
    if (token) this._pendingInviteKeys.delete(token);

    // Send ack to guest so they know encryption is ready
    this.deps.wsSend?.({
      type: 'ephemeral-key-exchange-ack',
      sessionId,
      targetAccountDigest: session.guest_digest
    });

    console.log('[Ephemeral] E2EE session established for', sessionId);
  }

  // ── Helpers ──
  _requestListRender() {
    this.deps.renderConversationList?.();
  }
}
