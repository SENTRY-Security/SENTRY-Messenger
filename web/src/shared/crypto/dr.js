import { loadNacl, scalarMult, genX25519Keypair, b64, b64u8 } from './nacl.js';
import { convertEd25519PublicKey, convertEd25519SecretKey } from './ed2curve.js';

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

function rememberSkippedKey(st, chainId, index, keyB64, maxPerChain = 20) {
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

export async function x3dhInitiate(devicePriv, peerBundle) {
  await loadNacl();
  const myIKsec64 = b64u8(devicePriv.ik_priv_b64);
  const myIKseed = myIKsec64.slice(0, 32);
  const myIKsec32 = await convertEd25519SecretKey(myIKseed);
  if (!myIKsec32) throw new Error('ik secret conversion failed');
  const ek = await genX25519Keypair();

  const peerIK = await convertEd25519PublicKey(b64u8(peerBundle.ik_pub));
  if (!peerIK) throw new Error('peer ik conversion failed');
  const peerSPK = b64u8(peerBundle.spk_pub);

  const DH1 = await scalarMult(myIKsec32, peerSPK);
  const DH2 = await scalarMult(ek.secretKey, peerIK);
  const DH3 = await scalarMult(ek.secretKey, peerSPK);
  let dhCat = new Uint8Array([...DH1, ...DH2, ...DH3]);

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

  const myIKsec64 = b64u8(devicePriv.ik_priv_b64);
  const myIKseed = myIKsec64.slice(0, 32);
  const myIKsec32 = await convertEd25519SecretKey(myIKseed);
  if (!myIKsec32) throw new Error('ik secret conversion failed');
  const mySPKsec = b64u8(devicePriv.spk_priv_b64);
  const mySPKsec32 = mySPKsec.slice(0, 32);
  const guestEK = b64u8(ekPub);

  const parts = [];
  const guestIKRaw = guestBundle.ik_pub || guestBundle.ik || guestBundle.identity_pub;
  if (guestIKRaw) {
    const guestIK = await convertEd25519PublicKey(b64u8(guestIKRaw));
    if (!guestIK) throw new Error('guest ik conversion failed');
    parts.push(await scalarMult(mySPKsec32, guestIK));
  }
  parts.push(await scalarMult(myIKsec32, guestEK));
  parts.push(await scalarMult(mySPKsec32, guestEK));

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

export async function drEncryptText(st, plaintext) {
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
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));

  const header = { dr: 1, ek_pub_b64: b64(st.myRatchetPub), pn: st.PN, n: st.Ns };
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
  const theirPub = b64u8(packet.header.ek_pub_b64);
  if (!st.theirRatchetPub || b64(st.theirRatchetPub) !== packet.header.ek_pub_b64) {
    await drRatchet(st, theirPub);
  } else {
    st.theirRatchetPub = theirPub;
  }
  const chainId = packet?.header?.ek_pub_b64 || null;
  const headerN = Number(packet?.header?.n);
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
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64u8(packet.iv_b64) },
    key,
    b64u8(packet.ciphertext_b64)
  );
  return new TextDecoder().decode(pt);
}
