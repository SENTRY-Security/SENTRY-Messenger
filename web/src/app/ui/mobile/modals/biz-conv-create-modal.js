/**
 * Business Conversation Create Modal — 3-step wizard
 *
 * Step 1: Group name + avatar
 * Step 2: Group policy
 * Step 3: Select members
 */

import { t } from '/locales/index.js';
import { escapeHtml } from '../ui-utils.js';
import { listReadyContacts, resolveContactAvatarUrl } from '../contact-core-store.js';
import { bizConvCreate, bizConvInvite } from '../../../api/biz-conv.js';
import { BizConvStore } from '../../../features/biz-conv.js';
import { deriveBizConvId, deriveGroupMetaKey, encryptMetaBlob, encryptRoleBlob, encryptPolicyBlob, buildKDM } from '../../../../shared/crypto/biz-conv.js';
import { markBizConvBackupDirty } from '../../../features/biz-conv-backup.js';
import { getAccountDigest, ensureDeviceId } from '../../../core/store.js';
import { upsertBizConvThread } from '../../../features/conversation-updates.js';
import { appendUserMessage } from '../../../features/timeline-store.js';
import { log } from '../../../core/log.js';
import { sessionStore } from '../session-store.js';

export function createBizConvCreateModal({ deps }) {
  const { openModal, closeModal, resetModalVariants, showToast, renderConversationList } = deps;

  async function open() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;
    resetModalVariants(modalElement);
    modalElement.classList.add('biz-conv-create-modal');

    const state = {
      step: 1,
      groupName: '',
      avatarDataUrl: null,
      avatarFile: null,
      policy: {
        allow_member_invite: false,
        allow_member_friendship: true,
        max_members: 50
      },
      selectedMembers: []
    };

    function render() {
      if (title) title.textContent = t('messages.bizConvCreate');
      if (state.step === 1) renderStep1();
      else if (state.step === 2) renderStep2();
      else renderStep3();
    }

    // ── Step 1: Name + Avatar ──
    function renderStep1() {
      const avatarPreview = state.avatarDataUrl
        ? `<img src="${escapeHtml(state.avatarDataUrl)}" class="biz-conv-avatar-preview" alt="" />`
        : `<div class="biz-conv-avatar-preview biz-conv-avatar-preview--empty">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
          </div>`;

      body.innerHTML = `
        <div class="biz-conv-wizard" data-step="1">
          <div class="biz-conv-step-indicator">${stepDots(1)}</div>
          <div class="biz-conv-step-content">
            <div class="biz-conv-avatar-section">
              <div id="bizConvAvatarBtn" class="biz-conv-avatar-btn" role="button" tabindex="0">
                ${avatarPreview}
                <span class="biz-conv-avatar-hint">${t('messages.bizConvChooseAvatar')}</span>
              </div>
              <input id="bizConvAvatarInput" type="file" accept="image/*" style="display:none" />
            </div>
            <label class="biz-conv-field-label" for="bizConvNameInput">
              ${t('messages.bizConvGroupName')}
              <input id="bizConvNameInput" type="text" maxlength="64"
                     value="${escapeHtml(state.groupName)}"
                     placeholder="${escapeHtml(t('messages.bizConvGroupNamePlaceholder'))}" />
            </label>
          </div>
          <div class="biz-conv-wizard-actions">
            <button type="button" id="bizConvNext1" class="btn btn-primary" disabled>${t('messages.bizConvNext')}</button>
          </div>
        </div>`;

      const nameInput = document.getElementById('bizConvNameInput');
      const nextBtn = document.getElementById('bizConvNext1');
      const avatarBtn = document.getElementById('bizConvAvatarBtn');
      const avatarInput = document.getElementById('bizConvAvatarInput');

      // Enable next if name is filled
      const checkName = () => {
        state.groupName = nameInput?.value?.trim() || '';
        if (nextBtn) nextBtn.disabled = !state.groupName;
      };
      nameInput?.addEventListener('input', checkName);
      checkName();

      nextBtn?.addEventListener('click', () => { state.step = 2; render(); });

      // Avatar picker
      avatarBtn?.addEventListener('click', () => avatarInput?.click());
      avatarInput?.addEventListener('change', () => {
        const file = avatarInput.files?.[0];
        if (!file || !file.type.startsWith('image/')) return;
        state.avatarFile = file;
        const reader = new FileReader();
        reader.onload = () => {
          state.avatarDataUrl = reader.result;
          render();
        };
        reader.readAsDataURL(file);
      });
    }

    // ── Step 2: Policy ──
    function renderStep2() {
      body.innerHTML = `
        <div class="biz-conv-wizard" data-step="2">
          <div class="biz-conv-step-indicator">${stepDots(2)}</div>
          <div class="biz-conv-step-content">
            <div class="biz-conv-policy-list">
              <label class="biz-conv-policy-item">
                <span class="biz-conv-policy-text">
                  <span class="biz-conv-policy-title">${t('messages.bizConvPolicyAllowInvite')}</span>
                  <span class="biz-conv-policy-desc">${t('messages.bizConvPolicyAllowInviteDesc')}</span>
                </span>
                <input type="checkbox" id="policyAllowInvite" ${state.policy.allow_member_invite ? 'checked' : ''} />
              </label>
              <label class="biz-conv-policy-item">
                <span class="biz-conv-policy-text">
                  <span class="biz-conv-policy-title">${t('messages.bizConvPolicyAllowFriendship')}</span>
                  <span class="biz-conv-policy-desc">${t('messages.bizConvPolicyAllowFriendshipDesc')}</span>
                </span>
                <input type="checkbox" id="policyAllowFriendship" ${state.policy.allow_member_friendship ? 'checked' : ''} />
              </label>
              <label class="biz-conv-policy-item">
                <span class="biz-conv-policy-text">
                  <span class="biz-conv-policy-title">${t('messages.bizConvPolicyMaxMembers')}</span>
                  <span class="biz-conv-policy-desc">${t('messages.bizConvPolicyMaxMembersDesc')}</span>
                </span>
                <select id="policyMaxMembers" class="biz-conv-policy-select">
                  ${[10, 20, 50, 100, 200, 500].map(n =>
                    `<option value="${n}" ${state.policy.max_members === n ? 'selected' : ''}>${n}</option>`
                  ).join('')}
                </select>
              </label>
            </div>
          </div>
          <div class="biz-conv-wizard-actions biz-conv-wizard-actions--dual">
            <button type="button" id="bizConvBack2" class="btn btn-ghost">${t('messages.bizConvBack')}</button>
            <button type="button" id="bizConvNext2" class="btn btn-primary">${t('messages.bizConvNext')}</button>
          </div>
        </div>`;

      document.getElementById('bizConvBack2')?.addEventListener('click', () => { state.step = 1; render(); });
      document.getElementById('bizConvNext2')?.addEventListener('click', () => {
        state.policy.allow_member_invite = document.getElementById('policyAllowInvite')?.checked || false;
        state.policy.allow_member_friendship = document.getElementById('policyAllowFriendship')?.checked || false;
        state.policy.max_members = parseInt(document.getElementById('policyMaxMembers')?.value, 10) || 50;
        state.step = 3;
        render();
      });
    }

    // ── Step 3: Select Members ──
    function renderStep3() {
      const contacts = listReadyContacts();
      const selectedSet = new Set(state.selectedMembers.map(m => m.accountDigest));

      body.innerHTML = `
        <div class="biz-conv-wizard" data-step="3">
          <div class="biz-conv-step-indicator">${stepDots(3)}</div>
          <div class="biz-conv-step-content">
            <div class="biz-conv-members-label">${t('messages.bizConvSelectMembers')}</div>
            <div id="bizConvContactList" class="biz-conv-contact-list">
              ${contacts.length === 0
                ? `<div class="biz-conv-no-contacts">${t('messages.bizConvNoContacts')}</div>`
                : contacts.map((c, i) => {
                    const nick = c.nickname || c.peerKey?.slice(-8) || `#${i}`;
                    const digest = c.peerAccountDigest || c.peerKey || '';
                    const avatarUrl = resolveContactAvatarUrl(c);
                    const initial = nick.charAt(0).toUpperCase();
                    const checked = selectedSet.has(digest) ? 'checked' : '';
                    const avatarHtml = avatarUrl
                      ? `<img class="biz-conv-contact-avatar" src="${escapeHtml(avatarUrl)}" alt="" />`
                      : `<span class="biz-conv-contact-avatar biz-conv-contact-avatar--initial">${escapeHtml(initial)}</span>`;
                    return `<label class="biz-conv-contact-item">
                      <input type="checkbox" name="member" value="${escapeHtml(digest)}" data-device-id="${escapeHtml(c.peerDeviceId || '')}" ${checked} />
                      ${avatarHtml}
                      <span class="biz-conv-contact-nick">${escapeHtml(nick)}</span>
                    </label>`;
                  }).join('')
              }
            </div>
          </div>
          <div id="bizConvCreateProgress" class="biz-conv-create-progress" role="status" aria-live="polite" style="display:none">
            <div class="biz-conv-progress-bar-track">
              <div id="bizConvProgressBar" class="biz-conv-progress-bar-fill"></div>
            </div>
            <div id="bizConvProgressStep" class="biz-conv-progress-step"></div>
          </div>
          <div id="bizConvCreateStatus" class="biz-conv-create-status" role="status" aria-live="polite"></div>
          <div class="biz-conv-wizard-actions biz-conv-wizard-actions--dual">
            <button type="button" id="bizConvBack3" class="btn btn-ghost">${t('messages.bizConvBack')}</button>
            <button type="button" id="bizConvSubmit" class="btn btn-primary">${t('messages.bizConvCreate')}</button>
          </div>
        </div>`;

      const statusEl = document.getElementById('bizConvCreateStatus');
      const progressEl = document.getElementById('bizConvCreateProgress');
      const progressBarEl = document.getElementById('bizConvProgressBar');
      const progressStepEl = document.getElementById('bizConvProgressStep');

      function updateProgress(percent, stepText) {
        if (progressEl) progressEl.style.display = '';
        if (progressBarEl) progressBarEl.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        if (progressStepEl) progressStepEl.textContent = stepText;
        if (statusEl) statusEl.textContent = '';
      }

      document.getElementById('bizConvBack3')?.addEventListener('click', () => {
        collectSelectedMembers();
        state.step = 2;
        render();
      });

      document.getElementById('bizConvSubmit')?.addEventListener('click', async () => {
        collectSelectedMembers();
        if (state.selectedMembers.length === 0) {
          if (statusEl) statusEl.textContent = t('messages.bizConvSelectMembers');
          return;
        }
        const btn = document.getElementById('bizConvSubmit');
        const backBtn = document.getElementById('bizConvBack3');
        if (btn) btn.disabled = true;
        if (backBtn) backBtn.disabled = true;

        try {
          await doCreate(state.groupName, state.selectedMembers, state.policy, state.avatarDataUrl, updateProgress);
          updateProgress(100, t('messages.bizConvCreated'));
          showToast?.(t('messages.bizConvCreated'));
          closeModal();
          renderConversationList?.();
        } catch (err) {
          log({ bizConvCreateError: err?.message, stack: err?.stack });
          console.error('[biz-conv-create] doCreate failed:', err);
          if (progressEl) progressEl.style.display = 'none';
          const errDetail = err?.message || '';
          if (statusEl) statusEl.textContent = t('messages.bizConvCreateFailed') + (errDetail ? ` (${errDetail})` : '');
          if (btn) btn.disabled = false;
          if (backBtn) backBtn.disabled = false;
        }
      });

      function collectSelectedMembers() {
        const list = document.getElementById('bizConvContactList');
        if (!list) return;
        const checked = list.querySelectorAll('input[name="member"]:checked');
        const contacts = listReadyContacts();
        const contactMap = new Map();
        for (const c of contacts) {
          const d = (c.peerAccountDigest || c.peerKey || '').toUpperCase();
          if (d) contactMap.set(d, c);
        }
        state.selectedMembers = Array.from(checked).map(cb => {
          const digest = cb.value;
          const contact = contactMap.get((digest || '').toUpperCase());
          return {
            accountDigest: digest,
            deviceId: cb.dataset.deviceId || null,
            nickname: contact?.nickname || null,
            avatar: resolveContactAvatarUrl(contact) || null
          };
        });
      }
    }

    function stepDots(current) {
      return [1, 2, 3].map(n =>
        `<span class="biz-conv-dot${n === current ? ' biz-conv-dot--active' : ''}"></span>`
      ).join('');
    }

    render();
    openModal();
  }

  async function doCreate(groupName, members, policy, avatarDataUrl, onProgress) {
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    const totalMembers = members.length;
    // Progress allocation: keys 10%, server 25%, local 35%, invite loop 40-95%, done 100%

    const selfDigest = getAccountDigest();
    const selfDeviceId = ensureDeviceId();
    if (!selfDigest || !selfDeviceId) throw new Error('Not authenticated');

    // ── Step 1: Generate encryption keys ──
    report(5, t('messages.bizConvProgressKeys'));
    const groupSeed = crypto.getRandomValues(new Uint8Array(32));
    const { conversationId } = await deriveBizConvId(groupSeed);
    const metaKey = await deriveGroupMetaKey(groupSeed);

    const metaPayload = {
      name: groupName,
      created_at: Date.now(),
      owner: selfDigest
    };
    if (avatarDataUrl) metaPayload.avatar = avatarDataUrl;

    const encryptedMeta = await encryptMetaBlob(metaKey, metaPayload);

    const policyPayload = { v: 1, ...policy };
    const encryptedPolicy = await encryptPolicyBlob(metaKey, policyPayload);

    await encryptRoleBlob(metaKey, {
      account_digest: selfDigest,
      role: 'owner',
      joined_at: Date.now()
    });
    report(15, t('messages.bizConvProgressKeys'));

    // ── Step 2: Create group on server ──
    report(20, t('messages.bizConvProgressServer'));
    await bizConvCreate({
      conversationId,
      encryptedMetaBlob: JSON.stringify(encryptedMeta),
      encryptedPolicyBlob: JSON.stringify(encryptedPolicy),
      members: []
    });
    report(30, t('messages.bizConvProgressServer'));

    // ── Step 3: Initialize local state ──
    report(35, t('messages.bizConvProgressLocal'));
    const st = BizConvStore.getOrCreate(conversationId);
    st.seeds[0] = groupSeed;
    st.currentEpoch = 0;
    st._groupMetaKey = metaKey;
    st.owner_account_digest = selfDigest;
    st.status = 'active';
    st.meta = { name: groupName, avatar: avatarDataUrl || null };
    st.policy = policy;
    st.members = [{ accountDigest: selfDigest, deviceId: selfDeviceId, role: 'owner' }];

    upsertBizConvThread(conversationId, {
      name: groupName,
      memberCount: 1 + members.length,
      isOwner: true,
      status: 'active',
      avatar: avatarDataUrl || null
    });

    // Insert a tombstone so the chat shows "Group created"
    appendUserMessage(conversationId, {
      messageId: `tombstone-created-${conversationId}`,
      msgType: 'biz-conv-tombstone',
      text: t('messages.bizConvCreated'),
      ts: Date.now(),
      direction: 'system'
    });

    // Build member profiles list for KDM (so recipients can display names/avatars
    // even if they don't have each other as contacts)
    const selfNickname = sessionStore.nickname || sessionStore.currentNickname || null;
    const selfAvatar = sessionStore.currentAvatarUrl || null;
    const memberProfiles = [
      { accountDigest: selfDigest, nickname: selfNickname, avatar: selfAvatar },
      ...members.map(m => ({
        accountDigest: m.accountDigest,
        nickname: m.nickname || null,
        avatar: m.avatar || null
      }))
    ];

    // Also store member profiles locally for the owner
    const st2 = BizConvStore.get(conversationId);
    if (st2) {
      st2.memberProfiles = {};
      for (const p of memberProfiles) {
        if (p.accountDigest) {
          st2.memberProfiles[p.accountDigest.toUpperCase()] = {
            nickname: p.nickname || null,
            avatar: p.avatar || null
          };
        }
      }
    }

    // ── Step 4: Invite members & distribute keys ──
    const inviteErrors = [];
    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const memberNick = member.nickname || member.accountDigest?.slice(-8) || `#${i + 1}`;
      const pctBase = 40 + Math.round((i / totalMembers) * 55);
      report(pctBase, t('messages.bizConvProgressInvite', { current: i + 1, total: totalMembers, name: memberNick }));

      try {
        await bizConvInvite(conversationId, member.accountDigest);

        // Resolve device ID: prefer member.deviceId, fallback to DR session map
        let deviceId = member.deviceId || null;
        if (!deviceId && member.accountDigest) {
          const drSessMap = deps.getDrSessMap?.();
          if (drSessMap) {
            for (const [key] of drSessMap) {
              if (typeof key === 'string' && key.toUpperCase().startsWith(member.accountDigest.toUpperCase() + '::')) {
                deviceId = key.split('::')[1] || null;
                break;
              }
            }
          }
        }

        if (!deviceId) {
          log({ bizConvKdmSkipNoDevice: { member: member.accountDigest?.slice(-8) } });
          inviteErrors.push(memberNick);
          continue;
        }

        const kdm = buildKDM({
          conversationId,
          epoch: 0,
          groupSeed,
          meta: {
            name: groupName,
            owner: selfDigest,
            avatar: avatarDataUrl || null,
            members: memberProfiles
          }
        });
        if (typeof deps.sendBizConvKDM === 'function') {
          await deps.sendBizConvKDM(member.accountDigest, deviceId, kdm);
        }
      } catch (err) {
        log({ bizConvInviteError: { member: member.accountDigest?.slice(-8), error: err?.message } });
        inviteErrors.push(memberNick);
      }
    }

    report(95, t('messages.bizConvProgressFinishing'));
    markBizConvBackupDirty();
    log({ bizConvCreated: { conversationId: conversationId?.slice(-8), members: members.length, inviteErrors: inviteErrors.length } });

    // Notify if some invites failed
    if (inviteErrors.length > 0) {
      log({ bizConvPartialInviteFailures: inviteErrors });
    }
  }

  return { open };
}
