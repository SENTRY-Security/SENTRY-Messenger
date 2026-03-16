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
import { findContactCoreByAccountDigest, resolveContactAvatarUrl } from '../contact-core-store.js';
import { getConversationThreads } from '../../../features/conversation-updates.js';
import { appendUserMessage } from '../../../features/timeline-store.js';
import { sessionStore } from '../session-store.js';
import { log } from '../../../core/log.js';

export function createBizConvInfoModal({ deps }) {
  const { openModal, closeModal, resetModalVariants, showToast, showConfirmModal, renderConversationList, navigateToList } = deps;

  function resolveMemberInfo(digest, conversationId) {
    const matches = findContactCoreByAccountDigest(digest);
    const ready = matches.find(m => m.entry?.isReady);
    if (ready) {
      return {
        nickname: ready.entry.nickname || digest.slice(-8),
        avatarUrl: resolveContactAvatarUrl(ready.entry),
        isFriend: true
      };
    }
    // Fallback: use member profile from KDM data (for non-contact members)
    const profile = conversationId ? BizConvStore.getMemberProfile(conversationId, digest) : null;
    if (profile) {
      return {
        nickname: profile.nickname || digest.slice(-8),
        avatarUrl: profile.avatar || null,
        isFriend: false
      };
    }
    return { nickname: digest.slice(-8), avatarUrl: null, isFriend: false };
  }

  function memberAvatarHtml(info) {
    if (info.avatarUrl) {
      return `<img class="biz-conv-member-avatar" src="${escapeHtml(info.avatarUrl)}" alt="" />`;
    }
    const initial = info.nickname.charAt(0).toUpperCase();
    return `<span class="biz-conv-member-avatar biz-conv-member-avatar--initial">${escapeHtml(initial)}</span>`;
  }

  async function open(conversationId) {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body || !conversationId) return;

    resetModalVariants(modalElement);
    modalElement.classList.add('biz-conv-info-modal');

    const convState = BizConvStore.conversations.get(conversationId);
    const selfDigest = getAccountDigest();
    const isOwner = convState?.isOwner || convState?.owner_account_digest === selfDigest || false;
    const groupName = convState?.name || convState?.meta?.name || t('messages.bizConvDefault');

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

    const memberCount = members.length;
    const threads = getConversationThreads();
    const threadData = threads.get(conversationId) || {};
    const groupAvatarUrl = threadData.bizConvAvatar || null;
    const groupAvatarHtml = groupAvatarUrl
      ? `<img class="biz-conv-info-avatar biz-conv-info-avatar--img" src="${escapeHtml(groupAvatarUrl)}" alt="" />`
      : `<div class="biz-conv-info-avatar">${escapeHtml(groupName.slice(0, 2).toUpperCase())}</div>`;

    body.innerHTML = `
      <div class="biz-conv-info">
        <div class="biz-conv-info-header">
          ${groupAvatarHtml}
          <div class="biz-conv-info-name">${escapeHtml(groupName)}</div>
          <div class="biz-conv-info-count">${memberCount} ${t('messages.bizConvMemberCount')}</div>
        </div>
        <div class="biz-conv-info-section-title">${t('messages.bizConvMembers')}</div>
        <div class="biz-conv-info-members">
          ${members.map(m => {
            const digest = m.account_digest || m.accountDigest || '';
            const isSelf = digest === selfDigest;
            const isOwnerMember = m.role === 'owner' || digest === (convState?.owner_account_digest || convState?.ownerDigest || '');

            let nickname, avatarHtml, isFriend;
            if (isSelf) {
              const selfAvatarUrl = sessionStore.currentAvatarUrl || null;
              const selfInfo = { nickname: t('misc.me') || 'Me', avatarUrl: selfAvatarUrl, isFriend: true };
              nickname = selfInfo.nickname;
              avatarHtml = memberAvatarHtml(selfInfo);
              isFriend = true;
            } else {
              const info = resolveMemberInfo(digest, conversationId);
              nickname = info.nickname;
              avatarHtml = memberAvatarHtml(info);
              isFriend = info.isFriend;
            }

            return `<div class="biz-conv-member-item" data-digest="${escapeHtml(digest)}">
              ${avatarHtml}
              <span class="biz-conv-member-name">${escapeHtml(nickname)}</span>
              ${isOwnerMember ? `<span class="biz-conv-member-badge">${t('messages.bizConvOwner')}</span>` : ''}
              ${!isSelf && !isFriend ? `<button class="biz-conv-add-friend-btn" data-digest="${escapeHtml(digest)}" data-device-id="${escapeHtml(m.device_id || m.deviceId || '')}">${t('messages.bizConvAddFriend')}</button>` : ''}
              ${isOwner && !isSelf ? `<button class="biz-conv-kick-btn" data-digest="${escapeHtml(digest)}">${t('messages.bizConvKick')}</button>` : ''}
            </div>`;
          }).join('')}
        </div>
        <div class="biz-conv-info-actions">
          ${isOwner
            ? `<button id="bizConvTransferBtn" class="btn biz-conv-btn-transfer">${t('messages.bizConvTransferOwnership')}</button>
               <button id="bizConvDissolveBtn" class="btn biz-conv-btn-dissolve">${t('messages.bizConvDissolve')}</button>`
            : `<button id="bizConvLeaveBtn" class="btn biz-conv-btn-leave">${t('messages.bizConvLeave')}</button>`
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
        document.dispatchEvent(new CustomEvent('biz-conv:add-friend', {
          detail: {
            peerAccountDigest: digest,
            peerDeviceId: deviceId,
            conversationId,
            source: 'biz-conv-info'
          }
        }));
        btn.disabled = true;
        btn.textContent = t('messages.bizConvFriendRequestSent');
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
          // Filter removed member locally to avoid stale server data
          members = members.filter(m => {
            const d = m.account_digest || m.accountDigest || '';
            return d !== digest;
          });
          // Also update BizConvStore local members
          const cs = BizConvStore.conversations.get(conversationId);
          if (cs?.members) {
            cs.members = cs.members.filter(m => {
              const d = m.account_digest || m.accountDigest || '';
              return d !== digest;
            });
          }
          try {
            await rotateGroupKey(conversationId, {
              reason: 'member-removed',
              removedDigest: digest,
              sendKdmFn: deps.sendBizConvKDM || null
            });
          } catch (rotErr) {
            log({ bizConvRotateAfterKickError: rotErr?.message });
          }
          showToast?.(t('messages.bizConvMemberRemoved'));
          // Remove the member row from DOM directly instead of re-fetching
          const row = body.querySelector(`.biz-conv-member-item[data-digest="${CSS.escape(digest)}"]`);
          if (row) row.remove();
          // Update member count display
          const countEl = body.querySelector('.biz-conv-info-count');
          if (countEl) countEl.textContent = `${members.length} ${t('messages.bizConvMemberCount')}`;
        } catch (err) {
          showToast?.(t('messages.bizConvActionFailed'));
        }
      });
    });

    // Transfer ownership
    document.getElementById('bizConvTransferBtn')?.addEventListener('click', () => {
      const nonSelfMembers = members.filter(m => {
        const d = m.account_digest || m.accountDigest || '';
        return d !== selfDigest;
      });
      if (nonSelfMembers.length === 0) {
        showToast?.(t('messages.bizConvNoMembersToTransfer'));
        return;
      }
      // Render transfer picker directly in the modal body
      if (title) title.textContent = t('messages.bizConvTransferOwnership');
      body.innerHTML = `
        <div class="biz-conv-info">
          <div class="biz-conv-transfer-hint">${escapeHtml(t('messages.bizConvTransferHint'))}</div>
          <div class="biz-conv-transfer-list">
            ${nonSelfMembers.map(m => {
              const d = m.account_digest || m.accountDigest || '';
              const info = resolveMemberInfo(d);
              return `<button class="biz-conv-transfer-pick" data-digest="${escapeHtml(d)}">
                ${memberAvatarHtml(info)}
                <span>${escapeHtml(info.nickname)}</span>
              </button>`;
            }).join('')}
          </div>
          <div class="biz-conv-wizard-actions">
            <button type="button" id="bizConvTransferBack" class="btn btn-ghost">${t('messages.bizConvBack')}</button>
          </div>
        </div>`;
      document.getElementById('bizConvTransferBack')?.addEventListener('click', () => open(conversationId));
      body.querySelectorAll('.biz-conv-transfer-pick').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            const targetDigest = btn.dataset.digest;
            const targetInfo = resolveMemberInfo(targetDigest, conversationId);
            await bizConvTransfer(conversationId, targetDigest);
            // Update local ownership state
            const cs = BizConvStore.conversations.get(conversationId);
            if (cs) {
              cs.isOwner = false;
              cs.owner_account_digest = targetDigest;
            }
            const th = getConversationThreads().get(conversationId);
            if (th) th.bizConvIsOwner = false;
            markBizConvBackupDirty();
            appendUserMessage(conversationId, {
              messageId: `tombstone-transfer-${Date.now()}`,
              msgType: 'biz-conv-tombstone',
              text: t('messages.bizConvOwnershipTransferred') + ' → ' + targetInfo.nickname,
              ts: Date.now(),
              direction: 'system'
            });
            showToast?.(t('messages.bizConvOwnershipTransferred'));
            renderConversationList?.();
            open(conversationId);
          } catch (err) {
            showToast?.(t('messages.bizConvActionFailed'));
          }
        });
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
            appendUserMessage(conversationId, {
              messageId: `tombstone-leave-${Date.now()}`,
              msgType: 'biz-conv-tombstone',
              text: t('messages.bizConvLeftGroup'),
              ts: Date.now(),
              direction: 'system'
            });
            BizConvStore.conversations.delete(conversationId);
            getConversationThreads().delete(conversationId);
            markBizConvBackupDirty();
            closeModal();
            renderConversationList?.();
            navigateToList?.();
          } catch (err) {
            showToast?.(t('messages.bizConvActionFailed'));
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
            appendUserMessage(conversationId, {
              messageId: `tombstone-dissolve-${Date.now()}`,
              msgType: 'biz-conv-tombstone',
              text: t('messages.bizConvDissolved'),
              ts: Date.now(),
              direction: 'system'
            });
            BizConvStore.conversations.delete(conversationId);
            getConversationThreads().delete(conversationId);
            markBizConvBackupDirty();
            closeModal();
            renderConversationList?.();
            navigateToList?.();
          } catch (err) {
            showToast?.(t('messages.bizConvActionFailed'));
          }
        }
      });
    });

    openModal();
  }

  return { open };
}
