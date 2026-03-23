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

// ══════════════════════════════════════════════════════════════
// ── OLE2 Compound Binary File parser (for .doc support) ──
// ══════════════════════════════════════════════════════════════

function parseOLE2(buffer) {
  const view = new DataView(buffer);
  // Verify OLE2 signature: D0 CF 11 E0 A1 B1 1A E1
  const sig = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
  for (let i = 0; i < 8; i++) {
    if (view.getUint8(i) !== sig[i]) throw new Error('Not an OLE2 file');
  }

  const sectorSizePow = view.getUint16(0x1E, true);
  const sectorSize = 1 << sectorSizePow;
  const miniSectorSizePow = view.getUint16(0x20, true);
  const miniSectorSize = 1 << miniSectorSizePow;
  const firstDirSector = view.getUint32(0x30, true);
  const miniStreamCutoff = view.getUint32(0x38, true);
  const firstMiniFATSector = view.getInt32(0x3C, true);
  const miniFATSectorCount = view.getUint32(0x40, true);
  const firstDIFATSector = view.getInt32(0x44, true);
  const difatSectorCount = view.getUint32(0x48, true);

  // Build DIFAT: first 109 entries from header
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const v = view.getInt32(0x4C + i * 4, true);
    if (v >= 0) difat.push(v);
  }
  // Additional DIFAT sectors
  let difatSec = firstDIFATSector;
  for (let i = 0; i < difatSectorCount && difatSec >= 0; i++) {
    const off = (difatSec + 1) * sectorSize;
    for (let j = 0; j < sectorSize / 4 - 1; j++) {
      const v = view.getInt32(off + j * 4, true);
      if (v >= 0) difat.push(v);
    }
    difatSec = view.getInt32(off + sectorSize - 4, true);
  }

  // Build FAT from DIFAT sectors
  const fat = [];
  for (const sec of difat) {
    const off = (sec + 1) * sectorSize;
    for (let i = 0; i < sectorSize / 4; i++) {
      fat.push(view.getInt32(off + i * 4, true));
    }
  }

  // Read a chain of sectors into a Uint8Array
  function readChain(startSector) {
    const chunks = [];
    let sec = startSector;
    const visited = new Set();
    while (sec >= 0 && sec < fat.length && !visited.has(sec)) {
      visited.add(sec);
      const off = (sec + 1) * sectorSize;
      if (off + sectorSize <= buffer.byteLength) {
        chunks.push(new Uint8Array(buffer, off, sectorSize));
      }
      sec = fat[sec] ?? -2;
    }
    const total = chunks.reduce((s, a) => s + a.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
  }

  // Read directory entries
  const dirData = readChain(firstDirSector);
  const entries = [];
  for (let i = 0; i + 128 <= dirData.length; i += 128) {
    const nameSize = dirData[i + 0x40] | (dirData[i + 0x41] << 8);
    if (nameSize === 0) continue;
    let name = '';
    for (let j = 0; j < nameSize - 2; j += 2) {
      name += String.fromCharCode(dirData[i + j] | (dirData[i + j + 1] << 8));
    }
    const type = dirData[i + 0x42];
    const dv = new DataView(dirData.buffer, dirData.byteOffset + i, 128);
    const startSector = dv.getInt32(0x74, true);
    const size = dv.getUint32(0x78, true);
    entries.push({ name, type, startSector, size });
  }

  // Build mini FAT
  let miniFAT = [];
  if (firstMiniFATSector >= 0 && miniFATSectorCount > 0) {
    const mfData = readChain(firstMiniFATSector);
    const mfView = new DataView(mfData.buffer, mfData.byteOffset, mfData.byteLength);
    for (let i = 0; i < mfData.length / 4; i++) {
      miniFAT.push(mfView.getInt32(i * 4, true));
    }
  }

  // Mini stream (from root entry)
  const rootEntry = entries.find(e => e.type === 5);
  let miniStream = null;
  if (rootEntry && rootEntry.startSector >= 0) {
    miniStream = readChain(rootEntry.startSector);
  }

  // Get named stream data
  function getStream(streamName) {
    const entry = entries.find(e => e.name === streamName && e.type === 2);
    if (!entry || entry.startSector < 0) return null;
    if (entry.size < miniStreamCutoff && miniStream) {
      // Read from mini stream using mini FAT
      const data = new Uint8Array(entry.size);
      let sec = entry.startSector;
      let pos = 0;
      const visited = new Set();
      while (sec >= 0 && pos < entry.size && !visited.has(sec)) {
        visited.add(sec);
        const off = sec * miniSectorSize;
        const len = Math.min(miniSectorSize, entry.size - pos);
        if (off + len <= miniStream.length) {
          data.set(miniStream.slice(off, off + len), pos);
        }
        pos += len;
        sec = miniFAT[sec] ?? -2;
      }
      return data;
    }
    const chain = readChain(entry.startSector);
    return chain.slice(0, entry.size);
  }

  return { entries, getStream };
}

// ── Extract text from Word Binary (.doc) ──
function extractDocText(buffer) {
  const ole2 = parseOLE2(buffer);
  const wordDoc = ole2.getStream('WordDocument');
  if (!wordDoc) throw new Error('WordDocument stream not found');

  const wdView = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength);
  const wIdent = wdView.getUint16(0, true);
  if (wIdent !== 0xA5EC) throw new Error('Invalid Word document magic');

  const flags = wdView.getUint16(0x0A, true);
  const fEncrypted = !!(flags & 0x0100);
  if (fEncrypted) throw new Error('ENCRYPTED');
  const fWhichTblStm = !!(flags & 0x0200);

  // Read FIB structure offsets
  // fibBase: 0x00-0x1F (32 bytes)
  // csw at 0x20, then fibRgW (csw * 2 bytes)
  // cslw, then fibRgLw (cslw * 4 bytes)
  // cbRgFcLcb, then fibRgFcLcb pairs (each 8 bytes: fc + lcb)
  let off = 0x20;
  if (off + 2 > wordDoc.length) throw new Error('FIB too short');
  const csw = wdView.getUint16(off, true);
  off += 2 + csw * 2;
  if (off + 2 > wordDoc.length) throw new Error('FIB too short');
  const cslw = wdView.getUint16(off, true);
  off += 2 + cslw * 4;
  if (off + 2 > wordDoc.length) throw new Error('FIB too short');
  const cbRgFcLcb = wdView.getUint16(off, true);
  off += 2;

  // CLX is at index 66 in fibRgFcLcb (Word 97+)
  const clxIndex = 66;
  if (clxIndex >= cbRgFcLcb) {
    // Fallback: try raw text extraction
    return fallbackTextExtract(wordDoc);
  }

  const fcClx = wdView.getUint32(off + clxIndex * 8, true);
  const lcbClx = wdView.getUint32(off + clxIndex * 8 + 4, true);
  if (lcbClx === 0) return fallbackTextExtract(wordDoc);

  // Get table stream
  const tableName = fWhichTblStm ? '1Table' : '0Table';
  const tableStream = ole2.getStream(tableName);
  if (!tableStream || fcClx + lcbClx > tableStream.length) {
    return fallbackTextExtract(wordDoc);
  }

  // Parse CLX: skip Prc records (0x01), find Pcdt (0x02)
  let clxOff = fcClx;
  const tsView = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  while (clxOff < fcClx + lcbClx) {
    const type = tableStream[clxOff];
    if (type === 0x01) {
      const cbGrpprl = tsView.getUint16(clxOff + 1, true);
      clxOff += 3 + cbGrpprl;
    } else if (type === 0x02) {
      clxOff += 1;
      break;
    } else {
      break;
    }
  }

  if (clxOff + 4 > tableStream.length) return fallbackTextExtract(wordDoc);
  const lcbPcdt = tsView.getUint32(clxOff, true);
  clxOff += 4;

  // Piece table: (n+1) CPs (uint32) + n PCDs (8 bytes each)
  // lcbPcdt = (n+1)*4 + n*8 → n = (lcbPcdt - 4) / 12
  const n = Math.floor((lcbPcdt - 4) / 12);
  if (n <= 0) return fallbackTextExtract(wordDoc);

  // Read character positions
  const cps = [];
  for (let i = 0; i <= n; i++) {
    cps.push(tsView.getUint32(clxOff + i * 4, true));
  }

  // Read piece descriptors and extract text
  const pcdBase = clxOff + (n + 1) * 4;
  const textParts = [];
  for (let i = 0; i < n; i++) {
    const charCount = cps[i + 1] - cps[i];
    if (charCount <= 0) continue;
    const pcdOff = pcdBase + i * 8;
    if (pcdOff + 8 > tableStream.length) break;
    const fc = tsView.getUint32(pcdOff + 2, true);
    const fCompressed = !!(fc & 0x40000000);
    const fcValue = fc & 0x3FFFFFFF;

    try {
      if (fCompressed) {
        // ANSI text (1 byte per char)
        const byteOff = fcValue / 2;
        if (byteOff + charCount <= wordDoc.length) {
          const bytes = wordDoc.slice(byteOff, byteOff + charCount);
          textParts.push(new TextDecoder('windows-1252').decode(bytes));
        }
      } else {
        // Unicode text (2 bytes per char)
        if (fcValue + charCount * 2 <= wordDoc.length) {
          const bytes = wordDoc.slice(fcValue, fcValue + charCount * 2);
          textParts.push(new TextDecoder('utf-16le').decode(bytes));
        }
      }
    } catch { /* skip bad piece */ }
  }

  if (textParts.length === 0) return fallbackTextExtract(wordDoc);
  return textParts.join('');
}

// Fallback: scan binary for readable text sequences
function fallbackTextExtract(data) {
  // Try to find text after FIB (typically starts at 0x200 or later)
  const parts = [];
  let current = '';
  for (let i = 0x200; i < data.length; i++) {
    const b = data[i];
    if (b >= 0x20 && b < 0x7F) {
      current += String.fromCharCode(b);
    } else if (b === 0x0D || b === 0x0A) {
      if (current.trim()) parts.push(current);
      current = '';
    } else if (b === 0x09) {
      current += '\t';
    } else {
      if (current.length > 2) parts.push(current);
      current = '';
    }
  }
  if (current.trim()) parts.push(current);
  if (parts.length === 0) throw new Error('No readable text found');
  return parts.join('\r');
}

// Convert extracted .doc plain text to HTML
function docTextToHtml(rawText) {
  // Word uses \r for paragraph breaks, \x07 for table cell/row marks
  // Clean up special chars
  const cleaned = rawText
    .replace(/\x07/g, '\t')      // Cell marks → tab
    .replace(/\x01/g, '')         // Picture placeholders
    .replace(/\x08/g, '')         // Drawing anchors
    .replace(/\x13[^\x15]*\x15/g, '') // Field codes
    .replace(/\x13|\x14|\x15/g, '')   // Remaining field markers
    .replace(/\r\n/g, '\r')
    .replace(/\n/g, '\r');

  const paragraphs = cleaned.split('\r');
  const html = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) {
      html.push('<p class="word-p word-empty">&nbsp;</p>');
    } else {
      html.push(`<p class="word-p">${escapeHtml(trimmed)}</p>`);
    }
  }
  return html.join('');
}

// ══════════════════════════════════════════════════════════════
// ── DOCX XML parsing helpers ──
// ══════════════════════════════════════════════════════════════

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

// ── Find the main document part from [Content_Types].xml ──
async function findDocumentPath(zip) {
  const ctXml = await zip.file('[Content_Types].xml')?.async('string').catch(() => null);
  if (ctXml) {
    const doc = parseXml(ctXml);
    for (const override of doc.getElementsByTagName('Override')) {
      const ct = override.getAttribute('ContentType') || '';
      if (ct.includes('wordprocessingml.document.main')) {
        const partName = override.getAttribute('PartName') || '';
        return partName.startsWith('/') ? partName.slice(1) : partName;
      }
    }
  }
  // Fallback: try common paths
  for (const p of ['word/document.xml', 'word/document2.xml']) {
    if (zip.file(p)) return p;
  }
  return null;
}

// ── Build HTML from document.xml ──
async function renderDocxToHtml(zip) {
  // Find main document part
  const docPath = await findDocumentPath(zip);
  if (!docPath) throw new Error('Missing word/document.xml');
  const docXml = await zip.file(docPath)?.async('string');
  if (!docXml) throw new Error('Missing word/document.xml');

  // Derive base directory from document path (usually "word/")
  const docDir = docPath.replace(/[^/]+$/, '');
  const docFilename = docPath.split('/').pop();

  const relsXml = await zip.file(`${docDir}_rels/${docFilename}.rels`)?.async('string').catch(() => null);
  const stylesXml = await zip.file(`${docDir}styles.xml`)?.async('string').catch(() => null);
  const numXml = await zip.file(`${docDir}numbering.xml`)?.async('string').catch(() => null);

  const relMap = buildRelMap(relsXml);
  const styles = parseStyles(stylesXml);
  const numbering = parseNumbering(numXml);

  // Load all images as data URLs
  const imageData = {};
  for (const [rId, target] of Object.entries(relMap)) {
    if (/\.(png|jpg|jpeg|gif|bmp|svg|webp|tiff?)$/i.test(target)) {
      const imgPath = target.startsWith('/') ? target.slice(1) : docDir + target;
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

    // Check if this is a ZIP-based DOCX or an old binary .doc
    const header = new Uint8Array(arrayBuffer, 0, Math.min(8, arrayBuffer.byteLength));
    const isZip = header[0] === 0x50 && header[1] === 0x4B && header[2] === 0x03 && header[3] === 0x04;
    const isOle2 = header[0] === 0xD0 && header[1] === 0xCF && header[2] === 0x11 && header[3] === 0xE0;

    let resultHtml = '';
    let isDocFormat = false;

    if (isZip) {
      // DOCX (ZIP-based)
      const zip = await JSZip.loadAsync(arrayBuffer);
      const result = await renderDocxToHtml(zip);
      objectUrls = result.objectUrls || [];
      resultHtml = result.html;
    } else if (isOle2) {
      // Old .doc (OLE2 binary)
      isDocFormat = true;
      const rawText = extractDocText(arrayBuffer);
      resultHtml = docTextToHtml(rawText);
    } else {
      throw new Error('NOT_DOCX');
    }

    // Create document container
    const docContainer = document.createElement('div');
    docContainer.className = 'word-doc-container';
    if (isDocFormat) {
      // Show format notice for .doc
      const notice = document.createElement('div');
      notice.className = 'word-format-notice';
      notice.textContent = t('viewer.wordDocNotice') || '.doc 格式僅支援文字預覽，下載可查看完整格式。';
      docContainer.appendChild(notice);
    }
    const page = document.createElement('div');
    page.className = 'word-page';
    page.innerHTML = resultHtml;
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
    const isNotDocx = err?.message === 'NOT_DOCX';
    const isEncrypted = err?.message === 'ENCRYPTED';
    const errorMsg = isNotDocx
      ? (t('viewer.wordOldFormat') || '無法辨識的檔案格式，請下載後使用其他應用程式開啟。')
      : isEncrypted
        ? (t('viewer.wordEncrypted') || '此檔案已加密，無法線上預覽。請下載後使用其他應用程式開啟。')
        : t('viewer.wordLoadFailed', { error: err?.message || err });
    if (stageEl) {
      stageEl.innerHTML = `
        <div class="viewer-error-state">
          <div class="viewer-error-msg">${escapeHtml(errorMsg)}</div>
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
