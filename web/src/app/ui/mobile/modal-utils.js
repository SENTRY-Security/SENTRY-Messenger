import { escapeHtml, fmtSize } from './ui-utils.js';
import { sessionStore } from './session-store.js';

export function setupModalController({ shareButtonProvider } = {}) {
  const getShareButton = typeof shareButtonProvider === 'function'
    ? shareButtonProvider
    : () => shareButtonProvider || null;

  let currentObjectUrl = null;

  function openModal() {
    const modal = document.getElementById('modal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
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
      'settings-modal'
    );

    if (typeof modal.__avatarCleanup === 'function') {
      try { modal.__avatarCleanup(); } catch (err) { console.warn(err); }
      delete modal.__avatarCleanup;
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

    const downloadBtn = document.getElementById('modalDownload');
    if (downloadBtn) {
      downloadBtn.style.display = 'none';
      downloadBtn.onclick = null;
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
    }

    document.body.classList.remove('modal-open');
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
      'settings-modal'
    );
    modal.classList.add('loading-modal');
    const downloadBtn = document.getElementById('modalDownload');
    if (downloadBtn) {
      downloadBtn.style.display = 'none';
      downloadBtn.onclick = null;
    }
    const title = document.getElementById('modalTitle');
    if (title) title.textContent = '';
    body.innerHTML = `
      <div class="loading-wrap">
        <div class="loading-spinner"></div>
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
      'settings-modal'
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
      'settings-modal'
    );
    modal.classList.add('progress-modal');
    const modalTitle = document.getElementById('modalTitle');
    if (modalTitle) modalTitle.textContent = '';
    body.innerHTML = `
      <div class="progress-wrap">
        <div class="progress-title">上傳中：${escapeHtml(name || '檔案')}</div>
        <div id="progressText" class="progress-text">準備中…</div>
        <div class="progress-bar"><div id="progressInner" class="progress-inner" style="width:0%;"></div></div>
      </div>`;
    openModal();
  }

  function updateProgressModal(progress) {
    const inner = document.getElementById('progressInner');
    const text = document.getElementById('progressText');
    if (inner) inner.style.width = `${Math.min(Math.max(progress.percent || 0, 0), 100)}%`;
    if (text) text.textContent = `${progress.percent || 0}% · ${fmtSize(progress.loaded || 0)} / ${fmtSize(progress.total || 0)}`;
  }

  function completeProgressModal() {
    const text = document.getElementById('progressText');
    const inner = document.getElementById('progressInner');
    if (text) text.textContent = '完成！';
    if (inner) inner.style.width = '100%';
    setTimeout(() => closeModal(), 650);
  }

  function failProgressModal(message) {
    const body = document.getElementById('modalBody');
    if (!body) return;
    body.innerHTML = `
      <div class="progress-wrap">
        <div class="progress-title">上傳失敗</div>
        <div class="progress-text" style="color:#fecaca;">${escapeHtml(message || '未知錯誤')}</div>
      </div>`;
    setTimeout(() => closeModal(), 1600);
  }

  return {
    openModal,
    closeModal,
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
