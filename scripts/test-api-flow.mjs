#!/usr/bin/env node
/**
 * 完整 API 流程測試（無 fallback）：
 *  - 兩個測試帳號（A/B）透過 friend setup 完成 SDM / OPAQUE / MK / DeviceKeys
 *  - 建立好友邀請並交換聯絡封套（含 DR 初始資料）
 *  - 以會話金鑰加密訊息並送出
 *  - 讀取並解密驗證內容正確
 *
 * 執行：
 *   ORIGIN_API=http://127.0.0.1:3000 node scripts/test-api-flow.mjs
 */

import crypto from 'node:crypto';
import { setupFriendConversation } from './lib/friends-flow.mjs';
import {
  encryptConversationEnvelope,
  decryptConversationEnvelope,
  computeConversationAccessFingerprint
} from '../web/src/shared/conversation/context.js';
import {
  bytesToB64,
  bytesToB64Url,
  b64UrlToBytes
} from '../web/src/shared/utils/base64.js';

if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto;
}

const ORIGIN = process.env.ORIGIN_API || 'http://127.0.0.1:3000';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nowTs() {
  return Math.floor(Date.now() / 1000);
}

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTestMessage({ senderLabel, senderUid, conversation, text, account }) {
  const keyBytes = b64UrlToBytes(conversation.tokenB64);
  const key = await crypto.webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const msgIv = crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const cipherBytes = new Uint8Array(await crypto.webcrypto.subtle.encrypt({ name: 'AES-GCM', iv: msgIv }, key, encoder.encode(text)));

  if (!account?.uidHex || !account?.accountDigest) {
    throw new Error('account credentials missing for sender');
  }

  let conversationFingerprint = null;
  try {
    conversationFingerprint = await computeConversationAccessFingerprint(conversation.tokenB64, account.accountDigest);
  } catch (err) {
    console.warn('[test-api-flow] computeConversationAccessFingerprint failed:', err?.message || err);
  }

  const header = {
    v: 1,
    iv_b64: bytesToB64Url(msgIv),
    sender: senderUid,
    seq: nowTs()
  };
  const payload = {
    v: 1,
    hdr_b64: bytesToB64Url(encoder.encode(JSON.stringify(header))),
    ct_b64: bytesToB64Url(cipherBytes),
    meta: {
      ts: nowTs(),
      sender_uid: senderUid,
      note: senderLabel
    }
  };

  const envelope = await encryptConversationEnvelope(conversation.tokenB64, payload);

  const res = await fetch(`${ORIGIN}/api/v1/messages/secure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversation_id: conversation.conversationId,
      payload_envelope: envelope,
      created_at: nowTs(),
      uidHex: account.uidHex,
      accountDigest: account.accountDigest,
      accountToken: account.accountToken,
      conversationFingerprint
    })
  });
  if (res.status !== 202) {
    const body = await res.text();
    throw new Error(`sendTestMessage failed (${res.status}): ${body}`);
  }
}

async function fetchAndDecrypt({ viewer, conversation }) {
  if (!viewer?.uidHex || !viewer?.accountDigest) {
    throw new Error(`viewer ${viewer?.label || ''} missing credentials`);
  }
  let conversationFingerprint = null;
  try {
    conversationFingerprint = await computeConversationAccessFingerprint(conversation.tokenB64, viewer.accountDigest);
  } catch (err) {
    console.warn('[test-api-flow] computeConversationAccessFingerprint(viewer) failed:', err?.message || err);
  }
  const headers = {
    'X-Uid-Hex': viewer.uidHex,
    'X-Account-Digest': viewer.accountDigest
  };
  if (viewer.accountToken) headers['X-Account-Token'] = viewer.accountToken;
  if (conversationFingerprint) headers['X-Conversation-Fingerprint'] = conversationFingerprint;
  const res = await fetch(`${ORIGIN}/api/v1/messages/secure?conversationId=${encodeURIComponent(conversation.conversationId)}`, {
    method: 'GET',
    headers
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`fetch secure messages failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  const keyBytes = b64UrlToBytes(conversation.tokenB64);
  const key = await crypto.webcrypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  const results = [];

  for (const item of items) {
    const payload = await decryptConversationEnvelope(conversation.tokenB64, item.payload_envelope || item.payloadEnvelope);
    const headerBytes = b64UrlToBytes(payload.hdr_b64);
    const header = JSON.parse(decoder.decode(headerBytes));
    if (!header.iv_b64) {
      throw new Error('payload header missing iv_b64');
    }
    const msgIv = b64UrlToBytes(header.iv_b64);
    const cipher = b64UrlToBytes(payload.ct_b64);
    try {
      const plain = await crypto.webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: msgIv }, key, cipher);
      results.push({
        id: item.id,
        ts: payload?.meta?.ts || item.created_at,
        sender_uid: payload?.meta?.sender_uid || header.sender || 'unknown',
        text: decoder.decode(plain)
      });
    } catch (err) {
      throw new Error(`decrypt message failed (${viewer.label}): ${err?.message || err}`);
    }
  }
  return results;
}

(async () => {
  const friendSetup = await setupFriendConversation({ origin: ORIGIN });
  if (!friendSetup || !friendSetup.userA || !friendSetup.userB) {
    throw new Error('friend setup failed');
  }
  const { userA, userB, conversation } = friendSetup;

  console.log('[setup] users ready', userA.uidHex, userB.uidHex);
  console.log('[setup] conversation id', conversation.conversationId);
  console.log('[setup] drInit role', conversation?.drInit?.role || 'n/a');

  const messageA = `Hello from A ${Date.now()}`;
  const messageB = `Reply from B ${Date.now()}`;

  await sendTestMessage({
    senderLabel: 'owner',
    senderUid: userA.uidHex,
    conversation,
    text: messageA,
    account: userA
  });
  console.log('[message] sent by A');

  await sendTestMessage({
    senderLabel: 'guest',
    senderUid: userB.uidHex,
    conversation,
    text: messageB,
    account: userB
  });
  console.log('[message] sent by B');

  await wait(500);

  const decryptedForA = await fetchAndDecrypt({ viewer: { label: 'A', uidHex: userA.uidHex, accountToken: userA.accountToken, accountDigest: userA.accountDigest }, conversation });
  const decryptedForB = await fetchAndDecrypt({ viewer: { label: 'B', uidHex: userB.uidHex, accountToken: userB.accountToken, accountDigest: userB.accountDigest }, conversation });

  console.log('[decrypt] viewer A sees', decryptedForA);
  console.log('[decrypt] viewer B sees', decryptedForB);

  const textsA = decryptedForA.map((m) => m.text);
  const textsB = decryptedForB.map((m) => m.text);
  if (!textsA.includes(messageA) || !textsA.includes(messageB)) {
    throw new Error('viewer A missing messages');
  }
  if (!textsB.includes(messageA) || !textsB.includes(messageB)) {
    throw new Error('viewer B missing messages');
  }

  console.log('✅ API secure messaging flow verified');
})().catch((err) => {
  console.error('❌ test-api-flow failed:', err);
  process.exitCode = 1;
});
