import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { verifySdmCmacFromEnvWithFallback, computeSdmCmac } from '../lib/ntag424-verify.js';
import { deriveSdmFileReadKey, keyToHex } from '../lib/ntag424-kdf.js';
import { signHmac } from '../utils/hmac.js';
import { logger } from '../utils/logger.js';
import { getOpaqueConfig, OpaqueID, OpaqueServer, KE1, KE2, KE3, RegistrationRequest, RegistrationRecord, ExpectedAuthResult } from '@cloudflare/opaque-ts';
import elliptic from 'elliptic';

const r = Router();

// 環境變數
const DATA_API = process.env.DATA_API_URL;     // 例：https://message-data.<workers>.dev
const HMAC_SECRET = process.env.DATA_API_HMAC; // 與 worker 的 HMAC_SECRET 相同

// 簡單的一次性 session（先用記憶體 TTL；之後換 KV/Redis）
const SESS = new Map(); // sessionId -> { uidHex, accountToken, accountDigest, uidDigest, exp }
const TTL_SECONDS = 60;
const DEBUG_COUNTERS = new Map(); // uidHex -> last counter used
const OPAQUE_EXPECTED = new Map(); // opaqueSession -> expected auth result (for finish)

// OPAQUE config
const OPAQUE_SEED_HEX = process.env.OPAQUE_OPRF_SEED || '';
const OPAQUE_SERVER_ID = process.env.OPAQUE_SERVER_ID || process.env.DOMAIN || 'api.sentry';
const OPAQUE_AKE_PRIV_B64 = process.env.OPAQUE_AKE_PRIV_B64 || '';
const OPAQUE_AKE_PUB_B64 = process.env.OPAQUE_AKE_PUB_B64 || '';

let opaqueServer = null;
async function initOpaqueIfReady() {
  if (opaqueServer) return opaqueServer;
  if (!/^[0-9A-Fa-f]{64}$/.test(OPAQUE_SEED_HEX)) return null;
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const oprf_seed_u8 = Uint8Array.from(Buffer.from(OPAQUE_SEED_HEX, 'hex'));
  const oprf_seed = Array.from(oprf_seed_u8);

  // Preferred: use configured AKE keypair
  let ake_keypair_export = null;
  if (OPAQUE_AKE_PRIV_B64 && OPAQUE_AKE_PUB_B64) {
    const privU8 = Uint8Array.from(Buffer.from(OPAQUE_AKE_PRIV_B64, 'base64'));
    const pubU8  = Uint8Array.from(Buffer.from(OPAQUE_AKE_PUB_B64, 'base64'));
    ake_keypair_export = {
      private_key: Array.from(privU8),
      public_key: Array.from(pubU8)
    };
  }

  const toExportPair = (pair) => {
    if (!pair) return null;
    const priv = (pair.private_key instanceof Uint8Array) ? Array.from(pair.private_key) : Array.from(pair.private_key || []);
    const pub  = (pair.public_key  instanceof Uint8Array) ? Array.from(pair.public_key)  : Array.from(pair.public_key || []);
    return { private_key: priv, public_key: pub };
  };

  const tryInit = (pairIn) => {
    try {
      const pair = toExportPair(pairIn);
      if (pair) {
        try {
          console.warn('[opaque.init] ake_key len', { priv: pair.private_key.length, pub: pair.public_key.length });
          console.warn('[opaque.init] ake_key sample', {
            priv0: typeof pair.private_key[0], priv1: typeof pair.private_key[1],
            pub0: typeof pair.public_key[0], pub1: typeof pair.public_key[1]
          });
        } catch {}
      }
      opaqueServer = new OpaqueServer(cfg, oprf_seed, pair, OPAQUE_SERVER_ID);
      return true;
    } catch (e) {
      try { console.error('[opaque.init] failed', e?.message || e); } catch {}
      return false;
    }
  };

  if (ake_keypair_export && tryInit(ake_keypair_export)) return opaqueServer;

  // Fallback: generate ephemeral AKE keypair (for test envs). Not recommended for production.
  try {
    console.warn('[opaque.init] attempting fallback keypair generation');
    // Try library-provided generator first
    if (cfg?.ake?.generateAuthKeyPair) {
      const kp = await cfg.ake.generateAuthKeyPair();
      const fallback = { private_key: kp.private_key, public_key: kp.public_key };
      if (tryInit(fallback)) {
        console.warn('[opaque.init] using ephemeral AKE keypair (fallback-lib)');
        return opaqueServer;
      }
    }
    // Use elliptic P-256 to build a keypair (compressed pub)
    const { ec: ECClass } = elliptic;
    const ec = new ECClass('p256');
    const kp2 = ec.genKeyPair();
    const privArr = kp2.getPrivate().toArray('be', 32);
    const pubArr = kp2.getPublic(true, 'array'); // compressed 33 bytes
    const fallback2 = { private_key: Uint8Array.from(privArr), public_key: Uint8Array.from(pubArr) };
    if (tryInit(fallback2)) {
      console.warn('[opaque.init] using ephemeral AKE keypair (fallback-elliptic)');
      return opaqueServer;
    }
  } catch (e) {
    try { console.error('[opaque.init] fallback generateKeyPair failed', e?.message || e); } catch {}
  }

  return null;
}

function b64ToU8(b64) { return Uint8Array.from(Buffer.from(String(b64||''), 'base64')); }
function b64urlToStd(s) {
  const str = String(s || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return str + pad;
}
function b64flexToU8(s) {
  try { return b64ToU8(s); } catch { /* fallthrough */ }
  return Uint8Array.from(Buffer.from(b64urlToStd(s), 'base64'));
}
function u8ToB64(u8) { return Buffer.from(u8).toString('base64'); }
function b64url(bytes) { return Buffer.from(bytes).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }

const ExchangeSchema = z.object({
  uid: z.string().min(14),            // 7-byte UID hex
  sdmmac: z.string().min(8),          // hex
  sdmcounter: z.union([z.number().int().nonnegative(), z.string().min(1)]),
  nonce: z.string().min(1).optional(),
  tagid: z.string().optional()
});

const AccountDigestRegex = /^[0-9A-Fa-f]{64}$/;

const StoreMkSchema = z.object({
  session: z.string().min(8),
  uidHex: z.string().min(14),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  wrapped_mk: z.object({
    v: z.number(),
    kdf: z.literal('argon2id'),
    m: z.number(),
    t: z.number(),
    p: z.number(),
    salt_b64: z.string().min(8),
    iv_b64: z.string().min(8),
    ct_b64: z.string().min(8)
  })
});

const DebugKitSchema = z.object({
  uidHex: z.string().min(14).optional()
});

// ---- OPAQUE Schemas ----
const OpaqueRegisterInitSchema = z.object({
  accountDigest: z.string().regex(AccountDigestRegex),
  request_b64: z.string().min(8)
});

const OpaqueRegisterFinishSchema = z.object({
  accountDigest: z.string().regex(AccountDigestRegex),
  record_b64: z.string().min(8),
  client_identity: z.string().min(1).nullable().optional()
});

const OpaqueLoginInitSchema = z.object({
  accountDigest: z.string().regex(AccountDigestRegex),
  ke1_b64: z.string().min(8),
  context: z.string().min(1).optional()
});

const OpaqueLoginFinishSchema = z.object({
  opaqueSession: z.string().min(8),
  ke3_b64: z.string().min(8)
});

function normalizeUidHex(value) {
  const cleaned = String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (cleaned.length < 14) return null;
  return cleaned.slice(0, 14);
}

function nextDebugCounter(uidHex) {
  const now = Math.floor(Date.now() / 1000);
  const last = DEBUG_COUNTERS.get(uidHex) || 0;
  const next = now > last ? now : last + 1;
  DEBUG_COUNTERS.set(uidHex, next);
  return next;
}

// POST /api/v1/auth/sdm/debug-kit  （產生前端除錯用 SDM 套件）
r.post('/auth/sdm/debug-kit', (req, res) => {
  try {
    const input = DebugKitSchema.parse(req.body || {});
    let uidHex = normalizeUidHex(input.uidHex);
    if (!uidHex) {
      uidHex = crypto.randomBytes(7).toString('hex').toUpperCase();
    }

    const ctr = nextDebugCounter(uidHex);
    const ctrHex = ctr.toString(16).toUpperCase().padStart(6, '0').slice(-6);
    const keyBuf = deriveSdmFileReadKey({ uidHex });
    const cmacHex = computeSdmCmac({ uidHex, ctrHex, sdmFileReadKeyHex: keyToHex(keyBuf) });
    const nonce = `debug-${Date.now()}`;

    return res.json({ uidHex, sdmcounter: ctrHex, sdmmac: cmacHex, nonce });
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/auth/sdm/exchange  （開頁背景自動打）
r.post('/auth/sdm/exchange', async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not set' });
  }
  try {
    const input = ExchangeSchema.parse(req.body || {});
    const uidHex = String(input.uid).replace(/[^0-9a-f]/gi, '').toUpperCase();
    const ctrHex = typeof input.sdmcounter === 'number' ? input.sdmcounter.toString(16) : String(input.sdmcounter);
    const cmacHex = String(input.sdmmac).replace(/[^0-9a-f]/gi, '').toUpperCase();

    // 1) Node 端驗證 SDM/CMAC（支援 current/legacy fallback）
    const vr = verifySdmCmacFromEnvWithFallback({ uidHex, ctrHex, cmacHex });
    if (!vr.ok) {
      // 這裡的 verify 來自你上傳的模組（SV2/CMAC/HKDF/EV2 已封裝）
      //  [oai_citation:0‡ntag424-verify.js](file-service://file-3yLtPRGTSLw9uxYjWr3PfY)  [oai_citation:1‡ntag424-verify.js](file-service://file-3A2kBGQWcdA69xh5hdc8DU)
      return res.status(401).json({ error: 'Unauthorized', detail: 'SDM verify failed' });
    }

    // 2) 更新 last_ctr 並讀回 wrapped_mk（如有）
    const path = '/d1/tags/exchange';
    const body = JSON.stringify({ uidHex, ctr: parseInt(ctrHex, 16) || Number(ctrHex) || 0 });
    const sig = signHmac(path, body, HMAC_SECRET);
    const w = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
    const data = await w.json();
    if (!w.ok) {
      return res.status(w.status).json({ error: 'ExchangeFailed', details: data });
    }

    // 3) 發一次性 session（60s）
    const session = crypto.randomBytes(24).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    const accountToken = data.account_token || null;
    const accountDigest = data.account_digest || null;
    const uidDigest = data.uid_digest || null;
    if (!accountToken || !accountDigest) {
      return res.status(502).json({ error: 'AccountInfoMissing', message: 'worker did not return account token' });
    }
    SESS.set(session, { uidHex, accountToken, accountDigest: accountDigest.toUpperCase(), uidDigest, exp });

    return res.json({
      session,
      hasMK: !!data.hasMK,
      wrapped_mk: data.wrapped_mk || undefined,
      accountToken,
      accountDigest: accountDigest.toUpperCase(),
      uidDigest: uidDigest || null,
      opaqueServerId: OPAQUE_SERVER_ID || null
    });
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/mk/store  （首次設定密碼時呼叫）
r.post('/mk/store', async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not set' });
  }
  try {
    const input = StoreMkSchema.parse(req.body || {});
    const sess = SESS.get(input.session);
    SESS.delete(input.session); // 單次使用
    if (!sess || sess.exp < Math.floor(Date.now() / 1000)) {
      return res.status(401).json({ error: 'SessionExpired', message: 'please re-tap the tag' });
    }
    // 防止偽造 uid
    const uidHex = String(input.uidHex).replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (uidHex !== sess.uidHex) {
      return res.status(401).json({ error: 'SessionMismatch', message: 'uid mismatch' });
    }

    const accountToken = sess.accountToken || input.accountToken;
    const accountDigest = (sess.accountDigest || input.accountDigest || '').toUpperCase();
    if (!accountToken || !accountDigest) {
      return res.status(400).json({ error: 'AccountInfoMissing', message: 'account token missing, please redo exchange' });
    }
    if (!AccountDigestRegex.test(accountDigest)) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid accountDigest' });
    }

    if (input.accountToken && input.accountToken !== accountToken) {
      return res.status(401).json({ error: 'SessionMismatch', message: 'account token mismatch' });
    }
    if (input.accountDigest && input.accountDigest.toUpperCase() !== accountDigest) {
      return res.status(401).json({ error: 'SessionMismatch', message: 'account digest mismatch' });
    }

    const path = '/d1/tags/store-mk';
    const body = JSON.stringify({
      uidHex,
      accountToken,
      accountDigest,
      wrapped_mk: input.wrapped_mk
    });
    const sig = signHmac(path, body, HMAC_SECRET);
    const w = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
    if (!w.ok) {
      const txt = await w.text().catch(() => '');
      return res.status(502).json({ error: 'StoreFailed', details: txt });
    }
    return res.status(204).end();
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// ---- OPAQUE Endpoints ----
// POST /api/v1/auth/opaque/register-init
r.post('/auth/opaque/register-init', async (req, res) => {
  try {
    const server = await initOpaqueIfReady();
    if (!server) return res.status(500).json({ error: 'ConfigError', message: 'OPAQUE not configured' });
    const input = OpaqueRegisterInitSchema.parse(req.body || {});
    const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
    // Validate length before deserializing to avoid opaque-ts generic errors
    const reqBytes = Array.from(b64flexToU8(input.request_b64));
    const expectedReq = RegistrationRequest.sizeSerialized(cfg);
    try { console.warn('[opaque.register-init] sizes', { acct: input.accountDigest, req_b64_len: input.request_b64?.length || 0, req_bytes_len: reqBytes.length, expected: expectedReq }); } catch {}
    logger.info({ op: 'opaque.register-init', acct: input.accountDigest, req_b64_len: input.request_b64?.length || 0, req_bytes_len: reqBytes.length, expected: expectedReq });
    if (reqBytes.length !== expectedReq) {
      return res.status(400).json({ error: 'BadRequest', message: `invalid request_b64 length (got ${reqBytes.length}, expected ${expectedReq})` });
    }
    let reqObj;
    try {
      reqObj = RegistrationRequest.deserialize(cfg, reqBytes);
    } catch (e) {
      return res.status(400).json({ error: 'BadRequest', message: 'invalid request_b64' });
    }
    let out;
    try {
      out = await server.registerInit(reqObj, input.accountDigest.toUpperCase());
    } catch (e) {
      try { console.warn('[opaque.register-init] thrown', e?.message || e); } catch {}
      return res.status(404).json({ error: 'RecordNotFound' });
    }
    if (out instanceof Error) {
      try { console.warn('[opaque.register-init] out instanceof Error', out?.message || out); } catch {}
      return res.status(404).json({ error: 'RecordNotFound' });
    }
    const response_b64 = u8ToB64(new Uint8Array(out.serialize()));
    return res.json({ response_b64 });
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/auth/opaque/register-finish
r.post('/auth/opaque/register-finish', async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not set' });
  }
  try {
    const input = OpaqueRegisterFinishSchema.parse(req.body || {});
    const path = '/d1/opaque/store';
    const body = JSON.stringify({
      accountDigest: input.accountDigest.toUpperCase(),
      record_b64: input.record_b64,
      client_identity: input.client_identity ?? null
    });
    const sig = signHmac(path, body, HMAC_SECRET);
    const w = await fetch(`${DATA_API}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body
    });
    if (w.status !== 204) {
      const txt = await w.text().catch(() => '');
      return res.status(w.status).json({ error: 'OpaqueStoreFailed', details: txt });
    }
    return res.status(204).end();
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/auth/opaque/login-init
r.post('/auth/opaque/login-init', async (req, res) => {
  if (!DATA_API || !HMAC_SECRET) {
    return res.status(500).json({ error: 'ConfigError', message: 'DATA_API_URL or DATA_API_HMAC not set' });
  }
  try {
    const server = await initOpaqueIfReady();
    if (!server) return res.status(500).json({ error: 'ConfigError', message: 'OPAQUE not configured' });
    const input = OpaqueLoginInitSchema.parse(req.body || {});
    const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);

    // fetch registration record from Worker
    const fetchPath = '/d1/opaque/fetch';
    const fetchBody = JSON.stringify({ accountDigest: input.accountDigest.toUpperCase() });
    const sig = signHmac(fetchPath, fetchBody, HMAC_SECRET);
    const w = await fetch(`${DATA_API}${fetchPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-auth': sig },
      body: fetchBody
    });
    if (w.status === 404) {
      try { console.warn('[opaque.login-init] 404 record', { acct: input.accountDigest }); } catch {}
      logger.info({ op: 'opaque.login-init', acct: input.accountDigest, status: 404 });
      return res.status(404).json({ error: 'RecordNotFound' });
    }
    const data = await w.json().catch(async () => ({ text: await w.text().catch(() => '') }));
    if (!w.ok) return res.status(w.status).json({ error: 'OpaqueFetchFailed', details: data });

    const record_b64 = String(data.record_b64 || '').trim();
    const client_identity = data.client_identity ? String(data.client_identity) : undefined;
    // Guard: if record is empty or too short, treat as not found
    const recBytes = Array.from(b64flexToU8(record_b64));
    try { console.warn('[opaque.login-init] record sizes', { acct: input.accountDigest, record_b64_len: record_b64.length, record_bytes_len: recBytes.length }); } catch {}
    logger.info({ op: 'opaque.login-init', acct: input.accountDigest, record_b64_len: record_b64.length, record_bytes_len: recBytes.length });
    const minRecord = RegistrationRecord.sizeSerialized(cfg);
    if (!record_b64 || recBytes.length < minRecord) {
      return res.status(404).json({ error: 'RecordNotFound' });
    }
    let record;
    try {
      record = RegistrationRecord.deserialize(cfg, recBytes);
    } catch (e) {
      // Treat invalid/corrupted record as not found to trigger re-register
      return res.status(404).json({ error: 'RecordNotFound' });
    }

    // Validate ke1 length before deserializing
    const ke1Bytes = Array.from(b64flexToU8(input.ke1_b64));
    try { console.warn('[opaque.login-init] ke1 sizes', { acct: input.accountDigest, ke1_b64_len: input.ke1_b64?.length || 0, ke1_bytes_len: ke1Bytes.length }); } catch {}
    logger.info({ op: 'opaque.login-init', acct: input.accountDigest, ke1_b64_len: input.ke1_b64?.length || 0, ke1_bytes_len: ke1Bytes.length });
    if (ke1Bytes.length !== KE1.sizeSerialized(cfg)) {
      // invalid ke1 from client — cause re-register flow
      return res.status(404).json({ error: 'RecordNotFound' });
    }
    let ke1;
    try {
      ke1 = KE1.deserialize(cfg, ke1Bytes);
    } catch (e) {
      return res.status(404).json({ error: 'RecordNotFound' });
    }
    const initRes = await server.authInit(ke1, record, input.accountDigest.toUpperCase(), client_identity, input.context || undefined);
    if (initRes instanceof Error) {
      // Treat incompatible/corrupted record as missing to trigger re-register on the client.
      return res.status(404).json({ error: 'RecordNotFound', message: 'register required' });
    }

    const ke2_b64 = u8ToB64(new Uint8Array(initRes.ke2.serialize()));
    const expected_b64 = u8ToB64(new Uint8Array(initRes.expected.serialize()));
    const opaqueSession = `opaque-${b64url(crypto.randomBytes(18))}`;
    const exp = Math.floor(Date.now() / 1000) + 120;
    OPAQUE_EXPECTED.set(opaqueSession, { expected_b64, exp });
    return res.json({ ke2_b64, opaqueSession });
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// POST /api/v1/auth/opaque/login-finish
r.post('/auth/opaque/login-finish', async (req, res) => {
  try {
    const server = await initOpaqueIfReady();
    if (!server) return res.status(500).json({ error: 'ConfigError', message: 'OPAQUE not configured' });
    const input = OpaqueLoginFinishSchema.parse(req.body || {});
    const rec = OPAQUE_EXPECTED.get(input.opaqueSession);
    OPAQUE_EXPECTED.delete(input.opaqueSession);
    if (!rec) return res.status(400).json({ error: 'OpaqueSessionNotFound' });
    const now = Math.floor(Date.now() / 1000);
    if (rec.exp && rec.exp < now) return res.status(400).json({ error: 'OpaqueSessionExpired' });
    const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
    let expected, ke3;
    try {
      expected = ExpectedAuthResult.deserialize(cfg, Array.from(b64flexToU8(rec.expected_b64)));
    } catch { return res.status(400).json({ error: 'BadRequest', message: 'invalid expected_b64' }); }
    try {
      ke3 = KE3.deserialize(cfg, Array.from(b64flexToU8(input.ke3_b64)));
    } catch { return res.status(400).json({ error: 'BadRequest', message: 'invalid ke3_b64' }); }
    logger.info({ op: 'opaque.login-finish', opaqueSession: input.opaqueSession, expected_len: rec.expected_b64?.length || 0, ke3_len: input.ke3_b64?.length || 0 });
    const fin = server.authFinish(ke3, expected);
    if (fin instanceof Error) return res.status(400).json({ error: 'OpaqueLoginFinishFailed', message: fin.message || 'login-finish failed' });
    const session_key_b64 = u8ToB64(new Uint8Array(fin.session_key));
    return res.json({ ok: true, session_key_b64 });
  } catch (e) {
    return res.status(400).json({ error: 'BadRequest', message: e?.message || 'invalid input' });
  }
});

// DEBUG: OPAQUE config introspection (non-sensitive)
r.get('/auth/opaque/debug', (req, res) => {
  try {
    const seedHex = String(OPAQUE_SEED_HEX || '');
    const privB64 = String(OPAQUE_AKE_PRIV_B64 || '');
    const pubB64  = String(OPAQUE_AKE_PUB_B64 || '');
    const out = {
      hasSeed: /^[0-9A-Fa-f]{64}$/.test(seedHex),
      hasPriv: !!privB64,
      hasPub: !!pubB64,
      seedLen: seedHex.length,
      privLen: Buffer.from(privB64 || '', 'base64').length || 0,
      pubLen: Buffer.from(pubB64 || '', 'base64').length || 0,
      serverId: OPAQUE_SERVER_ID || null
    };
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: 'OpaqueDebugFailed', message: e?.message || 'internal error' });
  }
});

export default r;
