// /shared/utils/icon.js
// Lucide icon helper — creates <svg> elements referencing the sprite.
// Usage:
//   import { icon } from '/shared/utils/icon.js';
//   el.innerHTML = icon('user');
//   el.innerHTML = icon('cloud', 'icon-lg icon-anim');

/**
 * Return an SVG icon string referencing the Lucide sprite.
 * @param {string} name - Lucide icon name (e.g. 'user', 'send', 'trash-2')
 * @param {string} [cls] - Additional CSS classes (e.g. 'icon-lg icon-anim')
 * @returns {string} SVG markup string
 */
export function icon(name, cls) {
  const c = cls ? `icon ${cls}` : 'icon';
  return `<svg class="${c}"><use href="#i-${name}"/></svg>`;
}

/**
 * Create an SVG icon DOM element.
 * @param {string} name - Lucide icon name
 * @param {string} [cls] - Additional CSS classes
 * @returns {SVGSVGElement}
 */
export function iconEl(name, cls) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

// Boxicons → Lucide name mapping (for migration convenience)
export const BX_TO_LUCIDE = {
  'bx-user-circle': 'circle-user',
  'bx-message-dots': 'message-circle',
  'bxs-cloud': 'cloud',
  'bx-lock-alt': 'lock',
  'bx-user': 'user',
  'bxl-chrome': 'globe',
  'bx-phone': 'phone',
  'bx-phone-off': 'phone-off',
  'bx-video': 'video',
  'bx-microphone-off': 'mic-off',
  'bx-microphone': 'mic',
  'bx-refresh': 'refresh-cw',
  'bx-face': 'smile',
  'bx-paperclip': 'paperclip',
  'bx-send': 'send',
  'bx-message-detail': 'message-square',
  'bx-group': 'users',
  'bx-user-plus': 'user-plus',
  'bx-qr': 'qr-code',
  'bx-qr-scan': 'scan-line',
  'bx-dialpad': 'grid-3x3',
  'bx-cloud-upload': 'cloud-upload',
  'bx-folder-plus': 'folder-plus',
  'bx-folder': 'folder',
  'bx-trash': 'trash-2',
  'bx-upload': 'upload',
  'bx-image': 'image',
  'bx-music': 'music',
  'bxs-file-pdf': 'file-text',
  'bx-file': 'file',
  'bx-spreadsheet': 'file-spreadsheet',
  'bx-slideshow': 'presentation',
  'bx-archive': 'archive',
  'bx-cog': 'settings',
  'bx-camera': 'camera',
  'bx-pencil': 'pencil',
  'bx-copy': 'copy',
  'bx-search': 'search',
  'bx-chevron-left': 'chevron-left',
  'bx-chevron-down': 'chevron-down',
  'bx-error-circle': 'circle-alert',
  'bx-x': 'x',
  'bx-play': 'play',
  'bx-stop': 'square',
  'bx-log-in': 'log-in',
  'bx-check-shield': 'shield-check',
  'bxs-lock-shield': 'shield',
  'bx-credit-card': 'credit-card',
  'bx-volume-full': 'volume-2',
  'bx-show': 'eye',
  'bx-sync': 'refresh-cw',
};
