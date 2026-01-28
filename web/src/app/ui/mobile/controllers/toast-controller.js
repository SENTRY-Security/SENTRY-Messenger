import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';

export function createToastController(element) {
  const toastEl = element ?? (typeof document !== 'undefined' ? document.getElementById('appToast') : null);
  let toastTimerId = null;
  let toastClickHandler = null;
  const variantClasses = ['toast-success', 'toast-warning', 'toast-error'];

  const TOAST_VARIANTS = {
    success: {
      className: 'toast-success',
      icon: '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    },
    warning: {
      className: 'toast-warning',
      icon: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 4V8.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M7.99992 11.3332H8.00659" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M8 1.66699L14 13.667H2L8 1.66699Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    },
    error: {
      className: 'toast-error',
      icon: '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5L11.5 11.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M11.5 4.5L4.5 11.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    },
    info: {
      className: '',
      icon: null
    }
  };

  function normalizeOptions(options) {
    if (options && typeof options === 'object') return options;
    return {};
  }

  function applyVariantClass(key) {
    if (!toastEl) return;
    toastEl.classList.remove(...variantClasses);
    const className = TOAST_VARIANTS[key]?.className;
    if (className) {
      toastEl.classList.add(className);
    }
  }

  function hide() {
    if (!toastEl) return;
    toastEl.classList.remove('show');
    toastEl.innerHTML = '';
    toastClickHandler = null;
  }

  function show(message, options) {
    if (!toastEl) return;
    const opts = normalizeOptions(options);
    const {
      duration = 2600,
      onClick,
      avatarUrl,
      avatarInitials,
      subtitle,
      variant = 'info'
    } = opts;
    const text = String(message || '').trim();
    if (!text) {
      hide();
      return;
    }
    toastClickHandler = typeof onClick === 'function' ? onClick : null;
    const variantKey = TOAST_VARIANTS[variant] ? variant : 'info';
    applyVariantClass(variantKey);
    const contentParts = [];
    if (variantKey !== 'info' && TOAST_VARIANTS[variantKey].icon) {
      contentParts.push(`<span class="toast-icon" aria-hidden="true">${TOAST_VARIANTS[variantKey].icon}</span>`);
    } else if (avatarUrl || avatarInitials) {
      const avatarContent = avatarUrl
        ? `<img src="${escapeHtml(avatarUrl)}" alt="avatar" />`
        : escapeHtml((avatarInitials || '').slice(0, 2) || '好友');
      contentParts.push(`<div class="toast-avatar">${avatarContent}</div>`);
    }
    const body = [`<div class="toast-text">${escapeHtml(text)}</div>`];
    if (subtitle) body.push(`<div class="toast-sub">${escapeHtml(String(subtitle))}</div>`);
    contentParts.push(`<div class="toast-body">${body.join('')}</div>`);
    toastEl.innerHTML = `<div class="toast-content">${contentParts.join('')}</div>`;
    toastEl.classList.add('show');
    toastEl.setAttribute('aria-label', text);
    toastEl.setAttribute('tabindex', '0');
    if (toastTimerId) clearTimeout(toastTimerId);
    toastTimerId = setTimeout(() => {
      hide();
      toastTimerId = null;
    }, Math.max(1200, Number(duration) || 0));
  }

  const invokeHandler = () => {
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
  };

  toastEl?.addEventListener('click', invokeHandler);
  toastEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      invokeHandler();
    }
  });

  return { showToast: show, hideToast: hide };
}
