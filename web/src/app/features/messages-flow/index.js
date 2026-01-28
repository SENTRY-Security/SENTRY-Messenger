// Facade for the next-gen messages flow (A-route only).
// This layer only translates events into jobs and schedules them.
// It must not decrypt, touch vault, or call server APIs directly.

export function createMessagesFlowFacade(deps = {}) {
  const { queue } = deps;

  const enqueueJob = (job) => {
    if (!queue || typeof queue.enqueue !== 'function') {
      return { ok: false, reason: 'queue_unavailable', job };
    }
    return queue.enqueue(job);
  };

  const nowMs = () => Date.now();
  const buildJob = ({ type, conversationId, key, payload }) => ({
    type,
    conversationId: conversationId || null,
    key: key || (conversationId ? `${type}:${conversationId}` : type),
    payload: payload || null,
    createdAtMs: nowMs()
  });

  return {
    // Event -> job only. No decrypt/vault/API.
    onLoginResume({ source } = {}) {
      return enqueueJob(buildJob({
        type: 'login_resume',
        payload: { source: source || null }
      }));
    },

    // Event -> job only. No decrypt/vault/API.
    onWsIncomingMessageNew(msg) {
      return enqueueJob(buildJob({
        type: 'ws_incoming_message_new',
        payload: { msg: msg || null }
      }));
    },

    // Event -> job only. No decrypt/vault/API.
    onEnterConversation({ conversationId, peerKey } = {}) {
      return enqueueJob(buildJob({
        type: 'enter_conversation',
        conversationId,
        payload: { peerKey: peerKey || null }
      }));
    },

    // Event -> job only. No decrypt/vault/API.
    onPullToRefreshContacts({ source } = {}) {
      return enqueueJob(buildJob({
        type: 'pull_to_refresh_contacts',
        payload: { source: source || null }
      }));
    },

    // Event -> job only. No decrypt/vault/API.
    onVisibilityResume({ source } = {}) {
      return enqueueJob(buildJob({
        type: 'visibility_resume',
        payload: { source: source || null }
      }));
    },

    // Event -> job only. No decrypt/vault/API.
    onScrollFetchMore({ conversationId, cursor } = {}) {
      return enqueueJob(buildJob({
        type: 'scroll_fetch_more',
        conversationId,
        payload: { cursor: cursor || null }
      }));
    },

    // Event -> job only. No decrypt/vault/API.
    reconcileOutgoingStatusNow({ conversationId, peerKey } = {}) {
      return enqueueJob(buildJob({
        type: 'reconcile_outgoing_status',
        conversationId,
        payload: { peerKey: peerKey || null }
      }));
    }
  };
}

export { createMessagesFlowScrollFetch } from '../messages-flow/scroll-fetch.js';

export { createGapQueue } from '../messages-flow/gap-queue.js';
