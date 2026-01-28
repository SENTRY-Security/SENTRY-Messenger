#!/usr/bin/env node
// One-off inspector for contact-secrets snapshots.

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
let selfDeviceId = null;
let fileSource = null;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--self' && args[i + 1]) {
    selfDeviceId = args[i + 1];
    i += 1;
  } else if (arg === '--file' && args[i + 1]) {
    fileSource = args[i + 1];
    i += 1;
  }
}

if (!selfDeviceId && process.env.SELF_DEVICE_ID) {
  selfDeviceId = process.env.SELF_DEVICE_ID.trim();
}

const keyPattern = /^contactSecrets-v[12]/;

function gatherStoragePayloads() {
  const candidates = [];
  const push = (payload, source, meta = {}) => {
    if (typeof payload === 'string' && payload.trim()) {
      candidates.push({ payload, source, meta });
    }
  };

  const collectFromStorage = (storage, source) => {
    if (!storage || typeof storage.getItem !== 'function') return;
    try {
      const keys = Object.keys(storage).filter((k) => keyPattern.test(k));
      for (const key of keys) {
        const payload = storage.getItem(key);
        push(payload, `${source}:${key}`);
      }
    } catch (err) {
      console.warn(`[inspect] read from ${source} failed`, err?.message || err);
    }
  };

  collectFromStorage(globalThis.localStorage, 'localStorage');
  collectFromStorage(globalThis.sessionStorage, 'sessionStorage');

  if (fileSource) {
    try {
      const raw = fs.readFileSync(path.resolve(fileSource), 'utf8');
      let payload = raw;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.payload === 'string') payload = parsed.payload;
      } catch {
        /* keep raw */
      }
      push(payload, `file:${fileSource}`);
    } catch (err) {
      console.warn('[inspect] failed to read file', fileSource, err?.message || err);
    }
  }

  if (process.env.CONTACT_SECRETS_PAYLOAD) {
    push(process.env.CONTACT_SECRETS_PAYLOAD, 'env:CONTACT_SECRETS_PAYLOAD');
  }

  return candidates;
}

function chooseSnapshot(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return candidates.reduce((best, cur) => {
    if (!best) return cur;
    return (cur.payload.length > best.payload.length) ? cur : best;
  }, null);
}

function resolveSelfDeviceId(entries) {
  if (selfDeviceId) return selfDeviceId;
  const deviceIds = new Set();
  for (const entry of entries) {
    const devices = entry?.devices && typeof entry.devices === 'object' ? Object.keys(entry.devices) : [];
    devices.filter(Boolean).forEach((id) => deviceIds.add(id));
  }
  if (deviceIds.size === 1) return Array.from(deviceIds)[0];
  return null;
}

function assessDrState(drState) {
  const required = ['rk_b64', 'theirRatchetPub_b64', 'myRatchetPriv_b64', 'myRatchetPub_b64'];
  const missing = [];
  for (const key of required) {
    if (typeof drState?.[key] !== 'string' || !drState[key]) {
      missing.push(key);
    }
  }
  return { missing, usable: missing.length === 0 };
}

function inspectSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    console.error('[inspect] snapshot payload missing or invalid');
    process.exit(1);
  }
  const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  const resolvedSelfId = resolveSelfDeviceId(entries);

  if (!resolvedSelfId) {
    console.warn('[inspect] selfDeviceId not provided and could not be inferred; pass --self <deviceId> to avoid false negatives');
  }

  const summary = {
    peers: entries.length,
    usable: 0,
    missing: 0,
    invalid: 0,
    deviceMissing: 0
  };

  const details = [];

  for (const entry of entries) {
    const peerKey = entry?.peerAccountDigest && entry?.peerDeviceId
      ? `${entry.peerAccountDigest}::${entry.peerDeviceId}`
      : (entry?.peerAccountDigest || '(unknown)');
    const devices = entry?.devices && typeof entry.devices === 'object' ? entry.devices : {};
    const dev = resolvedSelfId ? devices[resolvedSelfId] : null;
    const hasDevice = !!dev;
    const drState = dev?.drState || null;
    const drHistory = Array.isArray(dev?.drHistory) ? dev.drHistory.length : 0;
    const hasSeed = typeof dev?.drSeed === 'string' && dev.drSeed.length > 0;

    let status = 'missing';
    let missingFields = [];

    if (!hasDevice) {
      summary.deviceMissing += 1;
      status = 'no-device';
    } else if (drState) {
      const { missing, usable } = assessDrState(drState);
      missingFields = missing;
      if (usable) {
        summary.usable += 1;
        status = 'usable';
      } else {
        summary.invalid += 1;
        status = 'invalid-format';
      }
    } else {
      summary.missing += 1;
    }

    details.push({
      peerKey,
      device: hasDevice ? resolvedSelfId || '(self-unknown)' : null,
      status,
      missingFields,
      drHistory,
      hasSeed
    });
  }

  return { summary, details, selfDeviceId: resolvedSelfId };
}

function main() {
  const candidates = gatherStoragePayloads();
  const chosen = chooseSnapshot(candidates);

  if (!chosen) {
    console.error('[inspect] no contact-secrets payload found (localStorage/sessionStorage/env/file)');
    process.exit(1);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(chosen.payload);
  } catch (err) {
    console.error('[inspect] failed to parse payload JSON from', chosen.source, err?.message || err);
    process.exit(1);
  }

  const result = inspectSnapshot(snapshot);
  console.log(JSON.stringify({
    source: chosen.source,
    snapshotVersion: snapshot?.v ?? snapshot?.version ?? null,
    selfDeviceId: result.selfDeviceId,
    peersTotal: result.summary.peers,
    peersWithUsableDrState: result.summary.usable,
    peersMissingDrState: result.summary.missing,
    peersInvalidFormat: result.summary.invalid,
    peersDeviceMissing: result.summary.deviceMissing,
    details: result.details
  }, null, 2));
}

main();
