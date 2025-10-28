import crypto from 'node:crypto';
import { OpaqueClient, getOpaqueConfig, OpaqueID } from '@cloudflare/opaque-ts/lib/src/index.js';
import { KE2, RegistrationResponse } from '@cloudflare/opaque-ts/lib/src/messages.js';
import {
  generateInitialBundle,
  wrapDevicePrivWithMK
} from '../../web/src/shared/crypto/prekeys.js';
import { x3dhInitiate, x3dhRespond } from '../../web/src/shared/crypto/dr.js';
import {
  deriveConversationContextFromSecret,
  encryptConversationEnvelope,
  decryptConversationEnvelope,
  computeConversationFingerprint
} from '../../web/src/shared/conversation/context.js';
import {
  encryptContactPayload as encryptContactPayloadShared,
  decryptContactPayload as decryptContactPayloadShared
} from '../../web/src/shared/contacts/contact-share.js';
import {
  bytesToB64,
  bytesToB64Url,
  b64ToBytes,
  b64UrlToBytes
} from '../../web/src/shared/utils/base64.js';
import { wrapMKWithPasswordArgon2id } from './argon2-wrap.mjs';

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function randomUidHex() {
  return crypto.randomBytes(7).toString('hex').toUpperCase();
}

function randomPassword() {
  return `pass-${crypto.randomBytes(8).toString('hex')}`;
}

function encodeU8(value) {
  return value instanceof Uint8Array ? bytesToB64(value) : null;
}

function serializeDrState(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    rk_b64: encodeU8(state.rk),
    ckS_b64: encodeU8(state.ckS),
    ckR_b64: encodeU8(state.ckR),
    Ns: Number(state.Ns || 0),
    Nr: Number(state.Nr || 0),
    PN: Number(state.PN || 0),
    myRatchetPriv_b64: encodeU8(state.myRatchetPriv),
    myRatchetPub_b64: encodeU8(state.myRatchetPub),
    theirRatchetPub_b64: encodeU8(state.theirRatchetPub),
    pendingSendRatchet: !!state.pendingSendRatchet
  };
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
  const request_b64 = bytesToB64(init.serialize());
  const { res: r1, data: d1 } = await jsonPost(origin, '/api/v1/auth/opaque/register-init', { accountDigest, request_b64 });
  if (!r1.ok || !d1?.response_b64) throw new Error(`register-init failed: ${JSON.stringify(d1)}`);
  const resp = RegistrationResponse.deserialize(cfg, Array.from(b64ToBytes(d1.response_b64)));
  const fin = await client.registerFinish(resp, serverId || undefined, undefined);
  if (fin instanceof Error) throw fin;
  const record_b64 = bytesToB64(fin.record.serialize());
  const { res: r2, data: d2 } = await jsonPost(origin, '/api/v1/auth/opaque/register-finish', { accountDigest, record_b64 });
  if (r2.status !== 204) throw new Error(`register-finish failed: ${JSON.stringify(d2)}`);
}

async function opaqueLogin(origin, { password, accountDigest, serverId }) {
  const cfg = getOpaqueConfig(OpaqueID.OPAQUE_P256);
  const client = new OpaqueClient(cfg);
  const ke1 = await client.authInit(password);
  if (ke1 instanceof Error) throw ke1;
  const ke1_b64 = bytesToB64(ke1.serialize());
  const { res: r1, data: d1 } = await jsonPost(origin, '/api/v1/auth/opaque/login-init', { accountDigest, ke1_b64 });
  if (!r1.ok || !d1?.ke2_b64 || !d1?.opaqueSession) throw new Error(`login-init failed: ${JSON.stringify(d1)}`);
  const ke2 = KE2.deserialize(cfg, Array.from(b64ToBytes(d1.ke2_b64)));
  const fin = await client.authFinish(ke2, serverId || undefined, undefined, undefined);
  if (fin instanceof Error) throw fin;
  const ke3_b64 = bytesToB64(fin.ke3.serialize());
  const { res: r2, data: d2 } = await jsonPost(origin, '/api/v1/auth/opaque/login-finish', { opaqueSession: d1.opaqueSession, ke3_b64 });
  if (!r2.ok || !d2?.ok) throw new Error(`login-finish failed: ${JSON.stringify(d2)}`);
  return d2.session_key_b64;
}

async function publishBundle(origin, { uidHex, accountToken, accountDigest, bundle }) {
  const { res, data } = await jsonPost(origin, '/api/v1/keys/publish', {
    uidHex,
    accountToken,
    accountDigest,
    bundle
  });
  if (res.status !== 204) throw new Error(`keys.publish failed: ${JSON.stringify(data)}`);
}

async function storeDevkeys(origin, { accountToken, accountDigest, wrapped_dev }) {
  const { res, data } = await jsonPost(origin, '/api/v1/devkeys/store', {
    accountToken,
    accountDigest,
    wrapped_dev
  });
  if (res.status !== 204) throw new Error(`devkeys.store failed: ${JSON.stringify(data)}`);
}

async function mkStore(origin, { session, uidHex, accountToken, accountDigest, wrapped_mk }) {
  const payload = {
    uidHex,
    wrapped_mk
  };
  if (session) payload.session = session;
  if (accountToken) payload.accountToken = accountToken;
  if (accountDigest) payload.accountDigest = accountDigest;
  const { res, data } = await jsonPost(origin, '/api/v1/mk/store', payload);
  if (res.status !== 204) throw new Error(`mk.store failed: ${JSON.stringify(data)}`);
}

export async function bootstrapUser({ origin, label, uidHex, password }) {
  const uid = uidHex || randomUidHex();
  const pwd = password || randomPassword();
  const kit = await sdmDebugKit(origin, uid);
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

  await opaqueRegister(origin, { password: pwd, accountDigest, serverId });
  await opaqueLogin(origin, { password: pwd, accountDigest, serverId });

  const mk = crypto.randomBytes(32);
  const wrapped_mk = await wrapMKWithPasswordArgon2id(pwd, mk);
  await mkStore(origin, {
    session: ex.session || null,
    uidHex: kit.uidHex,
    accountToken,
    accountDigest,
    wrapped_mk
  });

  const { devicePriv, bundlePub } = await generateInitialBundle(1, 40);
  await publishBundle(origin, { uidHex: kit.uidHex, accountToken, accountDigest, bundle: bundlePub });

  const wrapped_dev = await wrapDevicePrivWithMK(devicePriv, mk);
  await storeDevkeys(origin, { accountToken, accountDigest, wrapped_dev });
  // eslint-disable-next-line no-console
  console.log('[friends-flow] devkeys stored for', kit.uidHex);

  return {
    uidHex: kit.uidHex,
    accountToken,
    accountDigest,
    password: pwd,
    opaqueServerId: serverId,
    devicePriv,
    bundlePub,
    mk,
    wrappedMK: wrapped_mk,
    wrappedDev: wrapped_dev
  };
}

function buildContactPayload({ nickname, conversation, drInit }) {
  const base = {
    nickname: nickname || `好友-${crypto.randomBytes(2).toString('hex')}`,
    avatar: null,
    addedAt: Math.floor(Date.now() / 1000)
  };
  if (conversation) {
    base.conversation = { ...conversation };
    if (drInit) base.conversation.dr_init = drInit;
  }
  return base;
}

function normalizeOwnerBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('owner bundle missing');
  const ik = String(bundle.ik_pub || bundle.ik || '').trim();
  const spk = String(bundle.spk_pub || bundle.spk || '').trim();
  const sig = String(bundle.spk_sig || '').trim();
  if (!ik || !spk || !sig) throw new Error('owner bundle invalid');
  const out = { ik_pub: ik, spk_pub: spk, spk_sig: sig };
  if (bundle.opk && bundle.opk.id != null && bundle.opk.pub) {
    out.opk = { id: bundle.opk.id, pub: bundle.opk.pub };
  }
  return out;
}

function buildGuestBundle(devicePriv, ownerBundle, x3dhState) {
  const ekPub = x3dhState?.myRatchetPub instanceof Uint8Array ? x3dhState.myRatchetPub : new Uint8Array();
  const bundle = {
    ik_pub: devicePriv.ik_pub_b64,
    ek_pub: bytesToB64(ekPub)
  };
  if (devicePriv.spk_pub_b64) bundle.spk_pub = devicePriv.spk_pub_b64;
  if (ownerBundle?.opk && ownerBundle.opk.id != null) bundle.opk_id = ownerBundle.opk.id;
  return bundle;
}

function buildConversationInfo(conversation) {
  return {
    token_b64: conversation.tokenB64,
    conversation_id: conversation.conversationId
  };
}

export async function setupFriendConversation({ origin, userA = {}, userB = {} }) {
  const userAData = await bootstrapUser({ origin, label: 'A', uidHex: userA.uidHex, password: userA.password });
  const userBData = await bootstrapUser({ origin, label: 'B', uidHex: userB.uidHex, password: userB.password });

  const invite = await createFriendInvite(origin, userAData);
  const conversation = await deriveConversationContextFromSecret(invite.secret);

  const ownerPayload = buildContactPayload({
    nickname: userA.nickname || '使用者A',
    conversation: buildConversationInfo(conversation)
  });
  await attachInviteContact(origin, {
    inviteId: invite.inviteId,
    secret: invite.secret,
    payload: ownerPayload
  });

  const ownerBundle = normalizeOwnerBundle(invite.prekeyBundle);
  const bundleForInitiate = ownerBundle.opk ? { ...ownerBundle, opk: null } : ownerBundle;
  const guestState = await x3dhInitiate(userBData.devicePriv, bundleForInitiate);
  const guestBundle = buildGuestBundle(userBData.devicePriv, ownerBundle, guestState);
  const ownerState = await x3dhRespond(userAData.devicePriv, guestBundle);
  // eslint-disable-next-line no-console
  const drInit = { guest_bundle: guestBundle, role: 'initiator' };
  const guestPayload = buildContactPayload({
    nickname: userB.nickname || '使用者B',
    conversation: buildConversationInfo(conversation),
    drInit
  });

  await acceptFriendInvite(origin, userBData, {
    inviteId: invite.inviteId,
    secret: invite.secret,
    contactPayload: guestPayload,
    guestBundle
  });

  return {
    userA: userAData,
    userB: userBData,
    conversation: {
      ...conversation,
      drInit,
      initiatorDrState: serializeDrState(guestState),
      responderDrState: serializeDrState(ownerState)
    },
    invite
  };
}

function normalizeErrorCode(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      return normalizeErrorCode(parsed);
    } catch {
      return null;
    }
  }
  if (typeof payload === 'object') {
    const nested = normalizeErrorCode(payload.details);
    if (nested) return nested;
    return payload.error || payload.code || null;
  }
  return null;
}

async function rotateOwnerPrekeys({ origin, user, count = 40 }) {
  const startId = Number(user?.devicePriv?.next_opk_id || user?.devicePriv?.nextOpkId || 1);
  const { devicePriv, bundlePub } = await generateInitialBundle(startId, count);
  await publishBundle(origin, {
    uidHex: user.uidHex,
    accountToken: user.accountToken,
    accountDigest: user.accountDigest,
    bundle: bundlePub
  });
  if (user?.mk) {
    const wrappedDev = await wrapDevicePrivWithMK(devicePriv, user.mk);
    await storeDevkeys(origin, {
      accountToken: user.accountToken,
      accountDigest: user.accountDigest,
      wrapped_dev: wrappedDev
    });
    // eslint-disable-next-line no-console
    console.log('[friends-flow] rotated devkeys stored for', user.uidHex);
    user.wrappedDev = wrappedDev;
  }
  user.devicePriv = devicePriv;
  user.bundlePub = bundlePub;
  return true;
}

async function createFriendInvite(origin, user, ttlSeconds = 300, attempt = 0) {
  const { res, data } = await jsonPost(origin, '/api/v1/friends/invite', {
    uidHex: user.uidHex,
    accountToken: user.accountToken,
    accountDigest: user.accountDigest,
    ttlSeconds
  });
  if (!res.ok) {
    const code = normalizeErrorCode(data);
    if (code === 'PrekeyUnavailable' && attempt < 2) {
      await rotateOwnerPrekeys({ origin, user, count: 40 });
      return createFriendInvite(origin, user, ttlSeconds, attempt + 1);
    }
    throw new Error(`friends.invite failed: ${JSON.stringify(data)}`);
  }
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
  const envelope = await encryptContactPayloadShared({ secret, payload });
  const { res, data } = await jsonPost(origin, '/api/v1/friends/invite/contact', {
    inviteId,
    secret,
    envelope
  });
  if (!res.ok) throw new Error(`friends.invite.contact failed: ${JSON.stringify(data)}`);
}

async function acceptFriendInvite(origin, user, { inviteId, secret, contactPayload, guestBundle }) {
  let contactEnvelope = null;
  if (contactPayload) {
    contactEnvelope = await encryptContactPayloadShared({ secret, payload: contactPayload });
  }
  const { res, data } = await jsonPost(origin, '/api/v1/friends/accept', {
    inviteId,
    secret,
    myUid: user.uidHex,
    accountToken: user.accountToken,
    accountDigest: user.accountDigest,
    contactEnvelope,
    guestBundle
  });
  if (!res.ok) throw new Error(`friends.accept failed: ${JSON.stringify(data)}`);
  return data;
}

export const encryptContactPayload = encryptContactPayloadShared;
export const decryptContactPayload = decryptContactPayloadShared;
