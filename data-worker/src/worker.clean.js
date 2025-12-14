/**
 * Worker (clean rebuild scaffold)
 * -------------------------------
 * 目標：以乾淨結構重新搬遷既有路由，避免括號/結構錯亂。
 * 步驟：
 * 1) 保留共用工具（HMAC 驗證、base64 helpers）。
 * 2) 依功能區塊逐步搬移路由（tags → friends → messages → groups → media/calls/subscription → accounts/admin）。
 * 3) 每搬完一塊都跑 `node --check data-worker/src/worker.clean.js` 確認語法。
 * 4) 全部完成後，以本檔覆蓋 worker.js 並部署。
 */

import crypto from 'node:crypto';

// ---- 基本工具與正規化 ----
const textEncoder = new TextEncoder();
const INVITE_ENCODER = new TextEncoder();

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
      ikPub,
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
    'raw', new TextEncoder().encode(env.HMAC_SECRET),
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

function normalizeConversationId(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
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

function normalizeOpk(opk) {
  if (!opk || typeof opk !== 'object') return null;
  const id = Number(opk.id ?? opk.opk_id);
  const pub = typeof opk.pub === 'string' ? opk.pub.trim() : (typeof opk.opk_pub === 'string' ? opk.opk_pub.trim() : null);
  if (!Number.isFinite(id) || !pub) return null;
  return { id, pub: pub.slice(0, 4096) };
}

function normalizeSignedPrekey(spk) {
  if (!spk || typeof spk !== 'object') return null;
  const id = Number(spk.id ?? spk.spk_id);
  const pub = typeof spk.pub === 'string' ? spk.pub.trim() : (typeof spk.spk_pub === 'string' ? spk.spk_pub.trim() : null);
  const sig = typeof spk.sig === 'string' ? spk.sig.trim() : (typeof spk.spk_sig === 'string' ? spk.spk_sig.trim() : null);
  const ik = typeof spk.ik === 'string' ? spk.ik.trim() : (typeof spk.ik_pub === 'string' ? spk.ik_pub.trim() : null);
  if (!Number.isFinite(id) || !pub || !sig) return null;
  const normalized = { id, pub: pub.slice(0, 4096), sig: sig.slice(0, 4096) };
  if (ik) normalized.ik_pub = ik.slice(0, 4096);
  return normalized;
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

async function lookupIkFromBackup(env, accountDigest) {
  if (!accountDigest) return null;
  try {
    const row = await env.DB.prepare(
      `SELECT wrapped_dev_json FROM device_backup WHERE account_digest=?1`
    ).bind(accountDigest).first();
    const parsed = safeJSON(row?.wrapped_dev_json);
    const ik = parsed?.ik_pub_b64 || parsed?.ik_pub || null;
    if (ik && typeof ik === 'string' && ik.trim()) return ik.trim();
  } catch (err) {
    console.warn('ik_lookup_backup_failed', err?.message || err);
  }
  return null;
}

function normalizeOwnerPrekeyBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const ik = String(bundle.ik_pub || bundle.ik || '').trim();
  const spk = String(bundle.spk_pub || bundle.spk || '').trim();
  const sig = String(bundle.spk_sig || '').trim();
  if (!ik || !spk || !sig) return null;
  let opk = null;
  if (bundle.opk && typeof bundle.opk === 'object') {
    const idNum = Number(bundle.opk.id ?? bundle.opk.opk_id);
    const pub = String(bundle.opk.pub || bundle.opk.opk_pub || '').trim();
    if (pub) {
      opk = { id: Number.isFinite(idNum) ? idNum : null, pub };
    }
  }
  return opk ? { ik_pub: ik, spk_pub: spk, spk_sig: sig, opk } : { ik_pub: ik, spk_pub: spk, spk_sig: sig, opk: null };
}

function normalizeGuestBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const ek = String(bundle.ek_pub || bundle.ek || bundle.ephemeral_pub || '').trim();
  if (!ek) return null;
  const ik = bundle.ik_pub || bundle.ik || bundle.identity_pub ? String(bundle.ik_pub || bundle.ik || bundle.identity_pub || '').trim() : null;
  const spk = bundle.spk_pub ? String(bundle.spk_pub || '').trim() : null;
  const sig = bundle.spk_sig || bundle.spkSig || bundle.signature ? String(bundle.spk_sig || bundle.spkSig || bundle.signature || '').trim() : null;
  const opkId = bundle.opk_id ?? bundle.opkId ?? bundle.opk?.id;
  const out = { ek_pub: ek };
  if (ik) out.ik_pub = ik;
  if (spk) out.spk_pub = spk;
  if (sig) out.spk_sig = sig;
  if (opkId != null && opkId !== '') {
    const num = Number(opkId);
    if (Number.isFinite(num)) out.opk_id = num;
  }
  return out;
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

async function insertContactMessage(env, { convAccountDigest, peerAccountDigest, envelope, ts }) {
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
  const messageId = crypto.randomUUID();

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

async function ensureFriendInviteTable(env) {
  await ensureDataTables(env);
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
    hexToBytes(keyHex),
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

async function hashInviteTokenHex(token, env) {
  const keyMaterial = typeof env?.INVITE_TOKEN_KEY === 'string' ? env.INVITE_TOKEN_KEY : '';
  if (!keyMaterial || keyMaterial.length < 8) {
    throw new Error('INVITE_TOKEN_KEY missing or too short (>=8 chars required)');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    INVITE_ENCODER.encode(String(keyMaterial)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, INVITE_ENCODER.encode(String(token || '')));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
  const statements = [
    `CREATE TABLE IF NOT EXISTS accounts (
        account_digest TEXT PRIMARY KEY,
        account_token TEXT NOT NULL,
        uid_digest TEXT NOT NULL UNIQUE,
        last_ctr INTEGER NOT NULL DEFAULT 0,
        wrapped_mk_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE TABLE IF NOT EXISTS devices (
        account_digest TEXT NOT NULL,
        device_id TEXT NOT NULL,
        label TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (account_digest, device_id),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS device_signed_prekeys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_digest TEXT NOT NULL,
        device_id TEXT NOT NULL,
        spk_id INTEGER NOT NULL,
        spk_pub TEXT NOT NULL,
        spk_sig TEXT NOT NULL,
        ik_pub TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        UNIQUE (account_digest, device_id, spk_id),
        FOREIGN KEY (account_digest, device_id) REFERENCES devices(account_digest, device_id) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS device_opks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_digest TEXT NOT NULL,
        device_id TEXT NOT NULL,
        opk_id INTEGER NOT NULL,
        opk_pub TEXT NOT NULL,
        issued_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        consumed_at INTEGER,
        UNIQUE (account_digest, device_id, opk_id),
        FOREIGN KEY (account_digest, device_id) REFERENCES devices(account_digest, device_id) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_device_opks_fetch ON device_opks (account_digest, device_id, consumed_at, opk_id)`,
    `CREATE TABLE IF NOT EXISTS prekey_users (
        account_digest TEXT PRIMARY KEY,
        ik_pub      TEXT NOT NULL,
        spk_pub     TEXT NOT NULL,
        spk_sig     TEXT NOT NULL,
        device_id   TEXT,
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS prekey_opk (
        account_digest TEXT NOT NULL,
        opk_id     INTEGER NOT NULL,
        opk_pub    TEXT NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (account_digest, opk_id),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_prekey_opk_unused ON prekey_opk (account_digest, used, opk_id)`,
    `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        token_b64 TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE TABLE IF NOT EXISTS conversation_acl (
        conversation_id TEXT NOT NULL,
        account_digest TEXT NOT NULL,
        device_id TEXT,
        role TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (conversation_id, account_digest, device_id),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_acl_account_device ON conversation_acl (account_digest, device_id)`,
    `CREATE TABLE IF NOT EXISTS messages_secure (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_account_digest TEXT NOT NULL,
        sender_device_id TEXT NOT NULL,
        receiver_account_digest TEXT NOT NULL,
        receiver_device_id TEXT,
        header_json TEXT NOT NULL,
        ciphertext_b64 TEXT NOT NULL,
        counter INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_secure_conv_created ON messages_secure (conversation_id, created_at DESC, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_secure_sender_counter ON messages_secure (sender_account_digest, sender_device_id, counter)`,
    `CREATE TABLE IF NOT EXISTS attachments (
        object_key TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sender_account_digest TEXT NOT NULL,
        sender_device_id TEXT NOT NULL,
        envelope_json TEXT,
        size_bytes INTEGER,
        content_type TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_conv ON attachments (conversation_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments (message_id)`,
    `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conv_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('text','media')),
        aead TEXT NOT NULL,
        header_json TEXT,
        obj_key TEXT,
        size_bytes INTEGER,
        ts INTEGER NOT NULL,
        FOREIGN KEY (conv_id) REFERENCES conversations(id) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages (conv_id, ts)`,
    `CREATE TABLE IF NOT EXISTS media_objects (
        obj_key TEXT PRIMARY KEY,
        conv_id TEXT NOT NULL,
        size_bytes INTEGER,
        created_at INTEGER NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS idx_media_conv ON media_objects (conv_id)`,
    `CREATE TABLE IF NOT EXISTS opaque_records (
        account_digest TEXT PRIMARY KEY,
        record_b64     TEXT NOT NULL,
        client_identity TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS device_backup (
        account_digest   TEXT PRIMARY KEY,
        wrapped_dev_json TEXT,
        created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS friend_invites (
        invite_id TEXT PRIMARY KEY,
        owner_account_digest TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        invite_version INTEGER NOT NULL DEFAULT 2,
        owner_device_id TEXT,
        prekey_ik_pub TEXT,
        prekey_spk_pub TEXT,
        prekey_spk_sig TEXT,
        prekey_opk_id INTEGER,
        prekey_opk_pub TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_account_digest)`,
    `CREATE INDEX IF NOT EXISTS idx_friend_invites_used ON friend_invites(used_at)`,
    `CREATE INDEX IF NOT EXISTS idx_friend_invites_expires ON friend_invites(expires_at)`,
    `CREATE TABLE IF NOT EXISTS call_sessions (
        call_id TEXT PRIMARY KEY,
        caller_account_digest TEXT,
        callee_account_digest TEXT,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        capabilities_json TEXT,
        metadata_json TEXT,
        metrics_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        connected_at INTEGER,
        ended_at INTEGER,
        end_reason TEXT,
        expires_at INTEGER NOT NULL,
        last_event TEXT
      )`,
    `CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_call_sessions_expires ON call_sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS call_events (
        event_id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        from_account_digest TEXT,
        to_account_digest TEXT,
        trace_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (call_id) REFERENCES call_sessions(call_id) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_call_events_call_created ON call_events(call_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS contact_secret_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_digest TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        snapshot_version INTEGER,
        entries INTEGER,
        checksum TEXT,
        bytes INTEGER,
        updated_at INTEGER NOT NULL,
        device_label TEXT,
        device_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_secret_backups_account_version
        ON contact_secret_backups (account_digest, version)`,
    `CREATE INDEX IF NOT EXISTS idx_contact_secret_backups_account_updated
        ON contact_secret_backups (account_digest, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        creator_account_digest TEXT NOT NULL,
        name TEXT,
        avatar_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (creator_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_groups_conversation_id ON groups(conversation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_groups_creator ON groups(creator_account_digest)`,
    `CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        account_digest TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','left','kicked','removed')),
        inviter_account_digest TEXT,
        joined_at INTEGER,
        muted_until INTEGER,
        last_read_ts INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (group_id, account_digest),
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_group_members_account ON group_members(account_digest)`,
    `CREATE INDEX IF NOT EXISTS idx_group_members_status ON group_members(group_id, status)`,
    `CREATE TABLE IF NOT EXISTS group_invites (
        invite_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        issuer_account_digest TEXT,
        secret TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
        FOREIGN KEY (issuer_account_digest) REFERENCES accounts(account_digest) ON DELETE SET NULL
      )`,
    `CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_group_invites_expires ON group_invites(expires_at)`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
        digest TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE TABLE IF NOT EXISTS tokens (
        token_id TEXT PRIMARY KEY,
        digest TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        extend_days INTEGER NOT NULL,
        nonce TEXT,
        key_id TEXT NOT NULL,
        signature_b64 TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('issued','used','invalid')),
        used_at INTEGER,
        used_by_digest TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (digest) REFERENCES subscriptions(digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_tokens_digest ON tokens(digest)`,
    `CREATE INDEX IF NOT EXISTS idx_tokens_status ON tokens(status)`,
    `CREATE TABLE IF NOT EXISTS extend_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        extend_days INTEGER NOT NULL,
        expires_at_after INTEGER NOT NULL,
        used_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (token_id) REFERENCES tokens(token_id) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_extend_logs_digest ON extend_logs(digest)`,
    `CREATE INDEX IF NOT EXISTS idx_extend_logs_token ON extend_logs(token_id)`
  ];

  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      console.error('ensureDataTables failed', sql.slice(0, 60), err);
      throw err;
    }
  }

  const triggers = [
    `CREATE TRIGGER trg_device_backup_updated
       AFTER UPDATE ON device_backup
       FOR EACH ROW
       BEGIN
         UPDATE device_backup SET updated_at = strftime('%s','now') WHERE account_digest = OLD.account_digest;
       END;`,
    `CREATE TRIGGER trg_conversation_acl_updated
       AFTER UPDATE ON conversation_acl
       FOR EACH ROW
       BEGIN
         UPDATE conversation_acl
            SET updated_at = strftime('%s','now')
          WHERE conversation_id = OLD.conversation_id
            AND account_digest = OLD.account_digest
            AND (
              (device_id IS NULL AND OLD.device_id IS NULL) OR
              device_id = OLD.device_id
            );
       END;`,
    `CREATE TRIGGER trg_groups_updated
       AFTER UPDATE ON groups
       FOR EACH ROW
       BEGIN
         UPDATE groups SET updated_at = strftime('%s','now') WHERE group_id = OLD.group_id;
       END;`,
    `CREATE TRIGGER trg_group_members_updated
       AFTER UPDATE ON group_members
       FOR EACH ROW
       BEGIN
         UPDATE group_members SET updated_at = strftime('%s','now') WHERE group_id = OLD.group_id AND account_digest = OLD.account_digest;
       END;`
  ];

  for (const sql of triggers) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('already exists')) continue;
      console.error('ensureDataTables trigger failed', err);
    }
  }

  dataTablesReady = true;
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
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const accountDigest = normalizeAccountDigest(body.accountDigest || body.account_digest);
    const accountToken = typeof body.accountToken === 'string' ? body.accountToken : (typeof body.account_token === 'string' ? body.account_token : null);
    if (!accountDigest || !accountToken) {
      return json({ error: 'BadRequest', message: 'accountDigest & accountToken required' }, { status: 400 });
    }
    if (!body.wrapped_mk) {
      return json({ error: 'BadRequest', message: 'wrapped_mk required' }, { status: 400 });
    }
    await ensureDataTables(env);
    // 確認帳號存在且 token 匹配
    const acct = await resolveAccount(env, { accountDigest, accountToken }, { allowCreate: false });
    if (!acct) {
      return json({ error: 'Unauthorized', message: 'account token mismatch' }, { status: 401 });
    }
    await env.DB.prepare(
      `UPDATE accounts SET wrapped_mk_json=?2, updated_at=strftime('%s','now')
         WHERE account_digest=?1`
    ).bind(accountDigest, JSON.stringify(body.wrapped_mk)).run();
    return new Response(null, { status: 204 });
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

// ---- 主入口 ----
async function handleFriendsRoutes(req, env) {
  const url = new URL(req.url);

  // 建立好友邀請
  if (req.method === 'POST' && url.pathname === '/d1/friends/invite') {
    await ensureFriendInviteTable(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const inviteId = String(body?.inviteId || '').trim();
    const tokenHash = typeof body?.tokenHash === 'string' ? body.tokenHash.trim() : '';
    const expiresAt = Number(body?.expiresAt || 0);
    const accountTokenRaw = body?.accountToken || body?.account_token || null;
    const accountDigestRaw = body?.accountDigest || body?.account_digest || null;
    const accountToken = typeof accountTokenRaw === 'string' && accountTokenRaw.length ? accountTokenRaw : null;
    const accountDigest = typeof accountDigestRaw === 'string' && accountDigestRaw.length ? String(accountDigestRaw).replace(/[^0-9A-Fa-f]/g, '').toUpperCase() : null;
    const deviceIdBody = normalizeDeviceId(body?.deviceId || body?.device_id);

    if (!inviteId || !tokenHash || tokenHash.length < 32 || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
      return json({ error: 'BadRequest', message: 'invalid invite payload' }, { status: 400 });
    }

    let ownerAccount;
    try {
      ownerAccount = await resolveAccount(env, { accountToken, accountDigest }, { allowCreate: !!(accountToken || accountDigest), preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
    } catch (err) {
      return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
    }

    if (!ownerAccount) {
      return json({ error: 'AccountNotFound' }, { status: 404 });
    }

    let ownerBundle = normalizeOwnerPrekeyBundle(body?.prekeyBundle || body?.prekey_bundle);
    if (!ownerBundle) {
      ownerBundle = await allocateOwnerPrekeyBundle(env, ownerAccount.account_digest, deviceIdBody);
      if (!ownerBundle) {
        return json({ error: 'PrekeyUnavailable', message: 'owner prekey bundle unavailable' }, { status: 409 });
      }
    }

    const existingInvite = await env.DB.prepare(
      `SELECT invite_id FROM friend_invites WHERE invite_id=?1`
    ).bind(inviteId).all();

    if (existingInvite?.results?.length) {
      await env.DB.prepare(
        `UPDATE friend_invites
            SET owner_account_digest=?2,
                token_hash=?3,
                expires_at=?4,
                invite_version=2,
                owner_device_id=?5,
                prekey_ik_pub=?6,
                prekey_spk_pub=?7,
                prekey_spk_sig=?8,
                prekey_opk_id=?9,
                prekey_opk_pub=?10,
                used_at=NULL
          WHERE invite_id=?1`
      ).bind(
        inviteId,
        ownerAccount.account_digest,
        tokenHash,
        expiresAt,
        deviceIdBody,
        ownerBundle.ik_pub || null,
        ownerBundle.spk_pub || null,
        ownerBundle.spk_sig || null,
        ownerBundle.opk?.id ?? null,
        ownerBundle.opk?.pub ?? null
      ).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO friend_invites(
            invite_id, owner_account_digest, token_hash, expires_at,
            invite_version, owner_device_id, used_at, created_at,
            prekey_ik_pub, prekey_spk_pub, prekey_spk_sig, prekey_opk_id, prekey_opk_pub
         ) VALUES (?1, ?2, ?3, ?4, 2, ?5, NULL, strftime('%s','now'), ?6, ?7, ?8, ?9, ?10)`
      ).bind(
        inviteId,
        ownerAccount.account_digest,
        tokenHash,
        expiresAt,
        deviceIdBody,
        ownerBundle.ik_pub || null,
        ownerBundle.spk_pub || null,
        ownerBundle.spk_sig || null,
        ownerBundle.opk?.id ?? null,
        ownerBundle.opk?.pub ?? null
      ).run();
    }

    return json({
      ok: true,
      inviteId,
      expires_at: expiresAt,
      owner_account_digest: ownerAccount.account_digest,
      invite_version: 2,
      prekey_bundle: ownerBundle
    });
  }

  // Contact-share（會話內分享封裝）
  if (req.method === 'POST' && url.pathname === '/d1/friends/contact/share') {
    await ensureFriendInviteTable(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }

    const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
    const peerAccountDigest = normalizeAccountDigest(body?.peerAccountDigest || body?.peer_account_digest);
    const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
    const envelope = normalizeEnvelope(body?.envelope);
    const senderDeviceId = normalizeDeviceId(
      req.headers.get('x-device-id')
      || body?.deviceId
      || body?.device_id
      || body?.senderDeviceId
      || body?.sender_device_id
    );
    const peerDeviceId = normalizeDeviceId(
      body?.peerDeviceId
      || body?.peer_device_id
      || body?.targetDeviceId
      || body?.target_device_id
    );
    if (!accountDigest || !peerAccountDigest || !envelope || !conversationId || !senderDeviceId || !peerDeviceId) {
      return json({ error: 'BadRequest', message: 'accountDigest, peerAccountDigest, conversationId, senderDeviceId, peerDeviceId and envelope required' }, { status: 400 });
    }

    const senderAcl = await env.DB.prepare(
      `SELECT 1 FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2 AND device_id=?3`
    ).bind(conversationId, accountDigest, senderDeviceId).first();
    if (!senderAcl) {
      return json({ error: 'Forbidden', code: 'ConversationDeviceMismatch', message: 'sender device not authorized' }, { status: 403 });
    }
    const peerAclRow = await env.DB.prepare(
      `SELECT device_id FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2`
    ).bind(conversationId, peerAccountDigest).first();
    if (peerAclRow && peerAclRow.device_id !== peerDeviceId) {
      return json({ error: 'Forbidden', code: 'ConversationDeviceMismatch', message: 'peer device mismatch' }, { status: 403 });
    }

    await grantConversationAccess(env, {
      conversationId,
      accountDigest: peerAccountDigest,
      deviceId: peerDeviceId
    });

    await env.DB.prepare(
      `INSERT INTO conversations (id) VALUES (?1) ON CONFLICT(id) DO NOTHING`
    ).bind(conversationId).run();

    let counter = 1;
    try {
      const row = await env.DB.prepare(`
        SELECT MAX(counter) AS max_counter
          FROM messages_secure
         WHERE conversation_id=?1
           AND sender_account_digest=?2
           AND sender_device_id=?3
      `).bind(conversationId, accountDigest, senderDeviceId).first();
      const maxCounter = Number(row?.max_counter ?? 0);
      if (Number.isFinite(maxCounter) && maxCounter > 0) counter = maxCounter + 1;
    } catch (err) {
      console.warn('contact_share_counter_lookup_failed', err?.message || err);
    }

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ivB64 = bytesToBase64Url(iv);
    const ts = Math.floor(Date.now() / 1000);
    const header = {
      contact: 1,
      v: 1,
      peerAccountDigest: accountDigest,
      ts,
      envelope,
      iv_b64: ivB64,
      n: counter,
      device_id: senderDeviceId
    };
    const headerJson = JSON.stringify(header);
    const ciphertextB64 = bytesToBase64Url(new TextEncoder().encode(headerJson));
    const messageId = crypto.randomUUID();

    try {
      await env.DB.prepare(`
        INSERT INTO messages_secure (
          id, conversation_id, sender_account_digest, sender_device_id,
          receiver_account_digest, receiver_device_id, header_json, ciphertext_b64,
          counter, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      `).bind(
        messageId,
        conversationId,
        accountDigest,
        senderDeviceId,
        peerAccountDigest,
        peerDeviceId,
        headerJson,
        ciphertextB64,
        counter,
        ts
      ).run();
    } catch (err) {
      console.warn('contact_share_insert_failed', err?.message || err);
      return json({ error: 'InsertFailed', message: 'unable to store contact share' }, { status: 500 });
    }

    return json({
      ok: true,
      targetAccountDigest: peerAccountDigest,
      senderAccountDigest: accountDigest,
      ts,
      conversationId,
      senderDeviceId,
      peerDeviceId,
      id: messageId,
      counter
    });
  }

  // 刪除聯絡（依 peer）
  if (req.method === 'POST' && url.pathname === '/d1/friends/contact-delete') {
    await ensureFriendInviteTable(env);
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
      results.push({ convId: entry.convId, removed, target: entry.targetAccountDigest || null });
    }

    return json({ ok: true, ts: now, results });
  }

  // 接受好友邀請
  if (req.method === 'POST' && url.pathname === '/d1/friends/accept') {
    await ensureFriendInviteTable(env);
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
    }
    const inviteId = String(body?.inviteId || '').trim();
    const inviteToken = String(body?.inviteToken || body?.invite_token || body?.secret || '').trim();
    const guestBundle = normalizeGuestBundle(body?.guestBundle || body?.guest_bundle);
    if (!inviteId || !inviteToken) {
      return json({ error: 'BadRequest', message: 'inviteId & inviteToken required' }, { status: 400 });
    }

    const rows = await env.DB.prepare(
      `SELECT invite_id, owner_account_digest, token_hash, expires_at, used_at, owner_device_id, invite_version,
              prekey_ik_pub, prekey_spk_pub, prekey_spk_sig, prekey_opk_id, prekey_opk_pub
       FROM friend_invites WHERE invite_id=?1`
    ).bind(inviteId).all();
    const row = rows?.results?.[0];
    if (!row) return json({ error: 'NotFound' }, { status: 404 });
    let tokenHash;
    try {
      tokenHash = await hashInviteTokenHex(inviteToken, env);
    } catch (err) {
      console.warn('invite_token_hmac_key_missing', err?.message || err);
      return json({ error: 'ConfigError', message: err?.message || 'invite token key missing' }, { status: 500 });
    }
    if (row.token_hash !== tokenHash) return json({ error: 'Forbidden', message: 'invite token mismatch' }, { status: 403 });
    const now = Math.floor(Date.now() / 1000);
    if (row.expires_at < now) return json({ error: 'Expired' }, { status: 410 });
    if (row.used_at) return json({ error: 'AlreadyUsed' }, { status: 409 });

    const guestBundleNormalized = normalizeGuestBundle(guestBundle);
    if (!guestBundleNormalized) {
      return json({ error: 'BadRequest', message: 'guestBundle required' }, { status: 400 });
    }

    let ownerBundle = normalizeOwnerPrekeyBundle({
      ik_pub: row.prekey_ik_pub,
      spk_pub: row.prekey_spk_pub,
      spk_sig: row.prekey_spk_sig,
      opk: row.prekey_opk_id != null ? { id: row.prekey_opk_id, pub: row.prekey_opk_pub } : null
    });
    if (!ownerBundle) {
      ownerBundle = await allocateOwnerPrekeyBundle(env, row.owner_account_digest, row.owner_device_id);
      if (!ownerBundle) {
        return json({ error: 'PrekeyUnavailable', message: 'owner prekey bundle unavailable' }, { status: 409 });
      }
      try {
        await env.DB.prepare(
          `UPDATE friend_invites
              SET prekey_ik_pub=?2, prekey_spk_pub=?3, prekey_spk_sig=?4, prekey_opk_id=?5, prekey_opk_pub=?6
            WHERE invite_id=?1`
        ).bind(
          inviteId,
          ownerBundle.ik_pub || null,
          ownerBundle.spk_pub || null,
          ownerBundle.spk_sig || null,
          ownerBundle.opk?.id ?? null,
          ownerBundle.opk?.pub ?? null
        ).run();
      } catch (err) {
        console.warn('invite_store_prekey_fallback_failed', err?.message || err);
      }
    }

    await env.DB.prepare(
      `UPDATE friend_invites
          SET used_at=?2
        WHERE invite_id=?1`
    ).bind(
      inviteId,
      now
    ).run();

    return json({
      ok: true,
      owner_account_digest: row.owner_account_digest,
      expires_at: row.expires_at,
      owner_prekey_bundle: ownerBundle,
      owner_device_id: row.owner_device_id || null,
      invite_version: Number(row.invite_version || 2),
      invite_id: inviteId,
      guest_bundle: guestBundleNormalized
    });
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
    const signedPrekey = normalizeSignedPrekey(body?.signedPrekey || body?.signed_prekey || body?.spk);
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
    const peerAccountDigest = normalizeAccountDigest(
      url.searchParams.get('peerAccountDigest')
      || url.searchParams.get('peer_account_digest')
      || url.searchParams.get('accountDigest')
    );
    let peerDeviceId = normalizeDeviceId(
      url.searchParams.get('peerDeviceId')
      || url.searchParams.get('peer_device_id')
      || url.searchParams.get('deviceId')
    );
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
    let ikPub = spkRow.ik_pub || null;
    if (!ikPub) {
      ikPub = await lookupIkFromBackup(env, peerAccountDigest);
    }
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

async function handleMessagesRoutes(req, env) {
  const url = new URL(req.url);

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
    const messageId = typeof body?.id === 'string' && body.id.trim().length ? body.id.trim() : crypto.randomUUID();
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

  // List secure messages (cursor)
  if (req.method === 'GET' && url.pathname === '/d1/messages') {
    const conversationIdRaw = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
    const cursorTs = Number(url.searchParams.get('cursorTs') || url.searchParams.get('cursor_ts') || 0);
    const cursorCounter = Number(url.searchParams.get('cursorCounter') || url.searchParams.get('cursor_counter') || 0);
    const cursorId = url.searchParams.get('cursorId') || url.searchParams.get('cursor_id') || '';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
    const conversationId = normalizeConversationId(conversationIdRaw);
    if (!conversationId) {
      return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
    }
    await ensureDataTables(env);
    const params = [conversationId];
    let cursorClause = '';
    if (Number.isFinite(cursorCounter) && cursorCounter > 0) {
      params.push(cursorCounter, cursorId || '');
      cursorClause = 'AND (counter < ?2 OR (counter = ?2 AND id < ?3))';
    } else if (cursorTs) {
      params.push(cursorTs, cursorId);
      cursorClause = 'AND (created_at < ?2 OR (created_at = ?2 AND id < ?3))';
    }
    params.push(limit + 1);
    const stmt = env.DB.prepare(`
      SELECT id, conversation_id, sender_account_digest, sender_device_id, receiver_account_digest, receiver_device_id,
             header_json, ciphertext_b64, counter, created_at
        FROM messages_secure
       WHERE conversation_id=?1
         ${cursorClause}
       ORDER BY counter DESC, created_at DESC, id DESC
       LIMIT ?${params.length}
    `).bind(...params);
    const { results } = await stmt.all();
    const hasMore = results.length > limit;
    const trimmed = results.slice(0, limit);
    const items = trimmed.map((row) => ({
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
    }));
    const last = trimmed.at(-1) || null;
    const nextCursor = last ? { ts: last.created_at, id: last.id, counter: last.counter } : null;
    return json({
      ok: true,
      items,
      nextCursor,
      nextCursorTs: nextCursor?.ts || null,
      nextCursorCounter: nextCursor?.counter ?? null,
      hasMoreAtCursor: hasMore
    });
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
    const checksum = typeof body?.checksum === 'string' ? String(body.checksum).slice(0, 128) : null;
    const deviceLabel = typeof body?.deviceLabel === 'string' ? String(body.deviceLabel).slice(0, 120) : null;
    const deviceId = typeof body?.deviceId === 'string' ? String(body.deviceId).slice(0, 120) : null;
    const updatedAt = normalizeTimestampMs(body?.updatedAt || body?.updated_at) || Date.now();
    let version = Number.isFinite(Number(body?.version)) && Number(body.version) > 0
      ? Math.floor(Number(body.version))
      : null;

    const existingVersionRow = await env.DB.prepare(
      `SELECT MAX(version) as max_version FROM contact_secret_backups WHERE account_digest=?1`
    ).bind(accountDigest).all();
    const nextVersion = Number(existingVersionRow?.results?.[0]?.max_version || 0);
    if (!version || version <= nextVersion) {
      version = nextVersion + 1;
    }

    await env.DB.prepare(
      `INSERT INTO contact_secret_backups (
          account_digest, version, payload_json, snapshot_version, entries,
          checksum, bytes, updated_at, device_label, device_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%s','now'))`
    ).bind(
      accountDigest,
      version,
      JSON.stringify(payload),
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
    const backups = (rows?.results || []).map((row) => ({
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
      payload: safeJSON(row.payload_json)
    }));
    return json({ ok: true, backups });
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

async function handleAccountsRoutes(req, env) {
  const url = new URL(req.url);

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

    summary.friendInvites = await del(
      `DELETE FROM friend_invites WHERE owner_account_digest=?1`,
      [accountDigest]
    );

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

    // Friends / Invites
    const friendsResult = await handleFriendsRoutes(req, env);
    if (friendsResult) return friendsResult;

    const prekeyResult = await handlePrekeysRoutes(req, env);
    if (prekeyResult) return prekeyResult;

    const messagesResult = await handleMessagesRoutes(req, env);
    if (messagesResult) return messagesResult;

    const contactSecretResult = await handleContactSecretsRoutes(req, env);
    if (contactSecretResult) return contactSecretResult;

    const groupsResult = await handleGroupsRoutes(req, env);
    if (groupsResult) return groupsResult;

    const mediaResult = await handleMediaRoutes(req, env);
    if (mediaResult) return mediaResult;

    const convResult = await handleConversationRoutes(req, env);
    if (convResult) return convResult;

    const subscriptionResult = await handleSubscriptionRoutes(req, env);
    if (subscriptionResult) return subscriptionResult;

    const callsResult = await handleCallsRoutes(req, env);
    if (callsResult) return callsResult;

    const accountsResult = await handleAccountsRoutes(req, env);
    if (accountsResult) return accountsResult;

    return json({ error: 'not_found' }, { status: 404 });
  }
};
