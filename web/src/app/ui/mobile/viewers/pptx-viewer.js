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
// OOXML Parser — DOMParser based
// ═══════════════════════════════════════
const EMU_PX = 914400 / 96;
const emuToPx = (v) => Math.round(Number(v) / EMU_PX);

// XML namespaces
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function parseXml(xmlStr) {
  return new DOMParser().parseFromString(xmlStr, 'text/xml');
}

// First direct child by namespace + localName
function qn(parent, ns, localName) {
  if (!parent) return null;
  for (const ch of parent.children) {
    if (ch.localName === localName && ch.namespaceURI === ns) return ch;
  }
  return null;
}

// All direct children by namespace + localName
function qnAll(parent, ns, localName) {
  if (!parent) return [];
  const result = [];
  for (const ch of parent.children) {
    if (ch.localName === localName && ch.namespaceURI === ns) result.push(ch);
  }
  return result;
}

// First descendant (any depth)
function dn(parent, ns, localName) {
  return parent?.getElementsByTagNameNS?.(ns, localName)?.[0] || null;
}

// All descendants as array
function dnAll(parent, ns, localName) {
  return [...(parent?.getElementsByTagNameNS?.(ns, localName) || [])];
}

// ── Theme ──
// Parsed once per file; holds real colors + fonts from theme1.xml
let themeColors = {};
let themeFontMajor = 'Calibri';
let themeFontMinor = 'Calibri';

async function parseTheme(zip) {
  try {
    const xmlStr = await zip.file('ppt/theme/theme1.xml')?.async('string');
    if (!xmlStr) return;
    const doc = parseXml(xmlStr);
    const clrScheme = dn(doc, NS_A, 'clrScheme');
    if (clrScheme) {
      const tags = ['dk1','dk2','lt1','lt2','accent1','accent2','accent3','accent4','accent5','accent6','hlink','folHlink'];
      for (const tag of tags) {
        const el = qn(clrScheme, NS_A, tag);
        if (!el) continue;
        const srgb = dn(el, NS_A, 'srgbClr');
        if (srgb) { themeColors[tag] = '#' + srgb.getAttribute('val'); continue; }
        const sys = dn(el, NS_A, 'sysClr');
        if (sys) themeColors[tag] = '#' + (sys.getAttribute('lastClr') || sys.getAttribute('val') || '000000');
      }
      themeColors.tx1 = themeColors.dk1; themeColors.tx2 = themeColors.dk2;
      themeColors.bg1 = themeColors.lt1; themeColors.bg2 = themeColors.lt2;
    }
    const majorFont = dn(doc, NS_A, 'majorFont');
    if (majorFont) { const latin = qn(majorFont, NS_A, 'latin'); if (latin) themeFontMajor = latin.getAttribute('typeface') || 'Calibri'; }
    const minorFont = dn(doc, NS_A, 'minorFont');
    if (minorFont) { const latin = qn(minorFont, NS_A, 'latin'); if (latin) themeFontMinor = latin.getAttribute('typeface') || 'Calibri'; }
  } catch {}
}

// Common font name → CSS web-safe fallback
const FONT_MAP = {
  'Calibri': '"Calibri",-apple-system,sans-serif',
  'Arial': 'Arial,sans-serif',
  'Times New Roman': '"Times New Roman",serif',
  'Verdana': 'Verdana,sans-serif',
  'Georgia': 'Georgia,serif',
  'Tahoma': 'Tahoma,sans-serif',
  'Trebuchet MS': '"Trebuchet MS",sans-serif',
  'Courier New': '"Courier New",monospace',
  'Segoe UI': '"Segoe UI",-apple-system,sans-serif',
  'Meiryo': '"Meiryo","Hiragino Sans",sans-serif',
  'Microsoft JhengHei': '"Microsoft JhengHei","PingFang TC",sans-serif',
  'Microsoft YaHei': '"Microsoft YaHei","PingFang SC",sans-serif',
  '微軟正黑體': '"Microsoft JhengHei","PingFang TC",sans-serif',
  '微软雅黑': '"Microsoft YaHei","PingFang SC",sans-serif',
};

function resolveFont(rawFont) {
  if (!rawFont) return null;
  // Theme font references
  if (rawFont === '+mj-lt' || rawFont === '+mj-ea') return FONT_MAP[themeFontMajor] || `"${themeFontMajor}",sans-serif`;
  if (rawFont === '+mn-lt' || rawFont === '+mn-ea') return FONT_MAP[themeFontMinor] || `"${themeFontMinor}",sans-serif`;
  return FONT_MAP[rawFont] || `"${rawFont}",-apple-system,sans-serif`;
}

// ── Color ──
function parseColor(el) {
  if (!el) return null;
  const srgb = dn(el, NS_A, 'srgbClr');
  if (srgb) {
    const color = srgb.getAttribute('val');
    const lumMod = qn(srgb, NS_A, 'lumMod');
    const lumOff = qn(srgb, NS_A, 'lumOff');
    if (lumMod || lumOff) {
      return adjustLuminance('#' + color, lumMod ? Number(lumMod.getAttribute('val')) / 100000 : 1, lumOff ? Number(lumOff.getAttribute('val')) / 100000 : 0);
    }
    return '#' + color;
  }
  const scheme = dn(el, NS_A, 'schemeClr');
  if (scheme) {
    const base = themeColors[scheme.getAttribute('val')] || null;
    if (!base) return null;
    const lumMod = qn(scheme, NS_A, 'lumMod');
    const lumOff = qn(scheme, NS_A, 'lumOff');
    const tintEl = qn(scheme, NS_A, 'tint');
    const shadeEl = qn(scheme, NS_A, 'shade');
    if (lumMod || lumOff || tintEl || shadeEl) {
      let mod = lumMod ? Number(lumMod.getAttribute('val')) / 100000 : 1;
      let off = lumOff ? Number(lumOff.getAttribute('val')) / 100000 : 0;
      if (tintEl) { const tv = Number(tintEl.getAttribute('val')) / 100000; mod *= tv; off += (1 - tv); }
      if (shadeEl) mod *= Number(shadeEl.getAttribute('val')) / 100000;
      return adjustLuminance(base, mod, off);
    }
    return base;
  }
  return null;
}

function adjustLuminance(hex, mod, off) {
  // Simple luminance adjustment: convert to HSL, modify, convert back
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  l = Math.max(0, Math.min(1, l * mod + off));
  // HSL → RGB
  const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1/6) return p + (q - p) * 6 * t; if (t < 1/2) return q; if (t < 2/3) return p + (q - p) * (2/3 - t) * 6; return p; };
  let rr, gg, bb;
  if (s === 0) { rr = gg = bb = l; } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    rr = hue2rgb(p, q, h + 1/3); gg = hue2rgb(p, q, h); bb = hue2rgb(p, q, h - 1/3);
  }
  return '#' + [rr, gg, bb].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function parseFill(el) {
  if (!el) return null;
  const solid = dn(el, NS_A, 'solidFill');
  if (solid) return parseColor(solid);
  // Gradient fill → CSS linear-gradient with correct angle from <a:lin ang="...">
  const gradFill = dn(el, NS_A, 'gradFill');
  if (gradFill) {
    const stops = [];
    for (const gs of dnAll(gradFill, NS_A, 'gs')) {
      const pos = Math.round(Number(gs.getAttribute('pos') || '0') / 1000);
      const c = parseColor(gs);
      if (c) stops.push(`${c} ${pos}%`);
    }
    // Parse gradient angle: OOXML ang is in 60000ths of a degree, convert to CSS degrees
    // OOXML: 0=left→right, 5400000=top→bottom; CSS: 0deg=bottom→top, 90deg=left→right
    const lin = dn(gradFill, NS_A, 'lin');
    const ooAngle = lin ? Number(lin.getAttribute('ang') || '0') / 60000 : 270;
    const cssAngle = Math.round(ooAngle + 90) % 360;
    if (stops.length >= 2) return `linear-gradient(${cssAngle}deg,${stops.join(',')})`;
    if (stops.length === 1) return stops[0].split(' ')[0];
  }
  return null;
}

// ── Line / Border ──
function parseLine(el) {
  const ln = dn(el, NS_A, 'ln');
  if (!ln) return null;
  const w = ln.getAttribute('w');
  const color = parseFill(ln);
  if (!color || color === 'none') return null;
  return { width: w ? Math.max(1, emuToPx(w)) : 1, color: typeof color === 'string' && color.startsWith('#') ? color : '#94a3b8' };
}

// ── Text Run ──
function parseTextRun(runEl) {
  const tEl = dn(runEl, NS_A, 't');
  const text = tEl ? tEl.textContent : '';
  if (!text) return null;
  const rPr = dn(runEl, NS_A, 'rPr');
  const sz = rPr?.getAttribute('sz');
  const fontSize = sz ? Math.round(Number(sz) / 100) : null;
  const color = parseColor(rPr);
  const bold = rPr?.getAttribute('b') === '1';
  const italic = rPr?.getAttribute('i') === '1';
  const u = rPr?.getAttribute('u');
  const underline = u === 'sng' || u === 'dbl';
  const strike = rPr?.getAttribute('strike')?.startsWith('sng') || false;
  // Font
  const latin = rPr ? qn(rPr, NS_A, 'latin') : null;
  const ea = rPr ? qn(rPr, NS_A, 'ea') : null;
  const font = latin ? latin.getAttribute('typeface') : (ea ? ea.getAttribute('typeface') : null);
  // Character spacing (spc in 1/100 pt)
  const spc = rPr?.getAttribute('spc');
  const letterSpacing = spc ? Number(spc) / 100 : null;
  // Superscript/subscript (baseline in %)
  const baselineRaw = rPr?.getAttribute('baseline');
  const baseline = baselineRaw ? Number(baselineRaw) / 1000 : null;
  // Hyperlink
  const hlinkClick = dn(runEl, NS_A, 'hlinkClick');
  const hlinkRid = hlinkClick ? (hlinkClick.getAttributeNS(NS_R, 'id') || hlinkClick.getAttribute('r:id')) : null;
  return { text, fontSize, color, bold, italic, underline, strike, font, letterSpacing, baseline, hlinkRid };
}

// ── Paragraph ──
function parseParagraph(pEl) {
  // Process children in document order to preserve run/break sequence
  const runs = [];
  for (const child of pEl.children) {
    if (child.namespaceURI !== NS_A) continue;
    if (child.localName === 'r' || child.localName === 'fld') {
      const run = parseTextRun(child);
      if (run) runs.push(run);
    } else if (child.localName === 'br') {
      runs.push({ text: '\n', fontSize: null, color: null, bold: false, italic: false, underline: false, strike: false, font: null, letterSpacing: null, baseline: null, hlinkRid: null });
    }
  }

  const pPr = qn(pEl, NS_A, 'pPr');
  let align = 'left';
  if (pPr) {
    const algn = pPr.getAttribute('algn');
    if (algn === 'ctr') align = 'center';
    else if (algn === 'r') align = 'right';
    else if (algn === 'just') align = 'justify';
  }
  // Bullet
  let bullet = null;
  if (pPr && !qn(pPr, NS_A, 'buNone')) {
    const buChar = qn(pPr, NS_A, 'buChar');
    if (buChar) bullet = buChar.getAttribute('char');
    else if (qn(pPr, NS_A, 'buAutoNum')) bullet = 'auto';
  }
  // Bullet color
  let bulletColor = null;
  const buClr = pPr ? qn(pPr, NS_A, 'buClr') : null;
  if (buClr) bulletColor = parseColor(buClr);
  // Indent level
  const lvl = pPr?.getAttribute('lvl');
  const indent = lvl ? parseInt(lvl) : 0;
  // Left margin (marL in EMU)
  const marL = pPr?.getAttribute('marL');
  const marginLeft = marL ? emuToPx(marL) : null;
  // Line spacing
  const lnSpc = pPr ? qn(pPr, NS_A, 'lnSpc') : null;
  const spcPct = lnSpc ? dn(lnSpc, NS_A, 'spcPct') : null;
  const lineHeight = spcPct ? Math.round(Number(spcPct.getAttribute('val') || '0') / 1000) / 100 : null;
  // Space before/after
  const spcBef = pPr ? qn(pPr, NS_A, 'spcBef') : null;
  const spcBefPts = spcBef ? dn(spcBef, NS_A, 'spcPts') : null;
  const spaceBefore = spcBefPts ? Math.round(Number(spcBefPts.getAttribute('val') || '0') / 100) : null;
  const spcAft = pPr ? qn(pPr, NS_A, 'spcAft') : null;
  const spcAftPts = spcAft ? dn(spcAft, NS_A, 'spcPts') : null;
  const spaceAfter = spcAftPts ? Math.round(Number(spcAftPts.getAttribute('val') || '0') / 100) : null;
  // Default run properties (defRPr) — full style fallback for runs without explicit rPr
  const defRPr = pPr ? qn(pPr, NS_A, 'defRPr') : null;
  const defSz = defRPr?.getAttribute('sz');
  const defaultFontSize = defSz ? Math.round(Number(defSz) / 100) : null;
  const defaultColor = defRPr ? parseColor(defRPr) : null;
  const defaultBold = defRPr?.getAttribute('b') === '1' || false;
  const defaultItalic = defRPr?.getAttribute('i') === '1' || false;
  const defU = defRPr?.getAttribute('u');
  const defaultUnderline = defU === 'sng' || defU === 'dbl' || false;
  const defaultStrike = defRPr?.getAttribute('strike') === 'sngStrike' || false;
  const defLatin = defRPr ? qn(defRPr, NS_A, 'latin') : null;
  const defEa = defRPr ? qn(defRPr, NS_A, 'ea') : null;
  const defaultFont = defLatin ? defLatin.getAttribute('typeface') : (defEa ? defEa.getAttribute('typeface') : null);
  // endParaRPr — used when paragraph is otherwise empty (acts as default)
  const endParaRPr = qn(pEl, NS_A, 'endParaRPr');
  const endSz = endParaRPr?.getAttribute('sz');
  const endFontSize = endSz ? Math.round(Number(endSz) / 100) : null;
  const endColor = endParaRPr ? parseColor(endParaRPr) : null;
  return { runs, align, bullet, bulletColor, indent, marginLeft, lineHeight, spaceBefore, spaceAfter,
    defaultFontSize: defaultFontSize || endFontSize, defaultColor: defaultColor || endColor,
    defaultBold, defaultItalic, defaultUnderline, defaultStrike, defaultFont };
}

// ── Shape position/size ──
function parseTransform(el) {
  // a:xfrm (inside p:spPr) or p:xfrm (inside p:graphicFrame)
  const xfrm = dn(el, NS_A, 'xfrm') || dn(el, NS_P, 'xfrm');
  if (!xfrm) return { x: 0, y: 0, w: 0, h: 0, rot: 0 };
  const off = qn(xfrm, NS_A, 'off');
  const ext = qn(xfrm, NS_A, 'ext');
  const rot = xfrm.getAttribute('rot');
  return {
    x: off ? emuToPx(off.getAttribute('x') || '0') : 0,
    y: off ? emuToPx(off.getAttribute('y') || '0') : 0,
    w: ext ? emuToPx(ext.getAttribute('cx') || '0') : 0,
    h: ext ? emuToPx(ext.getAttribute('cy') || '0') : 0,
    rot: rot ? Number(rot) / 60000 : 0
  };
}

// ── Table ──
function parseTable(tblEl) {
  // Parse column widths from tblGrid
  const colWidths = [];
  const tblGrid = qn(tblEl, NS_A, 'tblGrid');
  if (tblGrid) {
    for (const gc of qnAll(tblGrid, NS_A, 'gridCol')) {
      colWidths.push(emuToPx(gc.getAttribute('w') || '0'));
    }
  }
  const rowHeights = [];
  const rows = [];
  for (const tr of qnAll(tblEl, NS_A, 'tr')) {
    rowHeights.push(emuToPx(tr.getAttribute('h') || '0'));
    const cells = [];
    for (const tc of qnAll(tr, NS_A, 'tc')) {
      const paragraphs = [];
      const txBody = qn(tc, NS_A, 'txBody');
      if (txBody) {
        for (const p of qnAll(txBody, NS_A, 'p')) paragraphs.push(parseParagraph(p));
      }
      const tcPr = qn(tc, NS_A, 'tcPr');
      // Cell fill: use direct child lookup (qn) to avoid picking up border fills from lnB/lnT/lnL/lnR
      const directSolid = tcPr ? qn(tcPr, NS_A, 'solidFill') : null;
      const fill = directSolid ? parseColor(directSolid) : null;
      // Border colors
      const borderColor = tcPr ? (() => {
        for (const side of ['lnB', 'lnT', 'lnL', 'lnR']) {
          const ln = qn(tcPr, NS_A, side);
          if (ln) { const c = parseFill(ln); if (c) return c; }
        }
        return null;
      })() : null;
      const gridSpan = tc.getAttribute('gridSpan');
      const rowSpan = tc.getAttribute('rowSpan');
      const hMerge = tc.getAttribute('hMerge') === '1';
      const vMerge = tc.getAttribute('vMerge') === '1';
      cells.push({ paragraphs, fill, borderColor, gridSpan: gridSpan ? parseInt(gridSpan) : 1, rowSpan: rowSpan ? parseInt(rowSpan) : 1, hMerge, vMerge });
    }
    rows.push(cells);
  }
  return { rows, colWidths, rowHeights };
}

// ── Shape parser ──
function parseShape(spEl, relMap, phStyles) {
  const tf = parseTransform(spEl);
  const hasOwnTransform = !!(dn(spEl, NS_A, 'xfrm') || dn(spEl, NS_P, 'xfrm'));
  // Image via blip
  const blip = dn(spEl, NS_A, 'blip');
  const embedId = blip ? (blip.getAttributeNS(NS_R, 'embed') || blip.getAttribute('r:embed')) : null;
  const isImageRef = embedId && relMap[embedId] && /\.(png|jpe?g|gif|bmp|svg|webp|emf|wmf|tiff?)$/i.test(relMap[embedId]);
  // Check if this shape also has text content (sp with blipFill + text)
  const txBodyEl = dn(spEl, NS_P, 'txBody');
  const hasTextContent = txBodyEl && qnAll(txBodyEl, NS_A, 'p').some(p => {
    for (const ch of p.children) {
      if (ch.namespaceURI === NS_A && (ch.localName === 'r' || ch.localName === 'fld')) return true;
    }
    return false;
  });
  if (isImageRef && !hasTextContent) {
    // Pure image shape (no text) — return as image
    const blipFill = blip.parentElement;
    const hasStretch = blipFill ? !!dn(blipFill, NS_A, 'stretch') : false;
    return { type: 'image', ...tf, target: relMap[embedId], fillMode: hasStretch ? 'stretch' : 'contain' };
  }
  // Table
  const tblEl = dn(spEl, NS_A, 'tbl');
  if (tblEl) { const tbl = parseTable(tblEl); return { type: 'table', ...tf, ...tbl }; }
  // Placeholder type from nvSpPr/nvPr/ph
  const phInfo = extractPhFromShape(spEl);
  // Inherit position/size from layout/master placeholder if shape has no xfrm
  if (phInfo && phStyles && !hasOwnTransform) {
    const phKey = phInfo.type + (phInfo.idx ? ':' + phInfo.idx : '');
    const phDef = phStyles[phKey] || phStyles[phInfo.type];
    const phTf = phDef?._transform;
    if (phTf && phTf.w && phTf.h) {
      tf.x = phTf.x; tf.y = phTf.y;
      tf.w = phTf.w; tf.h = phTf.h;
      if (phTf.rot) tf.rot = phTf.rot;
    }
  }
  // Shape styles — look specifically at spPr
  const spPr = dn(spEl, NS_P, 'spPr');
  const bgColor = spPr ? parseFill(spPr) : null;
  const line = spPr ? parseLine(spPr) : null;
  // Preset geometry (rounded rect, etc.)
  const prstGeom = spPr ? dn(spPr, NS_A, 'prstGeom') : null;
  const geom = prstGeom ? (prstGeom.getAttribute('prst') || 'rect') : 'rect';
  // Text body
  const txBody = dn(spEl, NS_P, 'txBody');
  const paragraphs = [];
  // Parse lstStyle for default font sizes per indent level
  const lstStyle = txBody ? qn(txBody, NS_A, 'lstStyle') : null;
  const levelDefaults = {};
  if (lstStyle) {
    const defs = extractLstStyleDefaults(lstStyle);
    Object.assign(levelDefaults, defs);
  }
  // Merge placeholder styles from layout/master (lower priority)
  if (phInfo && phStyles) {
    const phKey = phInfo.type + (phInfo.idx ? ':' + phInfo.idx : '');
    const phDefs = phStyles[phKey] || phStyles[phInfo.type] || {};
    for (const [lvl, val] of Object.entries(phDefs)) {
      if (lvl === '_transform') continue;
      if (!levelDefaults[lvl]) levelDefaults[lvl] = val;
      else {
        // Fill in missing properties from placeholder
        const ld = levelDefaults[lvl];
        if (!ld.fontSize && val.fontSize) ld.fontSize = val.fontSize;
        if (!ld.color && val.color) ld.color = val.color;
        if (!ld.bold && val.bold) ld.bold = val.bold;
        if (!ld.italic && val.italic) ld.italic = val.italic;
        if (!ld.underline && val.underline) ld.underline = val.underline;
        if (!ld.strike && val.strike) ld.strike = val.strike;
        if (!ld.font && val.font) ld.font = val.font;
        if (!ld.align && val.align) ld.align = val.align;
      }
    }
  }
  if (txBody) {
    for (const p of qnAll(txBody, NS_A, 'p')) {
      const para = parseParagraph(p);
      if (para.runs.length) paragraphs.push(para);
      // Apply level defaults (lstStyle + placeholder) if paragraph/runs lack properties
      const lvlDef = levelDefaults[para.indent] || levelDefaults['def'] || levelDefaults[0];
      if (lvlDef) {
        if (!para.defaultFontSize && lvlDef.fontSize) para.defaultFontSize = lvlDef.fontSize;
        if (!para.defaultColor && lvlDef.color) para.defaultColor = lvlDef.color;
        if (!para.defaultBold && lvlDef.bold) para.defaultBold = lvlDef.bold;
        if (!para.defaultItalic && lvlDef.italic) para.defaultItalic = lvlDef.italic;
        if (!para.defaultUnderline && lvlDef.underline) para.defaultUnderline = lvlDef.underline;
        if (!para.defaultStrike && lvlDef.strike) para.defaultStrike = lvlDef.strike;
        if (!para.defaultFont && lvlDef.font) para.defaultFont = lvlDef.font;
        if (para.align === 'left' && lvlDef.align) para.align = lvlDef.align;
      }
    }
  }
  // Text body properties
  const bodyPr = txBody ? qn(txBody, NS_A, 'bodyPr') : null;
  const anchor = bodyPr?.getAttribute('anchor');
  const wrapAttr = bodyPr?.getAttribute('wrap'); // "none" = no wrapping
  const noWrap = wrapAttr === 'none';
  // Auto-fit modes
  const autoFit = bodyPr ? !!dn(bodyPr, NS_A, 'spAutoFit') : false;
  const normAutofit = bodyPr ? dn(bodyPr, NS_A, 'normAutofit') : null;
  const fontScale = normAutofit ? (Number(normAutofit.getAttribute('fontScale') || '100000') / 1000) : 100;
  const lIns = bodyPr?.getAttribute('lIns'); const rIns = bodyPr?.getAttribute('rIns');
  const tIns = bodyPr?.getAttribute('tIns'); const bIns = bodyPr?.getAttribute('bIns');
  const margin = {
    l: lIns ? emuToPx(lIns) : 7, r: rIns ? emuToPx(rIns) : 7,
    t: tIns ? emuToPx(tIns) : 4, b: bIns ? emuToPx(bIns) : 4
  };
  // Attach blip fill target for shapes that have both image fill and text
  const blipTarget = isImageRef ? relMap[embedId] : null;
  // Return shape if it has text OR visual fill/border/blip (decorative shapes)
  if (!paragraphs.length && !bgColor && !line && !blipTarget) return null;
  return { type: 'text', ...tf, paragraphs, bgColor, blipTarget, line, anchor, margin, geom, noWrap, autoFit, fontScale };
}

// ── Group shapes (recursive, direct children only) ──
// Transforms child coordinates from group's child space (chOff/chExt) to parent space (off/ext)
function parseGroupShapes(grpEl, relMap, phStyles) {
  const shapes = [];

  // Read group transform: off/ext define position in parent, chOff/chExt define child coordinate space
  const grpSpPr = qn(grpEl, NS_P, 'grpSpPr');
  const xfrm = grpSpPr ? dn(grpSpPr, NS_A, 'xfrm') : null;
  let canMap = false;
  let gx = 0, gy = 0, sx = 1, sy = 1, cox = 0, coy = 0;
  if (xfrm) {
    const offEl = qn(xfrm, NS_A, 'off');
    const extEl = qn(xfrm, NS_A, 'ext');
    const chOffEl = qn(xfrm, NS_A, 'chOff');
    const chExtEl = qn(xfrm, NS_A, 'chExt');
    if (offEl && extEl && chExtEl) {
      const chCx = Number(chExtEl.getAttribute('cx') || '0');
      const chCy = Number(chExtEl.getAttribute('cy') || '0');
      if (chCx > 0 && chCy > 0) {
        gx = emuToPx(offEl.getAttribute('x') || '0');
        gy = emuToPx(offEl.getAttribute('y') || '0');
        cox = chOffEl ? emuToPx(chOffEl.getAttribute('x') || '0') : 0;
        coy = chOffEl ? emuToPx(chOffEl.getAttribute('y') || '0') : 0;
        sx = Number(extEl.getAttribute('cx') || '0') / chCx;
        sy = Number(extEl.getAttribute('cy') || '0') / chCy;
        canMap = true;
      }
    }
  }
  const mapCoords = (s) => {
    if (!canMap) return s;
    return { ...s, x: gx + (s.x - cox) * sx, y: gy + (s.y - coy) * sy, w: s.w * sx, h: s.h * sy };
  };

  // Iterate children in document order to preserve z-order within the group
  const grpShapeTypes = new Set(['sp', 'pic', 'cxnSp', 'grpSp']);
  for (const child of grpEl.children) {
    if (child.namespaceURI !== NS_P || !grpShapeTypes.has(child.localName)) continue;
    if (child.localName === 'grpSp') {
      for (const s of parseGroupShapes(child, relMap, phStyles)) shapes.push(mapCoords(s));
    } else {
      const s = parseShape(child, relMap, phStyles);
      if (s) shapes.push(mapCoords(s));
    }
  }
  return shapes;
}

function buildRelMap(relsXml) {
  const map = {};
  if (!relsXml) return map;
  try {
    const doc = parseXml(relsXml);
    for (const rel of doc.getElementsByTagName('Relationship')) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) map[id] = target;
    }
  } catch {}
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
    const xmlStr = await zip.file('ppt/presentation.xml')?.async('string');
    if (!xmlStr) return { w: 960, h: 540 };
    const doc = parseXml(xmlStr);
    const sldSz = dn(doc, NS_P, 'sldSz');
    if (sldSz) return { w: emuToPx(sldSz.getAttribute('cx') || '0'), h: emuToPx(sldSz.getAttribute('cy') || '0') };
  } catch {}
  return { w: 960, h: 540 };
}

// ── Slide layout/master background ──
async function getLayoutBg(slideDoc, relsXml, zip) {
  // Slide's own background
  const slideBg = dn(slideDoc, NS_P, 'bg');
  if (slideBg) { const c = parseFill(slideBg) || parseColor(slideBg); if (c) return c; }
  // Find layout from rels
  if (!relsXml) return null;
  const relsDoc = parseXml(relsXml);
  let layoutTarget = null;
  for (const rel of relsDoc.getElementsByTagName('Relationship')) {
    const t = rel.getAttribute('Target') || '';
    if (/slideLayout/i.test(t)) { layoutTarget = t; break; }
  }
  if (!layoutTarget) return null;
  const layoutPath = resolvePath(layoutTarget);
  try {
    const layoutXmlStr = await zip.file(layoutPath)?.async('string');
    if (!layoutXmlStr) return null;
    const layoutDoc = parseXml(layoutXmlStr);
    const bg = dn(layoutDoc, NS_P, 'bg');
    if (bg) { const c = parseColor(bg); if (c) return c; }
    // Check master from layout rels
    const layoutNum = layoutPath.match(/slideLayout(\d+)/)?.[1];
    const layoutRelsPath = `ppt/slideLayouts/_rels/slideLayout${layoutNum}.xml.rels`;
    const layoutRelsStr = await zip.file(layoutRelsPath)?.async('string').catch(() => null);
    if (!layoutRelsStr) return null;
    const layoutRelsDoc = parseXml(layoutRelsStr);
    let masterTarget = null;
    for (const rel of layoutRelsDoc.getElementsByTagName('Relationship')) {
      const t = rel.getAttribute('Target') || '';
      if (/slideMaster/i.test(t)) { masterTarget = t; break; }
    }
    if (!masterTarget) return null;
    const masterPath = masterTarget.startsWith('/') ? masterTarget.slice(1) : 'ppt/slideLayouts/' + masterTarget;
    const mParts = masterPath.split('/'); const mStack = [];
    for (const p of mParts) { if (p === '..') mStack.pop(); else if (p !== '.') mStack.push(p); }
    const masterXmlStr = await zip.file(mStack.join('/'))?.async('string');
    if (!masterXmlStr) return null;
    const masterDoc = parseXml(masterXmlStr);
    const masterBg = dn(masterDoc, NS_P, 'bg');
    if (masterBg) return parseColor(masterBg);
  } catch {}
  return null;
}

// ── Extract placeholder text styles from layout/master ──
function extractLstStyleDefaults(lstStyleEl) {
  const defaults = {};
  if (!lstStyleEl) return defaults;
  const lvlNames = ['defPPr', 'lvl1pPr', 'lvl2pPr', 'lvl3pPr', 'lvl4pPr', 'lvl5pPr'];
  for (let i = 0; i < lvlNames.length; i++) {
    const lvlPPr = qn(lstStyleEl, NS_A, lvlNames[i]);
    if (!lvlPPr) continue;
    // Paragraph-level: alignment
    const algn = lvlPPr.getAttribute('algn');
    const align = algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : (algn === 'l' ? 'left' : null);
    const dr = qn(lvlPPr, NS_A, 'defRPr');
    const lvlKey = i === 0 ? 'def' : i - 1;
    if (!dr) {
      if (align) defaults[lvlKey] = { fontSize: null, color: null, bold: false, italic: false, underline: false, strike: false, font: null, align };
      continue;
    }
    const sz = dr.getAttribute('sz');
    const c = parseColor(dr);
    const b = dr.getAttribute('b') === '1';
    const it = dr.getAttribute('i') === '1';
    const u = dr.getAttribute('u');
    const ul = u === 'sng' || u === 'dbl';
    const stk = dr.getAttribute('strike') === 'sngStrike';
    const latin = qn(dr, NS_A, 'latin');
    const ea = qn(dr, NS_A, 'ea');
    defaults[lvlKey] = {
      fontSize: sz ? Math.round(Number(sz) / 100) : null,
      color: c, bold: b, italic: it, underline: ul, strike: stk,
      font: latin ? latin.getAttribute('typeface') : (ea ? ea.getAttribute('typeface') : null),
      align
    };
  }
  return defaults;
}

function extractPhFromShape(spEl) {
  // Look for <p:nvSpPr><p:nvPr><p:ph type="..." idx="..."/>
  const nvSpPr = qn(spEl, NS_P, 'nvSpPr');
  if (!nvSpPr) return null;
  const nvPr = qn(nvSpPr, NS_P, 'nvPr');
  if (!nvPr) return null;
  const ph = qn(nvPr, NS_P, 'ph');
  if (!ph) return null;
  return { type: ph.getAttribute('type') || 'body', idx: ph.getAttribute('idx') || '' };
}

function extractPlaceholderStylesFromDoc(doc) {
  const phStyles = {};
  const spTree = dn(doc, NS_P, 'spTree') || dn(doc, NS_P, 'cSld');
  if (!spTree) return phStyles;
  for (const sp of qnAll(spTree, NS_P, 'sp')) {
    const phInfo = extractPhFromShape(sp);
    if (!phInfo) continue;
    // Extract transform (position/size) from layout/master placeholder
    const tf = parseTransform(sp);
    const txBody = dn(sp, NS_P, 'txBody');
    const lstStyle = txBody ? qn(txBody, NS_A, 'lstStyle') : null;
    const defaults = extractLstStyleDefaults(lstStyle);
    // Also check inline paragraphs for their defRPr (some layouts define style inline)
    if (txBody && Object.keys(defaults).length === 0) {
      const paras = qnAll(txBody, NS_A, 'p');
      for (const p of paras) {
        const pPr = qn(p, NS_A, 'pPr');
        const dr = pPr ? qn(pPr, NS_A, 'defRPr') : null;
        if (dr) {
          const sz = dr.getAttribute('sz');
          const c = parseColor(dr);
          const b = dr.getAttribute('b') === '1';
          const u = dr.getAttribute('u');
          const latin = qn(dr, NS_A, 'latin');
          const ea = qn(dr, NS_A, 'ea');
          const algn = pPr?.getAttribute('algn');
          defaults[0] = {
            fontSize: sz ? Math.round(Number(sz) / 100) : null,
            color: c, bold: b, italic: dr.getAttribute('i') === '1',
            underline: u === 'sng' || u === 'dbl', strike: dr.getAttribute('strike') === 'sngStrike',
            font: latin ? latin.getAttribute('typeface') : (ea ? ea.getAttribute('typeface') : null),
            align: algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'just' ? 'justify' : null
          };
          break;
        }
      }
    }
    const key = phInfo.type + (phInfo.idx ? ':' + phInfo.idx : '');
    defaults._transform = tf;
    const hasStyleDefaults = Object.keys(defaults).some(k => k !== '_transform');
    phStyles[key] = defaults;
    // Also store by type alone for fallback
    if (!phStyles[phInfo.type] || !Object.keys(phStyles[phInfo.type]).some(k => k !== '_transform')) {
      phStyles[phInfo.type] = defaults;
    }
  }
  return phStyles;
}

async function getPlaceholderStyles(relsXml, zip) {
  const result = {};
  if (!relsXml) return result;
  try {
    const relsDoc = parseXml(relsXml);
    let layoutTarget = null;
    for (const rel of relsDoc.getElementsByTagName('Relationship')) {
      const t = rel.getAttribute('Target') || '';
      if (/slideLayout/i.test(t)) { layoutTarget = t; break; }
    }
    if (!layoutTarget) return result;
    const layoutPath = resolvePath(layoutTarget);
    const layoutXmlStr = await zip.file(layoutPath)?.async('string');
    if (!layoutXmlStr) return result;
    const layoutDoc = parseXml(layoutXmlStr);
    // Extract styles from layout placeholders
    const layoutStyles = extractPlaceholderStylesFromDoc(layoutDoc);
    Object.assign(result, layoutStyles);

    // Also extract from txStyles in layout (rare but possible)
    // Now check slide master
    const layoutNum = layoutPath.match(/slideLayout(\d+)/)?.[1];
    const layoutRelsPath = `ppt/slideLayouts/_rels/slideLayout${layoutNum}.xml.rels`;
    const layoutRelsStr = await zip.file(layoutRelsPath)?.async('string').catch(() => null);
    if (!layoutRelsStr) return result;
    const layoutRelsDoc = parseXml(layoutRelsStr);
    let masterTarget = null;
    for (const rel of layoutRelsDoc.getElementsByTagName('Relationship')) {
      const t = rel.getAttribute('Target') || '';
      if (/slideMaster/i.test(t)) { masterTarget = t; break; }
    }
    if (!masterTarget) return result;
    const masterPath = masterTarget.startsWith('/') ? masterTarget.slice(1) : 'ppt/slideLayouts/' + masterTarget;
    const mParts = masterPath.split('/'); const mStack = [];
    for (const p of mParts) { if (p === '..') mStack.pop(); else if (p !== '.') mStack.push(p); }
    const resolvedMasterPath = mStack.join('/');
    const masterXmlStr = await zip.file(resolvedMasterPath)?.async('string');
    if (!masterXmlStr) return result;
    const masterDoc = parseXml(masterXmlStr);
    // Extract from master placeholders (lower priority)
    const masterStyles = extractPlaceholderStylesFromDoc(masterDoc);
    for (const [key, val] of Object.entries(masterStyles)) {
      if (!result[key] || Object.keys(result[key]).length === 0) result[key] = val;
    }
    // Extract from master txStyles (p:txStyles) — title/body/other style
    const txStyles = dn(masterDoc, NS_P, 'txStyles');
    if (txStyles) {
      const styleMap = { titleStyle: 'title', bodyStyle: 'body', otherStyle: 'other' };
      for (const [tag, phType] of Object.entries(styleMap)) {
        const styleEl = qn(txStyles, NS_P, tag);
        if (styleEl) {
          const defs = extractLstStyleDefaults(styleEl);
          if (!result[phType] || Object.keys(result[phType]).length === 0) {
            result[phType] = defs;
          } else {
            // Fill in missing levels
            for (const [lvl, val] of Object.entries(defs)) {
              if (!result[phType][lvl]) result[phType][lvl] = val;
            }
          }
          // ctrTitle uses titleStyle as well
          if (phType === 'title' && (!result['ctrTitle'] || Object.keys(result['ctrTitle']).length === 0)) {
            result['ctrTitle'] = defs;
          }
          // subTitle uses bodyStyle
          if (phType === 'body' && (!result['subTitle'] || Object.keys(result['subTitle']).length === 0)) {
            result['subTitle'] = defs;
          }
        }
      }
    }
  } catch {}
  return result;
}

// ═══════════════════════════════════════
// Canvas Renderer
// ═══════════════════════════════════════

// Convert pt to canvas px at given DPI scale
const ptToPx = (pt) => pt * 4 / 3; // 1pt = 1.333px at 96dpi

function buildCanvasFont(run, defaultFontSize) {
  const fs = run.fontSize || defaultFontSize || 12;
  const sizePx = ptToPx(fs);
  const style = run.italic ? 'italic ' : '';
  const weight = run.bold ? '700 ' : '';
  const rawFont = run.font;
  const family = rawFont ? (resolveFont(rawFont) || 'sans-serif') : (resolveFont(themeFontMinor) || 'sans-serif');
  return `${style}${weight}${sizePx}px ${family}`;
}

// Load image from zip as ImageBitmap (or Image fallback)
async function loadZipImage(zip, imgPath, objectUrls) {
  const file = zip.file(imgPath);
  if (!file) return null;
  const blob = await file.async('blob');
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  // Try createImageBitmap for better perf, fall back to Image
  try {
    return await createImageBitmap(blob);
  } catch {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
}

// Parse CSS linear-gradient into canvas-usable stops
function parseGradientStops(gradientStr) {
  const m = gradientStr.match(/linear-gradient\((\d+)deg,(.+)\)/);
  if (!m) return null;
  const angle = Number(m[1]);
  const parts = m[2].split(/,(?![^(]*\))/);
  const stops = [];
  for (const p of parts) {
    const t = p.trim();
    const cm = t.match(/^(#[0-9a-fA-F]{6})\s+(\d+)%$/);
    if (cm) stops.push({ color: cm[1], pos: Number(cm[2]) / 100 });
  }
  return stops.length >= 2 ? { angle, stops } : null;
}

function applyGradientFill(ctx, gradInfo, x, y, w, h) {
  const rad = (gradInfo.angle - 90) * Math.PI / 180;
  const cx = x + w / 2, cy = y + h / 2;
  const len = Math.max(w, h);
  const dx = Math.cos(rad) * len / 2, dy = Math.sin(rad) * len / 2;
  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  for (const s of gradInfo.stops) grad.addColorStop(s.pos, s.color);
  return grad;
}

// Word-wrap text into lines that fit within maxWidth
// CJK-aware word wrap: breaks on whitespace for Latin, per-character for CJK
function wrapText(ctx, text, maxWidth) {
  if (maxWidth <= 0) return [text];
  if (ctx.measureText(text).width <= maxWidth) return [text];

  // Segment text into tokens: CJK chars are individual tokens, Latin words stay grouped
  const CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u{20000}-\u{2FA1F}]/u;
  const tokens = [];
  let buf = '';
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(ch);
    } else if (/\s/.test(ch)) {
      if (buf) { tokens.push(buf); buf = ''; }
      tokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);

  const lines = [];
  let line = '';
  for (const tok of tokens) {
    const test = line + tok;
    if (ctx.measureText(test).width > maxWidth && line.length > 0) {
      lines.push(line);
      line = /\s/.test(tok) ? '' : tok;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

// Measure paragraph height (for vertical alignment)
function measureParagraphHeight(ctx, para, shapeW, margin, scale, autoNum) {
  const m = margin || { l: 7, r: 7, t: 4, b: 4 };
  const leftPad = ((m.l + (para.marginLeft || 0) + (para.indent || 0) * 20) * scale);
  const contentW = shapeW - (m.l + m.r) * scale - ((para.marginLeft || 0) + (para.indent || 0) * 20) * scale;
  const lh = para.lineHeight || 1.35;
  const spaceBefore = (para.spaceBefore || 0) * scale * 4 / 3;
  const spaceAfter = (para.spaceAfter || 2) * scale * 4 / 3;

  let totalH = spaceBefore;
  // Build full text segments for measurement
  const segments = [];
  if (para.bullet) {
    const bulletText = para.bullet === 'auto' ? `${autoNum.n}. ` : `${para.bullet} `;
    segments.push({ text: bulletText, fontSize: para.defaultFontSize || 12 });
  }
  for (const run of para.runs) {
    if (run.text === '\n') { segments.push({ text: '\n', fontSize: run.fontSize || para.defaultFontSize || 12 }); continue; }
    const fs = run.fontSize || para.defaultFontSize || 12;
    segments.push({ text: run.text, fontSize: fs, font: buildCanvasFont(run, para.defaultFontSize) });
  }

  // Simple height estimate: measure each run's text and wrap
  let maxFontSize = 12;
  let lineText = '';
  for (const seg of segments) {
    if (seg.fontSize > maxFontSize) maxFontSize = seg.fontSize;
    if (seg.text === '\n') {
      const lineH = ptToPx(maxFontSize) * scale * lh;
      totalH += lineH;
      lineText = '';
      maxFontSize = 12;
      continue;
    }
    lineText += seg.text;
  }
  if (lineText) {
    // Estimate line count
    ctx.font = `${ptToPx(maxFontSize) * scale}px sans-serif`;
    const lines = wrapText(ctx, lineText, Math.max(1, contentW));
    totalH += lines.length * ptToPx(maxFontSize) * scale * lh;
  }
  totalH += spaceAfter;
  return totalH;
}

// Detect if a color is "dark" (luminance < 0.4)
function isDarkColor(hex) {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return false;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) < 0.4;
}

function drawTextShape(ctx, shape, sx, sy, sw, sh, scale, relMap) {
  const m = shape.margin || { l: 7, r: 7, t: 4, b: 4 };
  const padL = m.l * scale, padR = m.r * scale, padT = m.t * scale, padB = m.b * scale;
  const contentW = sw - padL - padR;
  // normAutofit: scale font sizes by fontScale percentage
  const fScale = (shape.fontScale || 100) / 100;
  // Smart default text color: use white on dark backgrounds (solid, gradient, or blip)
  const shapeBg = shape.bgColor;
  let darkBg = false;
  if (shapeBg && typeof shapeBg === 'string') {
    if (shapeBg.startsWith('linear-gradient')) {
      // Check first gradient stop color
      const firstColor = shapeBg.match(/#[0-9a-fA-F]{6}/);
      darkBg = firstColor ? isDarkColor(firstColor[0]) : false;
    } else {
      darkBg = isDarkColor(shapeBg);
    }
  } else if (shape.blipTarget) {
    darkBg = false; // can't detect image brightness, default to dark text
  }
  const defaultTextColor = darkBg ? '#ffffff' : (themeColors.tx1 || '#1e293b');

  // Measure total content height for vertical alignment
  let totalContentH = 0;
  const autoNumMeasure = { n: 1 };
  for (const para of shape.paragraphs) {
    totalContentH += measureParagraphHeight(ctx, para, sw, m, scale, autoNumMeasure);
  }

  let startY = sy + padT;
  if (shape.anchor === 'ctr') {
    startY = sy + padT + Math.max(0, (sh - padT - padB - totalContentH) / 2);
  } else if (shape.anchor === 'b') {
    startY = sy + sh - padB - totalContentH;
  }

  let curY = startY;
  const autoNum = { n: 1 };

  for (const para of shape.paragraphs) {
    const lh = para.lineHeight || 1.35;
    const spaceBefore = (para.spaceBefore || 0) * scale * 4 / 3;
    const spaceAfter = (para.spaceAfter || 2) * scale * 4 / 3;
    const paraLeftPad = ((para.marginLeft || 0) + (para.indent || 0) * 20) * scale;
    curY += spaceBefore;

    // Build drawable segments for this paragraph
    const segments = [];
    if (para.bullet) {
      const bulletText = para.bullet === 'auto' ? `${autoNum.n++}. ` : `${para.bullet} `;
      const bFs = (para.defaultFontSize || 12) * fScale;
      segments.push({
        text: bulletText,
        font: `${ptToPx(bFs) * scale}px ${resolveFont(themeFontMinor) || 'sans-serif'}`,
        color: para.bulletColor || shape.paragraphs[0]?.runs[0]?.color || defaultTextColor,
        fontSize: bFs, underline: false, strike: false, baseline: null
      });
    }
    for (const run of para.runs) {
      if (run.text === '\n') { segments.push({ text: '\n' }); continue; }
      const fs = (run.fontSize || para.defaultFontSize || 12) * fScale;
      const effectiveFs = run.baseline ? fs * 0.65 : fs;
      const isBold = run.bold || para.defaultBold || false;
      const isItalic = run.italic || para.defaultItalic || false;
      const runFont = run.font || para.defaultFont;
      segments.push({
        text: run.text,
        font: `${isItalic ? 'italic ' : ''}${isBold ? '700 ' : ''}${ptToPx(effectiveFs) * scale}px ${resolveFont(runFont) || resolveFont(themeFontMinor) || 'sans-serif'}`,
        color: run.color || para.defaultColor || defaultTextColor,
        fontSize: fs,
        underline: run.underline || para.defaultUnderline || false,
        strike: run.strike || para.defaultStrike || false,
        baseline: run.baseline
      });
    }

    // Line-break and draw
    const lineStartX = sx + padL + paraLeftPad;
    const maxLineW = shape.noWrap ? Infinity : (contentW - paraLeftPad);

    // Split segments into wrapped lines
    const lines = []; // each line = [{ text, font, color, ... }]
    let currentLine = [];
    let currentLineW = 0;

    for (const seg of segments) {
      if (seg.text === '\n') {
        lines.push(currentLine);
        currentLine = [];
        currentLineW = 0;
        continue;
      }
      ctx.font = seg.font;
      const segW = ctx.measureText(seg.text).width;

      if (currentLineW + segW <= maxLineW || currentLine.length === 0) {
        currentLine.push(seg);
        currentLineW += segW;
      } else {
        // Need to wrap: tokenize CJK-aware
        const CJK = /[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u{20000}-\u{2FA1F}]/u;
        const words = [];
        let _b = '';
        for (const ch of seg.text) {
          if (CJK.test(ch)) { if (_b) { words.push(_b); _b = ''; } words.push(ch); }
          else if (/\s/.test(ch)) { if (_b) { words.push(_b); _b = ''; } words.push(ch); }
          else _b += ch;
        }
        if (_b) words.push(_b);
        let partial = '';
        for (const word of words) {
          const testW = ctx.measureText(partial + word).width;
          if (currentLineW + testW > maxLineW && (partial || currentLine.length > 0)) {
            if (partial) currentLine.push({ ...seg, text: partial });
            lines.push(currentLine);
            currentLine = [];
            currentLineW = 0;
            partial = word.trimStart();
          } else {
            partial += word;
          }
        }
        if (partial) {
          ctx.font = seg.font;
          currentLine.push({ ...seg, text: partial });
          currentLineW += ctx.measureText(partial).width;
        }
      }
    }
    if (currentLine.length) lines.push(currentLine);

    // Draw each line
    for (const line of lines) {
      let maxFs = 12;
      for (const s of line) { if (s.fontSize > maxFs) maxFs = s.fontSize; }
      const lineH = ptToPx(maxFs) * scale * lh;

      // Calculate line width for alignment
      let totalLineW = 0;
      for (const s of line) {
        ctx.font = s.font;
        totalLineW += ctx.measureText(s.text).width;
      }

      let drawX = lineStartX;
      if (para.align === 'center') drawX = lineStartX + (maxLineW - totalLineW) / 2;
      else if (para.align === 'right') drawX = lineStartX + maxLineW - totalLineW;

      const baselineY = curY + ptToPx(maxFs) * scale;

      for (const seg of line) {
        ctx.font = seg.font;
        ctx.fillStyle = seg.color || '#000';

        let segY = baselineY;
        if (seg.baseline && seg.baseline > 0) segY = baselineY - ptToPx(maxFs) * scale * 0.3;
        else if (seg.baseline && seg.baseline < 0) segY = baselineY + ptToPx(maxFs) * scale * 0.15;

        ctx.fillText(seg.text, drawX, segY);

        const tw = ctx.measureText(seg.text).width;
        if (seg.underline) {
          ctx.beginPath();
          ctx.strokeStyle = seg.color || '#000';
          ctx.lineWidth = Math.max(1, scale);
          ctx.moveTo(drawX, segY + 2 * scale);
          ctx.lineTo(drawX + tw, segY + 2 * scale);
          ctx.stroke();
        }
        if (seg.strike) {
          ctx.beginPath();
          ctx.strokeStyle = seg.color || '#000';
          ctx.lineWidth = Math.max(1, scale);
          const strikeY = segY - ptToPx(maxFs) * scale * 0.3;
          ctx.moveTo(drawX, strikeY);
          ctx.lineTo(drawX + tw, strikeY);
          ctx.stroke();
        }
        drawX += tw;
      }
      curY += lineH;
    }
    curY += spaceAfter;
  }
}

function drawTable(ctx, shape, sx, sy, sw, sh, scale) {
  if (!shape.rows || !shape.rows.length) return;
  const rowCount = shape.rows.length;
  const colCount = Math.max(...shape.rows.map(r => r.length));
  if (!colCount) return;

  // Calculate column positions from parsed widths or equal distribution
  const totalGridW = shape.colWidths?.length ? shape.colWidths.reduce((a, b) => a + b, 0) : 1;
  const colXs = [0]; // cumulative x positions as fraction of sw
  if (shape.colWidths?.length && totalGridW > 0) {
    let acc = 0;
    for (const w of shape.colWidths) { acc += w; colXs.push(acc / totalGridW); }
  } else {
    for (let i = 1; i <= colCount; i++) colXs.push(i / colCount);
  }

  // Row positions from parsed heights or equal distribution
  const totalGridH = shape.rowHeights?.length ? shape.rowHeights.reduce((a, b) => a + b, 0) : 1;
  const rowYs = [0];
  if (shape.rowHeights?.length && totalGridH > 0) {
    let acc = 0;
    for (const h of shape.rowHeights) { acc += h; rowYs.push(acc / totalGridH); }
  } else {
    for (let i = 1; i <= rowCount; i++) rowYs.push(i / rowCount);
  }

  const padding = 4 * scale;
  const defaultFamily = resolveFont(themeFontMinor) || 'sans-serif';
  const defaultTextColor = themeColors.tx1 || '#1e293b';

  for (let ri = 0; ri < rowCount; ri++) {
    const row = shape.rows[ri];
    let colIdx = 0;
    for (let ci = 0; ci < row.length; ci++) {
      const cell = row[ci];
      if (cell.hMerge || cell.vMerge) { colIdx += (cell.gridSpan || 1); continue; }

      const cx = sx + colXs[colIdx] * sw;
      const cy = sy + rowYs[ri] * sh;
      const endCol = Math.min(colIdx + (cell.gridSpan || 1), colXs.length - 1);
      const endRow = Math.min(ri + (cell.rowSpan || 1), rowYs.length - 1);
      const cw = (colXs[endCol] - colXs[colIdx]) * sw;
      const ch = (rowYs[endRow] - rowYs[ri]) * sh;
      colIdx += (cell.gridSpan || 1);

      // Cell background
      if (cell.fill) {
        ctx.fillStyle = cell.fill;
        ctx.fillRect(cx, cy, cw, ch);
      }
      // Cell border
      ctx.strokeStyle = cell.borderColor || '#cbd5e1';
      ctx.lineWidth = scale;
      ctx.strokeRect(cx, cy, cw, ch);

      // Cell text — mirror drawTextShape logic with bullet, bold/italic/underline inheritance
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx, cy, cw, ch);
      ctx.clip();

      let textY = cy + padding;
      const cellMaxW = cw - padding * 2;

      for (const para of cell.paragraphs) {
        const lh = para.lineHeight || 1.35;
        const spaceBefore = (para.spaceBefore || 0) * scale * 4 / 3;
        textY += spaceBefore;

        // Build segments (same logic as drawTextShape)
        const segments = [];
        if (para.bullet) {
          const bulletText = para.bullet === 'auto' ? '• ' : `${para.bullet} `;
          const bFs = para.defaultFontSize || 12;
          segments.push({
            text: bulletText,
            fontSize: bFs,
            font: `${ptToPx(bFs) * scale}px ${defaultFamily}`,
            color: para.bulletColor || defaultTextColor,
            underline: false, strike: false
          });
        }
        for (const run of para.runs) {
          if (run.text === '\n') { segments.push({ text: '\n' }); continue; }
          const fs = run.fontSize || para.defaultFontSize || 12;
          const isBold = run.bold || para.defaultBold || false;
          const isItalic = run.italic || para.defaultItalic || false;
          const runFont = run.font || para.defaultFont;
          segments.push({
            text: run.text,
            fontSize: fs,
            font: `${isItalic ? 'italic ' : ''}${isBold ? '700 ' : ''}${ptToPx(fs) * scale}px ${resolveFont(runFont) || defaultFamily}`,
            color: run.color || para.defaultColor || defaultTextColor,
            underline: run.underline || para.defaultUnderline || false,
            strike: run.strike || para.defaultStrike || false
          });
        }

        if (!segments.length) continue;

        // Wrap and draw segments line by line
        const maxFs = Math.max(...segments.filter(s => s.fontSize).map(s => s.fontSize), 12);
        const lineH = ptToPx(maxFs) * scale * lh;

        // Simple segment-aware line wrapping
        let lineSegs = []; // segments on current line
        let lineW = 0;

        const flushLine = () => {
          if (!lineSegs.length) return;
          textY += lineH;
          if (textY > cy + ch) return;
          let drawX = cx + padding;
          const totalW = lineSegs.reduce((a, s) => a + s.measuredW, 0);
          if (para.align === 'center') drawX = cx + (cw - totalW) / 2;
          else if (para.align === 'right') drawX = cx + cw - padding - totalW;

          for (const seg of lineSegs) {
            ctx.font = seg.font;
            ctx.fillStyle = seg.color;
            ctx.fillText(seg.text, drawX, textY);
            // Underline
            if (seg.underline) {
              ctx.beginPath();
              ctx.strokeStyle = seg.color;
              ctx.lineWidth = Math.max(1, scale);
              ctx.moveTo(drawX, textY + 2 * scale);
              ctx.lineTo(drawX + seg.measuredW, textY + 2 * scale);
              ctx.stroke();
            }
            // Strikethrough
            if (seg.strike) {
              ctx.beginPath();
              ctx.strokeStyle = seg.color;
              ctx.lineWidth = Math.max(1, scale);
              const strikeY = textY - ptToPx(maxFs) * scale * 0.3;
              ctx.moveTo(drawX, strikeY);
              ctx.lineTo(drawX + seg.measuredW, strikeY);
              ctx.stroke();
            }
            drawX += seg.measuredW;
          }
          lineSegs = [];
          lineW = 0;
        };

        for (const seg of segments) {
          if (seg.text === '\n') { flushLine(); continue; }
          ctx.font = seg.font;
          // Break segment text into wrappable tokens
          const words = wrapText(ctx, seg.text, cellMaxW);
          if (words.length <= 1) {
            // Fits on one line or single token
            const tw = ctx.measureText(seg.text).width;
            if (lineW + tw > cellMaxW && lineSegs.length > 0) flushLine();
            lineSegs.push({ ...seg, text: seg.text, measuredW: tw });
            lineW += tw;
          } else {
            // Multi-line wrap needed
            for (let wi = 0; wi < words.length; wi++) {
              const word = words[wi];
              const tw = ctx.measureText(word).width;
              if (wi > 0) flushLine();
              lineSegs.push({ ...seg, text: word, measuredW: tw });
              lineW += tw;
            }
          }
        }
        flushLine();

        const spaceAfter = (para.spaceAfter || 1) * scale * 4 / 3;
        textY += spaceAfter;
      }
      ctx.restore();
    }
  }
}

// Draw preset geometry path (arrows, stars, etc.)
function drawGeomPath(ctx, geom, sx, sy, sw, sh) {
  ctx.beginPath();
  switch (geom) {
    case 'ellipse':
      ctx.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      break;
    case 'roundRect': {
      const r = Math.min(sw * 0.1, sh * 0.1, 20);
      ctx.moveTo(sx + r, sy);
      ctx.arcTo(sx + sw, sy, sx + sw, sy + sh, r);
      ctx.arcTo(sx + sw, sy + sh, sx, sy + sh, r);
      ctx.arcTo(sx, sy + sh, sx, sy, r);
      ctx.arcTo(sx, sy, sx + sw, sy, r);
      break;
    }
    case 'rightArrow': {
      const headW = Math.min(sw * 0.4, sh * 0.6);
      const shaftH = sh * 0.4;
      const shaftTop = sy + (sh - shaftH) / 2;
      ctx.moveTo(sx, shaftTop);
      ctx.lineTo(sx + sw - headW, shaftTop);
      ctx.lineTo(sx + sw - headW, sy);
      ctx.lineTo(sx + sw, sy + sh / 2);
      ctx.lineTo(sx + sw - headW, sy + sh);
      ctx.lineTo(sx + sw - headW, shaftTop + shaftH);
      ctx.lineTo(sx, shaftTop + shaftH);
      break;
    }
    case 'leftArrow': {
      const headW = Math.min(sw * 0.4, sh * 0.6);
      const shaftH = sh * 0.4;
      const shaftTop = sy + (sh - shaftH) / 2;
      ctx.moveTo(sx + sw, shaftTop);
      ctx.lineTo(sx + headW, shaftTop);
      ctx.lineTo(sx + headW, sy);
      ctx.lineTo(sx, sy + sh / 2);
      ctx.lineTo(sx + headW, sy + sh);
      ctx.lineTo(sx + headW, shaftTop + shaftH);
      ctx.lineTo(sx + sw, shaftTop + shaftH);
      break;
    }
    case 'upArrow': {
      const headH = Math.min(sh * 0.4, sw * 0.6);
      const shaftW = sw * 0.4;
      const shaftLeft = sx + (sw - shaftW) / 2;
      ctx.moveTo(shaftLeft, sy + sh);
      ctx.lineTo(shaftLeft, sy + headH);
      ctx.lineTo(sx, sy + headH);
      ctx.lineTo(sx + sw / 2, sy);
      ctx.lineTo(sx + sw, sy + headH);
      ctx.lineTo(shaftLeft + shaftW, sy + headH);
      ctx.lineTo(shaftLeft + shaftW, sy + sh);
      break;
    }
    case 'downArrow': {
      const headH = Math.min(sh * 0.4, sw * 0.6);
      const shaftW = sw * 0.4;
      const shaftLeft = sx + (sw - shaftW) / 2;
      ctx.moveTo(shaftLeft, sy);
      ctx.lineTo(shaftLeft, sy + sh - headH);
      ctx.lineTo(sx, sy + sh - headH);
      ctx.lineTo(sx + sw / 2, sy + sh);
      ctx.lineTo(sx + sw, sy + sh - headH);
      ctx.lineTo(shaftLeft + shaftW, sy + sh - headH);
      ctx.lineTo(shaftLeft + shaftW, sy);
      break;
    }
    case 'diamond': {
      ctx.moveTo(sx + sw / 2, sy);
      ctx.lineTo(sx + sw, sy + sh / 2);
      ctx.lineTo(sx + sw / 2, sy + sh);
      ctx.lineTo(sx, sy + sh / 2);
      break;
    }
    case 'triangle':
    case 'isoscelesTriangle': {
      ctx.moveTo(sx + sw / 2, sy);
      ctx.lineTo(sx + sw, sy + sh);
      ctx.lineTo(sx, sy + sh);
      break;
    }
    case 'hexagon': {
      const inset = sw * 0.25;
      ctx.moveTo(sx + inset, sy);
      ctx.lineTo(sx + sw - inset, sy);
      ctx.lineTo(sx + sw, sy + sh / 2);
      ctx.lineTo(sx + sw - inset, sy + sh);
      ctx.lineTo(sx + inset, sy + sh);
      ctx.lineTo(sx, sy + sh / 2);
      break;
    }
    case 'star5': {
      const cx = sx + sw / 2, cy2 = sy + sh / 2;
      const outerR = Math.min(sw, sh) / 2;
      const innerR = outerR * 0.38;
      for (let i = 0; i < 5; i++) {
        const outerAngle = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const innerAngle = outerAngle + Math.PI / 5;
        if (i === 0) ctx.moveTo(cx + outerR * Math.cos(outerAngle), cy2 + outerR * Math.sin(outerAngle));
        else ctx.lineTo(cx + outerR * Math.cos(outerAngle), cy2 + outerR * Math.sin(outerAngle));
        ctx.lineTo(cx + innerR * Math.cos(innerAngle), cy2 + innerR * Math.sin(innerAngle));
      }
      break;
    }
    default:
      // Fallback: rectangle
      ctx.rect(sx, sy, sw, sh);
      break;
  }
  ctx.closePath();
}

async function drawShapeOnCanvas(ctx, shape, zip, canvasW, canvasH, slideSize, scale, objectUrls) {
  const sx = shape.x / slideSize.w * canvasW;
  const sy = shape.y / slideSize.h * canvasH;
  const sw = shape.w / slideSize.w * canvasW;
  const sh = shape.h / slideSize.h * canvasH;

  ctx.save();
  if (shape.rot) {
    const cx = sx + sw / 2, cy = sy + sh / 2;
    ctx.translate(cx, cy);
    ctx.rotate(shape.rot * Math.PI / 180);
    ctx.translate(-cx, -cy);
  }

  if (shape.type === 'image') {
    // Clip to shape geometry for images
    if (shape.geom && shape.geom !== 'rect') {
      drawGeomPath(ctx, shape.geom, sx, sy, sw, sh);
      ctx.clip();
    }
    const imgPath = resolvePath(shape.target);
    try {
      const img = await loadZipImage(zip, imgPath, objectUrls);
      if (img) {
        if (shape.fillMode === 'stretch') {
          ctx.drawImage(img, sx, sy, sw, sh);
        } else {
          // Cover-fit: fill shape bounds, crop excess (matches PPT behavior)
          const imgW = img.width, imgH = img.height;
          const imgAspect = imgW / imgH;
          const shapeAspect = sw / sh;
          let dw, dh, dx, dy;
          if (imgAspect > shapeAspect) {
            // Image wider than shape: match height, crop sides
            dh = sh; dw = sh * imgAspect; dy = sy; dx = sx + (sw - dw) / 2;
          } else {
            // Image taller than shape: match width, crop top/bottom
            dw = sw; dh = sw / imgAspect; dx = sx; dy = sy + (sh - dh) / 2;
          }
          ctx.drawImage(img, dx, dy, dw, dh);
        }
      }
    } catch {}
  } else if (shape.type === 'table') {
    drawTable(ctx, shape, sx, sy, sw, sh, scale);
  } else if (shape.type === 'text') {
    const geom = shape.geom || 'rect';
    const isRect = geom === 'rect';

    // Draw blip fill (image background) for shapes with both image and text
    if (shape.blipTarget) {
      try {
        const imgPath = resolvePath(shape.blipTarget);
        const img = await loadZipImage(zip, imgPath, objectUrls);
        if (img) {
          if (geom !== 'rect') { drawGeomPath(ctx, geom, sx, sy, sw, sh); ctx.clip(); }
          ctx.drawImage(img, sx, sy, sw, sh);
        }
      } catch (_e) { /* blip fill failed, continue with text */ }
    }

    // Draw shape fill using geometry path
    if (shape.bgColor || shape.line) {
      drawGeomPath(ctx, geom, sx, sy, sw, sh);
      if (shape.bgColor) {
        const gradInfo = shape.bgColor.startsWith?.('linear-gradient') ? parseGradientStops(shape.bgColor) : null;
        ctx.fillStyle = gradInfo ? applyGradientFill(ctx, gradInfo, sx, sy, sw, sh) : shape.bgColor;
        ctx.fill();
      }
      if (shape.line) {
        ctx.strokeStyle = shape.line.color;
        ctx.lineWidth = shape.line.width * scale;
        ctx.stroke();
      }
    }

    // Draw text — no clipping (PPT text commonly overflows shape bounds)
    if (shape.paragraphs && shape.paragraphs.length) {
      drawTextShape(ctx, shape, sx, sy, sw, sh, scale, {});
    }
  }

  ctx.restore();
}

async function buildSlideCanvas(slideXmlStr, relsXml, zip, slideSize, objectUrls) {
  const slideDoc = parseXml(slideXmlStr);
  const relMap = buildRelMap(relsXml);
  const bgColor = await getLayoutBg(slideDoc, relsXml, zip) || '#ffffff';

  // Get placeholder text styles from layout/master for font size inheritance
  const phStyles = await getPlaceholderStyles(relsXml, zip);

  // Check for background image
  let bgImage = null;
  const slideBgEl = dn(slideDoc, NS_P, 'bg');
  if (slideBgEl) {
    const bgBlip = dn(slideBgEl, NS_A, 'blip');
    const bgEmbed = bgBlip ? (bgBlip.getAttributeNS(NS_R, 'embed') || bgBlip.getAttribute('r:embed')) : null;
    if (bgEmbed && relMap[bgEmbed]) {
      const bgPath = resolvePath(relMap[bgEmbed]);
      bgImage = await loadZipImage(zip, bgPath, objectUrls);
    }
  }

  // Collect shapes in document order (preserves z-order: later elements render on top)
  const allShapes = [];
  const spTree = dn(slideDoc, NS_P, 'spTree');
  if (spTree) {
    const shapeTypes = new Set(['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame']);
    for (const child of spTree.children) {
      if (child.namespaceURI !== NS_P || !shapeTypes.has(child.localName)) continue;
      if (child.localName === 'grpSp') {
        allShapes.push(...parseGroupShapes(child, relMap, phStyles));
      } else {
        const s = parseShape(child, relMap, phStyles);
        if (s) allShapes.push(s);
      }
    }
  }

  // Return a render function that draws onto a sized canvas
  return { bgColor, bgImage, shapes: allShapes, relMap };
}

function renderSlideToCanvas(canvas, slideData, slideSize, zip, objectUrls) {
  const dpr = window.devicePixelRatio || 1;
  // Use container width to determine canvas size
  const displayW = canvas.parentElement?.clientWidth || canvas.clientWidth || 360;
  const aspect = slideSize.h / slideSize.w;
  const displayH = Math.round(displayW * aspect);

  canvas.style.width = '100%';
  canvas.style.height = 'auto';
  canvas.style.aspectRatio = `${slideSize.w}/${slideSize.h}`;
  canvas.width = Math.round(displayW * dpr);
  canvas.height = Math.round(displayH * dpr);

  const ctx = canvas.getContext('2d');
  const scale = canvas.width / slideSize.w;

  // Background
  ctx.fillStyle = slideData.bgColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (slideData.bgImage) {
    ctx.drawImage(slideData.bgImage, 0, 0, canvas.width, canvas.height);
  }

  // Draw shapes sequentially (images are async)
  return (async () => {
    for (const shape of slideData.shapes) {
      await drawShapeOnCanvas(ctx, shape, zip, canvas.width, canvas.height, slideSize, scale, objectUrls);
    }
  })();
}

// ═══════════════════════════════════════
// Thumbnail — render first slide to canvas for chat bubble preview
// ═══════════════════════════════════════
export async function renderPptxThumbnail(buffer, canvas) {
  if (!canvas) return false;
  try {
    const JSZip = await ensureJSZip();
    const zip = await JSZip.loadAsync(buffer);
    const slideSize = await getSlideSize(zip);
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string');
    if (!slideXml) return false;
    const slideRels = await zip.file('ppt/slides/_rels/slide1.xml.rels')?.async('string').catch(() => null);
    // Parse theme for font resolution
    try {
      const themeStr = await zip.file('ppt/theme/theme1.xml')?.async('string');
      if (themeStr) {
        const themeDoc = parseXml(themeStr);
        const majorFont = dn(themeDoc, NS_A, 'majorFont');
        const minorFont = dn(themeDoc, NS_A, 'minorFont');
        themeFontMajor = majorFont ? (qn(majorFont, NS_A, 'latin')?.getAttribute('typeface') || null) : null;
        themeFontMinor = minorFont ? (qn(minorFont, NS_A, 'latin')?.getAttribute('typeface') || null) : null;
      }
    } catch {}
    const objectUrls = [];
    const slideData = await buildSlideCanvas(slideXml, slideRels, zip, slideSize, objectUrls);
    // Render to canvas at thumbnail size
    const targetW = 240;
    const aspect = slideSize.h / slideSize.w;
    const targetH = Math.round(targetW * aspect);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(targetW * dpr);
    canvas.height = Math.round(targetH * dpr);
    canvas.style.width = targetW + 'px';
    canvas.style.height = targetH + 'px';
    const ctx = canvas.getContext('2d');
    const scale = canvas.width / slideSize.w;
    ctx.fillStyle = slideData.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (slideData.bgImage) ctx.drawImage(slideData.bgImage, 0, 0, canvas.width, canvas.height);
    for (const shape of slideData.shapes) {
      await drawShapeOnCanvas(ctx, shape, zip, canvas.width, canvas.height, slideSize, scale, objectUrls);
    }
    // Cleanup object URLs
    for (const u of objectUrls) { try { URL.revokeObjectURL(u); } catch {} }
    return true;
  } catch (err) {
    log({ pptxThumbnailError: err?.message || err });
    return false;
  }
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
    // Parse theme for real colors + fonts
    themeColors = {}; themeFontMajor = 'Calibri'; themeFontMinor = 'Calibri';
    await parseTheme(zip);
    const slideSize = await getSlideSize(zip);

    const slideFiles = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
      .sort((a, b) => parseInt(a.match(/slide(\d+)/)?.[1] || '0') - parseInt(b.match(/slide(\d+)/)?.[1] || '0'));

    if (!slideFiles.length) throw new Error('No slides found');
    if (loadingEl) loadingEl.remove();

    // Build all slides as canvases
    const slideEls = [];
    const slideDataList = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const slideXml = await zip.file(slideFiles[i])?.async('string');
      if (!slideXml) continue;
      const slideNum = slideFiles[i].match(/slide(\d+)/)?.[1] || '1';
      const relsXml = await zip.file(`ppt/slides/_rels/slide${slideNum}.xml.rels`)?.async('string').catch(() => null);
      const slideData = await buildSlideCanvas(slideXml, relsXml, zip, slideSize, objectUrls);

      const wrapper = document.createElement('div');
      wrapper.className = 'pptx-slide';
      wrapper.style.cssText = `position:relative;width:100%;`;

      const canvas = document.createElement('canvas');
      canvas.className = 'pptx-slide-canvas';
      wrapper.appendChild(canvas);

      // Slide number overlay
      const numEl = document.createElement('div');
      numEl.className = 'pptx-slide-num';
      numEl.textContent = `${i + 1}`;
      wrapper.appendChild(numEl);

      stageEl.appendChild(wrapper);
      slideEls.push(wrapper);
      slideDataList.push({ canvas, slideData });
    }

    // Render all canvases (after DOM insertion so clientWidth is available)
    for (const { canvas, slideData } of slideDataList) {
      await renderSlideToCanvas(canvas, slideData, slideSize, zip, objectUrls);
    }

    pageLabel.textContent = `${slideEls.length} ${t('viewer.pptxSlides')}`;

    // ── Pinch-to-zoom ──
    let zoomScale = 1;
    let zoomOriginX = 0, zoomOriginY = 0;
    let panX = 0, panY = 0;
    let pinchStartDist = 0;
    let pinchStartScale = 1;
    let pinchMidX = 0, pinchMidY = 0;
    let panStartX = 0, panStartY = 0;
    let panStartPanX = 0, panStartPanY = 0;
    let isPanning = false;

    function applyZoom() {
      stageEl.style.transformOrigin = `${zoomOriginX}px ${zoomOriginY}px`;
      stageEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoomScale})`;
    }

    function resetZoom() {
      zoomScale = 1; panX = 0; panY = 0;
      stageEl.style.transform = '';
      stageEl.style.transformOrigin = '';
    }

    function getTouchDist(t1, t2) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const t0 = e.touches[0], t1 = e.touches[1];
        pinchStartDist = getTouchDist(t0, t1);
        pinchStartScale = zoomScale;
        const rect = stageEl.getBoundingClientRect();
        pinchMidX = ((t0.clientX + t1.clientX) / 2 - rect.left) / zoomScale - panX / zoomScale;
        pinchMidY = ((t0.clientY + t1.clientY) / 2 - rect.top) / zoomScale - panY / zoomScale;
        zoomOriginX = pinchMidX;
        zoomOriginY = pinchMidY;
        isPanning = false;
      } else if (e.touches.length === 1 && zoomScale > 1) {
        isPanning = true;
        panStartX = e.touches[0].clientX;
        panStartY = e.touches[0].clientY;
        panStartPanX = panX;
        panStartPanY = panY;
      }
    };

    const onTouchMove = (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const dist = getTouchDist(e.touches[0], e.touches[1]);
        const newScale = Math.max(1, Math.min(5, pinchStartScale * (dist / pinchStartDist)));
        zoomScale = newScale;

        // Adjust pan to keep pinch center stable
        if (zoomScale <= 1) { panX = 0; panY = 0; }
        applyZoom();
      } else if (e.touches.length === 1 && isPanning && zoomScale > 1) {
        e.preventDefault();
        panX = panStartPanX + (e.touches[0].clientX - panStartX);
        panY = panStartPanY + (e.touches[0].clientY - panStartY);
        applyZoom();
      }
    };

    const onTouchEnd = (e) => {
      if (e.touches.length < 2) {
        if (zoomScale <= 1.05) resetZoom();
        isPanning = false;
      }
    };

    // Double-tap to reset zoom
    let lastTap = 0;
    const onDoubleTap = (e) => {
      if (e.touches.length !== 1) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        if (zoomScale > 1.05) {
          resetZoom();
        } else {
          zoomScale = 2.5;
          const rect = stageEl.getBoundingClientRect();
          zoomOriginX = (e.touches[0].clientX - rect.left);
          zoomOriginY = (e.touches[0].clientY - rect.top);
          panX = 0; panY = 0;
          applyZoom();
        }
      }
      lastTap = now;
    };

    stageEl.addEventListener('touchstart', onTouchStart, { passive: false });
    stageEl.addEventListener('touchstart', onDoubleTap, { passive: false });
    stageEl.addEventListener('touchmove', onTouchMove, { passive: false });
    stageEl.addEventListener('touchend', onTouchEnd, { passive: true });

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
      stageEl.removeEventListener('touchstart', onTouchStart);
      stageEl.removeEventListener('touchstart', onDoubleTap);
      stageEl.removeEventListener('touchmove', onTouchMove);
      stageEl.removeEventListener('touchend', onTouchEnd);
      resetZoom();
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
