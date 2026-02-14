import { log } from '../../core/log.js';
import { getAccountDigest, buildAccountPayload } from '../../core/store.js';
import { listMessages, createMessage } from '../../api/messages.js';
import { encryptAndPutWithProgress, deleteEncryptedObjects, downloadAndDecrypt, loadEnvelopeMeta } from '../../features/media.js';
import { sessionStore } from './session-store.js';
import { escapeHtml, fmtSize, safeJSON } from './ui-utils.js';
import { b64 } from '../../crypto/aead.js';
import { openImageViewer } from './viewers/image-viewer.js';

const DEFAULT_DRIVE_QUOTA_BYTES = 3 * 1024 * 1024 * 1024; // 3GB
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500MB per file

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
  const usageValueEl = dom.usageValue ?? document.getElementById('driveUsageValue');
  const usageTotalEl = dom.usageTotal ?? document.getElementById('driveUsageTotal');
  const usagePercentEl = dom.usagePercent ?? document.getElementById('driveUsagePercent');
  const usageNoteEl = null;
  const usageProgressEl = dom.usageProgress ?? document.getElementById('driveUsageProgress');
  const usageBarEl = dom.usageBar ?? document.getElementById('driveUsageBar');
  const driveSectionEl = dom.driveSection ?? document.getElementById('tab-drive');
  const driveUsageEl = dom.driveUsage ?? document.querySelector('#tab-drive .drive-usage');
  const driveCardEl = dom.driveCard ?? document.querySelector('#tab-drive .card');
  const driveRefreshEl = dom.driveRefresh ?? document.getElementById('driveRefreshHint');
  const driveRefreshLabelEl = dom.driveRefreshLabel ?? document.querySelector('#driveRefreshHint .label');
  const driveScrollEl = dom.driveScroll ?? document.getElementById('tab-drive');
  let activePdfCleanup = null;
  let pdfJsLibPromise = null;
  const isSubscriptionActive = () => true; // DEV: 硬解鎖訂閱
  const requireSubscriptionActive = () => {
    if (isSubscriptionActive()) return true;
    document.dispatchEvent(new CustomEvent('subscription:gate'));
    return false;
  };

  function showSubscriptionGateIfExpired() {
    if (!isSubscriptionActive()) {
      document.dispatchEvent(new CustomEvent('subscription:gate'));
    }
  }

  const SYSTEM_DIR_SENT = '__SYS_SENT__';
  const SYSTEM_DIR_RECEIVED = '__SYS_RECV__';
  const SYSTEM_DIR_LABELS = Object.freeze({
    [SYSTEM_DIR_SENT]: '已傳送',
    [SYSTEM_DIR_RECEIVED]: '已接收'
  });
  const RESERVED_DIRS = new Set([SYSTEM_DIR_SENT, SYSTEM_DIR_RECEIVED]);
  const DRIVE_PULL_THRESHOLD = 60;
  const DRIVE_PULL_MAX = 140;
  let drivePullTracking = false;
  let drivePullDecided = false;
  let drivePullInvalid = false;
  let drivePullStartY = 0;
  let drivePullStartX = 0;
  let drivePullDistance = 0;
  let driveRefreshing = false;

  function isReservedDir(name) {
    if (typeof name !== 'string') return false;
    const normalized = name.trim();
    return RESERVED_DIRS.has(normalized);
  }

  function displayFolderName(name) {
    return SYSTEM_DIR_LABELS[name] || name;
  }

  function sanitizePathSegments(input) {
    if (!Array.isArray(input)) return [];
    return input
      .map((seg) => String(seg || '').trim())
      .filter((seg) => !!seg);
  }

  function ensureSafeCwd() {
    const cleaned = sanitizePathSegments(Array.isArray(driveState.cwd) ? driveState.cwd : []);
    const requiresUpdate =
      !Array.isArray(driveState.cwd) ||
      cleaned.length !== driveState.cwd.length ||
      cleaned.some((seg, idx) => seg !== driveState.cwd[idx]);
    if (requiresUpdate) {
      driveState.cwd = [...cleaned];
    }
    return driveState.cwd;
  }

  function sanitizeHeaderDir(segments) {
    if (!Array.isArray(segments)) return [];
    return sanitizePathSegments(segments);
  }

  function applyDrivePullTransition(enable) {
    const transition = enable ? 'transform 120ms ease-out, opacity 120ms ease-out' : 'none';
    if (driveRefreshEl) driveRefreshEl.style.transition = transition;
    if (driveUsageEl) driveUsageEl.style.transition = enable ? 'transform 120ms ease-out' : 'none';
    if (driveCardEl) driveCardEl.style.transition = enable ? 'transform 120ms ease-out' : 'none';
  }

  function updateDrivePull(offset) {
    const clamped = Math.min(DRIVE_PULL_MAX, Math.max(0, offset));
    if (driveRefreshEl) {
      const fadeStart = 5;
      const fadeRange = 25;
      const alpha = Math.min(1, Math.max(0, (clamped - fadeStart) / fadeRange));
      driveRefreshEl.style.opacity = String(alpha);
      const spinner = driveRefreshEl.querySelector('.icon');
      const labelEl = driveRefreshLabelEl || driveRefreshEl.querySelector('.label');
      driveRefreshEl.classList.toggle('ready', clamped >= DRIVE_PULL_THRESHOLD);
      if (spinner && labelEl) {
        if (driveRefreshing) {
          spinner.classList.add('spin');
          labelEl.textContent = '刷新中…';
        } else {
          spinner.classList.remove('spin');
          labelEl.textContent = clamped >= DRIVE_PULL_THRESHOLD ? '鬆開更新檔案' : '下拉更新檔案';
        }
      }
    }
    if (driveUsageEl) driveUsageEl.style.transform = `translateY(${clamped}px)`;
    if (driveCardEl) driveCardEl.style.transform = `translateY(${clamped}px)`;
  }

  function resetDrivePull({ animate = true } = {}) {
    drivePullDistance = 0;
    applyDrivePullTransition(animate);
    updateDrivePull(0);
  }

  async function handleDriveRefresh() {
    if (driveRefreshing) return;
    driveRefreshing = true;
    updateDrivePull(DRIVE_PULL_THRESHOLD);
    try {
      await refreshDriveList();
    } catch (err) {
      log({ drivePullRefreshError: err?.message || err });
    } finally {
      driveRefreshing = false;
      resetDrivePull({ animate: true });
    }
  }

  function handleDrivePullStart(e) {
    if (!driveScrollEl) return;
    if (driveScrollEl.scrollTop > 0) {
      drivePullInvalid = true;
      return;
    }
    drivePullInvalid = false;
    if (e.touches?.length !== 1) return;
    drivePullTracking = true;
    drivePullDecided = false;
    drivePullStartY = e.touches[0].clientY;
    drivePullStartX = e.touches[0].clientX;
    drivePullDistance = 0;
    applyDrivePullTransition(false);
  }

  function handleDrivePullMove(e) {
    if (!drivePullTracking || drivePullInvalid || driveRefreshing) return;
    if (e.touches?.length !== 1) return;
    const dy = e.touches[0].clientY - drivePullStartY;
    const dx = Math.abs(e.touches[0].clientX - drivePullStartX);
    if (!drivePullDecided) {
      if (Math.abs(dy) < 8 && dx < 8) return;
      drivePullDecided = true;
      if (dy <= 0 || dy < Math.abs(dx)) {
        drivePullTracking = false;
        drivePullInvalid = true;
        resetDrivePull({ animate: true });
        return;
      }
    }
    drivePullDistance = dy;
    if (drivePullDistance > 0) {
      e.preventDefault();
      updateDrivePull(drivePullDistance);
    }
  }

  function handleDrivePullEnd() {
    if (!drivePullTracking) return;
    drivePullTracking = false;
    if (driveRefreshing) return;
    if (drivePullDistance >= DRIVE_PULL_THRESHOLD && !drivePullInvalid) {
      handleDriveRefresh();
    } else {
      resetDrivePull({ animate: true });
    }
  }

  function setupDrivePullToRefresh() {
    if (!driveScrollEl || !driveRefreshEl) return;
    driveScrollEl.style.webkitOverflowScrolling = 'touch';
    driveScrollEl.addEventListener('touchstart', handleDrivePullStart, { passive: true });
    driveScrollEl.addEventListener('touchmove', handleDrivePullMove, { passive: false });
    driveScrollEl.addEventListener('touchend', handleDrivePullEnd, { passive: true });
    driveScrollEl.addEventListener('touchcancel', handleDrivePullEnd, { passive: true });
    resetDrivePull({ animate: false });
  }

  function updateDriveActionAvailability() {
    const active = isSubscriptionActive();
    const controls = [btnUploadOpen, btnNewFolder];
    for (const btn of controls) {
      if (!btn) continue;
      btn.disabled = false; // 允許點擊觸發 modal
      btn.classList.toggle('disabled', !active);
      btn.setAttribute('aria-disabled', active ? 'false' : 'true');
      btn.style.opacity = active ? '1' : '0.6';
    }
  }

  async function getPdfJs() {
    if (pdfJsLibPromise) return pdfJsLibPromise;
    const version = '4.8.69';
    const workerUrl = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/build/pdf.worker.min.mjs`;
    pdfJsLibPromise = import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${version}/+esm`)
      .then((lib) => {
        try { lib.GlobalWorkerOptions.workerSrc = workerUrl; } catch (err) { log({ pdfWorkerInitError: err?.message || err }); }
        return lib;
      })
      .catch((err) => { pdfJsLibPromise = null; throw err; });
    return pdfJsLibPromise;
  }

  function cleanupPdfViewer() {
    if (typeof activePdfCleanup === 'function') {
      try { activePdfCleanup(); } catch {}
    }
    activePdfCleanup = null;
  }

  async function renderPdfPreview({ url, name, modalApi }) {
    const { openModal, closeModal, showConfirmModal } = modalApi || {};
    let pdfjsLib;
    try {
      pdfjsLib = await getPdfJs();
    } catch (err) {
      log({ drivePdfLoadError: err?.message || err });
      return false;
    }
    const modalEl = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    const closeBtn = document.getElementById('modalClose');
    const closeArea = document.getElementById('modalCloseArea');
    if (!modalEl || !body || !modalTitle) return false;
    cleanupPdfViewer();
    modalEl.classList.add('pdf-modal');
    modalTitle.textContent = '';
    body.innerHTML = `
      <div class="pdf-viewer">
        <div class="pdf-toolbar">
          <button type="button" class="pdf-btn" id="pdfCloseBtn" aria-label="關閉"><svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
          <div class="pdf-title" title="${escapeHtml(name || 'PDF')}">${escapeHtml(name || 'PDF')}</div>
          <div class="pdf-actions">
            <a class="pdf-btn" id="pdfDownload" href="${escapeHtml(url)}" download="${escapeHtml(name || 'file.pdf')}">下載</a>
          </div>
        </div>
        <div class="pdf-stage">
          <div class="pdf-canvas-wrap">
            <canvas id="pdfCanvas" class="pdf-canvas"></canvas>
            <div class="pdf-loading" id="pdfLoading">載入中…</div>
          </div>
        </div>
        <div class="pdf-footer">
          <div class="pdf-actions-row">
            <div class="pdf-page-info">
              <button type="button" class="pdf-btn" id="pdfPrev" aria-label="上一頁">‹</button>
              <span id="pdfPageLabel">– / –</span>
              <button type="button" class="pdf-btn" id="pdfNext" aria-label="下一頁">›</button>
            </div>
          </div>
        </div>
      </div>`;
    openModal?.();

    const canvas = body.querySelector('#pdfCanvas');
    const loadingEl = body.querySelector('#pdfLoading');
    const pageLabel = body.querySelector('#pdfPageLabel');
    const stage = body.querySelector('.pdf-stage');

    let pdfDoc = null;
    let pageNum = 1;
    let scale = 1;
    let rendering = false;
    let pendingPage = null;
    let fitWidth = true;

    const updateLabels = () => {
      if (pageLabel && pdfDoc) pageLabel.textContent = `${pageNum} / ${pdfDoc.numPages}`;
    };

    const cleanupCore = () => {
      try { pdfDoc?.cleanup?.(); pdfDoc?.destroy?.(); } catch {}
      modalEl.classList.remove('pdf-modal');
    };

    const renderPage = async (num) => {
      if (!pdfDoc || !canvas) return;
      rendering = true;
      const page = await pdfDoc.getPage(num);
      const baseViewport = page.getViewport({ scale: 1 });
      if (fitWidth && stage?.clientWidth) {
        const maxWidth = Math.max(stage.clientWidth, 320);
        scale = Math.min(3, Math.max(0.6, maxWidth / baseViewport.width));
      }
      const viewport = page.getViewport({ scale });
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      if (loadingEl) loadingEl.textContent = `載入第 ${num} 頁…`;
      await page.render({ canvasContext: ctx, viewport }).promise;
      rendering = false;
      updateLabels();
      if (loadingEl) loadingEl.textContent = '';
      if (pendingPage) {
        const next = pendingPage;
        pendingPage = null;
        renderPage(next);
      }
      if (stage) stage.style.touchAction = scale > 1 ? 'none' : 'auto';
    };

    try {
      pdfDoc = await pdfjsLib.getDocument({ url }).promise;
      pageNum = 1;
      updateLabels();
      await renderPage(pageNum);
    } catch (err) {
      if (loadingEl) {
        loadingEl.textContent = `PDF 載入失敗：${err?.message || err}`;
        loadingEl.classList.add('pdf-error');
      }
      return true;
    }

    const queueRender = (num) => {
      if (num < 1 || num > pdfDoc.numPages) return;
      pageNum = num;
      if (rendering) {
        pendingPage = num;
      } else {
        renderPage(num);
      }
    };

    body.querySelector('#pdfPrev')?.addEventListener('click', () => queueRender(pageNum - 1));
    body.querySelector('#pdfNext')?.addEventListener('click', () => queueRender(pageNum + 1));
    const downloadBtn = body.querySelector('#pdfDownload');
    downloadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.pdf');
      if (typeof showConfirmModal === 'function') {
        showConfirmModal({
          title: '下載 PDF',
          message: '下載後會在外部開啟，回到通訊軟體需重新感應。確定要下載嗎？',
          confirmLabel: '下載',
          onConfirm: proceed
        });
      } else {
        const confirmed = window.confirm('下載後會在外部開啟，回到通訊軟體需重新感應。確定要下載嗎？');
        if (confirmed) proceed();
      }
    });
    body.querySelector('#pdfCloseBtn')?.addEventListener('click', () => activePdfCleanup?.());
    closeBtn?.addEventListener('click', () => activePdfCleanup?.(), { once: true });
    closeArea?.addEventListener('click', () => activePdfCleanup?.(), { once: true });
    const handleResize = () => { if (fitWidth) queueRender(pageNum); };
    window.addEventListener('resize', handleResize);

    // Pinch/pan
    let pinchStartDist = null;
    let pinchStartScale = scale;
    let panStart = null;
    const getDistance = (touches) => {
      if (!touches || touches.length < 2) return null;
      const [a, b] = touches;
      const dx = a.clientX - b.clientX;
      const dy = a.clientY - b.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        pinchStartDist = getDistance(e.touches);
        pinchStartScale = scale;
        panStart = null;
        if (stage) stage.style.touchAction = 'none';
      } else if (e.touches.length === 1 && scale > 1 && stage) {
        const t = e.touches[0];
        panStart = { x: t.clientX, y: t.clientY, scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop };
        stage.style.touchAction = 'none';
      }
    };
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
        const dist = getDistance(e.touches);
        if (!dist) return;
        e.preventDefault();
        const factor = dist / pinchStartDist;
        scale = Math.min(3, Math.max(0.6, pinchStartScale * factor));
        fitWidth = false;
        queueRender(pageNum);
      } else if (e.touches.length === 1 && panStart && stage) {
        e.preventDefault();
        const t = e.touches[0];
        stage.scrollLeft = panStart.scrollLeft - (t.clientX - panStart.x);
        stage.scrollTop = panStart.scrollTop - (t.clientY - panStart.y);
      }
    };
    const onTouchEnd = () => {
      pinchStartDist = null;
      panStart = null;
      if (stage && scale <= 1) stage.style.touchAction = 'auto';
    };
    stage?.addEventListener('touchstart', onTouchStart, { passive: false });
    stage?.addEventListener('touchmove', onTouchMove, { passive: false });
    stage?.addEventListener('touchend', onTouchEnd);
    stage?.addEventListener('touchcancel', onTouchEnd);

    const prevCleanup = activePdfCleanup;
    activePdfCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      cleanupCore();
      window.removeEventListener('resize', handleResize);
      stage?.removeEventListener('touchstart', onTouchStart);
      stage?.removeEventListener('touchmove', onTouchMove);
      stage?.removeEventListener('touchend', onTouchEnd);
      stage?.removeEventListener('touchcancel', onTouchEnd);
      closeModal?.();
      activePdfCleanup = null;
      if (stage) stage.style.touchAction = 'auto';
    };
    return true;
  }

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
  driveState.usageQuotaBytes = Number.isFinite(Number(driveState.usageQuotaBytes))
    ? Number(driveState.usageQuotaBytes)
    : DEFAULT_DRIVE_QUOTA_BYTES;
  if (!Number.isFinite(Number(driveState.usageBytes))) driveState.usageBytes = 0;
  ensureSafeCwd();
  const PLACEHOLDER_NAME = '.empty-folder';
  const PLACEHOLDER_CT = 'application/x-empty-folder';

  function showBlockingModal(message, { title = '無法上傳', confirmLabel = '知道了' } = {}) {
    if (typeof showConfirmModal === 'function') {
      showConfirmModal({
        title,
        message,
        confirmLabel,
        onConfirm: () => {},
        onCancel: () => {}
      });
    } else {
      alert(message);
    }
  }

  function isPlaceholder(header) {
    if (!header) return false;
    if (header.placeholder === true) return true;
    const name = String(header.name || '').trim();
    const ct = String(header.contentType || '').toLowerCase();
    return name === PLACEHOLDER_NAME && ct === PLACEHOLDER_CT;
  }

  function resolveDriveQuotaBytes() {
    const quota = Number(driveState.usageQuotaBytes);
    if (Number.isFinite(quota) && quota > 0) return quota;
    driveState.usageQuotaBytes = DEFAULT_DRIVE_QUOTA_BYTES;
    return driveState.usageQuotaBytes;
  }

  function computeDriveUsageBytes(messages) {
    const items = Array.isArray(messages) ? messages : [];
    const seenKeys = new Set();
    let total = 0;
    for (const msg of items) {
      const header = safeJSON(msg?.header_json || msg?.header || '{}');
      if (!header || isPlaceholder(header)) continue;
      const objKey = typeof msg?.obj_key === 'string' && msg.obj_key
        ? msg.obj_key
        : (typeof header?.obj === 'string' ? header.obj : '');
      if (!objKey || seenKeys.has(objKey)) continue;
      seenKeys.add(objKey);
      const size = Number(header?.size ?? header?.contentLength ?? header?.bytes);
      if (Number.isFinite(size) && size > 0) total += size;
    }
    return total;
  }

  function formatPercentLabel(value) {
    if (!Number.isFinite(value)) return '0%';
    const rounded = Math.round(value * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 0.05) {
      return `${Math.round(rounded)}%`;
    }
    return `${rounded.toFixed(1)}%`;
  }

  function updateUsageSummary() {
    const usageBytes = computeDriveUsageBytes(driveState.currentMessages);
    driveState.usageBytes = usageBytes;
    const quotaBytes = resolveDriveQuotaBytes();
    const percentRaw = quotaBytes > 0 ? (usageBytes / quotaBytes) * 100 : 0;
    const percent = Number.isFinite(percentRaw) ? Math.min(100, Math.max(0, percentRaw)) : 0;
    const percentLabel = formatPercentLabel(percent);

    if (usageBarEl) {
      usageBarEl.style.width = `${percent}%`;
      usageBarEl.classList.toggle('alert', percent >= 90);
    }
    if (usagePercentEl) usagePercentEl.textContent = percentLabel;
    if (usageValueEl) usageValueEl.textContent = fmtSize(usageBytes);
    if (usageTotalEl) usageTotalEl.textContent = `/ ${fmtSize(quotaBytes)}`;
    if (usageProgressEl) {
      usageProgressEl.setAttribute('aria-valuenow', String(Math.round(percent)));
      usageProgressEl.setAttribute('aria-valuetext', `${fmtSize(usageBytes)} / ${fmtSize(quotaBytes)}`);
    }
  }

  async function fetchDriveMessages({ convId, pageLimit = 200, maxPages = 25 } = {}) {
    if (!convId) throw new Error('convId required');
    const items = [];
    let cursor = undefined;
    let pages = 0;
    let truncated = false;
    while (true) {
      pages += 1;
      if (pages > maxPages) {
        truncated = true;
        log({ driveListTruncated: true, pages, pageLimit });
        break;
      }
      const { r, data } = await listMessages({ convId, limit: pageLimit, cursorTs: cursor });
      if (!r.ok) throw new Error(typeof data === 'string' ? data : JSON.stringify(data));
      const chunk = Array.isArray(data?.items) ? data.items : [];
      if (chunk.length) items.push(...chunk);
      const next = data?.nextCursorTs;
      if (!next) break;
      cursor = next;
    }
    return { items, truncated };
  }

  function findMessageEntryByKey(messages, key) {
    const items = Array.isArray(messages) ? messages : [];
    let best = null;
    for (const msg of items) {
      const header = safeJSON(msg?.header_json || msg?.header || '{}');
      if (header?.obj === key) {
        if (!best || Number(msg?.ts || 0) > Number(best.msg?.ts || 0)) {
          best = { msg, header };
        }
      }
    }
    return best;
  }

  function dedupeMessagesByObject(messages) {
    if (!Array.isArray(messages)) return [];
    const best = new Map();
    for (const msg of messages) {
      const header = safeJSON(msg?.header_json || msg?.header || '{}');
      const objKey = typeof msg?.obj_key === 'string' && msg.obj_key
        ? msg.obj_key
        : (typeof header?.obj === 'string' ? header.obj : '');
      if (!objKey) continue;
      const ts = Number(msg?.ts || 0);
      const prev = best.get(objKey);
      if (!prev || ts > Number(prev.ts || 0)) {
        best.set(objKey, { ...msg });
      }
    }
    return Array.from(best.values()).sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
  }

  function findEnvelopeInMessages(messages, key) {
    const entry = findMessageEntryByKey(messages, key);
    if (!entry) return null;
    const env = entry.header?.env || {};
    if (env?.iv_b64 && env?.hkdf_salt_b64) {
      return {
        ...env,
        contentType: entry.header?.contentType || 'application/octet-stream',
        name: entry.header?.name || 'decrypted.bin'
      };
    }
    return null;
  }

  function buildCiphertextForRename({ msg, header }) {
    const env = header?.env || {};
    const aead = msg?.aead || 'aes-256-gcm';
    const payload = (env?.iv_b64 && env?.hkdf_salt_b64)
      ? {
          v: env.v || 1,
          aead: env.aead || aead,
          iv_b64: env.iv_b64,
          hkdf_salt_b64: env.hkdf_salt_b64,
          info_tag: env.info_tag || 'media/v1',
          key_type: env.key_type || 'mk'
        }
      : 'rename';
    const buf = new TextEncoder().encode(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return b64(buf);
  }

  function cwdPath() {
    return ensureSafeCwd().join('/');
  }

  function renderCrumb() {
    if (!crumbEl) return;
    const cwd = ensureSafeCwd();
    const parts = [{ name: '根目錄', path: '' }, ...cwd.map((seg, idx) => ({ name: displayFolderName(seg), path: cwd.slice(0, idx + 1).join('/') }))];
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
          refreshDriveList().catch((err) => {
            log({ driveCrumbError: err?.message || err });
            showBlockingModal('無法載入資料夾，請稍後再試。', { title: '載入失敗' });
          });
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

  function getDirSegments({ header, objKey, convId }) {
    if (header) {
      const dir = header.dir;
      if (Array.isArray(dir)) {
        const segments = sanitizeHeaderDir(dir);
        if (segments.length) return segments;
      } else if (typeof dir === 'string') {
        const segments = String(dir)
          .split('/')
          .map((seg) => String(seg || '').trim())
          .filter(Boolean);
        const cleaned = sanitizeHeaderDir(segments);
        if (cleaned.length) return cleaned;
      }
    }
    const key = typeof objKey === 'string' ? objKey : '';
    if (!key) return [];
    const parts = key.split('/').filter(Boolean);
    if (convId && parts[0] === convId) parts.shift();
    if (parts.length > 0) parts.pop(); // last segment is object key (filename/id)
    return sanitizeHeaderDir(parts);
  }

  function pathStartsWith(pathSegments, prefixSegments) {
    if (prefixSegments.length > pathSegments.length) return false;
    for (let i = 0; i < prefixSegments.length; i += 1) {
      if (pathSegments[i] !== prefixSegments[i]) return false;
    }
    return true;
  }

  function showListSkeleton() {
    if (!driveListEl) return;
    renderCrumb();
    driveListEl.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const li = document.createElement('li');
      li.className = 'file-item skeleton-item';
      li.setAttribute('aria-hidden', 'true');
      li.innerHTML = `
        <div class="item-content">
          <div class="meta">
            <div class="name"><span class="skeleton-bone skeleton-icon"></span><span class="skeleton-bone skeleton-text"></span></div>
            <div class="sub"><span class="skeleton-bone skeleton-sub"></span></div>
          </div>
        </div>`;
      driveListEl.appendChild(li);
    }
  }

  async function navigateToCwd(nextCwd) {
    const cleaned = sanitizePathSegments(Array.isArray(nextCwd) ? nextCwd : []);
    driveState.cwd = [...cleaned];
    ensureSafeCwd();
    showListSkeleton();
    try {
      await refreshDriveList();
    } catch (err) {
      log({ driveNavigateError: err?.message || err, cwd: driveState.cwd });
      showBlockingModal('無法載入資料夾，請稍後再試。', { title: '載入失敗' });
    }
  }

  async function refreshDriveList() {
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = `drive-${acct}`;
    const { items, truncated } = await fetchDriveMessages({ convId });
    const deduped = dedupeMessagesByObject(items);
    if (truncated) {
      log({ driveListWarning: '列表已截斷，僅顯示最新項目', convId, items: items.length });
    }
    driveState.currentMessages = deduped;
    driveState.currentConvId = convId;
    updateUsageSummary();
    renderDriveList(deduped);
    updateStats?.();
  }

  function renderDriveList(items) {
    if (!driveListEl) return;
    const convId = driveState.currentConvId || '';
    closeOpenSwipe?.();
    renderCrumb();
    driveListEl.innerHTML = '';
    const currentPath = [...ensureSafeCwd()];
    if (btnUp) btnUp.style.display = currentPath.length ? 'inline-flex' : 'none';
    const folderSet = new Map();
    const files = [];
    for (const it of items) {
      const header = safeJSON(it.header_json || it.header || '{}');
      const isPlaceholderItem = isPlaceholder(header);
      const objKey = typeof it?.obj_key === 'string' && it.obj_key ? it.obj_key : (typeof header?.obj === 'string' ? header.obj : '');
      const dirSegments = getDirSegments({ header, objKey, convId });
      if (!pathStartsWith(dirSegments, currentPath)) continue;
      if (dirSegments.length > currentPath.length) {
        const next = dirSegments[currentPath.length];
        if (next) {
          const summary = folderSet.get(next) || { files: 0, placeholders: 0, subfolders: new Set() };
          if (dirSegments.length > currentPath.length + 1) {
            const childName = dirSegments[currentPath.length + 1];
            if (childName) summary.subfolders.add(childName);
          }
          if (isPlaceholderItem) summary.placeholders += 1;
          else summary.files += 1;
          folderSet.set(next, summary);
        }
        continue;
      }
      if (isPlaceholderItem) continue;
      files.push({ header, ts: it.ts, obj_key: objKey });
    }
    const folders = Array.from(folderSet.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, summary] of folders) {
      const isSystem = isReservedDir(name);
      const displayName = SYSTEM_DIR_LABELS[name] || name;
      const fileCount = Number(summary?.files || 0);
      const folderCount = summary?.subfolders instanceof Set ? summary.subfolders.size : 0;
      const parts = [];
      if (folderCount > 0) parts.push(`${folderCount} 個資料夾`);
      if (fileCount > 0) parts.push(`${fileCount} 個檔案`);
      const subLabel = parts.length ? parts.join(' · ') : '空資料夾';
      const li = document.createElement('li');
      li.className = 'file-item folder' + (isSystem ? ' system-folder' : '');
      li.dataset.type = 'folder';
      li.dataset.folderName = name;
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      const badge = isSystem
        ? `<span class="badge badge-system" style="margin-left:6px;padding:2px 8px;border-radius:10px;background:#e0f2ff;color:#0b6bcb;font-weight:600;font-size:12px;">系統資料夾</span>`
        : '';
      li.innerHTML = `
        <div class="item-content">
          <div class="meta">
            <div class="name"><i class='bx bx-folder' aria-hidden="true"></i><span class="label">${escapeHtml(displayName)}</span>${badge}</div>
            <div class="sub">${subLabel}</div>
          </div>
        </div>
        ${isSystem ? '' : `<button type="button" class="item-delete" aria-label="刪除"><i class='bx bx-trash'></i></button>`}`;
      const open = async () => {
        if (li.classList.contains('show-delete')) {
          closeSwipe?.(li);
          return;
        }
        closeOpenSwipe?.();
        const next = [...ensureSafeCwd(), name];
        await navigateToCwd(next);
      };
      li.addEventListener('click', (e) => {
        if (e.target.closest('.item-delete')) return;
        if (li.classList.contains('show-delete')) { closeSwipe?.(li); return; }
        if (li.dataset.longPressActive === '1') { li.dataset.longPressActive = '0'; return; }
        e.preventDefault();
        open().catch((err) => log({ driveFolderOpenError: err?.message || err }));
      });
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open().catch((err) => log({ driveFolderOpenError: err?.message || err })); }
        if (e.key === 'Delete') { handleItemDelete({ type: 'folder', name, element: li }); }
      });
      li.querySelector('.item-delete')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleItemDelete({ type: 'folder', name, element: li });
      });
      li.querySelector('.label')?.setAttribute('title', name);
      setupSwipe?.(li);
      attachLongPressEdit(li, { type: 'folder', name });
      driveListEl.appendChild(li);
    }
    for (const f of files) {
      const key = f.obj_key || f.header?.obj || '';
      const name = f.header?.name || key.split('/').pop() || 'file.bin';
      const size = f.header?.size || 0;
      const ct = f.header?.contentType || 'application/octet-stream';
      const ts = friendlyTimestamp(f.ts);
      const friendlyCt = friendlyContentType(ct);
      const iconClass = fileIconForName(name, ct);
      const iconColor = fileIconColor(name, ct);
      const isImage = ct.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(String(name || '').split('.').pop().toLowerCase());
      const iconHtml = isImage
        ? `<span class="file-thumb" aria-hidden="true"><i class='${iconClass}'></i></span>`
        : `<i class='${iconClass}' style="color:${iconColor}" aria-hidden="true"></i>`;
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
            <div class="name">${iconHtml}<span class="label">${escapeHtml(name)}</span></div>
            <div class="sub">${fmtSize(size)} · ${escapeHtml(friendlyCt)}${ts ? ` · ${escapeHtml(ts)}` : ''}</div>
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
        if (li.dataset.longPressActive === '1') { li.dataset.longPressActive = '0'; return; }
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
      attachLongPressEdit(li, { type: 'file', name, key });
      driveListEl.appendChild(li);
    }
    if (!folders.length && !files.length) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'empty-state';
      emptyLi.innerHTML = `
        <i class='bx bx-cloud-upload' aria-hidden="true"></i>
        <p class="empty-state-title">這裡還沒有檔案</p>
        <p class="empty-state-hint">上傳檔案或建立資料夾開始使用</p>
        <button type="button" class="empty-state-btn">上傳檔案</button>`;
      emptyLi.querySelector('.empty-state-btn')?.addEventListener('click', () => openUploadModal());
      driveListEl.appendChild(emptyLi);
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

  function fileIconColor(name, contentType) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    const ct = String(contentType || '').toLowerCase();
    if (ct.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(ext)) return '#16a34a';
    if (ct.startsWith('video/') || ['mp4','mov','m4v','webm','avi','mkv'].includes(ext)) return '#7c3aed';
    if (ct.startsWith('audio/') || ['mp3','wav','m4a','aac','flac','ogg'].includes(ext)) return '#7c3aed';
    if (ext === 'pdf') return '#dc2626';
    if (['doc','docx','rtf','odt','pages'].includes(ext)) return '#2563eb';
    if (['xls','xlsx','csv','ods','numbers'].includes(ext)) return '#16a34a';
    if (['ppt','pptx','odp','key'].includes(ext)) return '#ea580c';
    if (['zip','rar','7z','gz','tar','tgz','bz2'].includes(ext)) return '#d97706';
    return '#2563eb';
  }

  function friendlyContentType(ct) {
    const s = String(ct || '').toLowerCase();
    if (s.startsWith('image/')) return s.replace('image/', '').toUpperCase() + ' 圖片';
    if (s.startsWith('video/')) return s.replace('video/', '').toUpperCase() + ' 影片';
    if (s.startsWith('audio/')) return s.replace('audio/', '').toUpperCase() + ' 音檔';
    if (s === 'application/pdf') return 'PDF 文件';
    if (s.includes('word') || s.includes('document')) return 'Word 文件';
    if (s.includes('sheet') || s.includes('excel')) return '試算表';
    if (s.includes('presentation') || s.includes('powerpoint')) return '簡報';
    if (s.includes('zip') || s.includes('compressed') || s.includes('archive') || s.includes('rar') || s.includes('7z') || s.includes('tar') || s.includes('gzip')) return '壓縮檔';
    if (s.startsWith('text/')) return s.replace('text/', '').toUpperCase() + ' 文字';
    if (s === 'application/octet-stream') return '檔案';
    if (s === 'application/json') return 'JSON';
    return s;
  }

  function friendlyTimestamp(unixSec) {
    if (!unixSec) return '';
    const date = new Date(unixSec * 1000);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return '剛剛';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} 分鐘前`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr} 小時前`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return `${diffDay} 天前`;
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    if (y === now.getFullYear()) return `${m}月${d}日`;
    return `${y}/${m}/${d}`;
  }

  function attachLongPressEdit(li, { type, name, key }) {
    let pressTimer = null;
    const threshold = 500; // ms
    const start = (e) => {
      if (e?.target?.closest?.('.item-delete')) return;
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        li.dataset.longPressActive = '1';
        openRenameModal({ type, name, key, element: li });
      }, threshold);
    };
    const clear = () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = null;
    };
    li.addEventListener('touchstart', start, { passive: true });
    li.addEventListener('touchend', clear);
    li.addEventListener('touchmove', clear);
    li.addEventListener('touchcancel', clear);
    li.addEventListener('mousedown', start);
    li.addEventListener('mouseleave', clear);
    li.addEventListener('mouseup', clear);
    li.addEventListener('click', () => {
      if (li.dataset.longPressActive === '1') li.dataset.longPressActive = '0';
    });
  }

  function openRenameModal({ type, name, key, element }) {
    const modalEl = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalEl || !body) return;
    modalEl.classList.remove('security-modal', 'progress-modal', 'upload-modal', 'nickname-modal', 'folder-modal', 'pdf-modal');
    modalEl.classList.add('nickname-modal');
    if (title) title.textContent = type === 'folder' ? '重新命名資料夾' : '重新命名檔案';
    body.innerHTML = `
      <form id="renameForm" class="nickname-form">
        <label for="renameInput">${type === 'folder' ? '資料夾名稱' : '檔案名稱'}</label>
        <input id="renameInput" type="text" value="${escapeHtml(name || '')}" autocomplete="off" spellcheck="false" />
        <p class="nickname-hint">名稱不可為空。</p>
        <div class="nickname-actions">
          <button type="button" id="renameCancel" class="secondary">取消</button>
          <button type="submit" class="primary">儲存</button>
        </div>
      </form>`;
    openModal?.();
    const input = body.querySelector('#renameInput');
    const form = body.querySelector('#renameForm');
    const cancelBtn = body.querySelector('#renameCancel');
    cancelBtn?.addEventListener('click', () => closeModal?.(), { once: true });
    setTimeout(() => input?.focus(), 30);
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const newName = String(input?.value || '').trim();
      if (!newName) {
        input?.focus();
        return;
      }
      closeModal?.();
      showModalLoading?.('重新命名中…');
      updateLoadingModal?.({ percent: 12, text: '準備重新命名…' });
      try {
        if (type === 'folder') {
          await renameFolder(name, newName);
          updateLoadingModal?.({ percent: 55, text: '同步資料夾名稱…' });
        } else if (type === 'file') {
          await renameFile(key, newName);
          updateLoadingModal?.({ percent: 55, text: '同步檔案名稱…' });
        }
        updateLoadingModal?.({ percent: 85, text: '刷新列表…' });
        await refreshDriveList();
        updateLoadingModal?.({ percent: 98, text: '完成' });
      } catch (err) {
        log({ renameError: err?.message || err });
      } finally {
        setTimeout(() => closeModal?.(), 120);
        if (element) closeSwipe?.(element);
      }
    }, { once: true });
  }

  async function renameFile(key, newName) {
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = driveState.currentConvId || `drive-${acct}`;
    const entry = findMessageEntryByKey(driveState.currentMessages, key);
    if (!entry) throw new Error('找不到檔案，請重新整理');
    const header = { ...entry.header, name: newName };
    const ciphertext_b64 = buildCiphertextForRename({ msg: entry.msg, header });
    const messageId = crypto.randomUUID();
    const msgPayload = {
      convId,
      type: entry.msg?.type || 'media',
      aead: entry.msg?.aead || 'aes-256-gcm',
      id: messageId,
      header,
      ciphertext_b64
    };
    const body = buildAccountPayload({ overrides: msgPayload });
    const { r, data } = await createMessage(body);
    if (!r.ok) throw new Error('重新命名失敗：' + JSON.stringify(data));
  }

  async function renameFolder(oldName, newName) {
    if (!oldName || !newName) return;
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = driveState.currentConvId || `drive-${acct}`;
    const currentPath = [...ensureSafeCwd()];
    const basePath = currentPath.slice(0, -1);
    const targetPath = [...basePath, oldName];
    const targetMessages = driveState.currentMessages
      .map((msg) => {
        const header = safeJSON(msg?.header_json || msg?.header || '{}');
        const objKey = typeof msg?.obj_key === 'string' && msg.obj_key ? msg.obj_key : (typeof header?.obj === 'string' ? header.obj : '');
        const dirSegments = getDirSegments({ header, objKey, convId });
        if (!pathStartsWith(dirSegments, targetPath)) return null;
        if (!objKey) return null;
        return { header, objKey, msg };
      })
      .filter(Boolean);

    const batch = targetMessages.map(({ header, objKey, msg }) => {
      const newDir = getDirSegments({ header, objKey, convId }).map((seg) => (seg === oldName ? newName : seg));
      const payload = {
        convId,
        type: msg?.type || 'media',
        aead: msg?.aead || 'aes-256-gcm',
        id: crypto.randomUUID(),
        header: {
          ...header,
          dir: newDir,
          obj: objKey
        },
        ciphertext_b64: buildCiphertextForRename({ msg, header })
      };
      return payload;
    });

    for (const msgPayload of batch) {
      const body = buildAccountPayload({ overrides: msgPayload });
      const { r, data } = await createMessage(body);
      if (!r.ok) throw new Error('重新命名失敗：' + JSON.stringify(data));
    }
  }

  function openUploadModal() {
    if (!requireSubscriptionActive()) return;
    const modalEl = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalEl || !body) return;
    modalEl.classList.remove('security-modal', 'progress-modal', 'folder-modal', 'nickname-modal', 'pdf-modal');
    modalEl.classList.add('upload-modal');
    if (title) title.textContent = '上傳檔案';
    body.innerHTML = `
      <form id="uploadForm" class="upload-form">
        <div class="upload-field">
          <input id="uploadFileInput" type="file" class="upload-input" multiple />
          <label for="uploadFileInput" class="upload-callout">
            <i class='bx bx-cloud-upload'></i>
            <span>點擊選擇檔案（可多選）</span>
          </label>
        </div>
        <div id="uploadFileName" class="upload-name">尚未選擇檔案</div>
        <ul id="uploadFileList" class="upload-file-list"></ul>
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
    const listEl = body.querySelector('#uploadFileList');
    const errorEl = body.querySelector('.upload-error');
    const cancelBtn = body.querySelector('#uploadCancel');
    const form = body.querySelector('#uploadForm');

    const formatUploadFileName = (name) => {
      const safe = typeof name === 'string' && name.trim() ? name.trim() : '未命名';
      const max = 26;
      const tail = 8;
      if (safe.length <= max) return safe;
      const headLen = Math.max(6, max - tail - 3);
      return `${safe.slice(0, headLen)}...${safe.slice(-tail)}`;
    };
    cancelBtn?.addEventListener('click', () => closeModal?.(), { once: true });
    input?.addEventListener('change', () => {
      const files = input?.files ? Array.from(input.files).filter(Boolean) : [];
      if (!files.length) {
        if (nameEl) nameEl.textContent = '尚未選擇檔案';
        if (listEl) listEl.innerHTML = '';
        if (errorEl) errorEl.textContent = '';
        return;
      }
      const oversized = files.filter((file) => Number(file?.size || 0) > MAX_UPLOAD_BYTES);
      if (oversized.length) {
        const msg = `單檔上限 500MB：${escapeHtml(oversized[0].name || '檔案')} 超過限制`;
        if (errorEl) errorEl.textContent = msg;
        showBlockingModal(msg, { title: '檔案過大' });
        input.value = '';
        if (nameEl) nameEl.textContent = '尚未選擇檔案';
        if (listEl) listEl.innerHTML = '';
        return;
      }
      const totalSize = files.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0);
      if (nameEl) {
        nameEl.textContent = files.length === 1
          ? formatUploadFileName(files[0].name)
          : `${files.length} 個檔案 · ${fmtSize(totalSize)}`;
      }
      if (listEl) {
        listEl.innerHTML = files
          .map((file) => `<li><span class="upload-file-name">${escapeHtml(formatUploadFileName(file.name))}</span><span class="upload-file-size">${fmtSize(file.size || 0)}</span></li>`)
          .join('');
      }
      if (errorEl) errorEl.textContent = '';
    });
    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const files = input?.files ? Array.from(input.files).filter(Boolean) : [];
      if (!files.length) {
        if (errorEl) errorEl.textContent = '請先選擇要上傳的檔案。';
        return;
      }
      const oversized = files.filter((file) => Number(file?.size || 0) > MAX_UPLOAD_BYTES);
      if (oversized.length) {
        const msg = `單檔上限 500MB：${escapeHtml(oversized[0].name || '檔案')} 超過限制`;
        if (errorEl) errorEl.textContent = msg;
        showBlockingModal(msg, { title: '檔案過大' });
        return;
      }
      closeModal?.();
      try {
        await startUploadQueue(files);
      } catch (err) {
        log({ driveUploadError: err?.message || err });
      }
    }, { once: true });
  }

  function openFolderModal() {
    if (!requireSubscriptionActive()) return;
    const modalEl = document.getElementById('modal');
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!modalEl || !body) return;
    modalEl.classList.remove('security-modal', 'progress-modal', 'upload-modal', 'nickname-modal', 'pdf-modal');
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
      if (isReservedDir(safeName)) {
        if (errorEl) errorEl.textContent = '此名稱為系統保留資料夾，請改用其他名稱。';
        input?.focus();
        input?.select?.();
        return;
      }
      if (input) input.value = safeName;
      if (errorEl) errorEl.textContent = '';
      const basePath = [...ensureSafeCwd()];
      const targetPath = [...basePath, safeName];
      driveState.cwd = [...targetPath];
      ensureSafeCwd();
      closeModal?.();
      showModalLoading?.('建立資料夾中…');
      updateLoadingModal?.({ percent: 12, text: '準備建立資料夾…' });
      try {
        await createFolderPlaceholder(targetPath);
        updateLoadingModal?.({ percent: 55, text: '同步資料夾…' });
        await refreshDriveList();
        updateLoadingModal?.({ percent: 95, text: '完成' });
        setTimeout(() => closeModal?.(), 120);
      } catch (err) {
        log({ driveListError: String(err?.message || err) });
        closeModal?.();
        showBlockingModal('建立資料夾失敗，請稍後再試。', { title: '建立失敗' });
      }
    }, { once: true });
  }

  async function startUploadQueue(selectedFiles) {
    const files = Array.isArray(selectedFiles) ? selectedFiles.filter(Boolean) : [];
    if (!files.length) return;
    const oversized = files.filter((file) => Number(file?.size || 0) > MAX_UPLOAD_BYTES);
    if (oversized.length) {
      const name = escapeHtml(oversized[0].name || '檔案');
      showBlockingModal(`無法上傳：${name} 超過 500MB 單檔限制`, { title: '檔案過大' });
      return;
    }
    const quotaBytes = resolveDriveQuotaBytes();
    const currentUsage = Number(driveState?.usageBytes || 0);
    let projected = currentUsage;
    for (const file of files) {
      const size = Number(file?.size || 0);
      if (!Number.isFinite(size)) continue;
      projected += size;
      if (quotaBytes && projected > quotaBytes) {
        showBlockingModal('雲端空間容量不足，請刪除檔案後再上傳。', { title: '空間不足' });
        return;
      }
    }
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) {
      showBlockingModal('尚未登入，請重新登入後再試。', { title: '尚未登入' });
      return;
    }
    const convId = driveState.currentConvId || `drive-${acct}`;
    showProgressModal?.(files.length === 1 ? (files[0].name || '檔案') : `${files.length} 個檔案`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const titleEl = document.querySelector('.progress-wrap .progress-title');
    const textEl = document.getElementById('progressText');
    const innerEl = document.getElementById('progressInner');
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (titleEl) titleEl.textContent = `上傳中 (${i + 1}/${files.length})：${file.name || '檔案'}`;
        if (innerEl) innerEl.style.width = '0%';
        if (textEl) textEl.textContent = '準備中…';
        await encryptAndPutWithProgress({
          convId,
          file,
          dir: [...ensureSafeCwd()],
          direction: 'drive',
          onProgress: (progress) => {
            if (!progress) return;
            const loaded = typeof progress.loaded === 'number' ? progress.loaded : 0;
            const total = typeof progress.total === 'number' ? progress.total : (typeof file.size === 'number' ? file.size : 0);
            const percent = progress.percent != null
              ? progress.percent
              : (total > 0 ? Math.round((loaded / total) * 100) : 0);
            updateProgressModal?.({
              ...progress,
              loaded,
              total,
              percent
            });
          }
        });
        if (innerEl) innerEl.style.width = '100%';
        if (textEl) textEl.textContent = `已完成 (${i + 1}/${files.length})`;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      completeProgressModal?.();
      await new Promise((resolve) => setTimeout(resolve, 680));
      await refreshDriveList();
    } catch (err) {
      log({ driveUploadError: err?.message || err });
      failProgressModal?.(err?.message || String(err));
      throw err;
    }
  }

  async function createFolderPlaceholder(pathSegments) {
    const dir = Array.isArray(pathSegments) ? pathSegments.filter(Boolean) : [];
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = `drive-${acct}`;
    const blob = new File([new Uint8Array([0])], PLACEHOLDER_NAME, { type: PLACEHOLDER_CT });
    await encryptAndPutWithProgress({
      convId,
      file: blob,
      dir,
      direction: 'drive',
      extraHeader: { placeholder: true }
    });
  }

  async function doPreview(key, contentTypeHint, nameHint) {
    showModalLoading?.('下載加密檔案中…');
    const envelope = findEnvelopeInMessages(driveState.currentMessages, key);
    try {
      cleanupPdfViewer();
      const { blob, contentType, name } = await downloadAndDecrypt({
        key,
        envelope,
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

      const url = URL.createObjectURL(blob);
      setModalObjectUrl?.(url);

      const container = document.createElement('div');
      container.className = 'preview-wrap';
      const wrap = document.createElement('div');
      wrap.className = 'viewer';
      container.appendChild(wrap);
      body.appendChild(container);

      if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
        const handled = await renderPdfPreview({
          url,
          name: resolvedName,
          modalApi: { openModal, closeModal, showConfirmModal }
        });
        if (handled) return;
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.className = 'viewer';
        iframe.title = resolvedName;
        wrap.appendChild(iframe);
      } else if (ct.startsWith('image/')) {
        // Use full-screen image viewer with drive save support
        closeModal?.();
        openImageViewer({
          url,
          blob,
          name: resolvedName,
          contentType: ct,
          source: 'drive',
          originalKey: key,
          onSaveToDrive: async (editedBlob, mode, editedName) => {
            const saveName = editedName || resolvedName;
            const saveFile = new File([editedBlob], saveName, { type: 'image/png' });
            if (mode === 'overwrite' && key) {
              // Delete original then upload replacement
              try {
                const matches = driveState.currentMessages
                  .filter((msg) => {
                    const direct = typeof msg?.obj_key === 'string' ? msg.obj_key : '';
                    if (direct && direct === key) return true;
                    const header = safeJSON(msg?.header_json || msg?.header || '{}');
                    return typeof header?.obj === 'string' && header.obj === key;
                  });
                const ids = matches.map((msg) => String(msg?.id || '')).filter(Boolean);
                await performDelete({ keys: [key], ids });
              } catch (err) {
                log({ driveOverwriteDeleteError: err?.message || err });
              }
            }
            await startUploadQueue([saveFile]);
          },
          onClose: () => {
            try { URL.revokeObjectURL(url); } catch {}
          }
        });
        return;
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
        message.className = 'preview-message';
        message.textContent = `無法預覽此類型（${ct}）`;
        wrap.appendChild(message);
        const link = document.createElement('a');
        link.href = url;
        link.download = resolvedName;
        link.textContent = '下載檔案';
        link.className = 'preview-download';
        wrap.appendChild(link);
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
    if (isReservedDir(folderName)) return;
    const basePath = [...ensureSafeCwd()];
    const targetPath = [...basePath, folderName];
    const convId = driveState.currentConvId || '';
    const targetMessages = driveState.currentMessages
      .map((msg) => {
        const header = safeJSON(msg?.header_json || msg?.header || '{}');
        const placeholder = isPlaceholder(header);
        const objKeyRaw = typeof msg?.obj_key === 'string' && msg.obj_key
          ? msg.obj_key
          : (typeof header?.obj === 'string' ? header.obj : '');
        const dirSegments = getDirSegments({ header, objKey: objKeyRaw, convId });
        if (!pathStartsWith(dirSegments, targetPath)) return null;
        const objKey = objKeyRaw;
        if (!objKey) return null;
        const id = String(msg?.id || '');
        return { objKey, id, placeholder };
      })
      .filter(Boolean);

    const visibleCount = targetMessages.filter((m) => !m.placeholder).length;

    if (!targetMessages.length) {
      log({ deleteInfo: `資料夾「${folderName}」內沒有檔案` });
      return;
    }

    const keys = Array.from(new Set(targetMessages.map((m) => m.objKey)));
    const ids = Array.from(new Set(targetMessages.map((m) => m.id).filter(Boolean)));

    if (element) closeSwipe?.(element);
    showConfirmModal?.({
      title: '確認刪除',
      message: visibleCount > 0
        ? `刪除資料夾「${escapeHtml(folderName)}」及其 ${visibleCount} 個檔案？`
        : `刪除資料夾「${escapeHtml(folderName)}」（空資料夾）？`,
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
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = `drive-${acct}`;
    const { deleted, failed } = await deleteEncryptedObjects({ keys, ids, convId });
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
    const cached = findEnvelopeInMessages(driveState.currentMessages, key);
    if (cached) return cached;
    const { items } = await fetchDriveMessages({ convId });
    driveState.currentMessages = items;
    driveState.currentConvId = convId;
    updateUsageSummary();
    const hit = findEnvelopeInMessages(items, key);
    if (hit) return hit;
    throw new Error('找不到封套資料（此物件可能來自尚未更新索引格式的舊版本或尚未同步）');
  }

  function bindDomEvents() {
    btnUploadOpen?.addEventListener('click', openUploadModal);
    btnNewFolder?.addEventListener('click', openFolderModal);
    btnUp?.addEventListener('click', () => {
      if (!driveState.cwd.length) return;
      const next = driveState.cwd.slice(0, -1);
      navigateToCwd(next).catch((err) => log({ driveFolderOpenError: err?.message || err }));
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
  setupDrivePullToRefresh();
  renderCrumb();
  updateUsageSummary();
  updateDriveActionAvailability();

  return {
    refreshDriveList,
    openUploadModal,
    openFolderModal,
    handleItemDelete,
    renderDriveList,
    renderCrumb,
    onDownloadByKey,
    getEnvelopeForKey,
    updateUsageSummary,
    updateDriveActionAvailability,
    showSubscriptionGateIfExpired
  };
}
