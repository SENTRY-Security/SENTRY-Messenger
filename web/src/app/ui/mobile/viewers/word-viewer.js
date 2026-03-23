import { log } from '../../../core/log.js';
import { escapeHtml } from '../ui-utils.js';
import { t } from '/locales/index.js';

const JSZIP_URL = '/assets/libs/jszip.min.js';

function toRoman(n) {
  const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
  const syms = ['M','CM','D','CD','C','XC','L','XL','X','IX','V','IV','I'];
  let r = '';
  for (let i = 0; i < vals.length && n > 0; i++) {
    while (n >= vals[i]) { r += syms[i]; n -= vals[i]; }
  }
  return r;
}
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
  if (wordDoc.length < 0x22) throw new Error('FIB too short');
  const v = new DataView(wordDoc.buffer, wordDoc.byteOffset, wordDoc.byteLength);
  if (v.getUint16(0, true) !== 0xA5EC) throw new Error('Invalid Word document magic');
  const flags = v.getUint16(0x0A, true);
  if (flags & 0x0100) throw new Error('ENCRYPTED');

  let off = 0x20;
  if (off + 2 > wordDoc.length) throw new Error('FIB too short');
  const csw = v.getUint16(off, true); off += 2 + csw * 2;
  if (off + 2 > wordDoc.length) throw new Error('FIB too short');
  const cslw = v.getUint16(off, true); off += 2 + cslw * 4;
  if (off + 2 > wordDoc.length) throw new Error('FIB too short');
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
      case 6: {
        // Variable-length operand: first byte (or 2 bytes for specific sprms) is size
        // sprmTDefTable(0xD608), sprmTDefTableShd(0xD612), sprmTCellShd(0xD670),
        // sprmTInsert(0xD613), sprmTBrcTopCv(0xD634), sprmTBrcLeftCv, sprmTBrcBottomCv, sprmTBrcRightCv
        // and sprmTDefTableShd80(0xD609) all use 2-byte size prefix per [MS-DOC]
        if (sprm === 0xD608 || sprm === 0xD609 || sprm === 0xD612 || sprm === 0xD613 ||
            sprm === 0xD634 || sprm === 0xD670) {
          // 2-byte cb: value includes the first byte of cb itself, so actual data = cb - 1
          const cb2 = pos + 1 < end ? (data[pos] | (data[pos + 1] << 8)) : 0;
          opSize = cb2 > 0 ? cb2 - 1 : 0;
          pos += 2;
        } else {
          opSize = pos < end ? data[pos++] : 0;
        }
        break;
      }
      default: opSize = 0;
    }
    if (pos + opSize > end) break;

    // Toggle semantics (MS-DOC §2.4.6.3):
    // 0x00=inherit style, 0x01=on, 0x80=inherit style, 0x81=negate style default
    // Only set prop for 0x01 (on) and 0x80/0x81; skip 0x00 to allow style inheritance
    const setToggle = (prop, v) => {
      if (v === 1 || v === 0x81) props[prop] = true;
      else if (v === 0x80) props[prop] = false;
      // 0x00 = inherit from style → don't set (let style fallback work)
    };

    switch (sprm) {
      // ── Character properties (sgc=2, CHP) ──
      case 0x0835: setToggle('bold', data[pos]); break;
      case 0x0836: setToggle('italic', data[pos]); break;
      case 0x0837: setToggle('strike', data[pos]); break;
      case 0x083A: setToggle('smallCaps', data[pos]); break;
      case 0x083B: setToggle('allCaps', data[pos]); break;
      case 0x0839: setToggle('vanish', data[pos]); break; // hidden text
      case 0x2A3E: { // sprmCKul - underline type
        const kul = data[pos];
        // 0=none,1=single,2=wordsOnly,3=double,4=dotted,5=dash,6=dashDot,7=dashDotDot,20=wave
        if (kul === 0) props.underline = false;
        else {
          props.underline = true;
          if (kul === 3) props.underlineStyle = 'double';
          else if (kul === 4) props.underlineStyle = 'dotted';
          else if (kul === 5 || kul === 6 || kul === 7) props.underlineStyle = 'dashed';
          else if (kul === 20) props.underlineStyle = 'wavy';
        }
        break;
      }
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
      case 0x2A0C: { // sprmCHighlight - highlight color index
        const hlMap = [null, '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff',
          '#ff0000', '#ffff00', '#ffffff', '#00008b', '#008b8b', '#006400',
          '#8b008b', '#8b0000', '#808000', '#808080', '#c0c0c0'];
        const hl = data[pos];
        if (hl > 0 && hl < hlMap.length) props.highlight = hlMap[hl];
        break;
      }
      case 0x2A48: props.istdChar = data[pos] | (data[pos + 1] << 8); break; // character style index (2 bytes)
      case 0x6A03: props.picLocation = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24); break; // sprmCPicLocation
      case 0x0806: props.fData = toggleVal(data[pos]); break; // sprmCFData — marks picture char
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
      case 0x2407: props.pageBreakBefore = toggleVal(data[pos]); break; // sprmPFPageBreakBefore (ispmd=7)
      case 0x2416: props.inTable = toggleVal(data[pos]); break; // sprmPFInTable (ispmd=22)
      case 0x2417: props.tableRowEnd = toggleVal(data[pos]); break; // sprmPFTtp (ispmd=23)
      case 0x460B: case 0xA413: // sprmPDyaBefore (Word 97 / Word 2000+)
        props.spaceBefore = (data[pos] | (data[pos + 1] << 8)) / 20; break;
      case 0x460C: case 0xA414: // sprmPDyaAfter (Word 97 / Word 2000+)
        props.spaceAfter = (data[pos] | (data[pos + 1] << 8)) / 20; break;
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
      case 0x6412: { // sprmPDyaLine - line spacing (4 bytes: dyaLine int16 + fMultLinespace int16)
        let dyaLine = data[pos] | (data[pos + 1] << 8);
        if (dyaLine > 0x7FFF) dyaLine -= 0x10000; // signed int16
        const fMultLinespace = data[pos + 2] | (data[pos + 3] << 8);
        if (fMultLinespace) {
          // Proportional: value/240 = multiplier (e.g., 480 = double spacing)
          props.lineHeight = (Math.abs(dyaLine) / 240).toFixed(2);
        } else if (dyaLine < 0) {
          // Exact line spacing (negative = exact)
          props.lineHeight = (Math.abs(dyaLine) / 20) + 'pt';
        } else if (dyaLine > 0) {
          // At-least line spacing
          props.lineHeight = (dyaLine / 20) + 'pt';
        }
        break;
      }
      case 0x2423: props.outlineLvl = data[pos]; break; // sprmPOutLvl (heading level)
      case 0x260A: props.ilvl = data[pos]; break; // sprmPIlvl — list level (0-8)
      case 0x460F: props.ilfo = data[pos] | (data[pos + 1] << 8); break; // sprmPIlfo — list format override index
      case 0x442D: { // sprmPShd80 - paragraph shading (legacy SHD80, 2 bytes)
        const shdVal = data[pos] | (data[pos + 1] << 8);
        const icoBack = shdVal & 0x1F;
        const icoMap80 = [null, '#000000', '#0000ff', '#00ffff', '#00ff00', '#ff00ff',
          '#ff0000', '#ffff00', '#ffffff', '#00008b', '#008b8b', '#006400',
          '#8b008b', '#8b0000', '#808000', '#808080', '#c0c0c0'];
        if (icoBack > 0 && icoBack < icoMap80.length) props.paraBg = icoMap80[icoBack];
        break;
      }
      case 0xC63D: { // sprmPBrcTop80 - paragraph top border (4 bytes: BRC80)
        if (opSize >= 4) {
          const bWidth = data[pos]; // border width in 1/8 pt
          const bType = data[pos + 1];
          const bColor = data[pos + 2]; // ICO index
          if (bWidth > 0) props.borderTop = Math.max(1, Math.round(bWidth / 8)) + 'px solid';
        }
        break;
      }
      case 0xC63E: { // sprmPBrcLeft80
        if (opSize >= 4) {
          const bWidth = data[pos];
          if (bWidth > 0) props.borderLeft = Math.max(1, Math.round(bWidth / 8)) + 'px solid';
        }
        break;
      }
      case 0xC63F: { // sprmPBrcBottom80
        if (opSize >= 4) {
          const bWidth = data[pos];
          if (bWidth > 0) props.borderBottom = Math.max(1, Math.round(bWidth / 8)) + 'px solid';
        }
        break;
      }
      case 0xC640: { // sprmPBrcRight80
        if (opSize >= 4) {
          const bWidth = data[pos];
          if (bWidth > 0) props.borderRight = Math.max(1, Math.round(bWidth / 8)) + 'px solid';
        }
        break;
      }

      // ── Table (TAP) properties ──
      case 0xD608: { // sprmTDefTable - defines cell boundaries + TC properties
        // Operand format: 1 byte itcMac (cell count),
        // then (itcMac+1) * 2 bytes = cell boundary positions (dxa, twips from left margin)
        // then itcMac * 20 bytes = TC structures (cell properties)
        if (opSize < 3) break;
        const itcMac = data[pos]; // 1 byte, NOT 2
        if (itcMac <= 0 || itcMac > 64) break;
        const boundaryBytes = (itcMac + 1) * 2;
        if (1 + boundaryBytes > opSize) break;
        const cellBoundaries = [];
        for (let c = 0; c <= itcMac; c++) {
          let bnd = data[pos + 1 + c * 2] | (data[pos + 2 + c * 2] << 8);
          if (bnd > 0x7FFF) bnd -= 0x10000; // signed
          cellBoundaries.push(bnd);
        }
        // Calculate cell widths from boundary differences (twips → pt)
        const cellWidths = [];
        for (let c = 0; c < itcMac; c++) {
          cellWidths.push(Math.max(0, (cellBoundaries[c + 1] - cellBoundaries[c]) / 20));
        }
        props.cellWidths = cellWidths;
        props.cellCount = itcMac;
        // Parse TC structures (20 bytes each) for borders/shading
        const tcBase = pos + 1 + boundaryBytes;
        if (1 + boundaryBytes + itcMac * 20 <= opSize) {
          const cellTCs = [];
          for (let c = 0; c < itcMac; c++) {
            const tcOff = tcBase + c * 20;
            const tcFlags = data[tcOff] | (data[tcOff + 1] << 8);
            const fVertMerge = !!(tcFlags & 0x0020);
            const fVertRestart = !!(tcFlags & 0x0040);
            cellTCs.push({ fVertMerge, fVertRestart });
          }
          props.cellTCs = cellTCs;
        }
        break;
      }
      case 0xD612: { // sprmTDefTableShd - cell shading for the row
        // Array of SHD structures (10 bytes each): cvFore(4) + cvBack(4) + ipat(2)
        if (opSize < 10) break;
        const nCells = Math.floor(opSize / 10);
        const cellShds = [];
        for (let c = 0; c < nCells; c++) {
          const shdOff = pos + c * 10;
          const ipat = data[shdOff + 8] | (data[shdOff + 9] << 8);
          // ipat=0 means auto/transparent; cvBack byte 7 = 0xFF means auto color
          if (ipat === 0 || data[shdOff + 7] === 0xFF) { cellShds.push(null); continue; }
          const r = data[shdOff + 4], g = data[shdOff + 5], b = data[shdOff + 6];
          if (r === 0xFF && g === 0xFF && b === 0xFF) cellShds.push(null);
          else cellShds.push('#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''));
        }
        props.cellShds = cellShds;
        break;
      }
      case 0xD613: { // sprmTDefTableShd2nd/sprmTCellShd - alternate cell shading format
        if (opSize < 10) break;
        const nCells2 = Math.floor(opSize / 10);
        const cellShds2 = [];
        for (let c = 0; c < nCells2; c++) {
          const shdOff = pos + c * 10;
          const ipat2 = data[shdOff + 8] | (data[shdOff + 9] << 8);
          if (ipat2 === 0 || data[shdOff + 7] === 0xFF) { cellShds2.push(null); continue; }
          const r = data[shdOff + 4], g = data[shdOff + 5], b = data[shdOff + 6];
          if (r === 0xFF && g === 0xFF && b === 0xFF) cellShds2.push(null);
          else cellShds2.push('#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join(''));
        }
        if (!props.cellShds) props.cellShds = cellShds2;
        break;
      }
      case 0x5400: { // sprmTJc - table row justification
        const tJc = data[pos] | (data[pos + 1] << 8);
        props.tableAlign = ['left', 'center', 'right'][tJc] || 'left';
        break;
      }
      case 0x9407: { // sprmTDyaRowHeight - row height
        let rowH = data[pos] | (data[pos + 1] << 8);
        if (rowH > 0x7FFF) rowH -= 0x10000; // signed: negative = exact, positive = at-least
        props.rowHeight = Math.abs(rowH) / 20;
        props.rowHeightExact = rowH < 0;
        break;
      }
      case 0xD605: { // sprmTTableBorders - table border definition (older format)
        // 6 borders × 8 bytes = 48 bytes (top, left, bottom, right, insideH, insideV)
        if (opSize >= 48) {
          props.tableBorders = true; // just flag that borders exist
        }
        break;
      }

      // ── Section (SEP) properties ──
      case 0xB017: { // sprmSDxaLeft - left margin (twips)
        let v = data[pos] | (data[pos + 1] << 8);
        if (v > 0x7FFF) v -= 0x10000;
        props.marginLeft = v / 20;
        break;
      }
      case 0xB018: { // sprmSDxaRight - right margin (twips)
        let v = data[pos] | (data[pos + 1] << 8);
        if (v > 0x7FFF) v -= 0x10000;
        props.marginRight = v / 20;
        break;
      }
      case 0x9023: { // sprmSDyaTop - top margin (twips)
        let v = data[pos] | (data[pos + 1] << 8);
        if (v > 0x7FFF) v -= 0x10000;
        props.marginTop = v / 20;
        break;
      }
      case 0x9024: { // sprmSDyaBottom - bottom margin (twips)
        let v = data[pos] | (data[pos + 1] << 8);
        if (v > 0x7FFF) v -= 0x10000;
        props.marginBottom = v / 20;
        break;
      }
    }
    pos += opSize;
  }
  return props;
}

// ── Parse list definitions (LSTF) and overrides (LFO) ──
function parseLists(tableStream, fib) {
  const lists = new Map(); // lsid → { levels: [{ nfc, iStartAt, bulletChar }] }
  const lfoMap = []; // index 1-based → lsid

  // 1) Parse PlfLst (FIB index 37)
  try {
    const lstPair = fib.fibPair(37);
    if (lstPair.lcb > 2) {
      let pos = lstPair.fc;
      const end = lstPair.fc + lstPair.lcb;
      const cLst = tableStream[pos] | (tableStream[pos + 1] << 8);
      pos += 2;
      // Read LSTF entries (28 bytes each)
      const lstfEntries = [];
      for (let i = 0; i < cLst && pos + 28 <= end; i++) {
        const lsid = tableStream[pos] | (tableStream[pos+1]<<8) | (tableStream[pos+2]<<16) | (tableStream[pos+3]<<24);
        const flags = tableStream[pos + 24] | (tableStream[pos + 25] << 8);
        const fSimple = !!(flags & 1);
        lstfEntries.push({ lsid, fSimple });
        pos += 28;
      }
      // Read LVLF entries for each list
      for (const entry of lstfEntries) {
        const lvlCount = entry.fSimple ? 1 : 9;
        const levels = [];
        for (let lv = 0; lv < lvlCount && pos + 28 <= end; lv++) {
          const iStartAt = tableStream[pos] | (tableStream[pos+1]<<8) | (tableStream[pos+2]<<16) | (tableStream[pos+3]<<24);
          const nfc = tableStream[pos + 4]; // number format
          const jc = tableStream[pos + 5];
          const cbPapx = tableStream[pos + 24];
          const cbChpx = tableStream[pos + 25];
          pos += 28; // LVLF size
          pos += cbPapx; // skip PAPX grpprl
          pos += cbChpx; // skip CHPX grpprl
          if (pos > end) break;
          // Read number text (xst): 2-byte count + unicode chars
          if (pos + 2 <= end) {
            const cch = tableStream[pos] | (tableStream[pos + 1] << 8);
            pos += 2;
            let bulletChar = '';
            if (nfc === 23 || nfc === 255) {
              // Bullet: read first char as bullet symbol
              if (cch > 0 && pos + 2 <= end) {
                bulletChar = String.fromCharCode(tableStream[pos] | (tableStream[pos + 1] << 8));
              }
            }
            pos += cch * 2;
            levels.push({ nfc, iStartAt, jc, bulletChar });
          }
        }
        lists.set(entry.lsid, { levels, fSimple: entry.fSimple });
      }
    }
  } catch { /* skip */ }

  // 2) Parse PlfLfo (FIB index 38) — maps ilfo (1-based) to lsid
  try {
    const lfoPair = fib.fibPair(38);
    if (lfoPair.lcb > 4) {
      let pos = lfoPair.fc;
      const end = lfoPair.fc + lfoPair.lcb;
      const cLfo = tableStream[pos] | (tableStream[pos+1]<<8) | (tableStream[pos+2]<<16) | (tableStream[pos+3]<<24);
      pos += 4;
      // Each LFO = 16 bytes
      for (let i = 0; i < cLfo && pos + 16 <= end; i++) {
        const lsid = tableStream[pos] | (tableStream[pos+1]<<8) | (tableStream[pos+2]<<16) | (tableStream[pos+3]<<24);
        lfoMap.push(lsid); // lfoMap[0] = ilfo 1
        pos += 16;
      }
    }
  } catch { /* skip */ }

  return { lists, lfoMap };
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
    const pn = tsView.getUint32(fc + (n + 1) * 4 + i * 4, true) & 0x3FFFFF; // 22-bit page number
    // Read FKP page from WordDocument (512 bytes)
    const pageOff = pn * 512;
    if (pageOff + 512 > wordDoc.length) continue;
    const page = wordDoc.slice(pageOff, pageOff + 512);
    const crun = page[511];
    if (crun === 0) continue;

    const pgView = new DataView(page.buffer, page.byteOffset, page.byteLength);
    for (let r = 0; r < crun; r++) {
      const fcStart = pgView.getUint32(r * 4, true);
      const fcEnd = pgView.getUint32((r + 1) * 4, true);
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
    const pn = tsView.getUint32(fc + (n + 1) * 4 + i * 4, true) & 0x3FFFFF; // 22-bit page number
    const pageOff = pn * 512;
    if (pageOff + 512 > wordDoc.length) continue;
    const page = wordDoc.slice(pageOff, pageOff + 512);
    const crun = page[511];
    if (crun === 0) continue;

    const pgView = new DataView(page.buffer, page.byteOffset, page.byteLength);
    for (let r = 0; r < crun; r++) {
      const fcStart = pgView.getUint32(r * 4, true);
      const fcEnd = pgView.getUint32((r + 1) * 4, true);
      // PAPX BX: 13 bytes (1 byte offset + 12 bytes PHE)
      const bxBase = (crun + 1) * 4 + r * 13;
      if (bxBase >= 511) continue;
      const papxWordOff = page[bxBase];
      if (papxWordOff === 0) continue;
      const papxByteOff = papxWordOff * 2;
      if (papxByteOff >= 511) continue;
      // PapxInFkp (MS-DOC §2.9.182):
      //   cb (1 byte): if non-zero, GrpPrlAndIstd is 2*cb bytes
      //     (spec says 2*cb-1 but Apache POI uses 2*cb — more reliable)
      //   if cb == 0:  next byte cb', GrpPrlAndIstd is 2*cb' bytes
      const cbRaw = page[papxByteOff];
      let grpSize, grpStart;
      if (cbRaw !== 0) {
        grpSize = 2 * cbRaw;
        grpStart = papxByteOff + 1;
      } else if (papxByteOff + 1 < 511) {
        grpSize = page[papxByteOff + 1] * 2;
        grpStart = papxByteOff + 2;
      } else { continue; }
      // Cap at page boundary (byte 511 = crun, not data)
      const maxSize = 511 - grpStart;
      if (maxSize < 2) continue;
      if (grpSize > maxSize) grpSize = maxSize;
      if (grpSize < 2) continue;
      // GrpPrlAndIstd: first 2 bytes = istd (style index), rest = grpprl (sprms)
      const istd = page[grpStart] | (page[grpStart + 1] << 8);
      const props = parseSprms(page, grpStart + 2, grpSize - 2);
      props._istd = istd;

      const cpS = fcToCp(fcStart, pieces);
      const cpE = fcToCp(fcEnd, pieces);
      if (cpS >= 0 && cpE > cpS) runs.push({ cpStart: cpS, cpEnd: cpE, props });
    }
  }
  runs.sort((a, b) => a.cpStart - b.cpStart);
  return runs;
}

// ── Parse STSH (Style Sheet) ──
// FibRgFcLcb97 index 1 = fcStshf/lcbStshf
// Returns a map: istd → { name, type, basedOn, props }
function parseStyleSheet(tableStream, fc, lcb) {
  const styles = new Map();
  if (!lcb || fc + lcb > tableStream.length) return styles;

  const view = new DataView(tableStream.buffer, tableStream.byteOffset + fc, lcb);
  // STSHI header: first 2 bytes = cbStshi (size of STSHI structure)
  const cbStshi = view.getUint16(0, true);
  if (cbStshi < 2 || 2 + cbStshi > lcb) return styles;
  // STSHI: bytes 0-1 = cstd (number of styles)
  const stshiView = new DataView(tableStream.buffer, tableStream.byteOffset + fc + 2, Math.min(cbStshi, lcb - 2));
  const cstd = stshiView.getUint16(0, true);
  const cbSTDBaseInFile = stshiView.getUint16(2, true); // size of STD base

  // Skip past STSHI header to the STD array
  let offset = 2 + cbStshi;

  for (let istd = 0; istd < cstd && offset + 2 <= lcb; istd++) {
    const cbStd = view.getUint16(offset, true);
    if (cbStd === 0) { offset += 2; continue; }
    if (offset + 2 + cbStd > lcb) break;

    const stdStart = offset + 2;
    try {
      // STD structure:
      // Bytes 0-1: sti (style identifier) in bits 0-11, sgc in bits 12-15
      const stiSgc = view.getUint16(stdStart, true);
      const sti = stiSgc & 0x0FFF;
      const sgc = (stiSgc >> 12) & 0x0F; // 1=paragraph, 2=character, 3=table
      // Bytes 2-3: istdBase (based-on style)
      const istdBase = view.getUint16(stdStart + 2, true);
      // Bytes 4: cupx (number of UPX in style)
      // Byte 5 is padding info

      // Parse GrpUpx (formatting properties)
      // Skip the fixed part to find the style name + UPX
      const nameOffset = stdStart + cbSTDBaseInFile;
      if (nameOffset >= stdStart + cbStd) { offset += 2 + cbStd; continue; }

      // Style name: first 2 bytes = length, then Unicode chars
      let styleName = '';
      if (nameOffset + 2 <= fc + lcb) {
        const nameLen = view.getUint16(nameOffset, true);
        if (nameLen > 0 && nameLen < 200) {
          const nameStart = nameOffset + 2;
          for (let i = 0; i < nameLen && nameStart + i * 2 + 1 < stdStart + cbStd; i++) {
            const ch = view.getUint16(nameStart + i * 2, true);
            if (ch === 0) break;
            styleName += String.fromCharCode(ch);
          }
        }
      }

      // Parse GrpUpx — UPX groups after the style name
      // GrpUpx starts after the name string (nameLen chars * 2 + 2 for length + possible null terminator)
      const cupx = cbSTDBaseInFile >= 5 ? (view.getUint8(stdStart + 4) & 0x0F) : 0;
      let upxOff = nameOffset + 2; // after nameLen word
      if (nameOffset + 2 <= stdStart + cbStd) {
        const nl = view.getUint16(nameOffset, true);
        upxOff = nameOffset + 2 + (nl + 1) * 2; // name chars + null terminator, each 2 bytes
        // Align to 2-byte boundary
        if ((upxOff - (stdStart)) % 2 !== 0) upxOff++;
      }

      const styleProps = {};
      const charProps = {};
      // Parse UPX entries
      // For paragraph styles (sgc=1): UPX[0] = UpxPapx, UPX[1] = UpxChpx
      // For character styles (sgc=2): UPX[0] = UpxChpx
      // For table styles (sgc=3): UPX[0] = UpxTapx, UPX[1] = UpxPapx, UPX[2] = UpxChpx
      try {
        for (let u = 0; u < cupx && upxOff + 2 <= stdStart + cbStd; u++) {
          const cbUpx = view.getUint16(upxOff, true);
          const upxData = upxOff + 2;
          if (cbUpx > 0 && upxData + cbUpx <= stdStart + cbStd) {
            // Create a safe copy to avoid out-of-bounds access
            const absOff = fc + upxData;
            if (absOff + cbUpx <= tableStream.length) {
              const upxBytes = tableStream.slice(absOff, absOff + cbUpx);
              if (sgc === 1 && u === 0 && cbUpx >= 2) {
                // UpxPapx: first 2 bytes = istd, rest = grpprl
                Object.assign(styleProps, parseSprms(upxBytes, 2, cbUpx - 2));
              } else if ((sgc === 1 && u === 1) || (sgc === 2 && u === 0)) {
                // UpxChpx: grpprl only
                Object.assign(charProps, parseSprms(upxBytes, 0, cbUpx));
              }
            }
          }
          upxOff += 2 + cbUpx;
          if ((upxOff - stdStart) % 2 !== 0) upxOff++;
        }
      } catch { /* skip malformed UPX */ }

      // Fallback: built-in heading detection from sti
      if (sti >= 1 && sti <= 9 && !styleProps.outlineLvl) {
        styleProps.outlineLvl = sti - 1;
      }

      styles.set(istd, {
        name: styleName,
        type: sgc,
        basedOn: istdBase === 0x0FFF ? -1 : istdBase,
        sti,
        props: styleProps,
        charProps,
      });
    } catch { /* skip malformed style */ }

    offset += 2 + cbStd;
  }

  return styles;
}

// ── Render OLE embedded chart from ObjectPool package_stream ──
// Parses ODF chart (application/vnd.oasis.opendocument.chart) ZIP and renders as HTML bar/line/pie chart.
function renderOleChart(ole2) {
  const pkg = ole2.getStream('package_stream');
  if (!pkg || pkg[0] !== 0x50 || pkg[1] !== 0x4B) return ''; // not a ZIP

  // Parse ZIP central directory
  let eocdPos = pkg.length - 22;
  while (eocdPos > 0 && !(pkg[eocdPos]===0x50&&pkg[eocdPos+1]===0x4B&&pkg[eocdPos+2]===0x05&&pkg[eocdPos+3]===0x06)) eocdPos--;
  if (eocdPos <= 0) return '';
  const cdOff = pkg[eocdPos+16]|(pkg[eocdPos+17]<<8)|(pkg[eocdPos+18]<<16)|(pkg[eocdPos+19]<<24);
  const numEntries = pkg[eocdPos+10]|(pkg[eocdPos+11]<<8);

  // Build file map
  const zipFiles = {};
  let p = cdOff;
  for (let i = 0; i < numEntries && p + 46 <= pkg.length; i++) {
    const method = pkg[p+10]|(pkg[p+11]<<8);
    const compSize = pkg[p+20]|(pkg[p+21]<<8)|(pkg[p+22]<<16)|(pkg[p+23]<<24);
    const nameLen = pkg[p+28]|(pkg[p+29]<<8);
    const extraLen = pkg[p+30]|(pkg[p+31]<<8);
    const commentLen = pkg[p+32]|(pkg[p+33]<<8);
    const localOff = pkg[p+42]|(pkg[p+43]<<8)|(pkg[p+44]<<16)|(pkg[p+45]<<24);
    const name = new TextDecoder().decode(pkg.slice(p+46, p+46+nameLen));
    const lnLen = pkg[localOff+26]|(pkg[localOff+27]<<8);
    const leLen = pkg[localOff+28]|(pkg[localOff+29]<<8);
    zipFiles[name] = { method, compSize, dataStart: localOff + 30 + lnLen + leLen };
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Extract content.xml
  const entry = zipFiles['content.xml'];
  if (!entry || entry.compSize <= 0) return '';
  const raw = pkg.slice(entry.dataStart, entry.dataStart + entry.compSize);
  if (entry.method === 0) return parseOdfChartXml(new TextDecoder().decode(raw));
  // Method 8 = deflate — return raw data for async decompression by caller
  return { _asyncChart: true, raw };
}

// Parse ODF chart XML and return HTML
function parseOdfChartXml(xml) {
  if (!xml || !xml.includes('chart:')) return '';

  const chartClass = xml.match(/chart:class="chart:([^"]+)"/)?.[1] || 'bar';

  // Extract table data
  const rowMatches = xml.match(/<table:table-row[^>]*>[\s\S]*?<\/table:table-row>/g);
  if (!rowMatches || rowMatches.length < 2) return '';

  const rows = rowMatches.map(row => {
    const cells = row.match(/<table:table-cell[^>]*(?:\/>|>[\s\S]*?<\/table:table-cell>)/g) || [];
    return cells.map(c => {
      const v = c.match(/office:value="([^"]+)"/)?.[1];
      const s = c.match(/office:string-value="([^"]+)"/)?.[1];
      const t = c.match(/<text:p>([^<]*)<\/text:p>/)?.[1];
      return v ? parseFloat(v) : (s || t || '');
    });
  });

  const headers = rows[0]; // First row = category labels
  const dataRows = rows.slice(1); // Data rows
  if (!dataRows.length) return '';

  // Find max value for scaling
  let maxVal = 0;
  dataRows.forEach(r => r.forEach((v, i) => { if (i > 0 && typeof v === 'number') maxVal = Math.max(maxVal, v); }));
  if (maxVal === 0) maxVal = 1;

  // Colors for series
  const colors = ['#3b82f6', '#f97316', '#eab308', '#22c55e', '#a855f7', '#ef4444'];

  if (chartClass === 'bar') {
    // Render bar chart as HTML/CSS
    const seriesCount = headers.length - 1;
    const catCount = dataRows.length;
    const barWidth = Math.max(12, Math.floor(60 / seriesCount));

    let html = '<div class="word-chart"><div class="word-chart-area">';
    // Y-axis labels
    html += '<div class="word-chart-yaxis">';
    for (let i = 5; i >= 0; i--) {
      const v = Math.round(maxVal * i / 5 * 10) / 10;
      html += `<span>${v}</span>`;
    }
    html += '</div>';
    // Bars
    html += '<div class="word-chart-bars">';
    dataRows.forEach((row, ri) => {
      html += '<div class="word-chart-group">';
      for (let si = 1; si < row.length && si <= seriesCount; si++) {
        const val = typeof row[si] === 'number' ? row[si] : 0;
        const pct = (val / maxVal * 100).toFixed(1);
        const color = colors[(si - 1) % colors.length];
        html += `<div class="word-chart-bar" style="height:${pct}%;background:${color};width:${barWidth}px" title="${headers[si]}: ${val}"></div>`;
      }
      html += `<div class="word-chart-cat">${typeof row[0] === 'string' ? row[0] : ''}</div>`;
      html += '</div>';
    });
    html += '</div></div>';
    // Legend
    html += '<div class="word-chart-legend">';
    for (let si = 1; si < headers.length; si++) {
      html += `<span><i style="background:${colors[(si-1) % colors.length]}"></i>${headers[si]}</span>`;
    }
    html += '</div></div>';
    return html;
  }

  // Fallback: show data as table
  let html = '<table class="word-tbl word-tbl-bordered"><tr>';
  headers.forEach(h => { html += `<th class="word-tc">${h}</th>`; });
  html += '</tr>';
  dataRows.forEach(row => {
    html += '<tr>';
    row.forEach(v => { html += `<td class="word-tc">${v}</td>`; });
    html += '</tr>';
  });
  html += '</table>';
  return html;
}

// ── Extract inline picture from Data stream at given offset ──
// PICFAndOfficeArtData: PICF (68 bytes) + OfficeArt records
// MS-DOC §2.9.177 PICF, §2.9.178 PICFAndOfficeArtData
function extractDocImage(dataStream, offset) {
  if (!dataStream || offset < 0 || offset + 68 > dataStream.length) return '';
  const avail = dataStream.length - offset;
  const dv = new DataView(dataStream.buffer, dataStream.byteOffset + offset, avail);
  const lcb = dv.getUint32(0, true);       // total size
  const cbHeader = dv.getUint16(4, true);  // PICF header size (typically 0x44 = 68)
  if (cbHeader < 28 || lcb < cbHeader || offset + lcb > dataStream.length) return '';
  const mm = dv.getUint16(6, true);        // mfpf.mm: 0x0064=MM_SHAPE, 0x0066=MM_SHAPEFILE

  // PICMID starts at PICF offset 28 (§2.9.176)
  const dxaGoal = dv.getUint16(28, true);  // original width in twips
  const dyaGoal = dv.getUint16(30, true);  // original height in twips
  const mx = dv.getUint16(32, true);       // horizontal scale (‰ of 100%)
  const my = dv.getUint16(34, true);       // vertical scale
  const wPt = mx && dxaGoal ? Math.round(dxaGoal * (mx / 1000) / 20) : 0;
  const hPt = my && dyaGoal ? Math.round(dyaGoal * (my / 1000) / 20) : 0;
  const style = wPt && hPt ? `max-width:100%;width:${wPt}pt;height:auto` : 'max-width:100%;height:auto';

  // OfficeArt data offset — after PICF header (+ optional filename for MM_SHAPEFILE)
  let artOff = offset + cbHeader;
  if (mm === 0x0066 && artOff < offset + lcb) {
    const cchPicName = dataStream[artOff];
    artOff += 1 + cchPicName;
  }
  const artEnd = offset + lcb;
  if (artOff >= artEnd) return '';

  // Scan OfficeArt records for BLIP image data
  // Record header: 2 bytes (recVer|recInstance) + 2 bytes recType + 4 bytes recLen
  while (artOff + 8 <= artEnd) {
    const rh = new DataView(dataStream.buffer, dataStream.byteOffset + artOff, 8);
    const verInst = rh.getUint16(0, true);
    const recVer = verInst & 0xF;
    const recInst = (verInst >> 4) & 0xFFF;
    const recType = rh.getUint16(2, true);
    const recLen = rh.getUint32(4, true);
    artOff += 8;

    if (recLen === 0 || artOff + recLen > artEnd) break;

    // Container records (recVer=0xF): children are inline at artOff
    // Don't advance by recLen — let the while loop process each child record
    if (recVer === 0xF) continue;

    // OfficeArtFBSE (0xF007): wrapper around BLIP
    // FBSE body = 36 bytes after the 8-byte header (already consumed).
    // Byte 33 of body = cbName. Embedded BLIP follows after 36 + cbName bytes.
    if (recType === 0xF007 && recLen > 36) {
      const cbName = dataStream[artOff + 33] || 0;
      artOff += 36 + cbName; // skip FBSE fixed part + nameData
      continue;
    }

    // OfficeArt BLIP types (MS-ODRAW):
    // 0xF01A/0xF02A=EMF, 0xF01B/0xF02B=WMF, 0xF01C/0xF02C=PICT
    // 0xF01D/0xF02D=JPEG, 0xF01E/0xF02E=PNG, 0xF01F/0xF02F=DIB, 0xF029=TIFF
    if (recType >= 0xF01A && recType <= 0xF02F && recLen > 20) {
      const is2uid = (recInst & 1) === 1;
      const uidSkip = is2uid ? 32 : 16;

      // EMF/WMF/PICT — metafile, skip (can't render in browser)
      if (recType === 0xF01A || recType === 0xF02A ||
          recType === 0xF01B || recType === 0xF02B ||
          recType === 0xF01C || recType === 0xF02C) {
        artOff += recLen; continue;
      }

      let imgOff = artOff + uidSkip + 1; // UIDs + tag byte
      let mime = '';
      if (recType === 0xF01D || recType === 0xF02D) mime = 'image/jpeg';
      else if (recType === 0xF01E || recType === 0xF02E) mime = 'image/png';
      else if (recType === 0xF01F || recType === 0xF02F) { artOff += recLen; continue; } // DIB unsupported
      else { artOff += recLen; continue; }

      const imgLen = recLen - (imgOff - artOff);
      if (imgLen <= 0 || imgOff + imgLen > artEnd) { artOff += recLen; continue; }

      // Validate with magic bytes
      const b0 = dataStream[imgOff], b1 = dataStream[imgOff + 1];
      if (b0 === 0x89 && b1 === 0x50) mime = 'image/png';
      else if (b0 === 0xFF && b1 === 0xD8) mime = 'image/jpeg';
      else { artOff += recLen; continue; } // unknown format

      const blob = new Blob([dataStream.slice(imgOff, imgOff + imgLen)], { type: mime });
      return `<img src="${URL.createObjectURL(blob)}" style="${style}" alt="" class="word-img">`;
    }

    artOff += recLen;
  }
  return '';
}

// ── Extract images from OfficeArt Drawing Group (BStoreContainer in Table stream → BLIPs in WordDocument) ──
// Returns an array of {index, html} where index is the 1-based BSE reference.
function extractOfficeArtImages(tableStream, wordDoc, fib) {
  const images = [];
  // Try multiple FIB pair indices for DggInfo (varies by Word version)
  let dggFc = 0, dggLcb = 0;
  for (const idx of [22, 50]) {
    const p = fib.fibPair(idx);
    if (p.lcb > 0) { dggFc = p.fc; dggLcb = p.lcb; break; }
  }
  if (!dggLcb || dggFc + dggLcb > tableStream.length) return images;

  // Scan DggContainer for BStoreContainer → BSE entries
  let off = dggFc;
  const end = dggFc + dggLcb;
  while (off + 8 <= end) {
    const rt = tableStream[off + 2] | (tableStream[off + 3] << 8);
    const len = tableStream[off + 4] | (tableStream[off + 5] << 8) | (tableStream[off + 6] << 16) | (tableStream[off + 7] << 24);
    const ver = tableStream[off] & 0x0F;

    if (ver === 0x0F) { off += 8; continue; } // enter container

    if (rt === 0xF007 && len >= 36) {
      // BSE record — extract foDelay (offset into WordDocument)
      const btWin32 = tableStream[off + 8];
      const size = tableStream[off + 28] | (tableStream[off + 29] << 8) | (tableStream[off + 30] << 16) | (tableStream[off + 31] << 24);
      const foDelay = tableStream[off + 36] | (tableStream[off + 37] << 8) | (tableStream[off + 38] << 16) | (tableStream[off + 39] << 24);

      if (foDelay > 0 && foDelay + 8 < wordDoc.length) {
        // Read BLIP record from WordDocument at foDelay
        const blipRt = wordDoc[foDelay + 2] | (wordDoc[foDelay + 3] << 8);
        const blipLen = wordDoc[foDelay + 4] | (wordDoc[foDelay + 5] << 8) | (wordDoc[foDelay + 6] << 16) | (wordDoc[foDelay + 7] << 24);

        if (blipRt >= 0xF01A && blipRt <= 0xF02F && blipLen > 20 && foDelay + 8 + blipLen <= wordDoc.length) {
          const inst = ((wordDoc[foDelay] >> 4) | (wordDoc[foDelay + 1] << 4)) & 0xFFF;
          const is2uid = (inst & 1) === 1;
          const uidSkip = is2uid ? 32 : 16;
          const imgOff = foDelay + 8 + uidSkip + 1; // header + UIDs + tag

          let mime = '';
          const b0 = wordDoc[imgOff], b1 = wordDoc[imgOff + 1];
          if (b0 === 0xFF && b1 === 0xD8) mime = 'image/jpeg';
          else if (b0 === 0x89 && b1 === 0x50) mime = 'image/png';

          if (mime) {
            const imgLen = blipLen - uidSkip - 1;
            if (imgLen > 0 && imgOff + imgLen <= wordDoc.length) {
              const blob = new Blob([wordDoc.slice(imgOff, imgOff + imgLen)], { type: mime });
              images.push(`<img src="${URL.createObjectURL(blob)}" style="max-width:100%;height:auto" alt="" class="word-img">`);
            }
          }
        }
      }
    }
    off += 8 + len;
  }
  return images;
}

// ── Build formatted HTML from .doc binary ──
function renderDocBinary(buffer) {
  const ole2 = parseOLE2(buffer);
  const wordDoc = ole2.getStream('WordDocument');
  if (!wordDoc) throw new Error('WordDocument stream not found');

  let fib;
  try { fib = parseFIB(wordDoc); } catch (e) {
    if (e?.message === 'ENCRYPTED') throw e; // let caller show encrypted notice
    return fallbackRender(wordDoc);
  }
  const tableStream = ole2.getStream(fib.tableName);
  const dataStream = ole2.getStream('Data');

  // Extract images from OfficeArt Drawing Group (BSE → BLIP in WordDocument)
  let artImages = [];
  try { artImages = extractOfficeArtImages(tableStream, wordDoc, fib); } catch { /* skip */ }

  // Pre-render OLE charts — returns HTML string or {_asyncChart, raw} for deflate
  // Use mutable object so renderFormattedRun can consume it (strings are pass-by-value)
  const oleChart = { html: '' };
  let _oleChartAsync = null;
  try {
    const chartResult = renderOleChart(ole2);
    if (typeof chartResult === 'string') oleChart.html = chartResult;
    else if (chartResult && chartResult._asyncChart) {
      _oleChartAsync = chartResult;
      oleChart.html = '<div id="word-ole-chart-placeholder" class="word-chart" style="text-align:center;padding:24px;color:#94a3b8">Loading chart…</div>';
    }
  } catch { /* skip */ }

  // Parse piece table for text + FC mapping
  // FibRgFcLcb97 index 33 = fcClx/lcbClx
  const clx = fib.fibPair(33);
  if (!clx.lcb || !tableStream) return fallbackRender(wordDoc);
  let ptResult;
  try { ptResult = parsePieceTable(wordDoc, tableStream, clx.fc, clx.lcb); } catch { /* fall through */ }
  if (!ptResult || !ptResult.text) return fallbackRender(wordDoc);

  const { text, pieces } = ptResult;

  // Parse font table (FibRgFcLcb97 index 15 = SttbfFfn)
  const ftPair = fib.fibPair(15);
  let fonts = [];
  try { fonts = parseFontTable(tableStream, ftPair.fc, ftPair.lcb); } catch { /* use empty */ }

  // Parse list definitions (LSTF/LFO)
  let listData = { lists: new Map(), lfoMap: [] };
  try { listData = parseLists(tableStream, fib); } catch { /* use empty */ }

  // Parse STSH (Style Sheet) for style-based formatting (FIB index 1)
  let styles = new Map();
  try {
    const stshPair = fib.fibPair(1);
    styles = parseStyleSheet(tableStream, stshPair.fc, stshPair.lcb);
  } catch { /* use empty */ }

  // Parse character and paragraph formatting (non-fatal if these fail)
  let charRuns = [], paraRuns = [];
  try {
    // FibRgFcLcb97 index 12 = PlcfBteChpx
    const chpxPair = fib.fibPair(12);
    charRuns = parseCharFormatting(wordDoc, tableStream, chpxPair.fc, chpxPair.lcb, pieces);
  } catch { /* proceed without character formatting */ }
  try {
    // FibRgFcLcb97 index 13 = PlcfBtePapx
    const papxPair = fib.fibPair(13);
    paraRuns = parseParaFormatting(wordDoc, tableStream, papxPair.fc, papxPair.lcb, pieces);
  } catch (e) { console.warn('[word-viewer] PAPX parse error:', e); }

  // Diagnostic (temporary) — helps identify parsing issues
  console.info('[word-viewer] Parse results:', {
    textLen: text.length, pieces: pieces.length,
    charRuns: charRuns.length, paraRuns: paraRuns.length,
    styles: styles.size, hasDataStream: !!dataStream,
    inTableCount: paraRuns.filter(r => r.props.inTable).length,
    rowEndCount: paraRuns.filter(r => r.props.tableRowEnd).length,
    picLocationCount: charRuns.filter(r => r.props.picLocation !== undefined).length,
    ilfoCount: paraRuns.filter(r => r.props.ilfo > 0).length,
    cellMarkCount: (text.match(/\x07/g) || []).length,
  });

  // DOP page margins (FIB index 31 = fcDop/lcbDop)
  // Note: DOP field offsets vary by Word version; disabled until verified
  let pageMargins = null;
  // Parse section properties (margins) from PlcfSed → SEPX
  try {
    const sedPair = fib.fibPair(28); // fcPlcfSed/lcbPlcfSed
    if (sedPair.lcb >= 16) {
      const sedView = new DataView(tableStream.buffer, tableStream.byteOffset + sedPair.fc, sedPair.lcb);
      const nSections = Math.floor((sedPair.lcb - 4) / 16); // (n+1)*4 CPs + n*12 SEDs
      if (nSections >= 1) {
        // Read first section's SED
        const sedOff = (nSections + 1) * 4; // skip CPs
        const fcSepx = sedView.getInt32(sedOff + 2, true); // offset 2 in SED
        if (fcSepx >= 0 && fcSepx + 2 < wordDoc.length) {
          const cb = wordDoc[fcSepx] | (wordDoc[fcSepx + 1] << 8);
          if (cb > 0 && fcSepx + 2 + cb <= wordDoc.length) {
            const sepProps = parseSprms(wordDoc, fcSepx + 2, cb);
            const left = sepProps.marginLeft || 72; // default 1 inch = 1440 twips = 72pt
            const right = sepProps.marginRight || 72;
            if (left > 0 || right > 0) {
              pageMargins = { left, right };
            }
          }
        }
      }
    }
  } catch { /* skip */ }

  // Style resolver: merge base style props with direct props
  function resolveStyle(istd) {
    const visited = new Set();
    const merged = {};
    const mergedChar = {};
    let cur = istd;
    while (cur >= 0 && styles.has(cur) && !visited.has(cur)) {
      visited.add(cur);
      const s = styles.get(cur);
      for (const [k, v] of Object.entries(s.props)) {
        if (merged[k] === undefined) merged[k] = v;
      }
      if (s.charProps) {
        for (const [k, v] of Object.entries(s.charProps)) {
          if (mergedChar[k] === undefined) mergedChar[k] = v;
        }
      }
      cur = s.basedOn;
    }
    merged._charProps = mergedChar;
    return merged;
  }

  // Build paragraphs: split text by \r (paragraph mark in Word binary)
  const html = [];
  let inTable = false;
  let tableRow = [];
  let tblMaxCols = 0;
  let tblAllRowEnds = []; // all rowEndRuns for current table
  const listCounters = {}; // track numbering per list+level
  let tblRowIdx = 0; // current row index within the table
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

    // Merge style-based paragraph properties (style provides defaults, direct overrides)
    if (paraProps._istd !== undefined && styles.size > 0) {
      const styleP = resolveStyle(paraProps._istd);
      // Style props as defaults — don't overwrite direct props
      // But skip table membership props (inTable/tableRowEnd per MS-DOC spec)
      for (const [k, v] of Object.entries(styleP)) {
        if (k === 'inTable' || k === 'tableRowEnd' || k === '_istd') continue;
        if (paraProps[k] === undefined) paraProps[k] = v;
      }
    }

    // ── Table handling ──
    const hasCellMark = paraText.indexOf('\x07') !== -1;

    if (paraProps.inTable) {
      // ── PAPX-based table ──
      // Word .doc tables: each cell is one or more paragraphs with inTable=true.
      // Cell end = paragraph ending with \x07. Row end = tableRowEnd paragraph.
      // Single-paragraph tables: all cells in one paragraph separated by \x07.

      if (!inTable) {
        // Find ALL tableRowEnd runs for this table to determine maxCols and table width
        tblAllRowEnds = paraRuns.filter(r => r.props.tableRowEnd && r.cpStart >= cpStart);
        tblRowIdx = 0;
        tblMaxCols = 0;
        let maxTblWidth = 0;
        for (const re of tblAllRowEnds) {
          const cw = re.props.cellWidths;
          if (cw) {
            if (cw.length > tblMaxCols) tblMaxCols = cw.length;
            const w = cw.reduce((s, v) => s + v, 0);
            if (w > maxTblWidth) maxTblWidth = w;
          }
        }
        const fixedClass = maxTblWidth > 0 ? ' word-tbl-fixed' : '';
        const tblStyle = maxTblWidth > 0 ? ` style="width:${maxTblWidth}pt"` : '';
        html.push(`<div class="word-tbl-wrap"><table class="word-tbl word-tbl-bordered${fixedClass}"${tblStyle}>`);
        inTable = true;
      }

      if (paraProps.tableRowEnd) {
        // Row-end paragraph — flush accumulated tableRow cells as a <tr>
        const cw = paraProps.cellWidths;
        const cs2 = paraProps.cellShds;
        const tcs = paraProps.cellTCs;
        if (tableRow.length > 0) {
          html.push('<tr>');
          for (let ci = 0; ci < tableRow.length; ci++) {
            const cell = tableRow[ci];
            const tc = tcs?.[ci];
            // Vertical merge: fVertMerge without fVertRestart = continuation → hide
            if (tc?.fVertMerge && !tc.fVertRestart) {
              html.push('<td class="word-tc" style="display:none"></td>');
              continue;
            }
            const tdStyle = [];
            if (cw && ci < cw.length) tdStyle.push(`width:${cw[ci]}pt`);
            if (cs2 && ci < cs2.length && cs2[ci]) tdStyle.push(`background-color:${cs2[ci]}`);
            // colspan: last cell spans remaining columns
            const isLast = ci === tableRow.length - 1;
            const remaining = tblMaxCols - tableRow.length;
            const csAttr = isLast && remaining > 0 ? ` colspan="${remaining + 1}"` : '';
            // Vertical merge: fVertRestart = start → calculate rowspan
            let rsAttr = '';
            if (tc?.fVertRestart && tblAllRowEnds.length > 0) {
              let span = 1;
              for (let nr = tblRowIdx + 1; nr < tblAllRowEnds.length; nr++) {
                const ntc = tblAllRowEnds[nr].props.cellTCs?.[ci];
                if (ntc?.fVertMerge && !ntc.fVertRestart) span++;
                else break;
              }
              if (span > 1) rsAttr = ` rowspan="${span}"`;
            }
            const sa = tdStyle.length ? ` style="${tdStyle.join(';')}"` : '';
            html.push(`<td class="word-tc"${rsAttr}${csAttr}${sa}>${cell.html}</td>`);
          }
          html.push('</tr>');
        }
        tableRow = [];
        tblRowIdx++;
      } else {
        // Cell content paragraph — accumulate
        const cellMarkCount = (paraText.match(/\x07/g) || []).length;
        if (cellMarkCount > 1) {
          // Single-paragraph with multiple cells (old format)
          // Each row = cellCount data cells + 1 row-end marker cell (\x07)
          const segments = paraText.split('\x07');
          let cellCp = cpStart;
          // Find ALL rowEndRuns within this paragraph's CP range
          const rowEndRuns = paraRuns.filter(r => r.props.tableRowEnd && r.cpStart >= cpStart && r.cpStart <= cpEnd + 200);
          let segIdx = 0;
          for (let ri = 0; ri < rowEndRuns.length && segIdx < segments.length; ri++) {
            const reProps = rowEndRuns[ri].props;
            const cellCount = reProps.cellWidths?.length || reProps.cellCount || 4;
            const cw = paraProps.cellWidths || reProps.cellWidths;
            const cs2 = paraProps.cellShds || reProps.cellShds;
            const tcs = reProps.cellTCs;
            html.push('<tr>');
            for (let ci = 0; ci < cellCount && segIdx < segments.length; ci++) {
              const seg = segments[segIdx];
              const tc = tcs?.[ci];
              // Vertical merge continuation → hide
              if (tc?.fVertMerge && !tc.fVertRestart) {
                html.push('<td class="word-tc" style="display:none"></td>');
                cellCp += seg.length + 1;
                segIdx++;
                continue;
              }
              const tdStyle = [];
              if (cw && ci < cw.length) tdStyle.push(`width:${cw[ci]}pt`);
              if (cs2 && ci < cs2.length && cs2[ci]) tdStyle.push(`background-color:${cs2[ci]}`);
              // colspan: last cell spans remaining columns
              const isLastCell = ci === cellCount - 1;
              const remCols = tblMaxCols - cellCount;
              const csAttr = isLastCell && remCols > 0 ? ` colspan="${remCols + 1}"` : '';
              // Vertical merge start → calculate rowspan
              let rsAttr = '';
              if (tc?.fVertRestart) {
                let span = 1;
                for (let nr = ri + 1; nr < rowEndRuns.length; nr++) {
                  const ntc = rowEndRuns[nr].props.cellTCs?.[ci];
                  if (ntc?.fVertMerge && !ntc.fVertRestart) span++;
                  else break;
                }
                if (span > 1) rsAttr = ` rowspan="${span}"`;
              }
              const sa = tdStyle.length ? ` style="${tdStyle.join(';')}"` : '';
              html.push(`<td class="word-tc"${rsAttr}${csAttr}${sa}>${renderFormattedRun(seg, cellCp, charRuns, fonts, dataStream, oleChart, artImages, paraProps._charProps)}</td>`);
              cellCp += seg.length + 1;
              segIdx++;
            }
            html.push('</tr>');
            tblRowIdx++;
            // Skip row-end marker cell
            if (segIdx < segments.length) {
              cellCp += segments[segIdx].length + 1;
              segIdx++;
            }
          }
        } else if (cellMarkCount === 1) {
          // Single cell end (\x07) — this paragraph is one cell in a multi-paragraph table
          const cellText = paraText.replace(/\x07$/, '');
          const cellHtml = renderFormattedRun(cellText, cpStart, charRuns, fonts, dataStream, oleChart, artImages, paraProps._charProps);
          if (tableRow.length > 0 && !tableRow[tableRow.length - 1].closed) {
            tableRow[tableRow.length - 1].html += '<br>' + cellHtml;
            tableRow[tableRow.length - 1].closed = true;
          } else {
            tableRow.push({ html: cellHtml, closed: true });
          }
        } else {
          // No \x07 — content continuation within a cell
          const cellHtml = renderFormattedRun(paraText, cpStart, charRuns, fonts, dataStream, oleChart, artImages, paraProps._charProps);
          if (tableRow.length > 0 && !tableRow[tableRow.length - 1].closed) {
            tableRow[tableRow.length - 1].html += '<br>' + cellHtml;
          } else {
            tableRow.push({ html: cellHtml, closed: false });
          }
        }
      }
    } else if (hasCellMark && !paraProps.inTable) {
      // ── Fallback: detect table from \x07 cell marks ──
      // In Word binary, each cell ends with \x07, and each row ends with an
      // extra \x07 (row-end mark). Row-end mark follows the last cell's \x07,
      // so \x07\x07 means "cell-end then row-end". We split rows by detecting
      // two consecutive \x07 marks (empty segment between two \x07).
      const segments = paraText.split('\x07');
      const fallbackRows = [];
      let rowCells = [];
      let cellCp = cpStart;

      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        // Empty segment after cells = row-end marker, flush row
        if (seg.length === 0 && rowCells.length > 0) {
          fallbackRows.push(rowCells);
          rowCells = [];
        } else if (si < segments.length - 1) {
          // Non-empty segment (or empty at start of row = empty cell)
          rowCells.push({ text: seg, cpStart: cellCp });
        }
        cellCp += seg.length + 1;
      }
      if (rowCells.length > 0) fallbackRows.push(rowCells);

      if (fallbackRows.length > 0) {
        if (!inTable) { html.push('<div class="word-tbl-wrap"><table class="word-tbl word-tbl-bordered">'); inTable = true; }
        // Determine max columns for colspan
        const maxCols = Math.max(...fallbackRows.map(r => r.length));
        for (const row of fallbackRows) {
          html.push('<tr>');
          for (let ci = 0; ci < row.length; ci++) {
            const cell = row[ci];
            const isLast = ci === row.length - 1;
            const cs = isLast && row.length < maxCols ? ` colspan="${maxCols - ci}"` : '';
            html.push(`<td class="word-tc"${cs}>${renderFormattedRun(cell.text, cell.cpStart, charRuns, fonts, dataStream, oleChart, artImages, paraProps._charProps)}</td>`);
          }
          html.push('</tr>');
        }
      }
    } else {
      // ── Non-table paragraph ──
      if (inTable) {
        // Flush any remaining tableRow cells
        if (tableRow.length > 0) {
          html.push('<tr>');
          for (const cell of tableRow) html.push(`<td class="word-tc">${cell.html}</td>`);
          html.push('</tr>');
          tableRow = [];
        }
        // Check if next paragraph continues the table
        const nextParaProps = (() => {
          const nextCp = cpEnd + 1;
          for (const pr of paraRuns) { if (pr.cpStart <= nextCp && pr.cpEnd > nextCp) return pr.props; }
          return {};
        })();
        if (nextParaProps.inTable) {
          // Non-table paragraph between table rows — add as full-width row
          const visTxt = paraText.replace(/[\x01\x07\x08\x13\x14\x15]/g, '').trim();
          if (visTxt) {
            html.push(`<tr><td class="word-tc" colspan="99">${renderFormattedRun(paraText, cpStart, charRuns, fonts, dataStream, oleChart, artImages, paraProps._charProps)}</td></tr>`);
            cp = cpEnd + 1;
            continue;
          }
        }
        html.push('</table></div>'); inTable = false; tableRow = []; tblMaxCols = 0; tblAllRowEnds = []; tblRowIdx = 0;
      }

      // Build paragraph style
      const styleParts = [];
      if (paraProps.align && paraProps.align !== 'left') styleParts.push(`text-align:${paraProps.align}`);
      if (paraProps.spaceBefore) styleParts.push(`margin-top:${paraProps.spaceBefore}pt`);
      if (paraProps.spaceAfter) styleParts.push(`margin-bottom:${paraProps.spaceAfter}pt`);
      if (paraProps.firstLine && paraProps.firstLine < 0) {
        // Hanging indent: text-indent is negative, padding-left includes both indent + hanging
        styleParts.push(`text-indent:${paraProps.firstLine}pt`);
        styleParts.push(`padding-left:${(paraProps.indentLeft || 0) - paraProps.firstLine}pt`);
      } else {
        if (paraProps.indentLeft && paraProps.indentLeft > 0) styleParts.push(`padding-left:${paraProps.indentLeft}pt`);
        if (paraProps.firstLine && paraProps.firstLine > 0) styleParts.push(`text-indent:${paraProps.firstLine}pt`);
      }
      if (paraProps.indentRight && paraProps.indentRight > 0) styleParts.push(`padding-right:${paraProps.indentRight}pt`);
      if (paraProps.lineHeight) styleParts.push(`line-height:${paraProps.lineHeight}`);
      if (paraProps.pageBreakBefore) styleParts.push('page-break-before:always');
      if (paraProps.paraBg) styleParts.push(`background-color:${paraProps.paraBg};padding:2pt 4pt`);
      if (paraProps.borderTop) styleParts.push(`border-top:${paraProps.borderTop}`);
      if (paraProps.borderBottom) styleParts.push(`border-bottom:${paraProps.borderBottom}`);
      if (paraProps.borderLeft) styleParts.push(`border-left:${paraProps.borderLeft}`);
      if (paraProps.borderRight) styleParts.push(`border-right:${paraProps.borderRight}`);
      const styleAttr = styleParts.length ? ` style="${styleParts.join(';')}"` : '';

      // Check if paragraph has visible text (strip special chars for check only)
      const visibleText = paraText.replace(/[\x01\x07\x08\x13\x14\x15]/g, '').trim();

      if (!visibleText) {
        html.push(`<p class="word-p word-empty"${styleAttr}>&nbsp;</p>`);
      } else {
        // Pass raw paraText + cpStart — renderFormattedRun skips special chars internally
        // to maintain correct CP↔formatting alignment
        const content = renderFormattedRun(paraText, cpStart, charRuns, fonts, dataStream, oleChart, artImages, paraProps._charProps);

        // Detect heading: ONLY use outlineLvl from paragraph Sprm (MS-DOC standard)
        // No font-size heuristic — it causes false positives on bold paragraphs
        let headingLevel = 0;
        if (paraProps.outlineLvl !== undefined && paraProps.outlineLvl <= 5) {
          headingLevel = paraProps.outlineLvl + 1; // outlineLvl 0 = H1, ..., 5 = H6
        }

        if (headingLevel >= 1 && headingLevel <= 6) {
          html.push(`<h${headingLevel} class="word-h"${styleAttr}>${content}</h${headingLevel}>`);
        } else if (paraProps.ilfo > 0 || paraProps.ilvl !== undefined) {
          // List paragraph — render with bullet/number prefix
          const lvl = paraProps.ilvl || 0;
          const indent = (lvl + 1) * 24;
          // Resolve list definition from LSTF/LFO
          let marker = '';
          const lsid = paraProps.ilfo > 0 ? listData.lfoMap[paraProps.ilfo - 1] : undefined;
          const lstDef = lsid !== undefined ? listData.lists.get(lsid) : null;
          const lvlDef = lstDef?.levels?.[lstDef.fSimple ? 0 : lvl];
          if (lvlDef && lvlDef.nfc !== 23 && lvlDef.nfc !== 255) {
            // Numbered list — track counter per ilfo+lvl
            const counterKey = `${paraProps.ilfo}-${lvl}`;
            if (!listCounters[counterKey]) listCounters[counterKey] = lvlDef.iStartAt || 1;
            const num = listCounters[counterKey]++;
            if (lvlDef.nfc === 0) marker = `${num}.`;
            else if (lvlDef.nfc === 1) marker = toRoman(num) + '.';
            else if (lvlDef.nfc === 2) marker = toRoman(num).toLowerCase() + '.';
            else if (lvlDef.nfc === 3) marker = String.fromCharCode(64 + ((num - 1) % 26) + 1) + '.';
            else if (lvlDef.nfc === 4) marker = String.fromCharCode(96 + ((num - 1) % 26) + 1) + '.';
            else marker = `${num}.`;
          } else {
            // Bullet list
            const bc = lvlDef?.bulletChar;
            const defaultBullets = ['•', '◦', '▪', '•', '◦', '▪', '•', '◦', '▪'];
            marker = (bc && bc.charCodeAt(0) > 0x20) ? bc : defaultBullets[lvl] || '•';
          }
          html.push(`<p class="word-p word-list"${styleAttr} style="padding-left:${indent}pt;${styleParts.join(';')}"><span class="word-list-bullet">${escapeHtml(marker)}</span>${content}</p>`);
        } else {
          html.push(`<p class="word-p"${styleAttr}>${content}</p>`);
        }
      }
    }

    cp = cpEnd + 1; // +1 for the \r separator
  }
  if (inTable) html.push('</table></div>');

  // Append any remaining OfficeArt images not consumed by \x01 placeholders
  if (artImages.length > 0) {
    for (const img of artImages) html.push(`<div class="word-p">${img}</div>`);
  }
  // Append OLE chart if not yet consumed
  if (oleChart.html) html.push(oleChart.html);

  return { html: html.join(''), pageMargins, _oleChartAsync };
}

// Special chars to strip from display (picture placeholders, cell marks, field markers)
const SPECIAL_CHAR_RE = /[\x01\x07\x08\x13\x14\x15]/g; // global for replace()
const SPECIAL_CHAR_TEST = /[\x01\x07\x08\x13\x14\x15]/; // non-global for test()

// Render text with character formatting applied.
// `text` is raw paragraph text (including special chars), `cpOffset` is the CP of text[0].
// We iterate by raw position to keep CP alignment with charRuns, but skip special chars in output.
// `dataStream` is the OLE2 Data stream for extracting inline pictures (may be null).
function renderFormattedRun(text, cpOffset, charRuns, fonts, dataStream, oleChart, artImages, styleCharProps) {
  if (!text) return '';
  const parts = [];
  let pos = 0;

  while (pos < text.length) {
    // Handle special chars
    const ch = text[pos];
    if (ch === '\x01') {
      // Picture or OLE object placeholder
      const cpPos2 = cpOffset + pos;
      const picRun = charRuns.find(r => r.cpStart <= cpPos2 && r.cpEnd > cpPos2);
      const picLoc = picRun?.props?.picLocation;
      // 1) Valid picLocation → try Data stream image
      if (picLoc !== undefined && picLoc >= 0 && picLoc < 0x7FFFFFFF && dataStream) {
        const imgHtml = extractDocImage(dataStream, picLoc);
        if (imgHtml) { parts.push(imgHtml); pos++; continue; }
      }
      // 2) picLocation=0x7FFFFFFF or OLE embed → OLE chart first
      if (picLoc === undefined || picLoc >= 0x7FFFFFFF) {
        if (oleChart.html) { parts.push(oleChart.html); oleChart.html = ''; pos++; continue; }
      }
      // 3) OfficeArt images
      if (artImages && artImages.length > 0) {
        parts.push(artImages.shift());
        pos++; continue;
      }
      // 4) OLE chart as last fallback
      if (oleChart.html) { parts.push(oleChart.html); oleChart.html = ''; pos++; continue; }
      pos++; continue;
    }
    // Field code handling: \x13 = field start, \x14 = field separator, \x15 = field end
    // Parse HYPERLINK fields as <a> links
    if (ch === '\x13') {
      // Find matching \x14 (separator) and \x15 (end)
      const sepIdx = text.indexOf('\x14', pos + 1);
      const endIdx = text.indexOf('\x15', sepIdx > pos ? sepIdx + 1 : pos + 1);
      if (sepIdx > pos && endIdx > sepIdx) {
        const fieldCode = text.slice(pos + 1, sepIdx);
        const fieldResult = text.slice(sepIdx + 1, endIdx);
        // Check for HYPERLINK field
        const hypMatch = fieldCode.match(/HYPERLINK\s+"([^"]+)"/i) || fieldCode.match(/HYPERLINK\s+(\S+)/i);
        if (hypMatch && fieldResult.replace(SPECIAL_CHAR_RE, '').trim()) {
          const url = hypMatch[1];
          const linkText = escapeHtml(fieldResult.replace(SPECIAL_CHAR_RE, ''));
          parts.push(`<a href="${escapeHtml(url)}" class="word-link" target="_blank" rel="noopener noreferrer">${linkText}</a>`);
        } else {
          // Non-hyperlink field: check for embedded \x01 (picture/chart placeholder)
          let hasEmbed = false;
          for (let fi = 0; fi < fieldResult.length; fi++) {
            if (fieldResult[fi] === '\x01') {
              hasEmbed = true;
              const frCp = cpOffset + sepIdx + 1 + fi;
              const picRun = charRuns.find(r => r.cpStart <= frCp && r.cpEnd > frCp);
              const loc = picRun?.props?.picLocation;
              // 1) Valid picLocation → try Data stream image
              if (loc !== undefined && loc >= 0 && loc < 0x7FFFFFFF && dataStream) {
                const imgHtml = extractDocImage(dataStream, loc);
                if (imgHtml) { parts.push(imgHtml); continue; }
              }
              // 2) picLocation=0x7FFFFFFF or OLE embed field → OLE chart
              if (loc === undefined || loc >= 0x7FFFFFFF) {
                if (oleChart.html) { parts.push(oleChart.html); oleChart.html = ''; continue; }
              }
              // 3) OfficeArt images
              if (artImages && artImages.length > 0) { parts.push(artImages.shift()); continue; }
              // 4) OLE chart as last fallback
              if (oleChart.html) { parts.push(oleChart.html); oleChart.html = ''; continue; }
            }
          }
          if (!hasEmbed) {
            const visText = fieldResult.replace(SPECIAL_CHAR_RE, '');
            if (visText) parts.push(escapeHtml(visText));
          }
        }
        pos = endIdx + 1;
        continue;
      }
      // No matching separator/end — skip field start
      pos++; continue;
    }
    if (SPECIAL_CHAR_TEST.test(ch)) {
      pos++;
      continue;
    }

    const cpPos = cpOffset + pos;
    // Find formatting run covering this CP position
    let run = null;
    for (const r of charRuns) {
      if (r.cpStart <= cpPos && r.cpEnd > cpPos) { run = r; break; }
    }

    // Determine how far this run extends (in raw text positions)
    let runEnd = text.length;
    if (run) runEnd = Math.min(runEnd, run.cpEnd - cpOffset);
    for (const r of charRuns) {
      if (r.cpStart > cpPos && r.cpStart - cpOffset < runEnd) {
        runEnd = r.cpStart - cpOffset;
        break;
      }
    }
    if (runEnd <= pos) runEnd = pos + 1;

    // Extract chunk, stripping special chars for display (but keep tabs)
    const rawChunk = text.slice(pos, runEnd);
    const chunk = rawChunk.replace(SPECIAL_CHAR_RE, '');
    if (!chunk) { pos = runEnd; continue; }
    // If chunk is only tabs, render them
    if (/^\t+$/.test(chunk)) {
      for (let t = 0; t < chunk.length; t++) parts.push('<span class="word-tab">\t</span>');
      pos = runEnd;
      continue;
    }

    if (run && run.props) {
      // Merge style charProps as fallback (direct props take precedence)
      const p = styleCharProps ? Object.assign({}, styleCharProps, run.props) : run.props;
      // Skip hidden text
      if (p.vanish) { pos = runEnd; continue; }

      let displayText = chunk;
      if (p.allCaps) displayText = displayText.toUpperCase();
      const escaped = escapeHtml(displayText).replace(/\t/g, '<span class="word-tab">\t</span>');

      const css = [];
      if (p.bold) css.push('font-weight:bold');
      if (p.italic) css.push('font-style:italic');
      const decoParts = [];
      if (p.underline) decoParts.push('underline');
      if (p.strike) decoParts.push('line-through');
      if (decoParts.length) {
        let deco = `text-decoration:${decoParts.join(' ')}`;
        if (p.underlineStyle) deco += `;text-decoration-style:${p.underlineStyle}`;
        if (p.ulColor) deco += `;text-decoration-color:${p.ulColor}`;
        css.push(deco);
      }
      if (p.fontSize) css.push(`font-size:${p.fontSize}pt`);
      if (p.color) css.push(`color:${p.color}`);
      if (p.highlight) css.push(`background-color:${p.highlight}`);
      if (p.fontIdx !== undefined && fonts[p.fontIdx]) css.push(`font-family:"${fonts[p.fontIdx]}",sans-serif`);
      if (p.smallCaps && !p.allCaps) css.push('font-variant:small-caps');
      if (p.vertAlign) css.push(`vertical-align:${p.vertAlign};font-size:0.75em`);

      if (css.length) {
        parts.push(`<span style="${css.join(';')}">${escaped}</span>`);
      } else {
        parts.push(escaped);
      }
    } else {
      parts.push(escapeHtml(chunk).replace(/\t/g, '<span class="word-tab">\t</span>'));
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
    for (const [side, prop] of [['top','borderTop'],['bottom','borderBottom'],['left','borderLeft'],['right','borderRight']]) {
      const bdr = dn(pBdr, NS_W, side);
      if (bdr) {
        const bVal = getAttr(bdr, 'val');
        if (bVal && bVal !== 'none' && bVal !== 'nil') {
          const color = getAttr(bdr, 'color') || '000000';
          const sz = getAttr(bdr, 'sz');
          props[prop] = `${Math.max(1, Math.round(Number(sz || 4) / 8))}px solid #${color === 'auto' ? '000000' : color}`;
        }
      }
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
      html.push(renderTable(child, styles, relMap, imageData, numbering, listCounters));
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
  if (styleProps.borderTop) styleParts.push(`border-top:${styleProps.borderTop}`);
  if (styleProps.borderBottom) styleParts.push(`border-bottom:${styleProps.borderBottom}`);
  if (styleProps.borderLeft) styleParts.push(`border-left:${styleProps.borderLeft}`);
  if (styleProps.borderRight) styleParts.push(`border-right:${styleProps.borderRight}`);
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

      // Text content — collect ALL w:t elements (runs can have multiple)
      const textEls = dnAll(child, NS_W, 't');
      if (textEls.length) {
        const text = textEls.map(t => t.textContent || '').join('');
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
    } else if (child.localName === 'oMath') {
      // Inline math
      parts.push(`<span class="word-math">${renderOmml(child)}</span>`);
    } else if (child.localName === 'oMathPara') {
      // Display math paragraph
      parts.push(`<div class="word-math-para">${renderOmml(child)}</div>`);
    } else if (child.localName === 'bookmarkStart' || child.localName === 'bookmarkEnd' ||
               child.localName === 'proofErr' || child.localName === 'commentRangeStart' ||
               child.localName === 'commentRangeEnd') {
      // Skip metadata elements
    }
  }
  return parts.join('');
}

// ── OMML Math rendering → HTML ──
const NS_M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
function renderOmml(el) {
  if (!el) return '';
  const parts = [];
  for (const child of el.children) {
    const ln = child.localName;
    if (ln === 'r') {
      // Math run — extract text from <m:t>
      const t = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 't')[0] : null;
      if (!t) { const t2 = child.querySelector('t'); parts.push(t2?.textContent || ''); }
      else parts.push(`<span class="word-math-r">${escapeHtml(t.textContent || '')}</span>`);
    } else if (ln === 'f') {
      // Fraction: <m:num> / <m:den>
      const num = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'num')[0] : child.querySelector('num');
      const den = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'den')[0] : child.querySelector('den');
      parts.push(`<span class="word-math-frac"><span class="word-math-num">${renderOmml(num)}</span><span class="word-math-den">${renderOmml(den)}</span></span>`);
    } else if (ln === 'rad') {
      // Radical: <m:deg> (degree) + <m:e> (expression)
      const deg = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'deg')[0] : child.querySelector('deg');
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      const degText = deg ? renderOmml(deg) : '';
      if (degText && degText.replace(/<[^>]*>/g, '').trim()) {
        parts.push(`<span class="word-math-rad"><sup>${degText}</sup>&radic;<span style="text-decoration:overline">${renderOmml(e)}</span></span>`);
      } else {
        parts.push(`<span class="word-math-rad">&radic;<span style="text-decoration:overline">${renderOmml(e)}</span></span>`);
      }
    } else if (ln === 'sSup') {
      // Superscript: <m:e> + <m:sup>
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      const sup = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'sup')[0] : child.querySelector('sup');
      parts.push(`${renderOmml(e)}<sup>${renderOmml(sup)}</sup>`);
    } else if (ln === 'sSub') {
      // Subscript: <m:e> + <m:sub>
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      const sub = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'sub')[0] : child.querySelector('sub');
      parts.push(`${renderOmml(e)}<sub>${renderOmml(sub)}</sub>`);
    } else if (ln === 'sSubSup') {
      // Sub-superscript: <m:e> + <m:sub> + <m:sup>
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      const sub = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'sub')[0] : child.querySelector('sub');
      const sup = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'sup')[0] : child.querySelector('sup');
      parts.push(`${renderOmml(e)}<sub>${renderOmml(sub)}</sub><sup>${renderOmml(sup)}</sup>`);
    } else if (ln === 'nary') {
      // N-ary operator (sum, integral, etc.): <m:naryPr> + <m:sub> + <m:sup> + <m:e>
      const naryPr = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'naryPr')[0] : child.querySelector('naryPr');
      const chr = naryPr?.getElementsByTagNameNS ? naryPr.getElementsByTagNameNS(NS_M, 'chr')[0] : naryPr?.querySelector('chr');
      const op = chr?.getAttribute('m:val') || chr?.getAttribute('val') || '\u222B'; // default integral
      const sub = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'sub')[0] : child.querySelector('sub');
      const sup = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'sup')[0] : child.querySelector('sup');
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      parts.push(`<span class="word-math-nary"><span class="word-math-op">${escapeHtml(op)}</span>`);
      if (sub) parts.push(`<sub>${renderOmml(sub)}</sub>`);
      if (sup) parts.push(`<sup>${renderOmml(sup)}</sup>`);
      parts.push(`${renderOmml(e)}</span>`);
    } else if (ln === 'd') {
      // Delimiters (parentheses, brackets, etc.)
      const dPr = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'dPr')[0] : child.querySelector('dPr');
      const begChr = dPr?.getElementsByTagNameNS ? dPr.getElementsByTagNameNS(NS_M, 'begChr')[0] : dPr?.querySelector('begChr');
      const endChr = dPr?.getElementsByTagNameNS ? dPr.getElementsByTagNameNS(NS_M, 'endChr')[0] : dPr?.querySelector('endChr');
      const open = begChr?.getAttribute('m:val') ?? begChr?.getAttribute('val') ?? '(';
      const close = endChr?.getAttribute('m:val') ?? endChr?.getAttribute('val') ?? ')';
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      parts.push(`${escapeHtml(open)}${renderOmml(e)}${escapeHtml(close)}`);
    } else if (ln === 'func') {
      // Function: <m:fName> + <m:e>
      const fName = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'fName')[0] : child.querySelector('fName');
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      parts.push(`${renderOmml(fName)}${renderOmml(e)}`);
    } else if (ln === 'eqArr') {
      // Equation array (multi-line)
      for (const eChild of child.children) {
        if (eChild.localName === 'e') parts.push(`<div>${renderOmml(eChild)}</div>`);
      }
    } else if (ln === 'limLow' || ln === 'limUpp') {
      // Limit: <m:e> with <m:lim> below/above
      const e = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'e')[0] : child.querySelector('e');
      const lim = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'lim')[0] : child.querySelector('lim');
      parts.push(`${renderOmml(e)}<sub>${renderOmml(lim)}</sub>`);
    } else if (ln === 'm') {
      // Matrix
      const rows = child.getElementsByTagNameNS ? child.getElementsByTagNameNS(NS_M, 'mr') : child.querySelectorAll('mr');
      parts.push('<span class="word-math-matrix">');
      for (const mr of rows) {
        parts.push('<span class="word-math-mrow">');
        const cells = mr.getElementsByTagNameNS ? mr.getElementsByTagNameNS(NS_M, 'e') : mr.querySelectorAll('e');
        for (const mc of cells) parts.push(`<span class="word-math-mcell">${renderOmml(mc)}</span>`);
        parts.push('</span>');
      }
      parts.push('</span>');
    } else if (ln === 'oMath') {
      parts.push(renderOmml(child));
    } else if (ln === 'oMathPara') {
      parts.push(`<div class="word-math-para">${renderOmml(child)}</div>`);
    } else if (ln === 'e' || ln === 'num' || ln === 'den' || ln === 'sub' || ln === 'sup' ||
               ln === 'fName' || ln === 'lim' || ln === 'deg') {
      // Container elements — recurse
      parts.push(renderOmml(child));
    } else if (ln === 'rPr' || ln === 'ctrlPr' || ln === 'naryPr' || ln === 'fPr' ||
               ln === 'dPr' || ln === 'radPr' || ln === 'sSubPr' || ln === 'sSupPr' ||
               ln === 'funcPr' || ln === 'limLowPr' || ln === 'limUppPr' || ln === 'mPr' ||
               ln === 'eqArrPr' || ln === 'sSubSupPr') {
      // Property elements — skip
    } else {
      // Unknown element — recurse
      parts.push(renderOmml(child));
    }
  }
  return parts.join('');
}

// ── Table rendering ──
function renderTable(tblEl, styles, relMap, imageData, numbering, listCounters) {
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
          // val="restart" — calculate rowspan by counting subsequent continuation rows
          if (vm === 'restart') {
            const allRows = dnAll(tblEl, NS_W, 'tr').filter(r => r.parentNode === tblEl);
            const curRowIdx = allRows.indexOf(tr);
            // Calculate grid column index (accounting for gridSpan in preceding cells)
            const curCells = Array.from(tr.children).filter(c => c.localName === 'tc');
            let gridCol = 0;
            for (const c of curCells) {
              if (c === tc) break;
              const cPr = dn(c, NS_W, 'tcPr');
              const gs = cPr ? dn(cPr, NS_W, 'gridSpan') : null;
              gridCol += gs ? (parseInt(getAttr(gs, 'val')) || 1) : 1;
            }
            let span = 1;
            for (let nr = curRowIdx + 1; nr < allRows.length; nr++) {
              const nextCells = Array.from(allRows[nr].children).filter(c => c.localName === 'tc');
              // Find cell at same grid column in next row
              let col = 0, nextTc = null;
              for (const c of nextCells) {
                if (col === gridCol) { nextTc = c; break; }
                const cPr = dn(c, NS_W, 'tcPr');
                const gs = cPr ? dn(cPr, NS_W, 'gridSpan') : null;
                col += gs ? (parseInt(getAttr(gs, 'val')) || 1) : 1;
                if (col > gridCol) break;
              }
              if (!nextTc) break;
              const nextTcPr = dn(nextTc, NS_W, 'tcPr');
              const nextVm = nextTcPr ? dn(nextTcPr, NS_W, 'vMerge') : null;
              if (nextVm) {
                const nextVal = getAttr(nextVm, 'val');
                if (!nextVal || nextVal === 'continue') { span++; continue; }
              }
              break;
            }
            if (span > 1) rowspan = ` rowspan="${span}"`;
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
        // Cell borders
        const tcBorders = dn(tcPr, NS_W, 'tcBorders');
        if (tcBorders) {
          for (const [side, cssProp] of [['top','border-top'],['bottom','border-bottom'],['left','border-left'],['right','border-right']]) {
            const bdr = dn(tcBorders, NS_W, side);
            if (bdr) {
              const bVal = getAttr(bdr, 'val');
              if (bVal && bVal !== 'nil' && bVal !== 'none') {
                const bSz = getAttr(bdr, 'sz');
                const bColor = getAttr(bdr, 'color');
                const width = bSz ? Math.max(1, Math.round(Number(bSz) / 8)) : 1;
                const color = bColor && bColor !== 'auto' ? `#${bColor}` : '#000';
                cellStyle.push(`${cssProp}:${width}px solid ${color}`);
              }
            }
          }
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
          html.push(renderParagraph(cellChild, styles, numbering || {}, relMap, imageData, listCounters || {}));
        } else if (cellChild.localName === 'tbl') {
          html.push(renderTable(cellChild, styles, relMap, imageData, numbering, listCounters));
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
      const docResult = renderDocBinary(arrayBuffer);
      resultHtml = typeof docResult === 'string' ? docResult : docResult.html;
      var docPageMargins = typeof docResult === 'object' ? docResult.pageMargins : null;
      // Handle async OLE chart decompression (deflate)
      if (docResult._oleChartAsync) {
        const removePlaceholder = () => {
          const ph = document.getElementById('word-ole-chart-placeholder');
          if (ph) ph.remove();
        };
        if (typeof DecompressionStream === 'undefined') {
          // Browser doesn't support DecompressionStream — remove placeholder
          setTimeout(removePlaceholder, 0);
        } else {
          try {
            const { raw } = docResult._oleChartAsync;
            const ds = new DecompressionStream('deflate-raw');
            const writer = ds.writable.getWriter();
            const reader = ds.readable.getReader();
            writer.write(raw);
            writer.close();
            const chunks = [];
            let done = false;
            const readAll = async () => {
              while (!done) {
                const { value, done: d } = await reader.read();
                if (d) { done = true; break; }
                chunks.push(value);
              }
              const total = chunks.reduce((s, c) => s + c.length, 0);
              const result = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) { result.set(c, off); off += c.length; }
              return new TextDecoder().decode(result);
            };
            readAll().then(xml => {
              const chartHtml = parseOdfChartXml(xml);
              if (chartHtml) {
                const placeholder = document.getElementById('word-ole-chart-placeholder');
                if (placeholder) {
                  placeholder.outerHTML = chartHtml;
                } else {
                  const pageEl = document.querySelector('.word-page');
                  if (pageEl) {
                    const tmp = document.createElement('div');
                    tmp.innerHTML = chartHtml;
                    pageEl.appendChild(tmp.firstElementChild || tmp);
                  }
                }
              } else {
                removePlaceholder();
              }
            }).catch(removePlaceholder);
          } catch { removePlaceholder(); }
        }
      }
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
      notice.textContent = t('viewer.wordDocNotice') || '.doc 格式預覽可能與原始排版略有差異，下載可查看完整格式。';
      docContainer.appendChild(notice);
    }
    const page = document.createElement('div');
    page.className = 'word-page';
    // Apply page margins from DOP if available
    if (docPageMargins) {
      page.style.paddingTop = docPageMargins.top + 'pt';
      page.style.paddingBottom = docPageMargins.bottom + 'pt';
      page.style.paddingLeft = docPageMargins.left + 'pt';
      page.style.paddingRight = docPageMargins.right + 'pt';
    }
    page.innerHTML = resultHtml;
    docContainer.appendChild(page);
    stageEl.appendChild(docContainer);
    if (loadingEl) loadingEl.remove();

    // Auto-scale fixed-width tables that overflow their container
    requestAnimationFrame(() => {
      const pageWidth = page.clientWidth - parseFloat(getComputedStyle(page).paddingLeft) - parseFloat(getComputedStyle(page).paddingRight);
      page.querySelectorAll('.word-tbl-fixed').forEach(tbl => {
        const tblWidth = tbl.scrollWidth;
        if (tblWidth > pageWidth && pageWidth > 0) {
          const scale = pageWidth / tblWidth;
          const wrap = tbl.closest('.word-tbl-wrap');
          if (wrap) {
            wrap.style.overflow = 'hidden';
            tbl.style.transformOrigin = 'top left';
            tbl.style.transform = `scale(${scale.toFixed(4)})`;
            // Compensate for the vertical space freed by scaling
            const tblHeight = tbl.offsetHeight;
            tbl.style.marginBottom = `-${(tblHeight * (1 - scale)).toFixed(0)}px`;
          }
        }
      });
    });

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

/**
 * Render a Word doc/docx file as a thumbnail preview for chat messages.
 * Only extracts the first ~10 paragraphs of plain text — lightweight, no full render.
 * @param {ArrayBuffer} buffer - file content
 * @returns {HTMLElement|null}
 */
export function renderWordThumbnail(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const MAX_PARAS = 10;
    const parts = [];

    const isDocx = bytes[0] === 0x50 && bytes[1] === 0x4B;
    const isOle2 = bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;

    if (isOle2) {
      // Extract plain text from .doc via piece table (lightweight, no formatting render)
      try {
        const ole2 = parseOLE2(buffer);
        const wordDoc = ole2.getStream('WordDocument');
        const fib = parseFIB(wordDoc);
        const tableStream = ole2.getStream(fib.tableName);
        const clx = fib.fibPair(33);
        const ptResult = parsePieceTable(wordDoc, tableStream, clx.fc, clx.lcb);
        const paras = ptResult.text.split('\r');
        let count = 0;
        for (const p of paras) {
          const clean = p.replace(/[\x00-\x1f]/g, '').trim();
          if (!clean) continue;
          parts.push(`<p style="margin:0 0 3pt 0">${escapeHtml(clean)}</p>`);
          if (++count >= MAX_PARAS) break;
        }
      } catch { return null; }
    } else if (isDocx) {
      // Extract text from .docx via ZIP → word/document.xml (store or deflate)
      try {
        const xml = extractDocxXml(bytes);
        if (!xml) return null;
        const paraRe = /<w:p[\s>][\s\S]*?<\/w:p>/g;
        let m, count = 0;
        while ((m = paraRe.exec(xml)) !== null && count < MAX_PARAS) {
          const texts = [];
          const tRe = /<w:t[^>]*>([^<]*)<\/w:t>/g;
          let tm;
          while ((tm = tRe.exec(m[0])) !== null) texts.push(tm[1]);
          const text = texts.join('');
          if (!text) continue;
          const isBold = m[0].includes('<w:b/>') || m[0].includes('<w:b ');
          const isLarge = m[0].includes('<w:pStyle w:val="Heading') || m[0].includes('<w:pStyle w:val="Title');
          let style = 'margin:0 0 3pt 0';
          if (isBold) style += ';font-weight:bold';
          if (isLarge) style += ';font-size:1.2em';
          parts.push(`<p style="${style}">${escapeHtml(text)}</p>`);
          count++;
        }
      } catch { return null; }
    }

    if (!parts.length) return null;

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:180px;height:120px;overflow:hidden;position:relative;background:#fff;border-radius:12px;';

    const inner = document.createElement('div');
    inner.style.cssText = 'transform-origin:top left;transform:scale(0.36);width:278%;padding:8pt 10pt;font-size:9pt;line-height:1.35;color:#1e293b;pointer-events:none;';
    inner.innerHTML = parts.join('');
    wrapper.appendChild(inner);

    // File type badge in bottom-right corner
    const badge = document.createElement('div');
    badge.style.cssText = 'position:absolute;bottom:4px;right:4px;background:rgba(37,99,235,0.9);color:#fff;font-size:9px;font-weight:600;padding:2px 5px;border-radius:4px;line-height:1.2;pointer-events:none;letter-spacing:0.5px;';
    const ext = isDocx ? 'DOCX' : 'DOC';
    badge.textContent = ext;
    wrapper.appendChild(badge);

    return wrapper;
  } catch {
    return null;
  }
}

/** Extract word/document.xml string from DOCX ZIP (sync, store-only) */
function extractDocxXml(bytes) {
  let eocdPos = bytes.length - 22;
  while (eocdPos > 0 && !(bytes[eocdPos]===0x50 && bytes[eocdPos+1]===0x4B && bytes[eocdPos+2]===0x05 && bytes[eocdPos+3]===0x06)) eocdPos--;
  if (eocdPos <= 0) return null;
  const cdOff = bytes[eocdPos+16]|(bytes[eocdPos+17]<<8)|(bytes[eocdPos+18]<<16)|(bytes[eocdPos+19]<<24);
  const numEntries = bytes[eocdPos+10]|(bytes[eocdPos+11]<<8);
  let p = cdOff;
  for (let i = 0; i < numEntries && p + 46 <= bytes.length; i++) {
    const compSize = bytes[p+20]|(bytes[p+21]<<8)|(bytes[p+22]<<16)|(bytes[p+23]<<24);
    const nameLen = bytes[p+28]|(bytes[p+29]<<8);
    const extraLen = bytes[p+30]|(bytes[p+31]<<8);
    const commentLen = bytes[p+32]|(bytes[p+33]<<8);
    const localOff = bytes[p+42]|(bytes[p+43]<<8)|(bytes[p+44]<<16)|(bytes[p+45]<<24);
    const method = bytes[p+10]|(bytes[p+11]<<8);
    const name = new TextDecoder().decode(bytes.slice(p+46, p+46+nameLen));
    if (name === 'word/document.xml') {
      const lnLen = bytes[localOff+26]|(bytes[localOff+27]<<8);
      const leLen = bytes[localOff+28]|(bytes[localOff+29]<<8);
      const dataStart = localOff + 30 + lnLen + leLen;
      if (method === 0) return new TextDecoder().decode(bytes.slice(dataStart, dataStart + compSize));
      return null; // deflate — can't sync decompress
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}
