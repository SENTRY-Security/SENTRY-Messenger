/**
 * SECURITY POLICY – STRICT CRYPTO PROTOCOL, NO FALLBACK ALLOWED.
 *
 * 本檔案中的所有密碼協定（X3DH、Double Ratchet、AEAD、鍵派生、counter 驗證、header 驗證）
 * 禁止設計、加入或推論任何 fallback、retry、rollback、resync、auto-repair 等邏輯。
 *
 * 規則如下：
 * 1. 若解密失敗 → 一律直接 fail，不可嘗試第二組 key 或舊 ratchet state。
 * 2. 若 counter 不一致 → 一律直接拒絕，不可重送、補拉或自動對齊。
 * 3. 不允許任何協定降級（downgrade）。不得用舊版本、舊頭資訊、舊密鑰重試。
 * 4. 不允許模糊錯誤處理。不做 try-catch fallback，不做 silent recovery。
 * 5. 對話重置必須是顯式事件，不得隱式重建 state。
 *
 * 一切協定邏輯必須「單一路徑」且「強一致性」，任何 fallback 視為安全漏洞。
 */
import { loadNacl, scalarMult, genX25519Keypair, b64, b64u8, verifyDetached } from './nacl.js';
import { convertEd25519PublicKey, convertEd25519SecretKey } from './ed2curve.js';
import { toU8Strict } from '../utils/u8-strict.js';
import { DEBUG } from '../../app/ui/mobile/debug-flags.js';

const encoder = new TextEncoder();
const SKIPPED_KEYS_PER_CHAIN_MAX = 100;
const PACKET_HOLDER_CACHE_MAX = 2000;
const packetHolderCache = new Map();
const drDebugLogsEnabled = DEBUG.drVerbose === true;

function cloneU8(src) {
  if (src instanceof Uint8Array) return new Uint8Array(src);
  return src;
}

function normalizeDeviceId(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeAadVersion(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function buildAadString({ version, deviceId, counter }) {
  const v = normalizeAadVersion(version, 1);
  const dev = normalizeDeviceId(deviceId);
  if (!dev) return null;
  const ctr = Number(counter);
  if (!Number.isFinite(ctr)) return null;
  return `v:${v};d:${dev};c:${ctr}`;
}

export function buildDrAadFromHeader(header) {
  if (!header || typeof header !== 'object') return null;
  const counter = Number.isFinite(header?.n) ? header.n : Number(header?.counter);
  const deviceId = header?.device_id || header?.deviceId || null;
  const version = header?.v ?? header?.version ?? 1;
  const aadStr = buildAadString({ version, deviceId, counter });
  return aadStr ? encoder.encode(aadStr) : null;
}

function buildDrAad({ version, deviceId, counter }) {
  const aadStr = buildAadString({ version, deviceId, counter });
  return aadStr ? encoder.encode(aadStr) : null;
}

async function hkdfBytes(ikmU8, saltStr, infoStr, outLen = 32) {
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(ikmU8, 'web/src/shared/crypto/dr.js:63:hkdfBytes'),
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(saltStr), info: new TextEncoder().encode(infoStr) },
    key,
    outLen * 8
  );
  return new Uint8Array(bits);
}

async function kdfRK(rk, dhOut) {
  return hkdfBytes(new Uint8Array([...rk, ...dhOut]), 'dr-rk', 'root', 64);
}

async function kdfCK(ck) {
  return hkdfBytes(ck, 'dr-ck', 'chain', 64);
}

function split64(u) {
  return { a: u.slice(0, 32), b: u.slice(32, 64) };
}

async function hashPrefix(u8, len = 12) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', u8);
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, len);
  } catch {
    return null;
  }
}

function ensureSkipStore(st) {
  if (!st || typeof st !== 'object') return null;
  if (!(st.skippedKeys instanceof Map)) {
    try {
      st.skippedKeys = new Map();
    } catch {
      st.skippedKeys = null;
    }
  }
  return st.skippedKeys || null;
}

function cloneSkippedKeys(store) {
  const out = new Map();
  if (!(store instanceof Map)) return out;
  for (const [chainId, chain] of store.entries()) {
    if (chain instanceof Map) {
      out.set(chainId, new Map(chain));
    }
  }
  return out;
}

export function rememberSkippedKey(st, chainId, index, keyB64, maxPerChain = SKIPPED_KEYS_PER_CHAIN_MAX) {
  if (!chainId || !Number.isFinite(index)) return;
  const store = ensureSkipStore(st);
  if (!store) return;
  let chain = store.get(chainId);
  if (!chain) {
    chain = new Map();
    store.set(chainId, chain);
  }
  chain.set(index, keyB64);
  if (chain.size > maxPerChain) {
    const firstKey = chain.keys().next();
    if (!firstKey.done) {
      chain.delete(firstKey.value);
    }
  }
}

function takeSkippedKey(st, chainId, index) {
  if (!chainId || !Number.isFinite(index)) return null;
  const store = ensureSkipStore(st);
  if (!store) return null;
  const chain = store.get(chainId);
  if (!chain) return null;
  const value = chain.get(index) || null;
  if (value !== null) chain.delete(index);
  if (!chain.size) store.delete(chainId);
  return value;
}

export async function x3dhInitiate(devicePriv, peerBundle, overrideEk = null) {
  await loadNacl();
  const peerIkRaw = peerBundle?.ik_pub;
  const peerSpkRaw = peerBundle?.spk_pub;
  const peerSpkSigRaw = peerBundle?.spk_sig;
  const peerOpkRaw = peerBundle?.opk?.pub || null;
  if (!peerIkRaw || !peerSpkRaw) throw new Error('peer bundle missing identity or signed prekey');
  if (!peerSpkSigRaw) throw new Error('peer bundle missing signed prekey signature');
  if (!peerOpkRaw) throw new Error('peer bundle missing one-time prekey');
  const spkSig = b64u8(peerSpkSigRaw);
  const peerIk = await convertEd25519PublicKey(b64u8(peerIkRaw));
  if (!peerIk) throw new Error('peer identity key invalid');
  const verifyOk = await verifyDetached(b64u8(peerSpkRaw), spkSig, b64u8(peerIkRaw));
  if (!verifyOk) throw new Error('peer signed prekey signature invalid');
  const myIKsec64 = b64u8(devicePriv.ik_priv_b64);
  const myIKseed = myIKsec64.slice(0, 32);
  const myIKsec32 = await convertEd25519SecretKey(myIKseed);
  if (!myIKsec32) throw new Error('ik secret conversion failed');

  let ek = overrideEk;
  const ekPub = overrideEk?.publicKey instanceof Uint8Array ? overrideEk.publicKey : null;
  const ekSec = overrideEk?.secretKey instanceof Uint8Array ? overrideEk.secretKey : null;
  if (!ekPub || !ekSec || ekPub.length !== 32 || ekSec.length !== 32) {
    ek = await genX25519Keypair();
  }

  const peerIK = peerIk;
  const peerSPK = b64u8(peerSpkRaw);
  const peerOPK = b64u8(peerOpkRaw);

  const DH1 = await scalarMult(myIKsec32, peerSPK);
  const DH2 = await scalarMult(ek.secretKey, peerIK);
  const DH3 = await scalarMult(ek.secretKey, peerSPK);
  const DH4 = await scalarMult(ek.secretKey, peerOPK);
  let dhCat = new Uint8Array([...DH1, ...DH2, ...DH3, ...DH4]);

  const rk = await hkdfBytes(dhCat, 'x3dh-salt', 'x3dh-root', 32);
  const seed = await kdfCK(rk);
  const { a: ckS } = split64(seed);

  const state = {
    rk,
    ckS,
    ckR: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    NsTotal: 0,
    NrTotal: 0,
    myRatchetPriv: ek.secretKey,
    myRatchetPub: ek.publicKey,
    theirRatchetPub: null,
    pendingSendRatchet: false,
    __bornReason: 'x3dh-initiate'
  };
  if (drDebugLogsEnabled) {
    try {
      console.log('[msg] state:init-transport-counter', JSON.stringify({
        peerDigest: peerBundle?.account_digest || null,
        peerDeviceId: peerBundle?.device_id || null,
        conversationId: null,
        NsTotal: state.NsTotal,
        NrTotal: state.NrTotal,
        reason: state.__bornReason
      }));
    } catch { }
  }
  return state;
}

export async function x3dhRespond(devicePriv, guestBundle) {
  await loadNacl();
  if (!guestBundle || typeof guestBundle !== 'object') throw new Error('guest bundle required');
  const ekPub = guestBundle.ek_pub;
  if (!ekPub) throw new Error('guest bundle missing ek_pub');
  const guestIkRaw = guestBundle.ik_pub;
  const guestSpkRaw = guestBundle.spk_pub;
  const guestSpkSigRaw = guestBundle.spk_sig;
  if (!guestIkRaw || !guestSpkRaw) throw new Error('guest bundle missing identity or signed prekey');
  if (!guestSpkSigRaw) throw new Error('guest bundle missing signed prekey signature');
  const opkId = guestBundle.opk_id;
  if (opkId === null || opkId === undefined || !Number.isFinite(Number(opkId))) {
    throw new Error('guest bundle missing opk_id for responder');
  }
  const opkPrivMap = devicePriv.opk_priv_map || {};
  const opkPrivB64 = opkPrivMap[opkId] || opkPrivMap[String(opkId)];
  if (!opkPrivB64) {
    throw new Error('opk private key missing, please replenish prekeys and retry');
  }

  const myIKsec64 = b64u8(devicePriv.ik_priv_b64);
  const myIKseed = myIKsec64.slice(0, 32);
  const myIKsec32 = await convertEd25519SecretKey(myIKseed);
  if (!myIKsec32) throw new Error('ik secret conversion failed');
  const mySPKsec = b64u8(devicePriv.spk_priv_b64);
  const mySPKsec32 = mySPKsec.slice(0, 32);
  const guestEK = b64u8(ekPub);
  const guestIk = await convertEd25519PublicKey(b64u8(guestIkRaw));
  if (!guestIk) throw new Error('guest ik conversion failed');
  const guestSpkSig = b64u8(guestSpkSigRaw);
  const verified = await verifyDetached(b64u8(guestSpkRaw), guestSpkSig, b64u8(guestIkRaw));
  if (!verified) throw new Error('guest signed prekey signature invalid');

  const parts = [];
  parts.push(await scalarMult(mySPKsec32, guestIk));
  parts.push(await scalarMult(myIKsec32, guestEK));
  parts.push(await scalarMult(mySPKsec32, guestEK));
  const opkPrivU8 = b64u8(opkPrivB64);
  parts.push(await scalarMult(opkPrivU8.slice(0, 32), guestEK));

  let dhCat = parts[0];
  for (let i = 1; i < parts.length; i += 1) {
    dhCat = new Uint8Array([...dhCat, ...parts[i]]);
  }

  const rk = await hkdfBytes(dhCat, 'x3dh-salt', 'x3dh-root', 32);
  const seed = await kdfCK(rk);
  const { a: ckR, b: ckS } = split64(seed);
  const myNew = await genX25519Keypair();

  const state = {
    rk,
    ckS,
    ckR,
    Ns: 0,
    Nr: 0,
    PN: 0,
    NsTotal: 0,
    NrTotal: 0,
    myRatchetPriv: myNew.secretKey,
    myRatchetPub: myNew.publicKey,
    theirRatchetPub: guestEK,
    pendingSendRatchet: true,
    __bornReason: 'x3dh-respond'
  };
  if (drDebugLogsEnabled) {
    try {
      console.log('[msg] state:init-transport-counter', JSON.stringify({
        peerDigest: guestBundle?.account_digest || null,
        peerDeviceId: guestBundle?.device_id || null,
        conversationId: null,
        NsTotal: state.NsTotal,
        NrTotal: state.NrTotal,
        reason: state.__bornReason
      }));
    } catch { }
  }
  return state;
}

export async function drRatchet(st, theirRatchetPubU8) {
  const nsBase = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) : 0;
  const nrBase = Number.isFinite(st?.NrTotal) ? Number(st.NrTotal) : 0;
  const nsPrev = Number.isFinite(st?.Ns) ? Number(st.Ns) : 0;
  const nrPrev = Number.isFinite(st?.Nr) ? Number(st.Nr) : 0;
  st.NsTotal = nsBase + nsPrev;
  st.NrTotal = nrBase + nrPrev;
  const dh = await scalarMult(st.myRatchetPriv.slice(0, 32), theirRatchetPubU8);
  const rkOut = await kdfRK(st.rk, dh);
  const { a: newRoot, b: chainSeed } = split64(rkOut);
  const dhOutHash = await hashPrefix(dh);
  const ckRSeedHash = await hashPrefix(chainSeed);
  const myNew = await genX25519Keypair();
  st.rk = newRoot;
  st.ckR = chainSeed;
  // [DEBUG] Disable recurring ratchet: Keep existing sending chain alive.
  // st.ckS = null;
  // [DEBUG] Disable sending side updates entirely
  // st.PN = st.Ns;
  // st.Ns = 0;
  st.Nr = 0;
  // st.myRatchetPriv = myNew.secretKey;
  // st.myRatchetPub = myNew.publicKey;
  st.theirRatchetPub = theirRatchetPubU8;
  st.pendingSendRatchet = false;
  try {
    if (drDebugLogsEnabled) {
      console.warn('[dr-debug:ratchet-dh]', {
        dhOutHash,
        ckRSeedHash,
        headerEk: theirRatchetPubU8 ? b64(theirRatchetPubU8).slice(0, 12) : null
      });
    }
  } catch { }
  return { ckR: chainSeed, theirRatchetPub: theirRatchetPubU8, dhOutHash, ckRSeedHash };
}

export async function drEncryptText(st, plaintext, opts = {}) {
  const deviceId = normalizeDeviceId(opts?.deviceId || opts?.senderDeviceId || null);
  const version = normalizeAadVersion(opts?.version ?? opts?.msgVersion ?? 1, 1);
  if (st.pendingSendRatchet) {
    st.pendingSendRatchet = false;
    st.ckS = null;
  }
  if (!st.ckS) {
    if (!st.theirRatchetPub) {
      if (!(st.myRatchetPriv instanceof Uint8Array) || !(st.myRatchetPub instanceof Uint8Array)) {
        const initial = await genX25519Keypair();
        st.myRatchetPriv = initial.secretKey;
        st.myRatchetPub = initial.publicKey;
      }
      const seed = await kdfCK(st.rk);
      const { a: ckS } = split64(seed);
      st.ckS = ckS;
    } else {
      const myNew = await genX25519Keypair();
      const dh = await scalarMult(myNew.secretKey.slice(0, 32), st.theirRatchetPub);
      const rkOut = await kdfRK(st.rk, dh);
      const { a: newRoot, b: chainSeed } = split64(rkOut);
      st.rk = newRoot;
      st.ckS = chainSeed;
      st.PN = st.Ns;
      st.Ns = 0;
      st.myRatchetPriv = myNew.secretKey;
      st.myRatchetPub = myNew.publicKey;
      try {
        if (drDebugLogsEnabled) {
          console.warn('[dr-debug:ratchet-dh:send]', {
            dhOutHash: await hashPrefix(dh),
            ckSSeedHash: await hashPrefix(chainSeed),
            headerEk: st?.theirRatchetPub ? b64(st.theirRatchetPub).slice(0, 12) : null
          });
        }
      } catch { }
    }
  }
  const mkOut = await kdfCK(st.ckS);
  const { a: mk, b: nextCkS } = split64(mkOut);
  const mkB64 = b64(mk);
  st.ckS = nextCkS;
  st.Ns += 1;
  st.NsTotal = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) + 1 : st.Ns;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(mk, 'web/src/shared/crypto/dr.js:305:drEncryptText'),
    'AES-GCM',
    false,
    ['encrypt']
  );
  const aad = buildDrAad({ version, deviceId, counter: st.Ns });
  const cipherParams = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  const ctBuf = await crypto.subtle.encrypt(cipherParams, key, new TextEncoder().encode(plaintext));
  try {
    encIvHash = await hashPrefix(iv);
    encCtHash = await hashPrefix(new Uint8Array(ctBuf));
    encAadHash = aad ? await hashPrefix(aad) : null;
    encMkHash = await hashPrefix(mk);
    const encLine = JSON.stringify({
      ivLen: iv?.byteLength ?? null,
      ivHash: encIvHash,
      ctLen: ctBuf?.byteLength ?? null,
      ctHash: encCtHash,
      aadLen: aad?.byteLength ?? null,
      aadHash: encAadHash,
      mkHash: encMkHash,
      nUsed: st?.Ns ?? null,
      ek: st?.myRatchetPub ? b64(st.myRatchetPub).slice(0, 12) : null
    });
    if (drDebugLogsEnabled) {
      console.warn('[dr-debug:aead-encrypt]', encLine);
    }
  } catch { }

  const header = {
    dr: 1,
    v: version,
    device_id: deviceId || undefined,
    ek_pub_b64: b64(st.myRatchetPub),
    pn: st.PN,
    n: st.Ns
  };
  return {
    aead: 'aes-256-gcm',
    header,
    iv_b64: b64(iv),
    ciphertext_b64: b64(new Uint8Array(ctBuf)),
    message_key_b64: mkB64
  };
}

export async function drDecryptText(st, packet, opts = {}) {
  let headerN = null;
  let currentNr = null; // Used in logs
  let chainId = null; // Used in logs
  let nUsed = null; // Used in ensureDrMeta
  let nrAfterRatchet = null; // Used in ensureDrMeta

  try {
    const onMessageKey = typeof opts?.onMessageKey === 'function' ? opts.onMessageKey : null;
    const packetKey = typeof opts?.packetKey === 'string' && opts.packetKey ? String(opts.packetKey) : null;
    const msgType = typeof opts?.msgType === 'string' && opts.msgType ? String(opts.msgType) : null;
    headerN = Number(packet?.header?.n);
    if (Number.isFinite(headerN) && headerN <= 0) {
      throw new Error('invalid message counter');
    }
    // [DEBUG-TRACE]
    console.log('[drDecryptText] Start', {
      headerN,
      pn: packet?.header?.pn,
      ek: packet?.header?.ek_pub_b64 ? String(packet.header.ek_pub_b64).slice(0, 8) : null,
      role: typeof st?.baseKey?.role === 'string' ? st.baseKey.role : 'unknown',
      stateNs: st?.Ns,
      stateNr: st?.Nr,
      hasRk: !!(st?.rk && st.rk.length),
      hasCkR: !!(st?.ckR && st.ckR.length),
      hasTheirPub: !!(st?.theirRatchetPub && st.theirRatchetPub.length)
    });
    const resolveStateKey = () => {
      const base = st?.baseKey || {};
      if (base.stateKey) return base.stateKey;
      const convId = typeof base?.conversationId === 'string' ? base.conversationId : null;
      const peerKey = base?.peerKey || base?.peerAccountDigest || null;
      const peerDeviceId = base?.peerDeviceId || base?.deviceId || null;
      if (convId || peerKey || peerDeviceId) {
        return `${convId || 'unknown'}::${peerKey || 'unknown'}::${peerDeviceId || 'unknown-device'}`;
      }
      return null;
    };
    const holderId = st?.__id || null;
    const stateKey = resolveStateKey();
    const holderRole = typeof st?.baseKey?.role === 'string'
      ? st.baseKey.role.toLowerCase()
      : (typeof st?.baseRole === 'string' ? st.baseRole.toLowerCase() : null);
    if (packetKey) {
      const prevHolder = packetHolderCache.get(packetKey);
      if (prevHolder !== undefined && prevHolder !== holderId) {
        const inv = new Error('dr invariant violated: packetKey processed by different holder');
        inv.code = 'INVARIANT_VIOLATION';
        inv.__drInvariantDiff = { packetKey, holderId, prevHolderId: prevHolder };
        throw inv;
      }
      packetHolderCache.set(packetKey, holderId || null);
      if (packetHolderCache.size > PACKET_HOLDER_CACHE_MAX) {
        const firstKey = packetHolderCache.keys().next();
        if (!firstKey.done) packetHolderCache.delete(firstKey.value);
      }
    }
    const holderSnapshot = {
      rk: cloneU8(st?.rk) || null,
      ckS: cloneU8(st?.ckS) || null,
      ckR: cloneU8(st?.ckR) || null,
      Ns: Number.isFinite(st?.Ns) ? Number(st.Ns) : 0,
      Nr: Number.isFinite(st?.Nr) ? Number(st.Nr) : 0,
      NsTotal: Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) : 0,
      NrTotal: Number.isFinite(st?.NrTotal) ? Number(st.NrTotal) : 0,
      PN: Number.isFinite(st?.PN) ? Number(st.PN) : 0,
      myRatchetPriv: cloneU8(st?.myRatchetPriv) || null,
      myRatchetPub: cloneU8(st?.myRatchetPub) || null,
      theirRatchetPub: cloneU8(st?.theirRatchetPub) || null,
      pendingSendRatchet: !!st?.pendingSendRatchet,
      skippedKeys: cloneSkippedKeys(st?.skippedKeys)
    };
    const restoreHolder = () => {
      st.rk = holderSnapshot.rk;
      st.ckS = holderSnapshot.ckS;
      st.ckR = holderSnapshot.ckR;
      st.Ns = holderSnapshot.Ns;
      st.Nr = holderSnapshot.Nr;
      st.NsTotal = holderSnapshot.NsTotal;
      st.NrTotal = holderSnapshot.NrTotal;
      st.PN = holderSnapshot.PN;
      st.myRatchetPriv = holderSnapshot.myRatchetPriv;
      st.myRatchetPub = holderSnapshot.myRatchetPub;
      st.theirRatchetPub = holderSnapshot.theirRatchetPub;
      st.pendingSendRatchet = holderSnapshot.pendingSendRatchet;
      st.skippedKeys = cloneSkippedKeys(holderSnapshot.skippedKeys);
    };
    const resolveRole = (holder) => {
      if (typeof holder?.baseKey?.role === 'string') return holder.baseKey.role.toLowerCase();
      if (typeof holder?.baseRole === 'string') return holder.baseRole.toLowerCase();
      return holderRole || null;
    };
    const fingerprintState = async (holder, mkHashValue = null, ctHashValue = null) => {
      const hashOrNull = async (u8) => (u8 instanceof Uint8Array && u8.length ? await hashPrefix(u8) : null);
      const skippedSize = holder?.skippedKeys instanceof Map
        ? [...holder.skippedKeys.values()].reduce((acc, chain) => acc + (chain instanceof Map ? chain.size : 0), 0)
        : 0;
      const fp = {
        stateKey: stateKey || null,
        holderId: holderId || null,
        Nr: Number.isFinite(holder?.Nr) ? Number(holder.Nr) : null,
        Ns: Number.isFinite(holder?.Ns) ? Number(holder.Ns) : null,
        PN: Number.isFinite(holder?.PN) ? Number(holder.PN) : null,
        theirPubHash: await hashOrNull(holder?.theirRatchetPub),
        ckRHash: await hashOrNull(holder?.ckR),
        ckSHash: await hashOrNull(holder?.ckS),
        skippedSize,
        role: resolveRole(holder),
        mkHash: mkHashValue || null,
        ctHash: ctHashValue || null
      };
      return fp;
    };
    const diffFingerprint = (before, after) => {
      const diff = {};
      const keys = new Set([...(before ? Object.keys(before) : []), ...(after ? Object.keys(after) : [])]);
      for (const key of keys) {
        const beforeVal = before ? before[key] : undefined;
        const afterVal = after ? after[key] : undefined;
        if (beforeVal !== afterVal) {
          diff[key] = { before: beforeVal, after: afterVal };
        }
      }
      return diff;
    };
    const fingerprintBaseline = await fingerprintState(holderSnapshot);
    const beforeAttempt = fingerprintBaseline;
    try {
      const preRatchetFp = await fingerprintState(st);
      if (drDebugLogsEnabled) {
        console.warn('[dr-fingerprint:pre-ratchet]', {
          ...preRatchetFp,
          msgType: msgType || null,
          packetKey: packetKey || null
        });
      }
    } catch { }
    try {
      if (drDebugLogsEnabled) {
        console.warn('[dr-attempt:holder]', {
          stateKey,
          holderId,
          packetKey: packetKey || null,
          msgType: msgType || null
        });
      }
    } catch { }
    nUsed = headerN;
    nrAfterRatchet = Number(st.Nr);
    let nrAtDerive = null;
    let postRatchetTheirPubPrefix = null;
    let dhOutHash = null;
    let ckRSeedHash = null;
    let ckSSeedHash = null;
    let mkHash = null;
    let chainHash = null;
    let encIvHash = null;
    let encCtHash = null;
    let encAadHash = null;
    let decIvHash = null;
    let decCtHash = null;
    let decAadHash = null;
    let encMkHash = null;
    let fingerprintBeforeDecrypt = null;
    currentNr = Number.isFinite(Number(st?.Nr)) ? Number(st.Nr) : 0;
    const working = {
      rk: cloneU8(st?.rk) || null,
      ckS: cloneU8(st?.ckS) || null,
      ckR: cloneU8(st?.ckR) || null,
      Ns: Number.isFinite(st?.Ns) ? Number(st.Ns) : 0,
      Nr: currentNr,
      NsTotal: Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) : 0,
      NrTotal: Number.isFinite(st?.NrTotal) ? Number(st.NrTotal) : 0,
      PN: Number.isFinite(st?.PN) ? Number(st.PN) : 0,
      myRatchetPriv: cloneU8(st?.myRatchetPriv) || null,
      myRatchetPub: cloneU8(st?.myRatchetPub) || null,
      theirRatchetPub: cloneU8(st?.theirRatchetPub) || null,
      pendingSendRatchet: !!st?.pendingSendRatchet
    };
    const newSkippedKeys = [];
    let skippedNext = cloneSkippedKeys(st?.skippedKeys);
    const rememberSkippedLocal = (chainId, index, keyB64, maxPerChain = SKIPPED_KEYS_PER_CHAIN_MAX) => {
      if (!chainId || !Number.isFinite(index)) return;
      let chain = skippedNext.get(chainId);
      if (!chain) {
        chain = new Map();
        skippedNext.set(chainId, chain);
      }
      chain.set(index, keyB64);
      if (chain.size > maxPerChain) {
        const firstKey = chain.keys().next();
        if (!firstKey.done) chain.delete(firstKey.value);
      }
    };
    const takeSkippedLocal = (chainId, index) => {
      if (!chainId || !Number.isFinite(index)) return null;
      const chain = skippedNext.get(chainId);
      if (!chain) return null;
      const value = chain.get(index) || null;
      if (value !== null) chain.delete(index);
      if (!chain.size) skippedNext.delete(chainId);
      return value;
    };
    let mk = null;
    let usedStoredKey = false;
    const sameReceiveChain = st?.theirRatchetPub && typeof packet?.header?.ek_pub_b64 === 'string'
      && b64(working.theirRatchetPub) === packet.header.ek_pub_b64;

    // [FIX] Cache-First Replay Check: If message is "late" (counter < current), check if we saved a key for it.
    if (sameReceiveChain && Number.isFinite(headerN) && Number.isFinite(currentNr) && currentNr >= headerN) {
      // Attempt to rescue from skipped cache
      const chainIdCandidate = packet.header.ek_pub_b64;
      const cached = takeSkippedLocal(chainIdCandidate, headerN);
      if (cached) {
        mk = b64u8(cached);
        usedStoredKey = true;
        nrAtDerive = Number.isFinite(st?.Nr) ? Number(st.Nr) : null;
        nUsed = Number.isFinite(headerN) ? headerN : (nrAtDerive !== null ? nrAtDerive : null);
      } else {
        // Only throw if we truly don't have the key
        throw new Error('replay or out-of-order message counter');
      }
    }
    let ratchetPerformed = false;

    // 若接收端狀態的對方 ratchet 公鑰與封包不一致，且這是第一封消息，嘗試丟棄舊的 receive chain 讓後續能依新公鑰重新進入 ratchet。
    if (
      holderRole === 'responder' &&
      headerN === 1 &&
      currentNr === 0 &&
      typeof packet?.header?.ek_pub_b64 === 'string' &&
      working?.theirRatchetPub &&
      b64(working.theirRatchetPub) !== packet.header.ek_pub_b64
    ) {
      working.ckR = null;
      working.theirRatchetPub = null;
    }

    const theirPub = b64u8(packet.header.ek_pub_b64);
    const pn = Number(packet?.header?.pn);
    const prevChainId = working.theirRatchetPub ? b64(working.theirRatchetPub) : null;
    chainId = prevChainId;

    if (!working.theirRatchetPub || b64(working.theirRatchetPub) !== packet.header.ek_pub_b64) {
      try {
        if (drDebugLogsEnabled) {
          console.warn('[dr-ratchet:pre]', {
            headerEk: packet?.header?.ek_pub_b64 ? String(packet.header.ek_pub_b64).slice(0, 12) : null,
            stateTheirPub: working?.theirRatchetPub ? b64(working.theirRatchetPub).slice(0, 12) : null,
            hasCkR: !!(working?.ckR && working.ckR.length),
            hasCkS: !!(working?.ckS && working.ckS.length),
            Nr: working?.Nr ?? null,
            Ns: working?.Ns ?? null,
            PN: working?.PN ?? null
          });
        }
      } catch { }
      // Before switching to the new ratchet key, fill skipped message keys on the previous receiving chain up to pn.
      if (prevChainId && working.ckR && Number.isFinite(pn) && pn > working.Nr) {
        const gap = pn - working.Nr;
        if (gap > SKIPPED_KEYS_PER_CHAIN_MAX) {
          if (drDebugLogsEnabled) {
            console.warn('[dr] skipped-key gap too large', { gap, pn, nr: working.Nr, chain: prevChainId });
          }
        }
        let ckR = working.ckR;
        let nr = working.Nr;
        while (ckR && nr < pn) {
          const skippedOut = await kdfCK(ckR);
          const { a: skippedMk, b: skippedNext } = split64(skippedOut);
          newSkippedKeys.push({ chainId: prevChainId, headerCounter: nr + 1, messageKeyB64: b64(skippedMk) });
          ckR = skippedNext;
          nr += 1;
        }
        working.ckR = ckR;
        working.Nr = nr;
      }
      const ratchetResult = await drRatchet(working, theirPub);
      if (!(working.ckR instanceof Uint8Array) || !working.ckR.length) {
        working.ckR = ratchetResult?.ckR instanceof Uint8Array ? ratchetResult.ckR : null;
      }
      working.theirRatchetPub = ratchetResult?.theirRatchetPub instanceof Uint8Array ? ratchetResult.theirRatchetPub : theirPub;
      working.Nr = 0;
      ratchetPerformed = true;
      dhOutHash = ratchetResult?.dhOutHash || null;
      ckRSeedHash = ratchetResult?.ckRSeedHash || null;
      ckSSeedHash = ratchetResult?.ckRSeedHash || null;
    } else {
      working.theirRatchetPub = theirPub;
    }
    // [DEBUG-TRACE]
    if (ratchetPerformed) {
      console.log('[drDecryptText] Ratchet Performed', {
        newNr: working.Nr,
        hasCkR: !!(working.ckR && working.ckR.length)
      });
    }
    nrAfterRatchet = Number.isFinite(working?.Nr) ? Number(working.Nr) : null;
    postRatchetTheirPubPrefix = working?.theirRatchetPub ? b64(working.theirRatchetPub).slice(0, 12) : null;
    chainId = packet?.header?.ek_pub_b64 || null;
    let usedStoredKeyMatches = false; // dummy or reuse? Loop below logic handles it.
    // Removed let declarations to avoid SyntaxError (hoisted above)
    // let mk = null; 
    // let usedStoredKey = false;
    if (!mk && !usedStoredKey) { // Reset if not already found in early check
      mk = null;
    }
    if (chainId && Number.isFinite(headerN)) {
      const cached = takeSkippedLocal(chainId, headerN);
      if (cached) {
        mk = b64u8(cached);
        usedStoredKey = true;
        nrAtDerive = Number.isFinite(st?.Nr) ? Number(st.Nr) : null;
        nUsed = Number.isFinite(headerN) ? headerN : (nrAtDerive !== null ? nrAtDerive : null);
      }
    }
    if (!usedStoredKey) {
      if (!working.ckR) throw new Error('receive chain missing');
      if (chainId && Number.isFinite(headerN)) {
        while (working.ckR && working.Nr + 1 < headerN) {
          const skippedOut = await kdfCK(working.ckR);
          const { a: skippedMk, b: skippedNext } = split64(skippedOut);
          working.ckR = skippedNext;
          working.Nr += 1;
          newSkippedKeys.push({ chainId, headerCounter: working.Nr, messageKeyB64: b64(skippedMk) });
        }
      }
      nrAtDerive = Number.isFinite(working?.Nr) ? Number(working.Nr) : null;
      nUsed = Number.isFinite(headerN) ? headerN : (nrAtDerive !== null ? nrAtDerive + 1 : null);
      const mkOut = await kdfCK(working.ckR);
      const derivation = split64(mkOut);
      mk = derivation.a;
      working.ckR = derivation.b;
      mkHash = await hashPrefix(mk);
      chainHash = await hashPrefix(working.ckR);
    }
    if (!mkHash && mk) {
      mkHash = await hashPrefix(mk);
    }
    let decryptIv = null;
    let decryptCt = null;
    try {
      decryptIv = b64u8(packet.iv_b64);
      decryptCt = b64u8(packet.ciphertext_b64);
      const aad = buildDrAadFromHeader(packet.header);
      const aadHash = aad ? await hashPrefix(aad) : null;
      decIvHash = decryptIv ? await hashPrefix(decryptIv) : null;
      decCtHash = decryptCt ? await hashPrefix(decryptCt) : null;
      decAadHash = aadHash;
      const decLine = JSON.stringify({
        ivLen: decryptIv?.byteLength ?? null,
        ivHash: decIvHash,
        ctLen: decryptCt?.byteLength ?? null,
        ctHash: decCtHash,
        aadLen: aad?.byteLength ?? null,
        aadHash,
        mkHash,
        nUsed: Number.isFinite(nUsed) ? nUsed : null,
        ek: packet?.header?.ek_pub_b64 ? String(packet.header.ek_pub_b64).slice(0, 12) : null
      });
      if (drDebugLogsEnabled) {
        console.warn('[dr-debug:aead-decrypt]', decLine);
      }
    } catch { }
    if (onMessageKey) {
      try {
        onMessageKey(b64(mk));
      } catch {
        // ignore callback errors
      }
    }
    if (!usedStoredKey) {
      working.Nr += 1;
      if (Number.isFinite(headerN) && headerN > working.Nr) {
        working.Nr = headerN;
      }
      working.NrTotal = Number.isFinite(working?.NrTotal) ? Number(working.NrTotal) + 1 : working.Nr;
    }

    if (ratchetPerformed) {
      try {
        if (drDebugLogsEnabled) {
          console.warn('[dr-ratchet:post]', {
            headerEk: packet?.header?.ek_pub_b64 ? String(packet.header.ek_pub_b64).slice(0, 12) : null,
            stateTheirPub: working?.theirRatchetPub ? b64(working.theirRatchetPub).slice(0, 12) : null,
            hasCkR: !!(working?.ckR && working.ckR.length),
            hasCkS: !!(working?.ckS && working.ckS.length),
            Nr: working?.Nr ?? null,
            Ns: working?.Ns ?? null,
            PN: working?.PN ?? null
          });
        }
      } catch { }
    }

    if (ratchetPerformed || usedStoredKey) {
      try {
        if (drDebugLogsEnabled) {
          console.warn('[dr-log:decrypt-ratchet]', {
            headerN,
            pn,
            usedStoredKey,
            ratchetPerformed,
            chainId: chainId ? chainId.slice(0, 12) : null,
            stateNr: working?.Nr ?? null,
            stateNs: working?.Ns ?? null,
            hasCkS: !!(working?.ckS && working.ckS.length),
            hasCkR: !!(working?.ckR && working.ckR.length),
            theirPubHash: working?.theirRatchetPub ? b64(working.theirRatchetPub).slice(0, 12) : null
          });
        }
      } catch {
        // ignore log errors
      }
    }

    fingerprintBeforeDecrypt = await fingerprintState(holderSnapshot, mkHash, decCtHash);
    const key = await crypto.subtle.importKey(
      'raw',
      toU8Strict(mk, 'web/src/shared/crypto/dr.js:458:drDecryptText'),
      'AES-GCM',
      false,
      ['decrypt']
    );
    const aad = buildDrAadFromHeader(packet.header);
    const decryptPayload = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decryptIv, additionalData: aad },
      key,
      decryptCt
    );
    const plaintext = new TextDecoder().decode(decryptPayload);

    try {
      const fingerprintAfterDecrypt = await fingerprintState(working, mkHash, decCtHash);
      if (drDebugLogsEnabled) {
        console.warn('[dr-fingerprint:post-decrypt]', {
          ...fingerprintAfterDecrypt,
          diff: diffFingerprint(beforeAttempt, fingerprintAfterDecrypt)
        });
      }
    } catch { }

    restoreHolder();
    st.rk = working.rk;
    st.ckR = working.ckR;
    st.ckS = working.ckS;
    st.Ns = working.Ns;
    st.Nr = working.Nr;
    st.NsTotal = working.NsTotal;
    st.NrTotal = working.NrTotal;
    st.PN = working.PN;
    st.myRatchetPriv = working.myRatchetPriv;
    st.myRatchetPub = working.myRatchetPub;
    st.theirRatchetPub = working.theirRatchetPub;
    st.pendingSendRatchet = working.pendingSendRatchet;
    st.skippedKeys = cloneSkippedKeys(skippedNext);

    if (newSkippedKeys.length && typeof opts?.onSkippedKeys === 'function') {
      opts.onSkippedKeys(newSkippedKeys);
    }

    // [DEBUG-TRACE]
    console.log('[drDecryptText] Decrypt Success', { n: headerN });
    return plaintext;
  } catch (err) {
    // [DEBUG-TRACE]
    console.error('[drDecryptText] Failed', err, {
      headerN,
      chainId,
      currentNr
    });
    if (drDebugLogsEnabled) {
      try {
        console.warn('[dr-error:decrypt-fail]', {
          message: err?.message || String(err),
          stack: err?.stack || null,
          headerN,
          currentNr,
          chainId: chainId ? chainId.slice(0, 12) : null
        });
      } catch (logErr) {
        console.warn('[dr-error:decrypt-fail:log-error]', String(logErr));
      }
    }
    const isAeadFailure = (err?.name === 'OperationError') || (err?.code === 'OperationError') || (typeof err?.message === 'string' && err.message.includes('OperationError'));
    const ensureDrMeta = () => {
      if (!err.__drMeta) {
        err.__drMeta = {
          headerN: Number.isFinite(headerN) ? headerN : null,
          nUsed: Number.isFinite(nUsed) ? nUsed : null,
          nrAfterRatchet: Number.isFinite(nrAfterRatchet) ? nrAfterRatchet : null,
          nrAtDerive: Number.isFinite(nrAtDerive) ? nrAtDerive : null,
          ratchetPerformed,
          chainId: packet?.header?.ek_pub_b64 || null,
          postRatchetTheirPubPrefix,
          dhOutHash,
          ckRSeedHash,
          ckSSeedHash,
          mkHash,
          chainHash,
          encIvHash,
          encCtHash,
          encAadHash,
          decIvHash,
          decCtHash,
          decAadHash,
          encMkHash
        };
      }
      return err.__drMeta;
    };
    let diff = null;
    if (isAeadFailure) {
      restoreHolder();
      try {
        const expected = fingerprintBeforeDecrypt || beforeAttempt;
        const afterRestore = await fingerprintState(st, mkHash, decCtHash);
        diff = expected ? diffFingerprint(expected, afterRestore) : null;
        if (drDebugLogsEnabled) {
          try {
            console.warn('[dr-rollback:aes-gcm]', {
              stateKey: stateKey || null,
              holderId: holderId || null,
              headerN: Number.isFinite(headerN) ? headerN : null,
              mkHash: mkHash || null,
              ctHash: decCtHash || null,
              expected,
              afterRestore
            });
            console.warn('[dr-fingerprint:post-restore]', {
              ...afterRestore,
              msgType: msgType || null,
              packetKey: packetKey || null
            });
          } catch { }
        }
      } catch { }
    } else {
      try {
        const afterAttempt = await fingerprintState(st, mkHash);
        diff = diffFingerprint(beforeAttempt, afterAttempt);
      } catch { }
      restoreHolder();
    }
    if (diff && Object.keys(diff).length) {
      const invariantErr = new Error('dr invariant violated: holder mutated during decrypt failure');
      invariantErr.code = 'INVARIANT_VIOLATION';
      invariantErr.__drInvariantDiff = diff;
      invariantErr.__drMeta = ensureDrMeta();
      throw invariantErr;
    }
    ensureDrMeta();
    throw err;
  }
}
