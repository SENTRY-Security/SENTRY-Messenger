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
  // Gradient fill → CSS linear-gradient
  const gradFill = dn(el, NS_A, 'gradFill');
  if (gradFill) {
    const stops = [];
    for (const gs of dnAll(gradFill, NS_A, 'gs')) {
      const pos = Math.round(Number(gs.getAttribute('pos') || '0') / 1000);
      const c = parseColor(gs);
      if (c) stops.push(`${c} ${pos}%`);
    }
    if (stops.length >= 2) return `linear-gradient(180deg,${stops.join(',')})`;
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
  // Default run properties (defRPr) for font size fallback
  const defRPr = pPr ? qn(pPr, NS_A, 'defRPr') : null;
  const defSz = defRPr?.getAttribute('sz');
  const defaultFontSize = defSz ? Math.round(Number(defSz) / 100) : null;
  return { runs, align, bullet, bulletColor, indent, marginLeft, lineHeight, spaceBefore, spaceAfter, defaultFontSize };
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
  const rows = [];
  for (const tr of qnAll(tblEl, NS_A, 'tr')) {
    const cells = [];
    for (const tc of qnAll(tr, NS_A, 'tc')) {
      const paragraphs = [];
      const txBody = qn(tc, NS_A, 'txBody');
      if (txBody) {
        for (const p of qnAll(txBody, NS_A, 'p')) paragraphs.push(parseParagraph(p));
      }
      const tcPr = qn(tc, NS_A, 'tcPr');
      const fill = tcPr ? parseFill(tcPr) : null;
      const gridSpan = tc.getAttribute('gridSpan');
      const rowSpan = tc.getAttribute('rowSpan');
      cells.push({ paragraphs, fill, gridSpan: gridSpan ? parseInt(gridSpan) : 1, rowSpan: rowSpan ? parseInt(rowSpan) : 1 });
    }
    rows.push(cells);
  }
  return rows;
}

// ── Shape parser ──
function parseShape(spEl, relMap) {
  const tf = parseTransform(spEl);
  // Image via blip
  const blip = dn(spEl, NS_A, 'blip');
  const embedId = blip ? (blip.getAttributeNS(NS_R, 'embed') || blip.getAttribute('r:embed')) : null;
  if (embedId && relMap[embedId] && /\.(png|jpe?g|gif|bmp|svg|webp|emf|wmf|tiff?)$/i.test(relMap[embedId])) {
    return { type: 'image', ...tf, target: relMap[embedId] };
  }
  // Table
  const tblEl = dn(spEl, NS_A, 'tbl');
  if (tblEl) return { type: 'table', ...tf, rows: parseTable(tblEl) };
  // Text body
  const txBody = dn(spEl, NS_P, 'txBody');
  if (!txBody) return null;
  const paragraphs = [];
  for (const p of qnAll(txBody, NS_A, 'p')) {
    const para = parseParagraph(p);
    if (para.runs.length) paragraphs.push(para);
  }
  if (!paragraphs.length) return null;
  // Shape styles — look specifically at spPr
  const spPr = dn(spEl, NS_P, 'spPr');
  const bgColor = spPr ? parseFill(spPr) : null;
  const line = spPr ? parseLine(spPr) : null;
  // Text body properties
  const bodyPr = qn(txBody, NS_A, 'bodyPr');
  const anchor = bodyPr?.getAttribute('anchor');
  const lIns = bodyPr?.getAttribute('lIns'); const rIns = bodyPr?.getAttribute('rIns');
  const tIns = bodyPr?.getAttribute('tIns'); const bIns = bodyPr?.getAttribute('bIns');
  const margin = {
    l: lIns ? emuToPx(lIns) : 7, r: rIns ? emuToPx(rIns) : 7,
    t: tIns ? emuToPx(tIns) : 4, b: bIns ? emuToPx(bIns) : 4
  };
  // Preset geometry (rounded rect, etc.)
  const prstGeom = spPr ? dn(spPr, NS_A, 'prstGeom') : null;
  const geom = prstGeom ? (prstGeom.getAttribute('prst') || 'rect') : 'rect';
  return { type: 'text', ...tf, paragraphs, bgColor, line, anchor, margin, geom };
}

// ── Group shapes (recursive, direct children only) ──
function parseGroupShapes(grpEl, relMap) {
  const shapes = [];
  for (const sp of qnAll(grpEl, NS_P, 'sp')) {
    const s = parseShape(sp, relMap); if (s) shapes.push(s);
  }
  for (const pic of qnAll(grpEl, NS_P, 'pic')) {
    const s = parseShape(pic, relMap); if (s) shapes.push(s);
  }
  for (const cxn of qnAll(grpEl, NS_P, 'cxnSp')) {
    const s = parseShape(cxn, relMap); if (s) shapes.push(s);
  }
  // Nested groups — recursive with direct children only
  for (const subGrp of qnAll(grpEl, NS_P, 'grpSp')) {
    shapes.push(...parseGroupShapes(subGrp, relMap));
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

// ═══════════════════════════════════════
// DOM Builder
// ═══════════════════════════════════════
function renderRun(run, relMap, defaultFontSize) {
  if (run.text === '\n') return document.createElement('br');
  const span = document.createElement('span');
  let css = '';
  const fs = run.fontSize || defaultFontSize;
  if (fs) css += `font-size:${fs}pt;`;
  if (run.color) css += `color:${run.color};`;
  if (run.bold) css += 'font-weight:700;';
  if (run.italic) css += 'font-style:italic;';
  // text-decoration can combine underline + line-through
  const deco = [run.underline ? 'underline' : '', run.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css += `text-decoration:${deco};`;
  if (run.font) { const f = resolveFont(run.font); if (f) css += `font-family:${f};`; }
  if (run.letterSpacing) css += `letter-spacing:${run.letterSpacing}pt;`;
  if (run.baseline) {
    if (run.baseline > 0) css += `vertical-align:super;font-size:${Math.round((fs || 12) * 0.65)}pt;`;
    else css += `vertical-align:sub;font-size:${Math.round((fs || 12) * 0.65)}pt;`;
  }
  if (css) span.style.cssText = css;
  span.textContent = run.text;
  if (run.hlinkRid && relMap[run.hlinkRid]) {
    const a = document.createElement('a');
    a.href = relMap[run.hlinkRid];
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.style.cssText = 'color:inherit;text-decoration:underline;cursor:pointer;';
    a.appendChild(span);
    return a;
  }
  return span;
}

function renderParagraph(para, relMap, autoNum) {
  const p = document.createElement('p');
  let css = `margin:0;text-align:${para.align};white-space:pre-wrap;word-break:break-word;`;
  if (para.lineHeight) css += `line-height:${para.lineHeight};`;
  else css += 'line-height:1.35;';
  const leftPad = (para.marginLeft || 0) + (para.indent || 0) * 20;
  if (leftPad) css += `padding-left:${leftPad}px;`;
  if (para.spaceBefore) css += `margin-top:${para.spaceBefore}pt;`;
  if (para.spaceAfter) css += `margin-bottom:${para.spaceAfter}pt;`;
  else css += 'margin-bottom:2px;';
  p.style.cssText = css;
  // Bullet
  if (para.bullet) {
    const bulletSpan = document.createElement('span');
    let bCss = 'margin-right:6px;';
    if (para.bulletColor) bCss += `color:${para.bulletColor};`;
    bulletSpan.style.cssText = bCss;
    bulletSpan.textContent = para.bullet === 'auto' ? `${autoNum.n++}. ` : `${para.bullet} `;
    p.appendChild(bulletSpan);
  }
  for (const run of para.runs) p.appendChild(renderRun(run, relMap, para.defaultFontSize));
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
    // Background: could be solid color or gradient
    if (shape.bgColor) {
      if (shape.bgColor.startsWith('linear-gradient')) el.style.background = shape.bgColor;
      else el.style.background = shape.bgColor;
    }
    if (shape.line) el.style.border = `${shape.line.width}px solid ${shape.line.color}`;
    const m = shape.margin || { l: 7, r: 7, t: 4, b: 4 };
    el.style.padding = `${m.t}px ${m.r}px ${m.b}px ${m.l}px`;
    el.style.boxSizing = 'border-box';
    el.style.display = 'flex'; el.style.flexDirection = 'column';
    el.style.fontFamily = resolveFont(themeFontMinor) || 'sans-serif';
    if (shape.anchor === 'ctr') el.style.justifyContent = 'center';
    else if (shape.anchor === 'b') el.style.justifyContent = 'flex-end';
    const autoNum = { n: 1 };
    for (const para of shape.paragraphs) el.appendChild(renderParagraph(para, relMap, autoNum));
  }
  return el;
}

async function buildSlideElement(slideXmlStr, relsXml, zip, slideSize, objectUrls) {
  const slideDoc = parseXml(slideXmlStr);
  const relMap = buildRelMap(relsXml);
  const bgColor = await getLayoutBg(slideDoc, relsXml, zip) || '#ffffff';

  // Check for background image fill
  let bgImageUrl = null;
  const slideBgEl = dn(slideDoc, NS_P, 'bg');
  if (slideBgEl) {
    const bgBlip = dn(slideBgEl, NS_A, 'blip');
    const bgEmbed = bgBlip ? (bgBlip.getAttributeNS(NS_R, 'embed') || bgBlip.getAttribute('r:embed')) : null;
    if (bgEmbed && relMap[bgEmbed]) {
      const bgPath = resolvePath(relMap[bgEmbed]);
      try {
        const bgFile = zip.file(bgPath);
        if (bgFile) {
          const bgBlob = await bgFile.async('blob');
          bgImageUrl = URL.createObjectURL(bgBlob);
          objectUrls.push(bgImageUrl);
        }
      } catch {}
    }
  }

  const slide = document.createElement('div');
  slide.className = 'pptx-slide';
  const defaultFont = resolveFont(themeFontMinor) || 'sans-serif';
  let slideCss = `aspect-ratio:${slideSize.w}/${slideSize.h};background:${bgColor};position:relative;overflow:hidden;font-family:${defaultFont};font-size:12pt;color:${themeColors.tx1 || '#1e293b'};`;
  if (bgImageUrl) slideCss += `background-image:url(${bgImageUrl});background-size:cover;background-position:center;`;
  slide.style.cssText = slideCss;

  // Collect shapes from spTree — direct children only (fixes duplicate shapes in groups)
  const allShapes = [];
  const spTree = dn(slideDoc, NS_P, 'spTree');
  if (spTree) {
    for (const sp of qnAll(spTree, NS_P, 'sp')) { const s = parseShape(sp, relMap); if (s) allShapes.push(s); }
    for (const pic of qnAll(spTree, NS_P, 'pic')) { const s = parseShape(pic, relMap); if (s) allShapes.push(s); }
    for (const cxn of qnAll(spTree, NS_P, 'cxnSp')) { const s = parseShape(cxn, relMap); if (s) allShapes.push(s); }
    for (const grp of qnAll(spTree, NS_P, 'grpSp')) { allShapes.push(...parseGroupShapes(grp, relMap)); }
    for (const gf of qnAll(spTree, NS_P, 'graphicFrame')) { const s = parseShape(gf, relMap); if (s) allShapes.push(s); }
  }

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
    // Parse theme for real colors + fonts
    themeColors = {}; themeFontMajor = 'Calibri'; themeFontMinor = 'Calibri';
    await parseTheme(zip);
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
