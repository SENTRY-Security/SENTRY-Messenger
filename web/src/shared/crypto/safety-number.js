/**
 * Safety Number / Key Fingerprint — 帶外身份驗證機制。
 *
 * 參考 Signal Protocol 的 Safety Number 設計：
 * 將雙方的 (accountDigest, identityKey) 分別做迭代 SHA-256，
 * 產生 60 位數字指紋（12 組 × 5 位），供使用者面對面或透過可信管道比對。
 *
 * 若雙方各自計算出的 Safety Number 一致，表示沒有 MITM。
 */

const ITERATION_COUNT = 5200;
const FINGERPRINT_VERSION = new Uint8Array([0x00, 0x00]);

/**
 * 計算單方指紋塊（30 位數字）。
 * digest = SHA-256^5200( version || publicKey || stableId )
 * 取前 30 bytes，每 5 bytes → 5 位十進位數字。
 *
 * @param {Uint8Array} identityKey - Ed25519 公鑰 (32 bytes)
 * @param {string} stableId - 帳號的 accountDigest（hex string）
 * @returns {Promise<string>} 30 位數字
 */
async function computeFingerprintBlock(identityKey, stableId) {
  if (!(identityKey instanceof Uint8Array) || identityKey.length !== 32) {
    throw new Error('identityKey must be 32-byte Uint8Array');
  }
  if (!stableId || typeof stableId !== 'string') {
    throw new Error('stableId required');
  }

  const stableIdBytes = new TextEncoder().encode(stableId);

  // 初始輸入 = version(2) || identityKey(32) || stableId(variable)
  let hash = new Uint8Array([...FINGERPRINT_VERSION, ...identityKey, ...stableIdBytes]);

  for (let i = 0; i < ITERATION_COUNT; i++) {
    // 每次迭代: SHA-256( previous_hash || identityKey )
    const input = new Uint8Array(hash.length + identityKey.length);
    input.set(hash, 0);
    input.set(identityKey, hash.length);
    const buf = await crypto.subtle.digest('SHA-256', input);
    hash = new Uint8Array(buf);
  }

  // 取前 30 bytes → 6 組 × 5 bytes → 每組轉為 5 位十進位
  const digits = [];
  for (let i = 0; i < 6; i++) {
    const offset = i * 5;
    // 取 5 bytes 組成大數 mod 100000
    const value =
      ((hash[offset] & 0xff) * 2 ** 32 +
        (hash[offset + 1] & 0xff) * 2 ** 24 +
        (hash[offset + 2] & 0xff) * 2 ** 16 +
        (hash[offset + 3] & 0xff) * 2 ** 8 +
        (hash[offset + 4] & 0xff)) %
      100000;
    digits.push(String(value).padStart(5, '0'));
  }

  return digits.join('');
}

/**
 * 計算雙方的 Safety Number（60 位數字）。
 *
 * 排序規則：將兩方的 stableId 做字典序比較，
 * 較小的放前面，確保雙方算出相同結果。
 *
 * @param {object} local - { identityKey: Uint8Array, accountDigest: string }
 * @param {object} remote - { identityKey: Uint8Array, accountDigest: string }
 * @returns {Promise<string>} 60 位數字（12 組 × 5 位）
 */
export async function computeSafetyNumber(local, remote) {
  if (!local?.identityKey || !local?.accountDigest) {
    throw new Error('local identity required (identityKey + accountDigest)');
  }
  if (!remote?.identityKey || !remote?.accountDigest) {
    throw new Error('remote identity required (identityKey + accountDigest)');
  }

  const localBlock = await computeFingerprintBlock(local.identityKey, local.accountDigest);
  const remoteBlock = await computeFingerprintBlock(remote.identityKey, remote.accountDigest);

  // 字典序：較小的 accountDigest 放前面，保證雙方計算一致
  if (local.accountDigest < remote.accountDigest) {
    return localBlock + remoteBlock;
  } else if (local.accountDigest > remote.accountDigest) {
    return remoteBlock + localBlock;
  }
  // 同一帳號（理論上不會發生）→ 按 identityKey 排序
  const localHex = Array.from(local.identityKey).map((b) => b.toString(16).padStart(2, '0')).join('');
  const remoteHex = Array.from(remote.identityKey).map((b) => b.toString(16).padStart(2, '0')).join('');
  return localHex <= remoteHex ? localBlock + remoteBlock : remoteBlock + localBlock;
}

/**
 * 格式化 Safety Number 為易讀格式（12 組 × 5 位）。
 *
 * @param {string} safetyNumber - 60 位數字字串
 * @returns {string} 格式化後的字串，例如 "12345 67890 ..."
 */
export function formatSafetyNumber(safetyNumber) {
  if (!safetyNumber || safetyNumber.length !== 60) {
    throw new Error('safety number must be 60 digits');
  }
  const groups = [];
  for (let i = 0; i < 60; i += 5) {
    groups.push(safetyNumber.slice(i, i + 5));
  }
  return groups.join(' ');
}
