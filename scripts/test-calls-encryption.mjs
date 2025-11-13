#!/usr/bin/env node
// API-level integration test for encrypted call sessions.
// Creates two accounts, establishes friendship, sends a call invite with call-key-envelope,
// verifies callee can fetch the session and see the envelope, reports metrics, and cancels the call.

import crypto from 'node:crypto';
import { setupFriendConversation } from './lib/friends-flow.mjs';
import {
  DEFAULT_CALL_MEDIA_CAPABILITY,
  normalizeCallKeyEnvelope
} from '../web/src/shared/calls/schemas.js';
import { bytesToB64 } from '../web/src/shared/utils/base64.js';

const ORIGIN_API = (process.env.ORIGIN_API || 'http://127.0.0.1:3000').replace(/\/$/, '');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function jsonPost(path, body) {
  const url = path.startsWith('http') ? path : `${ORIGIN_API}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data;
  try { data = await res.json(); } catch { data = await res.text(); }
  if (!res.ok) {
    throw new Error(`POST ${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function fetchCallSession(user, callId) {
  const params = new URLSearchParams();
  params.set('uidHex', user.uidHex);
  if (user.accountToken) params.set('accountToken', user.accountToken);
  if (user.accountDigest) params.set('accountDigest', user.accountDigest);
  const qs = params.toString();
  const url = `${ORIGIN_API}/api/v1/calls/${encodeURIComponent(callId)}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, { method: 'GET' });
  let data;
  try { data = await res.json(); } catch { data = await res.text(); }
  if (!res.ok) {
    throw new Error(`GET /calls/${callId} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

function buildAuthPayload(user, extra = {}) {
  return {
    uidHex: user.uidHex,
    accountToken: user.accountToken,
    accountDigest: user.accountDigest,
    ...extra
  };
}

function cloneDefaultCapability() {
  return JSON.parse(JSON.stringify(DEFAULT_CALL_MEDIA_CAPABILITY));
}

function randomB64(size) {
  return bytesToB64(crypto.randomBytes(size));
}

async function main() {
  console.log('[setup] bootstrap contacts for call test');
  const { userA, userB } = await setupFriendConversation({ origin: ORIGIN_API });

  const callId = crypto.randomUUID();
  const baseEnvelope = {
    type: 'call-key-envelope',
    callId,
    epoch: 1,
    cmkSalt: randomB64(32),
    cmkProof: randomB64(32),
    media: {
      audio: { enabled: true, codec: 'opus' },
      video: { enabled: false }
    }
  };
  const callKeyEnvelope = normalizeCallKeyEnvelope(baseEnvelope);
  const capabilities = cloneDefaultCapability();
  capabilities.callKeyEnvelope = callKeyEnvelope;

  console.log('[1] create call invite with call-key-envelope');
  const invitePayload = buildAuthPayload(userA, {
    callId,
    peerUid: userB.uidHex,
    peerAccountDigest: userB.accountDigest,
    mode: 'voice',
    capabilities,
    metadata: { test: 'api-call-encryption' },
    traceId: `call-test-${Date.now()}`
  });
  const inviteRes = await jsonPost('/api/v1/calls/invite', invitePayload);
  assert(inviteRes?.callId === callId, 'callId mismatch in invite response');

  console.log('[2] callee acknowledges the call');
  await jsonPost('/api/v1/calls/ack', buildAuthPayload(userB, { callId }));

  console.log('[3] callee fetches call session and verifies envelope');
  const sessionRes = await fetchCallSession(userB, callId);
  const session = sessionRes?.session;
  assert(session?.callId === callId, 'fetched session missing callId');
  assert(session?.capabilities?.callKeyEnvelope, 'callKeyEnvelope missing in session capabilities');
  assert(
    session.capabilities.callKeyEnvelope.cmkSalt === callKeyEnvelope.cmkSalt,
    'cmkSalt mismatch in stored callKeyEnvelope'
  );

  console.log('[4] caller reports call metrics');
  await jsonPost('/api/v1/calls/report-metrics', buildAuthPayload(userA, {
    callId,
    metrics: { jitterMs: 4, rttMs: 32 },
    status: 'ringing'
  }));

  console.log('[5] caller cancels the call session');
  await jsonPost('/api/v1/calls/cancel', buildAuthPayload(userA, {
    callId,
    reason: 'integration-test-cleanup'
  }));

  console.log('\nALL OK');
}

main().catch((err) => {
  console.error('TEST FAILED:', err?.message || err);
  process.exit(1);
});
