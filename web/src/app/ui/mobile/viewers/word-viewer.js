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

// ── Parse FIB (File Information Block) from WordDocument stream ──
function parseFIB(wordDoc) {
  const v = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength);
  if (v.getUint16(0, true) !== 0xA5EC) throw new Error('Invalid Word document magic');
  const flags = v.getUint16(0x0A, true);
  if (flags & 0x0100) throw new Error('ENCRYPTED');

  let off = 0x20;
  const csw = v.getUint16(off, true); off += 2 + csw * 2;
  const cslw = v.getUint16(off, true); off += 2 + cslw * 4;
  const cbRgFcLcb = v.getUint16(off, true); off += 2;

  const fibPair = (idx) => idx < cbRgFcLcb
    ? { fc: v.getUint32(off + idx * 8, true), lcb: v.getUint32(off + idx * 8 + 4, true) }
    : { fc: 0, lcb: 0 };

  return { flags, fibPair, tableName: (flags & 0x0200) ? '1Table' : '0Table' };
}

// ── Parse piece table → text + CP↔FC mapping ──
// PCD stores fc.fc (30-bit). For compressed text, byte offset = fc.fc / 2.
// FKP pages store byte offsets in WordDocument stream directly.
// We store both fcRaw (for debugging) and fcByteOff (for FKP matching).
function parsePieceTable(wordDoc, tableStream, fcClx, lcbClx) {
  const tsView = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  let clxOff = fcClx;
  while (clxOff < fcClx + lcbClx) {
    const type = tableStream[clxOff];
    if (type === 0x01) { clxOff += 3 + tsView.getUint16(clxOff + 1, true); }
    else if (type === 0x02) { clxOff += 1; break; }
    else break;
  }
  if (clxOff + 4 > tableStream.length) return null;
  const lcbPcdt = tsView.getUint32(clxOff, true); clxOff += 4;
  const n = Math.floor((lcbPcdt - 4) / 12);
  if (n <= 0) return null;

  const cps = [];
  for (let i = 0; i <= n; i++) cps.push(tsView.getUint32(clxOff + i * 4, true));
  const pcdBase = clxOff + (n + 1) * 4;

  const pieces = [];
  const textChunks = [];
  for (let i = 0; i < n; i++) {
    const charCount = cps[i + 1] - cps[i];
    if (charCount <= 0) continue;
    const pcdOff = pcdBase + i * 8;
    if (pcdOff + 8 > tableStream.length) break;
    const fcField = tsView.getUint32(pcdOff + 2, true);
    const fCompressed = !!(fcField & 0x40000000);
    const fcValue = fcField & 0x3FFFFFFF;
    // Byte offset in WordDocument where this piece's text lives
    const fcByteOff = fCompressed ? fcValue / 2 : fcValue;

    pieces.push({
      cpStart: cps[i], cpEnd: cps[i + 1],
      fcByteOff,   // actual byte offset (matches FKP FC values)
      fcRaw: fcValue, // raw 30-bit PCD value (for fallback matching)
      fCompressed,
    });
    try {
      if (fCompressed) {
        if (fcByteOff + charCount <= wordDoc.length) {
          textChunks.push(new TextDecoder('windows-1252').decode(wordDoc.slice(fcByteOff, fcByteOff + charCount)));
        }
      } else {
        if (fcByteOff + charCount * 2 <= wordDoc.length) {
          textChunks.push(new TextDecoder('utf-16le').decode(wordDoc.slice(fcByteOff, fcByteOff + charCount * 2)));
        }
      }
    } catch { textChunks.push(''); }
  }
  return { text: textChunks.join(''), pieces };
}

// ── Convert FC (byte offset in WordDocument) to CP (character position) ──
// FKP pages store byte offsets. For compressed pieces, 1 byte/char;
// for uncompressed, 2 bytes/char.
function fcToCp(fc, pieces) {
  for (const p of pieces) {
    const cpLen = p.cpEnd - p.cpStart;
    if (p.fCompressed) {
      // Each char is 1 byte: FC range = [fcByteOff, fcByteOff + cpLen)
      const fcEnd = p.fcByteOff + cpLen;
      if (fc >= p.fcByteOff && fc < fcEnd) return p.cpStart + (fc - p.fcByteOff);
    } else {
      // Each char is 2 bytes: FC range = [fcByteOff, fcByteOff + cpLen*2)
      const fcEnd = p.fcByteOff + cpLen * 2;
      if (fc >= p.fcByteOff && fc < fcEnd) return p.cpStart + Math.floor((fc - p.fcByteOff) / 2);
    }
  }
  // Fallback: try matching with raw PCD fc values (some Word versions use these in FKPs)
  for (const p of pieces) {
    const cpLen = p.cpEnd - p.cpStart;
    if (p.fCompressed) {
      const fcEnd = p.fcRaw + cpLen;
      if (fc >= p.fcRaw && fc < fcEnd) return p.cpStart + (fc - p.fcRaw);
    } else {
      const fcEnd = p.fcRaw + cpLen * 2;
      if (fc >= p.fcRaw && fc < fcEnd) return p.cpStart + Math.floor((fc - p.fcRaw) / 2);
    }
  }
  return -1;
}

// ── Parse Sprm (Single Property Modifier) operations ──
// Toggle byte: 0=off, 1=on, 0x80=use style default, 0x81=negate style default
function parseSprms(data, offset, length) {
  const props = {};
  let pos = offset;
  const end = offset + length;
  while (pos + 2 <= end) {
    const sprm = data[pos] | (data[pos + 1] << 8);
    pos += 2;
    const spra = (sprm >> 13) & 0x07;
    let opSize;
    switch (spra) {
      case 0: case 1: opSize = 1; break;
      case 2: case 4: case 5: opSize = 2; break;
      case 3: opSize = 4; break;
      case 7: opSize = 3; break;
      case 6: opSize = pos < end ? (data[pos++]) : 0; break;
      default: opSize = 0;
    }
    if (pos + opSize > end) break;

    const toggleVal = (v) => v === 1 || v === 0x81; // on or negate-default (treat as on)

    switch (sprm) {
      // ── Character properties (sgc=2, CHP) ──
      case 0x0835: props.bold = toggleVal(data[pos]); break;
      case 0x0836: props.italic = toggleVal(data[pos]); break;
      case 0x0837: props.strike = toggleVal(data[pos]); break;
      case 0x083A: props.smallCaps = toggleVal(data[pos]); break;
      case 0x083B: props.allCaps = toggleVal(data[pos]); break;
      case 0x0839: props.vanish = toggleVal(data[pos]); break; // hidden text
      case 0x2A3E: props.underline = data[pos] !== 0; break; // sprmCKul
      case 0x4A43: props.fontSize = (data[pos] | (data[pos + 1] << 8)) / 2; break; // sprmCHps (half-points)
      case 0x6870: { // sprmCCv - text color (COLORREF: 0x00BBGGRR)
        const r = data[pos], g = data[pos + 1], b = data[pos + 2];
        // Include black (0,0,0) explicitly — it's a valid intentional color
        props.color = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        break;
      }
      case 0x6877: { // sprmCCvUl - underline color
        const r = data[pos], g = data[pos + 1], b = data[pos + 2];
        props.ulColor = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
        break;
      }
      case 0x4A4F: case 0x4A50: case 0x4A51: // sprmCRgFtc0/1/2 - font index
        if (props.fontIdx === undefined) props.fontIdx = data[pos] | (data[pos + 1] << 8);
        break;
      case 0x4845: { // sprmCIco - legacy color index (Word 97)
        const icoMap = [null, '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff',
          '#ff0000', '#ffff00', '#ffffff', '#00008b', '#008b8b', '#006400',
          '#8b008b', '#8b0000', '#808000', '#808080', '#c0c0c0'];
        const ico = data[pos];
        if (ico > 0 && ico < icoMap.length) props.color = icoMap[ico];
        break;
      }
      case 0x2A48: props.istdChar = data[pos]; break; // character style index
      case 0x484B: { // sprmCHpsPos - vertical position (superscript/subscript)
        const hpsPos = data[pos] | (data[pos + 1] << 8);
        if (hpsPos > 0 && hpsPos < 0x8000) props.vertAlign = 'super';
        else if (hpsPos >= 0x8000) props.vertAlign = 'sub';
        break;
      }

      // ── Paragraph properties (sgc=1, PAP) ──
      case 0x2403: case 0x2461: { // sprmPJc80 / sprmPJc
        const jc = data[pos];
        props.align = ['left', 'center', 'right', 'justify'][jc] || 'left';
        break;
      }
      case 0x2407: props.inTable = toggleVal(data[pos]); break; // sprmPFInTable
      case 0x2416: props.tableRowEnd = toggleVal(data[pos]); break; // sprmPFTtp
      case 0x460B: props.spaceBefore = (data[pos] | (data[pos + 1] << 8)) / 20; break; // sprmPDyaBefore
      case 0x460C: props.spaceAfter = (data[pos] | (data[pos + 1] << 8)) / 20; break; // sprmPDyaAfter
      case 0x840E: case 0x845E: { // sprmPDxaLeft / sprmPDxaLeft80
        const val = data[pos] | (data[pos + 1] << 8);
        props.indentLeft = (val > 0x7FFF ? val - 0x10000 : val) / 20;
        break;
      }
      case 0x8411: case 0x8460: { // sprmPDxaRight / sprmPDxaRight80
        const val = data[pos] | (data[pos + 1] << 8);
        props.indentRight = (val > 0x7FFF ? val - 0x10000 : val) / 20;
        break;
      }
      case 0x840F: case 0x845F: { // sprmPDxaLeft1 / sprmPDxaLeft180 (first line indent)
        const val = data[pos] | (data[pos + 1] << 8);
        props.firstLine = (val > 0x7FFF ? val - 0x10000 : val) / 20;
        break;
      }
      case 0x6412: { // sprmPDyaLine - line spacing
        const dyaLine = data[pos] | (data[pos + 1] << 8);
        const fMultLinespace = data[pos + 2] | (data[pos + 3] << 8);
        if (fMultLinespace) {
          props.lineHeight = (dyaLine / 240).toFixed(2);
        } else if (dyaLine > 0) {
          props.lineHeight = (dyaLine / 20) + 'pt';
        }
        break;
      }
      case 0x2423: props.outlineLvl = data[pos]; break; // sprmPOutLvl (heading level)
    }
    pos += opSize;
  }
  return props;
}

// ── Parse font table (SttbfFfn) ──
function parseFontTable(tableStream, fc, lcb) {
  const fonts = [];
  if (!lcb || fc + lcb > tableStream.length) return fonts;
  const v = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  // SttbfFfn: 2-byte count, then entries
  let pos = fc;
  const extended = v.getUint16(pos, true) === 0xFFFF;
  if (extended) pos += 2; // skip 0xFFFF marker
  const cData = v.getUint16(pos, true); pos += 2;
  const cbExtra = v.getUint16(pos, true); pos += 2;

  for (let i = 0; i < cData && pos < fc + lcb; i++) {
    // FFN structure: cbFfnM1 (1 byte) = total size - 1
    if (pos >= fc + lcb) break;
    const cbFfnM1 = tableStream[pos]; pos += 1;
    const ffnEnd = pos + cbFfnM1;
    if (ffnEnd > fc + lcb) break;
    // Skip fixed part of FFN (39 bytes): prq+ff(1), wWeight(2), chs(1), ixchSzAlt(1), panose(10), fs(24)
    const nameStart = pos + 39;
    // Font name is null-terminated UTF-16LE
    let name = '';
    if (nameStart < ffnEnd && nameStart < tableStream.length - 1) {
      for (let j = nameStart; j + 1 < ffnEnd && j + 1 < tableStream.length; j += 2) {
        const ch = tableStream[j] | (tableStream[j + 1] << 8);
        if (ch === 0) break;
        name += String.fromCharCode(ch);
        if (name.length > 256) break; // safety limit
      }
    }
    fonts.push(name || `Font${i}`);
    pos = ffnEnd;
  }
  return fonts;
}

// ── Parse character formatting from PlcBteChpx ──
function parseCharFormatting(wordDoc, tableStream, fc, lcb, pieces) {
  const runs = []; // {cpStart, cpEnd, props}
  if (!lcb || fc + lcb > tableStream.length) return runs;
  const tsView = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  const n = Math.floor((lcb - 4) / 8);
  // Read FCs and PNs
  for (let i = 0; i < n; i++) {
    const pn = tsView.getUint32(fc + (n + 1) * 4 + i * 4, true);
    // Read FKP page from WordDocument (512 bytes)
    const pageOff = pn * 512;
    if (pageOff + 512 > wordDoc.length) continue;
    const page = wordDoc.slice(pageOff, pageOff + 512);
    const crun = page[511];
    if (crun === 0) continue;

    for (let r = 0; r < crun; r++) {
      const rgfcOff = r * 4;
      const fcStart = page[rgfcOff] | (page[rgfcOff + 1] << 8) | (page[rgfcOff + 2] << 16) | (page[rgfcOff + 3] << 24);
      const fcEnd = page[rgfcOff + 4] | (page[rgfcOff + 5] << 8) | (page[rgfcOff + 6] << 16) | (page[rgfcOff + 7] << 24);
      // BX entry: 1 byte offset (in 2-byte words within page)
      const bxOff = (crun + 1) * 4 + r;
      const chpxWordOff = page[bxOff];
      if (chpxWordOff === 0) continue;
      const chpxByteOff = chpxWordOff * 2;
      if (chpxByteOff >= 511) continue;
      const cb = page[chpxByteOff];
      if (cb === 0 || chpxByteOff + 1 + cb > 512) continue;

      const props = parseSprms(page, chpxByteOff + 1, cb);
      if (Object.keys(props).length === 0) continue;

      // Convert FC range to CP range
      const cpS = fcToCp(fcStart, pieces);
      const cpE = fcToCp(fcEnd, pieces);
      if (cpS >= 0 && cpE > cpS) runs.push({ cpStart: cpS, cpEnd: cpE, props });
    }
  }
  runs.sort((a, b) => a.cpStart - b.cpStart);
  return runs;
}

// ── Parse paragraph formatting from PlcBtePapx ──
function parseParaFormatting(wordDoc, tableStream, fc, lcb, pieces) {
  const runs = [];
  if (!lcb || fc + lcb > tableStream.length) return runs;
  const tsView = new DataView(tableStream.buffer, tableStream.byteOffset, tableStream.byteLength);
  const n = Math.floor((lcb - 4) / 8);
  for (let i = 0; i < n; i++) {
    const pn = tsView.getUint32(fc + (n + 1) * 4 + i * 4, true);
    const pageOff = pn * 512;
    if (pageOff + 512 > wordDoc.length) continue;
    const page = wordDoc.slice(pageOff, pageOff + 512);
    const crun = page[511];
    if (crun === 0) continue;

    for (let r = 0; r < crun; r++) {
      const rgfcOff = r * 4;
      const fcStart = page[rgfcOff] | (page[rgfcOff + 1] << 8) | (page[rgfcOff + 2] << 16) | (page[rgfcOff + 3] << 24);
      const fcEnd = page[rgfcOff + 4] | (page[rgfcOff + 5] << 8) | (page[rgfcOff + 6] << 16) | (page[rgfcOff + 7] << 24);
      // PAPX BX: 13 bytes (1 byte offset + 12 bytes PHE)
      const bxBase = (crun + 1) * 4 + r * 13;
      if (bxBase >= 511) continue;
      const papxWordOff = page[bxBase];
      if (papxWordOff === 0) continue;
      const papxByteOff = papxWordOff * 2;
      if (papxByteOff >= 511) continue;
      let cb = page[papxByteOff];
      let grpStart = papxByteOff + 1;
      if (cb === 0 && grpStart < 511) {
        cb = page[grpStart] * 2;
        grpStart += 1;
      }
      if (cb < 2 || grpStart + cb > 512) continue;
      // Skip 2-byte istd (style index)
      const props = parseSprms(page, grpStart + 2, cb - 2);
      if (Object.keys(props).length === 0) continue;

      const cpS = fcToCp(fcStart, pieces);
      const cpE = fcToCp(fcEnd, pieces);
      if (cpS >= 0 && cpE > cpS) runs.push({ cpStart: cpS, cpEnd: cpE, props });
    }
  }
  runs.sort((a, b) => a.cpStart - b.cpStart);
  return runs;
}

// ── Build formatted HTML from .doc binary ──
function renderDocBinary(buffer) {
  const ole2 = parseOLE2(buffer);
  const wordDoc = ole2.getStream('WordDocument');
  if (!wordDoc) throw new Error('WordDocument stream not found');

  let fib;
  try { fib = parseFIB(wordDoc); } catch { return fallbackRender(wordDoc); }
  const tableStream = ole2.getStream(fib.tableName);

  // Parse piece table for text + FC mapping
  const clx = fib.fibPair(66);
  if (!clx.lcb || !tableStream) return fallbackRender(wordDoc);
  let ptResult;
  try { ptResult = parsePieceTable(wordDoc, tableStream, clx.fc, clx.lcb); } catch { /* fall through */ }
  if (!ptResult || !ptResult.text) return fallbackRender(wordDoc);

  const { text, pieces } = ptResult;

  // Parse font table
  const ftPair = fib.fibPair(39);
  let fonts = [];
  try { fonts = parseFontTable(tableStream, ftPair.fc, ftPair.lcb); } catch { /* use empty */ }

  // Parse character and paragraph formatting (non-fatal if these fail)
  let charRuns = [], paraRuns = [];
  try {
    const chpxPair = fib.fibPair(10);
    charRuns = parseCharFormatting(wordDoc, tableStream, chpxPair.fc, chpxPair.lcb, pieces);
  } catch { /* proceed without character formatting */ }
  try {
    const papxPair = fib.fibPair(11);
    paraRuns = parseParaFormatting(wordDoc, tableStream, papxPair.fc, papxPair.lcb, pieces);
  } catch { /* proceed without paragraph formatting */ }

  // Build paragraphs: split text by \r (paragraph mark in Word binary)
  const html = [];
  let inTable = false;
  let tableRow = [];
  let tableCellCpStart = 0;
  let cp = 0;

  const paragraphs = text.split('\r');
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const paraText = paragraphs[pi];
    const paraLen = paraText.length;
    const cpStart = cp;
    const cpEnd = cp + paraLen;

    // Find paragraph props covering this CP range
    let paraProps = {};
    for (const pr of paraRuns) {
      if (pr.cpStart <= cpStart && pr.cpEnd > cpStart) { paraProps = pr.props; break; }
    }

    // ── Table handling ──
    if (paraProps.inTable) {
      // Split cells by \x07 (cell mark)
      const cells = paraText.split('\x07');
      let cellCp = cpStart;
      for (let ci = 0; ci < cells.length; ci++) {
        const cellText = cells[ci];
        if (cellText || ci < cells.length - 1) {
          tableRow.push({ text: cellText, cpStart: cellCp });
        }
        cellCp += cellText.length + 1; // +1 for \x07
      }
      if (paraProps.tableRowEnd) {
        if (!inTable) { html.push('<div class="word-tbl-wrap"><table class="word-tbl word-tbl-bordered">'); inTable = true; }
        html.push('<tr>');
        // Last cell is the row-end marker itself, skip it
        const dataCells = tableRow.slice(0, -1);
        for (const cell of (dataCells.length ? dataCells : tableRow)) {
          const cleanCell = cell.text.replace(/[\x01\x08\x13\x14\x15]/g, '');
          html.push(`<td class="word-tc">${renderFormattedRun(cleanCell, cell.cpStart, charRuns, fonts)}</td>`);
        }
        html.push('</tr>');
        tableRow = [];
      }
    } else {
      // ── Close open table ──
      if (inTable) { html.push('</table></div>'); inTable = false; tableRow = []; }

      // Clean special chars (field codes, picture placeholders, etc.)
      const cleanText = paraText.replace(/[\x01\x08\x13\x14\x15\x07]/g, '');

      // Build paragraph style
      const styleParts = [];
      if (paraProps.align && paraProps.align !== 'left') styleParts.push(`text-align:${paraProps.align}`);
      if (paraProps.spaceBefore) styleParts.push(`margin-top:${paraProps.spaceBefore}pt`);
      if (paraProps.spaceAfter) styleParts.push(`margin-bottom:${paraProps.spaceAfter}pt`);
      if (paraProps.indentLeft && paraProps.indentLeft > 0) styleParts.push(`padding-left:${paraProps.indentLeft}pt`);
      if (paraProps.indentRight && paraProps.indentRight > 0) styleParts.push(`padding-right:${paraProps.indentRight}pt`);
      if (paraProps.firstLine) {
        if (paraProps.firstLine > 0) styleParts.push(`text-indent:${paraProps.firstLine}pt`);
        else styleParts.push(`text-indent:${paraProps.firstLine}pt;padding-left:${(paraProps.indentLeft || 0) - paraProps.firstLine}pt`);
      }
      if (paraProps.lineHeight) styleParts.push(`line-height:${paraProps.lineHeight}`);
      const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';

      if (!cleanText.trim()) {
        html.push(`<p class="word-p word-empty"${styleAttr}>&nbsp;</p>`);
      } else {
        const content = renderFormattedRun(cleanText, cpStart, charRuns, fonts);

        // Detect heading: use outlineLvl (0-8) from paragraph Sprm, or fall back to font size
        let headingLevel = 0;
        if (paraProps.outlineLvl !== undefined && paraProps.outlineLvl <= 8) {
          headingLevel = paraProps.outlineLvl + 1; // outlineLvl 0 = Heading 1
        } else {
          // Heuristic: large bold text that's short = heading
          const firstCharRun = charRuns.find(r => r.cpStart <= cpStart && r.cpEnd > cpStart);
          const fs = firstCharRun?.props?.fontSize;
          if (fs && fs >= 18 && cleanText.trim().length < 200) {
            headingLevel = fs >= 28 ? 1 : fs >= 22 ? 2 : 3;
          }
        }

        if (headingLevel >= 1 && headingLevel <= 6) {
          html.push(`<h${headingLevel} class="word-h"${styleAttr}>${content}</h${headingLevel}>`);
        } else {
          html.push(`<p class="word-p"${styleAttr}>${content}</p>`);
        }
      }
    }

    cp = cpEnd + 1; // +1 for the \r separator
  }
  if (inTable) html.push('</table></div>');

  return html.join('');
}

// Render text with character formatting applied
function renderFormattedRun(text, cpOffset, charRuns, fonts) {
  if (!text) return '';
  const parts = [];
  let pos = 0;

  while (pos < text.length) {
    const cpPos = cpOffset + pos;
    // Find formatting run covering this position
    let run = null;
    for (const r of charRuns) {
      if (r.cpStart <= cpPos && r.cpEnd > cpPos) { run = r; break; }
    }

    // Find how far this run extends
    let runEnd = text.length;
    if (run) runEnd = Math.min(runEnd, run.cpEnd - cpOffset);
    // Also check when next different run starts
    for (const r of charRuns) {
      if (r.cpStart > cpPos && r.cpStart - cpOffset < runEnd) {
        runEnd = r.cpStart - cpOffset;
        break;
      }
    }
    if (runEnd <= pos) runEnd = pos + 1;

    const chunk = text.slice(pos, runEnd);

    if (run && run.props) {
      const p = run.props;
      // Skip hidden text
      if (p.vanish) { pos = runEnd; continue; }

      // Apply text transforms before escaping
      let displayText = chunk;
      if (p.allCaps) displayText = displayText.toUpperCase();
      // smallCaps: don't transform text — CSS font-variant handles it
      const escaped = escapeHtml(displayText);

      const css = [];
      if (p.bold) css.push('font-weight:bold');
      if (p.italic) css.push('font-style:italic');
      // Text decoration: combine underline + strikethrough
      const decoParts = [];
      if (p.underline) decoParts.push('underline');
      if (p.strike) decoParts.push('line-through');
      if (decoParts.length) {
        let deco = `text-decoration:${decoParts.join(' ')}`;
        if (p.ulColor) deco += `;text-decoration-color:${p.ulColor}`;
        css.push(deco);
      }
      if (p.fontSize) css.push(`font-size:${p.fontSize}pt`);
      if (p.color) css.push(`color:${p.color}`);
      if (p.fontIdx !== undefined && fonts[p.fontIdx]) css.push(`font-family:"${fonts[p.fontIdx]}",sans-serif`);
      if (p.smallCaps && !p.allCaps) css.push('font-variant:small-caps');
      if (p.vertAlign) css.push(`vertical-align:${p.vertAlign};font-size:0.75em`);

      if (css.length) {
        parts.push(`<span style="${css.join(';')}">${escaped}</span>`);
      } else {
        parts.push(escaped);
      }
    } else {
      parts.push(escapeHtml(chunk));
    }
    pos = runEnd;
  }
  return parts.join('');
}

// Fallback: scan binary for readable text
function fallbackRender(wordDoc) {
  const parts = [];
  let current = '';
  for (let i = 0x200; i < wordDoc.length; i++) {
    const b = wordDoc[i];
    if (b >= 0x20 && b < 0x7F) current += String.fromCharCode(b);
    else if (b === 0x0D || b === 0x0A) { if (current.trim()) parts.push(current); current = ''; }
    else if (b === 0x09) current += '\t';
    else { if (current.length > 2) parts.push(current); current = ''; }
  }
  if (current.trim()) parts.push(current);
  if (!parts.length) throw new Error('No readable text found');
  return parts.map(p => `<p class="word-p">${escapeHtml(p)}</p>`).join('');
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
  if (styleProps.lineHeight) styleParts.push(`line-height:${styleProps.lineHeight}`);
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
      // Old .doc (OLE2 binary) — formatted rendering
      isDocFormat = true;
      resultHtml = renderDocBinary(arrayBuffer);
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
