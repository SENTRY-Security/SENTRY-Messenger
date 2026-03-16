/**
 * Business Conversation Create Modal
 *
 * Allows the user to create a new business conversation (group chat).
 * Steps: enter group name → select contacts → create on server → distribute KDMs.
 */

import { t } from '/locales/index.js';
import { escapeHtml } from '../ui-utils.js';
import { listReadyContacts, resolveContactAvatarUrl } from '../contact-core-store.js';
import { bizConvCreate, bizConvInvite } from '../../../api/biz-conv.js';
import { BizConvStore } from '../../../features/biz-conv.js';
import { deriveBizConvId, deriveGroupMetaKey, encryptMetaBlob, encryptRoleBlob, buildKDM } from '../../../../shared/crypto/biz-conv.js';
import { markBizConvBackupDirty } from '../../../features/biz-conv-backup.js';
import { getAccountDigest, ensureDeviceId } from '../../../core/store.js';
import { upsertBizConvThread } from '../../../features/conversation-updates.js';
import { log } from '../../../core/log.js';

export function createBizConvCreateModal({ deps }) {
  const { openModal, closeModal, resetModalVariants, showToast, renderConversationList, getDrSessMap } = deps;

  async function open() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;
    resetModalVariants(modalElement);
    modalElement.classList.add('biz-conv-create-modal');
    if (title) title.textContent = t('messages.bizConvCreate');

    const contacts = listReadyContacts();

    body.innerHTML = `
      <form id="bizConvCreateForm" class="biz-conv-create-form">
        <label for="bizConvNameInput">
          ${t('messages.bizConvGroupName')}
          <input id="bizConvNameInput" type="text" maxlength="64"
                 placeholder="${escapeHtml(t('messages.bizConvGroupNamePlaceholder'))}" required />
        </label>
        <div class="biz-conv-members-label">${t('messages.bizConvSelectMembers')}</div>
        <div id="bizConvContactList" class="biz-conv-contact-list">
          ${contacts.length === 0
            ? `<div class="biz-conv-no-contacts">${t('messages.bizConvNoContacts')}</div>`
            : contacts.map((c, i) => {
                const nick = c.nickname || c.peerKey?.slice(-8) || `#${i}`;
                const digest = c.peerAccountDigest || c.peerKey || '';
                const avatarUrl = resolveContactAvatarUrl(c);
                const initial = nick.charAt(0).toUpperCase();
                const avatarHtml = avatarUrl
                  ? `<img class="biz-conv-contact-avatar" src="${escapeHtml(avatarUrl)}" alt="" />`
                  : `<span class="biz-conv-contact-avatar biz-conv-contact-avatar--initial">${escapeHtml(initial)}</span>`;
                return `<label class="biz-conv-contact-item">
                  <input type="checkbox" name="member" value="${escapeHtml(digest)}" data-device-id="${escapeHtml(c.peerDeviceId || '')}" />
                  ${avatarHtml}
                  <span class="biz-conv-contact-nick">${escapeHtml(nick)}</span>
                </label>`;
              }).join('')
          }
        </div>
        <div id="bizConvCreateStatus" class="biz-conv-create-status" role="status" aria-live="polite"></div>
        <button type="submit" id="bizConvCreateBtn" class="btn btn-primary">${t('messages.bizConvCreate')}</button>
      </form>
    `;

    const form = document.getElementById('bizConvCreateForm');
    const statusEl = document.getElementById('bizConvCreateStatus');

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('bizConvNameInput');
      const groupName = nameInput?.value?.trim();
      if (!groupName) return;

      const checked = form.querySelectorAll('input[name="member"]:checked');
      const selectedMembers = Array.from(checked).map(cb => ({
        accountDigest: cb.value,
        deviceId: cb.dataset.deviceId || null
      }));

      if (selectedMembers.length === 0) {
        if (statusEl) statusEl.textContent = t('messages.bizConvSelectMembers');
        return;
      }

      const btn = document.getElementById('bizConvCreateBtn');
      if (btn) btn.disabled = true;
      if (statusEl) statusEl.textContent = t('messages.bizConvCreating');

      try {
        await doCreate(groupName, selectedMembers);
        showToast?.(t('messages.bizConvCreated'));
        closeModal();
        renderConversationList?.();
      } catch (err) {
        log({ bizConvCreateError: err?.message });
        if (statusEl) statusEl.textContent = t('messages.bizConvCreateFailed');
        if (btn) btn.disabled = false;
      }
    });

    openModal();
  }

  /**
   * Create a new business conversation:
   * 1. Generate group seed
   * 2. Derive conversation_id
   * 3. Encrypt meta blob
   * 4. Call server create API
   * 5. Invite each member + send KDM via DR
   */
  async function doCreate(groupName, members) {
    const selfDigest = getAccountDigest();
    const selfDeviceId = ensureDeviceId();
    if (!selfDigest || !selfDeviceId) throw new Error('Not authenticated');

    // Generate group seed (32 bytes random)
    const groupSeed = crypto.getRandomValues(new Uint8Array(32));

    // Derive conversation ID (returns { conversationId, tokenB64 })
    const { conversationId } = await deriveBizConvId(groupSeed);

    // Derive meta key and encrypt meta blob
    const metaKey = await deriveGroupMetaKey(groupSeed);
    const encryptedMeta = await encryptMetaBlob(metaKey, {
      name: groupName,
      created_at: Date.now(),
      owner: selfDigest
    });

    // Encrypt owner role
    const ownerRole = await encryptRoleBlob(metaKey, {
      account_digest: selfDigest,
      role: 'owner',
      joined_at: Date.now()
    });

    // Create on server
    await bizConvCreate({
      conversationId,
      encryptedMetaBlob: JSON.stringify(encryptedMeta),
      encryptedPolicyBlob: null,
      members: []
    });

    // Initialize local store state
    const state = BizConvStore.getOrCreate(conversationId);
    state.seeds[0] = groupSeed;
    state.currentEpoch = 0;
    state._groupMetaKey = metaKey;
    state.owner_account_digest = selfDigest;
    state.status = 'active';
    state.meta = { name: groupName };
    state.members = [{ accountDigest: selfDigest, deviceId: selfDeviceId, role: 'owner' }];

    // Upsert thread for conversation list
    upsertBizConvThread(conversationId, {
      name: groupName,
      memberCount: 1 + members.length,
      isOwner: true,
      status: 'active'
    });

    // Invite members and send KDMs
    for (const member of members) {
      try {
        // Invite on server
        await bizConvInvite(conversationId, member.accountDigest);

        // Build KDM for this member (to be sent via existing DR channel)
        const kdm = buildKDM({
          conversationId,
          epoch: 0,
          groupSeed,
          meta: { name: groupName }
        });

        // Send KDM through the existing pairwise DR message channel
        if (typeof deps.sendBizConvKDM === 'function') {
          await deps.sendBizConvKDM(member.accountDigest, member.deviceId, kdm);
        }
      } catch (err) {
        log({ bizConvInviteError: { member: member.accountDigest?.slice(-8), error: err?.message } });
      }
    }

    markBizConvBackupDirty();
    log({ bizConvCreated: { conversationId: conversationId?.slice(-8), members: members.length } });
  }

  return { open };
}
