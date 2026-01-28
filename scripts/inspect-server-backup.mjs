#!/usr/bin/env node
/**
 * Server-side contact-secrets backup inspector.
 * Fetches the latest backups via /api/v1/contact-secrets/backup and reports presence-only info.
 */

const args = process.argv.slice(2);

function readFlag(name) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return null;
}

const baseUrl = readFlag('--base') || process.env.CONTACT_API_BASE || process.env.API_BASE || 'http://localhost:3000';
const accountDigest = readFlag('--accountDigest') || process.env.ACCOUNT_DIGEST || null;
const accountToken = readFlag('--accountToken') || process.env.ACCOUNT_TOKEN || null;
const selfDeviceId = readFlag('--selfDeviceId') || process.env.SELF_DEVICE_ID || null;
const limit = Math.min(Math.max(Number(readFlag('--limit') || 3) || 3, 1), 3);

if (!accountDigest && !accountToken) {
  console.error('[inspect] require --accountDigest or --accountToken (or env ACCOUNT_DIGEST / ACCOUNT_TOKEN)');
  process.exit(1);
}

function maskPeerKey(peerKey) {
  if (!peerKey) return null;
  const val = String(peerKey);
  if (val.length <= 12) return val;
  return `${val.slice(0, 6)}...${val.slice(-4)}`;
}

function resolvePeerKey(entry) {
  const digest = entry?.peerAccountDigest || entry?.peer_account_digest || entry?.accountDigest || entry?.account_digest || null;
  const peerDeviceId = entry?.peerDeviceId || entry?.peer_device_id || null;
  if (digest && peerDeviceId) return `${digest}::${peerDeviceId}`;
  return digest || peerDeviceId || null;
}

function summarizeDrState(record) {
  const drState = record?.drState || record?.dr_state || null;
  const required = ['rk_b64', 'theirRatchetPub_b64', 'myRatchetPriv_b64', 'myRatchetPub_b64'];
  const missing = [];
  for (const key of required) {
    if (typeof drState?.[key] !== 'string' || !drState[key]) {
      missing.push(key);
    }
  }
  return { present: !!drState, missing };
}

function summarizeEntries(entries = []) {
  const samples = [];
  for (const entry of entries.slice(0, 3)) {
    const peerKey = resolvePeerKey(entry);
    const devices = entry?.devices && typeof entry.devices === 'object' ? entry.devices : null;
    const deviceRecord = selfDeviceId && devices ? devices[selfDeviceId] : null;
    const drStateSummary = summarizeDrState(deviceRecord || {});
    samples.push({
      peerKey: maskPeerKey(peerKey) || '(unknown)',
      hasDevices: !!devices,
      selfDevicePresent: !!deviceRecord,
      drStatePresent: drStateSummary.present,
      drStateMissingFields: drStateSummary.missing
    });
  }
  return { count: entries.length, samples };
}

function extractEntries(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.entries)) return payload.entries;
  if (payload.payload && typeof payload.payload === 'object' && Array.isArray(payload.payload.entries)) {
    return payload.payload.entries;
  }
  return null;
}

function summarizeBackup(backup) {
  const payload = backup?.payload || null;
  const entriesFromPayload = extractEntries(payload);
  const entriesSummary = entriesFromPayload ? summarizeEntries(entriesFromPayload) : null;
  const withDrStatePayload = Number.isFinite(Number(payload?.withDrState))
    ? Number(payload.withDrState)
    : (Number.isFinite(Number(payload?.meta?.withDrState)) ? Number(payload.meta.withDrState) : null);
  return {
    version: backup?.version ?? null,
    snapshotVersion: backup?.snapshotVersion ?? null,
    updatedAt: backup?.updatedAt ?? backup?.updated_at ?? null,
    entries: Number.isFinite(Number(backup?.entries)) ? Number(backup.entries) : (entriesSummary ? entriesSummary.count : null),
    withDrState: Number.isFinite(Number(backup?.withDrState)) ? Number(backup.withDrState) : withDrStatePayload,
    bytes: Number.isFinite(Number(backup?.bytes)) ? Number(backup.bytes) : null,
    deviceId: backup?.deviceId ?? backup?.device_id ?? null,
    payloadType: payload && typeof payload === 'object'
      ? (payload.aead ? 'encrypted' : 'structured')
      : typeof payload,
    entriesSample: entriesSummary ? entriesSummary.samples : 'entries not present (likely encrypted)'
  };
}

async function fetchBackups() {
  const url = new URL('/api/v1/contact-secrets/backup', baseUrl);
  url.searchParams.set('limit', String(limit));
  const headers = {};
  if (accountDigest) headers['X-Account-Digest'] = accountDigest;
  if (accountToken) headers['X-Account-Token'] = accountToken;
  const res = await fetch(url, { method: 'GET', headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const backups = Array.isArray(data?.backups) ? data.backups : [];
  const summary = {
    request: {
      url: url.toString(),
      limit
    },
    response: {
      status: res.status,
      ok: res.ok
    },
    backupsLength: backups.length,
    backups: backups.map(summarizeBackup)
  };
  return summary;
}

async function main() {
  if (!selfDeviceId) {
    console.warn('[inspect] selfDeviceId not provided; device presence checks may be inaccurate. Pass --selfDeviceId or env SELF_DEVICE_ID.');
  }
  try {
    const summary = await fetchBackups();
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    console.error('[inspect] failed', err?.message || err);
    process.exit(1);
  }
}

main();
