/**
 * Call-Log Backup Module
 *
 * In-memory store for call-log entries with encrypted cloud backup/restore.
 * Follows the same pattern as biz-conv-backup.js:
 *   - Entries accumulated in memory during session
 *   - Encrypted with MK via wrapWithMK_JSON, uploaded to contact-secrets backup
 *   - Hydrated on login via unwrapWithMK_JSON from server backup
 *   - Cleared on logout (local data wiped, server backup persists)
 *
 * Call-log entries are embedded inside the biz-conv backup payload
 * (under the `callLogs` key) to avoid server limit/namespace issues.
 */

import { log } from '../core/log.js';

/**
 * In-memory store: conversationId → Map(callId → entry)
 * Each entry contains the minimal data needed to reconstruct
 * the call-log tombstone in the timeline on hydration.
 */
const callLogMap = new Map();

/**
 * Add a call-log entry to the in-memory store.
 * Call this after creating or receiving a call-log.
 *
 * @param {string} conversationId
 * @param {Object} entry - Must contain at least { callId, ts, msgType, direction, text, callLog }
 */
export function addCallLogEntry(conversationId, entry) {
  if (!conversationId || !entry) return;
  const callId = entry.callLog?.callId || entry.callId;
  if (!callId) return;

  let convMap = callLogMap.get(conversationId);
  if (!convMap) {
    convMap = new Map();
    callLogMap.set(conversationId, convMap);
  }

  // Store only the fields needed for timeline reconstruction
  convMap.set(callId, {
    messageId: entry.messageId || entry.id || null,
    callId,
    ts: entry.ts || 0,
    direction: entry.direction || 'outgoing',
    text: entry.text || '',
    msgType: 'call-log',
    callLog: entry.callLog || null
  });
}

/**
 * Build a serializable payload for backup.
 * @returns {Object} { v, conversations, updated_at }
 */
export function buildCallLogBackupPayload() {
  const conversations = {};
  for (const [convId, entries] of callLogMap) {
    const items = [];
    for (const [, entry] of entries) {
      items.push(entry);
    }
    if (items.length > 0) {
      conversations[convId] = items;
    }
  }
  return {
    v: 1,
    conversations,
    updated_at: Date.now()
  };
}

/**
 * Restore call-log entries from a decrypted backup payload.
 * @param {Object} payload - { v, conversations }
 */
export function restoreCallLogFromPayload(payload) {
  if (!payload || !payload.conversations) return;
  for (const [convId, items] of Object.entries(payload.conversations)) {
    if (!Array.isArray(items)) continue;
    let convMap = callLogMap.get(convId);
    if (!convMap) {
      convMap = new Map();
      callLogMap.set(convId, convMap);
    }
    for (const entry of items) {
      const callId = entry.callLog?.callId || entry.callId;
      if (!callId) continue;
      // Don't overwrite existing (live session) entries
      if (!convMap.has(callId)) {
        convMap.set(callId, entry);
      }
    }
  }
}

/**
 * Inject restored call-log entries into the timeline store.
 * Called after hydration to make them visible in conversations.
 */
export async function injectCallLogsIntoTimeline() {
  if (callLogMap.size === 0) return;

  const { appendUserMessage } = await import('./timeline-store.js');
  let injected = 0;

  for (const [convId, entries] of callLogMap) {
    for (const [, entry] of entries) {
      if (!entry.messageId || !entry.ts) continue;
      const appended = appendUserMessage(convId, {
        messageId: entry.messageId,
        msgType: 'call-log',
        direction: entry.direction || 'outgoing',
        text: entry.text || '',
        ts: entry.ts,
        callLog: entry.callLog || null,
        conversationId: convId
      });
      if (appended) injected++;
    }
  }

  if (injected > 0) {
    log({ callLogHydrateInjected: injected });
  }
}

/**
 * Check if a call-log entry already exists for a given conversation and callId.
 */
export function hasCallLogEntry(conversationId, callId) {
  if (!conversationId || !callId) return false;
  const convMap = callLogMap.get(conversationId);
  return convMap ? convMap.has(callId) : false;
}

/**
 * Get total number of stored call-log entries (for diagnostics).
 */
export function getCallLogCount() {
  let count = 0;
  for (const [, entries] of callLogMap) {
    count += entries.size;
  }
  return count;
}

/**
 * Clear all call-log entries on logout.
 */
export function clearCallLogOnLogout() {
  callLogMap.clear();
}
