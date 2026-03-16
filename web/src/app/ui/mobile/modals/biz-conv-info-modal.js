/**
 * Business Conversation Info Modal
 *
 * Shows group info: name, members, owner status.
 * Allows: leave group, dissolve (owner), kick member (owner), transfer ownership (owner).
 */

import { t } from '/locales/index.js';
import { escapeHtml } from '../ui-utils.js';
import { BizConvStore } from '../../../features/biz-conv.js';
import {
  bizConvLeave, bizConvDissolve, bizConvRemove,
  bizConvTransfer, bizConvMembers
} from '../../../api/biz-conv.js';
import { markBizConvBackupDirty } from '../../../features/biz-conv-backup.js';
import { rotateGroupKey } from '../../../features/biz-conv-key-rotation.js';
import { getAccountDigest } from '../../../core/store.js';
import { log } from '../../../core/log.js';

export function createBizConvInfoModal({ deps }) {
  const { openModal, closeModal, resetModalVariants, showToast, showConfirmModal, renderConversationList } = deps;

  async function open(conversationId) {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body || !conversationId) return;

    resetModalVariants(modalElement);
    modalElement.classList.add('biz-conv-info-modal');

    const convState = BizConvStore.conversations.get(conversationId);
    const selfDigest = getAccountDigest();
    const isOwner = convState?.isOwner || false;
    const groupName = convState?.name || t('messages.bizConvDefault');

    if (title) title.textContent = t('messages.bizConvSettings');

    // Fetch members from server
    let members = convState?.members || [];
    try {
      const result = await bizConvMembers(conversationId);
      if (result?.members) {
        members = result.members;
      }
    } catch (err) {
      log({ bizConvInfoMembersFetchError: err?.message });
    }

    body.innerHTML = `
      <div class="biz-conv-info">
        <div class="biz-conv-info-header">
          <div class="biz-conv-info-avatar">${escapeHtml(groupName.slice(0, 2).toUpperCase())}</div>
          <div class="biz-conv-info-name">${escapeHtml(groupName)}</div>
          <div class="biz-conv-info-count">${members.length} ${t('messages.bizConvMembers').toLowerCase()}</div>
        </div>
        <div class="biz-conv-info-section-title">${t('messages.bizConvMembers')}</div>
        <div class="biz-conv-info-members">
          ${members.map(m => {
            const digest = m.account_digest || m.accountDigest || '';
            const isSelf = digest === selfDigest;
            const isOwnerMember = m.role === 'owner' || digest === (convState?.ownerDigest || selfDigest);
            const shortId = digest.slice(-8);
            return `<div class="biz-conv-member-item" data-digest="${escapeHtml(digest)}">
              <span class="biz-conv-member-name">${escapeHtml(isSelf ? t('misc.you') || 'You' : shortId)}</span>
              ${isOwnerMember ? `<span class="biz-conv-member-badge">${t('messages.bizConvOwner')}</span>` : ''}
              ${!isSelf ? `<button class="biz-conv-add-friend-btn" data-digest="${escapeHtml(digest)}" data-device-id="${escapeHtml(m.device_id || m.deviceId || '')}">${t('messages.bizConvAddFriend')}</button>` : ''}
              ${isOwner && !isSelf ? `<button class="biz-conv-kick-btn" data-digest="${escapeHtml(digest)}">${t('messages.bizConvKick')}</button>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div class="biz-conv-info-actions">
          ${isOwner
            ? `<button id="bizConvDissolveBtn" class="btn btn-danger">${t('messages.bizConvDissolve')}</button>`
            : `<button id="bizConvLeaveBtn" class="btn btn-secondary">${t('messages.bizConvLeave')}</button>`
          }
        </div>
      </div>
    `;

    // Add friend from group
    body.querySelectorAll('.biz-conv-add-friend-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const digest = btn.dataset.digest;
        const deviceId = btn.dataset.deviceId || null;
        if (!digest) return;
        // Emit a custom event for the contact system to handle
        document.dispatchEvent(new CustomEvent('biz-conv:add-friend', {
          detail: {
            peerAccountDigest: digest,
            peerDeviceId: deviceId,
            conversationId,
            source: 'biz-conv-info'
          }
        }));
        btn.disabled = true;
        btn.textContent = '...';
        showToast?.(t('messages.bizConvFriendRequestSent'));
      });
    });

    // Kick member
    body.querySelectorAll('.biz-conv-kick-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const digest = btn.dataset.digest;
        if (!digest) return;
        try {
          await bizConvRemove(conversationId, digest);
          // Trigger key rotation so the removed member can't decrypt future messages
          try {
            await rotateGroupKey(conversationId, {
              reason: 'member-removed',
              removedDigest: digest,
              sendKdmFn: deps.sendBizConvKDM || null
            });
          } catch (rotErr) {
            log({ bizConvRotateAfterKickError: rotErr?.message });
          }
          showToast?.('Member removed');
          open(conversationId); // Refresh
        } catch (err) {
          showToast?.(err?.message || 'Failed');
        }
      });
    });

    // Leave group
    document.getElementById('bizConvLeaveBtn')?.addEventListener('click', () => {
      showConfirmModal?.({
        title: t('messages.bizConvLeave'),
        message: t('messages.bizConvLeaveConfirm').replace('{name}', groupName),
        onConfirm: async () => {
          try {
            await bizConvLeave(conversationId);
            BizConvStore.conversations.delete(conversationId);
            markBizConvBackupDirty();
            closeModal();
            renderConversationList?.();
            showToast?.('Left group');
          } catch (err) {
            showToast?.(err?.message || 'Failed');
          }
        }
      });
    });

    // Dissolve group
    document.getElementById('bizConvDissolveBtn')?.addEventListener('click', () => {
      showConfirmModal?.({
        title: t('messages.bizConvDissolve'),
        message: t('messages.bizConvDissolveConfirm').replace('{name}', groupName),
        onConfirm: async () => {
          try {
            await bizConvDissolve(conversationId);
            BizConvStore.conversations.delete(conversationId);
            markBizConvBackupDirty();
            closeModal();
            renderConversationList?.();
            showToast?.('Group dissolved');
          } catch (err) {
            showToast?.(err?.message || 'Failed');
          }
        }
      });
    });

    openModal();
  }

  return { open };
}
