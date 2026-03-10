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
import { loadNacl, scalarMult, genX25519Keypair, b64, b64u8, verifyDetached } from './nacl.ts';
import { convertEd25519PublicKey, convertEd25519SecretKey } from './ed2curve.ts';
import { toU8Strict } from '../utils/u8-strict.js';
import { DEBUG } from '../../app/ui/mobile/debug-flags.js';
import type { KeyPair } from './nacl.ts';
import type { DevicePriv } from './prekeys.ts';

// ── Types ─────────────────────────────────────────────────────────────

/** Skipped message key store: chainId → (counter → base64-encoded key) */
export type SkippedKeyStore = Map<string, Map<number, string>>;

/** Core Double Ratchet session state. */
export interface DrState {
  rk: Uint8Array;
  ckS: Uint8Array | null;
  ckR: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  NsTotal: number;
  NrTotal: number;
  myRatchetPriv: Uint8Array;
  myRatchetPub: Uint8Array;
  theirRatchetPub: Uint8Array | null;
  pendingSendRatchet: boolean;
  skippedKeys?: SkippedKeyStore;
  baseKey?: DrBaseKey;
  baseRole?: string;
  __bornReason?: string;
  __id?: string;
}

export interface DrBaseKey {
  role?: string;
  stateKey?: string;
  conversationId?: string;
  peerKey?: string;
  peerAccountDigest?: string;
  peerDeviceId?: string;
  deviceId?: string;
}

/** Encrypted packet header. */
export interface DrHeader {
  dr: number;
  v: number;
  device_id?: string;
  ek_pub_b64: string;
  pn: number;
  n: number;
  counter?: number;
  deviceId?: string;
  version?: number;
}

/** Encrypted DR packet returned by drEncryptText. */
export interface DrPacket {
  aead: 'aes-256-gcm';
  header: DrHeader;
  iv_b64: string;
  ciphertext_b64: string;
  message_key_b64: string;
}

/** Peer bundle for X3DH initiator. */
export interface PeerBundle {
  ik_pub: string;
  spk_pub: string;
  spk_sig: string;
  opk?: { pub: string; id?: number } | null;
  account_digest?: string;
  device_id?: string;
}

/** Guest bundle for X3DH responder. */
export interface GuestBundle {
  ek_pub: string;
  ik_pub: string;
  spk_pub: string;
  spk_sig: string;
  opk_id: number | string;
  account_digest?: string;
  device_id?: string;
}

export interface DrEncryptOpts {
  deviceId?: string;
  senderDeviceId?: string;
  version?: number;
  msgVersion?: number;
}

export interface DrDecryptOpts {
  onMessageKey?: (mkB64: string) => void;
  onSkippedKeys?: (keys: SkippedKeyEntry[]) => void;
  packetKey?: string;
  msgType?: string;
}

export interface SkippedKeyEntry {
  chainId: string;
  headerCounter: number;
  messageKeyB64: string;
}

interface RatchetResult {
  ckR: Uint8Array;
  theirRatchetPub: Uint8Array;
  dhOutHash: string | null;
  ckRSeedHash: string | null;
}

interface DrFingerprint {
  stateKey: string | null;
  holderId: string | null;
  Nr: number | null;
  Ns: number | null;
  PN: number | null;
  theirPubHash: string | null;
  ckRHash: string | null;
  ckSHash: string | null;
  skippedSize: number;
  role: string | null;
  mkHash: string | null;
  ctHash: string | null;
}

interface DrError extends Error {
  code?: string;
  __drMeta?: Record<string, unknown>;
  __drInvariantDiff?: Record<string, unknown>;
}

// ── Constants ─────────────────────────────────────────────────────────

const encoder = new TextEncoder();
const SKIPPED_KEYS_PER_CHAIN_MAX = 100;
const PACKET_HOLDER_CACHE_MAX = 2000;
const packetHolderCache = new Map<string, string | null>();
const drDebugLogsEnabled: boolean = DEBUG.drVerbose === true;

// ── Helpers ───────────────────────────────────────────────────────────

function cloneU8(src: Uint8Array | null | undefined): Uint8Array | null {
  if (src instanceof Uint8Array) return new Uint8Array(src);
  return null;
}

function normalizeDeviceId(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeAadVersion(value: unknown, fallback: number = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

interface AadParams {
  version: unknown;
  deviceId: unknown;
  counter: unknown;
}

function buildAadString({ version, deviceId, counter }: AadParams): string | null {
  const v = normalizeAadVersion(version, 1);
  const dev = normalizeDeviceId(deviceId);
  if (!dev) return null;
  const ctr = Number(counter);
  if (!Number.isFinite(ctr)) return null;
  return `v:${v};d:${dev};c:${ctr}`;
}

export function buildDrAadFromHeader(header: Partial<DrHeader> | null | undefined): Uint8Array | null {
  if (!header || typeof header !== 'object') return null;
  const counter = Number.isFinite(header?.n) ? header.n! : Number(header?.counter);
  const deviceId = header?.device_id || header?.deviceId || null;
  const version = header?.v ?? header?.version ?? 1;
  const aadStr = buildAadString({ version, deviceId, counter });
  return aadStr ? encoder.encode(aadStr) : null;
}

function buildDrAad({ version, deviceId, counter }: AadParams): Uint8Array | null {
  const aadStr = buildAadString({ version, deviceId, counter });
  return aadStr ? encoder.encode(aadStr) : null;
}

async function hkdfBytes(ikmU8: Uint8Array, saltStr: string, infoStr: string, outLen: number = 32): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(ikmU8, 'web/src/shared/crypto/dr.ts:hkdfBytes') as BufferSource,
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

async function kdfRK(rk: Uint8Array, dhOut: Uint8Array): Promise<Uint8Array> {
  return hkdfBytes(new Uint8Array([...rk, ...dhOut]), 'dr-rk', 'root', 64);
}

async function kdfCK(ck: Uint8Array): Promise<Uint8Array> {
  return hkdfBytes(ck, 'dr-ck', 'chain', 64);
}

function split64(u: Uint8Array): { a: Uint8Array; b: Uint8Array } {
  return { a: u.slice(0, 32), b: u.slice(32, 64) };
}

async function hashPrefix(u8: Uint8Array, len: number = 12): Promise<string | null> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', u8 as BufferSource);
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, len);
  } catch {
    return null;
  }
}

function ensureSkipStore(st: DrState): SkippedKeyStore | null {
  if (!st || typeof st !== 'object') return null;
  if (!(st.skippedKeys instanceof Map)) {
    try {
      st.skippedKeys = new Map();
    } catch {
      st.skippedKeys = undefined;
    }
  }
  return st.skippedKeys || null;
}

function cloneSkippedKeys(store: SkippedKeyStore | undefined | null): SkippedKeyStore {
  const out: SkippedKeyStore = new Map();
  if (!(store instanceof Map)) return out;
  for (const [chainId, chain] of store.entries()) {
    if (chain instanceof Map) {
      out.set(chainId, new Map(chain));
    }
  }
  return out;
}

export function rememberSkippedKey(
  st: DrState,
  chainId: string,
  index: number,
  keyB64: string,
  maxPerChain: number = SKIPPED_KEYS_PER_CHAIN_MAX
): void {
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

function takeSkippedKey(st: DrState, chainId: string, index: number): string | null {
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

// ── X3DH ──────────────────────────────────────────────────────────────

export async function x3dhInitiate(
  devicePriv: DevicePriv,
  peerBundle: PeerBundle,
  overrideEk: KeyPair | null = null
): Promise<DrState> {
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

  let ek: KeyPair = overrideEk as KeyPair;
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
  const dhCat = new Uint8Array([...DH1, ...DH2, ...DH3, ...DH4]);

  const rk = await hkdfBytes(dhCat, 'x3dh-salt', 'x3dh-root', 32);
  const seed = await kdfCK(rk);
  const { a: ckS } = split64(seed);

  const state: DrState = {
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
      const rkH = state.rk ? await hashPrefix(state.rk) : null;
      const ckSH = state.ckS ? await hashPrefix(state.ckS) : null;
      const myPubH = state.myRatchetPub ? await hashPrefix(state.myRatchetPub) : null;
      const myPrivH = state.myRatchetPriv ? await hashPrefix(state.myRatchetPriv) : null;
      console.warn('[dr-debug:x3dh-initiate]', {
        rkHash: rkH,
        ckSHash: ckSH,
        myPubHash: myPubH,
        myPrivHash: myPrivH,
        peerDigest: peerBundle?.account_digest || null,
        peerDeviceId: peerBundle?.device_id || null
      });
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

export async function x3dhRespond(
  devicePriv: DevicePriv,
  guestBundle: GuestBundle
): Promise<DrState> {
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

  const parts: Uint8Array[] = [];
  parts.push(await scalarMult(mySPKsec32, guestIk));
  parts.push(await scalarMult(myIKsec32, guestEK));
  parts.push(await scalarMult(mySPKsec32, guestEK));
  const opkPrivU8 = b64u8(opkPrivB64);
  parts.push(await scalarMult(opkPrivU8.slice(0, 32), guestEK));

  let dhCat = parts[0]!;
  for (let i = 1; i < parts.length; i += 1) {
    dhCat = new Uint8Array([...dhCat, ...parts[i]!]);
  }

  const rk = await hkdfBytes(dhCat, 'x3dh-salt', 'x3dh-root', 32);
  const seed = await kdfCK(rk);
  const { a: ckR, b: ckS } = split64(seed);
  const myNew = await genX25519Keypair();

  const state: DrState = {
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
      const rkH = state.rk ? await hashPrefix(state.rk) : null;
      const ckSH = state.ckS ? await hashPrefix(state.ckS) : null;
      const ckRH = state.ckR ? await hashPrefix(state.ckR) : null;
      const myPubH = state.myRatchetPub ? await hashPrefix(state.myRatchetPub) : null;
      const theirPubH = state.theirRatchetPub ? await hashPrefix(state.theirRatchetPub) : null;
      console.warn('[dr-debug:x3dh-respond]', {
        rkHash: rkH,
        ckSHash: ckSH,
        ckRHash: ckRH,
        myPubHash: myPubH,
        theirRatchetPubHash: theirPubH,
        peerDigest: guestBundle?.account_digest || null,
        peerDeviceId: guestBundle?.device_id || null
      });
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

// ── DH Ratchet ────────────────────────────────────────────────────────

export async function drRatchet(st: DrState, theirRatchetPubU8: Uint8Array): Promise<RatchetResult> {
  const nrBase = Number.isFinite(st?.NrTotal) ? Number(st.NrTotal) : 0;
  const nrPrev = Number.isFinite(st?.Nr) ? Number(st.Nr) : 0;
  // [FIX] NsTotal accumulation disabled: since send-side ratcheting is disabled
  // (st.Ns = 0 is commented out below), Ns keeps growing monotonically across all
  // receive ratchets. Accumulating Ns into NsTotal on each ratchet causes NsTotal
  // to compound quadratically (NsTotal += Ns every receive), leading to transport
  // counter jumps that desync with the server's expected counter.
  // NsTotal is maintained by reserveTransportCounter() in dr-session.js instead.
  // st.NsTotal = nsBase + nsPrev;
  st.NrTotal = nrBase + nrPrev;
  const rkHashBefore = drDebugLogsEnabled ? await hashPrefix(st.rk) : null;
  const myPrivHash = drDebugLogsEnabled && st.myRatchetPriv ? await hashPrefix(st.myRatchetPriv) : null;
  const theirPubHash = drDebugLogsEnabled && theirRatchetPubU8 ? await hashPrefix(theirRatchetPubU8) : null;
  const dh = await scalarMult(st.myRatchetPriv.slice(0, 32), theirRatchetPubU8);
  const rkOut = await kdfRK(st.rk, dh);
  const { a: newRoot, b: chainSeed } = split64(rkOut);
  const dhOutHash = await hashPrefix(dh);
  const ckRSeedHash = await hashPrefix(chainSeed);
  const newRkHash = drDebugLogsEnabled ? await hashPrefix(newRoot) : null;
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
      console.warn('[dr-debug:ratchet-dh:recv]', {
        rkHashBefore,
        myPrivHash,
        theirPubHash,
        dhOutHash,
        ckRSeedHash,
        newRkHash,
        headerEk: theirRatchetPubU8 ? b64(theirRatchetPubU8).slice(0, 12) : null
      });
    }
  } catch { }
  return { ckR: chainSeed, theirRatchetPub: theirRatchetPubU8, dhOutHash, ckRSeedHash };
}

// ── Encrypt ───────────────────────────────────────────────────────────

export async function drEncryptText(st: DrState, plaintext: string, opts: DrEncryptOpts = {}): Promise<DrPacket> {
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
      const rkBefore = drDebugLogsEnabled ? await hashPrefix(st.rk) : null;
      const myPrivBefore = drDebugLogsEnabled && st.myRatchetPriv ? await hashPrefix(st.myRatchetPriv) : null;
      const theirPubBefore = drDebugLogsEnabled && st.theirRatchetPub ? await hashPrefix(st.theirRatchetPub) : null;
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
            rkHashBefore: rkBefore,
            myNewPrivHash: await hashPrefix(myNew.secretKey),
            myNewPubHash: await hashPrefix(myNew.publicKey),
            theirPubHash: theirPubBefore,
            dhOutHash: await hashPrefix(dh),
            ckSSeedHash: await hashPrefix(chainSeed),
            newRkHash: await hashPrefix(newRoot),
            headerEk: b64(myNew.publicKey).slice(0, 12)
          });
        }
      } catch { }
    }
  }
  try {
    if (drDebugLogsEnabled) {
      console.warn('[dr-debug:encrypt-pre-mk]', {
        hasCkS: !!(st.ckS && st.ckS.length),
        ckSHash: st.ckS ? await hashPrefix(st.ckS) : null,
        rkHash: st.rk ? await hashPrefix(st.rk) : null,
        Ns: st.Ns,
        pendingSendRatchet: st.pendingSendRatchet,
        branch: st.pendingSendRatchet ? 'pending-cleared' : (st.ckS ? 'existing-ckS' : 'ratchet')
      });
    }
  } catch { }
  const mkOut = await kdfCK(st.ckS!);
  const { a: mk, b: nextCkS } = split64(mkOut);
  const mkB64 = b64(mk);
  st.ckS = nextCkS;
  st.Ns += 1;
  st.NsTotal = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) + 1 : st.Ns;

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(mk, 'web/src/shared/crypto/dr.ts:drEncryptText') as BufferSource,
    'AES-GCM',
    false,
    ['encrypt']
  );
  const aad = buildDrAad({ version, deviceId, counter: st.Ns });
  const cipherParams: AesGcmParams = aad
    ? { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource }
    : { name: 'AES-GCM', iv: iv as BufferSource };
  const ctBuf = await crypto.subtle.encrypt(cipherParams, key, new TextEncoder().encode(plaintext));

  let encIvHash: string | null = null;
  let encCtHash: string | null = null;
  let encAadHash: string | null = null;
  let encMkHash: string | null = null;
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

  const header: DrHeader = {
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

// ── Decrypt ───────────────────────────────────────────────────────────

/** Working copy of DR state used during decrypt to avoid mutating the live state until success. */
interface WorkingState {
  rk: Uint8Array | null;
  ckS: Uint8Array | null;
  ckR: Uint8Array | null;
  Ns: number;
  Nr: number;
  NsTotal: number;
  NrTotal: number;
  PN: number;
  myRatchetPriv: Uint8Array | null;
  myRatchetPub: Uint8Array | null;
  theirRatchetPub: Uint8Array | null;
  pendingSendRatchet: boolean;
}

export async function drDecryptText(st: DrState, packet: DrPacket, opts: DrDecryptOpts = {}): Promise<string> {
  // ── All shared variables hoisted to function scope ──
  // (fixes scoping bug in original JS where catch referenced try-block-scoped const)
  let headerN: number | null = null;
  let currentNr: number | null = null;
  let chainId: string | null = null;
  let nUsed: number | null = null;
  let nrAfterRatchet: number | null = null;
  let nrAtDerive: number | null = null;
  let postRatchetTheirPubPrefix: string | null = null;
  let dhOutHash: string | null = null;
  let ckRSeedHash: string | null = null;
  let ckSSeedHash: string | null = null;
  let mkHash: string | null = null;
  let chainHash: string | null = null;
  let encIvHash: string | null = null;
  let encCtHash: string | null = null;
  let encAadHash: string | null = null;
  let decIvHash: string | null = null;
  let decCtHash: string | null = null;
  let decAadHash: string | null = null;
  let encMkHash: string | null = null;
  let fingerprintBeforeDecrypt: DrFingerprint | null = null;
  let ratchetPerformed = false;
  let mk: Uint8Array | null = null;
  let usedStoredKey = false;
  let decryptIv: Uint8Array | null = null;
  let decryptCt: Uint8Array | null = null;

  const onMessageKey = typeof opts?.onMessageKey === 'function' ? opts.onMessageKey : null;
  const packetKey = typeof opts?.packetKey === 'string' && opts.packetKey ? String(opts.packetKey) : null;
  const msgType = typeof opts?.msgType === 'string' && opts.msgType ? String(opts.msgType) : null;

  // ── Resolve state key / holder identity ──
  const resolveStateKey = (): string | null => {
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

  // ── Snapshot for rollback ──
  const holderSnapshot: DrState & { skippedKeys: SkippedKeyStore } = {
    rk: cloneU8(st?.rk)!,
    ckS: cloneU8(st?.ckS),
    ckR: cloneU8(st?.ckR),
    Ns: Number.isFinite(st?.Ns) ? Number(st.Ns) : 0,
    Nr: Number.isFinite(st?.Nr) ? Number(st.Nr) : 0,
    NsTotal: Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) : 0,
    NrTotal: Number.isFinite(st?.NrTotal) ? Number(st.NrTotal) : 0,
    PN: Number.isFinite(st?.PN) ? Number(st.PN) : 0,
    myRatchetPriv: cloneU8(st?.myRatchetPriv)!,
    myRatchetPub: cloneU8(st?.myRatchetPub)!,
    theirRatchetPub: cloneU8(st?.theirRatchetPub),
    pendingSendRatchet: !!st?.pendingSendRatchet,
    skippedKeys: cloneSkippedKeys(st?.skippedKeys)
  };

  const restoreHolder = (): void => {
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

  // ── Debug fingerprinting helpers ──
  const resolveRole = (holder: Partial<DrState>): string | null => {
    if (typeof holder?.baseKey?.role === 'string') return holder.baseKey.role.toLowerCase();
    if (typeof holder?.baseRole === 'string') return holder.baseRole.toLowerCase();
    return holderRole || null;
  };

  const fingerprintState = async (
    holder: Partial<DrState>,
    mkHashValue: string | null = null,
    ctHashValue: string | null = null
  ): Promise<DrFingerprint> => {
    const hashOrNull = async (u8: Uint8Array | null | undefined): Promise<string | null> =>
      (u8 instanceof Uint8Array && u8.length ? await hashPrefix(u8) : null);
    const skippedSize = holder?.skippedKeys instanceof Map
      ? [...holder.skippedKeys.values()].reduce((acc: number, chain) => acc + (chain instanceof Map ? chain.size : 0), 0)
      : 0;
    return {
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
  };

  const diffFingerprint = (
    before: DrFingerprint | null,
    after: DrFingerprint | null
  ): Record<string, { before: unknown; after: unknown }> => {
    const diff: Record<string, { before: unknown; after: unknown }> = {};
    const keys = new Set([
      ...(before ? Object.keys(before) : []),
      ...(after ? Object.keys(after) : [])
    ]);
    for (const key of keys) {
      const beforeVal = before ? (before as unknown as Record<string, unknown>)[key] : undefined;
      const afterVal = after ? (after as unknown as Record<string, unknown>)[key] : undefined;
      if (beforeVal !== afterVal) {
        diff[key] = { before: beforeVal, after: afterVal };
      }
    }
    return diff;
  };

  // ── Working state ──
  currentNr = Number.isFinite(Number(st?.Nr)) ? Number(st.Nr) : 0;

  const working: WorkingState = {
    rk: cloneU8(st?.rk),
    ckS: cloneU8(st?.ckS),
    ckR: cloneU8(st?.ckR),
    Ns: Number.isFinite(st?.Ns) ? Number(st.Ns) : 0,
    Nr: currentNr,
    NsTotal: Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) : 0,
    NrTotal: Number.isFinite(st?.NrTotal) ? Number(st.NrTotal) : 0,
    PN: Number.isFinite(st?.PN) ? Number(st.PN) : 0,
    myRatchetPriv: cloneU8(st?.myRatchetPriv),
    myRatchetPub: cloneU8(st?.myRatchetPub),
    theirRatchetPub: cloneU8(st?.theirRatchetPub),
    pendingSendRatchet: !!st?.pendingSendRatchet
  };

  const newSkippedKeys: SkippedKeyEntry[] = [];
  let skippedNext: SkippedKeyStore = cloneSkippedKeys(st?.skippedKeys);

  const takeSkippedLocal = (localChainId: string, index: number): string | null => {
    if (!localChainId || !Number.isFinite(index)) return null;
    const chain = skippedNext.get(localChainId);
    if (!chain) return null;
    const value = chain.get(index) || null;
    if (value !== null) chain.delete(index);
    if (!chain.size) skippedNext.delete(localChainId);
    return value;
  };

  // ── Fingerprint baseline (before any mutation) ──
  const fingerprintBaseline = await fingerprintState(holderSnapshot);
  const beforeAttempt = fingerprintBaseline;

  try {
    headerN = Number(packet?.header?.n);
    if (Number.isFinite(headerN) && headerN! <= 0) {
      throw new Error('invalid message counter');
    }
    // [DEBUG-TRACE]
    {
      let rkH: string | null = null;
      let ckRH: string | null = null;
      let ckSH: string | null = null;
      let myPrivH: string | null = null;
      let theirPubH: string | null = null;
      try {
        rkH = st?.rk ? await hashPrefix(st.rk) : null;
        ckRH = st?.ckR ? await hashPrefix(st.ckR) : null;
        ckSH = st?.ckS ? await hashPrefix(st.ckS) : null;
        myPrivH = st?.myRatchetPriv ? await hashPrefix(st.myRatchetPriv) : null;
        theirPubH = st?.theirRatchetPub ? await hashPrefix(st.theirRatchetPub) : null;
      } catch { }
      console.log('[drDecryptText] Start', {
        headerN,
        pn: packet?.header?.pn,
        ek: packet?.header?.ek_pub_b64 ? String(packet.header.ek_pub_b64).slice(0, 12) : null,
        role: typeof st?.baseKey?.role === 'string' ? st.baseKey.role : 'unknown',
        stateNs: st?.Ns,
        stateNr: st?.Nr,
        rkHash: rkH,
        ckRHash: ckRH,
        ckSHash: ckSH,
        myPrivHash: myPrivH,
        theirPubHash: theirPubH,
        hasRk: !!(st?.rk && st.rk.length),
        hasCkR: !!(st?.ckR && st.ckR.length),
        hasTheirPub: !!(st?.theirRatchetPub && st.theirRatchetPub.length)
      });
    }

    if (packetKey) {
      const prevHolder = packetHolderCache.get(packetKey);
      if (prevHolder !== undefined && prevHolder !== holderId) {
        const inv: DrError = new Error('dr invariant violated: packetKey processed by different holder');
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

    const sameReceiveChain = st?.theirRatchetPub && typeof packet?.header?.ek_pub_b64 === 'string'
      && b64(working.theirRatchetPub!) === packet.header.ek_pub_b64;

    // [FIX] Cache-First Replay Check
    if (sameReceiveChain && Number.isFinite(headerN) && Number.isFinite(currentNr) && currentNr! >= headerN!) {
      const chainIdCandidate = packet.header.ek_pub_b64;
      const cached = takeSkippedLocal(chainIdCandidate, headerN!);
      if (cached) {
        mk = b64u8(cached);
        usedStoredKey = true;
        nrAtDerive = Number.isFinite(st?.Nr) ? Number(st.Nr) : null;
        nUsed = Number.isFinite(headerN) ? headerN : (nrAtDerive !== null ? nrAtDerive : null);
      } else {
        throw new Error('replay or out-of-order message counter');
      }
    }

    // 若接收端狀態的對方 ratchet 公鑰與封包不一致，且這是第一封消息
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

      // Fill skipped message keys on previous receiving chain up to pn
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
          const { a: skippedMk, b: skippedNextCk } = split64(skippedOut);
          newSkippedKeys.push({ chainId: prevChainId, headerCounter: nr + 1, messageKeyB64: b64(skippedMk) });
          ckR = skippedNextCk;
          nr += 1;
        }
        working.ckR = ckR;
        working.Nr = nr;
      }

      // Cast working to DrState for drRatchet (it expects full DrState)
      const ratchetResult = await drRatchet(working as DrState, theirPub);
      if (!(working.ckR instanceof Uint8Array) || !working.ckR.length) {
        working.ckR = ratchetResult?.ckR instanceof Uint8Array ? ratchetResult.ckR : null;
      }
      working.theirRatchetPub = ratchetResult?.theirRatchetPub instanceof Uint8Array ? ratchetResult.theirRatchetPub : theirPub;
      working.Nr = 0;
      ratchetPerformed = true;
      dhOutHash = ratchetResult?.dhOutHash || null;
      ckRSeedHash = ratchetResult?.ckRSeedHash || null;
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

    if (!mk && !usedStoredKey) {
      mk = null;
    }

    if (chainId && Number.isFinite(headerN)) {
      const cached = takeSkippedLocal(chainId, headerN!);
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
        while (working.ckR && working.Nr + 1 < headerN!) {
          const skippedOut = await kdfCK(working.ckR);
          const { a: skippedMk, b: skippedNextCk } = split64(skippedOut);
          working.ckR = skippedNextCk;
          working.Nr += 1;
          newSkippedKeys.push({ chainId, headerCounter: working.Nr, messageKeyB64: b64(skippedMk) });
        }
      }
      nrAtDerive = Number.isFinite(working?.Nr) ? Number(working.Nr) : null;
      nUsed = Number.isFinite(headerN) ? headerN : (nrAtDerive !== null ? nrAtDerive + 1 : null);
      const mkOut = await kdfCK(working.ckR!);
      const derivation = split64(mkOut);
      mk = derivation.a;
      working.ckR = derivation.b;
      mkHash = await hashPrefix(mk);
      chainHash = await hashPrefix(working.ckR);
    }

    if (!mkHash && mk) {
      mkHash = await hashPrefix(mk);
    }

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
        onMessageKey(b64(mk!));
      } catch {
        // ignore callback errors
      }
    }

    if (!usedStoredKey) {
      working.Nr += 1;
      if (Number.isFinite(headerN) && headerN! > working.Nr) {
        working.Nr = headerN!;
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
    const aesKey = await crypto.subtle.importKey(
      'raw',
      toU8Strict(mk!, 'web/src/shared/crypto/dr.ts:drDecryptText') as BufferSource,
      'AES-GCM',
      false,
      ['decrypt']
    );
    const aad = buildDrAadFromHeader(packet.header);
    const decryptParams: AesGcmParams = aad
      ? { name: 'AES-GCM', iv: decryptIv! as BufferSource, additionalData: aad as BufferSource }
      : { name: 'AES-GCM', iv: decryptIv! as BufferSource };
    const decryptPayload = await crypto.subtle.decrypt(
      decryptParams,
      aesKey,
      decryptCt! as BufferSource
    );
    const plaintext = new TextDecoder().decode(decryptPayload);

    try {
      const fingerprintAfterDecrypt = await fingerprintState(working as unknown as Partial<DrState>, mkHash, decCtHash);
      if (drDebugLogsEnabled) {
        console.warn('[dr-fingerprint:post-decrypt]', {
          ...fingerprintAfterDecrypt,
          diff: diffFingerprint(beforeAttempt, fingerprintAfterDecrypt)
        });
      }
    } catch { }

    // [FIX] Capture send-side state BEFORE restoreHolder() wipes it.
    const liveNs = Number.isFinite(st.Ns) ? Number(st.Ns) : 0;
    const liveNsTotal = Number.isFinite(st.NsTotal) ? Number(st.NsTotal) : 0;
    const liveCkS = st.ckS;
    const liveMyRatchetPriv = st.myRatchetPriv;
    const liveMyRatchetPub = st.myRatchetPub;
    const livePN = Number.isFinite(st.PN) ? Number(st.PN) : 0;

    restoreHolder();
    st.rk = working.rk!;
    st.ckR = working.ckR;
    // Send-side fields: use Math.max for counters and preserve live chain
    st.ckS = liveCkS || working.ckS;
    st.Ns = Math.max(working.Ns, liveNs);
    st.Nr = working.Nr;
    st.NsTotal = Math.max(working.NsTotal, liveNsTotal);
    st.NrTotal = working.NrTotal;
    st.PN = Math.max(working.PN, livePN);
    st.myRatchetPriv = liveMyRatchetPriv || working.myRatchetPriv!;
    st.myRatchetPub = liveMyRatchetPub || working.myRatchetPub!;
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
    const drErr = err as DrError;
    if (drDebugLogsEnabled) {
      try {
        console.warn('[dr-error:decrypt-fail]', {
          message: drErr?.message || String(drErr),
          stack: drErr?.stack || null,
          headerN,
          currentNr,
          chainId: chainId ? chainId.slice(0, 12) : null
        });
      } catch (logErr) {
        console.warn('[dr-error:decrypt-fail:log-error]', String(logErr));
      }
    }

    const isAeadFailure = (drErr?.name === 'OperationError') ||
      (drErr?.code === 'OperationError') ||
      (typeof drErr?.message === 'string' && drErr.message.includes('OperationError'));

    const ensureDrMeta = (): Record<string, unknown> => {
      if (!drErr.__drMeta) {
        drErr.__drMeta = {
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
      return drErr.__drMeta;
    };

    let diff: Record<string, { before: unknown; after: unknown }> | null = null;

    // [FIX] Capture send-side state before restoreHolder() in failure path.
    // A concurrent drEncryptText may have advanced Ns/ckS during our awaits;
    // restoreHolder() must not roll those back or the next encrypt will
    // reuse the same header.n and chain key (duplicate + replay error).
    const failLiveNs = Number.isFinite(st.Ns) ? Number(st.Ns) : 0;
    const failLiveNsTotal = Number.isFinite(st.NsTotal) ? Number(st.NsTotal) : 0;
    const failLiveCkS = st.ckS;
    const failLiveMyPriv = st.myRatchetPriv;
    const failLiveMyPub = st.myRatchetPub;
    const failLivePN = Number.isFinite(st.PN) ? Number(st.PN) : 0;

    const protectSendSide = (): void => {
      st.ckS = failLiveCkS || st.ckS;
      st.Ns = Math.max(failLiveNs, Number.isFinite(st.Ns) ? Number(st.Ns) : 0);
      st.NsTotal = Math.max(failLiveNsTotal, Number.isFinite(st.NsTotal) ? Number(st.NsTotal) : 0);
      st.PN = Math.max(failLivePN, Number.isFinite(st.PN) ? Number(st.PN) : 0);
      st.myRatchetPriv = failLiveMyPriv || st.myRatchetPriv;
      st.myRatchetPub = failLiveMyPub || st.myRatchetPub;
    };

    if (isAeadFailure) {
      restoreHolder();
      protectSendSide();
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
      protectSendSide();
    }

    if (diff && Object.keys(diff).length) {
      // [FIX] Exclude send-side fields from the invariant check.
      // A concurrent drEncryptText legitimately advances Ns/ckS/PN;
      // flagging that as an invariant violation masks the real decrypt error.
      const sendSideKeys = new Set(['Ns', 'ckSHash', 'PN']);
      const recvOnlyDiff: Record<string, unknown> = {};
      for (const k of Object.keys(diff)) {
        if (!sendSideKeys.has(k)) recvOnlyDiff[k] = diff[k];
      }
      if (Object.keys(recvOnlyDiff).length) {
        const invariantErr: DrError = new Error('dr invariant violated: holder mutated during decrypt failure');
        invariantErr.code = 'INVARIANT_VIOLATION';
        invariantErr.__drInvariantDiff = diff;
        invariantErr.__drMeta = ensureDrMeta();
        throw invariantErr;
      }
    }

    ensureDrMeta();
    throw drErr;
  }
}
