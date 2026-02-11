// Runtime flags for messages-flow (single source of truth).

export const USE_MESSAGES_FLOW_SCROLL_FETCH = true;
export const USE_MESSAGES_FLOW_LIVE = true;
export const USE_MESSAGES_FLOW_MAX_COUNTER_PROBE = true;
export const USE_MESSAGES_FLOW_B_ROUTE_COMMIT = true;

// Unified mode: Legacy Handler only processes control messages (receipts, deleted).
// Content messages go exclusively through Live Flow → timeline append → UI.
// This eliminates the "無法解密" placeholder flash and dual-path race condition.
export const USE_MESSAGES_FLOW_UNIFIED = true;

export function getMessagesFlowFlags() {
  return {
    USE_MESSAGES_FLOW_SCROLL_FETCH,
    USE_MESSAGES_FLOW_LIVE,
    USE_MESSAGES_FLOW_MAX_COUNTER_PROBE,
    USE_MESSAGES_FLOW_B_ROUTE_COMMIT,
    USE_MESSAGES_FLOW_UNIFIED,
    source: 'default'
  };
}
