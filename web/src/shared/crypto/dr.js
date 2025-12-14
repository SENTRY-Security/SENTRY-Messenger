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

const encoder = new TextEncoder();
const SKIPPED_KEYS_PER_CHAIN_MAX = 100;

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
  const key = await crypto.subtle.importKey('raw', ikmU8, 'HKDF', false, ['deriveBits']);
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

function rememberSkippedKey(st, chainId, index, keyB64, maxPerChain = SKIPPED_KEYS_PER_CHAIN_MAX) {
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
  const peerIkRaw = peerBundle.ik_pub || peerBundle.ik || peerBundle.identity_pub;
  const peerSpkRaw = peerBundle.spk_pub || peerBundle.spk;
  const peerSpkSigRaw = peerBundle.spk_sig || peerBundle.spkSig || peerBundle.signature;
  const peerOpkRaw = peerBundle.opk?.pub || peerBundle.opk_pub || null;
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

  return {
    rk,
    ckS,
    ckR: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    myRatchetPriv: ek.secretKey,
    myRatchetPub: ek.publicKey,
    theirRatchetPub: null,
    pendingSendRatchet: false
  };
}

export async function x3dhRespond(devicePriv, guestBundle) {
  await loadNacl();
  if (!guestBundle || typeof guestBundle !== 'object') throw new Error('guest bundle required');
  const ekPub = guestBundle.ek_pub || guestBundle.ek || guestBundle.ephemeral_pub;
  if (!ekPub) throw new Error('guest bundle missing ek_pub');
  const guestIkRaw = guestBundle.ik_pub || guestBundle.ik || guestBundle.identity_pub;
  const guestSpkRaw = guestBundle.spk_pub || guestBundle.spk;
  const guestSpkSigRaw = guestBundle.spk_sig || guestBundle.spkSig || guestBundle.signature;
  if (!guestIkRaw || !guestSpkRaw) throw new Error('guest bundle missing identity or signed prekey');
  if (!guestSpkSigRaw) throw new Error('guest bundle missing signed prekey signature');
  const opkId = guestBundle.opk_id ?? guestBundle.opkId ?? guestBundle.opk?.id ?? null;
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

  return {
    rk,
    ckS,
    ckR,
    Ns: 0,
    Nr: 0,
    PN: 0,
    myRatchetPriv: myNew.secretKey,
    myRatchetPub: myNew.publicKey,
    theirRatchetPub: guestEK,
    pendingSendRatchet: true
  };
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
  const myNew = await genX25519Keypair();
  st.rk = newRoot;
  st.ckR = chainSeed;
  st.ckS = null;
  st.PN = st.Ns;
  st.Ns = 0;
  st.Nr = 0;
  st.myRatchetPriv = myNew.secretKey;
  st.myRatchetPub = myNew.publicKey;
  st.theirRatchetPub = theirRatchetPubU8;
  st.pendingSendRatchet = false;
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
    }
  }
  const mkOut = await kdfCK(st.ckS);
  const { a: mk, b: nextCkS } = split64(mkOut);
  const mkB64 = b64(mk);
  st.ckS = nextCkS;
  st.Ns += 1;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', mk, 'AES-GCM', false, ['encrypt']);
  const aad = buildDrAad({ version, deviceId, counter: st.Ns });
  const cipherParams = aad ? { name: 'AES-GCM', iv, additionalData: aad } : { name: 'AES-GCM', iv };
  const ctBuf = await crypto.subtle.encrypt(cipherParams, key, new TextEncoder().encode(plaintext));

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
  const onMessageKey = typeof opts?.onMessageKey === 'function' ? opts.onMessageKey : null;
  const headerN = Number(packet?.header?.n);
  if (Number.isFinite(headerN) && headerN <= 0) {
    throw new Error('invalid message counter');
  }
  const currentNr = Number.isFinite(Number(st?.Nr)) ? Number(st.Nr) : 0;
  st.Nr = currentNr; // normalize counter to numeric to avoid string comparisons
  const sameReceiveChain = st?.theirRatchetPub && typeof packet?.header?.ek_pub_b64 === 'string'
    && b64(st.theirRatchetPub) === packet.header.ek_pub_b64;
  if (sameReceiveChain && Number.isFinite(headerN) && Number.isFinite(currentNr) && currentNr >= headerN) {
    throw new Error('replay or out-of-order message counter');
  }
  let ratchetPerformed = false;

  // 若接收端狀態的對方 ratchet 公鑰與封包不一致，且這是第一封消息，嘗試丟棄舊的 receive chain 讓後續能依新公鑰重新進入 ratchet。
  if (
    st?.baseRole === 'responder' &&
    headerN === 1 &&
    currentNr === 0 &&
    typeof packet?.header?.ek_pub_b64 === 'string' &&
    st?.theirRatchetPub &&
    b64(st.theirRatchetPub) !== packet.header.ek_pub_b64
  ) {
    st.ckR = null;
    st.theirRatchetPub = null;
  }

    const snapshot = st ? {
      rk: cloneU8(st.rk),
      ckS: cloneU8(st.ckS),
      ckR: cloneU8(st.ckR),
      Ns: st.Ns,
      Nr: st.Nr,
      NsTotal: st.NsTotal,
      NrTotal: st.NrTotal,
      PN: st.PN,
      myRatchetPriv: cloneU8(st.myRatchetPriv),
      myRatchetPub: cloneU8(st.myRatchetPub),
      theirRatchetPub: cloneU8(st.theirRatchetPub),
      pendingSendRatchet: st.pendingSendRatchet
    } : null;

  const theirPub = b64u8(packet.header.ek_pub_b64);
  const pn = Number(packet?.header?.pn);
  const prevChainId = st.theirRatchetPub ? b64(st.theirRatchetPub) : null;
  try {
    if (!st.theirRatchetPub || b64(st.theirRatchetPub) !== packet.header.ek_pub_b64) {
      // Before switching to the new ratchet key, fill skipped message keys on the previous receiving chain up to pn.
      if (prevChainId && st.ckR && Number.isFinite(pn) && pn > st.Nr) {
        const gap = pn - st.Nr;
        if (gap > SKIPPED_KEYS_PER_CHAIN_MAX) {
          console.warn('[dr] skipped-key gap too large', { gap, pn, nr: st.Nr, chain: prevChainId });
        }
        let ckR = st.ckR;
        let nr = st.Nr;
        while (ckR && nr < pn) {
          const skippedOut = await kdfCK(ckR);
          const { a: skippedMk, b: skippedNext } = split64(skippedOut);
          rememberSkippedKey(st, prevChainId, nr + 1, b64(skippedMk));
          ckR = skippedNext;
          nr += 1;
        }
        st.ckR = ckR;
        st.Nr = nr;
      }
      await drRatchet(st, theirPub);
      ratchetPerformed = true;
    } else {
      st.theirRatchetPub = theirPub;
    }
    const chainId = packet?.header?.ek_pub_b64 || null;
    let usedStoredKey = false;
    let mk = null;
    if (chainId && Number.isFinite(headerN)) {
      const cached = takeSkippedKey(st, chainId, headerN);
      if (cached) {
        mk = b64u8(cached);
        usedStoredKey = true;
      }
    }
    if (!usedStoredKey) {
      if (!st.ckR) throw new Error('receive chain missing');
      if (chainId && Number.isFinite(headerN)) {
        while (st.ckR && st.Nr + 1 < headerN) {
          const skippedOut = await kdfCK(st.ckR);
          const { a: skippedMk, b: skippedNext } = split64(skippedOut);
          st.ckR = skippedNext;
          st.Nr += 1;
          rememberSkippedKey(st, chainId, st.Nr, b64(skippedMk));
        }
      }
      const mkOut = await kdfCK(st.ckR);
      const derivation = split64(mkOut);
      mk = derivation.a;
      st.ckR = derivation.b;
    }
    if (onMessageKey) {
      try {
        onMessageKey(b64(mk));
      } catch {
        // ignore callback errors
      }
    }
    if (!usedStoredKey) {
      st.Nr += 1;
      if (Number.isFinite(headerN) && headerN > st.Nr) {
        st.Nr = headerN;
      }
    }

    const key = await crypto.subtle.importKey('raw', mk, 'AES-GCM', false, ['decrypt']);
    const aad = buildDrAadFromHeader(packet.header);
    const decryptParams = aad
      ? { name: 'AES-GCM', iv: b64u8(packet.iv_b64), additionalData: aad }
      : { name: 'AES-GCM', iv: b64u8(packet.iv_b64) };
    const pt = await crypto.subtle.decrypt(
      decryptParams,
      key,
      b64u8(packet.ciphertext_b64)
    );
    return new TextDecoder().decode(pt);
  } catch (err) {
    if (snapshot) {
      st.rk = snapshot.rk;
      st.ckS = snapshot.ckS;
      st.ckR = snapshot.ckR;
      st.Ns = snapshot.Ns;
      st.Nr = snapshot.Nr;
      st.NsTotal = snapshot.NsTotal;
      st.NrTotal = snapshot.NrTotal;
      st.PN = snapshot.PN;
      st.myRatchetPriv = snapshot.myRatchetPriv;
      st.myRatchetPub = snapshot.myRatchetPub;
      st.theirRatchetPub = snapshot.theirRatchetPub;
      st.pendingSendRatchet = snapshot.pendingSendRatchet;
    }
    throw err;
  }
}
