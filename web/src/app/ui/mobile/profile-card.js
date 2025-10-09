import { log } from '../../core/log.js';
import { ensureProfileNickname, saveProfile, normalizeNickname, generateRandomNickname, uploadAvatar, loadAvatarBlob } from '../../features/profile.js';
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
      loaded = await ensureProfileNickname();
    } catch (err) {
      log({ profileInitError: err?.message || err, stack: err?.stack || null });
      throw err;
    }
    sessionStore.profileState = loaded || { nickname: generateRandomNickname(), updatedAt: Math.floor(Date.now() / 1000) };
    sessionStore.profileState.nickname = normalizeNickname(sessionStore.profileState.nickname) || generateRandomNickname();
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
      try { URL.revokeObjectURL(sessionStore.currentAvatarUrl); } catch {}
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
        const next = { ...(sessionStore.profileState || {}), nickname: normalized, updatedAt: Math.floor(Date.now() / 1000) };
        const saved = await saveProfile(next);
        sessionStore.profileState = saved || next;
        sessionStore.profileState.nickname = normalizeNickname(sessionStore.profileState.nickname) || normalized;
        updateProfileNicknameUI();
        updateStats?.();
        log({ profileNicknameUpdated: normalized });
        if (typeof broadcastContactUpdate === 'function') {
          try {
            await broadcastContactUpdate({ reason: 'nickname' });
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
        try { URL.revokeObjectURL(previewUrl); } catch {}
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
        <div class="avatar-preview"><canvas id="avatarPreviewCanvas" width="240" height="240"></canvas></div>
        <div class="avatar-controls">
          <label>縮放
            <input type="range" id="avatarScale" min="100" max="300" value="100" disabled />
          </label>
          <label>水平
            <input type="range" id="avatarOffsetX" min="-100" max="100" value="0" disabled />
          </label>
          <label>垂直
            <input type="range" id="avatarOffsetY" min="-100" max="100" value="0" disabled />
          </label>
        </div>
        <div class="avatar-select"><button type="button" id="avatarChooseBtn">選擇圖片</button></div>
        <input id="avatarFileInput" type="file" accept="image/*" style="display:none" />
        <p class="avatar-hint">建議使用 1024 x 1024 以內的圖片，大小不超過 6MB。</p>
        <div id="avatarStatus" class="avatar-hint" style="text-align:center"></div>
        <div class="avatar-actions">
          <button type="button" id="avatarCancel" class="secondary">取消</button>
          <button type="button" id="avatarSubmit" class="primary" disabled>上傳</button>
        </div>
      </div>`;
    modal.openModal();
    hideShareButton();

    const previewCanvas = body.querySelector('#avatarPreviewCanvas');
    const previewCtx = previewCanvas?.getContext('2d');
    const previewSize = previewCanvas?.width || 240;
    const fileInput = body.querySelector('#avatarFileInput');
    const chooseBtn = body.querySelector('#avatarChooseBtn');
    const cancelBtn = body.querySelector('#avatarCancel');
    const submitBtn = body.querySelector('#avatarSubmit');
    const statusEl = body.querySelector('#avatarStatus');
    const scaleInput = body.querySelector('#avatarScale');
    const offsetXInput = body.querySelector('#avatarOffsetX');
    const offsetYInput = body.querySelector('#avatarOffsetY');
    let cropState = null;
    let tempObjectURL = null;
    const fallbackImg = new Image();
    fallbackImg.onload = () => renderPreview();
    fallbackImg.src = currentSrc;

    modalElement.__avatarCleanup = () => {
      cleanupTempURL();
      cropState = null;
    };

    const cleanupTempURL = () => {
      if (tempObjectURL) {
        try { URL.revokeObjectURL(tempObjectURL); } catch {}
        tempObjectURL = null;
      }
    };

    const enableControls = (enabled) => {
      [scaleInput, offsetXInput, offsetYInput].forEach((input) => {
        if (!input) return;
        if (enabled) input.removeAttribute('disabled');
        else input.setAttribute('disabled', 'disabled');
      });
    };

    const renderPreview = () => {
      if (!previewCtx) return;
      if (cropState?.image) {
        drawAvatarCrop(previewCtx, previewSize, cropState);
      } else if (fallbackImg.complete) {
        drawAvatarCrop(previewCtx, previewSize, { image: fallbackImg, scale: 1, offsetX: 0, offsetY: 0 });
      } else {
        previewCtx.fillStyle = '#e2e8f0';
        previewCtx.fillRect(0, 0, previewSize, previewSize);
      }
    };

    const updateCropFromInputs = () => {
      if (!cropState) return;
      cropState.scale = Number(scaleInput?.value || '100') / 100;
      cropState.offsetX = Number(offsetXInput?.value || '0');
      cropState.offsetY = Number(offsetYInput?.value || '0');
      renderPreview();
    };

    scaleInput?.addEventListener('input', updateCropFromInputs);
    offsetXInput?.addEventListener('input', updateCropFromInputs);
    offsetYInput?.addEventListener('input', updateCropFromInputs);

    enableControls(false);
    renderPreview();

    chooseBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', () => {
      cleanupTempURL();
      const file = fileInput.files?.[0] || null;
      if (!file) {
        submitBtn?.setAttribute('disabled', 'disabled');
        if (statusEl) statusEl.textContent = '';
        cropState = null;
        enableControls(false);
        renderPreview();
        return;
      }
      if (!file.type.startsWith('image/')) {
        if (statusEl) statusEl.textContent = '僅支援圖片格式。';
        submitBtn?.setAttribute('disabled', 'disabled');
        return;
      }
      if (statusEl) statusEl.textContent = '正在準備圖片…';
      loadAndResizeImage(file, { maxSize: 2048 })
        .then(({ image }) => {
          cropState = {
            image,
            scale: 1,
            offsetX: 0,
            offsetY: 0
          };
          enableControls(true);
          renderPreview();
          if (scaleInput) scaleInput.value = '100';
          if (offsetXInput) offsetXInput.value = '0';
          if (offsetYInput) offsetYInput.value = '0';
          if (statusEl) statusEl.textContent = '';
          submitBtn?.removeAttribute('disabled');
        })
        .catch((err) => {
          cropState = null;
          enableControls(false);
          renderPreview();
          submitBtn?.setAttribute('disabled', 'disabled');
          if (statusEl) statusEl.textContent = `圖片讀取失敗：${err?.message || err}`;
        });
    });

    cancelBtn?.addEventListener('click', () => {
      cleanupTempURL();
      modal.closeModal();
      restoreShareButton();
    }, { once: true });

    submitBtn?.addEventListener('click', async () => {
      if (!cropState?.image) {
        if (statusEl) statusEl.textContent = '請先選擇並裁切圖片。';
        return;
      }
      submitBtn.setAttribute('disabled', 'disabled');
      chooseBtn?.setAttribute('disabled', 'disabled');
      if (statusEl) statusEl.textContent = '上傳中… 0%';
      try {
        const { blob: uploadBlob, thumbDataUrl } = await buildAvatarOutputBlob(cropState, 512);
        const file = new File([uploadBlob], 'avatar.jpg', { type: uploadBlob.type || 'image/jpeg' });
        const avatarMeta = await uploadAvatar({
          file,
          thumbDataUrl,
          onProgress: (p) => {
            if (!statusEl) return;
            const percent = p?.percent ?? Math.round((p.loaded / (p.total || file.size || 1)) * 100);
            statusEl.textContent = `上傳中… ${percent}%`;
          }
        });
        const next = {
          ...(sessionStore.profileState || {}),
          avatar: avatarMeta,
          nickname: sessionStore.profileState?.nickname || generateRandomNickname(),
          updatedAt: Math.floor(Date.now() / 1000)
        };
        const saved = await saveProfile(next);
        sessionStore.profileState = saved || next;
        const sanitizedNick = normalizeNickname(sessionStore.profileState.nickname);
        sessionStore.profileState.nickname = sanitizedNick || sessionStore.profileState.nickname || generateRandomNickname();
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
        if (statusEl) statusEl.textContent = `上傳失敗：${err?.message || err}`;
        submitBtn.removeAttribute('disabled');
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

  async function buildLocalContactPayload() {
    const nickname = sessionStore.profileState?.nickname || '';
    let avatar = null;
    if (sessionStore.profileState?.avatar) {
      avatar = await ensureAvatarThumbnail();
      if (avatar) avatar = { ...avatar };
    }
    return {
      nickname: nickname || generateRandomNickname(),
      avatar,
      addedAt: Math.floor(Date.now() / 1000)
    };
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

  async function buildAvatarOutputBlob(state, canvasSize) {
    if (!state?.image) throw new Error('缺少裁切資料');
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = canvasSize;
    finalCanvas.height = canvasSize;
    const finalCtx = finalCanvas.getContext('2d');
    drawAvatarCrop(finalCtx, canvasSize, state);
    const thumbDataUrl = finalCanvas.toDataURL('image/jpeg', 0.85);
    const blob = await new Promise((resolve, reject) => {
      finalCanvas.toBlob((b) => {
        if (!b) reject(new Error('裁切失敗，請重試'));
        else resolve(b);
      }, 'image/jpeg', 0.85);
    });
    return { blob, thumbDataUrl };
  }

  function drawAvatarCrop(ctx, size, state) {
    if (!ctx) return;
    ctx.fillStyle = '#e2e8f0';
    ctx.fillRect(0, 0, size, size);
    const img = state?.image;
    if (!img) return;
    const scale = state.scale ?? 1;
    const offsetX = state.offsetX ?? 0;
    const offsetY = state.offsetY ?? 0;
    const baseScale = Math.max(size / img.width, size / img.height);
    const drawScale = baseScale * scale;
    const drawWidth = img.width * drawScale;
    const drawHeight = img.height * drawScale;
    const maxOffsetX = Math.max(0, drawWidth - size);
    const maxOffsetY = Math.max(0, drawHeight - size);
    const offsetXPx = (offsetX / 100) * (maxOffsetX / 2);
    const offsetYPx = (offsetY / 100) * (maxOffsetY / 2);
    const dx = (size - drawWidth) / 2 - offsetXPx;
    const dy = (size - drawHeight) / 2 - offsetYPx;
    ctx.drawImage(img, dx, dy, drawWidth, drawHeight);
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
