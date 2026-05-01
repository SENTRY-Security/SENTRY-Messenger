import { log } from '../../core/log.js';
import { isSubscriptionActive, requireSubscriptionActive } from '../../core/subscription-gate.js';
import { getAccountDigest, buildAccountPayload } from '../../core/store.js';
import { listMessages, createMessage } from '../../api/messages.js';
import { encryptAndPutWithProgress, deleteEncryptedObjects, downloadAndDecrypt, loadEnvelopeMeta } from '../../features/media.js';
import { sessionStore } from './session-store.js';
import { escapeHtml, fmtSize, safeJSON } from './ui-utils.js';
import { b64 } from '../../crypto/aead.js';
import { openImageViewer } from './viewers/image-viewer.js';
import { renderPdfViewer, cleanupPdfViewer } from './viewers/pdf-viewer.js';
import { renderExcelViewer, cleanupExcelViewer, isExcelMime, isExcelFilename } from './viewers/excel-viewer.js';
import { renderWordViewer, cleanupWordViewer, isWordMime, isWordFilename } from './viewers/word-viewer.js';
import { renderZipViewer, cleanupZipViewer, isZipMime, isZipFilename } from './viewers/zip-viewer.js';
import { renderPptxViewer, cleanupPptxViewer, isPptxMime, isPptxFilename } from './viewers/pptx-viewer.js';
import { t } from '/locales/index.js';

const DEFAULT_DRIVE_QUOTA_BYTES = 3 * 1024 * 1024 * 1024; // 3GB
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1GB per file

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
  // Subscription gate imported at module top level from core/subscription-gate.js

  function showSubscriptionGateIfExpired() {
    if (!isSubscriptionActive()) {
      document.dispatchEvent(new CustomEvent('subscription:gate'));
    }
  }

  const SYSTEM_DIR_SENT = '__SYS_SENT__';
  const SYSTEM_DIR_RECEIVED = '__SYS_RECV__';
  const SYSTEM_DIR_LABELS = Object.freeze({
    [SYSTEM_DIR_SENT]: t('drive.sent'),
    [SYSTEM_DIR_RECEIVED]: t('drive.received')
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
          labelEl.textContent = t('common.refreshing');
        } else {
          spinner.classList.remove('spin');
          labelEl.textContent = clamped >= DRIVE_PULL_THRESHOLD ? t('drive.releaseToRefresh') : t('drive.pullToRefresh');
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

  // PDF viewer is now shared with chat — imported from viewers/pdf-viewer.js

  const {
    openModal,
    closeModal,
    showConfirmModal,
    showAlertModal,
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

  function showBlockingModal(message, { title = t('drive.cannotUpload'), confirmLabel = t('drive.understood') } = {}) {
    if (typeof showConfirmModal === 'function') {
      showConfirmModal({
        title,
        message,
        confirmLabel,
        onConfirm: () => {},
        onCancel: () => {}
      });
    } else if (typeof showAlertModal === 'function') {
      showAlertModal({ title, message });
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
      const next = data?.next_cursor_ts;
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
      // Match by obj key (single file) or baseKey (chunked file)
      if (header?.obj === key || header?.baseKey === key) {
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
      // Use obj_key, header.obj, or header.baseKey (chunked files) as the dedupe key
      let objKey = typeof msg?.obj_key === 'string' && msg.obj_key
        ? msg.obj_key
        : (typeof header?.obj === 'string' ? header.obj : '');
      if (!objKey && typeof header?.baseKey === 'string') {
        objKey = header.baseKey;
      }
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
    const parts = [{ name: t('drive.rootDir'), path: '' }, ...cwd.map((seg, idx) => ({ name: displayFolderName(seg), path: cwd.slice(0, idx + 1).join('/') }))];
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
            showBlockingModal(t('drive.cannotLoadFolder'), { title: t('errors.loadFailed') });
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
      showBlockingModal(t('drive.cannotLoadFolder'), { title: t('errors.loadFailed') });
    }
  }

  async function refreshDriveList() {
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) throw new Error('Account missing');
    const convId = `drive-${acct}`;
    const { items, truncated } = await fetchDriveMessages({ convId });
    const deduped = dedupeMessagesByObject(items);
    if (truncated) {
      log({ driveListWarning: t('drive.listTruncated'), convId, items: items.length });
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
      if (folderCount > 0) parts.push(t('drive.folderCount', { count: folderCount }));
      if (fileCount > 0) parts.push(t('drive.fileCount', { count: fileCount }));
      const subLabel = parts.length ? parts.join(' · ') : t('common.emptyFolder');
      const li = document.createElement('li');
      li.className = 'file-item folder' + (isSystem ? ' system-folder' : '');
      li.dataset.type = 'folder';
      li.dataset.folderName = name;
      li.setAttribute('role', 'button');
      li.tabIndex = 0;
      const badge = isSystem
        ? `<span class="badge badge-system" style="margin-left:6px;padding:2px 8px;border-radius:10px;background:#e0f2ff;color:#0b6bcb;font-weight:600;font-size:12px;">${t('drive.systemFolder')}</span>`
        : '';
      li.innerHTML = `
        <div class="item-content">
          <div class="meta">
            <div class="name"><svg class="icon" aria-hidden="true"><use href="#i-folder"/></svg><span class="label">${escapeHtml(displayName)}</span>${badge}</div>
            <div class="sub">${subLabel}</div>
          </div>
        </div>
        ${isSystem ? '' : `<button type="button" class="item-delete" aria-label="${t('drive.deleteAriaLabel')}"><svg class="icon"><use href="#i-trash-2"/></svg></button>`}`;
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
      const header = safeJSON(f?.header_json || f?.header || '{}');
      const isChunkedFile = !!header?.chunked && !!header?.baseKey;
      const key = isChunkedFile ? header.baseKey : (f.obj_key || header?.obj || '');
      const name = header?.name || key.split('/').pop() || 'file.bin';
      const size = f.header?.size || 0;
      const ct = f.header?.contentType || 'application/octet-stream';
      const ts = friendlyTimestamp(f.ts);
      const friendlyCt = friendlyContentType(ct);
      const iconClass = fileIconForName(name, ct);
      const iconColor = fileIconColor(name, ct);
      const isImage = ct.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(String(name || '').split('.').pop().toLowerCase());
      const iconHtml = isImage
        ? `<span class="file-thumb" aria-hidden="true"><svg class="icon"><use href="#i-${iconClass}"/></svg></span>`
        : `<svg class="icon" style="color:${iconColor}" aria-hidden="true"><use href="#i-${iconClass}"/></svg>`;
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
        <button type="button" class="item-delete" aria-label="${t('drive.deleteAriaLabel')}"><svg class="icon"><use href="#i-trash-2"/></svg></button>`;
      const preview = () => {
        if (li.classList.contains('show-delete')) {
          closeSwipe?.(li);
          return;
        }
        closeOpenSwipe?.();
        const previewMeta = isChunkedFile
          ? { chunked: true, baseKey: header.baseKey, chunkCount: header.chunkCount, totalSize: header.totalSize, manifestEnvelope: header.manifestEnvelope }
          : null;
        doPreview(key, ct, name, previewMeta).catch((err) => {
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
        <svg class="icon" aria-hidden="true"><use href="#i-cloud-upload"/></svg>
        <p class="empty-state-title">${t('drive.noFilesYet')}</p>
        <p class="empty-state-hint">${t('drive.emptyStateHint')}</p>
        <button type="button" class="empty-state-btn">${t('drive.uploadFileTitle')}</button>`;
      emptyLi.querySelector('.empty-state-btn')?.addEventListener('click', () => openUploadModal());
      driveListEl.appendChild(emptyLi);
    }
  }

  function fileIconForName(name, contentType) {
    const ext = String(name || '').split('.').pop().toLowerCase();
    const ct = String(contentType || '').toLowerCase();
    if (ct.startsWith('image/') || ['jpg','jpeg','png','gif','webp','bmp','svg','heic','heif','avif'].includes(ext)) return 'image';
    if (ct.startsWith('video/') || ['mp4','mov','m4v','webm','avi','mkv'].includes(ext)) return 'film';
    if (ct.startsWith('audio/') || ['mp3','wav','m4a','aac','flac','ogg'].includes(ext)) return 'music';
    if (ext === 'pdf') return 'file-text';
    if (['doc','docx','rtf','odt','pages'].includes(ext)) return 'file';
    if (['xls','xlsx','csv','ods','numbers'].includes(ext)) return 'file-spreadsheet';
    if (['ppt','pptx','odp','key'].includes(ext)) return 'presentation';
    if (['zip','rar','7z','gz','tar','tgz','bz2'].includes(ext)) return 'archive';
    if (['txt','md','log','json','xml','yml','yaml'].includes(ext) || ct.startsWith('text/')) return 'file';
    return 'file';
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
    if (s.startsWith('image/')) return s.replace('image/', '').toUpperCase() + ' ' + t('drive.typeImage');
    if (s.startsWith('video/')) return s.replace('video/', '').toUpperCase() + ' ' + t('drive.typeVideo');
    if (s.startsWith('audio/')) return s.replace('audio/', '').toUpperCase() + ' ' + t('drive.typeAudio');
    if (s === 'application/pdf') return t('drive.typePdf');
    if (s.includes('word') || s.includes('document')) return t('drive.typeWord');
    if (s.includes('sheet') || s.includes('excel')) return t('drive.spreadsheet');
    if (s.includes('presentation') || s.includes('powerpoint')) return t('drive.presentation');
    if (s.includes('zip') || s.includes('compressed') || s.includes('archive') || s.includes('rar') || s.includes('7z') || s.includes('tar') || s.includes('gzip')) return t('drive.archive');
    if (s.startsWith('text/')) return s.replace('text/', '').toUpperCase() + ' ' + t('drive.typeText');
    if (s === 'application/octet-stream') return t('common.file');
    if (s === 'application/json') return 'JSON';
    return s;
  }

  function friendlyTimestamp(unixSec) {
    if (!unixSec) return '';
    const date = new Date(unixSec * 1000);
    const now = new Date();
    const diffMs = now - date;
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return t('common.justNow');
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return t('drive.minutesAgo', { count: diffMin });
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return t('drive.hoursAgo', { count: diffHr });
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 7) return t('drive.daysAgo', { count: diffDay });
    const y = date.getFullYear();
    const m = date.getMonth() + 1;
    const d = date.getDate();
    if (y === now.getFullYear()) return t('drive.monthDay', { month: m, day: d });
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
    if (title) title.textContent = type === 'folder' ? t('drive.renameFolder') : t('drive.renameFile');
    body.innerHTML = `
      <form id="renameForm" class="nickname-form">
        <label for="renameInput">${type === 'folder' ? t('drive.folderName') : t('drive.fileName')}</label>
        <input id="renameInput" type="text" value="${escapeHtml(name || '')}" autocomplete="off" spellcheck="false" />
        <p class="nickname-hint">${t('drive.nameCannotBeEmpty')}</p>
        <div class="nickname-actions">
          <button type="button" id="renameCancel" class="secondary">${t('common.cancel')}</button>
          <button type="submit" class="primary">${t('common.save')}</button>
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
      showModalLoading?.(t('drive.renaming'));
      updateLoadingModal?.({ percent: 12, text: t('drive.preparingRename') });
      try {
        if (type === 'folder') {
          await renameFolder(name, newName);
          updateLoadingModal?.({ percent: 55, text: t('drive.syncingFolderName') });
        } else if (type === 'file') {
          await renameFile(key, newName);
          updateLoadingModal?.({ percent: 55, text: t('drive.syncingFileName') });
        }
        updateLoadingModal?.({ percent: 85, text: t('drive.refreshingList') });
        await refreshDriveList();
        updateLoadingModal?.({ percent: 98, text: t('drive.done') });
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
    if (!entry) throw new Error(t('drive.fileNotFound'));
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
    if (!r.ok) throw new Error(t('drive.renameFailed') + JSON.stringify(data));
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
      if (!r.ok) throw new Error(t('drive.renameFailed') + JSON.stringify(data));
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
    if (title) title.textContent = t('drive.uploadFileTitle');
    body.innerHTML = `
      <form id="uploadForm" class="upload-form">
        <div class="upload-field">
          <input id="uploadFileInput" type="file" class="upload-input" multiple />
          <label for="uploadFileInput" class="upload-callout">
            <svg class="icon"><use href="#i-cloud-upload"/></svg>
            <span>${t('drive.clickToSelectFiles')}</span>
          </label>
        </div>
        <div id="uploadFileName" class="upload-name">${t('drive.noFileSelected')}</div>
        <ul id="uploadFileList" class="upload-file-list"></ul>
        <p class="upload-hint">${t('drive.iosSafariHint')}</p>
        <p class="upload-error" role="alert"></p>
        <div class="upload-actions">
          <button type="button" id="uploadCancel" class="secondary">${t('common.cancel')}</button>
          <button type="submit" class="primary">${t('common.upload')}</button>
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
      const safe = typeof name === 'string' && name.trim() ? name.trim() : t('drive.unnamed');
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
        if (nameEl) nameEl.textContent = t('drive.noFileSelected');
        if (listEl) listEl.innerHTML = '';
        if (errorEl) errorEl.textContent = '';
        return;
      }
      const oversized = files.filter((file) => Number(file?.size || 0) > MAX_UPLOAD_BYTES);
      if (oversized.length) {
        const msg = t('drive.singleFileLimit1GB', { name: escapeHtml(oversized[0].name || t('common.file')) });
        if (errorEl) errorEl.textContent = msg;
        showBlockingModal(msg, { title: t('drive.fileTooLarge') });
        input.value = '';
        if (nameEl) nameEl.textContent = t('drive.noFileSelected');
        if (listEl) listEl.innerHTML = '';
        return;
      }
      const totalSize = files.reduce((sum, f) => sum + (typeof f.size === 'number' ? f.size : 0), 0);
      if (nameEl) {
        nameEl.textContent = files.length === 1
          ? formatUploadFileName(files[0].name)
          : t('drive.filesCountSize', { count: files.length, size: fmtSize(totalSize) });
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
        if (errorEl) errorEl.textContent = t('drive.selectFileFirst');
        return;
      }
      const oversized = files.filter((file) => Number(file?.size || 0) > MAX_UPLOAD_BYTES);
      if (oversized.length) {
        const msg = t('drive.singleFileLimit1GB', { name: escapeHtml(oversized[0].name || t('common.file')) });
        if (errorEl) errorEl.textContent = msg;
        showBlockingModal(msg, { title: t('drive.fileTooLarge') });
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
    if (title) title.textContent = t('drive.newFolderTitle');
    body.innerHTML = `
      <form id="folderForm" class="folder-form">
        <label for="folderNameInput">${t('drive.folderName')}</label>
        <input id="folderNameInput" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="${t('drive.folderNamePlaceholder')}" />
        <p class="folder-hint">${t('drive.folderNameHint')}</p>
        <p class="folder-error" role="alert"></p>
        <div class="folder-actions">
          <button type="button" id="folderCancel" class="secondary">${t('common.cancel')}</button>
          <button type="submit" class="primary">${t('common.create')}</button>
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
        if (errorEl) errorEl.textContent = t('drive.folderNameEmpty');
        input?.focus();
        input?.select?.();
        return;
      }
      if (isReservedDir(safeName)) {
        if (errorEl) errorEl.textContent = t('drive.reservedFolderName');
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
      showModalLoading?.(t('drive.creatingFolder'));
      updateLoadingModal?.({ percent: 12, text: t('drive.preparingCreateFolder') });
      try {
        await createFolderPlaceholder(targetPath);
        updateLoadingModal?.({ percent: 55, text: t('drive.syncingFolder') });
        await refreshDriveList();
        updateLoadingModal?.({ percent: 95, text: t('drive.done') });
        setTimeout(() => closeModal?.(), 120);
      } catch (err) {
        log({ driveListError: String(err?.message || err) });
        closeModal?.();
        showBlockingModal(t('drive.createFolderFailed'), { title: t('errors.createFailed') });
      }
    }, { once: true });
  }

  async function startUploadQueue(selectedFiles) {
    const files = Array.isArray(selectedFiles) ? selectedFiles.filter(Boolean) : [];
    if (!files.length) return;
    const oversized = files.filter((file) => Number(file?.size || 0) > MAX_UPLOAD_BYTES);
    if (oversized.length) {
      const name = escapeHtml(oversized[0].name || t('common.file'));
      showBlockingModal(t('drive.cannotUploadExceeds1GB', { name }), { title: t('drive.fileTooLarge') });
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
        showBlockingModal(t('drive.cloudSpaceInsufficient'), { title: t('drive.spaceInsufficient') });
        return;
      }
    }
    const acct = (getAccountDigest() || '').toUpperCase();
    if (!acct) {
      showBlockingModal(t('drive.notLoggedInRelogin'), { title: t('drive.notLoggedIn') });
      return;
    }
    const convId = driveState.currentConvId || `drive-${acct}`;
    showProgressModal?.(files.length === 1 ? (files[0].name || t('common.file')) : t('drive.nFiles', { count: files.length }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const titleEl = document.querySelector('.progress-wrap .progress-title');
    const subtitleEl = document.querySelector('.progress-wrap .progress-subtitle');
    const pctEl = document.getElementById('progressPercent');
    const textEl = document.getElementById('progressText');
    const innerEl = document.getElementById('progressInner');
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (titleEl) titleEl.textContent = file.name || t('common.file');
        if (subtitleEl) subtitleEl.textContent = files.length > 1 ? t('drive.fileNofM', { current: i + 1, total: files.length }) : t('drive.uploading');
        if (innerEl) innerEl.style.width = '0%';
        if (pctEl) pctEl.innerHTML = '0<span>%</span>';
        if (textEl) textEl.textContent = '';
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
        if (pctEl) pctEl.innerHTML = '100<span>%</span>';
        if (textEl) textEl.textContent = files.length > 1 ? t('drive.completedNofM', { current: i + 1, total: files.length }) : '';
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      completeProgressModal?.();
      await new Promise((resolve) => setTimeout(resolve, 880));
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

  async function doPreview(key, contentTypeHint, nameHint, chunkedMeta) {
    const ct = (contentTypeHint || '').toLowerCase();
    const resolvedName = nameHint || key.split('/').pop() || 'download.bin';

    // ── Chunked video: use MSE streaming (no full download) ──
    if (chunkedMeta?.chunked && ct.startsWith('video/')) {
      closeModal?.();
      try {
        await doChunkedVideoPreview(chunkedMeta, ct, resolvedName);
      } catch (err) {
        log({ chunkedVideoPreviewError: err?.message || err });
      }
      return;
    }

    // ── Chunked non-video: download all chunks then preview ──
    if (chunkedMeta?.chunked) {
      showModalLoading?.(t('drive.downloadEncryptedFile'));
      try {
        cleanupPdfViewer();
        const { downloadChunkedManifest, downloadAllChunks } = await import('../../features/chunked-download.js');
        updateLoadingModal?.({ percent: 5, text: t('drive.gettingDecryptInfo') });
        const manifest = await downloadChunkedManifest({
          baseKey: chunkedMeta.baseKey,
          manifestEnvelope: chunkedMeta.manifestEnvelope
        });
        updateLoadingModal?.({ percent: 10, text: t('drive.downloadingEncryptedChunks') });
        const result = await downloadAllChunks({
          baseKey: chunkedMeta.baseKey,
          manifest,
          manifestEnvelope: chunkedMeta.manifestEnvelope,
          onProgress: ({ percent: pct }) => {
            if (Number.isFinite(pct)) {
              const mapped = 10 + Math.round(pct * 0.85);
              updateLoadingModal?.({ percent: mapped, text: `${t('drive.downloadingEncryptedChunks')} ${pct}%` });
            }
          }
        });
        updateLoadingModal?.({ percent: 98, text: t('drive.assemblingFile') });
        doPreviewFromBlob(result.blob, result.contentType || ct, result.name || resolvedName);
      } catch (err) {
        closeModal?.();
        throw err;
      }
      return;
    }

    // ── Standard single-object file ──
    showModalLoading?.(t('drive.downloadEncryptedFile'));
    const envelope = findEnvelopeInMessages(driveState.currentMessages, key);
    try {
      cleanupPdfViewer();
      const { blob, contentType, name } = await downloadAndDecrypt({
        key,
        envelope,
        onProgress: ({ stage, loaded, total }) => {
          if (stage === 'sign') {
            updateLoadingModal?.({ percent: 5, text: t('drive.gettingDownloadAuth') });
          } else if (stage === 'download-start') {
            updateLoadingModal?.({ percent: 10, text: t('drive.downloadingEncryptedFile') });
          } else if (stage === 'download') {
            const pct = total && total > 0 ? Math.round((loaded / total) * 100) : null;
            const percent = pct != null ? Math.min(95, Math.max(15, pct)) : 45;
            const text = pct != null
              ? `${t('drive.downloadingEncryptedFile')} ${pct}% (${fmtSize(loaded)} / ${fmtSize(total)})`
              : `${t('drive.downloadingEncryptedFile')} (${fmtSize(loaded)})`;
            updateLoadingModal?.({ percent, text });
          } else if (stage === 'decrypt') {
            updateLoadingModal?.({ percent: 98, text: t('drive.decryptingFile') });
          }
        }
      });
      doPreviewFromBlob(blob, contentType || ct, name || resolvedName);
    } catch (err) {
      closeModal?.();
      throw err;
    }
  }

  /**
   * Render a preview from an already-downloaded blob (shared by single + chunked non-video paths).
   */
  function doPreviewFromBlob(blob, contentType, resolvedName) {
    const body = document.getElementById('modalBody');
    const title = document.getElementById('modalTitle');
    if (!body || !title) {
      closeModal?.();
      return;
    }

    // Clear stale modal classes before opening a new viewer
    const modalEl = document.getElementById('modal');
    if (modalEl) {
      modalEl.classList.remove(
        'loading-modal', 'progress-modal',
        'pdf-modal', 'excel-modal', 'word-modal', 'pptx-modal', 'zip-modal'
      );
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

    const ct = (contentType || '').toLowerCase();

    if (ct === 'application/pdf' || ct.startsWith('application/pdf')) {
      renderPdfViewer({
        url,
        name: resolvedName,
        modalApi: { openModal, closeModal, showConfirmModal }
      }).then((handled) => {
        if (handled) return;
        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.className = 'viewer';
        iframe.title = resolvedName;
        wrap.appendChild(iframe);
        openModal?.();
      });
      return;
    } else if (isExcelMime(ct) || isExcelFilename(resolvedName)) {
      renderExcelViewer({
        url,
        blob,
        name: resolvedName,
        modalApi: { openModal, closeModal, showConfirmModal }
      }).then((handled) => {
        if (handled) return;
        const msg = document.createElement('div');
        msg.className = 'preview-message';
        msg.textContent = t('drive.cannotPreviewType', { type: ct });
        wrap.appendChild(msg);
        openModal?.();
      });
      return;
    } else if (isWordMime(ct) || isWordFilename(resolvedName)) {
      renderWordViewer({
        url,
        blob,
        name: resolvedName,
        modalApi: { openModal, closeModal, showConfirmModal }
      }).then((handled) => {
        if (handled) return;
        const msg = document.createElement('div');
        msg.className = 'preview-message';
        msg.textContent = t('drive.cannotPreviewType', { type: ct });
        wrap.appendChild(msg);
        openModal?.();
      });
      return;
    } else if (isPptxMime(ct) || isPptxFilename(resolvedName)) {
      renderPptxViewer({
        url,
        blob,
        name: resolvedName,
        modalApi: { openModal, closeModal, showConfirmModal }
      }).then((handled) => {
        if (handled) return;
        const msg = document.createElement('div');
        msg.className = 'preview-message';
        msg.textContent = t('drive.cannotPreviewType', { type: ct });
        wrap.appendChild(msg);
        openModal?.();
      });
      return;
    } else if (isZipMime(ct) || isZipFilename(resolvedName)) {
      renderZipViewer({
        url,
        blob,
        name: resolvedName,
        modalApi: { openModal, closeModal, showConfirmModal }
      }).then((handled) => {
        if (handled) return;
        const msg = document.createElement('div');
        msg.className = 'preview-message';
        msg.textContent = t('drive.cannotPreviewType', { type: ct });
        wrap.appendChild(msg);
        openModal?.();
      });
      return;
    } else if (ct.startsWith('image/')) {
      // Use full-screen image viewer with drive save support
      setModalObjectUrl?.(null);
      closeModal?.();
      openImageViewer({
        url,
        blob,
        name: resolvedName,
        contentType: ct,
        source: 'drive',
        onSaveToDrive: async (editedBlob, mode, editedName) => {
          const saveName = editedName || resolvedName;
          const saveFile = new File([editedBlob], saveName, { type: 'image/png' });
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
        blob.text().then((textContent) => {
          const pre = document.createElement('pre');
          pre.textContent = textContent;
          wrap.appendChild(pre);
        });
      } catch (err) {
        const msg = document.createElement('div');
        msg.className = 'preview-message';
        msg.textContent = t('drive.cannotDisplayTextContent');
        wrap.appendChild(msg);
      }
    } else {
      const message = document.createElement('div');
      message.className = 'preview-message';
      message.textContent = t('drive.cannotPreviewType', { type: ct });
      wrap.appendChild(message);
      const link = document.createElement('a');
      link.href = url;
      link.download = resolvedName;
      link.textContent = t('drive.downloadFile');
      link.className = 'preview-download';
      wrap.appendChild(link);
    }

    openModal?.();
  }

  /**
   * Stream a chunked video from the drive using MSE (same approach as chat video player).
   * Opens the full-screen video viewer with progressive chunk download + MSE playback.
   */
  async function doChunkedVideoPreview(chunkedMeta, contentType, name) {
    const { downloadChunkedManifest, streamChunks } = await import('../../features/chunked-download.js');
    const { openVideoViewer, cleanupVideoViewer } = await import('./viewers/video-viewer.js');
    const { createMsePlayer, buildMimeFromCodecString, detectCodecFromInitSegment, isValidMseInitSegment, parseMoofTiming, parseInitTimescales } = await import('../../features/mse-player.js');
    const { mergeInitSegments } = await import('../../features/mp4-remuxer.js');

    cleanupVideoViewer();

    // Download manifest first
    const manifest = await downloadChunkedManifest({
      baseKey: chunkedMeta.baseKey,
      manifestEnvelope: chunkedMeta.manifestEnvelope
    });

    if (!manifest.segment_aligned || !manifest.tracks) {
      // Non-segment-aligned: fall back to full download + blob URL
      const { downloadAllChunks } = await import('../../features/chunked-download.js');
      showModalLoading?.(t('drive.downloadingVideo'));
      const result = await downloadAllChunks({
        baseKey: chunkedMeta.baseKey,
        manifest,
        manifestEnvelope: chunkedMeta.manifestEnvelope,
        onProgress: ({ percent }) => {
          updateLoadingModal?.({ percent: Math.min(95, percent), text: `${t('drive.downloadingVideo')} ${percent}%` });
        }
      });
      doPreviewFromBlob(result.blob, result.contentType || contentType, result.name || name);
      return;
    }

    const manifestTracks = Array.isArray(manifest.tracks) ? manifest.tracks : [];
    const numTracks = manifestTracks.length || 1;

    const downloadAbort = new AbortController();
    let blobUrl = null;
    let msePlayer = null;

    const viewer = openVideoViewer({
      name,
      onClose: () => {
        try { downloadAbort.abort(); } catch {}
        if (msePlayer) { try { msePlayer.destroy(); } catch {} msePlayer = null; }
        if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch {} blobUrl = null; }
      }
    });

    const video = viewer.video;

    try {
      // Create MSE player
      const createPlayer = () => createMsePlayer({
        videoElement: video,
        onError: (err) => console.warn('[drive-mse] segment error:', err?.message)
      });
      msePlayer = createPlayer();
      viewer.setMsePlayer(msePlayer);
      await msePlayer.open();
      video.play().catch(() => {});

      let mseInitialized = false;
      let useBlobFallback = false;
      const blobParts = [];
      const initChunks = [];
      const chunkCache = [];
      const chunkTimeIndex = [];
      let timescaleMap = null;
      let chunksReceived = 0;
      let bytesReceived = 0;
      const isLegacyMultiTrack = manifest.v < 3 && numTracks > 1;

      // canplay handler
      let firstMediaAppended = false;
      video.addEventListener('canplay', () => {
        if (!firstMediaAppended) {
          firstMediaAppended = true;
          viewer.hideBuffering();
          if (video.paused) video.play().catch(() => {});
        }
      }, { once: true });

      // Init MSE with codec detection + fallback
      const tryInitMse = async (initData, primaryMimeCodec) => {
        const codecs = [];
        if (primaryMimeCodec) codecs.push(primaryMimeCodec);
        const detected = detectCodecFromInitSegment(initData, 'muxed');
        if (detected && !codecs.includes(detected)) codecs.push(detected);
        const fallbacks = ['avc1.42E01E,mp4a.40.2', 'avc1.4D401E,mp4a.40.2', 'avc1.64001E,mp4a.40.2'];
        for (const cs of fallbacks) {
          const m = buildMimeFromCodecString(cs);
          if (m && !codecs.includes(m)) codecs.push(m);
        }
        if (!codecs.length) throw new Error(t('mediaHandling.cannotDetectVideoCodec'));

        for (let i = 0; i < codecs.length; i++) {
          try {
            if (i > 0) {
              try { msePlayer.destroy(); } catch {}
              video.src = '';
              video.load();
              msePlayer = createPlayer();
              viewer.setMsePlayer(msePlayer);
              await msePlayer.open();
              video.play().catch(() => {});
            }
            msePlayer.addSourceBuffer('muxed', codecs[i]);
            msePlayer.resumeQueues();
            await Promise.race([
              msePlayer.appendChunk('muxed', initData),
              new Promise((_, rej) => setTimeout(() => rej(new Error('init timeout')), 5000))
            ]);
            return;
          } catch (err) {
            if (i === codecs.length - 1) throw err;
          }
        }
      };

      for await (const { data, index } of streamChunks({
        baseKey: chunkedMeta.baseKey,
        manifest,
        manifestEnvelope: chunkedMeta.manifestEnvelope,
        abortSignal: downloadAbort.signal,
        onProgress: ({ percent }) => {
          viewer.updateChunkStats({ received: chunksReceived, total: manifest.totalChunks });
        }
      })) {
        chunksReceived++;
        bytesReceived += (data?.byteLength || 0);
        viewer.updateChunkStats({ received: chunksReceived, bytes: bytesReceived });
        chunkCache[index] = new Blob([data]);

        if (useBlobFallback) {
          blobParts.push(data);
          continue;
        }

        const isInitSegment = index < numTracks;

        if (isInitSegment) {
          let initData = data;
          let primaryMime = null;

          if (isLegacyMultiTrack) {
            initChunks.push(data);
            if (initChunks.length < numTracks) continue;
            initData = mergeInitSegments(initChunks);
            const manifestCodec = manifestTracks.map(t => t.codec).filter(Boolean).join(',');
            primaryMime = manifestCodec ? buildMimeFromCodecString(manifestCodec) : null;
          } else {
            const track = manifestTracks[0];
            primaryMime = track?.codec ? buildMimeFromCodecString(track.codec) : null;
          }

          if (!isValidMseInitSegment(initData)) {
            useBlobFallback = true;
            blobParts.push(initData);
            try { msePlayer.destroy(); } catch {}
            msePlayer = null;
            continue;
          }

          try {
            await tryInitMse(initData, primaryMime);
            mseInitialized = true;
            timescaleMap = parseInitTimescales(initData);
            if (manifest.duration && msePlayer) msePlayer.setDuration(manifest.duration);
          } catch (initErr) {
            console.warn('[drive-video] MSE init failed:', initErr?.message);
            useBlobFallback = true;
            blobParts.push(initData);
            try { msePlayer.destroy(); } catch {}
            msePlayer = null;
            continue;
          }
        } else {
          if (!mseInitialized) continue;

          const timing = parseMoofTiming(data, timescaleMap);
          chunkTimeIndex[index] = timing;

          try {
            await msePlayer.appendChunk('muxed', data);
          } catch (appendErr) {
            console.warn(`[drive-video] segment ${index} append failed:`, appendErr?.message);
          }
        }
      }

      if (useBlobFallback) {
        const blob = new Blob(blobParts, { type: contentType || 'video/mp4' });
        blobParts.length = 0;
        blobUrl = URL.createObjectURL(blob);
        video.src = blobUrl;
        video.load();
        video.addEventListener('canplay', () => viewer.hideBuffering(), { once: true });
        try { await video.play(); } catch {}
      } else if (msePlayer) {
        await msePlayer.endOfStream();
      }

      viewer.hideBuffering();

    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error('[drive-video] streaming failed:', err?.message);
      viewer.destroy();
      log({ driveVideoError: err?.message || err });
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
        title: t('drive.confirmDelete'),
        message: t('drive.confirmDeleteFile', { name: escapeHtml(name || key) }),
        confirmLabel: t('drive.deleteAriaLabel'),
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
      log({ deleteInfo: t('drive.folderNoFiles', { name: folderName }) });
      return;
    }

    const keys = Array.from(new Set(targetMessages.map((m) => m.objKey)));
    const ids = Array.from(new Set(targetMessages.map((m) => m.id).filter(Boolean)));

    if (element) closeSwipe?.(element);
    showConfirmModal?.({
      title: t('drive.confirmDelete'),
      message: visibleCount > 0
        ? t('drive.deleteFolderWithCount', { name: escapeHtml(folderName), count: visibleCount })
        : t('drive.deleteFolderEmpty', { name: escapeHtml(folderName) }),
      confirmLabel: t('drive.deleteAriaLabel'),
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
    throw new Error(t('drive.missingEnvelopeData'));
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
