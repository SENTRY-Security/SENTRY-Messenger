import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const JSZIP_URL = '/assets/libs/jszip.min.js';
let activePptxCleanup = null;

async function ensureJSZip() {
  if (typeof window.JSZip !== 'undefined') return window.JSZip;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSZIP_URL;
    s.onload = resolve;
    s.onerror = () => reject(new Error('JSZip load failed'));
    document.head.appendChild(s);
  });
  return window.JSZip;
}

export function cleanupPptxViewer() {
  if (typeof activePptxCleanup === 'function') { try { activePptxCleanup(); } catch {} }
  activePptxCleanup = null;
}

function triggerDownload(url, filename) {
  const a = document.createElement('a'); a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener noreferrer'; document.body.appendChild(a); a.click(); a.remove();
}

const PPTX_MIMES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.ms-powerpoint.presentation.macroenabled.12'
];
export function isPptxMime(ct) { if (!ct) return false; const l = ct.toLowerCase().split(';')[0].trim(); return PPTX_MIMES.some(m => l === m); }
export function isPptxFilename(name) { return name ? /\.(pptx|ppt|pptm)$/i.test(name) : false; }

// ═══════════════════════════════════════
// OOXML Parser
// ═══════════════════════════════════════
const EMU_PX = 914400 / 96;
const emuToPx = (v) => Math.round(Number(v) / EMU_PX);
const attr = (xml, name) => { const m = xml.match(new RegExp(`${name}="([^"]*)"`)); return m ? m[1] : null; };

// ── Color ──
const SCHEME_COLORS = { dk1:'#1e293b', dk2:'#334155', lt1:'#ffffff', lt2:'#f1f5f9', accent1:'#4472C4', accent2:'#ED7D31', accent3:'#A5A5A5', accent4:'#FFC000', accent5:'#5B9BD5', accent6:'#70AD47', tx1:'#1e293b', tx2:'#475569', bg1:'#ffffff', bg2:'#e2e8f0', hlink:'#0563C1', folHlink:'#954F72' };

function parseColor(xml) {
  if (!xml) return null;
  const srgb = xml.match(/<a:srgbClr\s+val="([^"]+)"/);
  if (srgb) return '#' + srgb[1];
  const scheme = xml.match(/<a:schemeClr\s+val="([^"]+)"/);
  if (scheme) return SCHEME_COLORS[scheme[1]] || null;
  return null;
}

function parseFill(xml) {
  if (!xml) return null;
  // Solid fill
  const solid = xml.match(/<a:solidFill>([\s\S]*?)<\/a:solidFill>/);
  if (solid) return parseColor(solid[0]);
  // Gradient fill → use first stop color
  const gradStop = xml.match(/<a:gs\b[^>]*>([\s\S]*?)<\/a:gs>/);
  if (gradStop) return parseColor(gradStop[0]);
  return null;
}

// ── Line / Border ──
function parseLine(xml) {
  const ln = xml.match(/<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/);
  if (!ln) return null;
  const w = attr(ln[1], 'w');
  const color = parseFill(ln[2]);
  return { width: w ? Math.max(1, emuToPx(w)) : 1, color: color || '#94a3b8' };
}

// ── Text Run ──
function parseTextRun(runXml) {
  const textMatch = runXml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/);
  const text = textMatch ? textMatch[1] : '';
  if (!text) return null;
  const rPrMatch = runXml.match(/<a:rPr\b[\s\S]*?(?:\/>|<\/a:rPr>)/);
  const rPr = rPrMatch ? rPrMatch[0] : '';
  const sz = rPr.match(/\bsz="(\d+)"/);
  const fontSize = sz ? Math.round(Number(sz[1]) / 100) : null;
  const color = parseColor(rPr);
  const bold = /\bb="1"/.test(rPr);
  const italic = /\bi="1"/.test(rPr);
  const underline = /\bu="sng"/.test(rPr);
  const strike = /\bstrike="sng/.test(rPr);
  // Font
  const latin = rPr.match(/<a:latin\s+typeface="([^"]+)"/);
  const ea = rPr.match(/<a:ea\s+typeface="([^"]+)"/);
  const font = latin ? latin[1] : (ea ? ea[1] : null);
  // Hyperlink
  const hlinkMatch = runXml.match(/<a:hlinkClick[^>]*r:id="(rId\d+)"/);
  return { text, fontSize, color, bold, italic, underline, strike, font, hlinkRid: hlinkMatch ? hlinkMatch[1] : null };
}

// ── Paragraph ──
function parseParagraph(pXml) {
  const runs = [];
  for (const m of pXml.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
    const run = parseTextRun(m[1]);
    if (run) runs.push(run);
  }
  // Also handle <a:fld> (field, e.g. slide number)
  for (const m of pXml.matchAll(/<a:fld\b[^>]*>([\s\S]*?)<\/a:fld>/g)) {
    const run = parseTextRun(m[1]);
    if (run) runs.push(run);
  }
  const pPr = pXml.match(/<a:pPr\b([^>]*)[\s\S]*?(?:\/>|<\/a:pPr>)/);
  const pPrStr = pPr ? pPr[0] : '';
  const pPrAttrs = pPr ? pPr[1] : '';
  let align = 'left';
  const algn = attr(pPrAttrs, 'algn');
  if (algn === 'ctr') align = 'center';
  else if (algn === 'r') align = 'right';
  else if (algn === 'just') align = 'justify';
  // Bullet
  let bullet = null;
  if (/<a:buChar\s+char="([^"]*)"/.test(pPrStr)) bullet = pPrStr.match(/<a:buChar\s+char="([^"]*)"/)[1];
  else if (/<a:buAutoNum/.test(pPrStr)) bullet = 'auto';
  // Indent level
  const lvl = attr(pPrAttrs, 'lvl');
  const indent = lvl ? parseInt(lvl) : 0;
  // Line spacing
  const lnSpc = pPrStr.match(/<a:lnSpc>[\s\S]*?<a:spcPct\s+val="(\d+)"/);
  const lineHeight = lnSpc ? Math.round(Number(lnSpc[1]) / 1000) / 100 : null;
  return { runs, align, bullet, indent, lineHeight };
}

// ── Shape position/size ──
function parseTransform(xml) {
  const off = xml.match(/<a:off\s+x="(-?\d+)"\s+y="(-?\d+)"/);
  const ext = xml.match(/<a:ext\s+cx="(\d+)"\s+cy="(\d+)"/);
  const rot = xml.match(/<a:xfrm[^>]*\brot="(-?\d+)"/);
  return {
    x: off ? emuToPx(off[1]) : 0, y: off ? emuToPx(off[2]) : 0,
    w: ext ? emuToPx(ext[1]) : 0, h: ext ? emuToPx(ext[2]) : 0,
    rot: rot ? Number(rot[1]) / 60000 : 0
  };
}

// ── Table ──
function parseTable(tblXml) {
  const rows = [];
  for (const trMatch of tblXml.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
    const cells = [];
    for (const tcMatch of trMatch[1].matchAll(/<a:tc\b([^>]*)>([\s\S]*?)<\/a:tc>/g)) {
      const paragraphs = [];
      for (const pMatch of tcMatch[2].matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
        paragraphs.push(parseParagraph(pMatch[1]));
      }
      const fill = parseFill(tcMatch[2]);
      const gridSpan = attr(tcMatch[1], 'gridSpan');
      const rowSpan = attr(tcMatch[1], 'rowSpan');
      cells.push({ paragraphs, fill, gridSpan: gridSpan ? parseInt(gridSpan) : 1, rowSpan: rowSpan ? parseInt(rowSpan) : 1 });
    }
    rows.push(cells);
  }
  return rows;
}

// ── Shape parser ──
function parseShape(spXml, relMap) {
  const tf = parseTransform(spXml);
  // Image via blip
  const blip = spXml.match(/r:embed="(rId\d+)"/);
  if (blip && relMap[blip[1]] && /\.(png|jpe?g|gif|bmp|svg|webp|emf|wmf|tiff?)$/i.test(relMap[blip[1]])) {
    return { type: 'image', ...tf, target: relMap[blip[1]] };
  }
  // Table
  const tbl = spXml.match(/<a:tbl>([\s\S]*?)<\/a:tbl>/);
  if (tbl) return { type: 'table', ...tf, rows: parseTable(tbl[1]) };
  // Text body
  const txBody = spXml.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/);
  if (!txBody) return null;
  const paragraphs = [];
  for (const m of txBody[1].matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)) {
    const p = parseParagraph(m[1]);
    if (p.runs.length) paragraphs.push(p);
  }
  if (!paragraphs.length) return null;
  // Shape styles
  const bgColor = parseFill(spXml);
  const line = parseLine(spXml);
  // Text body properties
  const bodyPr = txBody[1].match(/<a:bodyPr\b([^>]*)/);
  const bodyAttrs = bodyPr ? bodyPr[1] : '';
  const anchor = attr(bodyAttrs, 'anchor'); // t, ctr, b
  const lIns = attr(bodyAttrs, 'lIns'); const rIns = attr(bodyAttrs, 'rIns');
  const tIns = attr(bodyAttrs, 'tIns'); const bIns = attr(bodyAttrs, 'bIns');
  const margin = {
    l: lIns ? emuToPx(lIns) : 7, r: rIns ? emuToPx(rIns) : 7,
    t: tIns ? emuToPx(tIns) : 4, b: bIns ? emuToPx(bIns) : 4
  };
  // Preset geometry (rounded rect, etc.)
  const prstGeom = spXml.match(/<a:prstGeom\s+prst="([^"]+)"/);
  const geom = prstGeom ? prstGeom[1] : 'rect';
  return { type: 'text', ...tf, paragraphs, bgColor, line, anchor, margin, geom };
}

// ── Group shapes (recursive) ──
function parseGroupShapes(grpXml, relMap) {
  const shapes = [];
  // Child shapes
  for (const m of grpXml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
    const s = parseShape(m[1], relMap); if (s) shapes.push(s);
  }
  for (const m of grpXml.matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/g)) {
    const s = parseShape(m[1], relMap); if (s) shapes.push(s);
  }
  for (const m of grpXml.matchAll(/<p:cxnSp>([\s\S]*?)<\/p:cxnSp>/g)) {
    const s = parseShape(m[1], relMap); if (s) shapes.push(s);
  }
  // Nested groups
  for (const m of grpXml.matchAll(/<p:grpSp>([\s\S]*?)<\/p:grpSp>/g)) {
    shapes.push(...parseGroupShapes(m[1], relMap));
  }
  return shapes;
}

function buildRelMap(relsXml) {
  const map = {};
  if (!relsXml) return map;
  for (const m of relsXml.matchAll(/Id="(rId\d+)"[^>]*Target="([^"]+)"/g)) map[m[1]] = m[2];
  return map;
}

function resolvePath(target) {
  const r = target.startsWith('/') ? target.slice(1) : 'ppt/slides/' + target;
  const parts = r.split('/'); const stack = [];
  for (const p of parts) { if (p === '..') stack.pop(); else if (p !== '.') stack.push(p); }
  return stack.join('/');
}

async function getSlideSize(zip) {
  try {
    const xml = await zip.file('ppt/presentation.xml')?.async('string');
    if (!xml) return { w: 960, h: 540 };
    const m = xml.match(/<p:sldSz\s+cx="(\d+)"\s+cy="(\d+)"/);
    if (m) return { w: emuToPx(m[1]), h: emuToPx(m[2]) };
  } catch {}
  return { w: 960, h: 540 };
}

// ── Slide layout/master background ──
async function getLayoutBg(slideXml, relsXml, zip) {
  // Slide's own background
  const slideBg = slideXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
  if (slideBg) { const c = parseColor(slideBg[1]); if (c) return c; }
  // Find layout from rels
  if (!relsXml) return null;
  const layoutRel = relsXml.match(/Target="([^"]*slideLayout[^"]*)"/);
  if (!layoutRel) return null;
  const layoutPath = resolvePath(layoutRel[1]);
  try {
    const layoutXml = await zip.file(layoutPath)?.async('string');
    if (!layoutXml) return null;
    const bg = layoutXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
    if (bg) { const c = parseColor(bg[1]); if (c) return c; }
    // Check master from layout rels
    const layoutNum = layoutPath.match(/slideLayout(\d+)/)?.[1];
    const layoutRelsPath = `ppt/slideLayouts/_rels/slideLayout${layoutNum}.xml.rels`;
    const layoutRels = await zip.file(layoutRelsPath)?.async('string').catch(() => null);
    if (!layoutRels) return null;
    const masterRel = layoutRels.match(/Target="([^"]*slideMaster[^"]*)"/);
    if (!masterRel) return null;
    const masterPath = masterRel[1].startsWith('/') ? masterRel[1].slice(1) : 'ppt/slideLayouts/' + masterRel[1];
    const mParts = masterPath.split('/'); const mStack = [];
    for (const p of mParts) { if (p === '..') mStack.pop(); else if (p !== '.') mStack.push(p); }
    const masterXml = await zip.file(mStack.join('/'))?.async('string');
    if (!masterXml) return null;
    const masterBg = masterXml.match(/<p:bg>([\s\S]*?)<\/p:bg>/);
    if (masterBg) return parseColor(masterBg[1]);
  } catch {}
  return null;
}

// ═══════════════════════════════════════
// DOM Builder
// ═══════════════════════════════════════
function renderRun(run, relMap) {
  const span = document.createElement('span');
  let css = '';
  if (run.fontSize) css += `font-size:${run.fontSize}pt;`;
  if (run.color) css += `color:${run.color};`;
  if (run.bold) css += 'font-weight:700;';
  if (run.italic) css += 'font-style:italic;';
  if (run.underline) css += 'text-decoration:underline;';
  if (run.strike) css += 'text-decoration:line-through;';
  if (run.font) css += `font-family:"${run.font}",-apple-system,sans-serif;`;
  if (css) span.style.cssText = css;
  span.textContent = run.text;
  if (run.hlinkRid && relMap[run.hlinkRid]) {
    const a = document.createElement('a');
    a.href = relMap[run.hlinkRid];
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.style.color = 'inherit'; a.style.textDecoration = 'underline';
    a.appendChild(span);
    return a;
  }
  return span;
}

function renderParagraph(para, relMap, autoNum) {
  const p = document.createElement('p');
  let css = `margin:0 0 2px;text-align:${para.align};`;
  if (para.lineHeight) css += `line-height:${para.lineHeight};`;
  if (para.indent) css += `padding-left:${para.indent * 20}px;`;
  p.style.cssText = css;
  // Bullet
  if (para.bullet) {
    const bulletSpan = document.createElement('span');
    bulletSpan.style.cssText = 'margin-right:6px;';
    bulletSpan.textContent = para.bullet === 'auto' ? `${autoNum.n++}. ` : `${para.bullet} `;
    p.appendChild(bulletSpan);
  }
  for (const run of para.runs) p.appendChild(renderRun(run, relMap));
  return p;
}

function renderTable(shape) {
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:10pt;';
  for (const row of shape.rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.style.cssText = `border:1px solid #cbd5e1;padding:4px 6px;vertical-align:top;${cell.fill ? 'background:' + cell.fill + ';' : ''}`;
      if (cell.gridSpan > 1) td.colSpan = cell.gridSpan;
      if (cell.rowSpan > 1) td.rowSpan = cell.rowSpan;
      const autoNum = { n: 1 };
      for (const para of cell.paragraphs) td.appendChild(renderParagraph(para, {}, autoNum));
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  return table;
}

async function buildShapeElement(shape, relMap, zip, scaleX, scaleY, objectUrls) {
  const el = document.createElement('div');
  let css = `position:absolute;left:${shape.x * scaleX}%;top:${shape.y * scaleY}%;width:${shape.w * scaleX}%;height:${shape.h * scaleY}%;overflow:hidden;`;
  if (shape.rot) css += `transform:rotate(${shape.rot}deg);`;
  // Geometry → border-radius
  if (shape.geom === 'roundRect') css += 'border-radius:8px;';
  else if (shape.geom === 'ellipse') css += 'border-radius:50%;';
  el.style.cssText = css;

  if (shape.type === 'image') {
    const imgPath = resolvePath(shape.target);
    try {
      const imgFile = zip.file(imgPath);
      if (imgFile) {
        const imgBlob = await imgFile.async('blob');
        const imgUrl = URL.createObjectURL(imgBlob);
        objectUrls.push(imgUrl);
        const img = document.createElement('img');
        img.src = imgUrl; img.decoding = 'async';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
        el.appendChild(img);
      }
    } catch {}
  } else if (shape.type === 'table') {
    el.style.overflow = 'auto';
    el.appendChild(renderTable(shape));
  } else if (shape.type === 'text') {
    if (shape.bgColor) el.style.background = shape.bgColor;
    if (shape.line) el.style.border = `${shape.line.width}px solid ${shape.line.color}`;
    const m = shape.margin || { l: 7, r: 7, t: 4, b: 4 };
    el.style.padding = `${m.t}px ${m.r}px ${m.b}px ${m.l}px`;
    el.style.boxSizing = 'border-box';
    el.style.display = 'flex'; el.style.flexDirection = 'column';
    if (shape.anchor === 'ctr') el.style.justifyContent = 'center';
    else if (shape.anchor === 'b') el.style.justifyContent = 'flex-end';
    const autoNum = { n: 1 };
    for (const para of shape.paragraphs) el.appendChild(renderParagraph(para, relMap, autoNum));
  }
  return el;
}

async function buildSlideElement(slideXml, relsXml, zip, slideSize, objectUrls) {
  const relMap = buildRelMap(relsXml);
  const bgColor = await getLayoutBg(slideXml, relsXml, zip) || '#ffffff';

  // Check for background image fill
  let bgImageUrl = null;
  const bgBlip = slideXml.match(/<p:bg>[\s\S]*?r:embed="(rId\d+)"[\s\S]*?<\/p:bg>/);
  if (bgBlip && relMap[bgBlip[1]]) {
    const bgPath = resolvePath(relMap[bgBlip[1]]);
    try {
      const bgFile = zip.file(bgPath);
      if (bgFile) {
        const bgBlob = await bgFile.async('blob');
        bgImageUrl = URL.createObjectURL(bgBlob);
        objectUrls.push(bgImageUrl);
      }
    } catch {}
  }

  const slide = document.createElement('div');
  slide.className = 'pptx-slide';
  let slideCss = `aspect-ratio:${slideSize.w}/${slideSize.h};background:${bgColor};position:relative;overflow:hidden;`;
  if (bgImageUrl) slideCss += `background-image:url(${bgImageUrl});background-size:cover;background-position:center;`;
  slide.style.cssText = slideCss;

  // Collect all shapes from various containers
  const allShapes = [];
  const collect = (xml) => {
    for (const m of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) { const s = parseShape(m[1], relMap); if (s) allShapes.push(s); }
    for (const m of xml.matchAll(/<p:pic>([\s\S]*?)<\/p:pic>/g)) { const s = parseShape(m[1], relMap); if (s) allShapes.push(s); }
    for (const m of xml.matchAll(/<p:cxnSp>([\s\S]*?)<\/p:cxnSp>/g)) { const s = parseShape(m[1], relMap); if (s) allShapes.push(s); }
    for (const m of xml.matchAll(/<p:grpSp>([\s\S]*?)<\/p:grpSp>/g)) { allShapes.push(...parseGroupShapes(m[1], relMap)); }
    // graphicFrame (charts, tables, etc.)
    for (const m of xml.matchAll(/<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g)) { const s = parseShape(m[1], relMap); if (s) allShapes.push(s); }
  };
  collect(slideXml);

  const scaleX = 100 / slideSize.w;
  const scaleY = 100 / slideSize.h;

  for (const shape of allShapes) {
    const el = await buildShapeElement(shape, relMap, zip, scaleX, scaleY, objectUrls);
    slide.appendChild(el);
  }

  // Slide number overlay
  const numEl = document.createElement('div');
  numEl.className = 'pptx-slide-num';
  slide.appendChild(numEl);

  return slide;
}

// ═══════════════════════════════════════
// Main Viewer — Vertical scroll layout
// ═══════════════════════════════════════
export async function renderPptxViewer({ url, blob, name, modalApi }) {
  const { openModal, closeModal, showConfirmModal } = modalApi || {};
  let JSZip;
  try { JSZip = await ensureJSZip(); } catch (err) { log({ jszipLoadError: err?.message || err }); return false; }

  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const modalTitle = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');
  const closeArea = document.getElementById('modalCloseArea');
  if (!modalEl || !body || !modalTitle) return false;

  cleanupPptxViewer();
  modalEl.classList.add('pptx-modal');
  modalTitle.textContent = '';

  body.innerHTML = `
    <div class="pptx-viewer">
      <div class="pptx-toolbar">
        <button type="button" class="pptx-btn" id="pptxCloseBtn" aria-label="${t('viewer.close')}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="pptx-title" title="${escapeHtml(name || 'PowerPoint')}">${escapeHtml(name || 'PowerPoint')}</div>
        <span class="pptx-page-label" id="pptxPageLabel">– / –</span>
        <div class="pptx-actions">
          <button type="button" class="pptx-btn" id="pptxDownload" aria-label="${t('viewer.downloadPptx')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="pptx-stage" id="pptxStage">
        <div class="pptx-loading" id="pptxLoading">${t('common.loading')}</div>
      </div>
    </div>`;
  openModal?.();

  const loadingEl = body.querySelector('#pptxLoading');
  const stageEl = body.querySelector('#pptxStage');
  const pageLabel = body.querySelector('#pptxPageLabel');
  const objectUrls = [];
  const cleanup = () => { for (const u of objectUrls) { try { URL.revokeObjectURL(u); } catch {} } objectUrls.length = 0; };

  try {
    let arrayBuffer;
    if (blob) arrayBuffer = await blob.arrayBuffer();
    else if (url) { const r = await fetch(url); arrayBuffer = await r.arrayBuffer(); }
    else throw new Error('No data source');

    const zip = await JSZip.loadAsync(arrayBuffer);
    const slideSize = await getSlideSize(zip);

    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((a, b) => parseInt(a.match(/slide(\d+)/)?.[1] || '0') - parseInt(b.match(/slide(\d+)/)?.[1] || '0'));

    if (!slideFiles.length) throw new Error('No slides found');
    if (loadingEl) loadingEl.remove();

    // Build all slides vertically
    const slideEls = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const slideXml = await zip.file(slideFiles[i])?.async('string');
      if (!slideXml) continue;
      const slideNum = slideFiles[i].match(/slide(\d+)/)?.[1] || '1';
      const relsXml = await zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`)?.async('string').catch(() => null);
      const slideEl = await buildSlideElement(slideXml, relsXml, zip, slideSize, objectUrls);
      // Set slide number
      const numEl = slideEl.querySelector('.pptx-slide-num');
      if (numEl) numEl.textContent = `${i + 1}`;
      stageEl.appendChild(slideEl);
      slideEls.push(slideEl);
    }

    pageLabel.textContent = `${slideEls.length} ${t('viewer.pptxSlides')}`;

    // Scroll-based page tracking
    let scrollTick = false;
    const onScroll = () => {
      if (scrollTick) return;
      scrollTick = true;
      requestAnimationFrame(() => {
        const stageRect = stageEl.getBoundingClientRect();
        const mid = stageRect.top + stageRect.height * 0.35;
        let current = 1;
        for (let i = 0; i < slideEls.length; i++) {
          const r = slideEls[i].getBoundingClientRect();
          if (r.top <= mid && r.bottom > mid) { current = i + 1; break; }
          if (r.top > mid) break;
          current = i + 1;
        }
        pageLabel.textContent = `${current} / ${slideEls.length}`;
        scrollTick = false;
      });
    };
    stageEl.addEventListener('scroll', onScroll, { passive: true });

    // Download
    body.querySelector('#pptxDownload')?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.pptx');
      if (typeof showConfirmModal === 'function') {
        showConfirmModal({ title: t('viewer.downloadPptx'), message: t('drive.downloadPdfConfirm'), confirmLabel: t('drive.download'), onConfirm: proceed });
        return;
      }
      proceed();
    });

    // Close
    const doClose = () => activePptxCleanup?.();
    body.querySelector('#pptxCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });

    const prevCleanup = activePptxCleanup;
    activePptxCleanup = () => {
      if (typeof prevCleanup === 'function') prevCleanup();
      cleanup();
      stageEl.removeEventListener('scroll', onScroll);
      modalEl.classList.remove('pptx-modal');
      closeModal?.();
      activePptxCleanup = null;
    };
  } catch (err) {
    log({ pptxViewerError: err?.message || err });
    stageEl.innerHTML = `
      <div class="viewer-error-state">
        <div class="viewer-error-msg">${escapeHtml(t('viewer.pptxLoadFailed', { error: err?.message || err }))}</div>
        <button type="button" class="viewer-error-download" id="pptxErrorDownload">
          <svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          ${t('viewer.downloadPptx')}
        </button>
      </div>`;
    stageEl.querySelector('#pptxErrorDownload')?.addEventListener('click', () => triggerDownload(url, name || 'file.pptx'));
    const doClose = () => activePptxCleanup?.();
    body.querySelector('#pptxCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });
    const prevCleanup = activePptxCleanup;
    activePptxCleanup = () => { if (typeof prevCleanup === 'function') prevCleanup(); cleanup(); modalEl.classList.remove('pptx-modal'); closeModal?.(); activePptxCleanup = null; };
    return true;
  }
  return true;
}
