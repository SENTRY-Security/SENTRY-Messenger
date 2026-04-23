// Modal for selecting an emoji identifier for a contact.
// Slides up from bottom, shows preview + category tabs + emoji grid.

import { t } from '/locales/index.js';
import { EMOJI_POOL, EMOJI_CATEGORIES, isValidEmoji, findCategoryOfEmoji } from '../../../features/contact-emoji/emoji-pool.js';
import { getLabelEmoji, setLabel, clearLabel } from '../../../features/contact-emoji/contact-label-store.js';
import { triggerContactSecretsBackup } from '../../../features/contact-backup.js';
import { applyAvatarBadge } from '../components/avatar-badge.js';

const OVERLAY_ID = 'emojiIdentifierModalOverlay';
let lastCategoryId = null;

export function showIdentifierModal({ peerDigest, nickname, avatarSrc } = {}) {
  if (!peerDigest) return;
  hideIdentifierModal();

  const currentEmoji = getLabelEmoji(peerDigest);
  let selectedEmoji = currentEmoji;
  const activeCat = lastCategoryId && EMOJI_POOL[lastCategoryId] ? lastCategoryId : EMOJI_CATEGORIES[0].id;

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'emoji-id-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const escHandler = (e) => { if (e.key === 'Escape') hideIdentifierModal(); };

  const displayName = nickname || `${t('common.friend')} ${peerDigest.slice(-4)}`;

  const avatarHtml = avatarSrc
    ? `<img src="${escapeHtml(avatarSrc)}" alt="" />`
    : `<span style="font-size:22px;color:rgba(255,255,255,0.5)">${escapeHtml(displayName.slice(0, 2).toUpperCase())}</span>`;

  overlay.innerHTML = `
    <div class="emoji-id-modal">
      <div class="emoji-id-modal-handle"></div>
      <div class="emoji-id-modal-header">
        <span class="emoji-id-modal-title">${escapeHtml(t('emoji.modalTitle'))}</span>
        <button type="button" class="emoji-id-modal-close" aria-label="${escapeHtml(t('common.close'))}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="emoji-id-preview">
        <div class="emoji-id-preview-avatar" data-preview-avatar="1">
          ${avatarHtml}
        </div>
        <div class="emoji-id-preview-name">${escapeHtml(displayName)}</div>
      </div>
      <div class="emoji-id-tabs" data-tabs="1"></div>
      <div class="emoji-id-grid-scroll">
        <div class="emoji-id-grid" data-grid="1" role="grid" aria-label="${escapeHtml(t('emoji.gridLabel'))}"></div>
      </div>
      <div class="emoji-id-actions">
        <button type="button" class="emoji-id-btn emoji-id-btn-clear">${escapeHtml(t('emoji.clear'))}</button>
        <button type="button" class="emoji-id-btn emoji-id-btn-save">${escapeHtml(t('emoji.save'))}</button>
      </div>
      <div class="emoji-id-security">${escapeHtml(t('emoji.securityNote'))}</div>
    </div>
  `;

  const modal = overlay.querySelector('.emoji-id-modal');
  const previewAvatar = overlay.querySelector('[data-preview-avatar]');
  const tabs = overlay.querySelector('[data-tabs]');
  const grid = overlay.querySelector('[data-grid]');
  const closeBtn = overlay.querySelector('.emoji-id-modal-close');
  const clearBtn = overlay.querySelector('.emoji-id-btn-clear');
  const saveBtn = overlay.querySelector('.emoji-id-btn-save');

  function updatePreviewBadge() {
    const existing = previewAvatar.querySelector('.avatar-emoji-badge');
    if (existing) existing.remove();
    if (selectedEmoji) {
      const badge = document.createElement('span');
      badge.className = 'avatar-emoji-badge';
      badge.textContent = selectedEmoji;
      badge.style.fontSize = '18px';
      badge.style.width = '24px';
      badge.style.height = '24px';
      previewAvatar.appendChild(badge);
    }
  }

  function renderTabs(activeId) {
    tabs.innerHTML = '';
    for (const cat of EMOJI_CATEGORIES) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'emoji-id-tab' + (cat.id === activeId ? ' active' : '');
      tab.textContent = t(cat.labelI18nKey);
      tab.dataset.catId = cat.id;
      tab.addEventListener('click', () => {
        lastCategoryId = cat.id;
        renderTabs(cat.id);
        renderGrid(cat.id);
      });
      tabs.appendChild(tab);
    }
  }

  function renderGrid(catId) {
    const emojis = EMOJI_POOL[catId] || [];
    grid.innerHTML = '';
    for (const emoji of emojis) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'emoji-id-cell' + (emoji === selectedEmoji ? ' selected' : '');
      cell.textContent = emoji;
      cell.setAttribute('role', 'gridcell');
      cell.setAttribute('aria-label', emoji);
      cell.addEventListener('click', () => {
        if (selectedEmoji === emoji) {
          selectedEmoji = null;
        } else {
          selectedEmoji = emoji;
        }
        renderGrid(catId);
        updatePreviewBadge();
      });
      grid.appendChild(cell);
    }
  }

  // Close
  closeBtn.addEventListener('click', hideIdentifierModal);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) hideIdentifierModal();
  });

  // Clear
  clearBtn.addEventListener('click', () => {
    selectedEmoji = null;
    const currentCat = lastCategoryId || EMOJI_CATEGORIES[0].id;
    renderGrid(currentCat);
    updatePreviewBadge();
  });

  // Save
  saveBtn.addEventListener('click', () => {
    if (selectedEmoji) {
      setLabel(peerDigest, selectedEmoji);
    } else {
      clearLabel(peerDigest);
    }
    triggerContactSecretsBackup('emoji-label-change').catch(() => {});
    hideIdentifierModal();
  });

  document.addEventListener('keydown', escHandler);
  overlay.__escHandler = escHandler;

  document.body.appendChild(overlay);
  renderTabs(activeCat);
  renderGrid(activeCat);
  updatePreviewBadge();

  // Scroll active tab into view
  const activeTab = tabs.querySelector('.emoji-id-tab.active');
  if (activeTab) activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

export function hideIdentifierModal() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  if (overlay.__escHandler) {
    document.removeEventListener('keydown', overlay.__escHandler);
  }
  overlay.remove();
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
