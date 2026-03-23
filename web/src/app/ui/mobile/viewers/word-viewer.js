import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const JSZIP_URL = '/assets/libs/jszip.min.js';
let activeWordCleanup = null;

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

export function cleanupWordViewer() {
  if (typeof activeWordCleanup === 'function') {
    try { activeWordCleanup(); } catch {}
  }
  activeWordCleanup = null;
}

function triggerDownload(url, filename) {
  try {
    const a = document.createElement('a');
    a.href = url;
    if (filename) a.download = filename;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    log({ wordDownloadError: err?.message || err });
  }
}

const WORD_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.ms-word.document.macroenabled.12'
];

export function isWordMime(ct) {
  if (!ct) return false;
  const lower = ct.toLowerCase().split(';')[0].trim();
  return WORD_MIMES.some(m => lower === m || lower.startsWith(m));
}

export function isWordFilename(name) {
  if (!name) return false;
  return /\.(docx|doc|docm)$/i.test(name);
}

// ── XML parsing helpers ──
const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';

function parseXml(str) {
  return new DOMParser().parseFromString(str, 'application/xml');
}
function dn(parent, ns, local) {
  return parent?.getElementsByTagNameNS?.(ns, local)?.[0] ?? null;
}
function dnAll(parent, ns, local) {
  return parent?.getElementsByTagNameNS?.(ns, local) ?? [];
}

// ── Build relationship map ──
function buildRelMap(relsXml) {
  const map = {};
  if (!relsXml) return map;
  const doc = parseXml(relsXml);
  for (const rel of doc.getElementsByTagName('Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (id && target) map[id] = target;
  }
  return map;
}

// ── Parse styles.xml ──
function parseStyles(stylesXml) {
  const styles = {};
  if (!stylesXml) return styles;
  const doc = parseXml(stylesXml);
  for (const styleEl of dnAll(doc, NS_W, 'style')) {
    const id = styleEl.getAttribute('w:styleId') || styleEl.getAttributeNS(NS_W, 'styleId');
    if (!id) continue;
    const type = styleEl.getAttribute('w:type') || styleEl.getAttributeNS(NS_W, 'type');
    const nameEl = dn(styleEl, NS_W, 'name');
    const styleName = nameEl?.getAttribute('w:val') || nameEl?.getAttributeNS(NS_W, 'val') || '';
    const pPr = dn(styleEl, NS_W, 'pPr');
    const rPr = dn(styleEl, NS_W, 'rPr');
    styles[id] = {
      type,
      name: styleName,
      pPr: pPr ? parseParagraphProps(pPr) : {},
      rPr: rPr ? parseRunProps(rPr) : {}
    };
  }
  return styles;
}

// ── Parse numbering.xml ──
function parseNumbering(numXml) {
  const result = { abstractNums: {}, nums: {} };
  if (!numXml) return result;
  const doc = parseXml(numXml);
  for (const abs of dnAll(doc, NS_W, 'abstractNum')) {
    const absId = getAttr(abs, 'abstractNumId');
    if (!absId) continue;
    const levels = {};
    for (const lvl of dnAll(abs, NS_W, 'lvl')) {
      const ilvl = getAttr(lvl, 'ilvl');
      if (ilvl === null) continue;
      const numFmt = dn(lvl, NS_W, 'numFmt');
      const lvlText = dn(lvl, NS_W, 'lvlText');
      levels[ilvl] = {
        numFmt: getAttr(numFmt, 'val') || 'bullet',
        lvlText: getAttr(lvlText, 'val') || ''
      };
    }
    result.abstractNums[absId] = levels;
  }
  for (const num of dnAll(doc, NS_W, 'num')) {
    const numId = getAttr(num, 'numId');
    const absRef = dn(num, NS_W, 'abstractNumId');
    if (numId && absRef) {
      result.nums[numId] = getAttr(absRef, 'val');
    }
  }
  return result;
}

function getAttr(el, name) {
  if (!el) return null;
  return el.getAttribute('w:' + name) ?? el.getAttributeNS(NS_W, name) ?? el.getAttribute(name);
}

// ── Parse paragraph properties ──
function parseParagraphProps(pPr) {
  if (!pPr) return {};
  const props = {};
  const jc = dn(pPr, NS_W, 'jc');
  if (jc) {
    const val = getAttr(jc, 'val');
    if (val === 'center') props.align = 'center';
    else if (val === 'right' || val === 'end') props.align = 'right';
    else if (val === 'both' || val === 'distribute') props.align = 'justify';
  }
  const pStyle = dn(pPr, NS_W, 'pStyle');
  if (pStyle) props.styleId = getAttr(pStyle, 'val');
  const numPr = dn(pPr, NS_W, 'numPr');
  if (numPr) {
    const ilvl = dn(numPr, NS_W, 'ilvl');
    const numId = dn(numPr, NS_W, 'numId');
    props.numId = getAttr(numId, 'val');
    props.ilvl = getAttr(ilvl, 'val') || '0';
  }
  const ind = dn(pPr, NS_W, 'ind');
  if (ind) {
    const left = getAttr(ind, 'left') || getAttr(ind, 'start');
    if (left) props.indentLeft = Math.round(Number(left) / 20); // twips to pt
    const firstLine = getAttr(ind, 'firstLine');
    if (firstLine) props.firstLine = Math.round(Number(firstLine) / 20);
    const hanging = getAttr(ind, 'hanging');
    if (hanging) props.hanging = Math.round(Number(hanging) / 20);
  }
  const spacing = dn(pPr, NS_W, 'spacing');
  if (spacing) {
    const before = getAttr(spacing, 'before');
    const after = getAttr(spacing, 'after');
    const line = getAttr(spacing, 'line');
    const lineRule = getAttr(spacing, 'lineRule');
    if (before) props.spaceBefore = Math.round(Number(before) / 20);
    if (after) props.spaceAfter = Math.round(Number(after) / 20);
    if (line) {
      if (lineRule === 'exact' || lineRule === 'atLeast') {
        props.lineHeight = Math.round(Number(line) / 20) + 'pt';
      } else {
        props.lineHeight = (Number(line) / 240).toFixed(2);
      }
    }
  }
  // Borders
  const pBdr = dn(pPr, NS_W, 'pBdr');
  if (pBdr) {
    const bottom = dn(pBdr, NS_W, 'bottom');
    if (bottom) {
      const color = getAttr(bottom, 'color') || '000000';
      const sz = getAttr(bottom, 'sz');
      props.borderBottom = `${Math.max(1, Math.round(Number(sz || 4) / 8))}px solid #${color === 'auto' ? '000000' : color}`;
    }
  }
  // Background/shading
  const shd = dn(pPr, NS_W, 'shd');
  if (shd) {
    const fill = getAttr(shd, 'fill');
    if (fill && fill !== 'auto') props.bgColor = '#' + fill;
  }
  return props;
}

// ── Parse run properties ──
function parseRunProps(rPr) {
  if (!rPr) return {};
  const props = {};
  if (dn(rPr, NS_W, 'b')) props.bold = true;
  if (dn(rPr, NS_W, 'i')) props.italic = true;
  const u = dn(rPr, NS_W, 'u');
  if (u && getAttr(u, 'val') !== 'none') props.underline = true;
  if (dn(rPr, NS_W, 'strike')) props.strike = true;
  const sz = dn(rPr, NS_W, 'sz');
  if (sz) props.fontSize = Math.round(Number(getAttr(sz, 'val')) / 2); // half-points to pt
  const szCs = dn(rPr, NS_W, 'szCs');
  if (szCs && !props.fontSize) props.fontSize = Math.round(Number(getAttr(szCs, 'val')) / 2);
  const color = dn(rPr, NS_W, 'color');
  if (color) {
    const val = getAttr(color, 'val');
    if (val && val !== 'auto') props.color = '#' + val;
  }
  const rFonts = dn(rPr, NS_W, 'rFonts');
  if (rFonts) {
    props.font = getAttr(rFonts, 'ascii') || getAttr(rFonts, 'eastAsia') || getAttr(rFonts, 'hAnsi') || getAttr(rFonts, 'cs');
  }
  const highlight = dn(rPr, NS_W, 'highlight');
  if (highlight) {
    const hv = getAttr(highlight, 'val');
    if (hv && hv !== 'none') props.highlight = wordColorName(hv);
  }
  const shd = dn(rPr, NS_W, 'shd');
  if (shd) {
    const fill = getAttr(shd, 'fill');
    if (fill && fill !== 'auto') props.highlight = '#' + fill;
  }
  const vertAlign = dn(rPr, NS_W, 'vertAlign');
  if (vertAlign) {
    const va = getAttr(vertAlign, 'val');
    if (va === 'superscript') props.vertAlign = 'super';
    else if (va === 'subscript') props.vertAlign = 'sub';
  }
  return props;
}

function wordColorName(name) {
  const map = {
    yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff',
    blue: '#0000ff', red: '#ff0000', darkBlue: '#00008b', darkCyan: '#008b8b',
    darkGreen: '#006400', darkMagenta: '#8b008b', darkRed: '#8b0000', darkYellow: '#8b8b00',
    darkGray: '#a9a9a9', lightGray: '#d3d3d3', black: '#000000', white: '#ffffff'
  };
  return map[name] || '#ffff00';
}

// ── Merge run props with style defaults ──
function mergeRunProps(runProps, styleRProps) {
  const merged = { ...styleRProps, ...runProps };
  return merged;
}

// ── Convert run props to inline CSS ──
function runPropsToStyle(props) {
  const parts = [];
  if (props.bold) parts.push('font-weight:bold');
  if (props.italic) parts.push('font-style:italic');
  if (props.underline && props.strike) parts.push('text-decoration:underline line-through');
  else if (props.underline) parts.push('text-decoration:underline');
  else if (props.strike) parts.push('text-decoration:line-through');
  if (props.fontSize) parts.push(`font-size:${props.fontSize}pt`);
  if (props.color) parts.push(`color:${props.color}`);
  if (props.font) parts.push(`font-family:"${props.font}",sans-serif`);
  if (props.highlight) parts.push(`background-color:${props.highlight}`);
  if (props.vertAlign) parts.push(`vertical-align:${props.vertAlign};font-size:0.75em`);
  return parts.join(';');
}

// ── Process drawing/image elements ──
function processDrawing(drawingEl, relMap, imageData) {
  // Look for blip (embedded image reference)
  const blip = dn(drawingEl, NS_A, 'blip');
  if (!blip) return '';
  const embedId = blip.getAttribute('r:embed') || blip.getAttributeNS(NS_R, 'embed');
  if (!embedId || !relMap[embedId]) return '';
  const imgPath = relMap[embedId];
  const dataUrl = imageData[imgPath];
  if (!dataUrl) return '';

  // Get image dimensions from extent
  const extent = dn(drawingEl, NS_WP, 'extent') || dn(drawingEl, NS_A, 'ext');
  let style = 'max-width:100%;height:auto;';
  if (extent) {
    const cx = extent.getAttribute('cx');
    const cy = extent.getAttribute('cy');
    if (cx) style += `width:${Math.round(Number(cx) / 9525)}px;`;
    if (cy) style += `max-height:${Math.round(Number(cy) / 9525)}px;`;
  }
  return `<img src="${dataUrl}" style="${style}" alt="">`;
}

// ── Build HTML from document.xml ──
async function renderDocxToHtml(zip) {
  // Load required files
  const docXml = await zip.file('word/document.xml')?.async('string');
  if (!docXml) throw new Error('Missing word/document.xml');

  const relsXml = await zip.file('word/_rels/document.xml.rels')?.async('string').catch(() => null);
  const stylesXml = await zip.file('word/styles.xml')?.async('string').catch(() => null);
  const numXml = await zip.file('word/numbering.xml')?.async('string').catch(() => null);

  const relMap = buildRelMap(relsXml);
  const styles = parseStyles(stylesXml);
  const numbering = parseNumbering(numXml);

  // Load all images as data URLs
  const imageData = {};
  for (const [rId, target] of Object.entries(relMap)) {
    if (/\.(png|jpg|jpeg|gif|bmp|svg|webp|tiff?)$/i.test(target)) {
      const imgPath = target.startsWith('/') ? target.slice(1) : 'word/' + target;
      try {
        const imgBlob = await zip.file(imgPath)?.async('blob');
        if (imgBlob) {
          const ext = target.split('.').pop().toLowerCase();
          const mime = ext === 'svg' ? 'image/svg+xml' : ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          imageData[target] = URL.createObjectURL(new Blob([await imgBlob.arrayBuffer()], { type: mime }));
        }
      } catch {}
    }
  }

  const doc = parseXml(docXml);
  const body = dn(doc, NS_W, 'body');
  if (!body) throw new Error('Missing w:body');

  const html = [];
  // Track list state for numbering
  const listCounters = {};

  for (const child of body.children) {
    if (child.localName === 'p') {
      html.push(renderParagraph(child, styles, numbering, relMap, imageData, listCounters));
    } else if (child.localName === 'tbl') {
      html.push(renderTable(child, styles, relMap, imageData));
    } else if (child.localName === 'sectPr') {
      // Section properties (page size, margins) - skip
    }
  }

  return { html: html.join(''), objectUrls: Object.values(imageData) };
}

function renderParagraph(pEl, styles, numbering, relMap, imageData, listCounters) {
  const pPr = dn(pEl, NS_W, 'pPr');
  const props = parseParagraphProps(pPr);

  // Merge style properties
  let styleProps = {};
  let styleRProps = {};
  let headingLevel = 0;
  if (props.styleId && styles[props.styleId]) {
    const st = styles[props.styleId];
    styleProps = { ...st.pPr, ...props };
    // Keep explicit props
    if (props.align) styleProps.align = props.align;
    styleRProps = st.rPr || {};
    // Detect heading
    const sName = st.name.toLowerCase();
    if (/^heading\s*(\d)$/.test(sName)) headingLevel = parseInt(RegExp.$1);
    else if (sName === 'title') headingLevel = 1;
    else if (sName === 'subtitle') headingLevel = 2;
  } else {
    styleProps = props;
  }

  // Build inline style
  const styleParts = [];
  if (styleProps.align) styleParts.push(`text-align:${styleProps.align}`);
  if (styleProps.indentLeft) styleParts.push(`padding-left:${styleProps.indentLeft}pt`);
  if (styleProps.firstLine) styleParts.push(`text-indent:${styleProps.firstLine}pt`);
  if (styleProps.hanging) styleParts.push(`text-indent:-${styleProps.hanging}pt;padding-left:${(styleProps.indentLeft || 0) + styleProps.hanging}pt`);
  if (styleProps.spaceBefore) styleParts.push(`margin-top:${styleProps.spaceBefore}pt`);
  if (styleProps.spaceAfter) styleParts.push(`margin-bottom:${styleProps.spaceAfter}pt`);
  if (styleProps.lineHeight) {
    const lh = styleProps.lineHeight;
    styleParts.push(`line-height:${lh.toString().endsWith('pt') ? lh : lh}`);
  }
  if (styleProps.borderBottom) styleParts.push(`border-bottom:${styleProps.borderBottom}`);
  if (styleProps.bgColor) styleParts.push(`background-color:${styleProps.bgColor}`);

  // Numbering / list
  let listPrefix = '';
  if (props.numId && props.numId !== '0') {
    const absId = numbering.nums[props.numId];
    const levels = absId ? numbering.abstractNums[absId] : null;
    const lvlDef = levels?.[props.ilvl] || levels?.['0'];
    if (lvlDef) {
      const isBullet = lvlDef.numFmt === 'bullet';
      if (isBullet) {
        listPrefix = '<span class="word-list-bullet">\u2022</span>';
      } else {
        const key = `${props.numId}-${props.ilvl}`;
        listCounters[key] = (listCounters[key] || 0) + 1;
        listPrefix = `<span class="word-list-num">${listCounters[key]}.</span>`;
      }
      if (!styleProps.indentLeft) styleParts.push(`padding-left:${(parseInt(props.ilvl) + 1) * 24}pt`);
    }
  }

  // Render runs
  const content = renderRuns(pEl, styleRProps, styles, relMap, imageData);

  // Check for page break before
  let pageBreak = '';
  if (pPr) {
    const pgBrkBefore = dn(pPr, NS_W, 'pageBreakBefore');
    if (pgBrkBefore) pageBreak = '<div class="word-page-break"></div>';
  }

  const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';

  // Empty paragraph = spacing
  if (!content && !listPrefix) {
    return `${pageBreak}<p class="word-p word-empty"${styleAttr}>&nbsp;</p>`;
  }

  if (headingLevel >= 1 && headingLevel <= 6) {
    return `${pageBreak}<h${headingLevel} class="word-h"${styleAttr}>${listPrefix}${content}</h${headingLevel}>`;
  }

  return `${pageBreak}<p class="word-p"${styleAttr}>${listPrefix}${content}</p>`;
}

function renderRuns(parentEl, styleRProps, styles, relMap, imageData) {
  const parts = [];
  for (const child of parentEl.children) {
    if (child.localName === 'r') {
      // Text run
      const rPr = dn(child, NS_W, 'rPr');
      const runProps = mergeRunProps(parseRunProps(rPr), styleRProps);

      // Check for break
      const br = dn(child, NS_W, 'br');
      if (br) {
        const brType = getAttr(br, 'type');
        if (brType === 'page') {
          parts.push('<div class="word-page-break"></div>');
        } else {
          parts.push('<br>');
        }
      }
      // Check for tab
      const tab = dn(child, NS_W, 'tab');
      if (tab) parts.push('<span class="word-tab">\t</span>');

      // Text content
      const textEl = dn(child, NS_W, 't');
      if (textEl) {
        const text = textEl.textContent || '';
        const style = runPropsToStyle(runProps);
        if (style) {
          parts.push(`<span style="${style}">${escapeHtml(text)}</span>`);
        } else {
          parts.push(escapeHtml(text));
        }
      }
      // Drawing (image)
      const drawing = dn(child, NS_W, 'drawing');
      if (drawing) {
        parts.push(processDrawing(drawing, relMap, imageData));
      }
      // Embedded object (legacy images)
      const pict = dn(child, NS_W, 'pict');
      if (pict) {
        const imgData = dn(pict, null, 'imagedata');
        if (imgData) {
          const rId = imgData.getAttribute('r:id') || imgData.getAttributeNS(NS_R, 'id');
          if (rId && relMap[rId]) {
            const dataUrl = imageData[relMap[rId]];
            if (dataUrl) parts.push(`<img src="${dataUrl}" style="max-width:100%;height:auto;" alt="">`);
          }
        }
      }
    } else if (child.localName === 'hyperlink') {
      const rId = child.getAttribute('r:id') || child.getAttributeNS(NS_R, 'id');
      const anchor = getAttr(child, 'anchor');
      const linkContent = renderRuns(child, styleRProps, styles, relMap, imageData);
      if (rId && relMap[rId]) {
        parts.push(`<a href="${escapeHtml(relMap[rId])}" class="word-link" target="_blank" rel="noopener noreferrer">${linkContent}</a>`);
      } else if (anchor) {
        parts.push(`<a href="#${escapeHtml(anchor)}" class="word-link">${linkContent}</a>`);
      } else {
        parts.push(linkContent);
      }
    } else if (child.localName === 'bookmarkStart' || child.localName === 'bookmarkEnd' ||
               child.localName === 'proofErr' || child.localName === 'commentRangeStart' ||
               child.localName === 'commentRangeEnd') {
      // Skip metadata elements
    }
  }
  return parts.join('');
}

// ── Table rendering ──
function renderTable(tblEl, styles, relMap, imageData) {
  const html = ['<div class="word-tbl-wrap"><table class="word-tbl">'];
  const tblPr = dn(tblEl, NS_W, 'tblPr');
  let tblBorders = true;
  if (tblPr) {
    const borders = dn(tblPr, NS_W, 'tblBorders');
    if (borders) {
      const top = dn(borders, NS_W, 'top');
      const insideH = dn(borders, NS_W, 'insideH');
      tblBorders = !!(top && getAttr(top, 'val') !== 'none') || !!(insideH && getAttr(insideH, 'val') !== 'none');
    }
  }
  if (tblBorders) html[0] = '<div class="word-tbl-wrap"><table class="word-tbl word-tbl-bordered">';

  // Grid columns
  const tblGrid = dn(tblEl, NS_W, 'tblGrid');
  if (tblGrid) {
    html.push('<colgroup>');
    for (const col of dnAll(tblGrid, NS_W, 'gridCol')) {
      const w = getAttr(col, 'w');
      if (w) html.push(`<col style="width:${Math.round(Number(w) / 20)}pt">`);
      else html.push('<col>');
    }
    html.push('</colgroup>');
  }

  for (const tr of dnAll(tblEl, NS_W, 'tr')) {
    // Skip rows that are not direct children of tblEl
    if (tr.parentNode !== tblEl) continue;
    html.push('<tr>');
    for (const tc of dnAll(tr, NS_W, 'tc')) {
      if (tc.parentNode !== tr) continue;
      const tcPr = dn(tc, NS_W, 'tcPr');
      const cellStyle = [];
      let colspan = '';
      let rowspan = '';

      if (tcPr) {
        const gridSpan = dn(tcPr, NS_W, 'gridSpan');
        if (gridSpan) {
          const gs = getAttr(gridSpan, 'val');
          if (gs && Number(gs) > 1) colspan = ` colspan="${gs}"`;
        }
        const vMerge = dn(tcPr, NS_W, 'vMerge');
        if (vMerge) {
          const vm = getAttr(vMerge, 'val');
          if (!vm || vm === 'continue') {
            html.push(`<td class="word-tc-merged" style="display:none"></td>`);
            continue;
          }
        }
        const shd = dn(tcPr, NS_W, 'shd');
        if (shd) {
          const fill = getAttr(shd, 'fill');
          if (fill && fill !== 'auto') cellStyle.push(`background-color:#${fill}`);
        }
        const vAlign = dn(tcPr, NS_W, 'vAlign');
        if (vAlign) {
          const va = getAttr(vAlign, 'val');
          if (va === 'center') cellStyle.push('vertical-align:middle');
          else if (va === 'bottom') cellStyle.push('vertical-align:bottom');
        }
        const tcW = dn(tcPr, NS_W, 'tcW');
        if (tcW) {
          const w = getAttr(tcW, 'w');
          const type = getAttr(tcW, 'type');
          if (w && type === 'dxa') cellStyle.push(`width:${Math.round(Number(w) / 20)}pt`);
          else if (w && type === 'pct') cellStyle.push(`width:${(Number(w) / 50)}%`);
        }
      }

      const styleAttr = cellStyle.length ? ` style="${cellStyle.join(';')}"` : '';
      html.push(`<td class="word-tc"${colspan}${rowspan}${styleAttr}>`);

      // Cell content (paragraphs)
      for (const cellChild of tc.children) {
        if (cellChild.localName === 'p') {
          html.push(renderParagraph(cellChild, styles, {}, relMap, imageData, {}));
        } else if (cellChild.localName === 'tbl') {
          html.push(renderTable(cellChild, styles, relMap, imageData));
        }
      }

      html.push('</td>');
    }
    html.push('</tr>');
  }

  html.push('</table></div>');
  return html.join('');
}

// ── Main render function ──
export async function renderWordViewer({ url, blob, name, modalApi }) {
  const { openModal, closeModal, showConfirmModal } = modalApi || {};

  const modalEl = document.getElementById('modal');
  const body = document.getElementById('modalBody');
  const modalTitle = document.getElementById('modalTitle');
  const closeBtn = document.getElementById('modalClose');
  const closeArea = document.getElementById('modalCloseArea');
  if (!modalEl || !body || !modalTitle) return false;

  cleanupWordViewer();
  modalEl.classList.add('word-modal');
  modalTitle.textContent = '';

  body.innerHTML = `
    <div class="word-viewer">
      <div class="word-toolbar">
        <button type="button" class="word-btn" id="wordCloseBtn" aria-label="${t('viewer.close')}">
          <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M8 3l-5 5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="word-title" title="${escapeHtml(name || 'Word')}">${escapeHtml(name || 'Word')}</div>
        <div class="word-actions">
          <button type="button" class="word-btn" id="wordDownload" aria-label="${t('viewer.downloadWord')}">
            <svg viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      <div class="word-stage" id="wordStage">
        <div class="word-loading" id="wordLoading">${t('common.loading')}</div>
      </div>
    </div>`;
  openModal?.();

  const loadingEl = body.querySelector('#wordLoading');
  const stageEl = body.querySelector('#wordStage');
  let objectUrls = [];

  // Close handler setup
  const setupCloseHandlers = () => {
    const doClose = () => activeWordCleanup?.();
    body.querySelector('#wordCloseBtn')?.addEventListener('click', doClose);
    closeBtn?.addEventListener('click', doClose, { once: true });
    closeArea?.addEventListener('click', doClose, { once: true });
  };

  try {
    // Load JSZip
    const JSZip = await ensureJSZip();

    let arrayBuffer;
    if (blob) {
      arrayBuffer = await blob.arrayBuffer();
    } else if (url) {
      const resp = await fetch(url);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      throw new Error('No data source');
    }

    const zip = await JSZip.loadAsync(arrayBuffer);
    const result = await renderDocxToHtml(zip);
    objectUrls = result.objectUrls || [];

    // Create document container
    const docContainer = document.createElement('div');
    docContainer.className = 'word-doc-container';
    const page = document.createElement('div');
    page.className = 'word-page';
    page.innerHTML = result.html;
    docContainer.appendChild(page);
    stageEl.appendChild(docContainer);
    if (loadingEl) loadingEl.remove();

    // Download
    const downloadBtn = body.querySelector('#wordDownload');
    downloadBtn?.addEventListener('click', (e) => {
      e.preventDefault();
      const proceed = () => triggerDownload(url, name || 'file.docx');
      if (typeof showConfirmModal === 'function') {
        showConfirmModal({
          title: t('viewer.downloadWord'),
          message: t('drive.downloadPdfConfirm'),
          confirmLabel: t('drive.download'),
          onConfirm: proceed
        });
        return;
      }
      proceed();
    });

    setupCloseHandlers();

    activeWordCleanup = () => {
      for (const u of objectUrls) { try { URL.revokeObjectURL(u); } catch {} }
      modalEl.classList.remove('word-modal');
      closeModal?.();
      activeWordCleanup = null;
    };
  } catch (err) {
    log({ wordViewerError: err?.message || err });
    if (stageEl) {
      stageEl.innerHTML = `
        <div class="viewer-error-state">
          <div class="viewer-error-msg">${escapeHtml(t('viewer.wordLoadFailed', { error: err?.message || err }))}</div>
          <button type="button" class="viewer-error-download" id="wordErrorDownload">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none"><path d="M8 2v8m0 0l-3-3m3 3l3-3M3 11v2h10v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${t('viewer.downloadWord')}
          </button>
        </div>`;
      stageEl.querySelector('#wordErrorDownload')?.addEventListener('click', () => triggerDownload(url, name || 'file.docx'));
    }
    setupCloseHandlers();
    activeWordCleanup = () => {
      for (const u of objectUrls) { try { URL.revokeObjectURL(u); } catch {} }
      modalEl.classList.remove('word-modal');
      closeModal?.();
      activeWordCleanup = null;
    };
    return true;
  }

  return true;
}
