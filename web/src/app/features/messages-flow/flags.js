// Runtime flags for messages-flow (single source of truth).

export const USE_MESSAGES_FLOW_SCROLL_FETCH = true;
export const USE_MESSAGES_FLOW_LIVE = true;
export const USE_MESSAGES_FLOW_MAX_COUNTER_PROBE = true;
export const USE_MESSAGES_FLOW_B_ROUTE_COMMIT = true;

export function getMessagesFlowFlags() {
  return {
    USE_MESSAGES_FLOW_SCROLL_FETCH,
    USE_MESSAGES_FLOW_LIVE,
    USE_MESSAGES_FLOW_MAX_COUNTER_PROBE,
    USE_MESSAGES_FLOW_B_ROUTE_COMMIT,
    source: 'default'
  };
}
