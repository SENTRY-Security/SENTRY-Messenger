// /app/crypto/dr.js
// Minimal X3DH (initiator) + Double Ratchet (DR) helpers.
// - Pure crypto (no network / store); caller supplies peer bundle & device keys and persists state as needed.
//
// Exports:
//   x3dhInitiate(devicePriv, peerBundle) -> DR state
//   drRatchet(state, theirRatchetPubU8) -> void
//   drEncryptText(state, plaintext) -> { aead:'aes-256-gcm', header:{dr,ek_pub_b64,pn,n}, iv_b64,ciphertext_b64 }
//   drDecryptText(state, packet) -> string
//
// Types:
//   devicePriv = {
//     ik_priv_b64, ik_pub_b64,        // Ed25519 (sign)
//     spk_priv_b64, spk_pub_b64,      // X25519 (box)
//     spk_sig_b64, next_opk_id
//   }
//   peerBundle = {
//     ik_pub, spk_pub, spk_sig,       // base64 strings
//     opk: { id, pub } | null         // base64 string or null
//   }

import { loadNacl, scalarMult, genX25519Keypair, b64, b64u8 } from './nacl.js';

// --- HKDF helpers (WebCrypto) ---
async function hkdfBytes(ikmU8, saltStr, infoStr, outLen = 32) {
  const key = await crypto.subtle.importKey('raw', ikmU8, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(saltStr), info: new TextEncoder().encode(infoStr) },
    key,
    outLen * 8
  );
  return new Uint8Array(bits);
}
async function kdfRK(rk, dhOut) { return hkdfBytes(new Uint8Array([...rk, ...dhOut]), 'dr-rk', 'root', 64); }
async function kdfCK(ck)        { return hkdfBytes(ck, 'dr-ck', 'chain', 64); }
function split64(u) { return { a: u.slice(0,32), b: u.slice(32,64) }; }

// --- X3DH (initiator) ---
// NOTE: This is a simplified initiator: it uses DH(IK_A, SPK_B) + DH(EK_A, IK_B) + DH(EK_A, SPK_B) (+ DH(EK_A, OPK_B) if present).
// In a production system you'd convert Ed25519 IK to X25519 for DH or provision an X25519 identity directly.
export async function x3dhInitiate(devicePriv, peerBundle) {
  await loadNacl();
  const myIKsec64 = b64u8(devicePriv.ik_priv_b64); // Ed25519 secret (64); use first 32 bytes as X25519 scalar (simplified)
  const myIKsec32 = myIKsec64.slice(0, 32);
  const ek = await genX25519Keypair();             // Ephemeral X25519
  
  const peerIK = b64u8(peerBundle.ik_pub);         // 32 bytes (assumed compatible in this skeleton)
  const peerSPK = b64u8(peerBundle.spk_pub);       // X25519 public
  const opkPub = peerBundle.opk && peerBundle.opk.pub ? b64u8(peerBundle.opk.pub) : null;
  
  // DHs
  const DH1 = await scalarMult(myIKsec32, peerSPK);       // DH(IK_A, SPK_B)
  const DH2 = await scalarMult(ek.secretKey, peerIK);     // DH(EK_A, IK_B)
  const DH3 = await scalarMult(ek.secretKey, peerSPK);    // DH(EK_A, SPK_B)
  let dhCat = new Uint8Array([...DH1, ...DH2, ...DH3]);
  if (opkPub) {
    const DH4 = await scalarMult(ek.secretKey, opkPub);   // DH(EK_A, OPK_B)
    dhCat = new Uint8Array([...dhCat, ...DH4]);
  }
  
  // root key
  const rk = await hkdfBytes(dhCat, 'x3dh-salt', 'x3dh-root', 32);
  
  // init DR state
  const st = {
    rk, ckS: null, ckR: null, Ns: 0, Nr: 0, PN: 0,
    myRatchetPriv: ek.secretKey, myRatchetPub: ek.publicKey,
    theirRatchetPub: null
  };
  return st;
}

export async function x3dhRespond(devicePriv, guestBundle) {
  await loadNacl();
  if (!guestBundle || typeof guestBundle !== 'object') {
    throw new Error('guest bundle required');
  }
  const ekPub = guestBundle.ek_pub || guestBundle.ek || guestBundle.ephemeral_pub;
  if (!ekPub) throw new Error('guest bundle missing ek_pub');

  const myIKsec64 = b64u8(devicePriv.ik_priv_b64);
  const myIKsec32 = myIKsec64.slice(0, 32);
  const mySPKsec = b64u8(devicePriv.spk_priv_b64);
  const mySPKsec32 = mySPKsec.slice(0, 32);
  const guestEK = b64u8(ekPub);

  const parts = [];
  const guestIKRaw = guestBundle.ik_pub || guestBundle.ik || guestBundle.identity_pub;
  if (guestIKRaw) {
    const guestIK = b64u8(guestIKRaw);
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
    theirRatchetPub: guestEK
  };
}

// --- DR functions ---
export async function drRatchet(st, theirRatchetPubU8) {
  const dh = await scalarMult(st.myRatchetPriv.slice(0,32), theirRatchetPubU8);
  const rkOut = await kdfRK(st.rk, dh);
  const { a: ckR, b: ckS } = split64(rkOut);
  // new sending ratchet key
  const myNew = await genX25519Keypair();
  st.rk = rkOut.slice(0,32);     // keep first half as new rk seed
  st.ckR = ckR; st.ckS = ckS;
  st.PN = st.Ns; st.Ns = 0; st.Nr = 0;
  st.myRatchetPriv = myNew.secretKey;
  st.myRatchetPub  = myNew.publicKey;
  st.theirRatchetPub = theirRatchetPubU8;
}

export async function drEncryptText(st, plaintext) {
  if (!st.ckS) {
    // first encrypt: advance sending chain from rk
    const seed = await kdfCK(st.rk);
    const { a: ckS } = split64(seed);
    st.ckS = ckS;
  }
  const mkOut = await kdfCK(st.ckS);
  const { a: mk, b: nextCkS } = split64(mkOut);
  st.ckS = nextCkS; st.Ns += 1;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', mk, 'AES-GCM', false, ['encrypt']);
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));

  const header = { dr:1, ek_pub_b64: b64(st.myRatchetPub), pn: st.PN, n: st.Ns };
  return { aead:'aes-256-gcm', header, iv_b64: b64(iv), ciphertext_b64: b64(new Uint8Array(ctBuf)) };
}

export async function drDecryptText(st, packet) {
  const theirPub = b64u8(packet.header.ek_pub_b64);
  // if new ratchet pub, perform ratchet
  if (!st.theirRatchetPub || b64(st.theirRatchetPub) !== packet.header.ek_pub_b64) {
    await drRatchet(st, theirPub);
  }
  // derive receive chain if absent
  if (!st.ckR) {
    const seed = await kdfCK(st.rk);
    const { a: ckR } = split64(seed);
    st.ckR = ckR;
  }
  const mkOut = await kdfCK(st.ckR);
  const { a: mk, b: nextCkR } = split64(mkOut);
  st.ckR = nextCkR; st.Nr += 1;

  const key = await crypto.subtle.importKey('raw', mk, 'AES-GCM', false, ['decrypt']);
  const pt = await crypto.subtle.decrypt(
    { name:'AES-GCM', iv: b64u8(packet.iv_b64) },
    key,
    b64u8(packet.ciphertext_b64)
  );
  return new TextDecoder().decode(pt);
}
