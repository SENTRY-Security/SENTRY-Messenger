import crypto from 'node:crypto';
import { toU8Strict } from './u8-strict.js';

// ---- 基本工具與正規化 ----
const textEncoder = new TextEncoder();
const INVITE_INFO_TAG = 'contact-init/dropbox/v1';

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i += 1) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function b64ToBytes(str) {
  if (!str) return null;
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64UrlToBytes(str) {
  if (!str) return null;
  const padded = str.length % 4 ? str + '==='.slice(str.length % 4) : str;
  return b64ToBytes(padded.replace(/-/g, '+').replace(/_/g, '/'));
}

function b64ToU8(b64) {
  try {
    const bin = atob(String(b64 || ''));
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u8[i] = bin.charCodeAt(i);
    return u8;
  } catch {
    return null;
  }
}

async function verifySignedPrekey({ spk_pub_b64, spk_sig_b64, ik_pub_b64 }) {
  if (!spk_pub_b64 || !spk_sig_b64 || !ik_pub_b64) return false;
  const spkPub = b64ToU8(spk_pub_b64);
  const spkSig = b64ToU8(spk_sig_b64);
  const ikPub = b64ToU8(ik_pub_b64);
  if (!spkPub || !spkSig || !ikPub) return false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      toU8Strict(ikPub, 'data-worker/src/worker.js:60:verifySignedPrekey'),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, spkSig, spkPub);
  } catch {
    return false;
  }
}

function normalizeAccountDigest(value) {
  const cleaned = String(value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (cleaned.length !== 64) return null;
  return cleaned;
}

function normalizeDeviceId(value) {
  if (!value || typeof value !== 'string') return null;
  const token = value.trim();
  if (!token) return null;
  return token.slice(0, 120);
}

function normalizeUid(uid) {
  const cleaned = String(uid || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return cleaned.length >= 14 ? cleaned : null;
}

function json(obj, init) {
  return new Response(JSON.stringify(obj), {
    ...(init || {}),
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function verifyHMAC(req, env) {
  const sig = req.headers.get('x-auth') || '';
  if (!sig || !env.HMAC_SECRET) return false;
  const url = new URL(req.url);
  const body = req.method === 'GET' ? '' : await req.clone().text();
  const msgPipe = url.pathname + url.search + '|' + body;
  const msgNewline = url.pathname + url.search + '\n' + body;

  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(new TextEncoder().encode(env.HMAC_SECRET), 'data-worker/src/worker.js:106:verifyHMAC'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const encode = async (input) => {
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
    return btoa(String.fromCharCode(...new Uint8Array(mac)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const [sigPipe, sigNewline] = await Promise.all([encode(msgPipe), encode(msgNewline)]);
  return timingSafeEqual(sig, sigPipe) || timingSafeEqual(sig, sigNewline);
}

// ---- 帳號與 MK / TAGS 相關共用 ----
let dataTablesReady = false;

function bytesToHex(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += u8[i].toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

function hexToBytes(hex) {
  const cleaned = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  if (cleaned.length % 2 === 1) {
    throw new Error('hexToBytes: invalid length');
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToBase64Url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) {
    bin += String.fromCharCode(u8[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function safeJSON(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function normalizeHashHex(value, { maxLen = 128, minLen = 8 } = {}) {
  if (!value || typeof value !== 'string') return null;
  const cleaned = value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (!cleaned.length || cleaned.length < minLen) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function normalizeConversationId(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  if (!/^[A-Za-z0-9_:-]{8,128}$/.test(token)) return null;
  return token;
}

function normalizeMessageId(value) {
  if (value === null || value === undefined) return null;
  const token = String(value || '').trim();
  if (!token) return null;
  if (token.length < 8 || token.length > 200) return null;
  return token;
}

function normalizeEnvelope(input) {
  if (!input || typeof input !== 'object') return null;
  const iv = typeof input.iv === 'string' ? input.iv.trim() : '';
  const ct = typeof input.ct === 'string' ? input.ct.trim() : '';
  if (!iv || !ct) return null;
  if (iv.length < 8 || ct.length < 8) return null;
  return { iv, ct };
}

function safeParseEnvelope(json) {
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    return normalizeEnvelope(obj);
  } catch {
    return null;
  }
}

function parseBackupPayload(rawPayload) {
  const parsed = safeJSON(rawPayload);
  if (parsed && typeof parsed === 'object' && parsed.payload && parsed.meta && parsed.payload.aead) {
    const withDrStateMeta = Number.isFinite(Number(parsed.meta?.withDrState)) ? Number(parsed.meta.withDrState) : null;
    return { payload: parsed.payload, withDrState: withDrStateMeta };
  }
  const withDrStateInline = Number.isFinite(Number(parsed?.withDrState)) ? Number(parsed.withDrState) : null;
  return { payload: parsed, withDrState: withDrStateInline };
}

function normalizeOpk(opk) {
  if (!opk || typeof opk !== 'object') return null;
  const allowed = new Set(['id', 'pub']);
  for (const key of Object.keys(opk)) {
    if (!allowed.has(key)) return null;
  }
  const id = Number(opk.id);
  const pub = typeof opk.pub === 'string' ? opk.pub.trim() : null;
  if (!Number.isFinite(id) || !pub) return null;
  return { id, pub: pub.slice(0, 4096) };
}

function normalizeSignedPrekey(spk) {
  if (!spk || typeof spk !== 'object') return null;
  const allowed = new Set(['id', 'pub', 'sig', 'ik_pub']);
  for (const key of Object.keys(spk)) {
    if (!allowed.has(key)) return null;
  }
  const id = Number(spk.id);
  const pub = typeof spk.pub === 'string' ? spk.pub.trim() : null;
  const sig = typeof spk.sig === 'string' ? spk.sig.trim() : null;
  const ikPub = typeof spk.ik_pub === 'string' ? spk.ik_pub.trim() : null;
  if (!Number.isFinite(id) || !pub || !sig || !ikPub) return null;
  return {
    id,
    pub: pub.slice(0, 4096),
    sig: sig.slice(0, 4096),
    ik_pub: ikPub.slice(0, 4096)
  };
}

function normalizeGroupId(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
  return token;
}

function normalizeGroupName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function normalizeGroupRole(value) {
  const role = String(value || '').toLowerCase();
  if (role === 'owner' || role === 'admin') return role;
  return 'member';
}

function normalizeGroupStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['active', 'left', 'kicked', 'removed'].includes(status)) return status;
  return null;
}

function normalizeGroupAvatar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return null; }
  }
  return null;
}

function normalizeInviteDropboxEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const allowedKeys = new Set(['v', 'aead', 'info', 'sealed', 'createdAt', 'expiresAt']);
  for (const key of Object.keys(envelope)) {
    if (!allowedKeys.has(key)) return null;
  }
  const v = Number(envelope.v ?? 0);
  const aead = String(envelope.aead || '').trim();
  const info = String(envelope.info || '').trim();
  const createdAt = Number(envelope.createdAt || 0);
  const expiresAt = Number(envelope.expiresAt || 0);
  if (!Number.isFinite(v) || v !== 1) return null;
  if (aead !== 'aes-256-gcm') return null;
  if (info !== INVITE_INFO_TAG) return null;
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  const sealed = envelope.sealed;
  if (!sealed || typeof sealed !== 'object') return null;
  const sealedAllowed = new Set(['eph_pub_b64', 'iv_b64', 'ct_b64']);
  for (const key of Object.keys(sealed)) {
    if (!sealedAllowed.has(key)) return null;
  }
  const ephPub = String(sealed.eph_pub_b64 || '').trim();
  const iv = String(sealed.iv_b64 || '').trim();
  const ct = String(sealed.ct_b64 || '').trim();
  if (!ephPub || !iv || !ct) return null;
  return {
    v,
    aead,
    info,
    sealed: {
      eph_pub_b64: ephPub,
      iv_b64: iv,
      ct_b64: ct
    },
    createdAt,
    expiresAt
  };
}

const INVITE_DELIVER_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest',
  'device_id',
  'ciphertext_envelope'
]);
const INVITE_CONSUME_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest',
  'device_id',
  'ciphertext_envelope'
]);
const INVITE_STATUS_ALIAS_FIELDS = new Set([
  'invite_id',
  'account_token',
  'account_digest'
]);
const INVITE_DELIVER_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest',
  'deviceId',
  'ciphertextEnvelope'
]);
const INVITE_CONSUME_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest',
  'deviceId'
]);
const INVITE_STATUS_ALLOWED_FIELDS = new Set([
  'inviteId',
  'accountToken',
  'accountDigest'
]);

function findAliasKey(payload, aliasKeys) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of Object.keys(payload)) {
    if (aliasKeys.has(key)) return key;
  }
  return null;
}

function findUnexpectedKey(payload, allowedKeys) {
  if (!payload || typeof payload !== 'object') return null;
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) return key;
  }
  return null;
}

function inviteAliasError(key) {
  return json(
    { error: 'BadRequest', code: 'InviteSchemaMismatch', message: `alias field not allowed: ${key}`, field: key },
    { status: 400 }
  );
}

function inviteUnexpectedFieldError(key) {
  return json(
    { error: 'BadRequest', code: 'InviteSchemaMismatch', message: `unexpected field: ${key}`, field: key },
    { status: 400 }
  );
}

async function allocateOwnerPrekeyBundle(env, ownerAccountDigest, preferredDeviceId = null) {
  if (!ownerAccountDigest) return null;
  let deviceId = normalizeDeviceId(preferredDeviceId);

  if (!deviceId) {
    const devRow = await env.DB.prepare(
      `SELECT device_id FROM devices
         WHERE account_digest=?1
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1`
    ).bind(ownerAccountDigest).first();
    deviceId = normalizeDeviceId(devRow?.device_id);
  }
  if (!deviceId) return null;

  const spkRow = await env.DB.prepare(
    `SELECT spk_id, spk_pub, spk_sig, ik_pub
       FROM device_signed_prekeys
      WHERE account_digest=?1 AND device_id=?2
      ORDER BY spk_id DESC
      LIMIT 1`
  ).bind(ownerAccountDigest, deviceId).first();
  if (!spkRow) return null;
  const ikPub = spkRow.ik_pub || null;
  if (!ikPub) return null; // 嚴格要求當前設備簽名鍵附帶 IK，不再嘗試備份回填

  let opk = null;
  const opkRow = await env.DB.prepare(
    `SELECT opk_id, opk_pub
       FROM device_opks
      WHERE account_digest=?1 AND device_id=?2 AND consumed_at IS NULL
      ORDER BY opk_id ASC
      LIMIT 1`
  ).bind(ownerAccountDigest, deviceId).first();
  if (!opkRow) {
    console.warn('allocate_owner_bundle_opk_missing', { ownerAccountDigest, deviceId });
    return null;
  }
  await env.DB.prepare(
    `UPDATE device_opks SET consumed_at=strftime('%s','now')
       WHERE account_digest=?1 AND device_id=?2 AND opk_id=?3`
  ).bind(ownerAccountDigest, deviceId, opkRow.opk_id).run();
  opk = { id: Number(opkRow.opk_id), pub: String(opkRow.opk_pub || '') };

  return {
    device_id: deviceId,
    ik_pub: ikPub,
    spk_pub: String(spkRow.spk_pub || ''),
    spk_sig: String(spkRow.spk_sig || ''),
    opk
  };
}

async function grantConversationAccess(env, { conversationId, accountDigest, deviceId = null, role = 'member' }) {
  if (!conversationId || !accountDigest) return;
  await ensureDataTables(env);
  try {
    await env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET
        role = COALESCE(excluded.role, conversation_acl.role),
        updated_at = strftime('%s','now')
    `).bind(conversationId, accountDigest, deviceId, role || null).run();
  } catch (err) {
    console.warn('conversation_acl_upsert_failed', err?.message || err);
  }
}

async function deleteContactByPeer(env, convId, _targetUid, targetAccountDigest = null) {
  if (!convId || !targetAccountDigest) return 0;
  const acctParam = targetAccountDigest ? targetAccountDigest.toUpperCase() : null;
  let total = 0;
  try {
    const resSecure = await env.DB.prepare(`
      DELETE FROM messages_secure
       WHERE conversation_id=?1
         AND json_extract(header_json,'$.contact') = 1
         AND (
           ( ?2 IS NOT NULL AND UPPER(json_extract(header_json,'$.peerAccountDigest')) = ?2 )
         )
    `).bind(convId, acctParam).run();
    total += resSecure?.meta?.changes || 0;
  } catch (err) {
    console.warn('delete_contact_secure_failed', err?.message || err);
  }
  try {
    const resLegacy = await env.DB.prepare(`
      DELETE FROM messages
       WHERE conv_id=?1
         AND json_extract(header_json,'$.contact') = 1
         AND (
           ( ?2 IS NOT NULL AND UPPER(json_extract(header_json,'$.peerAccountDigest')) = ?2 )
         )
    `).bind(convId, acctParam).run();
    total += resLegacy?.meta?.changes || 0;
  } catch (err) {
    console.warn('delete_contact_legacy_failed', err?.message || err);
  }
  return total;
}

async function insertContactMessage(env, { convAccountDigest, peerAccountDigest, envelope, ts, messageId }) {
  await ensureDataTables(env);
  const normalized = normalizeEnvelope(envelope);
  if (!normalized) return;

  const convAcctNorm = normalizeAccountDigest(convAccountDigest);
  if (!convAcctNorm) return;
  const peerAcctNorm = normalizeAccountDigest(peerAccountDigest);

  const convId = `contacts-${convAcctNorm}`;
  const senderDeviceId = 'contacts-system';
  const senderAccountDigest = peerAcctNorm || convAcctNorm;
  const receiverAccountDigest = convAcctNorm;
  const createdAt = Number.isFinite(ts) && ts > 0 ? ts : Math.floor(Date.now() / 1000);

  let counter = 1;
  try {
    const row = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
    `).bind(convId, senderAccountDigest, senderDeviceId).first();
    const maxCounter = Number(row?.max_counter ?? 0);
    if (Number.isFinite(maxCounter) && maxCounter > 0) counter = maxCounter + 1;
  } catch (err) {
    console.warn('contact_counter_lookup_failed', err?.message || err);
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ivB64 = bytesToBase64Url(iv);
  const header = {
    contact: 1,
    v: 1,
    peerAccountDigest: peerAcctNorm,
    ts: createdAt,
    envelope: normalized,
    iv_b64: ivB64,
    n: counter,
    device_id: senderDeviceId
  };
  const headerJson = JSON.stringify(header);
  const ciphertextB64 = bytesToBase64Url(new TextEncoder().encode(headerJson));
  if (!messageId) {
    throw new Error('messageId required for contact message');
  }

  await env.DB.prepare(
    `INSERT OR IGNORE INTO conversations(id) VALUES (?1)`
  ).bind(convId).run();

  try {
    await env.DB.prepare(`
      INSERT INTO messages_secure (
        id, conversation_id, sender_account_digest, sender_device_id,
        receiver_account_digest, receiver_device_id, header_json, ciphertext_b64,
        counter, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
      messageId,
      convId,
      senderAccountDigest,
      senderDeviceId,
      receiverAccountDigest,
      null,
      headerJson,
      ciphertextB64,
      counter,
      createdAt
    ).run();
  } catch (err) {
    console.warn('contact_message_insert_failed', err?.message || err);
  }
}

async function removeConversationAccess(env, { conversationId, accountDigest }) {
  if (!conversationId || !accountDigest) return;
  await ensureDataTables(env);
  try {
    await env.DB.prepare(
      `DELETE FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2`
    ).bind(conversationId, accountDigest).run();
  } catch (err) {
    console.warn('conversation_acl_delete_failed', err?.message || err);
  }
}

async function upsertGroupMember(env, {
  groupId,
  accountDigest,
  role = 'member',
  status = 'active',
  inviterAccountDigest = null,
  joinedAt = null
} = {}) {
  if (!groupId || !accountDigest) return false;
  const normalizedRole = normalizeGroupRole(role);
  const normalizedStatus = normalizeGroupStatus(status) || 'active';
  const joined = Number.isFinite(Number(joinedAt)) && Number(joinedAt) > 0
    ? Math.floor(Number(joinedAt))
    : Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO group_members (
        group_id, account_digest, role, status,
        inviter_account_digest, joined_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(group_id, account_digest) DO UPDATE SET
        role=excluded.role,
        status=excluded.status,
        inviter_account_digest=COALESCE(excluded.inviter_account_digest, group_members.inviter_account_digest),
        joined_at=COALESCE(group_members.joined_at, excluded.joined_at),
        updated_at=strftime('%s','now')
    `).bind(
      groupId,
      accountDigest,
      normalizedRole,
      normalizedStatus,
      inviterAccountDigest || null,
      joined
    ).run();
    return true;
  } catch (err) {
    console.warn('group_member_upsert_failed', err?.message || err);
    return false;
  }
}

async function fetchGroupWithMembers(env, groupId) {
  if (!groupId) return null;
  await ensureDataTables(env);
  const groupRows = await env.DB.prepare(
    `SELECT group_id, conversation_id, creator_account_digest, name, avatar_json, created_at, updated_at
       FROM groups WHERE group_id=?1`
  ).bind(groupId).all();
  const group = groupRows?.results?.[0] || null;
  if (!group) return null;
  const membersRes = await env.DB.prepare(
    `SELECT group_id, account_digest, role, status, inviter_account_digest,
            joined_at, muted_until, last_read_ts, created_at, updated_at
       FROM group_members
      WHERE group_id=?1`
  ).bind(groupId).all();
  const members = (membersRes?.results || []).map((row) => ({
    groupId: row.group_id,
    accountDigest: row.account_digest,
    role: row.role || 'member',
    status: row.status || 'active',
    inviterAccountDigest: row.inviter_account_digest || null,
    joinedAt: Number(row.joined_at) || null,
    mutedUntil: Number(row.muted_until) || null,
    lastReadTs: Number(row.last_read_ts) || null,
    createdAt: Number(row.created_at) || null,
    updatedAt: Number(row.updated_at) || null
  }));
  return {
    group: {
      groupId: group.group_id,
      conversationId: group.conversation_id,
      creatorAccountDigest: group.creator_account_digest,
      name: group.name || null,
      avatar: safeJSON(group.avatar_json) || null,
      createdAt: Number(group.created_at) || null,
      updatedAt: Number(group.updated_at) || null
    },
    members
  };
}

async function trimContactSecretBackups(env, accountDigest, limit = 5) {
  if (!accountDigest) return;
  const keep = Math.max(Number(limit) || 1, 1);
  await env.DB.prepare(
    `DELETE FROM contact_secret_backups
       WHERE account_digest=?1
         AND id NOT IN (
           SELECT id FROM contact_secret_backups
            WHERE account_digest=?1
            ORDER BY updated_at DESC, id DESC
            LIMIT ?2
         )`
  ).bind(accountDigest, keep).run();
}

const CallStatusSet = new Set(['dialing', 'ringing', 'connecting', 'connected', 'in_call', 'ended', 'failed', 'cancelled', 'timeout', 'pending']);
const CallModeSet = new Set(['voice', 'video']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CALL_SESSION_PURGE_GRACE_MS = 5 * 60 * 1000;
let lastCallCleanupAt = 0;

function normalizeCallId(value) {
  const token = String(value || '').trim();
  if (!token || !UUID_REGEX.test(token)) return null;
  return token.toLowerCase();
}

function normalizeCallStatus(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (CallStatusSet.has(token)) return token;
  return null;
}

function normalizeCallMode(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (CallModeSet.has(token)) return token;
  return null;
}

function normalizeCallEndReason(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (!token) return null;
  return token;
}

function normalizeTimestampMs(value) {
  if (value === null || value === undefined) return null;
  let num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (Math.abs(num) < 1e11) {
    num = Math.round(num * 1000);
  } else {
    num = Math.round(num);
  }
  return num;
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function resolveCapabilities(existingJson, incoming) {
  if (incoming === undefined) {
    return normalizePlainObject(safeJSON(existingJson));
  }
  if (incoming === null) return null;
  return normalizePlainObject(incoming) || null;
}

function resolveMergableJson(existingJson, incoming) {
  const base = normalizePlainObject(safeJSON(existingJson));
  if (incoming === undefined) {
    return base;
  }
  if (incoming === null) {
    return null;
  }
  const patch = normalizePlainObject(incoming);
  if (!patch) return base;
  const merged = { ...(base || {}) };
  for (const [key, val] of Object.entries(patch)) {
    merged[key] = val;
  }
  return merged;
}

function jsonStringOrNull(obj) {
  if (obj === null || obj === undefined) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

async function upsertCallSession(env, payload = {}) {
  await ensureDataTables(env);
  const callId = normalizeCallId(payload.callId || payload.call_id);
  if (!callId) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callId required' };
  }
  const rows = await env.DB.prepare(`SELECT * FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  const existing = rows?.results?.[0] || null;
  const status = normalizeCallStatus(payload.status) || existing?.status || 'dialing';
  const mode = normalizeCallMode(payload.mode) || existing?.mode || 'voice';
  let callerDigest = normalizeAccountDigest(payload.callerAccountDigest || payload.caller_account_digest) || existing?.caller_account_digest || null;
  let calleeDigest = normalizeAccountDigest(payload.calleeAccountDigest || payload.callee_account_digest) || existing?.callee_account_digest || null;
  if (!callerDigest || !calleeDigest) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callerAccountDigest and calleeAccountDigest required' };
  }
  const now = Date.now();
  const createdAt = existing?.created_at ? Number(existing.created_at) : now;
  const updatedAt = normalizeTimestampMs(payload.updatedAt || payload.updated_at) || now;
  const expiresAt = normalizeTimestampMs(payload.expiresAt || payload.expires_at) || existing?.expires_at || (now + 90_000);
  const connectedAtInput = normalizeTimestampMs(payload.connectedAt || payload.connected_at);
  const connectedAt = connectedAtInput ?? (existing && Number.isFinite(existing.connected_at) ? Number(existing.connected_at) : null);
  const endedAtInput = normalizeTimestampMs(payload.endedAt || payload.ended_at);
  const endedAt = endedAtInput ?? (existing && Number.isFinite(existing.ended_at) ? Number(existing.ended_at) : null);
  const endReason = normalizeCallEndReason(payload.endReason || payload.end_reason) || existing?.end_reason || null;
  const capabilitiesObj = resolveCapabilities(existing?.capabilities_json, payload.capabilities);
  const metadataObj = resolveMergableJson(existing?.metadata_json, payload.metadata);
  const metricsObj = resolveMergableJson(existing?.metrics_json, payload.metrics);
  const lastEvent = payload.lastEvent || payload.last_event || existing?.last_event || null;

  await env.DB.prepare(`
    INSERT INTO call_sessions (
      call_id, caller_account_digest, callee_account_digest,
      status, mode,
      capabilities_json, metadata_json, metrics_json,
      created_at, updated_at, connected_at, ended_at, end_reason, expires_at, last_event
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    ON CONFLICT(call_id) DO UPDATE SET
      caller_account_digest=excluded.caller_account_digest,
      callee_account_digest=excluded.callee_account_digest,
      status=excluded.status,
      mode=excluded.mode,
      capabilities_json=excluded.capabilities_json,
      metadata_json=excluded.metadata_json,
      metrics_json=excluded.metrics_json,
      updated_at=excluded.updated_at,
      connected_at=excluded.connected_at,
      ended_at=excluded.ended_at,
      end_reason=excluded.end_reason,
      expires_at=excluded.expires_at,
      last_event=excluded.last_event,
      created_at=call_sessions.created_at
  `).bind(
    callId,
    callerDigest,
    calleeDigest,
    status,
    mode,
    jsonStringOrNull(capabilitiesObj),
    jsonStringOrNull(metadataObj),
    jsonStringOrNull(metricsObj),
    createdAt,
    updatedAt,
    connectedAt,
    endedAt,
    endReason,
    expiresAt,
    lastEvent
  ).run();

  const latest = await env.DB.prepare(`SELECT * FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  const row = latest?.results?.[0];
  if (!row) {
    return { ok: false, status: 500, error: 'UpsertFailed', message: 'call session missing after upsert' };
  }
  return { ok: true, session: serializeCallSessionRow(row) };
}

async function insertCallEvent(env, payload = {}) {
  await ensureDataTables(env);
  const callId = normalizeCallId(payload.callId || payload.call_id);
  if (!callId) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callId required' };
  }
  const type = String(payload.type || '').trim();
  if (!type) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'type required' };
  }
  const sessionRows = await env.DB.prepare(`SELECT call_id FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  if (!sessionRows?.results?.length) {
    return { ok: false, status: 404, error: 'NotFound', message: 'call session not found' };
  }
  const eventId = String(payload.eventId || payload.event_id || crypto.randomUUID());
  const createdAt = normalizeTimestampMs(payload.createdAt || payload.created_at) || Date.now();
  const fromAccountDigestInput = normalizeAccountDigest(payload.fromAccountDigest || payload.from_account_digest);
  const toAccountDigestInput = normalizeAccountDigest(payload.toAccountDigest || payload.to_account_digest);
  const traceId = payload.traceId ? String(payload.traceId).trim() : null;
  const eventPayload = payload.payload === undefined ? null : payload.payload;
  const payloadJson = eventPayload === null ? null : jsonStringOrNull(eventPayload);
  let fromAccountDigest = fromAccountDigestInput || null;
  let toAccountDigest = toAccountDigestInput || null;
  if (!fromAccountDigest || !toAccountDigest) {
    try {
      const sessionRow = await env.DB.prepare(
        `SELECT caller_account_digest, callee_account_digest FROM call_sessions WHERE call_id=?1`
      ).bind(callId).all();
      const row = sessionRow?.results?.[0] || null;
      if (!fromAccountDigest && row?.caller_account_digest) fromAccountDigest = normalizeAccountDigest(row.caller_account_digest);
      if (!toAccountDigest && row?.callee_account_digest) toAccountDigest = normalizeAccountDigest(row.callee_account_digest);
    } catch (err) {
      console.warn('call_session_lookup_for_event_failed', err?.message || err);
    }
  }

  if (!fromAccountDigest || !toAccountDigest) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'fromAccountDigest and toAccountDigest required' };
  }

  await env.DB.prepare(`
    INSERT INTO call_events (event_id, call_id, type, payload_json, from_account_digest, to_account_digest, trace_id, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).bind(
    eventId,
    callId,
    type,
    payloadJson,
    fromAccountDigest,
    toAccountDigest,
    traceId,
    createdAt
  ).run();
  await env.DB.prepare(
    `UPDATE call_sessions SET last_event=?2, updated_at=?3 WHERE call_id=?1`
  ).bind(callId, type, createdAt).run();
  return {
    ok: true,
    event: {
      eventId,
      callId,
      type,
      payload: eventPayload,
      fromAccountDigest: fromAccountDigest || null,
      toAccountDigest: toAccountDigest || null,
      traceId: traceId || null,
      createdAt
    }
  };
}

function serializeCallSessionRow(row) {
  if (!row) return null;
  return {
    callId: row.call_id,
    callerAccountDigest: row.caller_account_digest || null,
    calleeAccountDigest: row.callee_account_digest || null,
    status: row.status,
    mode: row.mode,
    capabilities: normalizePlainObject(safeJSON(row.capabilities_json)),
    metadata: normalizePlainObject(safeJSON(row.metadata_json)),
    metrics: normalizePlainObject(safeJSON(row.metrics_json)),
    createdAt: Number(row.created_at) || null,
    updatedAt: Number(row.updated_at) || null,
    connectedAt: row.connected_at != null ? Number(row.connected_at) : null,
    endedAt: row.ended_at != null ? Number(row.ended_at) : null,
    endReason: row.end_reason || null,
    expiresAt: Number(row.expires_at) || null,
    lastEvent: row.last_event || null
  };
}

async function cleanupCallTables(env) {
  const now = Date.now();
  if (now - lastCallCleanupAt < 60_000) return;
  lastCallCleanupAt = now;
  await ensureDataTables(env);
  const eventExpiry = now - CALL_EVENT_TTL_MS;
  const sessionExpiry = now - CALL_SESSION_PURGE_GRACE_MS;
  try {
    await env.DB.prepare(`DELETE FROM call_events WHERE created_at < ?1`).bind(eventExpiry).run();
  } catch (err) {
    console.warn('call_events_cleanup_failed', err?.message || err);
  }
  try {
    await env.DB.prepare(
      `DELETE FROM call_sessions
        WHERE expires_at < ?1
          AND status IN ('ended','failed','cancelled','timeout')`
    ).bind(sessionExpiry).run();
  } catch (err) {
    console.warn('call_sessions_cleanup_failed', err?.message || err);
  }
}

async function getAccountHmacCryptoKey(env) {
  const keyHex = String(env.ACCOUNT_HMAC_KEY || '').trim();
  if (!/^[0-9A-Fa-f]{64}$/.test(keyHex)) {
    throw new Error('ACCOUNT_HMAC_KEY missing or invalid (expect 64 hex chars)');
  }
  if (getAccountHmacCryptoKey._cacheHex === keyHex && getAccountHmacCryptoKey._cacheKey) {
    return getAccountHmacCryptoKey._cacheKey;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    toU8Strict(hexToBytes(keyHex), 'data-worker/src/worker.js:864:getAccountHmacCryptoKey'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  getAccountHmacCryptoKey._cacheHex = keyHex;
  getAccountHmacCryptoKey._cacheKey = key;
  return key;
}

async function hashUidToDigest(env, uidHex) {
  const normalized = normalizeUid(uidHex);
  if (!normalized) {
    throw new Error('hashUidToDigest: invalid uid');
  }
  const key = await getAccountHmacCryptoKey(env);
  const mac = await crypto.subtle.sign('HMAC', key, textEncoder.encode(normalized));
  return bytesToHex(new Uint8Array(mac));
}

function accountTokenLength(env) {
  const n = Number.parseInt(env.ACCOUNT_TOKEN_BYTES || '32', 10);
  if (Number.isFinite(n) && n > 0 && n <= 64) return n;
  return 32;
}

function generateAccountToken(env) {
  const raw = new Uint8Array(accountTokenLength(env));
  crypto.getRandomValues(raw);
  return bytesToBase64Url(raw);
}

async function digestAccountToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(token || '')));
  return bytesToHex(new Uint8Array(digest));
}

async function resolveAccount(env, { uidHex, accountToken, accountDigest } = {}, { allowCreate = false, preferredAccountToken = null, preferredAccountDigest = null } = {}) {
  const db = env.DB;
  const normalizedUid = uidHex ? normalizeUid(uidHex) : null;
  const normalizedAccountDigest = normalizeAccountDigest(preferredAccountDigest || accountDigest);
  const tokenInput = preferredAccountToken ?? accountToken;
  const normalizedToken = typeof tokenInput === 'string' && tokenInput.trim().length ? tokenInput.trim() : null;
  const uidDigest = normalizedUid ? await hashUidToDigest(env, normalizedUid) : null;

  let lookupDigest = normalizedAccountDigest || null;
  if (!lookupDigest && normalizedToken) {
    lookupDigest = await digestAccountToken(normalizedToken);
  }

  let accountRow = null;
  if (lookupDigest) {
    const rows = await db.prepare(
      `SELECT account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json
         FROM accounts
        WHERE account_digest=?1`
    ).bind(lookupDigest).all();
    accountRow = rows?.results?.[0] || null;
  }

  if (!accountRow && uidDigest) {
    const rows = await db.prepare(
      `SELECT account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json
         FROM accounts
        WHERE uid_digest=?1`
    ).bind(uidDigest).all();
    accountRow = rows?.results?.[0] || null;
  }

  if (accountRow) {
    if (normalizedToken && accountRow.account_token !== normalizedToken) {
      return null;
    }
    return {
      account_digest: accountRow.account_digest,
      account_token: accountRow.account_token,
      uid_digest: accountRow.uid_digest,
      last_ctr: Number(accountRow.last_ctr || 0),
      wrapped_mk_json: accountRow.wrapped_mk_json,
      newlyCreated: false
    };
  }

  if (!allowCreate) {
    return null;
  }

  let acctToken = normalizedToken || null;
  let acctDigest = normalizedAccountDigest || null;

  if (acctToken && !acctDigest) {
    acctDigest = await digestAccountToken(acctToken);
  }
  if (!acctToken) {
    acctToken = generateAccountToken(env);
  }
  if (!acctDigest) {
    acctDigest = await digestAccountToken(acctToken);
  }

  let acctUidDigest = uidDigest || null;
  if (!acctUidDigest) {
    acctUidDigest = acctDigest;
  }

  if (!acctDigest || !acctUidDigest) {
    throw new Error('resolveAccount: account identity required to create account');
  }

  const now = Math.floor(Date.now() / 1000);

  try {
    await db.prepare(
      `INSERT INTO accounts (account_digest, account_token, uid_digest, last_ctr, created_at, updated_at)
       VALUES (?1, ?2, ?3, 0, ?4, ?4)`
    ).bind(acctDigest, acctToken, acctUidDigest, now).run();
    return {
      account_digest: acctDigest,
      account_token: acctToken,
      uid_digest: acctUidDigest,
      last_ctr: 0,
      wrapped_mk_json: null,
      newlyCreated: true
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE constraint failed')) {
      const rows = await db.prepare(
        `SELECT account_digest, account_token, uid_digest, last_ctr, wrapped_mk_json
           FROM accounts
          WHERE account_digest=?1 OR uid_digest=?2`
      ).bind(acctDigest, acctUidDigest).all();
      const row = rows?.results?.[0];
      if (row) {
        return {
          account_digest: row.account_digest,
          account_token: row.account_token,
          uid_digest: row.uid_digest,
          last_ctr: Number(row.last_ctr || 0),
          wrapped_mk_json: row.wrapped_mk_json,
          newlyCreated: false
        };
      }
    }
    throw err;
  }
}

async function ensureDataTables(env) {
  if (dataTablesReady) return;
  const requiredTables = [
    'accounts',
    'devices',
    'device_signed_prekeys',
    'device_opks',
    'prekey_users',
    'prekey_opk',
    'conversations',
    'conversation_acl',
    'messages_secure',
    'message_key_vault',
    'attachments',
    // 'messages', // Legacy table, optional
    'media_objects',
    'opaque_records',
    'device_backup',
    'invite_dropbox',
    'call_sessions',
    'call_events',
    'contact_secret_backups',
    'groups',
    'group_members',
    'group_invites',
    'subscriptions',
    'tokens',
    'extend_logs'
  ];
  try {
    const tableRows = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
    const tableNames = new Set((tableRows?.results || []).map((row) => row.name));
    const missingTables = requiredTables.filter((name) => !tableNames.has(name));
    const missingColumns = [];
    try {
      await env.DB.prepare(`SELECT wrapped_mk_json FROM accounts LIMIT 0`).all();
    } catch {
      missingColumns.push('accounts.wrapped_mk_json');
    }
    try {
      await env.DB.prepare(`SELECT updated_at FROM invite_dropbox LIMIT 0`).all();
    } catch {
      missingColumns.push('invite_dropbox.updated_at');
    }
    try {
      await env.DB.prepare(`SELECT dr_state_snapshot FROM message_key_vault LIMIT 0`).all();
    } catch {
      missingColumns.push('message_key_vault.dr_state_snapshot');
    }
    if (missingTables.length || missingColumns.length) {
      const detail = [
        ...missingTables.map((name) => `table:${name}`),
        ...missingColumns.map((name) => `column:${name}`)
      ];
      const message = `D1 schema missing (${detail.join(', ') || 'none'}); run migrations (including 0026_invite_dropbox.sql and latest schema drops).`;
      console.error(message);
      throw new Error(message);
    }
    dataTablesReady = true;
  } catch (err) {
    console.error('ensureDataTables schema check failed', err);
    throw err;
  }
}

// ---- Tags / SDM / OPAQUE 路由（先搬）----
async function handleTagsRoutes(req, env) {
  const url = new URL(req.url);

  // 交換：建立 / 更新 account、檢查 counter、回傳 MK 包裝資訊
  if (req.method === 'POST' && url.pathname === '/d1/tags/exchange') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const uidHex = normalizeUid(body.uidHex || body.uid);
    const accountTokenRaw = body.accountToken || body.account_token;
    const accountDigest = normalizeAccountDigest(body.accountDigest || body.account_digest);
    const accountToken = typeof accountTokenRaw === 'string' && accountTokenRaw.trim().length ? accountTokenRaw.trim() : null;
    if (!uidHex && !accountDigest && !accountToken) {
      return json({ error: 'BadRequest', message: 'accountDigest/accountToken or uidHex required' }, { status: 400 });
    }
    const ctrNum = Number(body.ctr ?? body.counter ?? body.sdmcounter ?? 0);
    if (!Number.isFinite(ctrNum) || ctrNum < 0) {
      return json({ error: 'BadRequest', message: 'ctr must be a non-negative number' }, { status: 400 });
    }

    let account;
    try {
      account = await resolveAccount(
        env,
        { uidHex, accountToken, accountDigest },
        { allowCreate: true, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest }
      );
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }

    if (!account) {
      const errCode = uidHex ? 'AccountCreateFailed' : 'AccountNotFound';
      return json({ error: errCode }, { status: uidHex ? 500 : 404 });
    }

    if (!account.newlyCreated && !(ctrNum > account.last_ctr)) {
      return json({ error: 'Replay', message: 'counter must be strictly increasing', lastCtr: account.last_ctr }, { status: 409 });
    }

    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `UPDATE accounts
          SET last_ctr=?2,
              updated_at=?3
        WHERE account_digest=?1`
    ).bind(account.account_digest, ctrNum, now).run();

    const hasMK = !!account.wrapped_mk_json;
    let wrapped;
    if (hasMK) {
      try {
        wrapped = JSON.parse(account.wrapped_mk_json);
      } catch {
        wrapped = null;
      }
    }

    return json({
      hasMK,
      wrapped_mk: wrapped || undefined,
      account_token: account.account_token,
      account_digest: account.account_digest,
      uid_digest: account.uid_digest,
      newly_created: account.newlyCreated
    });
  }

  // 首次設定：儲存 wrapped_mk
  if (req.method === 'POST' && url.pathname === '/d1/tags/store-mk') {
    const cfRay = req.headers.get('cf-ray') || null;
    const makeError = (status, payload) => json({ cfRay, ...payload }, { status });
    try {
      let body;
      try {
        body = await req.json();
      } catch {
        return makeError(400, { error: 'BadRequest', code: 'JSON_PARSE_ERROR', message: 'invalid json' });
      }
      const accountDigest = normalizeAccountDigest(body.accountDigest || body.account_digest);
      const accountToken = typeof body.accountToken === 'string' ? body.accountToken : (typeof body.account_token === 'string' ? body.account_token : null);
      if (!accountDigest || !accountToken) {
        return makeError(400, { error: 'BadRequest', code: 'VALIDATION_ERROR', message: 'accountDigest & accountToken required' });
      }
      if (!body.wrapped_mk) {
        return makeError(400, { error: 'BadRequest', code: 'VALIDATION_ERROR', message: 'wrapped_mk required' });
      }
      await ensureDataTables(env);
      // 確認帳號存在且 token 匹配
      const acct = await resolveAccount(env, { accountDigest, accountToken }, { allowCreate: false });
      if (!acct) {
        return makeError(401, { error: 'Unauthorized', code: 'HMAC_INVALID', message: 'account token mismatch' });
      }
      try {
        await env.DB.prepare(
          `UPDATE accounts SET wrapped_mk_json=?2, updated_at=strftime('%s','now')
             WHERE account_digest=?1`
        ).bind(accountDigest, JSON.stringify(body.wrapped_mk)).run();
      } catch (err) {
        const msg = String(err?.message || '').slice(0, 200);
        return makeError(500, { error: 'StoreMkFailed', code: 'D1_ERROR', message: msg });
      }
      return new Response(null, { status: 204 });
    } catch (err) {
      const msg = String(err?.message || '').slice(0, 200);
      return makeError(500, { error: 'StoreMkFailed', code: 'UNKNOWN', message: msg });
    }
  }

  // 讀取裝置私鑰密文備份（wrapped_device_keys）
  if (req.method === 'POST' && url.pathname === '/d1/devkeys/fetch') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken: body.accountToken,
        accountDigest: body.accountDigest || body.account_digest
      });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }

    if (!account) {
      return json({ error: 'NotFound' }, { status: 404 });
    }

    const sel = await env.DB.prepare(
      `SELECT wrapped_dev_json FROM device_backup WHERE account_digest=?1`
    ).bind(account.account_digest).all();

    if (!sel.results || sel.results.length === 0) {
      return json({ error: 'NotFound' }, { status: 404 });
    }
    const wrapped = JSON.parse(sel.results[0].wrapped_dev_json);
    return json({ wrapped_dev: wrapped });
  }

  // 儲存裝置私鑰密文備份（wrapped_device_keys）
  if (req.method === 'POST' && url.pathname === '/d1/devkeys/store') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken: body.accountToken,
        accountDigest: body.accountDigest || body.account_digest
      });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }

    if (!account) {
      return json({ error: 'NotFound' }, { status: 404 });
    }

    if (!body.wrapped_dev) {
      return json({ error: 'BadRequest', message: 'wrapped_dev required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const upd = await env.DB.prepare(
      `UPDATE device_backup
          SET wrapped_dev_json=?2, updated_at=strftime('%s','now')
        WHERE account_digest=?1`
    ).bind(account.account_digest, JSON.stringify(body.wrapped_dev)).run();
    if (!upd || (upd.meta && upd.meta.changes === 0)) {
      await env.DB.prepare(
        `INSERT INTO device_backup (account_digest, wrapped_dev_json)
         VALUES (?1, ?2)`
      ).bind(account.account_digest, JSON.stringify(body.wrapped_dev)).run();
    }

    return new Response(null, { status: 204 });
  }

  // OPAQUE: store registration record
  if (req.method === 'POST' && url.pathname === '/d1/opaque/store') {
    let body; try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }
    const acct = String(body?.accountDigest || body?.account_digest || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    const record_b64 = typeof body?.record_b64 === 'string' ? body.record_b64.trim() : '';
    const client_identity = typeof body?.client_identity === 'string' ? body.client_identity : null;
    if (!acct || acct.length !== 64 || !record_b64) {
      return json({ error: 'BadRequest', message: 'accountDigest(64 hex) and record_b64 required' }, { status: 400 });
    }
    await env.DB.prepare(
      `INSERT INTO opaque_records (account_digest, record_b64, client_identity)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(account_digest) DO UPDATE SET record_b64=excluded.record_b64, client_identity=excluded.client_identity, updated_at=strftime('%s','now')`
    ).bind(acct, record_b64, client_identity).run();
    return new Response(null, { status: 204 });
  }

  // OPAQUE: fetch registration record
  if (req.method === 'POST' && url.pathname === '/d1/opaque/fetch') {
    let body; try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }
    const acct = String(body?.accountDigest || body?.account_digest || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (!acct || acct.length !== 64) {
      return json({ error: 'BadRequest', message: 'accountDigest(64 hex) required' }, { status: 400 });
    }
    const rs = await env.DB.prepare(`SELECT record_b64, client_identity FROM opaque_records WHERE account_digest=?1`).bind(acct).all();
    const row = rs?.results?.[0];
    if (!row) return json({ error: 'NotFound' }, { status: 404 });
    return json({ account_digest: acct, record_b64: row.record_b64, client_identity: row.client_identity || null });
  }

  return null;
}

async function markInviteExpired(env, inviteId, nowSec) {
  if (!inviteId) return;
  await env.DB.prepare(
    `UPDATE invite_dropbox
        SET status='EXPIRED',
            updated_at=?2
      WHERE invite_id=?1 AND status IN ('CREATED', 'DELIVERED')`
  ).bind(inviteId, nowSec).run();
}

async function handleInviteDropboxRoutes(req, env) {
  const url = new URL(req.url);

  // Create invite dropbox (owner)
  if (req.method === 'POST' && url.pathname === '/d1/invites/create') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    const ownerDeviceId = normalizeDeviceId(body?.deviceId);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }
    if (!ownerDeviceId) {
      return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    }

    const existing = await env.DB.prepare(
      `SELECT invite_id FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (existing) {
      return json({ error: 'InviteAlreadyExists' }, { status: 409 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const ownerBundle = await allocateOwnerPrekeyBundle(env, account.account_digest, ownerDeviceId);
    if (!ownerBundle) {
      return json({ error: 'PrekeyUnavailable', message: 'owner prekey bundle unavailable' }, { status: 409 });
    }
    if (Object.prototype.hasOwnProperty.call(body || {}, 'ownerPublicKey')) {
      return json({ error: 'BadRequest', code: 'InviteSchemaMismatch', message: 'ownerPublicKey not allowed' }, { status: 400 });
    }
    const ownerPublicKeyInput = String(body?.ownerPublicKeyB64 || '').trim();
    const ownerPublicKeyB64 = ownerPublicKeyInput || String(ownerBundle.spk_pub || '').trim();
    if (!ownerPublicKeyB64) {
      return json({ error: 'BadRequest', code: 'InviteSchemaInvalid', message: 'ownerPublicKeyB64 required' }, { status: 400 });
    }
    if (ownerPublicKeyInput && ownerBundle.spk_pub && ownerPublicKeyInput !== ownerBundle.spk_pub) {
      return json({ error: 'OwnerPublicKeyMismatch', message: 'ownerPublicKeyB64 mismatch' }, { status: 400 });
    }

    await env.DB.prepare(
      `INSERT INTO invite_dropbox (
          invite_id, owner_account_digest, owner_device_id,
          owner_public_key_b64, expires_at, status, created_at, updated_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, 'CREATED', ?6, ?7)`
    ).bind(
      inviteId,
      account.account_digest,
      ownerDeviceId,
      ownerPublicKeyB64,
      expiresAt,
      now,
      now
    ).run();

    const prekeyBundle = ownerBundle
      ? {
        ikPubB64: String(ownerBundle.ik_pub || '').trim(),
        spkPubB64: String(ownerBundle.spk_pub || '').trim(),
        signatureB64: String(ownerBundle.spk_sig || '').trim(),
        opkId: ownerBundle.opk?.id ?? null,
        opkPubB64: String(ownerBundle.opk?.pub || '').trim() || null
      }
      : null;

    return json({
      ok: true,
      inviteId,
      expiresAt,
      ownerAccountDigest: account.account_digest,
      ownerDeviceId,
      ownerPublicKeyB64,
      prekeyBundle
    });
  }

  // Deliver invite payload (guest)
  if (req.method === 'POST' && url.pathname === '/d1/invites/deliver') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_DELIVER_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_DELIVER_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    const senderDeviceId = normalizeDeviceId(body?.deviceId);
    const envelope = normalizeInviteDropboxEnvelope(body?.ciphertextEnvelope);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }
    if (!senderDeviceId) {
      return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    }
    if (!envelope) {
      return json({ error: 'BadRequest', code: 'InviteEnvelopeInvalid', message: 'ciphertextEnvelope invalid' }, { status: 400 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const row = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, owner_device_id, expires_at, status
         FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (!row) return json({ error: 'NotFound' }, { status: 404 });
    const now = Math.floor(Date.now() / 1000);
    if (Number(row.expires_at) <= now) {
      await markInviteExpired(env, inviteId, now);
      return json({ error: 'Expired' }, { status: 410 });
    }
    if (envelope.expiresAt !== Number(row.expires_at)) {
      return json({ error: 'InviteExpiresMismatch', message: 'envelope expires mismatch' }, { status: 400 });
    }
    if (row.status !== 'CREATED') {
      return json({ error: 'InviteAlreadyDelivered' }, { status: 409 });
    }

    const upd = await env.DB.prepare(
      `UPDATE invite_dropbox
          SET status='DELIVERED',
              delivered_by_account_digest=?2,
              delivered_by_device_id=?3,
              delivered_at=?4,
              ciphertext_json=?5,
              updated_at=?6
        WHERE invite_id=?1 AND status='CREATED'`
    ).bind(
      inviteId,
      account.account_digest,
      senderDeviceId,
      now,
      JSON.stringify(envelope),
      now
    ).run();
    if (!upd || (upd.meta && upd.meta.changes === 0)) {
      return json({ error: 'InviteAlreadyDelivered' }, { status: 409 });
    }

    return json({
      ok: true,
      inviteId,
      ownerAccountDigest: row.owner_account_digest,
      ownerDeviceId: row.owner_device_id,
      deliveredAt: now
    });
  }

  // Consume invite payload (owner)
  if (req.method === 'POST' && url.pathname === '/d1/invites/consume') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_CONSUME_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_CONSUME_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const row = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, owner_device_id, expires_at, status, ciphertext_json
         FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (!row) return json({ error: 'NotFound' }, { status: 404 });
    const now = Math.floor(Date.now() / 1000);
    if (Number(row.expires_at) <= now) {
      await markInviteExpired(env, inviteId, now);
      return json({ error: 'Expired' }, { status: 410 });
    }
    if (row.owner_account_digest !== account.account_digest) {
      return json({ error: 'Forbidden', message: 'invite owner mismatch' }, { status: 403 });
    }
    if (row.status === 'CONSUMED') {
      const envelope = safeJSON(row.ciphertext_json);
      if (!envelope) {
        return json({ error: 'PayloadMissing', message: 'ciphertext missing' }, { status: 500 });
      }
      return json({
        ok: true,
        inviteId,
        ownerDeviceId: row.owner_device_id,
        expiresAt: row.expires_at,
        ciphertextEnvelope: envelope
      });
    }
    if (row.status !== 'DELIVERED') {
      return json({ error: 'NotFound' }, { status: 404 });
    }
    const envelope = safeJSON(row.ciphertext_json);
    if (!envelope) {
      return json({ error: 'PayloadMissing', message: 'ciphertext missing' }, { status: 500 });
    }

    const upd = await env.DB.prepare(
      `UPDATE invite_dropbox
          SET status='CONSUMED',
              consumed_at=?2,
              updated_at=?3
        WHERE invite_id=?1 AND status='DELIVERED'`
    ).bind(inviteId, now, now).run();
    if (!upd || (upd.meta && upd.meta.changes === 0)) {
      const retry = await env.DB.prepare(
        `SELECT status, ciphertext_json, owner_device_id, expires_at
           FROM invite_dropbox WHERE invite_id=?1`
      ).bind(inviteId).first();
      if (retry?.status === 'CONSUMED') {
        const retryEnvelope = safeJSON(retry.ciphertext_json);
        if (!retryEnvelope) {
          return json({ error: 'PayloadMissing', message: 'ciphertext missing' }, { status: 500 });
        }
        return json({
          ok: true,
          inviteId,
          ownerDeviceId: retry.owner_device_id,
          expiresAt: retry.expires_at,
          ciphertextEnvelope: retryEnvelope
        });
      }
      return json({ error: 'NotFound' }, { status: 404 });
    }

    return json({
      ok: true,
      inviteId,
      ownerDeviceId: row.owner_device_id,
      expiresAt: row.expires_at,
      ciphertextEnvelope: envelope
    });
  }

  // Check invite status (owner or deliverer)
  if (req.method === 'POST' && url.pathname === '/d1/invites/status') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const aliasKey = findAliasKey(body, INVITE_STATUS_ALIAS_FIELDS);
    if (aliasKey) return inviteAliasError(aliasKey);
    const unexpectedKey = findUnexpectedKey(body, INVITE_STATUS_ALLOWED_FIELDS);
    if (unexpectedKey) return inviteUnexpectedFieldError(unexpectedKey);
    const inviteId = String(body?.inviteId || '').trim();
    const accountToken = typeof body?.accountToken === 'string' ? body.accountToken.trim() : '';
    const accountDigest = normalizeAccountDigest(body?.accountDigest || null);
    if (!inviteId || inviteId.length < 8) {
      return json({ error: 'BadRequest', message: 'inviteId required' }, { status: 400 });
    }
    if (!accountToken) {
      return json({ error: 'Unauthorized', message: 'accountToken required' }, { status: 401 });
    }

    let account;
    try {
      account = await resolveAccount(env, {
        accountToken,
        accountDigest
      }, { allowCreate: false, preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
    if (!account) {
      return json({ error: 'Forbidden', message: 'accountToken invalid' }, { status: 403 });
    }

    const row = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, owner_device_id,
              delivered_by_account_digest, delivered_by_device_id,
              status, created_at, delivered_at, consumed_at, expires_at, updated_at
         FROM invite_dropbox WHERE invite_id=?1`
    ).bind(inviteId).first();
    if (!row) return json({ error: 'NotFound' }, { status: 404 });

    const requester = account.account_digest;
    const isOwner = row.owner_account_digest === requester;
    const isDeliverer = row.delivered_by_account_digest && row.delivered_by_account_digest === requester;
    if (!isOwner && !isDeliverer) {
      return json({ error: 'Forbidden', message: 'invite access denied' }, { status: 403 });
    }

    const now = Math.floor(Date.now() / 1000);
    const isExpired = Number(row.expires_at) <= now;
    let status = row.status;
    let updatedAt = row.updated_at || row.created_at || null;
    if (isExpired && status !== 'CONSUMED') {
      await markInviteExpired(env, inviteId, now);
      status = 'EXPIRED';
      updatedAt = now;
    }
    return json({
      inviteId: row.invite_id,
      status,
      expiresAt: row.expires_at,
      createdAt: row.created_at || null,
      updatedAt,
      deliveredAt: row.delivered_at || null,
      consumedAt: row.consumed_at || null
    });
  }

  return null;
}

// ---- 主入口 ----
async function handleFriendsRoutes(req, env) {
  const url = new URL(req.url);

  // 刪除聯絡（依 peer）
  if (req.method === 'POST' && url.pathname === '/d1/friends/contact-delete') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    let ownerAccountDigest = normalizeAccountDigest(body?.ownerAccountDigest || body?.owner_account_digest || body?.accountDigest || body?.account_digest);
    let peerAccountDigest = normalizeAccountDigest(body?.peerAccountDigest || body?.peer_account_digest);

    if (!ownerAccountDigest) {
      return json({ error: 'BadRequest', message: 'ownerAccountDigest required' }, { status: 400 });
    }
    if (!peerAccountDigest) {
      return json({ error: 'BadRequest', message: 'peerAccountDigest required' }, { status: 400 });
    }

    const results = [];
    const now = Math.floor(Date.now() / 1000);

    const targets = new Map();
    const addTarget = (convId, targetAccountDigest) => {
      if (!convId) return;
      const key = `${convId}::${targetAccountDigest || peerAccountDigest || ''}`;
      if (!targets.has(key)) targets.set(key, { convId, targetAccountDigest: targetAccountDigest || peerAccountDigest || null });
    };

    addTarget(`contacts-${ownerAccountDigest}`, peerAccountDigest);
    addTarget(`contacts-${peerAccountDigest}`, ownerAccountDigest);

    const targetList = Array.from(targets.values());
    for (const entry of targetList) {
      const removed = await deleteContactByPeer(env, entry.convId, null, entry.targetAccountDigest);

      if (ownerAccountDigest && entry.targetAccountDigest) {
        try {
          await env.DB.prepare(
            `DELETE FROM contacts WHERE owner_account_digest=?1 AND peer_account_digest=?2`
          ).bind(ownerAccountDigest, entry.targetAccountDigest).run();
        } catch (err) {
          console.warn('contact_row_delete_failed', err?.message || err);
        }
      }

      results.push({ convId: entry.convId, removed, target: entry.targetAccountDigest || null });
    }

    return json({ ok: true, ts: now, results });
  }

  return null;
}

async function handlePrekeysRoutes(req, env) {
  const url = new URL(req.url);

  // Publish per-device prekeys (Signal-style)
  if (req.method === 'POST' && url.pathname === '/d1/prekeys/publish') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const deviceId = normalizeDeviceId(body?.deviceId || body?.device_id);
    const signedPrekey = normalizeSignedPrekey(body?.signedPrekey);
    const opks = Array.isArray(body?.opks) ? body.opks.map(normalizeOpk) : [];
    if (!accountDigest || !deviceId || !signedPrekey) {
      return json({ error: 'BadRequest', message: 'accountDigest, deviceId, signedPrekey required' }, { status: 400 });
    }
    if (opks.some((entry) => !entry)) {
      return json({ error: 'BadRequest', message: 'invalid opk entry' }, { status: 400 });
    }
    if (!signedPrekey.ik_pub) {
      return json({ error: 'BadRequest', message: 'ik_pub required for signedPrekey' }, { status: 400 });
    }
    const spkValid = await verifySignedPrekey({
      spk_pub_b64: signedPrekey.pub,
      spk_sig_b64: signedPrekey.sig,
      ik_pub_b64: signedPrekey.ik_pub
    });
    if (!spkValid) {
      return json({ error: 'BadRequest', message: 'signedPrekey signature invalid' }, { status: 400 });
    }
    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);
    await env.DB.prepare(`
      INSERT INTO devices (account_digest, device_id, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?3)
      ON CONFLICT(account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(accountDigest, deviceId, now).run();
    await env.DB.prepare(`
      INSERT INTO device_signed_prekeys (account_digest, device_id, spk_id, spk_pub, spk_sig, ik_pub, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(account_digest, device_id, spk_id) DO UPDATE SET
        spk_pub=excluded.spk_pub,
        spk_sig=excluded.spk_sig,
        ik_pub=COALESCE(excluded.ik_pub, device_signed_prekeys.ik_pub)
    `).bind(accountDigest, deviceId, signedPrekey.id, signedPrekey.pub, signedPrekey.sig, signedPrekey.ik_pub || null, now).run();
    if (opks.length) {
      const stmt = env.DB.prepare(`
        INSERT OR REPLACE INTO device_opks (account_digest, device_id, opk_id, opk_pub, issued_at, consumed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, NULL)
      `);
      for (const opk of opks) {
        await stmt.bind(accountDigest, deviceId, opk.id, opk.pub, now).run();
      }
    }
    const nextRow = await env.DB.prepare(`
      SELECT MAX(opk_id) as max_id FROM device_opks WHERE account_digest=?1 AND device_id=?2
    `).bind(accountDigest, deviceId).first();
    const nextOpkId = Number(nextRow?.max_id || 0) + 1;
    return json({ ok: true, next_opk_id: nextOpkId });
  }

  // Fetch per-device bundle (consume one OPK)
  if (req.method === 'GET' && url.pathname === '/d1/prekeys/bundle') {
    const peerAccountDigest = normalizeAccountDigest(url.searchParams.get('peerAccountDigest'));
    let peerDeviceId = normalizeDeviceId(url.searchParams.get('peerDeviceId'));
    if (!peerAccountDigest) {
      return json({ error: 'BadRequest', message: 'peerAccountDigest required' }, { status: 400 });
    }
    await ensureDataTables(env);
    if (!peerDeviceId) {
      const deviceRow = await env.DB.prepare(`
        SELECT device_id FROM devices
         WHERE account_digest=?1
         ORDER BY updated_at DESC, created_at DESC
         LIMIT 1
      `).bind(peerAccountDigest).first();
      peerDeviceId = normalizeDeviceId(deviceRow?.device_id);
    }
    if (!peerDeviceId) {
      console.warn('prekeys_bundle_peer_device_missing', { peerAccountDigest });
      return json({ error: 'PrekeyUnavailable', message: 'peer device not found' }, { status: 404 });
    }
    const spkRow = await env.DB.prepare(`
      SELECT spk_id, spk_pub, spk_sig, ik_pub
        FROM device_signed_prekeys
       WHERE account_digest=?1 AND device_id=?2
       ORDER BY spk_id DESC
       LIMIT 1
    `).bind(peerAccountDigest, peerDeviceId).first();
    if (!spkRow || !spkRow.spk_pub || !spkRow.spk_sig) {
      console.warn('prekeys_bundle_spk_missing', { peerAccountDigest, peerDeviceId });
      return json({ error: 'PrekeyUnavailable', message: 'signed prekey missing' }, { status: 404 });
    }
    const ikPub = spkRow.ik_pub || null;
    if (!ikPub) {
      console.warn('prekeys_bundle_ik_missing', { peerAccountDigest, peerDeviceId });
      return json({ error: 'PrekeyUnavailable', message: 'ik_pub missing for peer device' }, { status: 409 });
    }
    const opkRow = await env.DB.prepare(`
      SELECT opk_id, opk_pub FROM device_opks
       WHERE account_digest=?1 AND device_id=?2 AND consumed_at IS NULL
       ORDER BY opk_id ASC
       LIMIT 1
    `).bind(peerAccountDigest, peerDeviceId).first();
    if (!opkRow) {
      return json({ error: 'PrekeyUnavailable', message: 'one-time prekey missing' }, { status: 404 });
    }
    await env.DB.prepare(`
      UPDATE device_opks SET consumed_at=strftime('%s','now')
       WHERE account_digest=?1 AND device_id=?2 AND opk_id=?3
    `).bind(peerAccountDigest, peerDeviceId, opkRow.opk_id).run();
    return json({
      ok: true,
      deviceId: peerDeviceId,
      signedPrekey: {
        id: spkRow.spk_id,
        pub: spkRow.spk_pub,
        sig: spkRow.spk_sig,
        ik_pub: ikPub
      },
      opk: {
        id: opkRow.opk_id,
        pub: opkRow.opk_pub
      }
    });
  }

  return null;
}


async function handleAtomicSendRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/messages/atomic-send') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    // 1. Common Validation
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest); // Sender
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);

    if (!conversationId || !accountDigest || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId, accountDigest, senderDeviceId required' }, { status: 400 });
    }

    await ensureDataTables(env);

    const messagePayload = body?.message;
    const vaultPayload = body?.vault;
    const backupPayload = body?.backup;

    if (!messagePayload || !vaultPayload) {
      return json({ error: 'BadRequest', message: 'message and vault payloads required' }, { status: 400 });
    }

    // 2. Prepare Message Insert
    const msgId = normalizeMessageId(messagePayload?.id);
    // [FIX] Infer sender digest/device from auth context if not explicitly provided (Client sends null)
    const payloadSenderDigest = normalizeAccountDigest(messagePayload?.sender_account_digest || messagePayload?.senderAccountDigest);
    const msgSenderDigest = payloadSenderDigest || accountDigest;

    const payloadSenderDevice = normalizeDeviceId(messagePayload?.sender_device_id || messagePayload?.senderDeviceId);
    const msgSenderDevice = payloadSenderDevice || senderDeviceId;

    const msgReceiverDigest = normalizeAccountDigest(messagePayload?.receiver_account_digest || messagePayload?.receiverAccountDigest);
    const msgReceiverDevice = normalizeDeviceId(messagePayload?.receiver_device_id || messagePayload?.receiverDeviceId); // nullable
    const msgHeaderJson = typeof messagePayload?.header_json === 'string' ? messagePayload.header_json : (messagePayload?.header ? JSON.stringify(messagePayload.header) : null);
    const msgCiphertext = typeof messagePayload?.ciphertext_b64 === 'string' ? messagePayload.ciphertext_b64 : null;
    const msgCounter = Number(messagePayload?.counter);
    const msgCreatedAt = Number(messagePayload?.created_at || messagePayload?.ts || 0) || Math.floor(Date.now() / 1000);

    if (!msgId || !msgSenderDigest || !msgSenderDevice || !msgReceiverDigest || !msgHeaderJson || !msgCiphertext || !Number.isFinite(msgCounter)) {
      return json({ error: 'BadRequest', message: 'invalid message payload' }, { status: 400 });
    }
    // Consistency Check (Only if payload explicitly provided a different value)
    if (payloadSenderDigest && payloadSenderDigest !== accountDigest) {
      return json({ error: 'BadRequest', message: 'message sender digest mismatch' }, { status: 400 });
    }
    if (payloadSenderDevice && payloadSenderDevice !== senderDeviceId) {
      return json({ error: 'BadRequest', message: 'message sender device mismatch' }, { status: 400 });
    }

    // 3. Prepare Vault Insert
    const vaultConversationId = normalizeConversationId(vaultPayload?.conversationId || vaultPayload?.conversation_id);
    const vaultMessageId = normalizeMessageId(vaultPayload?.messageId || vaultPayload?.message_id);
    const vaultSenderDevice = normalizeDeviceId(vaultPayload?.senderDeviceId || vaultPayload?.sender_device_id);
    const vaultTargetDevice = normalizeDeviceId(vaultPayload?.targetDeviceId || vaultPayload?.target_device_id);
    const vaultDirection = typeof vaultPayload?.direction === 'string' ? vaultPayload.direction.trim() : '';
    const vaultMsgType = typeof vaultPayload?.msgType === 'string' ? vaultPayload.msgType.trim() : (typeof vaultPayload?.msg_type === 'string' ? vaultPayload.msg_type.trim() : null);
    const vaultHeaderCounter = Number.isFinite(Number(vaultPayload?.headerCounter ?? vaultPayload?.header_counter)) ? Number(vaultPayload?.headerCounter ?? vaultPayload?.header_counter) : null;
    const vaultWrapped = vaultPayload?.wrapped_mk || vaultPayload?.wrappedMk || null;
    const vaultContext = vaultPayload?.wrap_context || vaultPayload?.wrapContext || null;
    const vaultDrState = vaultPayload?.dr_state || vaultPayload?.drState || null;

    if (!vaultConversationId || !vaultMessageId || !vaultSenderDevice || !vaultTargetDevice || !vaultDirection || !vaultWrapped || !vaultContext) {
      return json({ error: 'BadRequest', message: 'invalid vault payload' }, { status: 400 });
    }
    // Consistency Check
    if (vaultConversationId !== conversationId || vaultMessageId !== msgId || vaultSenderDevice !== senderDeviceId) {
      return json({ error: 'BadRequest', message: 'vault mismatch with context' }, { status: 400 });
    }
    if (!validateWrappedMessageKeyEnvelope(vaultWrapped)) {
      return json({ error: 'InvalidWrappedPayload', message: 'wrapped envelope invalid' }, { status: 400 });
    }
    // Note: We skip deep context validation here or reuse validateWrapContext if needed,
    // but we can trust the client providing consistent context if signature/hmac verifies request.
    // However, basic consistency is good.
    if (!validateWrapContext(vaultContext, {
      conversationId: vaultConversationId,
      messageId: vaultMessageId,
      senderDeviceId: vaultSenderDevice,
      targetDeviceId: vaultTargetDevice,
      direction: vaultDirection,
      msgType: vaultMsgType,
      headerCounter: vaultHeaderCounter
    })) {
      return json({ error: 'InvalidWrapContext', message: 'wrap_context invalid' }, { status: 400 });
    }


    // 4. Validate Max Counter (Optimistic Concurrency)
    // We should check max counter for the conversation to prevent overwrite or re-use (though D1 primary key handles unique id).
    // The separate 'secure message insert' handler does this check. We should replicate it or rely on unique constraint on ID.
    // But 'CounterTooLow' is a logic error we might want to catch.
    const maxRow = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
    `).bind(conversationId, accountDigest, senderDeviceId).first();
    const maxCounter = Number(maxRow?.max_counter ?? -1);
    if (Number.isFinite(maxCounter) && maxCounter >= 0 && msgCounter <= maxCounter) {
      return json({ error: 'CounterTooLow', message: 'counter must be greater than previous', maxCounter }, { status: 409 });
    }

    // 5. Construct Batch
    const batch = [];

    // 5a. Conversations & ACL (ensure existence)
    // These are upserts (ON CONFLICT DO NOTHING/UPDATE), safe to include in batch or run before.
    // If run before, they are not atomic with message. Ideally everything in batch.
    // However, D1 batch is just array of statements.
    batch.push(env.DB.prepare(`
      INSERT INTO conversations (id)
      VALUES (?1)
      ON CONFLICT(id) DO NOTHING
    `).bind(conversationId));

    batch.push(env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, 'member')
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(conversationId, accountDigest, senderDeviceId));

    // Receiver ACL
    if (msgReceiverDigest) {
      batch.push(env.DB.prepare(`
         INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
         VALUES (?1, ?2, ?3, 'member')
         ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
       `).bind(conversationId, msgReceiverDigest, msgReceiverDevice || null));
    }

    // 5b. Message Insert
    batch.push(env.DB.prepare(`
      INSERT INTO messages_secure (
        id, conversation_id, sender_account_digest, sender_device_id,
        receiver_account_digest, receiver_device_id, header_json, ciphertext_b64, counter, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
      msgId, conversationId, accountDigest, senderDeviceId,
      msgReceiverDigest, msgReceiverDevice || null, msgHeaderJson, msgCiphertext, msgCounter, msgCreatedAt
    ));

    // 5c. Vault Insert
    batch.push(env.DB.prepare(`
      INSERT INTO message_key_vault (
          account_digest, conversation_id, message_id, sender_device_id,
          target_device_id, direction, msg_type, header_counter, wrapped_mk_json, wrap_context_json, dr_state_snapshot, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, strftime('%s','now'))
       ON CONFLICT(account_digest, conversation_id, message_id, sender_device_id)
       DO NOTHING
    `).bind(
      accountDigest, conversationId, msgId, senderDeviceId,
      vaultTargetDevice, vaultDirection, vaultMsgType, vaultHeaderCounter,
      JSON.stringify(vaultWrapped), JSON.stringify(vaultContext), vaultDrState || null
    ));

    // 5d. Backup Insert (if present)
    if (backupPayload) {
      // Validate backup payload
      const bkDigest = normalizeAccountDigest(backupPayload.accountDigest || backupPayload.account_digest);
      if (bkDigest !== accountDigest) {
        return json({ error: 'BadRequest', message: 'backup digest mismatch' }, { status: 400 });
      }
      const rawPayload = backupPayload.payload;
      if (!rawPayload || typeof rawPayload !== 'object') {
        return json({ error: 'BadRequest', message: 'backup payload invalid' }, { status: 400 });
      }

      // Check version monotonicity need extra read?
      // Constraint: We want this to be atomic. If we do a read now for version, and write in batch, it's fine.
      // Or we can blindly insert if client ensures version is correct?
      // The client usually knows the next version.
      // But let's check basic version logic if supplied.
      // Actually, to fully protect overwrite, we should rely on UNIQUE constraint on (account_digest, version) if it existed.
      // But let's look at `contact_secret_backups` schema (inferred).
      // If we assume client sends correct Monotonic Number, we can just Insert.
      // If we want to auto-increment version on server, we can't easily do that in a Batch with arbitrary logic, unless we use specific SQL.
      // EXISTING LOGIC: reads MAX(version), then increments.
      // We can replicate that READ here before the batch. It breaks strict "Serializability" if concurrent requests happen,
      // but for a single user/device, it's usually sequential.
      // Let's do the read.

      let bkVersion = Number.isFinite(Number(backupPayload.version)) && Number(backupPayload.version) > 0
        ? Math.floor(Number(backupPayload.version))
        : null;

      // Only if version not provided do we fetch. If provided, we respect it.
      if (!bkVersion) {
        const existingVersionRow = await env.DB.prepare(
          `SELECT MAX(version) as max_version FROM contact_secret_backups WHERE account_digest=?1`
        ).bind(accountDigest).all();
        const nextVersion = Number(existingVersionRow?.results?.[0]?.max_version || 0);
        bkVersion = nextVersion + 1;
      }

      const bkSnapshotVersion = Number.isFinite(Number(backupPayload.snapshotVersion)) ? Number(backupPayload.snapshotVersion) : null;
      const bkEntries = Number.isFinite(Number(backupPayload.entries)) ? Number(backupPayload.entries) : null;
      const bkBytes = Number.isFinite(Number(backupPayload.bytes)) ? Number(backupPayload.bytes) : null;
      const bkChecksum = typeof backupPayload.checksum === 'string' ? String(backupPayload.checksum).slice(0, 128) : null;
      const bkDeviceLabel = typeof backupPayload.deviceLabel === 'string' ? String(backupPayload.deviceLabel).slice(0, 120) : null;
      const bkDeviceId = typeof backupPayload.deviceId === 'string' ? String(backupPayload.deviceId).slice(0, 120) : null;
      const bkUpdatedAt = normalizeTimestampMs(backupPayload.updatedAt || backupPayload.updated_at) || Date.now();
      const bkWithDrState = Number.isFinite(Number(backupPayload.withDrState)) ? Number(backupPayload.withDrState) : null;

      const payloadRecord = Number.isFinite(bkWithDrState)
        ? { payload: rawPayload, meta: { withDrState: bkWithDrState } }
        : rawPayload;

      batch.push(env.DB.prepare(
        `INSERT INTO contact_secret_backups (
            account_digest, version, payload_json, snapshot_version, entries,
            checksum, bytes, updated_at, device_label, device_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%s','now'))`
      ).bind(
        accountDigest, bkVersion, JSON.stringify(payloadRecord),
        bkSnapshotVersion, bkEntries, bkChecksum, bkBytes, bkUpdatedAt,
        bkDeviceLabel, bkDeviceId
      ));

      // Trim (DELETE)
      // "Delete all but last 5"
      // We can use the same logic as trimContactSecretBackups but hardcoded params
      const keep = 5;
      batch.push(env.DB.prepare(
        `DELETE FROM contact_secret_backups
           WHERE account_digest=?1
             AND id NOT IN (
               SELECT id FROM contact_secret_backups
                WHERE account_digest=?1
                ORDER BY updated_at DESC, id DESC
                LIMIT ?2
             )`
      ).bind(accountDigest, keep));
    }

    // 6. Execute Batch
    try {
      await env.DB.batch(batch);
    } catch (err) {
      console.warn('atomic_send_failed', err?.message || err);
      // Analyze error (duplicate message id? etc)
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('primary')) {
        // If message ID conflict, it might be a retry.
        // Consider returning OK if it looks like exact duplicate?
        // For now, fail to let client know or handle idempotency carefully.
        // But strict atomicity means we should probably return Error so client knows it failed.
        return json({ error: 'Conflict', message: 'duplicate entry' }, { status: 409 });
      }
      return json({ error: 'AtomicSendFailed', message: 'transaction failed' }, { status: 500 });
    }

    return json({
      ok: true,
      id: msgId,
      created_at: msgCreatedAt,
      vault_saved: true,
      backup_saved: !!backupPayload
    });
  }

  return null;
}

async function handleMessagesRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/messages/send-state') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    if (!conversationId || !accountDigest || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId, accountDigest, senderDeviceId required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const row = await env.DB.prepare(`
      SELECT id, counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
       ORDER BY counter DESC, created_at DESC, id DESC
       LIMIT 1
    `).bind(conversationId, accountDigest, senderDeviceId).first();
    const lastAcceptedCounter = Number(row?.counter);
    const expectedCounter = Number.isFinite(lastAcceptedCounter) ? lastAcceptedCounter + 1 : 1;
    return json({
      ok: true,
      expectedCounter,
      lastAcceptedCounter: Number.isFinite(lastAcceptedCounter) ? lastAcceptedCounter : null,
      lastAcceptedMessageId: row?.id || null,
      serverTime: Math.floor(Date.now() / 1000)
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/messages/outgoing-status') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const senderAccountDigest = normalizeAccountDigest(body?.senderAccountDigest || body?.sender_account_digest);
    const receiverAccountDigest = normalizeAccountDigest(body?.receiverAccountDigest || body?.receiver_account_digest);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const messageIdsInput = Array.isArray(body?.messageIds) ? body.messageIds : [];
    const messageIds = messageIdsInput
      .map((value) => normalizeMessageId(value))
      .filter(Boolean);
    if (!conversationId || !senderAccountDigest || !receiverAccountDigest || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId, senderAccountDigest, receiverAccountDigest, senderDeviceId required' }, { status: 400 });
    }
    if (!messageIds.length) {
      return json({ error: 'BadRequest', message: 'messageIds required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const placeholders = messageIds.map((_, idx) => `?${idx + 5}`).join(', ');
    const params = [conversationId, senderDeviceId, senderAccountDigest, receiverAccountDigest, ...messageIds];
    const stmt = env.DB.prepare(`
      SELECT message_id, account_digest, direction, COUNT(*) AS row_count
        FROM message_key_vault
       WHERE conversation_id=?1
         AND sender_device_id=?2
         AND account_digest IN (?3, ?4)
         AND direction IN ('outgoing', 'incoming')
         AND message_id IN (${placeholders})
       GROUP BY message_id, account_digest, direction
    `).bind(...params);
    const { results } = await stmt.all();
    const counterByMessage = new Map();
    for (const messageId of messageIds) {
      counterByMessage.set(messageId, { outgoingCount: 0, incomingCount: 0 });
    }
    for (const row of results) {
      const messageId = row?.message_id || null;
      if (!messageId || !counterByMessage.has(messageId)) continue;
      const entry = counterByMessage.get(messageId);
      if (!entry) continue;
      const rowCount = Number(row?.row_count) || 0;
      const account = row?.account_digest || '';
      const direction = row?.direction || '';
      if (account === senderAccountDigest && direction === 'outgoing') {
        entry.outgoingCount += rowCount;
      } else if (account === receiverAccountDigest && direction === 'incoming') {
        entry.incomingCount += rowCount;
      }
    }
    const items = messageIds.map((messageId) => {
      const entry = counterByMessage.get(messageId) || { outgoingCount: 0, incomingCount: 0 };
      return {
        messageId,
        outgoingCount: entry.outgoingCount,
        incomingCount: entry.incomingCount,
        totalCount: entry.outgoingCount + entry.incomingCount
      };
    });
    return json({
      ok: true,
      items,
      serverTime: Math.floor(Date.now() / 1000)
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/messages/secure/max-counter') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const senderAccountDigest = normalizeAccountDigest(body?.senderAccountDigest || body?.sender_account_digest);
    if (!conversationId || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'conversationId and senderDeviceId required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const where = ['conversation_id=?1', 'sender_device_id=?2'];
    const params = [conversationId, senderDeviceId];
    if (senderAccountDigest) {
      where.push(`sender_account_digest=?${params.length + 1}`);
      params.push(senderAccountDigest);
    }
    const row = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE ${where.join(' AND ')}
    `).bind(...params).first();
    const maxCounter = Number.isFinite(Number(row?.max_counter)) ? Number(row.max_counter) : null;
    return json({
      ok: true,
      conversationId,
      senderDeviceId,
      maxCounter,
      ts: Math.floor(Date.now() / 1000)
    });
  }

  if (req.method === 'GET' && url.pathname === '/d1/messages/by-counter') {
    const conversationIdRaw = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    const counterRaw = url.searchParams.get('counter');
    const senderDeviceRaw = url.searchParams.get('senderDeviceId') || url.searchParams.get('sender_device_id');
    const senderDigestRaw = url.searchParams.get('senderAccountDigest') || url.searchParams.get('sender_account_digest');
    const conversationId = normalizeConversationId(conversationIdRaw);
    const counter = Number(counterRaw);
    const senderDeviceId = normalizeDeviceId(senderDeviceRaw || null);
    const senderAccountDigest = normalizeAccountDigest(senderDigestRaw || null);
    if (!conversationId || !Number.isFinite(counter)) {
      return json({ error: 'BadRequest', message: 'conversationId and counter required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const where = ['conversation_id=?1', 'counter=?2'];
    const params = [conversationId, counter];
    if (senderDeviceId) {
      where.push(`sender_device_id=?${params.length + 1}`);
      params.push(senderDeviceId);
    }
    if (senderAccountDigest) {
      where.push(`sender_account_digest=?${params.length + 1}`);
      params.push(senderAccountDigest);
    }
    const row = await env.DB.prepare(`
      SELECT id, conversation_id, sender_account_digest, sender_device_id, receiver_account_digest, receiver_device_id,
             header_json, ciphertext_b64, counter, created_at
        FROM messages_secure
       WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    `).bind(...params).first();
    if (!row) {
      return json({ error: 'NotFound', message: 'message not found' }, { status: 404 });
    }
    return json({
      ok: true,
      item: {
        id: row.id,
        conversation_id: row.conversation_id,
        sender_account_digest: row.sender_account_digest,
        sender_device_id: row.sender_device_id,
        receiver_account_digest: row.receiver_account_digest,
        receiver_device_id: row.receiver_device_id,
        header_json: row.header_json,
        ciphertext_b64: row.ciphertext_b64,
        counter: row.counter,
        created_at: row.created_at
      }
    });
  }

  // Secure message insert
  if (req.method === 'POST' && url.pathname === '/d1/messages') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversation_id || body?.conversationId);
    const senderAccountDigest = normalizeAccountDigest(body?.sender_account_digest || body?.senderAccountDigest);
    const senderDeviceId = normalizeDeviceId(body?.sender_device_id || body?.senderDeviceId);
    const receiverAccountDigest = normalizeAccountDigest(body?.receiver_account_digest || body?.receiverAccountDigest);
    const receiverDeviceId = normalizeDeviceId(body?.receiver_device_id || body?.receiverDeviceId);
    const headerJson = typeof body?.header_json === 'string' ? body.header_json : (body?.header ? JSON.stringify(body.header) : null);
    const ciphertextB64 = typeof body?.ciphertext_b64 === 'string' ? body.ciphertext_b64 : null;
    const counter = Number(body?.counter);
    if (!conversationId || !senderAccountDigest || !senderDeviceId || !receiverAccountDigest || !headerJson || !ciphertextB64 || !Number.isFinite(counter)) {
      return json({ error: 'BadRequest', message: 'conversationId, sender/receiver digest+device, header_json, ciphertext_b64, counter required' }, { status: 400 });
    }
    let header;
    try {
      header = JSON.parse(headerJson);
    } catch {
      return json({ error: 'BadRequest', message: 'header_json invalid' }, { status: 400 });
    }
    const headerCounter = Number.isFinite(header?.n) ? header.n : Number(header?.counter);
    if (!Number.isFinite(headerCounter)) {
      return json({ error: 'BadRequest', message: 'header counter invalid' }, { status: 400 });
    }
    const headerDeviceId = normalizeDeviceId(header?.device_id || header?.deviceId || null);
    if (!headerDeviceId) {
      return json({ error: 'BadRequest', message: 'header device_id required' }, { status: 400 });
    }
    if (headerDeviceId !== senderDeviceId) {
      return json({ error: 'BadRequest', message: 'header device_id mismatch' }, { status: 400 });
    }
    const headerVersion = Number(header?.v ?? header?.version ?? 1);
    if (!Number.isFinite(headerVersion) || headerVersion <= 0) {
      return json({ error: 'BadRequest', message: 'header version invalid' }, { status: 400 });
    }
    if (!header?.iv_b64) {
      return json({ error: 'BadRequest', message: 'header iv_b64 required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const maxRow = await env.DB.prepare(`
      SELECT MAX(counter) AS max_counter
        FROM messages_secure
       WHERE conversation_id=?1
         AND sender_account_digest=?2
         AND sender_device_id=?3
    `).bind(conversationId, senderAccountDigest, senderDeviceId).first();
    const maxCounter = Number(maxRow?.max_counter ?? -1);
    if (Number.isFinite(maxCounter) && maxCounter >= 0 && counter <= maxCounter) {
      return json({ error: 'CounterTooLow', message: 'counter must be greater than previous', maxCounter }, { status: 409 });
    }
    await env.DB.prepare(`
      INSERT INTO conversations (id)
      VALUES (?1)
      ON CONFLICT(id) DO NOTHING
    `).bind(conversationId).run();
    await env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, 'member')
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(conversationId, senderAccountDigest, senderDeviceId).run();
    await env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, device_id, role)
      VALUES (?1, ?2, ?3, 'member')
      ON CONFLICT(conversation_id, account_digest, device_id) DO UPDATE SET updated_at=strftime('%s','now')
    `).bind(conversationId, receiverAccountDigest, receiverDeviceId || null).run();
    const messageId = typeof body?.id === 'string' && body.id.trim().length ? body.id.trim() : null;
    if (!messageId) {
      return json({ error: 'BadRequest', message: 'id (messageId) required' }, { status: 400 });
    }
    const createdAtInput = Number(body?.created_at || body?.ts || 0);
    const createdAt = Number.isFinite(createdAtInput) && createdAtInput > 0 ? createdAtInput : Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(`
        INSERT INTO messages_secure (
          id, conversation_id, sender_account_digest, sender_device_id,
          receiver_account_digest, receiver_device_id, header_json, ciphertext_b64, counter, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `).bind(
        messageId,
        conversationId,
        senderAccountDigest,
        senderDeviceId,
        receiverAccountDigest,
        receiverDeviceId || null,
        headerJson,
        ciphertextB64,
        counter,
        createdAt
      ).run();
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('unique') || msg.includes('primary')) {
        return json({ ok: true, id: messageId, created_at: createdAt });
      }
      console.warn('messages_secure insert failed', err);
      return json({ error: 'InsertFailed', message: err?.message || 'insert failed' }, { status: 500 });
    }
    return json({ ok: true, id: messageId, created_at: createdAt });
  }

  // List secure messages (Smart Fetch / Visible Limit)
  if (req.method === 'GET' && url.pathname === '/d1/messages') {
    const conversationIdRaw = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    let cursorTs = Number(url.searchParams.get('cursorTs') || url.searchParams.get('cursor_ts') || 0);
    let cursorCounter = Number(url.searchParams.get('cursorCounter') || url.searchParams.get('cursor_counter') || 0);
    let cursorId = url.searchParams.get('cursorId') || url.searchParams.get('cursor_id') || '';

    // Treat 'limit' as 'visibleLimit' (default 20, max 200)
    const visibleLimit = Math.min(Math.max(Number(url.searchParams.get('limit') || 20), 1), 200);

    const conversationId = normalizeConversationId(conversationIdRaw);
    if (!conversationId) {
      return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    }
    const requesterDigest = normalizeAccountDigest(req.headers.get('x-account-digest') || url.searchParams.get('requesterDigest'));
    if (!requesterDigest) {
      // Optional: if no digest, return all (or 403? standard practice: return all if system call, but strictly for user privacy we should require it)
      // For now, if missing, default to -1 (show all).
    }
    await ensureDataTables(env);

    const SEMANTIC_VISIBLE = new Set(['text', 'media', 'call-log', 'system']);
    function isVisibleItem(row) {
      if (!row || !row.header_json) return false;
      try {
        const header = JSON.parse(row.header_json);
        let type = header?.meta?.msgType || header?.meta?.msg_type || null;
        if (!type && row.ciphertext_b64) {
          type = 'text';
        }
        return type && SEMANTIC_VISIBLE.has(type.toLowerCase());
      } catch {
        return false;
      }
    }

    const MAX_ITERATIONS = 5;
    let iteration = 0;
    let totalVisible = 0;
    const allItems = [];
    let hasMoreGlobal = false;

    while (totalVisible < visibleLimit && iteration < MAX_ITERATIONS) {
      iteration++;
      const needed = visibleLimit - totalVisible;
      const nextLimit = Math.min(Math.max(needed * 2, 50), 200);

      const params = [conversationId];
      let cursorClause = '';
      if (Number.isFinite(cursorCounter) && cursorCounter > 0) {
        params.push(cursorCounter, cursorId || '');
        cursorClause = 'AND (counter < ?2 OR (counter = ?2 AND id < ?3))';
      } else if (cursorTs) {
        params.push(cursorTs, cursorId);
        cursorClause = 'AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))';
      }
      params.push(nextLimit + 1);

      const stmt = env.DB.prepare(`
        SELECT id, conversation_id, sender_account_digest, sender_device_id, receiver_account_digest, receiver_device_id,
               header_json, ciphertext_b64, counter, created_at
          FROM messages_secure
         WHERE conversation_id=?1
           ${cursorClause}
           AND counter > COALESCE((
             SELECT min_counter FROM deletion_cursors 
             WHERE conversation_id=?1 AND account_digest=?${params.length + 1}
           ), -1)
         ORDER BY counter DESC, created_at DESC, id DESC
         LIMIT ?${params.length}
      `).bind(...params, requesterDigest);

      const { results } = await stmt.all();
      const rawCount = results.length;
      const hasMoreLocal = rawCount > nextLimit;
      const batch = hasMoreLocal ? results.slice(0, nextLimit) : results;

      if (batch.length === 0) {
        hasMoreGlobal = false;
        break;
      }

      let lastItemInBatch = null;
      for (const row of batch) {
        if (totalVisible >= visibleLimit) {
          hasMoreGlobal = true;
          break;
        }

        const item = {
          id: row.id,
          conversation_id: row.conversation_id,
          sender_account_digest: row.sender_account_digest,
          sender_device_id: row.sender_device_id,
          receiver_account_digest: row.receiver_account_digest,
          receiver_device_id: row.receiver_device_id,
          header: safeJSON(row.header_json), // Root Cause Fix: Return parsed header object
          header_json: row.header_json,
          ciphertext_b64: row.ciphertext_b64,
          counter: row.counter,
          created_at: row.created_at
        };

        if (isVisibleItem(row)) {
          totalVisible++;
        }
        allItems.push(item);
        lastItemInBatch = item;
      }

      if (lastItemInBatch) {
        cursorCounter = lastItemInBatch.counter;
        cursorTs = lastItemInBatch.created_at;
        cursorId = lastItemInBatch.id;
      }

      if (totalVisible < visibleLimit) {
        if (!hasMoreLocal) {
          hasMoreGlobal = false;
          break;
        }
        hasMoreGlobal = true;
      } else {
        if (!hasMoreLocal && batch.length === results.length && totalVisible === visibleLimit) {
          // Check if there are more items after this exact point?
          // Since we fetched `nextLimit + 1` and hasMoreLocal is false, we know DB is empty after this batch.
          // If we consumed the WHOLE batch to hit the limit, then global hasMore is false (unless batch length < results length due to logical break?)
          // Actually `results.length` vs `batch.length` handles the +1 query.
          if (rawCount <= nextLimit) hasMoreGlobal = false;
          else hasMoreGlobal = true;
        } else {
          hasMoreGlobal = true;
        }
        break;
      }
    }

    const last = allItems.at(-1) || null;
    const nextCursor = last ? { ts: last.created_at, id: last.id, counter: last.counter } : null;

    const includeKeys = url.searchParams.get('includeKeys') === 'true' || url.searchParams.get('include_keys') === 'true';
    let keysMap = null;

    if (includeKeys && allItems.length > 0) {
      const ids = allItems.map(it => it.id).filter(id => typeof id === 'string');
      // Pass 'X-Account-Digest' from Controller to Worker to scope Vault Query
      const accountDigest = req.headers.get('x-account-digest');

      if (ids.length > 0 && accountDigest) {
        try {
          const placeholders = ids.map((_, i) => `?${i + 2}`).join(',');
          const stmtKeys = env.DB.prepare(`
            SELECT message_id, wrapped_mk_json, wrap_context_json, dr_state_snapshot
              FROM message_key_vault
             WHERE account_digest = ?1
               AND message_id IN (${placeholders})
          `).bind(accountDigest, ...ids);
          const { results: keyRows } = await stmtKeys.all();
          if (keyRows && keyRows.length > 0) {
            keysMap = {};
            for (const kRow of keyRows) {
              keysMap[kRow.message_id] = {
                wrapped_mk_json: safeJSON(kRow.wrapped_mk_json),
                wrap_context_json: safeJSON(kRow.wrap_context_json),
                dr_state_snapshot: safeJSON(kRow.dr_state_snapshot)
              };
            }
          }
        } catch (err) {
          console.warn('d1_messages_include_keys_failed', err);
        }
      }
    }

    return json({
      ok: true,
      items: allItems,
      keys: keysMap,
      nextCursor,
      nextCursorTs: nextCursor?.ts || null,
      nextCursorCounter: nextCursor?.counter ?? null,
      hasMoreAtCursor: hasMoreGlobal
    });
  }

  // Deletion Cursor API
  if (req.method === 'POST' && url.pathname === '/d1/deletion/cursor') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }

    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const targetDigest = normalizeAccountDigest(body?.targetDigest || body?.targetAccountDigest || body?.accountDigest);
    const minCounter = Number(body?.minCounter || body?.min_counter);

    // Security: Check if requester is allowed to mod this conversation? (Skip for now, internal trusted worker)
    if (!conversationId || !targetDigest || !Number.isFinite(minCounter)) {
      return json({ error: 'BadRequest', message: 'conversationId, targetDigest, minCounter required' }, { status: 400 });
    }

    await ensureDataTables(env);
    await env.DB.prepare(`
      INSERT INTO deletion_cursors (conversation_id, account_digest, min_counter, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(conversation_id, account_digest) DO UPDATE SET
        min_counter = excluded.min_counter,
        updated_at = excluded.updated_at
      WHERE excluded.min_counter > deletion_cursors.min_counter
    `).bind(conversationId, targetDigest, minCounter, Date.now()).run();

    return json({ ok: true, minCounter });
  }

  // Deletion Log (Soft Delete)
  if (req.method === 'POST' && url.pathname === '/d1/deletion/log') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'BadRequest' }, { status: 400 }); }

    const { accountDigest, conversationId } = body;
    const encryptedCheckpoint = body.encryptedCheckpoint || body.encrypted_checkpoint;

    if (!accountDigest || !conversationId || !encryptedCheckpoint) {
      return json({ error: 'BadRequest', message: 'Missing fields' }, { status: 400 });
    }

    try {
      await env.DB.prepare(`
        INSERT INTO conversation_deletion_log (owner_digest, conversation_id, encrypted_checkpoint)
        VALUES (?1, ?2, ?3)
      `).bind(accountDigest, conversationId, encryptedCheckpoint).run();
      return json({ ok: true });
    } catch (err) {
      console.warn('deletion_log_insert_failed', err);
      return json({ ok: false, error: err.message }, { status: 500 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/d1/deletion/log') {
    const accountDigest = url.searchParams.get('accountDigest') || url.searchParams.get('account_digest');
    const conversationId = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');

    if (!accountDigest || !conversationId) {
      return json({ error: 'BadRequest', message: 'Missing params' }, { status: 400 });
    }

    try {
      const results = await env.DB.prepare(`
        SELECT encrypted_checkpoint, created_at, id
        FROM conversation_deletion_log
        WHERE owner_digest = ?1 AND conversation_id = ?2
        ORDER BY id ASC
      `).bind(accountDigest, conversationId).all();
      return json({ ok: true, entries: results.results || [] });
    } catch (err) {
      console.warn('deletion_log_fetch_failed', err);
      return json({ ok: false, error: err.message }, { status: 500 });
    }
  }

  // Delete secure conversation
  if (req.method === 'POST' && url.pathname === '/d1/messages/secure/delete-conversation') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    if (!conversationId) {
      return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    }

    try {
      await resolveAccount(env, {
        accountToken: body.accountToken,
        accountDigest: body.accountDigest || body.account_digest
      });
    } catch (err) {
      console.warn('secure_delete_conversation_resolve_failed', err?.message || err);
    }

    await ensureDataTables(env);

    let deletedSecure = 0;
    let deletedGeneral = 0;
    try {
      const resSecure = await env.DB.prepare(
        `DELETE FROM messages_secure WHERE conversation_id=?1`
      ).bind(conversationId).run();
      deletedSecure = resSecure?.meta?.changes || 0;
    } catch (err) {
      console.warn('delete secure conversation failed', err?.message || err);
    }

    try {
      const resGeneral = await env.DB.prepare(
        `DELETE FROM messages WHERE conv_id=?1`
      ).bind(conversationId).run();
      deletedGeneral = resGeneral?.meta?.changes || 0;
    } catch (err) {
      console.warn('delete general conversation failed', err?.message || err);
    }

    try {
      await env.DB.prepare(
        `DELETE FROM conversations WHERE id=?1`
      ).bind(conversationId).run();
    } catch (err) {
      console.warn('delete conversations row failed', err?.message || err);
    }

    return json({ ok: true, deleted_secure: deletedSecure, deleted_general: deletedGeneral, conversation_id: conversationId });
  }

  // Batch delete messages/attachments by id
  if (req.method === 'POST' && url.pathname === '/d1/messages/delete') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const ids = Array.isArray(body?.ids)
      ? Array.from(new Set(body.ids.map((k) => String(k || '').trim()).filter(Boolean)))
      : [];
    if (!ids.length) {
      return json({ error: 'BadRequest', message: 'ids required' }, { status: 400 });
    }

    const results = [];
    for (const id of ids) {
      let secureCount = 0;
      let attachmentCount = 0;
      try {
        const resAttach = await env.DB.prepare(
          `DELETE FROM attachments WHERE message_id=?1`
        ).bind(id).run();
        attachmentCount = resAttach?.meta?.changes || 0;
      } catch (err) {
        console.warn('delete attachments failed', err);
      }
      try {
        const resSecure = await env.DB.prepare(
          `DELETE FROM messages_secure WHERE id=?1`
        ).bind(id).run();
        secureCount = resSecure?.meta?.changes || 0;
      } catch (err) {
        console.warn('delete messages_secure failed', err);
      }
      results.push({ id, secure: secureCount, attachments: attachmentCount });
    }

    return json({ ok: true, results });
  }

  return null;
}

async function handleContactSecretsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/contact-secrets/backup') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const payload = body?.payload;
    if (!payload || typeof payload !== 'object') {
      return json({ error: 'BadRequest', message: 'payload required' }, { status: 400 });
    }
    const snapshotVersion = Number.isFinite(Number(body?.snapshotVersion)) ? Number(body.snapshotVersion) : null;
    const entries = Number.isFinite(Number(body?.entries)) ? Number(body.entries) : null;
    const bytes = Number.isFinite(Number(body?.bytes)) ? Number(body.bytes) : null;
    const withDrState = Number.isFinite(Number(body?.withDrState)) ? Number(body.withDrState) : null;
    const checksum = typeof body?.checksum === 'string' ? String(body.checksum).slice(0, 128) : null;
    const deviceLabel = typeof body?.deviceLabel === 'string' ? String(body.deviceLabel).slice(0, 120) : null;
    const deviceId = typeof body?.deviceId === 'string' ? String(body.deviceId).slice(0, 120) : null;
    const updatedAt = normalizeTimestampMs(body?.updatedAt || body?.updated_at) || Date.now();
    let version = Number.isFinite(Number(body?.version)) && Number(body.version) > 0
      ? Math.floor(Number(body.version))
      : null;

    let existingWithDrState = null;
    const latestRows = await env.DB.prepare(
      `SELECT payload_json
        FROM contact_secret_backups
        WHERE account_digest=?1
        ORDER BY updated_at DESC, id DESC
        LIMIT 5`
    ).bind(accountDigest).all();
    const latestList = latestRows?.results || [];
    for (const row of latestList) {
      const parsed = parseBackupPayload(row.payload_json);
      if (Number.isFinite(parsed?.withDrState)) {
        existingWithDrState = parsed.withDrState;
        break;
      }
    }

    const existingVersionRow = await env.DB.prepare(
      `SELECT MAX(version) as max_version FROM contact_secret_backups WHERE account_digest=?1`
    ).bind(accountDigest).all();
    const nextVersion = Number(existingVersionRow?.results?.[0]?.max_version || 0);
    if (!version || version <= nextVersion) {
      version = nextVersion + 1;
    }

    if (Number.isFinite(withDrState) && Number.isFinite(existingWithDrState) && withDrState < existingWithDrState) {
      return json({ ok: false, error: 'ContactSecretsBackupRejected', message: 'withDrState regression' }, { status: 409 });
    }

    const payloadRecord = Number.isFinite(withDrState)
      ? { payload, meta: { withDrState } }
      : payload;

    await env.DB.prepare(
      `INSERT INTO contact_secret_backups (
          account_digest, version, payload_json, snapshot_version, entries,
          checksum, bytes, updated_at, device_label, device_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%s','now'))`
    ).bind(
      accountDigest,
      version,
      JSON.stringify(payloadRecord),
      snapshotVersion,
      entries,
      checksum,
      bytes,
      updatedAt,
      deviceLabel,
      deviceId
    ).run();

    await trimContactSecretBackups(env, accountDigest, 5);

    return json({
      ok: true,
      backup: {
        accountDigest,
        version,
        updatedAt,
        snapshotVersion,
        entries,
        bytes,
        checksum,
        deviceLabel,
        deviceId
      }
    });
  }

  if (req.method === 'GET' && url.pathname === '/d1/contact-secrets/backup') {
    const accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
    );
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const limitParam = Number(url.searchParams.get('limit') || 1);
    const limit = Math.min(Math.max(limitParam || 1, 1), 10);
    const versionParam = Number(url.searchParams.get('version') || 0);

    let stmt;
    if (Number.isFinite(versionParam) && versionParam > 0) {
      stmt = env.DB.prepare(
        `SELECT * FROM contact_secret_backups
          WHERE account_digest=?1 AND version=?2
          ORDER BY updated_at DESC
          LIMIT 1`
      ).bind(accountDigest, Math.floor(versionParam));
    } else {
      stmt = env.DB.prepare(
        `SELECT * FROM contact_secret_backups
          WHERE account_digest=?1
          ORDER BY updated_at DESC, id DESC
          LIMIT ?2`
      ).bind(accountDigest, limit);
    }
    const rows = await stmt.all();
    const backups = (rows?.results || []).map((row) => {
      const parsed = parseBackupPayload(row.payload_json);
      const parsedWithDrState = Number.isFinite(parsed?.withDrState) ? Number(parsed.withDrState) : null;
      return {
        id: row.id,
        accountDigest: row.account_digest,
        version: row.version,
        snapshotVersion: row.snapshot_version,
        entries: row.entries,
        checksum: row.checksum,
        bytes: row.bytes,
        updatedAt: Number(row.updated_at) || null,
        deviceLabel: row.device_label || null,
        deviceId: row.device_id || null,
        createdAt: Number(row.created_at) || null,
        payload: parsed?.payload ?? null,
        withDrState: parsedWithDrState
      };
    });
    return json({ ok: true, backups });
  }

  return null;
}

let messageKeyVaultSchemaWarned = false;
const VAULT_WORKER_LOG_LIMIT = 5;
let messageKeyVaultPutLogCount = 0;
let messageKeyVaultGetLogCount = 0;

function logMessageKeyVault(kind, payload) {
  if (kind === 'put' && messageKeyVaultPutLogCount >= VAULT_WORKER_LOG_LIMIT) return;
  if (kind === 'get' && messageKeyVaultGetLogCount >= VAULT_WORKER_LOG_LIMIT) return;
  if (kind === 'put') messageKeyVaultPutLogCount += 1;
  if (kind === 'get') messageKeyVaultGetLogCount += 1;
  try {
    console.log(kind === 'put' ? 'messageKeyVaultPut' : 'messageKeyVaultGet', payload);
  } catch {
    /* ignore logging errors */
  }
}

function shapeOf(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length ? 'string' : 'string(empty)';
  if (typeof value === 'object') return Array.isArray(value) ? 'array' : 'object';
  return typeof value;
}

function summarizeMessageKeyVaultShape(body = {}) {
  return {
    accountDigest: shapeOf(body?.accountDigest || body?.account_digest),
    conversationId: shapeOf(body?.conversationId || body?.conversation_id),
    messageId: shapeOf(body?.messageId || body?.message_id),
    senderDeviceId: shapeOf(body?.senderDeviceId || body?.sender_device_id),
    targetDeviceId: shapeOf(body?.targetDeviceId || body?.target_device_id),
    direction: shapeOf(body?.direction),
    msgType: shapeOf(body?.msgType || body?.msg_type),
    headerCounter: shapeOf(body?.headerCounter || body?.header_counter),
    wrapped_mk: shapeOf(body?.wrapped_mk || body?.wrappedMk),
    wrap_context: shapeOf(body?.wrap_context || body?.wrapContext)
  };
}

function validateWrappedMessageKeyEnvelope(wrapped) {
  if (!wrapped || typeof wrapped !== 'object') return false;
  const version = Number(wrapped.v ?? wrapped.version ?? 0);
  if (!Number.isFinite(version) || version <= 0) return false;
  if (wrapped.aead !== 'aes-256-gcm') return false;
  if (wrapped.info !== 'message-key/v1') return false;
  const salt = typeof wrapped.salt_b64 === 'string'
    ? wrapped.salt_b64
    : (typeof wrapped.salt === 'string' ? wrapped.salt : null);
  const iv = typeof wrapped.iv_b64 === 'string'
    ? wrapped.iv_b64
    : (typeof wrapped.iv === 'string' ? wrapped.iv : null);
  const ct = typeof wrapped.ct_b64 === 'string'
    ? wrapped.ct_b64
    : (typeof wrapped.ct === 'string' ? wrapped.ct : null);
  if (!salt || !iv || !ct) return false;
  return true;
}

function getWrapContextString(ctx, key) {
  if (!ctx || typeof ctx !== 'object') return null;
  const snake = key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  const raw = ctx[key] ?? ctx[snake];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function normalizeWrapContextDirection(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === 'incoming' || trimmed === 'outgoing' ? trimmed : null;
}

function normalizeWrapContextHeaderCounter(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function validateWrapContext(ctx, expected) {
  if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return false;
  const version = Number(ctx.v ?? ctx.version ?? 0);
  if (!Number.isFinite(version) || version <= 0) return false;
  const conversationId = getWrapContextString(ctx, 'conversationId');
  const messageId = getWrapContextString(ctx, 'messageId');
  const senderDeviceId = getWrapContextString(ctx, 'senderDeviceId');
  const targetDeviceId = getWrapContextString(ctx, 'targetDeviceId');
  const direction = normalizeWrapContextDirection(ctx.direction);
  if (!conversationId || conversationId !== expected.conversationId) return false;
  if (!messageId || messageId !== expected.messageId) return false;
  if (!senderDeviceId || senderDeviceId !== expected.senderDeviceId) return false;
  if (!targetDeviceId || targetDeviceId !== expected.targetDeviceId) return false;
  if (!direction || direction !== expected.direction) return false;
  const headerCounter = normalizeWrapContextHeaderCounter(ctx.headerCounter ?? ctx.header_counter);
  if (headerCounter !== (expected.headerCounter ?? null)) return false;
  const msgType = getWrapContextString(ctx, 'msgType');
  if (msgType && expected.msgType && msgType !== expected.msgType) return false;
  return true;
}

async function handleMessageKeyVaultRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/put') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const bodyShape = summarizeMessageKeyVaultShape(body);
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const targetDeviceId = normalizeDeviceId(body?.targetDeviceId || body?.target_device_id);
    const directionRaw = typeof body?.direction === 'string' ? body.direction.trim() : '';
    const direction = directionRaw === 'incoming' || directionRaw === 'outgoing' ? directionRaw : null;
    const msgType = typeof body?.msgType === 'string'
      ? body.msgType.trim()
      : (typeof body?.msg_type === 'string' ? body.msg_type.trim() : null);
    const headerCounterRaw = body?.headerCounter ?? body?.header_counter;
    const headerCounter = (headerCounterRaw === null || headerCounterRaw === undefined || headerCounterRaw === '')
      ? null
      : (Number.isFinite(Number(headerCounterRaw)) ? Number(headerCounterRaw) : null);
    const wrapped = body?.wrapped_mk || body?.wrappedMk || null;
    const wrapContext = body?.wrap_context || body?.wrapContext || null;
    const drStateSnapshot = body?.dr_state || body?.drState || null; // Atomic Piggyback State

    if (!accountDigest || !conversationId || !messageId || !senderDeviceId || !targetDeviceId || !direction || !wrapped || !wrapContext) {
      console.warn('messageKeyVault.put.badPayload', {
        reason: 'required-missing',
        shape: bodyShape
      });
      return json({ error: 'BadRequest', message: 'accountDigest, conversationId, messageId, senderDeviceId, targetDeviceId, direction, wrapped_mk, wrap_context required' }, { status: 400 });
    }
    if (!validateWrappedMessageKeyEnvelope(wrapped)) {
      console.warn('messageKeyVault.put.badPayload', {
        reason: 'wrapped-envelope-invalid',
        shape: bodyShape
      });
      return json({ error: 'InvalidWrappedPayload', message: 'wrapped envelope missing required fields' }, { status: 400 });
    }
    if (!validateWrapContext(wrapContext, {
      conversationId,
      messageId,
      senderDeviceId,
      targetDeviceId,
      direction,
      msgType,
      headerCounter
    })) {
      console.warn('messageKeyVault.put.badPayload', {
        reason: 'wrap-context-invalid',
        shape: bodyShape
      });
      return json({ error: 'InvalidWrapContext', message: 'wrap_context invalid or mismatched' }, { status: 400 });
    }

    try {
      await ensureDataTables(env);
    } catch (err) {
      const message = err?.message || String(err);
      if (message.includes('message_key_vault')) {
        if (!messageKeyVaultSchemaWarned) {
          messageKeyVaultSchemaWarned = true;
          console.error('message_key_vault_schema_missing', message);
        }
        return json({ error: 'SchemaMissing', message: 'message_key_vault table missing; apply migration' }, { status: 500 });
      }
      throw err;
    }

    try {
      const result = await env.DB.prepare(
        `INSERT INTO message_key_vault (
            account_digest, conversation_id, message_id, sender_device_id,
            target_device_id, direction, msg_type, header_counter, wrapped_mk_json, wrap_context_json, dr_state_snapshot, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, strftime('%s','now'))
         ON CONFLICT(account_digest, conversation_id, message_id, sender_device_id)
         DO NOTHING`
      ).bind(
        accountDigest,
        conversationId,
        messageId,
        senderDeviceId,
        targetDeviceId,
        direction,
        msgType,
        headerCounter,
        JSON.stringify(wrapped),
        JSON.stringify(wrapContext),
        drStateSnapshot || null
      ).run();
      if (result?.changes === 0) {
        logMessageKeyVault('put', {
          accountDigestSuffix4: accountDigest.slice(-4),
          conversationIdPrefix8: conversationId.slice(0, 8),
          messageIdPrefix8: messageId.slice(0, 8),
          senderDeviceIdSuffix4: senderDeviceId.slice(-4),
          duplicate: true
        });
        return json({ ok: true, duplicate: true });
      }
    } catch (err) {
      console.warn('message_key_vault_put_failed', err?.message || err);
      return json({ error: 'InsertFailed', message: err?.message || 'unable to store message key' }, { status: 500 });
    }

    logMessageKeyVault('put', {
      accountDigestSuffix4: accountDigest.slice(-4),
      conversationIdPrefix8: conversationId.slice(0, 8),
      messageIdPrefix8: messageId.slice(0, 8),
      senderDeviceIdSuffix4: senderDeviceId.slice(-4),
      duplicate: false
    });
    return json({ ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/get') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);
    const headerCounter = body?.headerCounter ?? body?.header_counter;
    const headerCounterNum = Number.isFinite(Number(headerCounter)) ? Number(headerCounter) : null;

    if (!accountDigest || !conversationId || !senderDeviceId || (!messageId && headerCounterNum === null)) {
      return json({ error: 'BadRequest', message: 'accountDigest, conversationId, senderDeviceId, and (messageId or headerCounter) required' }, { status: 400 });
    }
    try {
      await ensureDataTables(env);
    } catch (err) {
      return json({ error: 'SchemaMissing', message: 'database not ready' }, { status: 500 });
    }

    let row = null;
    if (headerCounterNum !== null) {
      row = await env.DB.prepare(
        `SELECT wrapped_mk_json, wrap_context_json, direction, msg_type, header_counter, target_device_id, dr_state_snapshot, created_at
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND sender_device_id=?3 AND header_counter=?4
          ORDER BY created_at DESC
          LIMIT 1`
      ).bind(accountDigest, conversationId, senderDeviceId, headerCounterNum).first();
    } else {
      row = await env.DB.prepare(
        `SELECT wrapped_mk_json, wrap_context_json, direction, msg_type, header_counter, target_device_id, dr_state_snapshot, created_at
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND sender_device_id=?3 AND message_id=?4
          ORDER BY created_at DESC
          LIMIT 1`
      ).bind(accountDigest, conversationId, senderDeviceId, messageId).first();
    }

    if (!row) {
      logMessageKeyVault('get', {
        accountDigestSuffix4: accountDigest.slice(-4),
        conversationIdPrefix8: conversationId.slice(0, 8),
        messageIdPrefix8: messageId.slice(0, 8),
        senderDeviceIdSuffix4: senderDeviceId.slice(-4),
        found: false
      });
      return json({ error: 'NotFound', message: 'message key not found' }, { status: 404 });
    }
    logMessageKeyVault('get', {
      accountDigestSuffix4: accountDigest.slice(-4),
      conversationIdPrefix8: conversationId.slice(0, 8),
      messageIdPrefix8: messageId.slice(0, 8),
      senderDeviceIdSuffix4: senderDeviceId.slice(-4),
      found: true
    });
    return json({
      ok: true,
      wrapped_mk: safeJSON(row.wrapped_mk_json),
      wrap_context: safeJSON(row.wrap_context_json),
      dr_state: row.dr_state_snapshot || null,
      direction: row.direction || null,
      msgType: row.msg_type || null,
      headerCounter: Number(row.header_counter) || null,
      targetDeviceId: row.target_device_id || null,
      createdAt: Number(row.created_at) || null
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/latest-state') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);

    if (!accountDigest || !conversationId) {
      return json({ error: 'BadRequest', message: 'accountDigest and conversationId required' }, { status: 400 });
    }
    try {
      await ensureDataTables(env);
    } catch (err) {
      return json({ error: 'SchemaMissing', message: 'database not ready' }, { status: 500 });
    }

    // Parallel fetch: Latest Outgoing (My Send) & Latest Incoming (My Receive)
    // Note: 'sender_device_id' in Vault is the person who emitted the message.
    // For Outgoing: sender_device_id should be one of MY devices (but we might check all my devices? or just the current one?)
    // Actually, DR State is device-specific. So we only care about state relevant to THIS device?
    // Wait. If I am restoring on specific device D1...
    // I want the state that D1 pushed (Outgoing) OR the state D1 received (Incoming target=D1).
    // The Vault stores:
    // account_digest = ME
    // sender_device_id = Sender
    // target_device_id = Receiver

    // Case 1: Latest Outgoing (I sent it)
    // account_digest=ME, sender_device_id=MY_DEV_ID (if passed) OR any of my devices?
    // Usually we want the specific device's chain.
    // If strict device binding: sender_device_id = passed senderDeviceId.

    // Case 2: Latest Incoming (I received it)
    // account_digest=ME, target_device_id=MY_DEV_ID.
    // AND sender_device_id=THE_PEER?
    // If we want "Latest Incoming from ANY peer", that's broad.
    // If we want "Latest state for this conversation", we usually mean "Between Me and Peer X".
    // But Vault index is (account, conv, msg_id).
    // It does NOT easily index "Latest by Conversation".
    // We have index `account_digest, conversation_id, message_id`.
    // We do NOT have an index on `created_at` or `header_counter` grouped by conversation!
    // Searching `WHERE account_digest=? AND conversation_id=? ORDER BY header_counter DESC` might be slow without index.
    // However, D1/SQLite might optimize if PK prefix matches.
    // Let's try to fetch both directions.

    // Optimization: If senderDeviceId is provided, we assume it's "Self Device ID" for outgoing matching.

    const [outgoingRow, incomingRow] = await Promise.all([
      // 1. Latest Outgoing (I sent)
      env.DB.prepare(
        `SELECT dr_state_snapshot, header_counter, created_at, sender_device_id
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND direction='outgoing'
            ${senderDeviceId ? 'AND sender_device_id=?3' : ''}
          ORDER BY header_counter DESC
          LIMIT 1`
      ).bind(
        accountDigest,
        conversationId,
        ...(senderDeviceId ? [senderDeviceId] : [])
      ).first(),

      // 2. Latest Incoming (I received)
      // Note: We filter by direction='incoming'. we don't necessarily filter by sender_device_id unless we want specific peer.
      // Usually we want "Latest from anyone in this convo" (e.g. group) or "Latest from Peer" (DM).
      // Double Ratchet is 1:1. So Conversation = Peer in 1:1.
      // So simple 'incoming' check is sufficient for DM.
      env.DB.prepare(
        `SELECT dr_state_snapshot, header_counter, created_at, sender_device_id
           FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND direction='incoming'
          ORDER BY header_counter DESC
          LIMIT 1`
      ).bind(accountDigest, conversationId).first()
    ]);

    return json({
      ok: true,
      outgoing: outgoingRow ? {
        dr_state: outgoingRow.dr_state_snapshot || null,
        headerCounter: Number(outgoingRow.header_counter) || 0,
        createdAt: Number(outgoingRow.created_at) || 0,
        senderDeviceId: outgoingRow.sender_device_id
      } : null,
      incoming: incomingRow ? {
        dr_state: incomingRow.dr_state_snapshot || null,
        headerCounter: Number(incomingRow.header_counter) || 0,
        createdAt: Number(incomingRow.created_at) || 0,
        senderDeviceId: incomingRow.sender_device_id
      } : null
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/delete') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);
    const senderDeviceId = normalizeDeviceId(body?.senderDeviceId || body?.sender_device_id);

    if (!accountDigest || !conversationId || !messageId || !senderDeviceId) {
      return json({ error: 'BadRequest', message: 'accountDigest, conversationId, messageId, senderDeviceId required' }, { status: 400 });
    }

    try {
      await ensureDataTables(env);
      const result = await env.DB.prepare(
        `DELETE FROM message_key_vault
          WHERE account_digest=?1 AND conversation_id=?2 AND message_id=?3 AND sender_device_id=?4`
      ).bind(accountDigest, conversationId, messageId, senderDeviceId).run();

      const deleted = result?.changes > 0;
      logMessageKeyVault('delete', {
        accountDigestSuffix4: accountDigest.slice(-4),
        conversationIdPrefix8: conversationId.slice(0, 8),
        messageIdPrefix8: messageId.slice(0, 8),
        senderDeviceIdSuffix4: senderDeviceId.slice(-4),
        deleted
      });
      return json({ ok: true, deleted });
    } catch (err) {
      console.warn('message_key_vault_delete_failed', err?.message || err);
      return json({ error: 'DeleteFailed', message: err?.message || 'unable to delete message key' }, { status: 500 });
    }
  }

  if (req.method === 'POST' && url.pathname === '/d1/message-key-vault/count') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const messageId = normalizeMessageId(body?.messageId || body?.message_id);

    if (!conversationId || !messageId) {
      return json({ error: 'BadRequest', message: 'conversationId, messageId required' }, { status: 400 });
    }

    try {
      await ensureDataTables(env);
    } catch (err) {
      // similar error handling if needed, usually ensureDataTables handles log
    }

    const row = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM message_key_vault
        WHERE conversation_id=?1 AND message_id=?2`
    ).bind(conversationId, messageId).first();

    const count = Number(row?.count || 0);
    return json({ ok: true, count });
  }

  return null;
}

async function handleGroupsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/groups/create') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const groupId = normalizeGroupId(body?.groupId || body?.group_id);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const creatorAccountDigest = normalizeAccountDigest(body?.creatorAccountDigest || body?.creator_account_digest);
    const name = normalizeGroupName(body?.name);
    const avatarJson = normalizeGroupAvatar(body?.avatar || body?.avatarJson || body?.avatar_json);
    const membersInput = Array.isArray(body?.members) ? body.members : [];
    if (!groupId || !conversationId || !creatorAccountDigest) {
      return json({ error: 'BadRequest', message: 'groupId, conversationId, creatorAccountDigest required' }, { status: 400 });
    }

    await ensureDataTables(env);
    const now = Math.floor(Date.now() / 1000);
    try {
      await env.DB.prepare(`
        INSERT INTO groups (group_id, conversation_id, creator_account_digest, name, avatar_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
        ON CONFLICT(group_id) DO UPDATE SET
          conversation_id=excluded.conversation_id,
          name=excluded.name,
          avatar_json=excluded.avatar_json,
          updated_at=strftime('%s','now')
      `).bind(groupId, conversationId, creatorAccountDigest, name, avatarJson, now).run();
    } catch (err) {
      console.warn('group_create_failed', err?.message || err);
      return json({ error: 'CreateFailed', message: err?.message || 'unable to create group' }, { status: 500 });
    }

    await upsertGroupMember(env, {
      groupId,
      accountDigest: creatorAccountDigest,
      role: 'owner',
      status: 'active',
      inviterAccountDigest: creatorAccountDigest,
      joinedAt: now
    });
    await grantConversationAccess(env, { conversationId, accountDigest: creatorAccountDigest });

    const seenDigests = new Set([creatorAccountDigest]);
    for (const entry of membersInput) {
      const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
      if (!acct || seenDigests.has(acct)) continue;
      seenDigests.add(acct);
      const role = normalizeGroupRole(entry?.role);
      await upsertGroupMember(env, {
        groupId,
        accountDigest: acct,
        role,
        status: 'active',
        inviterAccountDigest: creatorAccountDigest,
        joinedAt: now
      });
      await grantConversationAccess(env, { conversationId, accountDigest: acct });
    }

    const detail = await fetchGroupWithMembers(env, groupId);
    return json(detail ? { ok: true, ...detail } : { ok: true, groupId });
  }

  if (req.method === 'POST' && url.pathname === '/d1/groups/members/add') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const groupId = normalizeGroupId(body?.groupId || body?.group_id);
    const membersInput = Array.isArray(body?.members) ? body.members : [];
    if (!groupId || !membersInput.length) {
      return json({ error: 'BadRequest', message: 'groupId and members required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const groupRow = await env.DB.prepare(`SELECT conversation_id FROM groups WHERE group_id=?1`).bind(groupId).all();
    const group = groupRow?.results?.[0] || null;
    if (!group) {
      return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
    }
    const conversationId = group.conversation_id;
    const now = Math.floor(Date.now() / 1000);
    let added = 0;
    for (const entry of membersInput) {
      const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
      if (!acct) continue;
      const role = normalizeGroupRole(entry?.role);
      const inviterAcct = normalizeAccountDigest(entry?.inviterAccountDigest || entry?.inviter_account_digest);
      await upsertGroupMember(env, {
        groupId,
        accountDigest: acct,
        role,
        status: 'active',
        inviterAccountDigest: inviterAcct,
        joinedAt: now
      });
      await grantConversationAccess(env, { conversationId, accountDigest: acct });
      added += 1;
    }
    const detail = await fetchGroupWithMembers(env, groupId);
    return json(detail ? { ok: true, added, ...detail } : { ok: true, added });
  }

  if (req.method === 'POST' && url.pathname === '/d1/groups/members/remove') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const groupId = normalizeGroupId(body?.groupId || body?.group_id);
    const membersInput = Array.isArray(body?.members) ? body.members : [];
    const statusOverride = normalizeGroupStatus(body?.status);
    if (!groupId || !membersInput.length) {
      return json({ error: 'BadRequest', message: 'groupId and members required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const groupRow = await env.DB.prepare(`SELECT conversation_id FROM groups WHERE group_id=?1`).bind(groupId).all();
    const group = groupRow?.results?.[0] || null;
    if (!group) {
      return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
    }
    const conversationId = group.conversation_id;
    const now = Math.floor(Date.now() / 1000);
    let removed = 0;
    for (const entry of membersInput) {
      const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
      if (!acct) continue;
      const status = statusOverride || normalizeGroupStatus(entry?.status) || 'removed';
      try {
        await env.DB.prepare(`
          UPDATE group_members
             SET status=?3,
                 updated_at=strftime('%s','now')
           WHERE group_id=?1 AND account_digest=?2
        `).bind(groupId, acct, status).run();
        removed += 1;
      } catch (err) {
        console.warn('group_member_remove_failed', err?.message || err);
      }
      await removeConversationAccess(env, { conversationId, accountDigest: acct });
    }
    const detail = await fetchGroupWithMembers(env, groupId);
    return json(detail ? { ok: true, removed, ...detail } : { ok: true, removed });
  }

  if (req.method === 'GET' && url.pathname === '/d1/groups/get') {
    const groupId = normalizeGroupId(
      url.searchParams.get('groupId')
      || url.searchParams.get('group_id')
    );
    if (!groupId) {
      return json({ error: 'BadRequest', message: 'groupId required' }, { status: 400 });
    }
    const detail = await fetchGroupWithMembers(env, groupId);
    if (!detail) {
      return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
    }
    return json({ ok: true, ...detail });
  }

  return null;
}

async function handleMediaRoutes(req, env) {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/d1/media/usage') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const convIdRaw = body?.convId ?? body?.conversationId;
    if (!convIdRaw || typeof convIdRaw !== 'string') {
      return json({ error: 'BadRequest', message: 'convId required' }, { status: 400 });
    }
    const convId = normalizeConversationId(convIdRaw);
    if (!convId) {
      return json({ error: 'BadRequest', message: 'invalid convId' }, { status: 400 });
    }
    const prefixRaw = typeof body?.prefix === 'string' ? body.prefix.trim() : '';
    let prefix = prefixRaw || convId;
    prefix = prefix.replace(/[\u0000-\u001F\u007F]/gu, '');
    if (!prefix.startsWith(convId)) {
      prefix = convId;
    }
    const ensureSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
    let totalBytes = 0;
    let objectCount = 0;
    try {
      const stmt = await env.DB.prepare(`
        SELECT
          COALESCE(SUM(COALESCE(size_bytes, 0)), 0) AS total_bytes,
          COUNT(*) AS object_count
        FROM attachments
        WHERE conversation_id=?1
          AND object_key LIKE ?2
      `).bind(convId, `${ensureSlash}%`).all();
      const row = stmt?.results?.[0] || null;
      totalBytes = Number(row?.total_bytes ?? 0);
      objectCount = Number(row?.object_count ?? 0);
    } catch (err) {
      console.warn('media usage query failed', err?.message || err);
      return json({ error: 'UsageQueryFailed', message: err?.message || 'media usage query failed' }, { status: 500 });
    }
    return json({
      ok: true,
      convId,
      prefix,
      totalBytes,
      objectCount
    });
  }
  return null;
}

async function handleConversationRoutes(req, env) {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/d1/conversations/authorize') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    if (!conversationId) {
      return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const deviceId = normalizeDeviceId(body?.deviceId || body?.device_id) || null;
    if (!deviceId) {
      return json({ error: 'BadRequest', message: 'deviceId required' }, { status: 400 });
    }
    await ensureDataTables(env);
    let deviceExists = false;
    try {
      const devRow = await env.DB.prepare(
        `SELECT 1 FROM devices WHERE account_digest=?1 AND device_id=?2`
      ).bind(accountDigest, deviceId).first();
      deviceExists = !!devRow;
    } catch (err) {
      console.warn('device_lookup_failed', err?.message || err);
    }
    if (!deviceExists) {
      return json({ error: 'DeviceNotFound', message: 'device not registered' }, { status: 404 });
    }
    let row;
    try {
      const res = await env.DB.prepare(
        `SELECT device_id FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2 AND (device_id=?3 OR device_id IS NULL)`
      ).bind(conversationId, accountDigest, deviceId).all();
      row = res?.results?.[0] || null;
    } catch (err) {
      console.warn('conversation_acl_query_failed', err?.message || err);
      return json({ error: 'ConversationLookupFailed', message: err?.message || 'lookup failed' }, { status: 500 });
    }
    if (!row) {
      await grantConversationAccess(env, { conversationId, accountDigest, deviceId });
      return json({ ok: true, created: true });
    }
    if (row?.device_id === null) {
      await grantConversationAccess(env, { conversationId, accountDigest, deviceId });
    }
    return json({ ok: true, deviceId });
  }
  return null;
}

async function handleSubscriptionRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/subscription/redeem') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const digest = normalizeAccountDigest(body?.digest || body?.accountDigest || body?.account_digest || body?.usedByDigest || body?.used_by_digest);
    const tokenId = typeof body?.tokenId === 'string' ? body.tokenId.trim() : (typeof body?.token_id === 'string' ? body.token_id.trim() : (typeof body?.voucherId === 'string' ? body.voucherId.trim() : null));
    const jti = typeof body?.jti === 'string' ? body.jti.trim() : null;
    const agentId = typeof body?.agentId === 'string' ? body.agentId.trim() : null;
    const keyId = typeof body?.keyId === 'string' ? body.keyId.trim() : 'default';
    const signatureB64 = typeof body?.signatureB64 === 'string' ? body.signatureB64.trim() : (typeof body?.signature_b64 === 'string' ? body.signature_b64.trim() : null);
    const issuedAt = Number(body?.issuedAt || body?.issued_at || 0);
    const durationDays = Number(body?.durationDays || body?.extend_days || 0);
    const dryRun = body?.dryRun === true;
    if (!digest) {
      return json({ error: 'BadRequest', message: 'digest required' }, { status: 400 });
    }
    if (!tokenId && !jti) {
      return json({ error: 'BadRequest', message: 'tokenId required' }, { status: 400 });
    }
    const tokenKey = tokenId || jti;
    if (!Number.isFinite(durationDays) || durationDays <= 0) {
      return json({ error: 'BadRequest', message: 'durationDays required' }, { status: 400 });
    }
    const now = Math.floor(Date.now() / 1000);
    const durationSeconds = Math.floor(durationDays * 86400);

    let currentExpires = 0;
    try {
      const row = await env.DB.prepare(`SELECT expires_at FROM subscriptions WHERE digest=?1`).bind(digest).all();
      currentExpires = Number(row?.results?.[0]?.expires_at || 0);
    } catch (err) {
      console.warn('subscription_lookup_failed', err?.message || err);
    }
    const base = Math.max(currentExpires, now);
    const newExpires = base + durationSeconds;

    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        tokenId: tokenKey,
        digest,
        currentExpires,
        expiresAt: newExpires,
        durationDays
      });
    }

    try {
      const existingToken = await env.DB.prepare(
        `SELECT token_id, status, used_at, used_by_digest FROM tokens WHERE token_id=?1`
      ).bind(tokenKey).all();
      const tokenRow = existingToken?.results?.[0] || null;
      if (tokenRow && tokenRow.status === 'used') {
        return json({
          error: 'TokenUsed',
          message: '憑證已被使用',
          tokenId: tokenKey,
          used_at: tokenRow.used_at || null,
          used_by_digest: tokenRow.used_by_digest || null
        }, { status: 409 });
      }

      const batch = [];
      batch.push(env.DB.prepare(
        `INSERT INTO subscriptions (digest, expires_at, updated_at, created_at)
           VALUES (?1, ?2, strftime('%s','now'), strftime('%s','now'))
           ON CONFLICT(digest) DO UPDATE SET expires_at=excluded.expires_at, updated_at=strftime('%s','now')`
      ).bind(digest, newExpires));

      batch.push(env.DB.prepare(
        `INSERT INTO tokens (token_id, digest, issued_at, extend_days, nonce, key_id, signature_b64, status, used_at, used_by_digest, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'used', ?8, ?9, strftime('%s','now'))
           ON CONFLICT(token_id) DO UPDATE SET digest=excluded.digest, extend_days=excluded.extend_days, key_id=excluded.key_id, signature_b64=excluded.signature_b64, status='used', used_at=excluded.used_at, used_by_digest=excluded.used_by_digest`
      ).bind(
        tokenKey,
        digest,
        Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt : now,
        durationDays,
        typeof body?.nonce === 'string' ? body.nonce.trim() : null,
        keyId,
        signatureB64 || '',
        now,
        digest
      ));

      batch.push(env.DB.prepare(
        `INSERT INTO extend_logs (token_id, digest, extend_days, expires_at_after, used_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, strftime('%s','now'))`
      ).bind(tokenKey, digest, durationDays, newExpires, now));

      await env.DB.batch(batch);
    } catch (err) {
      console.error('subscription_redeem_failed', err?.message || err);
      const msg = err?.message || '展期失敗，請稍後再試';
      return json({ error: 'RedeemFailed', message: msg }, { status: 500 });
    }

    return json({
      ok: true,
      tokenId: tokenKey,
      digest,
      currentExpires,
      expiresAt: newExpires,
      durationDays,
      usedAt: now,
      agentId: agentId || null
    });
  }

  if (req.method === 'GET' && url.pathname === '/d1/subscription/status') {
    await ensureDataTables(env);
    const digest = normalizeAccountDigest(url.searchParams.get('digest'));
    const uidDigest = normalizeAccountDigest(url.searchParams.get('uidDigest') || url.searchParams.get('uid_digest'));
    const limitRaw = url.searchParams.get('limit');
    const limit = Number.isFinite(Number(limitRaw)) ? Math.min(Math.max(Math.floor(Number(limitRaw)), 1), 200) : 50;
    let targetDigest = digest || null;
    if (!targetDigest && uidDigest) {
      try {
        const acct = await env.DB.prepare(
          `SELECT account_digest FROM accounts WHERE uid_digest=?1`
        ).bind(uidDigest).first();
        targetDigest = acct?.account_digest || null;
      } catch (err) {
        console.warn('subscription_uid_lookup_failed', err?.message || err);
      }
    }
    if (!targetDigest) {
      return json({ error: 'BadRequest', message: 'digest required' }, { status: 400 });
    }
    let record = null;
    let accountCreatedAt = null;
    let logs = [];
    try {
      const row = await env.DB.prepare(
        `SELECT digest, expires_at, updated_at FROM subscriptions WHERE digest=?1`
      ).bind(targetDigest).all();
      record = row?.results?.[0] || null;
    } catch (err) {
      console.warn('subscription_status_query_failed', err?.message || err);
    }
    try {
      const acctRow = await env.DB.prepare(
        `SELECT created_at FROM accounts WHERE account_digest=?1`
      ).bind(targetDigest).all();
      const acct = acctRow?.results?.[0] || null;
      accountCreatedAt = acct?.created_at ? Number(acct.created_at) : null;
    } catch (err) {
      console.warn('subscription_account_query_failed', err?.message || err);
    }
    try {
      const logRows = await env.DB.prepare(
        `SELECT l.token_id, l.extend_days, l.expires_at_after, l.used_at, t.status, t.key_id, t.created_at
           FROM extend_logs l
           LEFT JOIN tokens t ON l.token_id = t.token_id
          WHERE l.digest=?1
          ORDER BY l.used_at DESC
          LIMIT ?2`
      ).bind(targetDigest, limit).all();
      logs = Array.isArray(logRows?.results) ? logRows.results : [];
    } catch (err) {
      console.warn('subscription_logs_query_failed', err?.message || err);
    }
    if (!record) {
      return json({ ok: true, found: false, digest: targetDigest, now: Math.floor(Date.now() / 1000), account_created_at: accountCreatedAt, logs });
    }
    const now = Math.floor(Date.now() / 1000);
    return json({
      ok: true,
      found: true,
      digest: targetDigest,
      expires_at: Number(record.expires_at || 0),
      updated_at: Number(record.updated_at || 0),
      now,
      account_created_at: accountCreatedAt,
      logs
    });
  }

  if (req.method === 'GET' && url.pathname === '/d1/subscription/token-status') {
    await ensureDataTables(env);
    const tokenId = url.searchParams.get('tokenId') || url.searchParams.get('voucherId') || url.searchParams.get('jti');
    const tokenKey = typeof tokenId === 'string' ? tokenId.trim() : '';
    if (!tokenKey) {
      return json({ error: 'BadRequest', message: 'tokenId required' }, { status: 400 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT token_id, digest, issued_at, extend_days, nonce, key_id, signature_b64, status, used_at, used_by_digest, created_at
           FROM tokens
          WHERE token_id=?1`
      ).bind(tokenKey).all();
      const token = row?.results?.[0] || null;
      if (!token) {
        return json({ ok: true, found: false, tokenId: tokenKey });
      }
      let lastLog = null;
      try {
        const logRow = await env.DB.prepare(
          `SELECT expires_at_after, used_at, extend_days
             FROM extend_logs
            WHERE token_id=?1
            ORDER BY used_at DESC
            LIMIT 1`
        ).bind(tokenKey).all();
        lastLog = logRow?.results?.[0] || null;
      } catch (err) {
        console.warn('token_log_query_failed', err?.message || err);
      }
      return json({
        ok: true,
        found: true,
        tokenId: token.token_id,
        digest: token.digest,
        issued_at: Number(token.issued_at || 0),
        extend_days: Number(token.extend_days || 0),
        key_id: token.key_id || null,
        signature_b64: token.signature_b64 || null,
        status: token.status || null,
        used_at: token.used_at ? Number(token.used_at) : null,
        used_by_digest: token.used_by_digest || null,
        created_at: Number(token.created_at || 0) || null,
        expires_at_after: lastLog?.expires_at_after || null,
        last_extend_days: lastLog?.extend_days || null
      });
    } catch (err) {
      console.error('token_status_failed', err?.message || err);
      return json({ error: 'TokenStatusFailed', message: err?.message || 'query failed' }, { status: 500 });
    }
  }

  return null;
}

async function handleCallsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'POST' && url.pathname === '/d1/calls/session') {
    await cleanupCallTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const result = await upsertCallSession(env, body || {});
    if (!result.ok) {
      return json({ error: result.error || 'CallSessionUpsertFailed', message: result.message || 'unable to store call session' }, { status: result.status || 400 });
    }
    return json({ ok: true, session: result.session });
  }

  if (req.method === 'GET' && url.pathname === '/d1/calls/session') {
    await cleanupCallTables(env);
    const callId = normalizeCallId(url.searchParams.get('callId') || url.searchParams.get('call_id') || url.searchParams.get('id'));
    if (!callId) {
      return json({ error: 'BadRequest', message: 'callId required' }, { status: 400 });
    }
    const rows = await env.DB.prepare(
      `SELECT * FROM call_sessions WHERE call_id=?1`
    ).bind(callId).all();
    const row = rows?.results?.[0];
    if (!row) {
      return json({ error: 'NotFound', message: 'call session not found' }, { status: 404 });
    }
    return json({ ok: true, session: serializeCallSessionRow(row) });
  }

  if (req.method === 'POST' && url.pathname === '/d1/calls/events') {
    await cleanupCallTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const result = await insertCallEvent(env, body || {});
    if (!result.ok) {
      return json({ error: result.error || 'CallEventInsertFailed', message: result.message || 'unable to store call event' }, { status: result.status || 400 });
    }
    return json({ ok: true, event: result.event });
  }

  if (req.method === 'GET' && url.pathname === '/d1/calls/events') {
    await cleanupCallTables(env);
    const callId = normalizeCallId(url.searchParams.get('callId') || url.searchParams.get('call_id') || url.searchParams.get('id'));
    if (!callId) {
      return json({ error: 'BadRequest', message: 'callId required' }, { status: 400 });
    }
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
    const rows = await env.DB.prepare(
      `SELECT event_id, call_id, type, payload_json, from_account_digest, to_account_digest, trace_id, created_at
         FROM call_events
        WHERE call_id=?1
        ORDER BY created_at DESC
        LIMIT ?2`
    ).bind(callId, limit).all();
    const events = (rows?.results || []).map((row) => ({
      eventId: row.event_id,
      callId: row.call_id,
      type: row.type,
      payload: safeJSON(row.payload_json),
      fromAccountDigest: row.from_account_digest || null,
      toAccountDigest: row.to_account_digest || null,
      traceId: row.trace_id || null,
      createdAt: Number(row.created_at) || null
    }));
    return json({ ok: true, events });
  }

  return null;
}

async function handleDeviceRoutes(req, env) {
  const url = new URL(req.url);
  const now = Math.floor(Date.now() / 1000);

  if (req.method === 'POST' && url.pathname === '/d1/devices/upsert') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const deviceId = normalizeDeviceId(body?.deviceId || body?.device_id);
    const label = typeof body?.label === 'string' ? body.label.trim() : null;
    if (!accountDigest || !deviceId) {
      return json({ error: 'BadRequest', message: 'accountDigest and deviceId required' }, { status: 400 });
    }
    try {
      await env.DB.prepare(
        `INSERT INTO devices (account_digest, device_id, label, status, last_seen_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)
         ON CONFLICT(account_digest, device_id) DO UPDATE SET
           label=COALESCE(excluded.label, devices.label),
           status='active',
           last_seen_at=?4,
           updated_at=?4`
      ).bind(accountDigest, deviceId, label, now).run();
      return json({ ok: true });
    } catch (err) {
      console.error('device_upsert_failed', err?.message || err);
      return json({ error: 'DeviceUpsertFailed', message: err?.message || 'device upsert failed' }, { status: 500 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/d1/devices/check') {
    await ensureDataTables(env);
    const accountDigest = normalizeAccountDigest(url.searchParams.get('accountDigest') || url.searchParams.get('account_digest'));
    const deviceId = normalizeDeviceId(url.searchParams.get('deviceId') || url.searchParams.get('device_id'));
    if (!accountDigest || !deviceId) {
      return json({ error: 'BadRequest', message: 'accountDigest and deviceId required' }, { status: 400 });
    }
    try {
      const rows = await env.DB.prepare(
        `SELECT status, last_seen_at, created_at FROM devices WHERE account_digest=?1 AND device_id=?2`
      ).bind(accountDigest, deviceId).all();
      const row = rows?.results?.[0] || null;
      if (!row) {
        return json({ ok: false, status: null });
      }
      return json({
        ok: row.status === 'active',
        status: row.status || null,
        lastSeenAt: Number(row.last_seen_at) || null,
        createdAt: Number(row.created_at) || null
      });
    } catch (err) {
      console.error('device_check_failed', err?.message || err);
      return json({ error: 'DeviceCheckFailed', message: err?.message || 'device check failed' }, { status: 500 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/d1/devices/active') {
    await ensureDataTables(env);
    const accountDigest = normalizeAccountDigest(url.searchParams.get('accountDigest') || url.searchParams.get('account_digest'));
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    try {
      const rows = await env.DB.prepare(
        `SELECT device_id, status, last_seen_at, created_at, label
           FROM devices
          WHERE account_digest=?1 AND status='active'
          ORDER BY (last_seen_at IS NOT NULL) DESC, last_seen_at DESC, created_at DESC`
      ).bind(accountDigest).all();
      const devices = (rows?.results || []).map((row) => ({
        deviceId: row.device_id,
        status: row.status,
        lastSeenAt: row.last_seen_at != null ? Number(row.last_seen_at) : null,
        createdAt: row.created_at != null ? Number(row.created_at) : null,
        label: row.label || null
      }));
      return json({ devices });
    } catch (err) {
      console.error('device_active_list_failed', err?.message || err);
      return json({ error: 'DeviceListFailed', message: err?.message || 'device list failed' }, { status: 500 });
    }
  }

  return null;
}



async function handleContactsRoutes(req, env) {
  const url = new URL(req.url);

  // POST /d1/contacts/upsert
  if (req.method === 'POST' && url.pathname === '/d1/contacts/upsert') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body.accountDigest || body.account_digest);
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const contacts = Array.isArray(body.contacts) ? body.contacts : [];
    if (!contacts.length) {
      return json({ ok: true, count: 0 }); // nothing to do
    }

    let count = 0;
    // Batch upsert? or loop. Parallel prepared statements is usually fine for D1.
    // For large lists, strict batching might be needed, but for contact list sync (usually incremental or < 1000), sequential/parallel is okay.

    // We'll use a transaction if possible, or just Promise.all
    // D1 `batch` API is available on `env.DB`.

    const stmts = [];
    for (const item of contacts) {
      const peerDigest = normalizeAccountDigest(item.peerDigest || item.peer_digest);
      if (!peerDigest) continue;
      const blob = typeof item.encryptedBlob === 'string' ? item.encryptedBlob : null;
      const isBlocked = item.isBlocked === true || item.isBlocked === 1 ? 1 : 0;

      stmts.push(env.DB.prepare(`
        INSERT INTO contacts (owner_digest, peer_digest, encrypted_blob, is_blocked, updated_at)
        VALUES (?1, ?2, ?3, ?4, strftime('%s','now'))
        ON CONFLICT(owner_digest, peer_digest) DO UPDATE SET
          encrypted_blob = COALESCE(excluded.encrypted_blob, contacts.encrypted_blob),
          is_blocked = COALESCE(excluded.is_blocked, contacts.is_blocked),
          updated_at = strftime('%s','now')
      `).bind(accountDigest, peerDigest, blob, isBlocked));
    }

    if (stmts.length) {
      try {
        const results = await env.DB.batch(stmts);
        count = results.length;
      } catch (err) {
        console.error('contacts_upsert_failed', err);
        return json({ error: 'UpsertFailed', message: err?.message || 'db error' }, { status: 500 });
      }
    }
    return json({ ok: true, count });
  }

  // GET /d1/contacts/snapshot
  if (req.method === 'GET' && url.pathname === '/d1/contacts/snapshot') {
    await ensureDataTables(env);
    const accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
      || req.headers.get('x-account-digest')
    );
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required (checked QS and Headers)' }, { status: 400 });
    }

    try {
      const rows = await env.DB.prepare(`
        SELECT peer_digest, encrypted_blob, is_blocked, updated_at
          FROM contacts
         WHERE owner_digest = ?1
      `).bind(accountDigest).all();

      const contacts = (rows?.results || []).map(r => ({
        peerDigest: r.peer_digest,
        encryptedBlob: r.encrypted_blob || null,
        isBlocked: r.is_blocked === 1,
        updatedAt: Number(r.updated_at) || 0
      }));

      return json({ ok: true, contacts });
    } catch (err) {
      console.error('contacts_snapshot_failed', err);
      return json({ error: 'SnapshotFailed', message: err?.message }, { status: 500 });
    }
  }

  return null;
}

async function handleAccountsRoutes(req, env) {
  const url = new URL(req.url);

  if (req.method === 'GET' && url.pathname === '/d1/account/evidence') {
    const accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
      || url.searchParams.get('digest')
    );
    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    try {
      await ensureDataTables(env);
    } catch (err) {
      return json({ error: 'EnsureTablesFailed', message: err?.message || 'ensureDataTables failed' }, { status: 500 });
    }
    const evidence = {
      backupExists: false,
      vaultExists: false,
      messagesExists: false,
      backupDeviceId: null,
      backupDeviceLabel: null,
      backupUpdatedAt: null,
      registryDeviceId: null,
      registryDeviceLabel: null
    };
    try {
      const row = await env.DB.prepare(
        `SELECT device_id, device_label, updated_at
           FROM contact_secret_backups
          WHERE account_digest=?1
          ORDER BY updated_at DESC, id DESC
          LIMIT 1`
      ).bind(accountDigest).first();
      if (row) {
        evidence.backupExists = true;
        evidence.backupDeviceId = row.device_id || null;
        evidence.backupDeviceLabel = row.device_label || null;
        evidence.backupUpdatedAt = row.updated_at != null ? Number(row.updated_at) : null;
      }
    } catch (err) {
      return json({ error: 'BackupEvidenceFailed', message: err?.message || 'backup evidence query failed' }, { status: 500 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT 1 FROM message_key_vault WHERE account_digest=?1 LIMIT 1`
      ).bind(accountDigest).first();
      evidence.vaultExists = !!row;
    } catch (err) {
      return json({ error: 'VaultEvidenceFailed', message: err?.message || 'vault evidence query failed' }, { status: 500 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT 1 FROM messages_secure
           WHERE sender_account_digest=?1 OR receiver_account_digest=?1
           LIMIT 1`
      ).bind(accountDigest).first();
      evidence.messagesExists = !!row;
    } catch (err) {
      return json({ error: 'MessagesEvidenceFailed', message: err?.message || 'messages evidence query failed' }, { status: 500 });
    }
    try {
      const row = await env.DB.prepare(
        `SELECT device_id, label
           FROM devices
          WHERE account_digest=?1 AND status='active'
          ORDER BY (last_seen_at IS NOT NULL) DESC, last_seen_at DESC, created_at DESC
          LIMIT 1`
      ).bind(accountDigest).first();
      if (row) {
        evidence.registryDeviceId = row.device_id || null;
        evidence.registryDeviceLabel = row.label || null;
      }
    } catch (err) {
      return json({ error: 'DeviceEvidenceFailed', message: err?.message || 'device evidence query failed' }, { status: 500 });
    }
    return json({ ok: true, accountDigest, evidence });
  }

  if (req.method === 'POST' && url.pathname === '/d1/accounts/verify') {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountTokenRaw = body?.accountToken || body?.account_token;
    const accountDigestRaw = body?.accountDigest || body?.account_digest;
    const accountToken = typeof accountTokenRaw === 'string' && accountTokenRaw.trim().length ? accountTokenRaw.trim() : null;
    const accountDigest = typeof accountDigestRaw === 'string' && accountDigestRaw.trim().length ? normalizeAccountDigest(accountDigestRaw) : null;
    if (!accountToken && !accountDigest) {
      return json({ error: 'BadRequest', message: 'accountToken or accountDigest required' }, { status: 400 });
    }
    try {
      const account = await resolveAccount(
        env,
        { accountToken, accountDigest },
        { allowCreate: false, preferredAccountToken: accountToken || null, preferredAccountDigest: accountDigest || null }
      );
      if (!account) {
        return json({ error: 'NotFound' }, { status: 404 });
      }
      return json({
        ok: true,
        account_digest: account.account_digest
      });
    } catch (err) {
      return json({ error: 'VerifyFailed', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }
  }

  if (req.method === 'GET' && url.pathname === '/d1/accounts/created') {
    let accountDigest = normalizeAccountDigest(
      url.searchParams.get('accountDigest')
      || url.searchParams.get('account_digest')
      || url.searchParams.get('digest')
    );
    const uidDigest = normalizeAccountDigest(
      url.searchParams.get('uidDigest')
      || url.searchParams.get('uid_digest')
    );

    if (!accountDigest && uidDigest) {
      try {
        const row = await env.DB.prepare(
          `SELECT account_digest FROM accounts WHERE uid_digest=?1`
        ).bind(uidDigest).first();
        accountDigest = row?.account_digest || null;
      } catch (err) {
        console.warn('accounts_created_uid_lookup_failed', err?.message || err);
      }
    }

    if (!accountDigest) {
      return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
    }
    const rows = await env.DB.prepare(
      `SELECT account_digest, created_at FROM accounts WHERE account_digest=?1`
    ).bind(accountDigest).all();
    const row = rows?.results?.[0] || null;
    if (!row) {
      return json({ error: 'NotFound', message: 'account not found' }, { status: 404 });
    }
    return json({
      account_digest: row.account_digest,
      created_at: Number(row.created_at) || null
    });
  }

  if (req.method === 'POST' && url.pathname === '/d1/accounts/purge') {
    await ensureDataTables(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    let accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const uidDigest = normalizeAccountDigest(body?.uidDigest || body?.uid_digest);
    const dryRun = body?.dryRun === true;

    if (!accountDigest && uidDigest) {
      try {
        const row = await env.DB.prepare(
          `SELECT account_digest FROM accounts WHERE uid_digest=?1`
        ).bind(uidDigest).first();
        accountDigest = normalizeAccountDigest(row?.account_digest);
      } catch (err) {
        console.warn('account_purge_uid_lookup_failed', err?.message || err);
      }
    }

    if (!accountDigest) {
      return json({ ok: true, skipped: true, reason: 'accountDigest not found' });
    }

    const convIds = new Set([
      `contacts-${accountDigest}`,
      `profile-${accountDigest}`,
      `settings-${accountDigest}`,
      `drive-${accountDigest}`,
      `avatar-${accountDigest}`
    ]);
    const groupIds = new Set();
    const prefixes = new Set();

    const addConv = (id) => {
      if (!id) return;
      const normalized = normalizeConversationId(id);
      if (normalized) convIds.add(normalized);
    };

    const addGroup = (id) => {
      if (!id) return;
      const norm = String(id || '').trim();
      if (norm) groupIds.add(norm);
    };

    try {
      const rows = await env.DB.prepare(
        `SELECT conversation_id FROM conversation_acl WHERE account_digest=?1`
      ).bind(accountDigest).all();
      for (const row of rows?.results || []) addConv(row?.conversation_id);
    } catch (err) {
      console.warn('account_purge_conv_acl_lookup_failed', err?.message || err);
    }

    try {
      const creatorGroups = await env.DB.prepare(
        `SELECT group_id, conversation_id FROM groups WHERE creator_account_digest=?1`
      ).bind(accountDigest).all();
      for (const row of creatorGroups?.results || []) {
        addGroup(row?.group_id);
        addConv(row?.conversation_id);
      }
      const memberGroups = await env.DB.prepare(
        `SELECT gm.group_id, g.conversation_id
           FROM group_members gm
           JOIN groups g ON gm.group_id = g.group_id
          WHERE gm.account_digest=?1`
      ).bind(accountDigest).all();
      for (const row of memberGroups?.results || []) {
        addGroup(row?.group_id);
        addConv(row?.conversation_id);
      }
    } catch (err) {
      console.warn('account_purge_group_lookup_failed', err?.message || err);
    }

    const mediaKeys = new Set();
    if (convIds.size) {
      const convList = Array.from(convIds);
      const placeholders = convList.map((_, i) => `?${i + 1}`).join(',');
      try {
        const rows = await env.DB.prepare(
          `SELECT obj_key FROM media_objects WHERE conv_id IN (${placeholders})`
        ).bind(...convList).all();
        for (const row of rows?.results || []) {
          if (row?.obj_key) mediaKeys.add(row.obj_key);
        }
      } catch (err) {
        console.warn('account_purge_media_lookup_failed', err?.message || err);
      }
    }

    for (const convId of convIds) {
      prefixes.add(`${convId}/`);
    }

    if (dryRun) {
      return json({
        ok: true,
        dryRun: true,
        accountDigest,
        convIds: Array.from(convIds),
        groupIds: Array.from(groupIds),
        mediaKeys: Array.from(mediaKeys),
        prefixes: Array.from(prefixes)
      });
    }

    const del = async (sql, params = []) => {
      try {
        const res = await env.DB.prepare(sql).bind(...params).run();
        return res?.meta?.changes || 0;
      } catch (err) {
        console.warn('account_purge_delete_failed', { sql: sql.slice(0, 64), error: err?.message || err });
        return 0;
      }
    };

    const convList = Array.from(convIds);
    const convPlaceholders = convList.length ? convList.map((_, i) => `?${i + 1}`).join(',') : '';
    const groupList = Array.from(groupIds);
    const groupPlaceholders = groupList.length ? groupList.map((_, i) => `?${i + 1}`).join(',') : '';

    const summary = {};
    if (convList.length) {
      summary.messagesSecure = await del(
        `DELETE FROM messages_secure WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
      summary.attachments = await del(
        `DELETE FROM attachments WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
      summary.messages = await del(
        `DELETE FROM messages WHERE conv_id IN (${convPlaceholders})`,
        convList
      );
      summary.mediaObjects = await del(
        `DELETE FROM media_objects WHERE conv_id IN (${convPlaceholders})`,
        convList
      );
      summary.conversationAcl = await del(
        `DELETE FROM conversation_acl WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
      summary.conversations = await del(
        `DELETE FROM conversations WHERE id IN (${convPlaceholders})`,
        convList
      );
    }

    let callIds = [];
    try {
      const rows = await env.DB.prepare(
        `SELECT call_id FROM call_sessions WHERE caller_account_digest=?1 OR callee_account_digest=?1`
      ).bind(accountDigest).all();
      callIds = (rows?.results || []).map(r => r?.call_id).filter(Boolean);
    } catch (err) {
      console.warn('account_purge_call_lookup_failed', err?.message || err);
    }
    if (callIds.length) {
      const placeholders = callIds.map((_, i) => `?${i + 1}`).join(',');
      summary.callEvents = await del(
        `DELETE FROM call_events WHERE call_id IN (${placeholders})`,
        callIds
      );
      summary.callSessions = await del(
        `DELETE FROM call_sessions WHERE call_id IN (${placeholders})`,
        callIds
      );
    } else {
      summary.callEvents = await del(
        `DELETE FROM call_events WHERE from_account_digest=?1 OR to_account_digest=?1`,
        [accountDigest]
      );
      summary.callSessions = await del(
        `DELETE FROM call_sessions WHERE caller_account_digest=?1 OR callee_account_digest=?1`,
        [accountDigest]
      );
    }

    summary.contactSecretBackups = await del(
      `DELETE FROM contact_secret_backups WHERE account_digest=?1`,
      [accountDigest]
    );

    if (groupList.length) {
      summary.groupInvites = await del(
        `DELETE FROM group_invites WHERE group_id IN (${groupPlaceholders})`,
        groupList
      );
      summary.groupMembers = await del(
        `DELETE FROM group_members WHERE group_id IN (${groupPlaceholders})`,
        groupList
      );
      summary.groups = await del(
        `DELETE FROM groups WHERE group_id IN (${groupPlaceholders})`,
        groupList
      );
    } else {
      summary.groupMembers = await del(
        `DELETE FROM group_members WHERE account_digest=?1`,
        [accountDigest]
      );
    }

    summary.extendLogs = await del(
      `DELETE FROM extend_logs WHERE digest=?1`,
      [accountDigest]
    );
    summary.tokens = await del(
      `DELETE FROM tokens WHERE digest=?1`,
      [accountDigest]
    );
    summary.subscriptions = await del(
      `DELETE FROM subscriptions WHERE digest=?1`,
      [accountDigest]
    );

    summary.prekeyOpk = await del(
      `DELETE FROM prekey_opk WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.prekeyUsers = await del(
      `DELETE FROM prekey_users WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.deviceBackup = await del(
      `DELETE FROM device_backup WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.deviceOpks = await del(
      `DELETE FROM device_opks WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.deviceSignedPrekeys = await del(
      `DELETE FROM device_signed_prekeys WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.devices = await del(
      `DELETE FROM devices WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.opaqueRecords = await del(
      `DELETE FROM opaque_records WHERE account_digest=?1`,
      [accountDigest]
    );
    summary.accounts = await del(
      `DELETE FROM accounts WHERE account_digest=?1`,
      [accountDigest]
    );

    if (convList.length) {
      summary.conversationAclCleanup = await del(
        `DELETE FROM conversation_acl WHERE conversation_id IN (${convPlaceholders})`,
        convList
      );
    }

    return json({
      ok: true,
      accountDigest,
      convIds: Array.from(convIds),
      groupIds: Array.from(groupIds),
      mediaKeys: Array.from(mediaKeys),
      prefixes: Array.from(prefixes),
      summary
    });
  }

  return null;
}

export default {
  async fetch(req, env) {
    // 基本 HMAC 防護
    if (!await verifyHMAC(req, env)) {
      return new Response('unauthorized', { status: 401 });
    }

    // 先搬好的 Tags/OPAQUE/DevKeys
    const tagResult = await handleTagsRoutes(req, env);
    if (tagResult) return tagResult;

    const inviteDropboxResult = await handleInviteDropboxRoutes(req, env);
    if (inviteDropboxResult) return inviteDropboxResult;

    // Friends / Invites
    const friendsResult = await handleFriendsRoutes(req, env);
    if (friendsResult) return friendsResult;

    const prekeyResult = await handlePrekeysRoutes(req, env);
    if (prekeyResult) return prekeyResult;

    const atomicSendResult = await handleAtomicSendRoutes(req, env);
    if (atomicSendResult) return atomicSendResult;

    const messagesResult = await handleMessagesRoutes(req, env);
    if (messagesResult) return messagesResult;

    const contactSecretResult = await handleContactSecretsRoutes(req, env);
    if (contactSecretResult) return contactSecretResult;

    const messageKeyVaultResult = await handleMessageKeyVaultRoutes(req, env);
    if (messageKeyVaultResult) return messageKeyVaultResult;

    const groupsResult = await handleGroupsRoutes(req, env);
    if (groupsResult) return groupsResult;

    const mediaResult = await handleMediaRoutes(req, env);
    if (mediaResult) return mediaResult;

    const convResult = await handleConversationRoutes(req, env);
    if (convResult) return convResult;

    const subscriptionResult = await handleSubscriptionRoutes(req, env);
    if (subscriptionResult) return subscriptionResult;

    const devicesResult = await handleDeviceRoutes(req, env);
    if (devicesResult) return devicesResult;

    const callsResult = await handleCallsRoutes(req, env);
    if (callsResult) return callsResult;

    const accountsResult = await handleAccountsRoutes(req, env);
    if (accountsResult) return accountsResult;

    const contactsResult = await handleContactsRoutes(req, env);
    if (contactsResult) return contactsResult;

    return json({ error: 'not_found' }, { status: 404 });
  }
};
