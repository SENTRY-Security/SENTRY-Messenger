// /app/features/messages-flow/notify.js
// Commit-driven notification coordinator (no UI work).

import { logCapped } from '../../core/log.js';

const COMMIT_NOTIFY_LOG_CAP = 5;
const PREFIX_LEN = 8;
const DEFAULT_SOURCE = 'unknown';
const LIVE_SOUND_SOURCES = new Set([
  'live',
  'ws',
  'ws_incoming',
  'ws-incoming'
]);

function slicePrefix(value, len = PREFIX_LEN) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (!str) return null;
  return str.slice(0, len);
}

function normalizeConversationId(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str ? str : null;
}

function normalizeCounter(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (!Number.isInteger(num)) return null;
  if (num <= 0) return null;
  return num;
}

function normalizeSourceTag(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function resolveSourceTag(commitEvent, deps) {
  let sourceTag = null;
  if (typeof deps?.resolveSourceTag === 'function') {
    sourceTag = deps.resolveSourceTag(commitEvent);
  } else if (commitEvent && typeof commitEvent === 'object') {
    sourceTag = commitEvent.sourceTag || commitEvent.source || null;
  }
  if (!sourceTag && typeof deps?.sourceTag === 'string') {
    sourceTag = deps.sourceTag;
  }
  if (!sourceTag && typeof deps?.source === 'string') {
    sourceTag = deps.source;
  }
  const normalized = normalizeSourceTag(sourceTag);
  return normalized || DEFAULT_SOURCE;
}

function shouldAllowSound(sourceTag) {
  if (!sourceTag) return false;
  return LIVE_SOUND_SOURCES.has(sourceTag);
}

function logCommitNotifyTrace(logger, {
  conversationId,
  counter,
  ok,
  didVaultPut,
  deduped,
  reasonCode,
  source
} = {}) {
  logger('commitNotifyTrace', {
    conversationIdPrefix8: slicePrefix(conversationId, PREFIX_LEN),
    counter: Number.isFinite(counter) ? counter : null,
    ok: !!ok,
    didVaultPut: !!didVaultPut,
    deduped: !!deduped,
    reasonCode: reasonCode || null,
    source: source || null
  }, COMMIT_NOTIFY_LOG_CAP);
}

export function createCommitNotifier(deps = {}) {
  const logger = typeof deps.logCapped === 'function' ? deps.logCapped : logCapped;
  const onUnread = typeof deps.onUnread === 'function' ? deps.onUnread : null;
  const onNotify = typeof deps.onNotify === 'function' ? deps.onNotify : null;
  const seen = new Set();

  return function handleCommitEvent(commitEvent = null) {
    const hasEvent = !!(commitEvent && typeof commitEvent === 'object');
    const ok = hasEvent && commitEvent.ok === true;
    const didVaultPut = hasEvent && commitEvent.didVaultPut === true;
    const source = resolveSourceTag(commitEvent, deps);
    const reasonFromEvent = hasEvent && typeof commitEvent.reasonCode === 'string'
      ? commitEvent.reasonCode
      : null;

    if (!hasEvent) {
      const reasonCode = 'MISSING_COMMIT_EVENT';
      logCommitNotifyTrace(logger, {
        conversationId: null,
        counter: null,
        ok: false,
        didVaultPut: false,
        deduped: false,
        reasonCode,
        source
      });
      return { ok: false, reasonCode };
    }

    if (!ok) {
      const reasonCode = reasonFromEvent || 'COMMIT_NOT_OK';
      logCommitNotifyTrace(logger, {
        conversationId: commitEvent.conversationId || null,
        counter: commitEvent.counter ?? null,
        ok,
        didVaultPut,
        deduped: false,
        reasonCode,
        source
      });
      return { ok: false, reasonCode };
    }

    if (!didVaultPut) {
      const reasonCode = 'VAULT_PUT_MISSING';
      logCommitNotifyTrace(logger, {
        conversationId: commitEvent.conversationId || null,
        counter: commitEvent.counter ?? null,
        ok,
        didVaultPut,
        deduped: false,
        reasonCode,
        source
      });
      return { ok: false, reasonCode };
    }

    const conversationId = normalizeConversationId(commitEvent.conversationId);
    if (!conversationId) {
      const reasonCode = 'MISSING_CONVERSATION_ID';
      logCommitNotifyTrace(logger, {
        conversationId: commitEvent.conversationId || null,
        counter: commitEvent.counter ?? null,
        ok,
        didVaultPut,
        deduped: false,
        reasonCode,
        source
      });
      return { ok: false, reasonCode };
    }

    const counter = normalizeCounter(commitEvent.counter);
    if (!Number.isFinite(counter)) {
      const reasonCode = 'INVALID_COUNTER';
      logCommitNotifyTrace(logger, {
        conversationId,
        counter: commitEvent.counter ?? null,
        ok,
        didVaultPut,
        deduped: false,
        reasonCode,
        source
      });
      return { ok: false, reasonCode };
    }

    const dedupeKey = `${conversationId}:${counter}`;
    if (seen.has(dedupeKey)) {
      logCommitNotifyTrace(logger, {
        conversationId,
        counter,
        ok,
        didVaultPut,
        deduped: true,
        reasonCode: null,
        source
      });
      return { ok: true, deduped: true };
    }

    seen.add(dedupeKey);

    logCommitNotifyTrace(logger, {
      conversationId,
      counter,
      ok,
      didVaultPut,
      deduped: false,
      reasonCode: null,
      source
    });

    const allowSound = shouldAllowSound(source);
    if (onUnread) {
      onUnread({
        conversationId,
        counter,
        source,
        commitEvent
      });
    }
    if (onNotify) {
      onNotify({
        conversationId,
        counter,
        source,
        sound: allowSound,
        commitEvent
      });
    }

    return { ok: true, deduped: false };
  };
}
