import { aesCmac } from 'node-aes-cmac';
import { normalizeCtr, deriveSdmFileReadKey, deriveTagKeyWithFallback, keyToHex, deriveSlotKeyFromEnv } from './ntag424-kdf.js';

function hexToBuf(h) {
  if (!h) return Buffer.alloc(0);
  const s = String(h).replace(/[^0-9a-f]/gi, '');
  return Buffer.from(s, 'hex');
}

function toLSB3(bufOrHex) {
  const b = hexToBuf(bufOrHex);
  if (b.length !== 3) throw new Error('toLSB3: counter must be 3 bytes');
  return Buffer.from(b).reverse();
}

// SV2 = 0x3CC300010080 || UID(7) || Ctr(3, LSB)
function deriveKSesSDMFileReadMAC(sdmFileReadKeyHex, uidHex, ctrHex) {
  const K = hexToBuf(sdmFileReadKeyHex);
  const UID = hexToBuf(uidHex);
  if (UID.length !== 7) throw new Error('deriveKSesSDMFileReadMAC: UID must be 7 bytes');
  const ctrLSB = toLSB3(normalizeCtr(ctrHex));
  const SV2 = Buffer.concat([Buffer.from('3CC300010080', 'hex'), UID, ctrLSB]);
  return aesCmac(K, SV2, { returnAsBuffer: true }); // 16-byte Buffer
}

function MACt16to8(mac16Buf) {
  const out = Buffer.alloc(8);
  for (let i = 1, j = 0; i < mac16Buf.length && j < 8; i += 2, j += 1) {
    out[j] = mac16Buf[i];
  }
  return out;
}

/**
 * computeSdmCmac – calculate SDM MAC (8 bytes) with SDM File Read Key.
 * NXP NTAG 424 DNA SDM uses CMAC(Ksdm, UID||CTR) and takes 8 bytes (right-trim/left? vendors differ).
 * In most public implementations the MAC is the full 16B CMAC and SDM URL carries 8B (16 hex) – we
 * will compare by taking the first 8 bytes of the CMAC output, which matches common readers.
 *
 * @param {object} p
 * @param {string} p.uidHex 7-byte UID hex (no 0x)
 * @param {string} p.ctrHex 3-byte counter hex (6 hex chars)
 * @param {string} p.sdmFileReadKeyHex 16-byte key hex
 * @param {Buffer|string} [p.cmacInput] optional data to CMAC
 * @returns {string} expected cmac hex (16 uppercase hex chars)
 */
export function computeSdmCmac({ uidHex, ctrHex, sdmFileReadKeyHex, cmacInput = '' }) {
  const Kses = deriveKSesSDMFileReadMAC(sdmFileReadKeyHex, uidHex, ctrHex);
  const data = Buffer.isBuffer(cmacInput) ? cmacInput : Buffer.from(String(cmacInput), 'utf8');
  const full = aesCmac(Kses, data, { returnAsBuffer: true });
  return MACt16to8(full).toString('hex').toUpperCase();
}

/**
 * verifySdmCmacWithKey – verify using provided SDM key
 */
export function verifySdmCmacWithKey({ uidHex, ctrHex, cmacHex, sdmFileReadKeyHex, cmacInput }) {
  const expected = computeSdmCmac({ uidHex, ctrHex, sdmFileReadKeyHex, cmacInput });
  const got = String(cmacHex || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return { ok: got === expected, expected, got };
}

/**
 * verifySdmCmacFromEnv – derive SDM key from ENV root key, then verify
 */
export function verifySdmCmacFromEnv({ uidHex, ctrHex, cmacHex, tagidHex } = {}) {
  const keyBuf = deriveSdmFileReadKey({ uidHex, tagidHex });
  return verifySdmCmacWithKey({ uidHex, ctrHex, cmacHex, sdmFileReadKeyHex: keyToHex(keyBuf) });
}

/**
 * verifySdmCmacFromEnvWithFallback – same as above but also tries NTAG424_KM_OLD
 * Returns { ok, expected, got, used: 'current'|'legacy' }
 */
export function verifySdmCmacFromEnvWithFallback({ uidHex, ctrHex, cmacHex, tagidHex } = {}) {
  const { current, legacy } = deriveTagKeyWithFallback({ uidHex, tagidHex });
  let res = verifySdmCmacWithKey({ uidHex, ctrHex, cmacHex, sdmFileReadKeyHex: keyToHex(current) });
  if (res.ok || !legacy) return { ...res, used: 'current' };
  const resOld = verifySdmCmacWithKey({ uidHex, ctrHex, cmacHex, sdmFileReadKeyHex: keyToHex(legacy) });
  return { ...resOld, used: resOld.ok ? 'legacy' : 'current' };
}

/**
 * verifySdmCmacFromEnvTrySlot0 – fallback to slot-0 HKDF info if static-info check fails.
 */
export function verifySdmCmacFromEnvTrySlot0({ uidHex, ctrHex, cmacHex, tagidHex } = {}) {
  const resStatic = verifySdmCmacFromEnv({ uidHex, ctrHex, cmacHex, tagidHex });
  if (resStatic.ok) return { ...resStatic, used: 'static' };
  const keyBuf = deriveSlotKeyFromEnv({ uidHex, tagidHex, slotNo: 0 });
  const second = verifySdmCmacWithKey({ uidHex, ctrHex, cmacHex, sdmFileReadKeyHex: keyToHex(keyBuf) });
  return { ...second, used: second.ok ? 'slot0' : 'static' };
}