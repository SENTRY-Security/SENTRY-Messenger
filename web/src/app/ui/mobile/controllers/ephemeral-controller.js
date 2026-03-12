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
import { ephemeralCreateLink, ephemeralDelete, ephemeralList, ephemeralExtend, ephemeralRevokeInvite, ephemeralClearPendingKeyExchange } from '../../../api/ephemeral.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';
import { generateInitialBundle } from '../../../../shared/crypto/prekeys.js';
import { x3dhRespond, drEncryptText, drDecryptText } from '../../../../shared/crypto/dr.js';
import { loadNacl } from '../../../../shared/crypto/nacl.js';
import { saveSettings, DEFAULT_SETTINGS } from '../../../features/settings.js';
import { appendUserMessage } from '../../../features/timeline-store.js';

const EPHEMERAL_TTL_SEC = 600; // 10 minutes
const STORAGE_KEY_INVITE_KEYS = '__eph_pending_invite_keys';
const STORAGE_KEY_SESSION_TOKEN_MAP = '__eph_session_token_map';
const STUN_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];

// ── sessionStorage helpers for E2EE key persistence ──
// Private keys MUST survive page reloads / iOS background purges.
// Without persistence, switching apps to share the link causes key loss
// and the key exchange can NEVER complete (the root cause of always-fail).
function _persistMap(storageKey, map) {
  try {
    const obj = {};
    for (const [k, v] of map) obj[k] = v;
    sessionStorage.setItem(storageKey, JSON.stringify(obj));
  } catch { /* quota exceeded or private browsing */ }
}

function _restoreMap(storageKey) {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch { return new Map(); }
}

export class EphemeralController extends BaseController {
  constructor(deps) {
    super(deps);
    /** @type {Map<string, {session_id, conversation_id, guest_digest, expires_at, extended_count, created_at}>} */
    this.ephemeralSessions = new Map();
    this._timerInterval = null;

    // ── E2EE state ──
    // Restored from sessionStorage so keys survive page reloads / iOS background purges.
    /** @type {Map<string, object>} token → devicePriv (owner's ephemeral keypair, awaiting guest key-exchange) */
    this._pendingInviteKeys = _restoreMap(STORAGE_KEY_INVITE_KEYS);
    /** @type {Map<string, object>} session_id → DR state (active Double Ratchet sessions) */
    this._drStates = new Map();
    /** @type {Map<string, string>} session_id → token (maps sessions back to invite tokens for key lookup) */
    this._sessionTokenMap = _restoreMap(STORAGE_KEY_SESSION_TOKEN_MAP);
    /** @type {Array<{token, expires_at, created_at}>} pending (unconsumed) invites from server */
    this._pendingInvites = [];
    /** @type {boolean} prevents concurrent _generateLink calls */
    this._generating = false;
    /** @type {object|null} ephemeral call state: { callId, sessionId, mode, pc, localStream, muted, camOff, timerStart, timerInterval, direction } */
    this._callState = null;
  }

  init() {
    super.init();
    this._bindCreateButton();
    this._bindModalEvents();
    this._startTimerTick();
    this._listenWsEvents();
    // Load active sessions on init
    this._loadSessions();
    // Periodic poll for pending key exchanges (every 5s while sessions exist)
    this._kexPollInterval = setInterval(() => this._pollPendingKeyExchanges(), 5000);
  }

  destroy() {
    if (this._kexPollInterval) clearInterval(this._kexPollInterval);
    if (this._timerInterval) clearInterval(this._timerInterval);
    // Clear all crypto state (memory + storage)
    this._drStates.clear();
    this._pendingInviteKeys.clear();
    this._sessionTokenMap.clear();
    try { sessionStorage.removeItem(STORAGE_KEY_INVITE_KEYS); } catch {}
    try { sessionStorage.removeItem(STORAGE_KEY_SESSION_TOKEN_MAP); } catch {}
    super.destroy();
  }

  // ── Load sessions from server ──
  async _loadSessions() {
    let data;
    try {
      data = await ephemeralList();
    } catch (err) {
      console.warn('[Ephemeral] loadSessions failed', err?.message);
      return; // Keep existing in-memory sessions intact on failure
    }

    const sessions = data?.sessions || [];
    // Preserve client-only fields (e.g. guest_nickname) across server reloads
    const preserved = new Map();
    for (const [id, s] of this.ephemeralSessions) {
      if (s.guest_nickname) preserved.set(id, { guest_nickname: s.guest_nickname });
    }
    // Only clear AFTER successful fetch — never lose WS-sourced sessions on API failure
    this.ephemeralSessions.clear();
    for (const s of sessions) {
      const prev = preserved.get(s.session_id);
      if (prev?.guest_nickname) s.guest_nickname = prev.guest_nickname;
      this.ephemeralSessions.set(s.session_id, s);
      // Populate sessionTokenMap from server data (covers missed WS notifications)
      if (s.invite_token && !this._sessionTokenMap.has(s.session_id)) {
        this._sessionTokenMap.set(s.session_id, s.invite_token);
      }
    }
    _persistMap(STORAGE_KEY_SESSION_TOKEN_MAP, this._sessionTokenMap);
    this._pendingInvites = data?.pending_invites || [];
    this._requestListRender();

    // ── Process any pending key exchanges stored via HTTP fallback ──
    for (const s of sessions) {
      if (s.pending_key_exchange_json && !this._drStates.has(s.session_id)) {
        try {
          const guestBundle = typeof s.pending_key_exchange_json === 'string'
            ? JSON.parse(s.pending_key_exchange_json) : s.pending_key_exchange_json;
          console.log('[Ephemeral] processing pending key-exchange from D1 for', s.session_id);
          await this._handleKeyExchange({
            sessionId: s.session_id,
            guestBundle
          });
        } catch (err) {
          console.warn('[Ephemeral] pending key-exchange processing failed', s.session_id, err?.message);
        }
      }
    }
  }

  /**
   * Periodic poll: check if any sessions have pending key exchanges that
   * haven't been processed yet. This catches the case where the WS relay
   * failed but the HTTP fallback stored the bundle in D1.
   */
  async _pollPendingKeyExchanges() {
    // Only poll if there are sessions without established DR state
    const needsPoll = [...this.ephemeralSessions.values()].some(s => !this._drStates.has(s.session_id));
    if (!needsPoll) return;
    try {
      await this._loadSessions();
    } catch { /* swallowed — _loadSessions has its own error handling */ }
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

    // Business chat button (coming soon)
    const bizBtn = document.getElementById('btnCreateBusinessChat');
    if (bizBtn) bizBtn.addEventListener('click', () => this._showComingSoonModal());
  }

  _showComingSoonModal() {
    let modal = document.getElementById('comingSoonModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'comingSoonModal';
      modal.className = 'coming-soon-modal';
      modal.innerHTML = `
        <div class="coming-soon-backdrop"></div>
        <div class="coming-soon-panel">
          <div class="coming-soon-icon">🚧</div>
          <div class="coming-soon-title">${escapeHtml(t('ephemeral.comingSoonTitle') || '功能開發中')}</div>
          <div class="coming-soon-desc">${escapeHtml(t('ephemeral.comingSoonDesc') || '商業對話功能尚未開放，敬請期待')}</div>
          <button class="coming-soon-ok">${escapeHtml(t('misc.ok') || 'OK')}</button>
        </div>
      `;
      document.body.appendChild(modal);
      modal.querySelector('.coming-soon-backdrop')?.addEventListener('click', () => modal.classList.remove('active'));
      modal.querySelector('.coming-soon-ok')?.addEventListener('click', () => modal.classList.remove('active'));
    }
    modal.classList.add('active');
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
      _persistMap(STORAGE_KEY_INVITE_KEYS, this._pendingInviteKeys);

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
        row.dataset.ephSession = item.session_id;
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
            _persistMap(STORAGE_KEY_INVITE_KEYS, this._pendingInviteKeys);
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
        const expiredToken = this._sessionTokenMap.get(id);
        this._sessionTokenMap.delete(id);
        if (expiredToken) this._pendingInviteKeys.delete(expiredToken);
        needsRender = true;
        continue;
      }
      // Update ALL DOM timers (conversation list + modal both have matching elements)
      const min = Math.floor(remaining / 60);
      const sec = remaining % 60;
      const timerText = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
      const colorClass = remaining > 300 ? 'green' : remaining > 120 ? 'yellow' : 'red';
      for (const timerEl of document.querySelectorAll(`[data-eph-session="${id}"] .eph-timer-badge`)) {
        timerEl.textContent = timerText;
        timerEl.className = 'eph-timer-badge ' + colorClass;
      }

      // Update in-conversation timer if this is the active conversation
      this._updateConvTimer(session, remaining);
    }

    if (needsRender) {
      _persistMap(STORAGE_KEY_INVITE_KEYS, this._pendingInviteKeys);
      _persistMap(STORAGE_KEY_SESSION_TOKEN_MAP, this._sessionTokenMap);
      this._requestListRender();
    }
  }

  _updateConvTimer(session, remaining) {
    const convTimerEl = document.getElementById('ephConvTimerClock');
    const extendBtnEl = document.getElementById('ephConvExtendBtn');
    const fillEl = document.getElementById('ephConvProgressFill');
    const fireEl = document.getElementById('ephConvProgressFire');
    if (!convTimerEl) return;
    if (convTimerEl.dataset.sessionId !== session.session_id) return;

    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    convTimerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    // Calculate elapsed percentage (0% = just started, 100% = time's up)
    const totalDuration = (session.created_at && session.expires_at)
      ? (session.expires_at - session.created_at) : 600;
    const elapsed = Math.max(0, Math.min(100, (1 - remaining / totalDuration) * 100));

    convTimerEl.className = 'eph-conv-timer-clock' + (elapsed >= 80 ? ' red' : '');
    if (fillEl) {
      fillEl.style.width = elapsed + '%';
    }
    if (fireEl) {
      fireEl.style.left = elapsed + '%';
    }
    if (extendBtnEl) {
      if (remaining <= 300) {
        extendBtnEl.classList.add('active');
        extendBtnEl.disabled = false;
      } else {
        extendBtnEl.classList.remove('active');
        extendBtnEl.disabled = true;
      }
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
      const displayName = session.guest_nickname || t('ephemeral.guestLabel', { id: guestId });
      li.innerHTML = `
        <div class="item-content conversation-item-content">
          <div class="conversation-avatar"></div>
          <div class="conversation-content">
            <div class="conversation-row conversation-row-top">
              <span class="conversation-name">${escapeHtml(session.guest_nickname || t('ephemeral.tempChat'))}</span>
              <span class="eph-timer-badge ${colorClass}">${escapeHtml(timerText)}</span>
            </div>
            <div class="conversation-row conversation-row-bottom">
              <span class="conversation-snippet">${escapeHtml(session.guest_nickname ? t('ephemeral.tempChat') : displayName)}</span>
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
    // Must include both digest and device_id (format: "digest::deviceId")
    // otherwise normalizePeerIdentity returns null → "invalid contact"
    const peerKey = `${session.guest_digest}::${session.guest_device_id}`;
    this.deps.setActiveConversation?.(peerKey, session.conversation_id, null);
    // Mark messages list as ephemeral for avatar styling
    document.getElementById('messagesList')?.classList.add('ephemeral-active');
    // Show timer bar in messages thread
    this._showConvTimerBar(session);
    // Update header name to show guest nickname
    const guestId = (session.guest_digest || '').slice(-4);
    const displayName = session.guest_nickname || t('ephemeral.guestLabel', { id: guestId });
    const peerNameEl = document.querySelector('.messages-header strong');
    if (peerNameEl) peerNameEl.textContent = displayName;
  }

  _showConvTimerBar(session) {
    // Inject timer bar into messages header area
    let timerBar = document.getElementById('ephConvTimerBar');
    if (!timerBar) {
      timerBar = document.createElement('div');
      timerBar.id = 'ephConvTimerBar';
      timerBar.className = 'eph-conv-timer-bar';
      timerBar.innerHTML = `
        <div class="eph-conv-timer-control-row">
          <button id="ephConvExtendBtn" class="eph-conv-extend-btn" disabled>${escapeHtml(t('ephemeral.extendTime'))}</button>
          <div id="ephConvTimerClock" class="eph-conv-timer-clock" data-session-id="">--:--</div>
          <button id="ephConvEndBtn" class="eph-conv-end-btn">${escapeHtml(t('ephemeral.endConversation'))}</button>
        </div>
        <div class="eph-conv-progress-wrap">
          <div id="ephConvProgressFill" class="eph-conv-progress-fill" style="width:0%"></div>
          <div id="ephConvProgressFire" class="eph-conv-progress-fire" style="left:0%">🔥<span class="fire-glow"></span></div>
        </div>
        <div class="eph-conv-timer-label">${escapeHtml(t('ephemeral.timerLabel'))}</div>
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

      // Bind end conversation button
      document.getElementById('ephConvEndBtn')?.addEventListener('click', () => {
        const sid = document.getElementById('ephConvTimerClock')?.dataset?.sessionId;
        if (!sid) return;
        this._showEndConfirmModal(sid);
      });

    }

    const clockEl = document.getElementById('ephConvTimerClock');
    if (clockEl) clockEl.dataset.sessionId = session.session_id;
    timerBar.style.display = 'flex';
  }

  hideConvTimerBar() {
    const timerBar = document.getElementById('ephConvTimerBar');
    if (timerBar) timerBar.style.display = 'none';
    document.getElementById('messagesList')?.classList.remove('ephemeral-active');
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

  /**
   * Decrypt an incoming ephemeral message and render it in the timeline.
   * This bypasses the regular handleIncomingSecureMessage path which
   * requires targetDeviceId/senderDeviceId (not present in ephemeral WS relay).
   */
  async decryptAndRender(msg) {
    const result = await this.decryptIncomingMessage(msg);
    if (!result) return;

    // Handle encrypted control messages (e.g. nickname)
    if (this._handleControlMessage(result.text, msg)) return;

    const messageId = crypto.randomUUID();
    appendUserMessage(msg.conversationId, {
      id: messageId,
      messageId,
      text: result.text,
      ts: result.ts || Date.now(),
      direction: 'incoming',
      senderDigest: msg.senderDigest || msg.fromDigest || '',
      msgType: 'text',
      status: 'received',
      decrypted: true
    });

    this.deps.updateMessagesUI?.({ preserveScroll: true });
    this.deps.scrollMessagesToBottomSoon?.();
  }

  /**
   * Handle encrypted control messages (not rendered as chat).
   * Returns true if the message was a control message and was consumed.
   */
  _handleControlMessage(text, rawMsg) {
    try {
      if (!text || text[0] !== '{') return false;
      const ctrl = JSON.parse(text);
      if (!ctrl._ctrl) return false;

      if (ctrl._ctrl === 'set-nickname' && ctrl.nickname) {
        const session = rawMsg?.conversationId
          ? this.getSessionByConversationId(rawMsg.conversationId)
          : null;
        if (session) {
          session.guest_nickname = ctrl.nickname;
          // Update peer name display if this conversation is active
          const state = this.deps.getMessageState?.() || {};
          if (state.conversationId === session.conversation_id) {
            const peerNameEl = document.querySelector('.messages-header strong');
            if (peerNameEl) peerNameEl.textContent = ctrl.nickname;
          }
          this._requestListRender();
          console.log('[Ephemeral] guest nickname set:', ctrl.nickname);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
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
          _persistMap(STORAGE_KEY_SESSION_TOKEN_MAP, this._sessionTokenMap);
          // Remove consumed invite from pending list
          this._pendingInvites = this._pendingInvites.filter(inv => inv.token !== msg.inviteToken);
        }

        this._requestListRender();
        this._refreshModalIfOpen();
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
          this._refreshModalIfOpen();
        }
        return true;
      }
      case 'ephemeral-deleted': {
        const delToken = this._sessionTokenMap.get(msg.sessionId);
        this.ephemeralSessions.delete(msg.sessionId);
        this._drStates.delete(msg.sessionId);
        this._sessionTokenMap.delete(msg.sessionId);
        if (delToken) this._pendingInviteKeys.delete(delToken);
        _persistMap(STORAGE_KEY_INVITE_KEYS, this._pendingInviteKeys);
        _persistMap(STORAGE_KEY_SESSION_TOKEN_MAP, this._sessionTokenMap);
        this._requestListRender();
        this._refreshModalIfOpen();
        this.hideConvTimerBar();
        return true;
      }
      case 'ephemeral-guest-leave': {
        // Guest ended the conversation — clean up just like ephemeral-deleted
        const glToken = this._sessionTokenMap.get(msg.sessionId);
        this.ephemeralSessions.delete(msg.sessionId);
        this._drStates.delete(msg.sessionId);
        this._sessionTokenMap.delete(msg.sessionId);
        if (glToken) this._pendingInviteKeys.delete(glToken);
        _persistMap(STORAGE_KEY_INVITE_KEYS, this._pendingInviteKeys);
        _persistMap(STORAGE_KEY_SESSION_TOKEN_MAP, this._sessionTokenMap);
        this._requestListRender();
        this._refreshModalIfOpen();
        this.hideConvTimerBar();
        return true;
      }
      case 'ephemeral-message': {
        // Encrypted message — decrypt and forward to rendering pipeline
        // Decryption is handled by the WS integration layer calling decryptIncomingMessage()
        return false; // Let WS integration handle it
      }
      default:
        // Handle ephemeral call signals
        if (typeof msg.type === 'string' && msg.type.startsWith('ephemeral-call-')) {
          this._handleCallSignal(msg);
          return true;
        }
        return false;
    }
  }

  // ── E2EE: Handle key exchange from guest ──
  async _handleKeyExchange(msg) {
    const sessionId = msg.sessionId;
    console.log('[Ephemeral] _handleKeyExchange START', sessionId,
      'sessions:', this.ephemeralSessions.size,
      'tokenMap:', this._sessionTokenMap.size,
      'inviteKeys:', this._pendingInviteKeys.size,
      'hasDrState:', this._drStates.has(sessionId));

    let session = this.ephemeralSessions.get(sessionId);

    // Session or key mapping may be missing if the ephemeral_session_started
    // WS notification was lost (e.g. owner's WS was disconnected when the
    // guest consumed the link). Fetch from server to recover.
    if (!session || !this._sessionTokenMap.has(sessionId)) {
      console.log('[Ephemeral] key-exchange: session/token missing, fetching from server...');
      await this._loadSessions();
      session = this.ephemeralSessions.get(sessionId);
    }

    if (!session) {
      console.error('[Ephemeral] key-exchange FAIL: session not found after server fetch', sessionId);
      return;
    }

    // ── Idempotent: if x3dh was already completed, just resend the ack ──
    // This handles the case where the first ack was lost (e.g. D1 replica lag
    // in the relay, guest WS disconnected briefly). The guest retries the
    // key-exchange, but the private key was already deleted after the first
    // x3dhRespond. Without this check, ALL retries fail with "no private key".
    if (this._drStates.has(sessionId)) {
      console.log('[Ephemeral] key-exchange: DR state already exists, resending ack', sessionId);
      const sent = this.deps.wsSend?.({
        type: 'ephemeral-key-exchange-ack',
        sessionId,
        conversationId: session.conversation_id,
        targetDigest: session.guest_digest,
        targetAccountDigest: session.guest_digest
      });
      console.log('[Ephemeral] re-sent ack for', sessionId, 'sent:', sent);
      // Ensure composer is enabled even on duplicate key-exchange
      this.deps.updateComposerAvailability?.();
      return;
    }

    const token = this._sessionTokenMap.get(sessionId);
    console.log('[Ephemeral] key-exchange: token lookup', sessionId, '→', token ? token.slice(0, 8) + '...' : 'NULL',
      'hasKey:', token ? this._pendingInviteKeys.has(token) : false);

    const ownerPriv = this._findPrivKeyForSession(sessionId);
    if (!ownerPriv) {
      console.error('[Ephemeral] key-exchange FAIL: no private key for session', sessionId,
        'token:', token ? token.slice(0, 8) + '...' : 'NULL',
        'allTokens:', [...this._pendingInviteKeys.keys()].map(k => k.slice(0, 8) + '...'));
      return;
    }

    await loadNacl();

    // X3DH: Owner as responder
    const drSt = await x3dhRespond(ownerPriv, msg.guestBundle);
    this._drStates.set(sessionId, drSt);

    // Clean up pending invite key (no longer needed — DR state is established)
    if (token) {
      this._pendingInviteKeys.delete(token);
      _persistMap(STORAGE_KEY_INVITE_KEYS, this._pendingInviteKeys);
    }

    // Send ack to guest so they know encryption is ready
    const sent = this.deps.wsSend?.({
      type: 'ephemeral-key-exchange-ack',
      sessionId,
      conversationId: session.conversation_id,
      targetDigest: session.guest_digest,
      targetAccountDigest: session.guest_digest
    });

    console.log('[Ephemeral] E2EE session established for', sessionId, 'ack sent:', sent);

    // Clear the pending key exchange from D1 (best-effort)
    ephemeralClearPendingKeyExchange({ sessionId }).catch(() => {});

    // Notify the UI that encryption is now ready (enables composer input)
    this.deps.updateComposerAvailability?.();
  }

  // ── Helpers ──
  _requestListRender() {
    this.deps.renderConversationList?.();
  }

  /**
   * If the create-link modal is currently visible, re-render its session list
   * so it reflects real-time changes (e.g. guest joined, session extended/deleted).
   */
  _refreshModalIfOpen() {
    const modal = document.getElementById('ephemeralLinkModal');
    if (!modal || modal.style.display === 'none' || modal.getAttribute('aria-hidden') === 'true') return;
    const sessionListEl = document.getElementById('ephLinkSessionList');
    if (sessionListEl) this._renderSessionListInModal(sessionListEl);
  }

  // ── End Conversation Confirm Modal ──
  _showEndConfirmModal(sessionId) {
    let modal = document.getElementById('ephEndConfirmModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'ephEndConfirmModal';
      modal.className = 'eph-end-confirm-modal';
      modal.innerHTML = `
        <div class="eph-end-confirm-backdrop" data-eph-end-close></div>
        <div class="eph-end-confirm-panel">
          <div class="eph-end-confirm-icon">🔥</div>
          <div class="eph-end-confirm-title">${escapeHtml(t('ephemeral.endConversation'))}</div>
          <div class="eph-end-confirm-desc">${escapeHtml(t('ephemeral.endConversationConfirm'))}</div>
          <div class="eph-end-confirm-actions">
            <button class="eph-end-confirm-cancel" data-eph-end-close>${escapeHtml(t('common.cancel') || 'Cancel')}</button>
            <button class="eph-end-confirm-ok" id="ephEndConfirmOk">${escapeHtml(t('ephemeral.endConversation'))}</button>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      // Close on backdrop click
      modal.querySelector('[data-eph-end-close]')?.addEventListener('click', () => {
        modal.classList.remove('active');
      });
      modal.querySelectorAll('[data-eph-end-close]').forEach(el => {
        el.addEventListener('click', () => modal.classList.remove('active'));
      });
    }

    // Bind confirm action (replace handler each time for correct sessionId)
    const okBtn = document.getElementById('ephEndConfirmOk');
    const newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    newOk.id = 'ephEndConfirmOk';
    newOk.addEventListener('click', async () => {
      modal.classList.remove('active');
      await this._deleteSession(sessionId);
      const state = this.deps.getMessageState?.() || {};
      state.activePeerDigest = null;
      state.conversationId = null;
      state.viewMode = 'list';
      this.deps.applyMessagesLayout?.();
    });

    modal.classList.add('active');
  }

  // ── Ephemeral Call System ──

  _generateCallId() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }

  async initiateCall(sessionId, mode = 'voice') {
    if (this._callState) return; // already in a call
    const session = this.ephemeralSessions.get(sessionId);
    if (!session) return;

    const callId = this._generateCallId();
    this._showCallOverlay(mode, t('ephemeral.callDialing'));

    try {
      const constraints = { audio: true, video: mode === 'video' };
      const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(err => {
        if (mode === 'video') return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        throw err;
      });

      const localVideo = document.getElementById('ephOwnerLocalVideo');
      if (stream.getVideoTracks().length > 0 && localVideo) {
        localVideo.srcObject = stream;
        localVideo.classList.add('visible');
      }

      const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS, bundlePolicy: 'max-bundle' });
      this._callState = { callId, sessionId, mode, pc, localStream: stream, muted: false, camOff: false, timerStart: null, timerInterval: null, direction: 'outgoing' };

      for (const track of stream.getTracks()) pc.addTrack(track, stream);

      const remoteVideo = document.getElementById('ephOwnerRemoteVideo');
      pc.ontrack = (evt) => {
        if (remoteVideo && evt.streams[0]) {
          remoteVideo.srcObject = evt.streams[0];
          if (evt.track.kind === 'video') remoteVideo.classList.add('visible');
        }
      };

      pc.onicecandidate = (evt) => {
        if (evt.candidate) {
          this.deps.wsSend?.({
            type: 'ephemeral-call-ice-candidate',
            callId,
            conversationId: session.conversation_id,
            sessionId,
            candidate: evt.candidate.toJSON()
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          this._updateCallStatus(t('ephemeral.callConnected'));
          this._startCallTimer();
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          this.endCall();
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.deps.wsSend?.({
        type: 'ephemeral-call-invite',
        callId,
        conversationId: session.conversation_id,
        sessionId,
        mode
      });
      this.deps.wsSend?.({
        type: 'ephemeral-call-offer',
        callId,
        conversationId: session.conversation_id,
        sessionId,
        description: pc.localDescription.toJSON()
      });
    } catch (err) {
      console.error('[EphCall] failed to start call', err);
      this._hideCallOverlay();
      this._callState = null;
    }
  }

  async _handleCallSignal(msg) {
    const type = msg.type;

    // Incoming call invite — auto-accept (owner doesn't need a ringing UI for ephemeral)
    if (type === 'ephemeral-call-invite') {
      if (this._callState) {
        // Already in a call — send busy
        this.deps.wsSend?.({
          type: 'ephemeral-call-busy',
          callId: msg.callId,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId
        });
        return;
      }
      // Find session
      const session = msg.sessionId ? this.ephemeralSessions.get(msg.sessionId) : null;
      const sessionForConv = session || (msg.conversationId ? this.getSessionByConversationId(msg.conversationId) : null);
      if (!sessionForConv) return;

      this._callState = {
        callId: msg.callId,
        sessionId: sessionForConv.session_id,
        mode: msg.mode || 'voice',
        pc: null, localStream: null,
        muted: false, camOff: false,
        timerStart: null, timerInterval: null,
        direction: 'incoming'
      };
      this._showCallOverlay(msg.mode || 'voice', t('ephemeral.callConnecting'));

      // Send accept
      this.deps.wsSend?.({
        type: 'ephemeral-call-accept',
        callId: msg.callId,
        conversationId: sessionForConv.conversation_id,
        sessionId: sessionForConv.session_id
      });
      return;
    }

    if (!this._callState || msg.callId !== this._callState.callId) return;

    if (type === 'ephemeral-call-offer') {
      // Incoming offer — create PC, set remote desc, create answer
      try {
        const mode = this._callState.mode;
        const constraints = { audio: true, video: mode === 'video' };
        const stream = await navigator.mediaDevices.getUserMedia(constraints).catch(err => {
          if (mode === 'video') return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          throw err;
        });

        const localVideo = document.getElementById('ephOwnerLocalVideo');
        if (stream.getVideoTracks().length > 0 && localVideo) {
          localVideo.srcObject = stream;
          localVideo.classList.add('visible');
        }

        const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS, bundlePolicy: 'max-bundle' });
        this._callState.pc = pc;
        this._callState.localStream = stream;

        for (const track of stream.getTracks()) pc.addTrack(track, stream);

        const remoteVideo = document.getElementById('ephOwnerRemoteVideo');
        pc.ontrack = (evt) => {
          if (remoteVideo && evt.streams[0]) {
            remoteVideo.srcObject = evt.streams[0];
            if (evt.track.kind === 'video') remoteVideo.classList.add('visible');
          }
        };

        const session = this.ephemeralSessions.get(this._callState.sessionId);
        pc.onicecandidate = (evt) => {
          if (evt.candidate) {
            this.deps.wsSend?.({
              type: 'ephemeral-call-ice-candidate',
              callId: this._callState?.callId,
              conversationId: session?.conversation_id,
              sessionId: this._callState?.sessionId,
              candidate: evt.candidate.toJSON()
            });
          }
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'connected') {
            this._updateCallStatus(t('ephemeral.callConnected'));
            this._startCallTimer();
          } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            this.endCall();
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(msg.description));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.deps.wsSend?.({
          type: 'ephemeral-call-answer',
          callId: this._callState.callId,
          conversationId: session?.conversation_id,
          sessionId: this._callState.sessionId,
          description: pc.localDescription.toJSON()
        });
      } catch (err) {
        console.error('[EphCall] failed to handle offer', err);
        this.endCall();
      }
      return;
    }

    if (type === 'ephemeral-call-answer' && this._callState.pc) {
      if (msg.description) {
        this._callState.pc.setRemoteDescription(new RTCSessionDescription(msg.description)).catch(console.error);
      }
      return;
    }

    if (type === 'ephemeral-call-ice-candidate' && this._callState.pc) {
      if (msg.candidate) {
        this._callState.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(console.error);
      }
      return;
    }

    if (type === 'ephemeral-call-accept') {
      this._updateCallStatus(t('ephemeral.callConnecting'));
      return;
    }

    if (type === 'ephemeral-call-reject' || type === 'ephemeral-call-busy') {
      this._updateCallStatus(type === 'ephemeral-call-busy' ? t('ephemeral.callBusy') : t('ephemeral.callRejected'));
      setTimeout(() => this.endCall(), 1500);
      return;
    }

    if (type === 'ephemeral-call-end') {
      this.endCall(true);
      return;
    }
  }

  endCall(fromRemote = false) {
    if (!this._callState) return;
    const { pc, localStream, callId, timerInterval: ti, sessionId } = this._callState;
    const session = this.ephemeralSessions.get(sessionId);
    if (!fromRemote && session) {
      this.deps.wsSend?.({
        type: 'ephemeral-call-end',
        callId,
        conversationId: session.conversation_id,
        sessionId
      });
    }
    if (ti) clearInterval(ti);
    for (const track of localStream?.getTracks() || []) track.stop();
    pc?.close();
    const remoteVideo = document.getElementById('ephOwnerRemoteVideo');
    const localVideo = document.getElementById('ephOwnerLocalVideo');
    if (remoteVideo) { remoteVideo.srcObject = null; remoteVideo.classList.remove('visible'); }
    if (localVideo) { localVideo.srcObject = null; localVideo.classList.remove('visible'); }
    this._callState = null;
    this._hideCallOverlay();
  }

  toggleMute() {
    if (!this._callState?.localStream) return;
    this._callState.muted = !this._callState.muted;
    for (const t of this._callState.localStream.getAudioTracks()) t.enabled = !this._callState.muted;
    const btn = document.getElementById('ephOwnerMuteBtn');
    if (btn) btn.classList.toggle('active', this._callState.muted);
  }

  toggleCamera() {
    if (!this._callState?.localStream) return;
    this._callState.camOff = !this._callState.camOff;
    for (const t of this._callState.localStream.getVideoTracks()) t.enabled = !this._callState.camOff;
    const btn = document.getElementById('ephOwnerCamToggleBtn');
    if (btn) btn.classList.toggle('active', this._callState.camOff);
  }

  _showCallOverlay(mode, status) {
    let overlay = document.getElementById('ephOwnerCallOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'ephOwnerCallOverlay';
      overlay.className = 'eph-owner-call-overlay';
      overlay.innerHTML = `
        <video class="call-remote-video" id="ephOwnerRemoteVideo" autoplay playsinline></video>
        <video class="call-local-video" id="ephOwnerLocalVideo" autoplay playsinline muted></video>
        <div class="call-mode-icon" id="ephOwnerCallModeIcon"></div>
        <div class="call-status" id="ephOwnerCallStatus"></div>
        <div class="call-timer" id="ephOwnerCallTimer"></div>
        <div class="call-controls">
          <button class="call-ctrl-btn mute" id="ephOwnerMuteBtn"><i class='bx bx-microphone'></i></button>
          <button class="call-ctrl-btn cam-toggle" id="ephOwnerCamToggleBtn" style="display:none"><i class='bx bx-video'></i></button>
          <button class="call-ctrl-btn hangup" id="ephOwnerHangupBtn"><i class='bx bx-phone-off'></i></button>
        </div>
      `;
      document.body.appendChild(overlay);

      document.getElementById('ephOwnerMuteBtn')?.addEventListener('click', () => this.toggleMute());
      document.getElementById('ephOwnerCamToggleBtn')?.addEventListener('click', () => this.toggleCamera());
      document.getElementById('ephOwnerHangupBtn')?.addEventListener('click', () => this.endCall());
    }

    const modeIcon = document.getElementById('ephOwnerCallModeIcon');
    if (modeIcon) modeIcon.textContent = mode === 'video' ? '📹' : '📞';
    this._updateCallStatus(status);
    const timerEl = document.getElementById('ephOwnerCallTimer');
    if (timerEl) timerEl.textContent = '';
    overlay.classList.add('active');

    const muteBtn = document.getElementById('ephOwnerMuteBtn');
    if (muteBtn) muteBtn.classList.remove('active');
    const camBtn = document.getElementById('ephOwnerCamToggleBtn');
    if (camBtn) { camBtn.classList.remove('active'); camBtn.style.display = mode === 'video' ? '' : 'none'; }
  }

  _hideCallOverlay() {
    const overlay = document.getElementById('ephOwnerCallOverlay');
    if (overlay) overlay.classList.remove('active');
  }

  _updateCallStatus(text) {
    const el = document.getElementById('ephOwnerCallStatus');
    if (el) el.textContent = text;
  }

  _startCallTimer() {
    if (!this._callState) return;
    this._callState.timerStart = Date.now();
    this._callState.timerInterval = setInterval(() => {
      if (!this._callState) return;
      const elapsed = Math.floor((Date.now() - this._callState.timerStart) / 1000);
      const m = Math.floor(elapsed / 60);
      const s = elapsed % 60;
      const timerEl = document.getElementById('ephOwnerCallTimer');
      if (timerEl) timerEl.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }, 1000);
  }
}
