

import crypto from 'crypto';
import { aesCmac } from 'node-aes-cmac';

// --- Utilities ---
export function normalizeCtr(ctrHex) {
  const s = String(ctrHex || '')
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
  const right6 = s.length > 6 ? s.slice(-6) : s;
  return right6.padStart(6, '0');
}

function getEnvKM(which = 'NTAG424_KM') {
  const v = (process.env[which] || '').trim();
  if (!/^[0-9A-Fa-f]{32}$/.test(v)) {
    throw new Error(`${which} missing or invalid (expect 32 hex chars for 16B key)`);
  }
  return v.toUpperCase();
}

// HKDF-SHA256 → 16 bytes (Buffer)
function hkdf16(kmHex, uidHex, { salt, info }) {
  const km = Buffer.from(kmHex, 'hex');
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const prk = hmac(Buffer.from(salt || ''), km); // Extract
  const okm = hmac(prk, Buffer.from(`${info || 'ntag424-static-key'}:${uidHex}`, 'utf8')); // Expand(1)
  return okm.subarray(0, 16);
}

// EV2-style CMAC KDF (simplified): CMAC(KM, 0x01 || 'EV2-KDF' || UID || TAGID || kver)
function ev2cmac16(kmHex, { uidHex, tagidHex, kver }) {
  const parts = [Buffer.from([0x01]), Buffer.from('EV2-KDF')];
  if (uidHex) parts.push(Buffer.from(uidHex, 'hex'));
  if (tagidHex) parts.push(Buffer.from(String(tagidHex).replace(/-/g, ''), 'hex'));
  if (kver != null) parts.push(Buffer.from([Number(kver) & 0xff]));
  const msg = Buffer.concat(parts);
  const mac = aesCmac(Buffer.from(kmHex, 'hex'), msg, { returnAsBuffer: true });
  return Buffer.from(mac).subarray(0, 16);
}

function currentMode() {
  return String(process.env.NTAG424_KDF || 'HKDF').toUpperCase();
}

function defaultSalt() {
  return process.env.NTAG424_SALT || process.env.DOMAIN || 'sentry.red';
}

function defaultInfo() {
  return process.env.NTAG424_INFO || 'ntag424-static-key';
}

// --- Public API ---
/**
 * deriveTagKeyFromEnv – derive a 16-byte static key for a tag using ENV root key.
 * @param {object} p
 * @param {string} p.uidHex   7-byte UID as hex (uppercase/lowercase OK, no 0x)
 * @param {string} [p.tagidHex] UUID (with/without dashes), used in EV2 mode
 * @returns {Buffer} 16-byte key (Buffer)
 */
export function deriveTagKeyFromEnv({ uidHex, tagidHex } = {}) {
  const kmHex = getEnvKM('NTAG424_KM');
  const uid = String(uidHex || '').toUpperCase();
  const mode = currentMode();
  const kver = process.env.NTAG424_KVER ? Number(process.env.NTAG424_KVER) : undefined;

  if (mode === 'EV2') {
    return ev2cmac16(kmHex, { uidHex: uid, tagidHex, kver });
  }
  return hkdf16(kmHex, uid, { salt: defaultSalt(), info: defaultInfo() });
}

/**
 * deriveTagKeyWithFallback – returns { current, legacy? } Buffers.
 * Use current; if verification fails upstream, try legacy if present.
 */
export function deriveTagKeyWithFallback({ uidHex, tagidHex } = {}) {
  const current = deriveTagKeyFromEnv({ uidHex, tagidHex });
  const oldHex = (process.env.NTAG424_KM_OLD || '').trim();
  if (/^[0-9A-Fa-f]{32}$/.test(oldHex)) {
    const uid = String(uidHex || '').toUpperCase();
    const mode = currentMode();
    const kver = process.env.NTAG424_KVER ? Number(process.env.NTAG424_KVER) : undefined;
    const legacy = (mode === 'EV2')
      ? ev2cmac16(oldHex.toUpperCase(), { uidHex: uid, tagidHex, kver })
      : hkdf16(oldHex.toUpperCase(), uid, { salt: defaultSalt(), info: defaultInfo() });
    return { current, legacy };
  }
  return { current };
}

/**
 * deriveSdmFileReadKey – alias: SDM File Read Key uses the same static key (16B).
 */
export function deriveSdmFileReadKey({ uidHex, tagidHex } = {}) {
  return deriveTagKeyFromEnv({ uidHex, tagidHex });
}

/**
 * keyToHex – helper to print Buffer key as upper hex.
 */
export function keyToHex(buf) {
  return Buffer.isBuffer(buf) ? buf.toString('hex').toUpperCase() : String(buf || '').toUpperCase();
}

/**
 * deriveSlotKeyFromEnv – derive a per-slot static key. Default slot 0.
 * For HKDF mode: use info="ntag424-slot-<slotNo>".
 * For EV2 mode: falls back to deriveTagKeyFromEnv (slot concept not applicable).
 */
export function deriveSlotKeyFromEnv({ uidHex, tagidHex, slotNo = 0 } = {}) {
  const kmHex = getEnvKM('NTAG424_KM');
  const uid = String(uidHex || '').toUpperCase();
  const mode = currentMode();
  const kver = process.env.NTAG424_KVER ? Number(process.env.NTAG424_KVER) : undefined;
  if (mode === 'EV2') {
    return ev2cmac16(kmHex, { uidHex: uid, tagidHex, kver });
  }
  const salt = defaultSalt();
  const info = `ntag424-slot-${Number(slotNo) || 0}`;
  return hkdf16(kmHex, uid, { salt, info });
}