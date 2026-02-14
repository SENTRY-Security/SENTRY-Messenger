/**
 * Image Viewer & Editor Module
 * Full-screen image preview with zoom/pan, plus editing capabilities:
 * - Crop (via Cropper.js, already bundled)
 * - Draw / Brush (via Fabric.js, loaded on demand from CDN)
 * - Zoom in/out
 * - Undo / Reset
 * - Send (chat) or Save (drive) edited result
 */

import { log } from '../../../core/log.js';
import Cropper from '../../../lib/vendor/cropper.esm.js';

/* ── Fabric.js lazy loader (CDN, same pattern as PDF.js) ── */
let fabricLibPromise = null;

async function getFabric() {
  if (fabricLibPromise) return fabricLibPromise;
  fabricLibPromise = import('https://cdn.jsdelivr.net/npm/fabric@6/+esm')
    .then(mod => {
      // Handle different module structures (ESM default export vs namespace)
      const ns = mod.default || mod.fabric || mod;
      return ns;
    })
    .catch(err => { fabricLibPromise = null; throw err; });
  return fabricLibPromise;
}

/* ── State ── */
let activeCleanup = null;

export function cleanupImageViewer() {
  if (typeof activeCleanup === 'function') {
    try { activeCleanup(); } catch {}
  }
  activeCleanup = null;
}

/* ── Colour presets for brush ── */
const BRUSH_COLORS = [
  { color: '#ffffff', label: '白' },
  { color: '#ef4444', label: '紅' },
  { color: '#facc15', label: '黃' },
  { color: '#22c55e', label: '綠' },
  { color: '#3b82f6', label: '藍' },
  { color: '#0f172a', label: '黑' },
];
const BRUSH_SIZES = [
  { size: 3,  label: 'S' },
  { size: 8,  label: 'M' },
  { size: 16, label: 'L' },
];

/**
 * Open the full-screen image viewer.
 *
 * @param {Object} opts
 * @param {string} opts.url          – Object-URL of the image
 * @param {Blob}   opts.blob         – Original image blob
 * @param {string} opts.name         – Display name
 * @param {string} opts.contentType  – MIME type
 * @param {'chat'|'drive'} opts.source – Where the image was opened from
 * @param {Function} [opts.onSendToChat]   – (editedFile: File) => Promise  (chat context)
 * @param {Function} [opts.onSaveToDrive]  – (editedBlob: Blob, mode: 'overwrite'|'new', name: string) => Promise  (drive context)
 * @param {Function} [opts.onClose]        – Called when viewer is closed
 * @param {string}   [opts.originalKey]    – Object key for overwrite in drive
 */
export async function openImageViewer(opts) {
  const {
    url, blob, name = '圖片', contentType = 'image/png',
    source = 'chat',
    onSendToChat, onSaveToDrive, onClose, originalKey
  } = opts;

  cleanupImageViewer();

  /* ── Build overlay DOM ── */
  const overlay = document.createElement('div');
  overlay.className = 'iv-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', name);

  overlay.innerHTML = `
    <div class="iv-toolbar">
      <button type="button" class="iv-btn" data-action="close" aria-label="關閉">
        <svg viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="iv-title">${escHtml(name)}</div>
      <div class="iv-actions">
        <button type="button" class="iv-btn" data-action="download" aria-label="下載">
          <svg viewBox="0 0 24 24" fill="none"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2h16v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <button type="button" class="iv-btn" data-action="edit" aria-label="編輯">
          <svg viewBox="0 0 24 24" fill="none"><path d="M15.232 5.232l3.536 3.536M9 13l-2 6 6-2 9.364-9.364a2.5 2.5 0 00-3.536-3.536L9 13z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>
    <div class="iv-stage" id="ivStage">
      <img class="iv-image" alt="${escHtml(name)}" />
    </div>

    <!-- Editor layer (hidden initially) -->
    <div class="iv-editor" style="display:none">
      <div class="iv-toolbar iv-editor-toolbar">
        <button type="button" class="iv-btn" data-action="editor-close" aria-label="返回預覽">
          <svg viewBox="0 0 24 24" fill="none"><path d="M15 19l-7-7 7-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="iv-title">編輯</div>
        <div class="iv-actions">
          <button type="button" class="iv-btn" data-action="undo" aria-label="上一步" disabled>
            <svg viewBox="0 0 24 24" fill="none"><path d="M3 10h13a4 4 0 010 8H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M7 14L3 10l4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="iv-btn" data-action="reset" aria-label="取消所有變更">
            <svg viewBox="0 0 24 24" fill="none"><path d="M1 4v6h6M23 20v-6h-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>

      <div class="iv-canvas-stage">
        <canvas class="iv-canvas"></canvas>
        <img class="iv-crop-img" style="display:none" />
      </div>

      <!-- Brush sub-toolbar (hidden unless drawing) -->
      <div class="iv-brush-bar" style="display:none">
        <div class="iv-color-row"></div>
        <div class="iv-size-row"></div>
      </div>

      <!-- Crop confirm bar (hidden unless cropping) -->
      <div class="iv-crop-bar" style="display:none">
        <button type="button" class="iv-btn iv-crop-cancel" data-action="crop-cancel" aria-label="取消裁切">
          <svg viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="iv-crop-label">調整裁切區域</span>
        <button type="button" class="iv-btn iv-crop-confirm" data-action="crop-confirm" aria-label="確認裁切">
          <svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>

      <div class="iv-editor-footer">
        <div class="iv-tools">
          <button type="button" class="iv-tool-btn" data-tool="crop" aria-label="裁切">
            <svg viewBox="0 0 24 24" fill="none"><path d="M6 2v4H2v2h4v10h10v4h2v-4h4v-2H8V6h10v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="iv-tool-btn" data-tool="draw" aria-label="畫筆">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 19l7-7 3 3-7 7-3-3z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6.5" cy="10.5" r="1.5" fill="currentColor"/></svg>
          </button>
          <button type="button" class="iv-tool-btn" data-tool="zoom-in" aria-label="放大">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35M11 8v6M8 11h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button type="button" class="iv-tool-btn" data-tool="zoom-out" aria-label="縮小">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35M8 11h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <button type="button" class="iv-action-btn" data-action="save" style="display:none" aria-label="${source === 'chat' ? '發送' : '儲存'}">
          ${source === 'chat'
            ? '<svg viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 21v-8H7v8M7 3v5h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          }
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  /* ── Query elements ── */
  const stage    = overlay.querySelector('.iv-stage');
  const img      = overlay.querySelector('.iv-image');
  const editorEl = overlay.querySelector('.iv-editor');
  const canvas   = overlay.querySelector('.iv-canvas');
  const cropImg  = overlay.querySelector('.iv-crop-img');
  const brushBar = overlay.querySelector('.iv-brush-bar');
  const cropBar  = overlay.querySelector('.iv-crop-bar');
  const footer   = overlay.querySelector('.iv-editor-footer');
  const undoBtn  = overlay.querySelector('[data-action="undo"]');
  const resetBtn = overlay.querySelector('[data-action="reset"]');
  const saveBtn  = overlay.querySelector('[data-action="save"]');

  /* ── Preview mode: load image ── */
  img.src = url;

  /* ── Preview zoom/pan state ── */
  let previewScale = 1;
  let previewTx = 0;
  let previewTy = 0;
  const applyPreviewTransform = () => {
    img.style.transform = `translate(${previewTx}px, ${previewTy}px) scale(${previewScale})`;
  };

  /* Pointer-based pinch/pan for preview */
  const activePointers = new Map();
  let pinchStartDist = null;
  let pinchStartScale = 1;
  let pinchStartMid = null;
  let pinchStartTx = 0;
  let pinchStartTy = 0;
  let panStart = null;
  let lastTapTime = 0;

  const pointerDist = () => {
    if (activePointers.size < 2) return 0;
    const pts = Array.from(activePointers.values());
    const dx = pts[0].x - pts[1].x;
    const dy = pts[0].y - pts[1].y;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const pointerMid = () => {
    const pts = Array.from(activePointers.values());
    if (pts.length < 2) return { x: pts[0]?.x || 0, y: pts[0]?.y || 0 };
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
  };

  const onStagePointerDown = (e) => {
    stage.setPointerCapture(e.pointerId);
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size === 2) {
      pinchStartDist = pointerDist();
      pinchStartScale = previewScale;
      pinchStartMid = pointerMid();
      pinchStartTx = previewTx;
      pinchStartTy = previewTy;
      panStart = null;
    } else if (activePointers.size === 1) {
      // Double-tap detection
      const now = Date.now();
      if (now - lastTapTime < 300) {
        previewScale = previewScale > 1.5 ? 1 : 3;
        previewTx = 0;
        previewTy = 0;
        applyPreviewTransform();
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
      if (previewScale > 1) {
        panStart = { x: e.clientX, y: e.clientY, tx: previewTx, ty: previewTy };
      }
    }
  };

  const onStagePointerMove = (e) => {
    if (!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.size >= 2 && pinchStartDist) {
      e.preventDefault();
      const dist = pointerDist();
      previewScale = Math.min(6, Math.max(0.5, pinchStartScale * (dist / pinchStartDist)));
      // Track midpoint movement for two-finger pan
      const mid = pointerMid();
      previewTx = pinchStartTx + (mid.x - pinchStartMid.x);
      previewTy = pinchStartTy + (mid.y - pinchStartMid.y);
      applyPreviewTransform();
    } else if (panStart && activePointers.size === 1) {
      e.preventDefault();
      const p = activePointers.get(e.pointerId);
      previewTx = panStart.tx + (p.x - panStart.x);
      previewTy = panStart.ty + (p.y - panStart.y);
      applyPreviewTransform();
    }
  };

  const onStagePointerUp = (e) => {
    stage.releasePointerCapture?.(e.pointerId);
    activePointers.delete(e.pointerId);
    if (activePointers.size < 2) {
      pinchStartDist = null;
      // Seamless transition: if one finger remains after pinch, allow immediate single-finger pan
      if (activePointers.size === 1 && previewScale > 1) {
        const remaining = activePointers.values().next().value;
        panStart = { x: remaining.x, y: remaining.y, tx: previewTx, ty: previewTy };
      }
    }
    if (activePointers.size === 0) panStart = null;
  };

  stage.addEventListener('pointerdown', onStagePointerDown);
  stage.addEventListener('pointermove', onStagePointerMove);
  stage.addEventListener('pointerup', onStagePointerUp);
  stage.addEventListener('pointercancel', onStagePointerUp);
  stage.style.touchAction = 'none';

  /* Prevent context menu on long-press */
  overlay.addEventListener('contextmenu', e => e.preventDefault());

  /* ── Editor state ── */
  let fabricCanvas = null;
  let editorOpen = false;
  let cropper = null;
  let activeTool = null;
  let historyStack = [];
  let hasChanges = false;
  let originalImageDataUrl = null;
  let currentBrushColor = BRUSH_COLORS[0].color;
  let currentBrushSize = BRUSH_SIZES[1].size;

  /* ── Build brush sub-toolbar ── */
  const colorRow = brushBar.querySelector('.iv-color-row');
  const sizeRow = brushBar.querySelector('.iv-size-row');

  BRUSH_COLORS.forEach(({ color, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'iv-color-dot';
    btn.setAttribute('aria-label', label);
    btn.style.background = color;
    if (color === '#ffffff') btn.style.border = '2px solid rgba(255,255,255,0.6)';
    if (color === currentBrushColor) btn.classList.add('active');
    btn.addEventListener('click', () => {
      currentBrushColor = color;
      colorRow.querySelectorAll('.iv-color-dot').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (fabricCanvas) {
        fabricCanvas.freeDrawingBrush.color = color;
      }
    });
    colorRow.appendChild(btn);
  });

  BRUSH_SIZES.forEach(({ size, label }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'iv-size-btn';
    btn.textContent = label;
    if (size === currentBrushSize) btn.classList.add('active');
    btn.addEventListener('click', () => {
      currentBrushSize = size;
      sizeRow.querySelectorAll('.iv-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (fabricCanvas) {
        fabricCanvas.freeDrawingBrush.width = size;
      }
    });
    sizeRow.appendChild(btn);
  });

  /* ── Helper: push undo state ── */
  const pushUndo = () => {
    if (!fabricCanvas) return;
    historyStack.push(fabricCanvas.toJSON());
    if (historyStack.length > 50) historyStack.shift();
    undoBtn.disabled = false;
    hasChanges = true;
    saveBtn.style.display = '';
  };

  /* ── Helper: get image as original data URL ── */
  const loadOriginalDataUrl = () => {
    return new Promise((resolve) => {
      if (originalImageDataUrl) { resolve(originalImageDataUrl); return; }
      const c = document.createElement('canvas');
      const tempImg = new Image();
      tempImg.onload = () => {
        c.width = tempImg.naturalWidth;
        c.height = tempImg.naturalHeight;
        c.getContext('2d').drawImage(tempImg, 0, 0);
        originalImageDataUrl = c.toDataURL('image/png');
        resolve(originalImageDataUrl);
      };
      tempImg.onerror = () => resolve(url);
      tempImg.src = url;
    });
  };

  /* ── Enter editor mode ── */
  const enterEditor = async () => {
    if (editorOpen) return;
    editorOpen = true;
    stage.style.display = 'none';
    overlay.querySelector('.iv-toolbar').style.display = 'none';
    editorEl.style.display = '';

    try {
      const fabric = await getFabric();
      const FabricCanvas = fabric.Canvas;
      const FabricImage = fabric.FabricImage || fabric.Image;

      // Wait for image to load fully
      await new Promise((resolve) => {
        if (img.complete && img.naturalWidth) { resolve(); return; }
        img.onload = resolve;
        img.onerror = resolve;
      });

      const natW = img.naturalWidth || 800;
      const natH = img.naturalHeight || 600;

      // Fit canvas to screen
      const stageRect = overlay.querySelector('.iv-canvas-stage').getBoundingClientRect();
      const maxW = stageRect.width || window.innerWidth;
      const maxH = stageRect.height || (window.innerHeight - 140);
      const ratio = Math.min(maxW / natW, maxH / natH, 1);
      const displayW = Math.round(natW * ratio);
      const displayH = Math.round(natH * ratio);

      canvas.width = displayW;
      canvas.height = displayH;
      canvas.style.width = displayW + 'px';
      canvas.style.height = displayH + 'px';

      fabricCanvas = new FabricCanvas(canvas, {
        width: displayW,
        height: displayH,
        isDrawingMode: false,
        selection: false,
        backgroundColor: '#000',
      });

      // Load image as background
      const dataUrl = await loadOriginalDataUrl();
      const fabricImg = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
      fabricImg.scaleToWidth(displayW);
      fabricImg.scaleToHeight(displayH);
      fabricCanvas.backgroundImage = fabricImg;
      fabricCanvas.renderAll();

      // Set up brush
      fabricCanvas.freeDrawingBrush.color = currentBrushColor;
      fabricCanvas.freeDrawingBrush.width = currentBrushSize;

      // Save initial state
      historyStack = [fabricCanvas.toJSON()];
      hasChanges = false;
      undoBtn.disabled = true;
      saveBtn.style.display = 'none';

      // Listen for drawing changes
      fabricCanvas.on('path:created', () => pushUndo());
    } catch (err) {
      log({ imageEditorInitError: err?.message || err });
      exitEditor();
    }
  };

  /* ── Exit editor mode ── */
  const exitEditor = () => {
    deactivateTool();
    if (cropper) { cropper.destroy(); cropper = null; }
    if (fabricCanvas) {
      try { fabricCanvas.dispose(); } catch {}
      fabricCanvas = null;
    }
    editorOpen = false;
    stage.style.display = '';
    overlay.querySelector('.iv-toolbar').style.display = '';
    editorEl.style.display = 'none';
    historyStack = [];
    hasChanges = false;
  };

  /* ── Helper: Fabric.js wraps canvas in .canvas-container ── */
  const getFabricWrapper = () => canvas.parentElement?.classList?.contains('canvas-container')
    ? canvas.parentElement
    : canvas;

  /* ── Tool activation ── */
  const deactivateTool = () => {
    // Deactivate crop
    if (cropper) {
      cropper.destroy();
      cropper = null;
      cropImg.style.display = 'none';
      getFabricWrapper().style.display = '';
      cropBar.style.display = 'none';
      footer.style.display = '';
    }
    // Deactivate draw
    if (fabricCanvas) fabricCanvas.isDrawingMode = false;
    brushBar.style.display = 'none';
    activeTool = null;
    overlay.querySelectorAll('.iv-tool-btn').forEach(b => b.classList.remove('active'));
  };

  const activateCrop = () => {
    if (activeTool === 'crop') { deactivateTool(); return; }
    deactivateTool();
    activeTool = 'crop';
    overlay.querySelector('[data-tool="crop"]').classList.add('active');

    // Export current canvas to image for Cropper.js
    const dataUrl = fabricCanvas.toDataURL({ format: 'png' });
    cropImg.src = dataUrl;
    cropImg.style.display = '';
    getFabricWrapper().style.display = 'none';
    footer.style.display = 'none';
    cropBar.style.display = '';

    cropper = new Cropper(cropImg, {
      viewMode: 1,
      dragMode: 'crop',
      autoCropArea: 0.85,
      responsive: true,
      background: false,
      modal: true,
      guides: true,
      center: true,
      highlight: true,
      cropBoxMovable: true,
      cropBoxResizable: true,
      toggleDragModeOnDblclick: false,
    });
  };

  const confirmCrop = async () => {
    if (!cropper || !fabricCanvas) return;
    const croppedCanvas = cropper.getCroppedCanvas();
    if (!croppedCanvas) { deactivateTool(); return; }

    const croppedUrl = croppedCanvas.toDataURL('image/png');
    cropper.destroy();
    cropper = null;
    cropImg.style.display = 'none';
    getFabricWrapper().style.display = '';
    cropBar.style.display = 'none';
    footer.style.display = '';
    activeTool = null;
    overlay.querySelectorAll('.iv-tool-btn').forEach(b => b.classList.remove('active'));

    // Reload fabric canvas with cropped image
    const fabric = await getFabric();
    const FabricImage = fabric.FabricImage || fabric.Image;

    const cw = croppedCanvas.width;
    const ch = croppedCanvas.height;
    const stageRect = overlay.querySelector('.iv-canvas-stage').getBoundingClientRect();
    const maxW = stageRect.width || window.innerWidth;
    const maxH = stageRect.height || (window.innerHeight - 140);
    const ratio = Math.min(maxW / cw, maxH / ch, 1);
    const displayW = Math.round(cw * ratio);
    const displayH = Math.round(ch * ratio);

    fabricCanvas.setDimensions({ width: displayW, height: displayH });
    fabricCanvas.clear();

    const fabricImg = await FabricImage.fromURL(croppedUrl, { crossOrigin: 'anonymous' });
    fabricImg.scaleToWidth(displayW);
    fabricImg.scaleToHeight(displayH);
    fabricCanvas.backgroundImage = fabricImg;
    fabricCanvas.renderAll();

    pushUndo();
  };

  const activateDraw = () => {
    if (activeTool === 'draw') { deactivateTool(); return; }
    deactivateTool();
    activeTool = 'draw';
    overlay.querySelector('[data-tool="draw"]').classList.add('active');
    brushBar.style.display = '';
    if (fabricCanvas) {
      fabricCanvas.isDrawingMode = true;
      fabricCanvas.freeDrawingBrush.color = currentBrushColor;
      fabricCanvas.freeDrawingBrush.width = currentBrushSize;
    }
  };

  const doZoom = (dir) => {
    if (!fabricCanvas) return;
    const curZoom = fabricCanvas.getZoom();
    const newZoom = dir > 0
      ? Math.min(curZoom * 1.3, 5)
      : Math.max(curZoom / 1.3, 0.3);
    fabricCanvas.setZoom(newZoom);
    fabricCanvas.renderAll();
  };

  const doUndo = () => {
    if (historyStack.length <= 1 || !fabricCanvas) return;
    historyStack.pop(); // remove current
    const prev = historyStack[historyStack.length - 1];
    fabricCanvas.loadFromJSON(prev).then(() => {
      fabricCanvas.renderAll();
      if (historyStack.length <= 1) {
        undoBtn.disabled = true;
        hasChanges = false;
        saveBtn.style.display = 'none';
      }
    });
  };

  const doReset = async () => {
    if (!fabricCanvas) return;
    deactivateTool();

    const fabric = await getFabric();
    const FabricImage = fabric.FabricImage || fabric.Image;

    const dataUrl = await loadOriginalDataUrl();
    const tempImg = new Image();
    await new Promise((resolve) => {
      tempImg.onload = resolve;
      tempImg.onerror = resolve;
      tempImg.src = dataUrl;
    });

    const natW = tempImg.naturalWidth || 800;
    const natH = tempImg.naturalHeight || 600;
    const stageRect = overlay.querySelector('.iv-canvas-stage').getBoundingClientRect();
    const maxW = stageRect.width || window.innerWidth;
    const maxH = stageRect.height || (window.innerHeight - 140);
    const ratio = Math.min(maxW / natW, maxH / natH, 1);
    const displayW = Math.round(natW * ratio);
    const displayH = Math.round(natH * ratio);

    fabricCanvas.setDimensions({ width: displayW, height: displayH });
    fabricCanvas.clear();
    fabricCanvas.setZoom(1);

    const fabricImg = await FabricImage.fromURL(dataUrl, { crossOrigin: 'anonymous' });
    fabricImg.scaleToWidth(displayW);
    fabricImg.scaleToHeight(displayH);
    fabricCanvas.backgroundImage = fabricImg;
    fabricCanvas.renderAll();

    historyStack = [fabricCanvas.toJSON()];
    hasChanges = false;
    undoBtn.disabled = true;
    saveBtn.style.display = 'none';
  };

  /* ── Export edited image ── */
  const exportEditedBlob = () => {
    return new Promise((resolve) => {
      if (!fabricCanvas) { resolve(null); return; }
      // Reset zoom to 1 before exporting
      const prevZoom = fabricCanvas.getZoom();
      fabricCanvas.setZoom(1);
      fabricCanvas.renderAll();
      const dataUrl = fabricCanvas.toDataURL({ format: 'png', multiplier: 1 });
      fabricCanvas.setZoom(prevZoom);
      fabricCanvas.renderAll();
      fetch(dataUrl)
        .then(r => r.blob())
        .then(b => resolve(b))
        .catch(() => resolve(null));
    });
  };

  /* ── Save / Send handler ── */
  const handleSave = async () => {
    if (!hasChanges) return;
    const editedBlob = await exportEditedBlob();
    if (!editedBlob) return;

    if (source === 'chat' && typeof onSendToChat === 'function') {
      const editedName = (name || 'image').replace(/\.[^.]+$/, '') + '_edited.png';
      const file = new File([editedBlob], editedName, { type: 'image/png' });
      closeViewer();
      try {
        await onSendToChat(file);
      } catch (err) {
        log({ imageEditorSendError: err?.message || err });
      }
    } else if (source === 'drive' && typeof onSaveToDrive === 'function') {
      showDriveSaveDialog(editedBlob);
    }
  };

  /* ── Drive save dialog ── */
  const showDriveSaveDialog = (editedBlob) => {
    const dialog = document.createElement('div');
    dialog.className = 'iv-save-dialog';
    dialog.innerHTML = `
      <div class="iv-save-panel">
        <div class="iv-save-title">儲存編輯後的圖片</div>
        <button type="button" class="iv-save-option" data-mode="overwrite">
          <svg viewBox="0 0 24 24" fill="none" width="20" height="20"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 21v-8H7v8M7 3v5h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>覆蓋原檔</span>
        </button>
        <button type="button" class="iv-save-option" data-mode="new">
          <svg viewBox="0 0 24 24" fill="none" width="20" height="20"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2v6h6M12 18v-6M9 15h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span>另存新檔</span>
        </button>
        <button type="button" class="iv-save-cancel" data-action="save-cancel">取消</button>
      </div>
    `;
    overlay.appendChild(dialog);

    const cleanup = () => dialog.remove();

    dialog.querySelector('[data-mode="overwrite"]').addEventListener('click', async () => {
      cleanup();
      closeViewer();
      try {
        await onSaveToDrive(editedBlob, 'overwrite', name);
      } catch (err) {
        log({ imageEditorDriveSaveError: err?.message || err });
      }
    }, { once: true });

    dialog.querySelector('[data-mode="new"]').addEventListener('click', async () => {
      cleanup();
      const newName = (name || 'image').replace(/(\.[^.]+)$/, '_edited$1');
      closeViewer();
      try {
        await onSaveToDrive(editedBlob, 'new', newName);
      } catch (err) {
        log({ imageEditorDriveSaveError: err?.message || err });
      }
    }, { once: true });

    dialog.querySelector('[data-action="save-cancel"]').addEventListener('click', cleanup, { once: true });
  };

  /* ── Download handler ── */
  const handleDownload = () => {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = name || 'image';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      log({ imageDownloadError: err?.message || err });
    }
  };

  /* ── Close viewer ── */
  const closeViewer = () => {
    exitEditor();
    stage.removeEventListener('pointerdown', onStagePointerDown);
    stage.removeEventListener('pointermove', onStagePointerMove);
    stage.removeEventListener('pointerup', onStagePointerUp);
    stage.removeEventListener('pointercancel', onStagePointerUp);
    overlay.remove();
    document.body.classList.remove('iv-open');
    activeCleanup = null;
    onClose?.();
  };

  /* ── Event delegation ── */
  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) {
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) {
        const tool = toolBtn.dataset.tool;
        if (tool === 'crop') activateCrop();
        else if (tool === 'draw') activateDraw();
        else if (tool === 'zoom-in') doZoom(1);
        else if (tool === 'zoom-out') doZoom(-1);
      }
      return;
    }
    const action = btn.dataset.action;
    switch (action) {
      case 'close': closeViewer(); break;
      case 'download': handleDownload(); break;
      case 'edit': enterEditor(); break;
      case 'editor-close': exitEditor(); break;
      case 'undo': doUndo(); break;
      case 'reset': doReset(); break;
      case 'save': handleSave(); break;
      case 'crop-cancel': deactivateTool(); break;
      case 'crop-confirm': confirmCrop(); break;
    }
  });

  /* ── Lock body scroll ── */
  document.body.classList.add('iv-open');

  /* ── Register cleanup ── */
  activeCleanup = closeViewer;

  /* ── Escape key to close ── */
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (editorOpen) exitEditor();
      else closeViewer();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  const origCleanup = activeCleanup;
  activeCleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
    origCleanup();
  };
}

/* ── Util ── */
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
