/**
 * GroupBuilderController
 * Manages group creation UI and workflow.
 */

import { BaseController } from './base-controller.js';
import { normalizePeerKey } from '../contact-core-store.js';
import { escapeHtml } from '../ui-utils.js';
import { createGroupProcess, LocalGroupStore } from '../../../features/groups.js';

export class GroupBuilderController extends BaseController {
    constructor(deps) {
        super(deps);
        this.groupBuilderEl = null;
        this.localGroups = LocalGroupStore.list();
        this.GROUPS_ENABLED = false; // Feature flag
    }

    /**
     * Get contact peer key from contact object.
     * @private
     */
    _contactPeerKey(contact) {
        if (!contact) return null;
        return normalizePeerKey(contact.peerAccountDigest || contact.accountDigest || null);
    }

    /**
     * Copy group summary to clipboard.
     */
    async copyGroupSummary(draft) {
        if (!draft) return;
        const summary = [
            `群組ID: ${draft.groupId}`,
            `群組名稱: ${draft.name || '(未命名)'}`,
            `對話ID: ${draft.conversationId}`,
            `會話密鑰(token): ${draft.tokenB64}`,
            `邀請密鑰(seed): ${draft.secretB64Url}`
        ].join('\n');
        try {
            await navigator.clipboard.writeText(summary);
            this.showToast('群組資訊已複製');
        } catch {
            this.showToast('無法複製到剪貼簿，請確認權限');
            this.log({ groupCopyClipboardError: 'clipboard-write-failed' });
        }
    }

    /**
     * Render group drafts list.
     */
    renderGroupDrafts() {
        if (!this.GROUPS_ENABLED) return;
        const container = this.elements.groupDraftsEl;
        if (!container) return;
        if (!this.localGroups.length) {
            container.innerHTML = '';
            return;
        }
        const items = this.localGroups.map((draft, idx) => {
            const created = draft.createdAt ? new Date(draft.createdAt).toLocaleString() : '';
            const label = escapeHtml(draft.name || draft.groupId);
            const gid = escapeHtml(draft.groupId);
            const cid = escapeHtml(draft.conversationId);
            return `
        <div class="group-draft-item" data-idx="${idx}">
          <div class="group-draft-meta">
            <div class="group-draft-name">${label}</div>
            <div class="group-draft-id">ID ${gid}</div>
            <div class="group-draft-cid">CID ${cid}</div>
            ${created ? `<div class="group-draft-ts">${created}</div>` : ''}
          </div>
          <button type="button" class="group-draft-copy" aria-label="複製群組資訊">複製</button>
        </div>
      `;
        }).join('');
        container.innerHTML = `<div class="group-draft-header">我的群組（僅本機記錄）</div>${items}`;
        container.querySelectorAll('.group-draft-copy').forEach((btn) => {
            btn.addEventListener('click', (event) => {
                const wrapper = event.target.closest('.group-draft-item');
                const idx = Number(wrapper?.dataset?.idx ?? -1);
                if (Number.isInteger(idx) && idx >= 0 && this.localGroups[idx]) {
                    this.copyGroupSummary(this.localGroups[idx]);
                }
            });
        });
    }

    /**
     * Handle create group button click.
     */
    async handleCreateGroup() {
        if (!this.GROUPS_ENABLED) return;
        const btn = this.elements.createGroupBtn;
        if (!btn) return;
        if (this.groupBuilderEl) {
            this.groupBuilderEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        this.openGroupBuilder();
    }

    /**
     * Open the group builder UI.
     */
    openGroupBuilder() {
        if (!this.GROUPS_ENABLED) return;
        this.closeGroupBuilder();
        const container = document.createElement('div');
        container.className = 'group-builder';
        container.style.padding = '12px';
        container.style.margin = '8px 12px';
        container.style.border = '1px solid rgba(15,23,42,0.08)';
        container.style.borderRadius = '12px';
        container.style.background = '#f8fafc';
        container.style.boxShadow = '0 8px 24px rgba(15,23,42,0.08)';
        container.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;justify-content:space-between;margin-bottom:8px;">
        <strong style="font-size:14px;">建立群組</strong>
        <div style="display:flex;gap:8px;">
          <button type="button" class="group-builder-cancel secondary" style="padding:6px 10px;">取消</button>
          <button type="button" class="group-builder-create primary" style="padding:6px 10px;">建立</button>
        </div>
      </div>
      <label style="display:block;margin-bottom:8px;">
        <div style="font-size:12px;color:#475569;margin-bottom:4px;">群組名稱</div>
        <input type="text" class="group-builder-name" placeholder="輸入群組名稱" style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:14px;"/>
      </label>
      <div style="font-size:12px;color:#475569;margin:4px 0 6px;">選擇成員</div>
      <div class="group-builder-list" style="max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:6px;"></div>
      <div class="group-builder-empty" style="display:none;font-size:13px;color:#64748b;padding:8px 0;">尚無好友可加入，請先建立好友。</div>
    `;
        this.elements.conversationList?.parentElement?.insertBefore(container, this.elements.conversationList);
        this.groupBuilderEl = container;
        this.renderGroupMemberList();
        container.querySelector('.group-builder-cancel')?.addEventListener('click', () => this.closeGroupBuilder());
        container.querySelector('.group-builder-create')?.addEventListener('click', () => this.submitGroupBuilder());
    }

    /**
     * Close the group builder UI.
     */
    closeGroupBuilder() {
        if (this.groupBuilderEl && this.groupBuilderEl.parentElement) {
            this.groupBuilderEl.parentElement.removeChild(this.groupBuilderEl);
        }
        this.groupBuilderEl = null;
    }

    /**
     * Render member selection list.
     */
    renderGroupMemberList() {
        if (!this.GROUPS_ENABLED) return;
        if (!this.groupBuilderEl) return;
        const listEl = this.groupBuilderEl.querySelector('.group-builder-list');
        const emptyEl = this.groupBuilderEl.querySelector('.group-builder-empty');
        if (!listEl || !emptyEl) return;
        const contacts = Array.isArray(this.sessionStore.contactState) ? this.sessionStore.contactState : [];
        if (!contacts.length) {
            listEl.innerHTML = '';
            emptyEl.style.display = 'block';
            return;
        }
        emptyEl.style.display = 'none';
        listEl.innerHTML = contacts.map((c) => {
            const digest = this._contactPeerKey(c) || '';
            const nickname = escapeHtml(c?.nickname || `好友 ${digest.slice(-4)}`);
            return `
        <label class="group-builder-item" style="display:flex;align-items:center;gap:10px;padding:8px;border:1px solid rgba(148,163,184,0.4);border-radius:10px;cursor:pointer;">
          <input type="checkbox" data-peer-account-digest="${digest}" data-digest="${escapeHtml(digest)}" style="width:16px;height:16px;"/>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <span style="font-size:13px;font-weight:600;">${nickname}</span>
            <span style="font-size:11px;color:#64748b;">${digest}</span>
          </div>
        </label>
      `;
        }).join('');
    }

    /**
     * Submit the group builder form.
     */
    async submitGroupBuilder() {
        if (!this.GROUPS_ENABLED) return;
        if (!this.groupBuilderEl) return;
        const nameInput = this.groupBuilderEl.querySelector('.group-builder-name');
        const checkboxes = this.groupBuilderEl.querySelectorAll('input[type="checkbox"][data-peer-account-digest]');
        const selected = [];
        checkboxes.forEach((cb) => {
            if (cb.checked) {
                const digest = normalizePeerKey(cb.getAttribute('data-digest') || cb.getAttribute('data-peer-account-digest') || '');
                if (!digest) return;
                selected.push({ accountDigest: digest });
            }
        });
        const nameVal = (nameInput?.value || '').trim();
        const btn = this.groupBuilderEl.querySelector('.group-builder-create');
        if (btn?.dataset.busy === '1') return;
        btn.dataset.busy = '1';
        btn.disabled = true;
        try {
            const draft = await createGroupProcess({ name: nameVal, members: selected });
            this.showToast(`群組已建立：${draft.name}`);
            this.localGroups = LocalGroupStore.list();
            this.renderGroupDrafts();
            try {
                const summary = [
                    `群組ID: ${draft.groupId}`,
                    `對話ID: ${draft.conversationId}`,
                    `會話密鑰(token): ${draft.tokenB64}`,
                    `邀請密鑰(seed): ${draft.secretB64Url}`
                ].join('\n');
                await navigator.clipboard.writeText(summary);
                this.showToast('群組資訊已複製，可貼給成員');
            } catch {
                this.showToast('群組已建立，複製剪貼簿失敗，請稍後再試');
                this.log({ groupCreateClipboardError: 'clipboard-write-failed' });
            }
            this.log({ groupCreate: { groupId: draft.groupId, conversationId: draft.conversationId, hasClipboard: true } });
        } catch (err) {
            this.showToast(`建立群組失敗：${err?.message || err}`);
            this.log({ groupCreateError: err?.message || err });
        } finally {
            if (btn) {
                delete btn.dataset.busy;
                btn.disabled = false;
            }
        }
    }
}
