// Gear button + submenu on the conversation header (right side).
// Currently only has "Set Identifier" — designed for future expansion.

import { t } from '/locales/index.js';

const GEAR_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const EMOJI_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>`;

let outsideClickHandler = null;

export function createGearMenu({ onSetIdentifier } = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'conversation-gear-wrapper';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'conversation-gear-btn';
  btn.setAttribute('aria-label', t('emoji.gearLabel'));
  btn.innerHTML = GEAR_SVG;

  const submenu = document.createElement('div');
  submenu.className = 'conversation-gear-submenu hidden';

  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'conversation-gear-submenu-item';
  item.innerHTML = `${EMOJI_ICON}<span>${t('emoji.setIdentifier')}</span>`;
  item.addEventListener('click', () => {
    submenu.classList.add('hidden');
    removeOutsideClick();
    onSetIdentifier?.();
  });
  submenu.appendChild(item);

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = submenu.classList.contains('hidden');
    submenu.classList.toggle('hidden', !isHidden);
    if (isHidden) {
      removeOutsideClick();
      outsideClickHandler = (ev) => {
        if (!wrapper.contains(ev.target)) {
          submenu.classList.add('hidden');
          removeOutsideClick();
        }
      };
      setTimeout(() => {
        document.addEventListener('click', outsideClickHandler);
        document.addEventListener('touchstart', outsideClickHandler);
      }, 0);
    } else {
      removeOutsideClick();
    }
  });

  wrapper.appendChild(btn);
  wrapper.appendChild(submenu);
  return wrapper;
}

function removeOutsideClick() {
  if (outsideClickHandler) {
    document.removeEventListener('click', outsideClickHandler);
    document.removeEventListener('touchstart', outsideClickHandler);
    outsideClickHandler = null;
  }
}
