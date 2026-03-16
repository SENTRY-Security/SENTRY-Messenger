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
import { log } from '../../../core/log.js';

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
          <div id="bizConvCreateStatus" class="biz-conv-create-status" role="status" aria-live="polite"></div>
          <div class="biz-conv-wizard-actions biz-conv-wizard-actions--dual">
            <button type="button" id="bizConvBack3" class="btn btn-ghost">${t('messages.bizConvBack')}</button>
            <button type="button" id="bizConvSubmit" class="btn btn-primary">${t('messages.bizConvCreate')}</button>
          </div>
        </div>`;

      const statusEl = document.getElementById('bizConvCreateStatus');

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
        if (btn) btn.disabled = true;
        if (statusEl) statusEl.textContent = t('messages.bizConvCreating');

        try {
          await doCreate(state.groupName, state.selectedMembers, state.policy, state.avatarDataUrl);
          showToast?.(t('messages.bizConvCreated'));
          closeModal();
          renderConversationList?.();
        } catch (err) {
          log({ bizConvCreateError: err?.message });
          if (statusEl) statusEl.textContent = t('messages.bizConvCreateFailed');
          if (btn) btn.disabled = false;
        }
      });

      function collectSelectedMembers() {
        const list = document.getElementById('bizConvContactList');
        if (!list) return;
        const checked = list.querySelectorAll('input[name="member"]:checked');
        state.selectedMembers = Array.from(checked).map(cb => ({
          accountDigest: cb.value,
          deviceId: cb.dataset.deviceId || null
        }));
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

  async function doCreate(groupName, members, policy, avatarDataUrl) {
    const selfDigest = getAccountDigest();
    const selfDeviceId = ensureDeviceId();
    if (!selfDigest || !selfDeviceId) throw new Error('Not authenticated');

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

    await bizConvCreate({
      conversationId,
      encryptedMetaBlob: JSON.stringify(encryptedMeta),
      encryptedPolicyBlob: JSON.stringify(encryptedPolicy),
      members: []
    });

    const st = BizConvStore.getOrCreate(conversationId);
    st.seeds[0] = groupSeed;
    st.currentEpoch = 0;
    st._groupMetaKey = metaKey;
    st.owner_account_digest = selfDigest;
    st.status = 'active';
    st.meta = { name: groupName };
    st.policy = policy;
    st.members = [{ accountDigest: selfDigest, deviceId: selfDeviceId, role: 'owner' }];

    upsertBizConvThread(conversationId, {
      name: groupName,
      memberCount: 1 + members.length,
      isOwner: true,
      status: 'active'
    });

    for (const member of members) {
      try {
        await bizConvInvite(conversationId, member.accountDigest);
        const kdm = buildKDM({
          conversationId,
          epoch: 0,
          groupSeed,
          meta: { name: groupName }
        });
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
