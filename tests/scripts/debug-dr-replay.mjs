import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true
  });
}

import { drDecryptText } from '../../web/src/shared/crypto/dr.js';
import { b64u8 } from '../../web/src/app/crypto/nacl.js';

function fromB64(str) {
  if (!str) return null;
  let s = str;
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return b64u8(s);
}

function urlB64ToStd(str) {
  if (!str) return null;
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  return s;
}

const snapshotBefore = {
  rk_b64: '8N/xzmsHdsKR1l+Aiv5YDdAwDy6Ga9F+VZc6lB0VByg=',
  ckS_b64: 'mn2APBWl6uIzr3tMjcKfKj/wctnaDSdU9WLMaz6YbwY=',
  ckR_b64: '0uLLMLuHrlYco4ehe93vUy6o12K52c6jOKAJyyIXSyI=',
  Ns: 0,
  Nr: 0,
  PN: 0,
  myRatchetPriv_b64: 'hB/wzNUn/mYM5gctRQCMNeytCYBY263TykgUB/AmSks=',
  myRatchetPub_b64: 'zmrCXnz9D2pAId7Erda+nZrYrQIipdGA15XvIblysCk=',
  theirRatchetPub_b64: 'bnjPhzlbAktHuLsxCMdkyHExc/uah+vCPB0THLonqDE=',
  pendingSendRatchet: true,
  role: 'responder'
};

const headerB64 = 'eyJkciI6MSwiZWtfcHViX2I2NCI6ImpQQmJuKzBERHJNeFl0d005cmQvZUpHdVNDQnZHdVZERFhsMHJzZDJRaXc9IiwicG4iOjAsIm4iOjEsIml2X2I2NCI6IlpKdzZQdmFMa3QwNiswenoifQ';
const ciphertextB64Url = 'khFdtV98yC93MEjSso9RBz3TKpZljhFzXmew-HDPCQBSJWLTjQ';

const state = {
  rk: fromB64(snapshotBefore.rk_b64),
  ckS: fromB64(snapshotBefore.ckS_b64),
  ckR: fromB64(snapshotBefore.ckR_b64),
  Ns: snapshotBefore.Ns,
  Nr: snapshotBefore.Nr,
  PN: snapshotBefore.PN,
  myRatchetPriv: fromB64(snapshotBefore.myRatchetPriv_b64),
  myRatchetPub: fromB64(snapshotBefore.myRatchetPub_b64),
  theirRatchetPub: fromB64(snapshotBefore.theirRatchetPub_b64),
  pendingSendRatchet: snapshotBefore.pendingSendRatchet,
  baseKey: { role: snapshotBefore.role }
};

const headerJson = Buffer.from(headerB64, 'base64').toString('utf8');
const header = JSON.parse(headerJson);

const packet = {
  aead: 'aes-256-gcm',
  header,
  iv_b64: header.iv_b64,
  ciphertext_b64: urlB64ToStd(ciphertextB64Url)
};

const run = async () => {
  try {
    const text = await drDecryptText(state, packet);
    console.log('Decrypted text:', text);
  } catch (err) {
    const meta = err?.__drMeta || {};
    const recvDh = meta.dhOutHash ?? null;
    const recvSeed = meta.ckRSeedHash ?? null;
    const senderDh = meta.dhOutHash ?? null; // DH should be symmetric
    const senderSeed = meta.ckSSeedHash ?? meta.ckRSeedHash ?? null;
    const recvMk = meta.mkHash ?? null;
    const senderMk = meta.mkHash ?? null; // symmetric expectation
    const recvChain = meta.chainHash ?? null;
    const senderChain = meta.chainHash ?? null;
    const encIv = meta.encIvHash ?? null;
    const decIv = meta.decIvHash ?? null;
    const encCt = meta.encCtHash ?? null;
    const decCt = meta.decCtHash ?? null;
    const encAad = meta.encAadHash ?? null;
    const decAad = meta.decAadHash ?? null;
    const encMk = meta.encMkHash ?? null;
    const line = [
      `n=${meta.headerN ?? header?.n ?? null}`,
      `nUsed=${meta.nUsed ?? null}`,
      `nrAfterRatchet=${meta.nrAfterRatchet ?? null}`,
      `nrAtDerive=${meta.nrAtDerive ?? null}`,
      `ratchet=${meta.ratchetPerformed ?? null}`,
      `ek=${(header?.ek_pub_b64 || '').slice(0, 12) || null}`,
      `postPub=${meta.postRatchetTheirPubPrefix ?? null}`,
      `recvDh=${recvDh}`,
      `recvSeed=${recvSeed}`,
      `sendDh=${senderDh}`,
      `sendSeed=${senderSeed}`,
      `recvMk=${recvMk}`,
      `sendMk=${senderMk}`,
      `recvChain=${recvChain}`,
      `sendChain=${senderChain}`,
      `encIv=${encIv}`,
      `decIv=${decIv}`,
      `encCt=${encCt}`,
      `decCt=${decCt}`,
      `encAad=${encAad}`,
      `decAad=${decAad}`,
      `encMk=${encMk}`
    ].join(' ');
    console.log('[dr-replay:fail]', line);
  }
};

run();
