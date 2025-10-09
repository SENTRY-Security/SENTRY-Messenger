import crypto from 'node:crypto';
import { OpaqueClient, getOpaqueConfig, OpaqueID } from '@cloudflare/opaque-ts/lib/src/index.js';
import { KE2, RegistrationResponse } from '@cloudflare/opaque-ts/lib/src/messages.js';

const subtle = crypto.webcrypto?.subtle;
if (!subtle) {
  throw new Error('WebCrypto subtle API is required (Node 20+)');
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const CONTACT_INFO = TEXT_ENCODER.encode('contact-share');
const ZERO_SALT_CONTACT = new Uint8Array(16);
const ZERO_SALT_CONV = new Uint8Array(32);
const HKDF_INFO_CONV = TEXT_ENCODER.encode('sentry/conv-token');

function toBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function toBase64Url(buffer) {
  return toBase64(buffer).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(str) {
  const normalized = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = normalized + (pad ? '='.repeat(4 - pad) : '');
  return Buffer.from(padded, 'base64');
}

function randomUidHex() {
  return crypto.randomBytes(7).toString('hex').toUpperCase();
}

function randomPassword() {
  return 'pass-' + crypto.randomBytes(6).toString('hex');
}

async function jsonPost(origin, path, body) {
  const url = path.startsWith('http') ? path : `${origin}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { res, data };
}

async function jsonGet(origin, path) {
  const url = path.startsWith('http') ? path : `${origin}${path}`;
  const res = await fetch(url);
  let data;
  try { data = await res.json(); } catch { data = await res.text(); }
  return { res, data };
}

async function sdmDebugKit(origin, uidHex) {
  const payload = uidHex ? { uidHex } : {};
  const { res, data } = await jsonPost(origin, '/api/v1/auth/sdm/debug-kit', payload);
  if (!res.ok) throw new Error(`sdm.debug-kit failed: ${JSON.stringify(data)}`);
  return data;
}

async function sdmExchange(origin, payload) {
  const { res, data } = await jsonPost(origin, '/api/v1/auth/sdm/exchange', payload);
  if (!res.ok) throw new Error(`sdm.exchange failed: ${JSON.stringify(data)}`);
  return data;
}

async function opaqueRegister(origin, { password, accountDigest, serverId }) {
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const client = new OpaqueClient(cfg);
  const init = await client.registerInit(password);
  if (init instanceof Error) throw init;
  const request_b64 = toBase64(init.serialize());
  const { res: r1, data: d1 } = await jsonPost(origin, '/api/v1/auth/opaque/register-init', { accountDigest, request_b64 });
  if (!r1.ok || !d1?.response_b64) throw new Error(`register-init failed: ${JSON.stringify(d1)}`);
  const resp = RegistrationResponse.deserialize(cfg, Array.from(Buffer.from(d1.response_b64, 'base64')));
  const fin = await client.registerFinish(resp, serverId || undefined, undefined);
  if (fin instanceof Error) throw fin;
  const record_b64 = toBase64(fin.record.serialize());
  const { res: r2, data: d2 } = await jsonPost(origin, '/api/v1/auth/opaque/register-finish', { accountDigest, record_b64 });
  if (r2.status !== 204) throw new Error(`register-finish failed: ${JSON.stringify(d2)}`);
}

async function opaqueLogin(origin, { password, accountDigest, serverId }) {
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const client = new OpaqueClient(cfg);
  const ke1 = await client.authInit(password);
  if (ke1 instanceof Error) throw ke1;
  const ke1_b64 = toBase64(ke1.serialize());
  const { res: r1, data: d1 } = await jsonPost(origin, '/api/v1/auth/opaque/login-init', { accountDigest, ke1_b64 });
  if (!r1.ok || !d1?.ke2_b64 || !d1?.opaqueSession) throw new Error(`login-init failed: ${JSON.stringify(d1)}`);
  const ke2 = KE2.deserialize(cfg, Array.from(Buffer.from(d1.ke2_b64, 'base64')));
  const fin = await client.authFinish(ke2, serverId || undefined, undefined, undefined);
  if (fin instanceof Error) throw fin;
  const ke3_b64 = toBase64(fin.ke3.serialize());
  const { res: r2, data: d2 } = await jsonPost(origin, '/api/v1/auth/opaque/login-finish', { opaqueSession: d1.opaqueSession, ke3_b64 });
  if (!r2.ok || !d2?.ok) throw new Error(`login-finish failed: ${JSON.stringify(d2)}`);
  return d2.session_key_b64;
}

async function bootstrapUser({ origin, label, uidHex, password }) {
  const uid = uidHex || randomUidHex();
  const pwd = password || randomPassword();
  console.log(`[${label}] debug-kit (${uid})`);
  const kit = await sdmDebugKit(origin, uid);
  console.log(`[${label}] exchange`);
  const ex = await sdmExchange(origin, {
    uid: kit.uidHex,
    sdmmac: kit.sdmmac,
    sdmcounter: kit.sdmcounter,
    nonce: kit.nonce || `debug-${Date.now()}`
  });

  const accountDigest = String(ex.accountDigest || ex.account_digest || '').toUpperCase();
  const accountToken = ex.accountToken || ex.account_token;
  if (!accountToken || !accountDigest) throw new Error('missing account credentials');
  const serverId = ex.opaqueServerId || ex.opaque_server_id || null;

  console.log(`[${label}] OPAQUE register/login`);
  await opaqueRegister(origin, { password: pwd, accountDigest, serverId });
  await opaqueLogin(origin, { password: pwd, accountDigest, serverId });

  console.log(`[${label}] publish prekeys & store devkeys`);
  await publishPrekeys(origin, { uidHex: kit.uidHex, accountToken, accountDigest });
  await storeDevkeys(origin, { uidHex: kit.uidHex, accountToken, accountDigest });

  return {
    uidHex: kit.uidHex,
    accountToken,
    accountDigest,
    password: pwd,
    opaqueServerId: serverId
  };
}

async function publishPrekeys(origin, { uidHex, accountToken, accountDigest, count = 10 }) {
  const bundle = {
    ik_pub: toBase64(crypto.randomBytes(32)),
    spk_pub: toBase64(crypto.randomBytes(32)),
    spk_sig: toBase64(crypto.randomBytes(64)),
    opks: Array.from({ length: count }, (_, i) => ({ id: i + 1, pub: toBase64(crypto.randomBytes(32)) }))
  };
  const { res, data } = await jsonPost(origin, '/api/v1/keys/publish', {
    uidHex,
    accountToken,
    accountDigest,
    bundle
  });
  if (res.status !== 204) throw new Error(`keys.publish failed: ${JSON.stringify(data)}`);
}

async function storeDevkeys(origin, { uidHex, accountToken, accountDigest }) {
  const wrapped_dev = {
    v: 1,
    aead: 'aes-256-gcm',
    info: 'devkeys/v1',
    salt_b64: toBase64(crypto.randomBytes(16)),
    iv_b64: toBase64(crypto.randomBytes(12)),
    ct_b64: toBase64(crypto.randomBytes(64))
  };
  const { res, data } = await jsonPost(origin, '/api/v1/devkeys/store', {
    uidHex,
    accountToken,
    accountDigest,
    wrapped_dev
  });
  if (res.status !== 204) throw new Error(`devkeys.store failed: ${JSON.stringify(data)}`);
}

async function createFriendInvite(origin, user, ttlSeconds = 300) {
  const { res, data } = await jsonPost(origin, '/api/v1/friends/invite', {
    uidHex: user.uidHex,
    accountToken: user.accountToken,
    accountDigest: user.accountDigest,
    ttlSeconds
  });
  if (!res.ok) throw new Error(`friends.invite failed: ${JSON.stringify(data)}`);
  if (!data?.inviteId || !data?.secret) throw new Error('invite response incomplete');
  return {
    inviteId: data.inviteId,
    secret: data.secret,
    ownerUid: (data.ownerUid || data.owner_uid || user.uidHex).toUpperCase(),
    expiresAt: data.expiresAt || data.expires_at || null,
    prekeyBundle: data.prekeyBundle || data.prekey_bundle || null
  };
}

async function attachInviteContact(origin, { inviteId, secret, payload }) {
  const envelope = await encryptContactPayload(secret, payload);
  const { res, data } = await jsonPost(origin, '/api/v1/friends/invite/contact', {
    inviteId,
    secret,
    envelope
  });
  if (!res.ok) throw new Error(`friends.invite.contact failed: ${JSON.stringify(data)}`);
}

async function acceptFriendInvite(origin, user, { inviteId, secret, contactPayload }) {
  let contactEnvelope = null;
  if (contactPayload) {
    contactEnvelope = await encryptContactPayload(secret, contactPayload);
  }
  const { res, data } = await jsonPost(origin, '/api/v1/friends/accept', {
    inviteId,
    secret,
    myUid: user.uidHex,
    accountToken: user.accountToken,
    accountDigest: user.accountDigest,
    contactEnvelope
  });
  if (!res.ok) throw new Error(`friends.accept failed: ${JSON.stringify(data)}`);
  return data;
}

async function encryptContactPayload(secretB64, payload) {
  if (!secretB64) throw new Error('secret required');
  const secretBytes = fromBase64Url(secretB64);
  const baseKey = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: ZERO_SALT_CONTACT, info: CONTACT_INFO }, baseKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = crypto.randomBytes(12);
  const plain = TEXT_ENCODER.encode(JSON.stringify(payload));
  const ct = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return { iv: toBase64(iv), ct: toBase64(ct) };
}

async function deriveConversationContext(secretB64) {
  const secretBytes = fromBase64Url(secretB64);
  const baseKey = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: ZERO_SALT_CONV, info: HKDF_INFO_CONV }, baseKey, 256);
  const tokenBytes = Buffer.from(bits);
  const tokenB64 = toBase64Url(tokenBytes);
  const digest = crypto.createHash('sha256').update(tokenBytes).digest();
  const conversationId = toBase64Url(digest).slice(0, 44);
  return { tokenB64, conversationId };
}

async function encryptConversationEnvelope(tokenB64, payload) {
  const tokenBytes = fromBase64Url(tokenB64);
  const key = await subtle.importKey('raw', tokenBytes, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.randomBytes(12);
  const plain = TEXT_ENCODER.encode(JSON.stringify(payload));
  const ct = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    v: 1,
    iv_b64: toBase64Url(iv),
    payload_b64: toBase64Url(ct)
  };
}

function buildContactPayload({ nickname, conversationId, tokenB64 }) {
  return {
    nickname: nickname || `好友-${crypto.randomBytes(2).toString('hex')}`,
    avatar: null,
    addedAt: Math.floor(Date.now() / 1000),
    conversation: {
      token_b64: tokenB64,
      conversation_id: conversationId
    }
  };
}

async function sendSecureMessage(origin, { conversationId, tokenB64, senderUid, text }) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    hdr_b64: toBase64Url(TEXT_ENCODER.encode(JSON.stringify({ from: senderUid }))),
    ct_b64: toBase64Url(TEXT_ENCODER.encode(text)),
    meta: {
      ts,
      sender_fingerprint: toBase64Url(crypto.createHmac('sha256', fromBase64Url(tokenB64)).update(senderUid.toUpperCase()).digest()),
      msg_type: 'text'
    }
  };
  const envelope = await encryptConversationEnvelope(tokenB64, payload);
  const { res, data } = await jsonPost(origin, '/api/v1/messages/secure', {
    conversation_id: conversationId,
    payload_envelope: envelope,
    created_at: ts
  });
  if (res.status !== 202) throw new Error(`messages.secure failed: ${JSON.stringify(data)}`);
  return data;
}

export async function setupFriendConversation({
  origin,
  userA = {},
  userB = {},
  messageFromA = 'Hello from A',
  messageFromB = 'Reply from B'
}) {
  const userAData = await bootstrapUser({ origin, label: 'A', uidHex: userA.uidHex, password: userA.password });
  const userBData = await bootstrapUser({ origin, label: 'B', uidHex: userB.uidHex, password: userB.password });

  const invite = await createFriendInvite(origin, userAData);
  const conversation = await deriveConversationContext(invite.secret);

  const ownerPayload = buildContactPayload({
    nickname: userA.nickname || '使用者A',
    conversationId: conversation.conversationId,
    tokenB64: conversation.tokenB64
  });
  await attachInviteContact(origin, {
    inviteId: invite.inviteId,
    secret: invite.secret,
    payload: ownerPayload
  });

  const guestPayload = buildContactPayload({
    nickname: userB.nickname || '使用者B',
    conversationId: conversation.conversationId,
    tokenB64: conversation.tokenB64
  });

  await acceptFriendInvite(origin, userBData, {
    inviteId: invite.inviteId,
    secret: invite.secret,
    contactPayload: guestPayload
  });

  await sendSecureMessage(origin, {
    conversationId: conversation.conversationId,
    tokenB64: conversation.tokenB64,
    senderUid: userAData.uidHex,
    text: messageFromA
  });

  await sendSecureMessage(origin, {
    conversationId: conversation.conversationId,
    tokenB64: conversation.tokenB64,
    senderUid: userBData.uidHex,
    text: messageFromB
  });

  return {
    userA: userAData,
    userB: userBData,
    conversation,
    invite
  };
}
