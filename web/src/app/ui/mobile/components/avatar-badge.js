// Overlays an emoji badge on the bottom-right corner of an avatar element.
// Shared across contacts list, conversation list, and conversation header.

import { getLabelEmoji } from '../../../features/contact-emoji/contact-label-store.js';

const BADGE_CLASS = 'avatar-emoji-badge';

export function applyAvatarBadge(avatarEl, peerDigest) {
  if (!avatarEl) return;
  removeBadge(avatarEl);
  const emoji = getLabelEmoji(peerDigest);
  if (!emoji) return;
  const badge = document.createElement('span');
  badge.className = BADGE_CLASS;
  badge.textContent = emoji;
  badge.setAttribute('aria-label', emoji);
  badge.setAttribute('aria-hidden', 'false');
  avatarEl.style.position = 'relative';
  avatarEl.appendChild(badge);
}

export function removeBadge(avatarEl) {
  if (!avatarEl) return;
  const existing = avatarEl.querySelector('.' + BADGE_CLASS);
  if (existing) existing.remove();
}

export function refreshAllBadges() {
  document.querySelectorAll('[data-peer-digest]').forEach(el => {
    const digest = el.dataset.peerDigest;
    const avatarEl = el.querySelector('.avatar') || el.querySelector('.conversation-avatar');
    if (avatarEl && digest) applyAvatarBadge(avatarEl, digest);
  });
}

export { BADGE_CLASS };
