import { log } from '../../core/log.js';
import Cropper from '../../lib/vendor/cropper.esm.js';
import { loadLatestProfile, saveProfile, normalizeNickname, uploadAvatar, loadAvatarBlob, PROFILE_WRITE_SOURCE } from '../../features/profile.js';
import { sessionStore } from './session-store.js';
import { escapeHtml, blobToDataURL } from './ui-utils.js';

export function initProfileCard(options) {
  const {
    dom,
    modal,
    shareButton,
    updateStats,
    onAvatarUpdate,
    broadcastContactUpdate
  } = options;

  const {
    profileNicknameEl,
    btnProfileNickEdit,
    btnProfileEdit,
    profileAvatarImg
  } = dom;

  if (!profileNicknameEl) throw new Error('profileNicknameEl missing');
  if (!modal || typeof modal.openModal !== 'function' || typeof modal.closeModal !== 'function') {
    throw new Error('modal controller required');
  }

  btnProfileNickEdit?.addEventListener('click', openNicknameModal);
  btnProfileEdit?.addEventListener('click', (e) => {
    e?.stopPropagation?.();
    openAvatarModal();
  });
  profileAvatarImg?.addEventListener('click', () => {
    openAvatarPreview();
  });

  async function loadProfile() {
    let loaded = null;
    try {
      loaded = await loadLatestProfile();
    } catch (err) {
      log({ profileInitError: err?.message || err, stack: err?.stack || null });
      throw err;
    }
    sessionStore.profileState = loaded || { nickname: '', updatedAt: Date.now() };
    if (sessionStore.profileState?.nickname) {
      sessionStore.profileState.nickname = normalizeNickname(sessionStore.profileState.nickname) || sessionStore.profileState.nickname;
    }
    log({ profileLoad: sessionStore.profileState });
    updateProfileNicknameUI();
    await updateProfileAvatarUI();
  }

  function updateProfileNicknameUI() {
    const nick = sessionStore.profileState?.nickname ? normalizeNickname(sessionStore.profileState.nickname) : '';
    profileNicknameEl.textContent = nick || '尚未設定';
  }

  async function updateProfileAvatarUI() {
    if (!profileAvatarImg) return;
    if (sessionStore.currentAvatarUrl) {
      try { URL.revokeObjectURL(sessionStore.currentAvatarUrl); } catch { }
      sessionStore.currentAvatarUrl = null;
    }
    const result = await loadAvatarBlob(sessionStore.profileState).catch((err) => {
      log({ profileAvatarLoadError: err?.message || err });
      return null;
    });
    if (result?.blob) {
      const url = URL.createObjectURL(result.blob);
      sessionStore.currentAvatarUrl = url;
      profileAvatarImg.src = url;
      onAvatarUpdate?.({ src: url, hasCustom: true });
    } else {
      profileAvatarImg.src = '/assets/images/avatar.png';
      onAvatarUpdate?.({ src: '/assets/images/avatar.png', hasCustom: false });
    }
  }

  function hideShareButton() {
    if (!shareButton) return;
    shareButton.dataset.hiddenByModal = '1';
    shareButton.style.visibility = 'hidden';
  }

  function restoreShareButton() {
    if (!shareButton) return;
    if (shareButton.dataset.hiddenByModal === '1') {
      shareButton.style.visibility = '';
      delete shareButton.dataset.hiddenByModal;
    }
  }

  function openNicknameModal() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;
    modalElement.classList.remove('progress-modal', 'folder-modal', 'upload-modal', 'loading-modal', 'confirm-modal', 'nickname-modal');
    modalElement.classList.add('nickname-modal');
    if (title) title.textContent = '編輯暱稱';
    const current = sessionStore.profileState?.nickname || '';
    body.innerHTML = `
      <form id="nicknameForm" class="nickname-form">
        <label for="nicknameInput">新的暱稱</label>
        <input id="nicknameInput" type="text" value="${escapeHtml(current)}" maxlength="48" autocomplete="off" spellcheck="false" />
        <p class="nickname-hint">暱稱僅儲存在加密資料中，伺服器不會看到。僅限文字、數字、空格、-、_、.</p>
        <div class="nickname-actions">
          <button type="button" id="nicknameCancel" class="secondary">取消</button>
          <button type="submit" class="primary">儲存</button>
        </div>
      </form>`;
    modal.openModal();
    hideShareButton();
    const form = body.querySelector('#nicknameForm');
    const input = body.querySelector('#nicknameInput');
    const cancel = body.querySelector('#nicknameCancel');
    const submitBtn = body.querySelector('#nicknameForm button[type="submit"]');

    const setSubmitLoading = (loading) => {
      if (!submitBtn) return;
      if (loading) {
        if (!submitBtn.dataset.originalHtml) submitBtn.dataset.originalHtml = submitBtn.innerHTML;
        submitBtn.disabled = true;
        submitBtn.classList.add('loading');
        submitBtn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span><span class="btn-label">儲存中…</span>';
      } else {
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        if (submitBtn.dataset.originalHtml) {
          submitBtn.innerHTML = submitBtn.dataset.originalHtml;
          delete submitBtn.dataset.originalHtml;
        }
      }
    };
    cancel?.addEventListener('click', () => {
      modal.closeModal();
      restoreShareButton();
    }, { once: true });
    setTimeout(() => input?.focus?.(), 20);
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const raw = input?.value || '';
      const normalized = normalizeNickname(raw);
      if (!normalized || normalized.length < 2) {
        alert('暱稱需至少 2 個字，且只能包含文字、數字、空格或 - _ .');
        input?.focus();
        return;
      }
      if (normalized === (sessionStore.profileState?.nickname || '')) {
        modal.closeModal();
        restoreShareButton();
        return;
      }
      try {
        setSubmitLoading(true);
        const now = Date.now();
        const prevVersion = Number(sessionStore.profileState?.profileVersion) || 0;
        const next = { nickname: normalized, updatedAt: now, profileVersion: prevVersion + 1, sourceTag: PROFILE_WRITE_SOURCE.USER_NICKNAME };
        const saved = await saveProfile(next);
        sessionStore.profileState = { ...(sessionStore.profileState || {}), ...(saved || next) };
        sessionStore.profileState.nickname = normalizeNickname(sessionStore.profileState.nickname) || normalized;
        sessionStore.profileState.profileVersion = next.profileVersion;
        updateProfileNicknameUI();
        updateStats?.();
        log({ profileNicknameUpdated: normalized });
        if (typeof broadcastContactUpdate === 'function') {
          try {
            await broadcastContactUpdate({ reason: 'nickname', overrides: { nickname: normalized } });
          } catch (err) {
            log({ contactBroadcastError: err?.message || err, reason: 'nickname' });
          }
        }
        modal.closeModal();
        restoreShareButton();
      } catch (err) {
        log({ profileNicknameError: err?.message || err });
        alert('更新暱稱失敗，請稍後再試。');
      } finally {
        setSubmitLoading(false);
      }
    }, { once: true });
  }

  async function openAvatarPreview() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;
    modalElement.classList.remove('progress-modal', 'folder-modal', 'upload-modal', 'loading-modal', 'confirm-modal', 'nickname-modal', 'avatar-modal', 'avatar-preview-modal');
    modalElement.classList.add('avatar-modal', 'avatar-preview-modal');
    if (title) title.textContent = '頭像預覽';
    const currentSrc = profileAvatarImg?.src || '/assets/images/avatar.png';
    body.innerHTML = `
      <div class="avatar-upload">
        <div class="avatar-preview"><img id="avatarPreviewImg" src="${escapeHtml(currentSrc)}" alt="頭像預覽" /></div>
        <div class="avatar-actions">
          <button type="button" id="avatarPreviewClose" class="secondary">關閉</button>
          <button type="button" id="avatarPreviewEdit" class="primary">更換頭像</button>
        </div>
      </div>`;
    modal.openModal();
    hideShareButton();
    const closeBtn = body.querySelector('#avatarPreviewClose');
    const editBtn = body.querySelector('#avatarPreviewEdit');
    const previewImg = body.querySelector('#avatarPreviewImg');
    let previewUrl = null;
    const cleanup = () => {
      if (previewUrl) {
        try { URL.revokeObjectURL(previewUrl); } catch { }
        previewUrl = null;
      }
      if (previewImg) delete previewImg.dataset.objectUrl;
    };
    modalElement.__avatarCleanup = cleanup;
    closeBtn?.addEventListener('click', () => {
      cleanup();
      modal.closeModal();
      restoreShareButton();
    }, { once: true });
    editBtn?.addEventListener('click', () => {
      cleanup();
      modal.closeModal();
      restoreShareButton();
      setTimeout(() => openAvatarModal(), 150);
    }, { once: true });

    if (sessionStore.profileState?.avatar?.objKey) {
      try {
        const result = await loadAvatarBlob(sessionStore.profileState);
        if (result?.blob) {
          previewUrl = URL.createObjectURL(result.blob);
          previewImg.src = previewUrl;
          previewImg.dataset.objectUrl = previewUrl;
        }
      } catch (err) {
        log({ profileAvatarPreviewError: err?.message || err });
      }
    }
  }

  function openAvatarModal() {
    const modalElement = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalElement || !body) return;
    modalElement.classList.remove('progress-modal', 'folder-modal', 'upload-modal', 'loading-modal', 'confirm-modal', 'nickname-modal', 'avatar-modal', 'avatar-preview-modal');
    modalElement.classList.add('avatar-modal');
    if (title) title.textContent = '更新頭像';
    const currentSrc = profileAvatarImg?.src || '/assets/images/avatar.png';
    body.innerHTML = `
      <div class="avatar-upload">
        <div class="avatar-cropper">
          <img id="avatarCropImg" src="${escapeHtml(currentSrc)}" alt="頭像裁切" />
        </div>
        <div class="avatar-toolbar">
          <div class="avatar-actions-row">
            <button type="button" id="avatarChooseBtn" class="secondary">選擇圖片</button>
            <button type="button" id="avatarSubmit" class="primary upload-primary" disabled>上傳</button>
          </div>
          <p class="avatar-hint">拖曳或縮放裁切，支援雙指或滑鼠滾輪。</p>
        </div>
        <input id="avatarFileInput" type="file" accept="image/*" style="display:none" />
        <div id="avatarStatus" class="avatar-hint" style="text-align:center"></div>
      </div>`;
    modal.openModal();
    hideShareButton();
    const cropImg = body.querySelector('#avatarCropImg');
    const cropperBox = body.querySelector('.avatar-cropper');
    const fileInput = body.querySelector('#avatarFileInput');
    const chooseBtn = body.querySelector('#avatarChooseBtn');
    const submitBtn = body.querySelector('#avatarSubmit');
    const statusEl = body.querySelector('#avatarStatus');
    let cropper = null;
    let tempObjectURL = null;
    modalElement.__avatarCleanup = () => {
      if (cropper) {
        try { cropper.destroy(); } catch { }
        cropper = null;
      }
      cleanupTempURL();
      if (cropImg) {
        cropImg.onload = null;
        cropImg.onerror = null;
      }
    };

    const cleanupTempURL = () => {
      if (tempObjectURL) {
        try { URL.revokeObjectURL(tempObjectURL); } catch { }
        tempObjectURL = null;
      }
    };

    const setStatus = (text) => {
      if (!statusEl) return;
      statusEl.textContent = text || '';
    };

    const setupCropper = async (src) => {
      if (!cropImg) return;
      if (cropper) {
        try { cropper.destroy(); } catch { }
        cropper = null;
      }
      await new Promise((resolve) => {
        cropImg.onload = () => resolve(true);
        cropImg.onerror = () => resolve(false);
        cropImg.src = src;
        if (cropImg.complete && cropImg.naturalWidth) {
          resolve(true);
        }
      });
      try {
        cropper = new Cropper(cropImg, {
          viewMode: 1,
          aspectRatio: 1,
          dragMode: 'move',
          autoCropArea: 0.92,
          background: false,
          zoomOnWheel: true,
          zoomOnTouch: true,
          responsive: true,
          checkCrossOrigin: false,
          movable: true,
          rotatable: false,
          scalable: false
        });
        if (cropperBox) {
          cropperBox.classList.remove('zoom-hint');
          const ratio = cropImg.naturalWidth && cropImg.naturalHeight
            ? cropImg.naturalWidth / cropImg.naturalHeight
            : 1;
          if (ratio < 0.9) {
            cropperBox.classList.add('zoom-hint');
            setStatus('提示：可雙指或滾輪放大，再拖曳置中。');
            setTimeout(() => cropperBox.classList.remove('zoom-hint'), 3200);
          }
        }
      } catch (err) {
        log({ profileAvatarCropperInitError: err?.message || err });
      }
    };

    setupCropper(currentSrc).then(() => submitBtn?.removeAttribute('disabled'));

    chooseBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', async () => {
      cleanupTempURL();
      const file = fileInput.files?.[0] || null;
      if (!file) {
        submitBtn?.setAttribute('disabled', 'disabled');
        setStatus('');
        return;
      }
      if (!file.type.startsWith('image/')) {
        setStatus('僅支援圖片格式。');
        submitBtn?.setAttribute('disabled', 'disabled');
        return;
      }
      setStatus('正在準備圖片…');
      try {
        const { dataUrl } = await loadAndResizeImage(file, { maxSize: 2048 });
        await setupCropper(dataUrl);
        setStatus('');
        submitBtn?.removeAttribute('disabled');
      } catch (err) {
        submitBtn?.setAttribute('disabled', 'disabled');
        setStatus(`圖片讀取失敗：${err?.message || err}`);
      }
    });

    submitBtn?.addEventListener('click', async () => {
      if (!cropper) {
        setStatus('請先選擇並裁切圖片。');
        return;
      }
      submitBtn?.setAttribute('disabled', 'disabled');
      chooseBtn?.setAttribute('disabled', 'disabled');
      setStatus('上傳中… 0%');
      try {
        const canvas = cropper.getCroppedCanvas({ width: 512, height: 512, imageSmoothingEnabled: true, imageSmoothingQuality: 'high' });
        if (!canvas) throw new Error('裁切失敗，請重試');
        const uploadBlob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error('裁切失敗，請重試'));
          }, 'image/jpeg', 0.9);
        });
        const thumbDataUrl = canvas.toDataURL('image/jpeg', 0.85);
        const file = new File([uploadBlob], 'avatar.jpg', { type: uploadBlob.type || 'image/jpeg' });
        const avatarMeta = await uploadAvatar({
          file,
          thumbDataUrl,
          onProgress: (p) => {
            const percent = p?.percent ?? Math.round((p.loaded / (p.total || file.size || 1)) * 100);
            setStatus(`上傳中… ${percent}%`);
          }
        });
        const prevVersion = Number(sessionStore.profileState?.profileVersion) || 0;
        const next = {
          ...(sessionStore.profileState || {}),
          avatar: avatarMeta,
          nickname: sessionStore.profileState?.nickname || '',
          updatedAt: Date.now(),
          profileVersion: prevVersion + 1,
          sourceTag: PROFILE_WRITE_SOURCE.EXPLICIT
        };
        const saved = await saveProfile(next);
        sessionStore.profileState = saved || next;
        const sanitizedNick = normalizeNickname(sessionStore.profileState.nickname);
        sessionStore.profileState.nickname = sanitizedNick || sessionStore.profileState.nickname || '';
        sessionStore.profileState.profileVersion = next.profileVersion;
        updateProfileNicknameUI();
        await updateProfileAvatarUI();
        updateStats?.();
        log({ profileAvatarUpdated: avatarMeta.objKey });
        if (typeof broadcastContactUpdate === 'function') {
          try {
            await broadcastContactUpdate({ reason: 'avatar' });
          } catch (err) {
            log({ contactBroadcastError: err?.message || err, reason: 'avatar' });
          }
        }
        cleanupTempURL();
        modal.closeModal();
        restoreShareButton();
      } catch (err) {
        log({ profileAvatarUploadError: err?.message || err });
        setStatus(`上傳失敗：${err?.message || err}`);
        submitBtn?.removeAttribute('disabled');
        chooseBtn?.removeAttribute('disabled');
      }
    }, { once: true });
  }

  async function ensureAvatarThumbnail() {
    if (!sessionStore.profileState?.avatar) return null;
    const avatar = { ...sessionStore.profileState.avatar };
    if (avatar.thumbDataUrl) return avatar;
    if (avatar.previewDataUrl) {
      avatar.thumbDataUrl = avatar.previewDataUrl;
    } else if (profileAvatarImg?.src && profileAvatarImg.src.startsWith('data:')) {
      avatar.thumbDataUrl = profileAvatarImg.src;
    } else if (avatar.objKey && avatar.env) {
      try {
        const result = await loadAvatarBlob(sessionStore.profileState);
        if (result?.blob) {
          avatar.thumbDataUrl = await blobToDataURL(result.blob);
        }
      } catch (err) {
        log({ avatarThumbError: err?.message || err });
      }
    }
    if (avatar.thumbDataUrl) {
      sessionStore.profileState.avatar = { ...sessionStore.profileState.avatar, thumbDataUrl: avatar.thumbDataUrl };
    }
    return avatar.thumbDataUrl ? avatar : sessionStore.profileState.avatar;
  }

  async function buildLocalContactPayload({ conversation, drInit } = {}) {
    const nickname = sessionStore.profileState?.nickname || '';
    let avatar = null;
    if (sessionStore.profileState?.avatar) {
      avatar = await ensureAvatarThumbnail();
      if (avatar) avatar = { ...avatar };
    }
    const payload = {
      nickname: nickname || '',
      avatar,
      addedAt: Date.now()
    };
    const convo = conversation && (conversation.tokenB64 || conversation.token_b64) && (conversation.conversationId || conversation.conversation_id)
      ? {
        token_b64: conversation.tokenB64 || conversation.token_b64,
        conversation_id: conversation.conversationId || conversation.conversation_id,
        ...(conversation.dr_init ? { dr_init: conversation.dr_init } : null)
      }
      : null;
    if (!convo && drInit && conversation && (conversation.tokenB64 || conversation.token_b64) && (conversation.conversationId || conversation.conversation_id)) {
      payload.conversation = {
        token_b64: conversation.tokenB64 || conversation.token_b64,
        conversation_id: conversation.conversationId || conversation.conversation_id,
        dr_init: drInit
      };
    } else if (convo) {
      if (drInit && !convo.dr_init) convo.dr_init = drInit;
      payload.conversation = convo;
    }
    return payload;
  }

  async function loadAndResizeImage(file, { maxSize }) {
    const dataUrl = await readFileAsDataURL(file);
    const baseImage = await loadImageElement(dataUrl);
    const canvas = scaleImageToCanvas(baseImage, maxSize);
    const scaledDataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const previewImage = await loadImageElement(scaledDataUrl);
    return { image: previewImage, dataUrl: scaledDataUrl };
  }

  function scaleImageToCanvas(image, maxSize) {
    const { width, height } = image;
    let targetWidth = width;
    let targetHeight = height;
    if (width > maxSize || height > maxSize) {
      const aspect = width / height;
      if (aspect >= 1) {
        targetWidth = maxSize;
        targetHeight = Math.round(maxSize / aspect);
      } else {
        targetHeight = maxSize;
        targetWidth = Math.round(maxSize * aspect);
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    return canvas;
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
      reader.readAsDataURL(file);
    });
  }

  async function loadImageElement(src) {
    const img = new Image();
    const loadPromise = new Promise((resolve, reject) => {
      img.onload = () => resolve(null);
      img.onerror = (err) => reject(err || new Error('圖片載入失敗'));
    });
    img.src = src;
    if (typeof img.decode === 'function') {
      try {
        await img.decode();
        return img;
      } catch (err) {
        // decode 可能在部分環境失敗，改以 onload 事件處理
      }
    }
    if (img.complete && img.naturalWidth && img.naturalHeight) {
      return img;
    }
    await loadPromise;
    return img;
  }

  return {
    loadProfile,
    updateProfileNicknameUI,
    ensureAvatarThumbnail,
    buildLocalContactPayload,
    updateProfileAvatarUI,
    getProfileState: () => sessionStore.profileState
  };
}
