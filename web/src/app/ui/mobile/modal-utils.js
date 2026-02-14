import { escapeHtml, fmtSize } from './ui-utils.js';
import { sessionStore } from './session-store.js';
import { cleanupImageViewer } from './viewers/image-viewer.js';

export function setupModalController({ shareButtonProvider } = {}) {
  const getShareButton = typeof shareButtonProvider === 'function'
    ? shareButtonProvider
    : () => shareButtonProvider || null;

  let currentObjectUrl = null;
  let bodyScrollLocked = false;
  let bodyScrollY = 0;

  function lockBodyScroll() {
    if (bodyScrollLocked) return;
    const body = document.body;
    bodyScrollY = typeof window !== 'undefined' ? (window.scrollY || document.documentElement?.scrollTop || 0) : 0;
    body.style.position = 'fixed';
    body.style.top = `-${bodyScrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
    bodyScrollLocked = true;
  }

  function unlockBodyScroll() {
    if (!bodyScrollLocked) return;
    const body = document.body;
    body.style.position = '';
    body.style.top = '';
    body.style.left = '';
    body.style.right = '';
    body.style.width = '';
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: bodyScrollY || 0, behavior: 'auto' });
    }
    bodyScrollLocked = false;
  }

  function openModal() {
    const modal = document.getElementById('modal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
    lockBodyScroll();
  }

  function closeModal() {
    const modal = document.getElementById('modal');
    if (!modal) return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.remove(
      'security-modal',
      'progress-modal',
      'folder-modal',
      'upload-modal',
      'loading-modal',
      'confirm-modal',
      'nickname-modal',
      'avatar-modal',
      'avatar-preview-modal',
      'settings-modal',
      'pdf-modal',
      'subscription-modal-shell'
    );
    document.querySelector('.pdf-confirm')?.remove();
    cleanupImageViewer();

    if (typeof modal.__avatarCleanup === 'function') {
      try { modal.__avatarCleanup(); } catch (err) { console.warn(err); }
      delete modal.__avatarCleanup;
    }
    if (typeof modal.__subscriptionCleanup === 'function') {
      try { modal.__subscriptionCleanup(); } catch (err) { console.warn(err); }
      delete modal.__subscriptionCleanup;
    }

    const body = document.getElementById('modalBody');
    if (body) {
      const previewImg = body.querySelector?.('#avatarPreviewImg');
      const dataUrl = previewImg?.dataset?.objectUrl;
      if (dataUrl) {
        try { URL.revokeObjectURL(dataUrl); } catch (err) { console.warn(err); }
      }
      body.innerHTML = '';
    }

    if (currentObjectUrl) {
      try { URL.revokeObjectURL(currentObjectUrl); } catch (err) { console.warn(err); }
      currentObjectUrl = null;
    }
    sessionStore.uiState.currentModalUrl = null;

    const shareBtn = getShareButton();
    if (shareBtn && shareBtn.dataset.hiddenByModal === '1') {
      shareBtn.style.visibility = '';
      delete shareBtn.dataset.hiddenByModal;
    }

    const main = document.querySelector('main.content');
    if (main) {
      main.classList.remove('security-locked');
      main.removeAttribute('aria-hidden');
      try {
        main.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      } catch {
        main.scrollTop = 0;
      }
    }
    document.body.classList.remove('modal-open');
    unlockBodyScroll();
  }

  const modalClose = document.getElementById('modalClose');
  if (modalClose) {
    modalClose.addEventListener('click', () => {
      const modal = document.getElementById('modal');
      if (!modal || modal.classList.contains('security-modal')) return;
      closeModal();
    });
  }

  const modalCloseArea = document.getElementById('modalCloseArea');
  if (modalCloseArea) {
    modalCloseArea.addEventListener('click', () => {
      const modal = document.getElementById('modal');
      if (!modal || modal.classList.contains('security-modal')) return;
      closeModal();
    });
  }

  function showSecurityModal({ title, message, subMessage } = {}) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    if (!modal || !body) return;
    modal.classList.remove(
      'progress-modal',
      'folder-modal',
      'upload-modal',
      'loading-modal',
      'confirm-modal',
      'nickname-modal',
      'avatar-modal',
      'avatar-preview-modal',
      'settings-modal',
      'pdf-modal'
    );
    modal.classList.add('security-modal');
    const modalTitle = document.getElementById('modalTitle');
    if (modalTitle) modalTitle.textContent = title || '建立安全對話';
    const spinner = '<div class="loading-spinner"></div>';
    const primary = escapeHtml(message || '正在建立安全對話，請稍候…');
    const secondary = typeof subMessage === 'string' && subMessage
      ? `<div class="security-hint">${escapeHtml(subMessage)}</div>`
      : '';
    body.innerHTML = `
      <div class="security-message">
        ${spinner}
        <div>${primary}</div>
        ${secondary}
      </div>`;
    const main = document.querySelector('main.content');
    if (main) {
      main.classList.add('security-locked');
      main.setAttribute('aria-hidden', 'true');
    }
    openModal();
  }

  function showModalLoading(text) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    if (!modal || !body) return;
    modal.classList.remove(
      'security-modal',
      'progress-modal',
      'folder-modal',
      'upload-modal',
      'confirm-modal',
      'nickname-modal',
      'avatar-modal',
      'avatar-preview-modal',
      'settings-modal',
      'pdf-modal'
    );
    modal.classList.add('loading-modal');
    const title = document.getElementById('modalTitle');
    if (title) title.textContent = '';
    body.innerHTML = `
      <div class="loading-wrap">
        <div class="progress-bar" style="width:100%;"><div id="loadingBar" class="progress-inner" style="width:0%;"></div></div>
        <div id="loadingText" class="loading-text">${escapeHtml(text || '載入中…')}</div>
      </div>`;
    openModal();
  }

  function updateLoadingModal({ percent, text }) {
    const bar = document.getElementById('loadingBar');
    if (bar && typeof percent === 'number' && Number.isFinite(percent)) {
      bar.style.width = `${Math.min(Math.max(percent, 0), 100)}%`;
    }
    const label = document.getElementById('loadingText');
    if (label && typeof text === 'string' && text) {
      label.textContent = text;
    }
  }

  function showConfirmModal({ title, message, confirmLabel = '確定', onConfirm, onCancel }) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    if (!modal || !body) return;
    modal.classList.remove(
      'security-modal',
      'progress-modal',
      'folder-modal',
      'upload-modal',
      'loading-modal',
      'nickname-modal',
      'avatar-modal',
      'avatar-preview-modal',
      'settings-modal',
      'pdf-modal'
    );
    modal.classList.add('confirm-modal');
    const modalTitle = document.getElementById('modalTitle');
    if (modalTitle) modalTitle.textContent = title || '';
    body.innerHTML = `
      <div class="confirm-wrap">
        <div class="confirm-message">${escapeHtml(message || '')}</div>
        <div class="confirm-actions">
          <button type="button" id="confirmCancel" class="btn-secondary">取消</button>
          <button type="button" id="confirmOk" class="btn-danger">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    openModal();
    const cancelBtn = body.querySelector('#confirmCancel');
    const okBtn = body.querySelector('#confirmOk');
    cancelBtn?.addEventListener('click', () => {
      closeModal();
      onCancel?.();
    }, { once: true });
    okBtn?.addEventListener('click', () => {
      closeModal();
      onConfirm?.();
    }, { once: true });
  }

  const PROGRESS_ICON_UPLOAD = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 19V5m0 0l-5 5m5-5l5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const PROGRESS_ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const PROGRESS_ICON_FAIL = '<svg viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function showProgressModal(name) {
    const modal = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    if (!modal || !body) return;
    modal.classList.remove(
      'security-modal',
      'folder-modal',
      'upload-modal',
      'loading-modal',
      'confirm-modal',
      'nickname-modal',
      'avatar-modal',
      'avatar-preview-modal',
      'settings-modal',
      'pdf-modal'
    );
    modal.classList.add('progress-modal');
    const modalTitle = document.getElementById('modalTitle');
    if (modalTitle) modalTitle.textContent = '';
    body.innerHTML = `
      <div class="progress-wrap">
        <div class="progress-icon progress-icon--uploading">${PROGRESS_ICON_UPLOAD}</div>
        <div class="progress-title">${escapeHtml(name || '檔案')}</div>
        <div class="progress-subtitle">準備上傳…</div>
        <div id="progressPercent" class="progress-percent">0<span>%</span></div>
        <div class="progress-bar"><div id="progressInner" class="progress-inner" style="width:0%;"></div></div>
        <div id="progressText" class="progress-text"></div>
      </div>`;
    openModal();
  }

  function updateProgressModal(progress) {
    const inner = document.getElementById('progressInner');
    const pctEl = document.getElementById('progressPercent');
    const text = document.getElementById('progressText');
    const pct = Math.min(Math.max(progress.percent || 0, 0), 100);
    if (inner) inner.style.width = `${pct}%`;
    if (pctEl) pctEl.innerHTML = `${Math.round(pct)}<span>%</span>`;
    if (text) {
      const loaded = fmtSize(progress.loaded || 0);
      const total = fmtSize(progress.total || 0);
      text.textContent = `${loaded} / ${total}`;
    }
  }

  function completeProgressModal() {
    const body = document.getElementById('modalBody');
    if (!body) return;
    body.innerHTML = `
      <div class="progress-wrap">
        <div class="progress-icon progress-icon--done">${PROGRESS_ICON_CHECK}</div>
        <div class="progress-done-text">上傳完成</div>
      </div>`;
    setTimeout(() => closeModal(), 800);
  }

  function failProgressModal(message) {
    const body = document.getElementById('modalBody');
    if (!body) return;
    body.innerHTML = `
      <div class="progress-wrap">
        <div class="progress-icon progress-icon--fail">${PROGRESS_ICON_FAIL}</div>
        <div class="progress-title">上傳失敗</div>
        <div class="progress-fail-text">${escapeHtml(message || '未知錯誤')}</div>
      </div>`;
    setTimeout(() => closeModal(), 1800);
  }

  return {
    openModal,
    closeModal,
    showSecurityModal,
    showModalLoading,
    updateLoadingModal,
    showConfirmModal,
    showProgressModal,
    updateProgressModal,
    completeProgressModal,
    failProgressModal,
    setModalObjectUrl(url) {
      currentObjectUrl = url;
      sessionStore.uiState.currentModalUrl = url;
    }
  };
}
