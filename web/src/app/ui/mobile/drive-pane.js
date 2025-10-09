import { log } from '../../core/log.js';
import { getAccountDigest } from '../../core/store.js';
import { listMessages } from '../../api/messages.js';
import { encryptAndPutWithProgress, deleteEncryptedObjects, downloadAndDecrypt, loadEnvelopeMeta } from '../../features/media.js';
import { sessionStore } from './session-store.js';
import { escapeHtml, fmtSize, safeJSON } from './ui-utils.js';

export function initDrivePane({
  dom = {},
  modal = {},
  swipe = {},
  updateStats
}) {
  const driveListEl = dom.driveList ?? document.getElementById('driveList');
  const crumbEl = dom.crumbEl ?? document.getElementById('driveCrumb');
  const btnUploadOpen = dom.btnUploadOpen ?? document.getElementById('btnUploadOpen');
  const btnNewFolder = dom.btnNewFolder ?? document.getElementById('btnNewFolder');
  const btnUp = dom.btnUp ?? document.getElementById('btnUp');

  const {
    openModal,
    closeModal,
    showConfirmModal,
    showModalLoading,
    updateLoadingModal,
    showProgressModal,
    updateProgressModal,
    completeProgressModal,
    failProgressModal,
    setModalObjectUrl
  } = modal;

  const { setupSwipe, closeSwipe, closeOpenSwipe } = swipe;

  const driveState = sessionStore.driveState;

  function cwdPath() {
    return driveState.cwd.join('/');
  }

  function renderCrumb() {
    if (!crumbEl) return;
    const parts = [{ name: '根目錄', path: '' }, ...driveState.cwd.map((seg, idx) => ({ name: seg, path: driveState.cwd.slice(0, idx + 1).join('/') }))];
    crumbEl.innerHTML = '';
    parts.forEach((p, i) => {
      const isLast = i === parts.length - 1;
      const node = document.createElement(isLast ? 'span' : 'button');
      node.textContent = p.name;
      node.className = isLast ? 'crumb-current' : 'crumb-link';
      if (!isLast) {
        node.type = 'button';
        node.addEventListener('click', (e) => {
          e.preventDefault();
          driveState.cwd = p.path ? p.path.split('/') : [];
          refreshDriveList().catch(() => {});
        });
      }
      crumbEl.appendChild(node);
      if (!isLast || i === 0) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '/';
        crumbEl.appendChild(sep);
      }
    });
  }

  function sanitizeFolderName(raw) {
    if (raw === undefined || raw === null) return '';
    const cleaned = String(raw)
      .replace(/[\u0000-\u001F\u007F]/gu, '')
      .replace(/[\\/]/g, '')
      .replace(/\s+/gu, ' ')
      .trim();
    if (!cleaned || cleaned === '.' || cleaned === '..') return '';
    return cleaned.slice(0, 96);
  }

  function getDirSegmentsFromHeader(header) {
    if (!header) return [];
    const dir = header.dir;
    if (Array.isArray(dir)) {
      return dir.map((seg) => String(seg || '').trim()).filter(Boolean);
    }
    if (typeof dir === 'string') {
      return String(dir)
        .split('/')
        .map((seg) => String(seg || '').trim())
        .filter(Boolean);
    }
    return [];
  }

  function pathStartsWith(pathSegments, prefixSegments) {
    if (prefixSegments.length > pathSegments.length) return false;
    for (let i = 0; i < prefixSegments.length; i += 1) {
      if (pathSegments[i] !== prefixSegments[i]) return false;
    }
    return true;
  }

  async function refreshDriveList() {
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = `drive-${acct}`;
    const { r, data } = await listMessages({ convId, limit: 50 });
    if (!r.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
    const items = Array.isArray(data?.items) ? data.items : [];
    driveState.currentMessages = items;
    driveState.currentConvId = convId;
    renderDriveList(items, convId);
    updateStats?.();
  }

  function renderDriveList(items, convId) {
    if (!driveListEl) return;
    closeOpenSwipe?.();
    renderCrumb();
    driveListEl.innerHTML = '';
    if (btnUp) btnUp.style.display = driveState.cwd.length ? 'inline-flex' : 'none';
    const folderSet = new Map();
    const files = [];
    const prefix = convId + '/' + (cwdPath() ? cwdPath() + '/' : '');
    const currentPath = [...driveState.cwd];
    for (const it of items) {
      const header = safeJSON(it.header_json || it.header || '{}');
      const dirSegments = getDirSegmentsFromHeader(header);
      const objKey = typeof it?.obj_key === 'string' && it.obj_key ? it.obj_key : (typeof header?.obj === 'string' ? header.obj : '');
      if (dirSegments.length) {
        if (!pathStartsWith(dirSegments, currentPath)) continue;
        if (dirSegments.length > currentPath.length) {
          const next = dirSegments[currentPath.length];
          if (next) folderSet.set(next, (folderSet.get(next) || 0) + 1);
          continue;
        }
        files.push({ header, ts: it.ts, obj_key: objKey });
        continue;
      }
      if (!objKey || !objKey.startsWith(prefix)) continue;
      const rel = objKey.slice(prefix.length);
      if (rel.includes('/')) {
        const first = rel.split('/')[0];
        folderSet.set(first, (folderSet.get(first) || 0) + 1);
      } else {
        files.push({ header, ts: it.ts, obj_key: objKey });
      }
    }
    const folders = Array.from(folderSet.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, count] of folders) {
      const li = document.createElement('li');
      li.className = 'file-item folder';
      li.dataset.type = 'folder';
      li.dataset.folderName = name;
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.innerHTML = `
        <div class="item-content">
          <div class="meta">
            <div class="name"><i class='bx bx-folder' aria-hidden="true"></i><span class="label">${escapeHtml(name)}</span></div>
            <div class="sub">${count} 項</div>
          </div>
        </div>
        <button type="button" class="item-delete" aria-label="刪除"><i class='bx bx-trash'></i></button>`;
      const open = () => {
        if (li.classList.contains('show-delete')) {
          closeSwipe?.(li);
          return;
        }
        closeOpenSwipe?.();
        driveState.cwd.push(name);
        refreshDriveList().catch(() => {});
      };
      li.addEventListener('click', (e) => {
        if (e.target.closest('.item-delete')) return;
        if (li.classList.contains('show-delete')) { closeSwipe?.(li); return; }
        e.preventDefault();
        open();
      });
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
        if (e.key === 'Delete') { handleItemDelete({ type: 'folder', name, element: li }); }
      });
      li.querySelector('.item-delete')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleItemDelete({ type: 'folder', name, element: li });
      });
      li.querySelector('.label')?.setAttribute('title', name);
      setupSwipe?.(li);
      driveListEl.appendChild(li);
    }
    for (const f of files) {
      const key = f.obj_key || f.header?.obj || '';
      const name = f.header?.name || key.split('/').pop() || 'file.bin';
      const size = f.header?.size || 0;
      const ct = f.header?.contentType || 'application/octet-stream';
      const ts = f.ts ? new Date(f.ts * 1000).toLocaleString() : '';
      const iconClass = fileIconForName(name, ct);
      const li = document.createElement('li');
      li.className = 'file-item file';
      li.dataset.type = 'file';
      li.dataset.key = key || '';
      li.dataset.name = name;
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      li.innerHTML = `
        <div class="item-content">
          <div class="meta">
            <div class="name"><i class='${iconClass}' aria-hidden="true"></i><span class="label">${escapeHtml(name)}</span></div>
            <div class="sub">${fmtSize(size)} · ${escapeHtml(ct)} · ${escapeHtml(ts)}</div>
          </div>
        </div>
        <button type="button" class="item-delete" aria-label="刪除"><i class='bx bx-trash'></i></button>`;
      const preview = () => {
        if (li.classList.contains('show-delete')) {
          closeSwipe?.(li);
          return;
        }
        closeOpenSwipe?.();
        doPreview(key, ct, name).catch((err) => {
          closeModal?.();
          log({ previewError: String(err?.message || err) });
        });
      };
      li.addEventListener('click', (e) => {
        if (e.target.closest('.item-delete')) return;
        if (li.classList.contains('show-delete')) { closeSwipe?.(li); return; }
        e.preventDefault();
        preview();
      });
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); preview(); }
        if (e.key === 'Delete') { handleItemDelete({ type: 'file', key, name, element: li }); }
      });
      li.querySelector('.item-delete')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleItemDelete({ type: 'file', key, name, element: li });
      });
      li.querySelector('.label')?.setAttribute('title', name);
      setupSwipe?.(li);
      driveListEl.appendChild(li);
    }
    if (!folders.length && !files.length) {
      driveListEl.innerHTML = '<li class="empty">（此資料夾沒有內容）</li>';
    }
  }

  function fileIconForName(name, contentType) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    const ct = String(contentType || '').toLowerCase();
    if (ct.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(ext)) return 'bx bx-image';
    if (ct.startsWith('video/') || ['mp4','mov','m4v','webm','avi','mkv'].includes(ext)) return 'bx bx-video';
    if (ct.startsWith('audio/') || ['mp3','wav','m4a','aac','flac','ogg'].includes(ext)) return 'bx bx-music';
    if (ext === 'pdf') return 'bx bxs-file-pdf';
    if (['doc','docx','rtf','odt','pages'].includes(ext)) return 'bx bx-file';
    if (['xls','xlsx','csv','ods','numbers'].includes(ext)) return 'bx bx-spreadsheet';
    if (['ppt','pptx','odp','key'].includes(ext)) return 'bx bx-slideshow';
    if (['zip','rar','7z','gz','tar','tgz','bz2'].includes(ext)) return 'bx bx-archive';
    if (['txt','md','log','json','xml','yml','yaml'].includes(ext) || ct.startsWith('text/')) return 'bx bx-file';
    return 'bx bx-file';
  }

  function openUploadModal() {
    const modalEl = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalEl || !body) return;
    modalEl.classList.remove('security-modal', 'progress-modal', 'folder-modal', 'nickname-modal');
    modalEl.classList.add('upload-modal');
    if (title) title.textContent = '上傳檔案';
    body.innerHTML = `
      <form id="uploadForm" class="upload-form">
        <div class="upload-field">
          <input id="uploadFileInput" type="file" class="upload-input" />
          <label for="uploadFileInput" class="upload-callout">
            <i class='bx bx-cloud-upload'></i>
            <span>點擊選擇檔案</span>
          </label>
        </div>
        <div id="uploadFileName" class="upload-name">尚未選擇檔案</div>
        <p class="upload-hint">支援 iOS Safari：會開啟照片、檔案選擇器。</p>
        <p class="upload-error" role="alert"></p>
        <div class="upload-actions">
          <button type="button" id="uploadCancel" class="secondary">取消</button>
          <button type="submit" class="primary">上傳</button>
        </div>
      </form>`;
    openModal?.();
    const input = body.querySelector('#uploadFileInput');
    const nameEl = body.querySelector('#uploadFileName');
    const errorEl = body.querySelector('.upload-error');
    const cancelBtn = body.querySelector('#uploadCancel');
    const form = body.querySelector('#uploadForm');
    cancelBtn?.addEventListener('click', () => closeModal?.(), { once: true });
    input?.addEventListener('change', () => {
      if (nameEl) nameEl.textContent = input?.files?.[0]?.name || '尚未選擇檔案';
      if (errorEl) errorEl.textContent = '';
    });
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const file = input?.files?.[0];
      if (!file) {
        if (errorEl) errorEl.textContent = '請先選擇要上傳的檔案。';
        return;
      }
      closeModal?.();
      await startUpload(file);
    }, { once: true });
  }

  function openFolderModal() {
    const modalEl = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalEl || !body) return;
    modalEl.classList.remove('security-modal', 'progress-modal', 'upload-modal', 'nickname-modal');
    modalEl.classList.add('folder-modal');
    if (title) title.textContent = '新增資料夾';
    body.innerHTML = `
      <form id="folderForm" class="folder-form">
        <label for="folderNameInput">資料夾名稱</label>
        <input id="folderNameInput" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="例如：旅行紀錄 ✈️" />
        <p class="folder-hint">可輸入中文或 emoji，僅禁止使用 / 等分隔符號。</p>
        <p class="folder-error" role="alert"></p>
        <div class="folder-actions">
          <button type="button" id="folderCancel" class="secondary">取消</button>
          <button type="submit" class="primary">建立</button>
        </div>
      </form>`;
    openModal?.();
    const input = body.querySelector('#folderNameInput');
    const form = body.querySelector('#folderForm');
    const cancelBtn = body.querySelector('#folderCancel');
    const errorEl = body.querySelector('.folder-error');
    setTimeout(() => input?.focus(), 40);
    cancelBtn?.addEventListener('click', () => closeModal?.(), { once: true });
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const safeName = sanitizeFolderName(input?.value || '');
      if (!safeName) {
        if (errorEl) errorEl.textContent = '資料夾名稱不可為空，且不可包含 / 或控制字元。';
        input?.focus();
        input?.select?.();
        return;
      }
      if (input) input.value = safeName;
      if (errorEl) errorEl.textContent = '';
      driveState.cwd.push(safeName);
      closeModal?.();
      try {
        await refreshDriveList();
      } catch (err) {
        log({ driveListError: String(err?.message || err) });
      }
    });
  }

  async function startUpload(file) {
    if (!file) return;
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) {
      alert('尚未登入，請重新登入後再試。');
      return;
    }
    const convId = driveState.currentConvId || `drive-${acct}`;
    showProgressModal?.(file.name || '檔案');
    try {
      await encryptAndPutWithProgress({
        convId,
        file,
        dir: [...driveState.cwd],
        onProgress: (p) => updateProgressModal?.(p)
      });
      completeProgressModal?.();
      await refreshDriveList();
    } catch (err) {
      log({ driveUploadError: err?.message || err });
      failProgressModal?.(err?.message || String(err));
    }
  }

  async function doPreview(key, contentTypeHint, nameHint) {
    showModalLoading?.('下載加密檔案中…');
    try {
      const { blob, contentType, name } = await downloadAndDecrypt({
        key,
        onProgress: ({ stage, loaded, total }) => {
          if (stage === 'sign') {
            updateLoadingModal?.({ percent: 5, text: '取得下載授權中…' });
          } else if (stage === 'download-start') {
            updateLoadingModal?.({ percent: 10, text: '下載加密檔案中…' });
          } else if (stage === 'download') {
            const pct = total && total > 0 ? Math.round((loaded / total) * 100) : null;
            const percent = pct != null ? Math.min(95, Math.max(15, pct)) : 45;
            const text = pct != null
              ? `下載加密檔案中… ${pct}% (${fmtSize(loaded)} / ${fmtSize(total)})`
              : `下載加密檔案中… (${fmtSize(loaded)})`;
            updateLoadingModal?.({ percent, text });
          } else if (stage === 'decrypt') {
            updateLoadingModal?.({ percent: 98, text: '解密檔案中…' });
          }
        }
      });

      const ct = contentType || contentTypeHint || 'application/octet-stream';
      const resolvedName = name || nameHint || key.split('/').pop() || 'download.bin';
      const body = document.getElementById('modalBody');
      const title = document.getElementById('modalTitle');
      if (!body || !title) {
        closeModal?.();
        return;
      }

      body.innerHTML = '';
      title.textContent = resolvedName;
      title.setAttribute('title', resolvedName);

      const downloadBtn = document.getElementById('modalDownload');
      if (downloadBtn) {
        downloadBtn.style.display = 'inline-flex';
        downloadBtn.onclick = () => onDownloadByKey(key, resolvedName);
      }

      const url = URL.createObjectURL(blob);
      setModalObjectUrl?.(url);

      const container = document.createElement('div');
      container.className = 'preview-wrap';
      const wrap = document.createElement('div');
      wrap.className = 'viewer';
      container.appendChild(wrap);
      body.appendChild(container);

      if (ct.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = resolvedName;
        wrap.appendChild(img);
      } else if (ct.startsWith('video/')) {
        const video = document.createElement('video');
        video.src = url;
        video.controls = true;
        video.playsInline = true;
        wrap.appendChild(video);
      } else if (ct.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.src = url;
        audio.controls = true;
        wrap.appendChild(audio);
      } else if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.className = 'viewer';
        iframe.title = resolvedName;
        wrap.appendChild(iframe);
      } else if (ct.startsWith('text/')) {
        try {
          const textContent = await blob.text();
          const pre = document.createElement('pre');
          pre.textContent = textContent;
          wrap.appendChild(pre);
        } catch (err) {
          const msg = document.createElement('div');
          msg.className = 'preview-message';
          msg.textContent = '無法顯示文字內容。';
          wrap.appendChild(msg);
        }
      } else {
        const message = document.createElement('div');
        message.style.textAlign = 'center';
        message.innerHTML = `無法預覽此類型（${escapeHtml(ct)}）。<br/><br/>`;
        const link = document.createElement('a');
        link.href = url;
        link.download = resolvedName;
        link.textContent = '下載檔案';
        link.className = 'primary';
        message.appendChild(link);
        wrap.appendChild(message);
      }

      openModal?.();
    } catch (err) {
      closeModal?.();
      throw err;
    }
  }

  async function handleItemDelete({ type, key, name, element }) {
    if (!driveState.currentConvId) return;

    if (type === 'file') {
      if (!key) return;
      const matches = driveState.currentMessages
        .filter((msg) => {
          const direct = typeof msg?.obj_key === 'string' ? msg.obj_key : '';
          if (direct && direct === key) return true;
          const header = safeJSON(msg?.header_json || msg?.header || '{}');
          return typeof header?.obj === 'string' && header.obj === key;
        });
      const ids = matches.map((msg) => String(msg?.id || '')).filter(Boolean);

      if (element) closeSwipe?.(element);
      showConfirmModal?.({
        title: '確認刪除',
        message: `確定刪除「${escapeHtml(name || key)}」？`,
        confirmLabel: '刪除',
        onConfirm: async () => {
          try {
            await performDelete({ keys: [key], ids });
            await refreshDriveList();
          } catch (err) {
            log({ deleteError: String(err?.message || err) });
          }
        },
        onCancel: () => { if (element) closeSwipe?.(element); }
      });
      return;
    }

    const folderName = String(name || '').trim();
    if (!folderName) return;
    const rel = cwdPath();
    const folderRel = rel ? `${rel}/${folderName}` : folderName;
    const prefix = `${driveState.currentConvId}/${folderRel}`;
    const targetMessages = driveState.currentMessages
      .map((it) => {
        const direct = typeof it?.obj_key === 'string' ? it.obj_key : '';
        if (direct) return direct;
        const header = safeJSON(it?.header_json || it?.header || '{}');
        return typeof header?.obj === 'string' ? header.obj : '';
      })
      .map((objKey, idx) => ({ objKey, id: String(driveState.currentMessages[idx]?.id || '') }))
      .filter(({ objKey }) => objKey && objKey.startsWith(`${prefix}/`));

    if (!targetMessages.length) {
      log({ deleteInfo: `資料夾「${folderName}」內沒有檔案` });
      return;
    }

    const keys = Array.from(new Set(targetMessages.map((m) => m.objKey)));
    const ids = Array.from(new Set(targetMessages.map((m) => m.id).filter(Boolean)));

    if (element) closeSwipe?.(element);
    showConfirmModal?.({
      title: '確認刪除',
      message: `刪除資料夾「${escapeHtml(folderName)}」及其 ${keys.length} 個檔案？`,
      confirmLabel: '刪除',
      onConfirm: async () => {
        try {
          await performDelete({ keys, ids });
          await refreshDriveList();
        } catch (err) {
          log({ deleteError: String(err?.message || err) });
        }
      },
      onCancel: () => { if (element) closeSwipe?.(element); }
    });
  }

  async function performDelete({ keys = [], ids = [] }) {
    if (!keys.length && !ids.length) return;
    const { deleted, failed } = await deleteEncryptedObjects({ keys, ids });
    log({ driveDeleteResult: { keys, ids, deleted, failed } });
    if (deleted?.length) log({ deleted });
    if (failed?.length) log({ deleteFailed: failed });
  }

  async function onDownloadByKey(key, nameHint) {
    try {
      const meta = await getEnvelopeForKey(key);
      const outObj = await downloadAndDecrypt({ key, envelope: meta });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(outObj.blob);
      a.download = outObj.name || nameHint || 'download.bin';
      document.body.appendChild(a);
      a.click();
      URL.revokeObjectURL(a.href);
      a.remove();
      log({ downloaded: { bytes: outObj.bytes, name: outObj.name, type: outObj.contentType } });
    } catch (err) { log({ downloadError: String(err?.message || err) }); }
  }

  async function getEnvelopeForKey(key) {
    const local = loadEnvelopeMeta(key);
    if (local && local.iv_b64 && local.hkdf_salt_b64) return local;
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = `drive-${acct}`;
    const { r, data } = await listMessages({ convId, limit: 100 });
    if (!r.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
    const arr = Array.isArray(data?.items) ? data.items : [];
    for (const it of arr) {
      const header = safeJSON(it.header_json || it.header || '{}');
      if (header && header.obj === key && header.env && header.env.iv_b64 && header.env.hkdf_salt_b64) {
        return {
          iv_b64: header.env.iv_b64,
          hkdf_salt_b64: header.env.hkdf_salt_b64,
          contentType: header.contentType || 'application/octet-stream',
          name: header.name || 'decrypted.bin'
        };
      }
    }
    throw new Error('找不到封套資料（此物件可能來自尚未更新索引格式的舊版本）');
  }

  function bindDomEvents() {
    btnUploadOpen?.addEventListener('click', openUploadModal);
    btnNewFolder?.addEventListener('click', openFolderModal);
    btnUp?.addEventListener('click', () => {
      if (!driveState.cwd.length) return;
      driveState.cwd.pop();
      refreshDriveList().catch(() => {});
    });
  }

  if (typeof window !== 'undefined') {
    try {
      window.__refreshDrive = async () => {
        try {
          await refreshDriveList();
        } catch (err) {
          log({ driveRefreshError: err?.message || err });
        }
      };
      window.__deleteDriveObject = async (key) => {
        if (!driveState.currentConvId || !key) return false;
        const matches = driveState.currentMessages
          .filter((msg) => {
            const direct = typeof msg?.obj_key === 'string' ? msg.obj_key : '';
            if (direct && direct === key) return true;
            const header = safeJSON(msg?.header_json || msg?.header || '{}');
            return typeof header?.obj === 'string' && header.obj === key;
          });
        const ids = matches.map((msg) => String(msg?.id || '')).filter(Boolean);
        try {
          log({ driveDeleteAttempt: { key, ids, matches: matches.length } });
          await performDelete({ keys: [key], ids });
          await refreshDriveList();
          return true;
        } catch (err) {
          log({ deleteError: String(err?.message || err), key });
          return false;
        }
      };
    } catch {}
  }

  bindDomEvents();
  renderCrumb();

  return {
    refreshDriveList,
    openUploadModal,
    openFolderModal,
    handleItemDelete,
    renderDriveList,
    renderCrumb,
    onDownloadByKey,
    getEnvelopeForKey
  };
}
