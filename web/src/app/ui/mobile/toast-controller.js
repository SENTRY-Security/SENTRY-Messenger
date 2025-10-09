import { log } from '../../core/log.js';
import { escapeHtml } from './ui-utils.js';

export function createToastController(element) {
  const toastEl = element ?? (typeof document !== 'undefined' ? document.getElementById('appToast') : null);
  let toastTimerId = null;
  let toastClickHandler = null;

  function hide() {
    if (!toastEl) return;
    toastEl.classList.remove('show');
    toastEl.innerHTML = '';
    toastClickHandler = null;
  }

  function show(message, { duration = 2600, onClick, avatarUrl, avatarInitials, subtitle } = {}) {
    if (!toastEl) return;
    const text = String(message || '').trim();
    if (!text) {
      hide();
      return;
    }
    toastClickHandler = typeof onClick === 'function' ? onClick : null;
    const parts = [];
    if (avatarUrl || avatarInitials) {
      const avatarContent = avatarUrl
        ? `<img src="${escapeHtml(avatarUrl)}" alt="avatar" />`
        : escapeHtml((avatarInitials || '').slice(0, 2) || '好友');
      parts.push(`<div class="toast-avatar">${avatarContent}</div>`);
    }
    const body = [`<div class="toast-text">${escapeHtml(text)}</div>`];
    if (subtitle) body.push(`<div class="toast-sub">${escapeHtml(String(subtitle))}</div>`);
    parts.push(`<div class="toast-body">${body.join('')}</div>`);
    toastEl.innerHTML = parts.join('');
    toastEl.classList.add('show');
    if (toastTimerId) clearTimeout(toastTimerId);
    toastTimerId = setTimeout(() => {
      hide();
      toastTimerId = null;
    }, Math.max(1200, Number(duration) || 0));
  }

  toastEl?.addEventListener('click', () => {
    hide();
    if (toastTimerId) {
      clearTimeout(toastTimerId);
      toastTimerId = null;
    }
    const handler = toastClickHandler;
    toastClickHandler = null;
    if (typeof handler === 'function') {
      try { handler(); } catch (err) { log({ toastCallbackError: err?.message || err }); }
    }
  });

  return { showToast: show, hideToast: hide };
}
