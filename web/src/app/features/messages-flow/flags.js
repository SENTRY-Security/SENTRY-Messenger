// Runtime flags for messages-flow (single source of truth).

import { logCapped } from '../core/log.js';

export const USE_MESSAGES_FLOW_SCROLL_FETCH = false;
export const USE_MESSAGES_FLOW_LIVE = false;
export const USE_MESSAGES_FLOW_MAX_COUNTER_PROBE = false;
export const USE_MESSAGES_FLOW_B_ROUTE_COMMIT = false;

let enableTraceLogged = false;

function readLiveQueryOverride() {
  if (typeof window === 'undefined' || !window?.location?.search) return false;
  try {
    const params = new URLSearchParams(window.location.search || '');
    return params.get('mf_live') === '1';
  } catch {
    return false;
  }
}

function readLiveStorageOverride() {
  if (typeof window === 'undefined' || !window?.localStorage) return false;
  try {
    return window.localStorage.getItem('messagesFlow.live') === '1';
  } catch {
    return false;
  }
}

function logEnableTraceOnce({ source, live, commit, probe }) {
  if (enableTraceLogged) return;
  enableTraceLogged = true;
  logCapped('messagesFlowEnableTrace', {
    source,
    live: !!live,
    commit: !!commit,
    probe: !!probe,
    tsMs: Date.now()
  }, 5);
}

export function getMessagesFlowFlags() {
  const queryOverride = readLiveQueryOverride();
  const storageOverride = queryOverride ? false : readLiveStorageOverride();
  const enableLive = queryOverride || storageOverride;
  const source = queryOverride ? 'query' : (storageOverride ? 'storage' : 'default');
  const live = enableLive ? true : USE_MESSAGES_FLOW_LIVE;
  const commit = enableLive ? true : USE_MESSAGES_FLOW_B_ROUTE_COMMIT;
  const probe = enableLive ? true : USE_MESSAGES_FLOW_MAX_COUNTER_PROBE;
  if (enableLive) {
    logEnableTraceOnce({
      source,
      live,
      commit,
      probe
    });
  }
  return {
    USE_MESSAGES_FLOW_SCROLL_FETCH,
    USE_MESSAGES_FLOW_LIVE: live,
    USE_MESSAGES_FLOW_MAX_COUNTER_PROBE: probe,
    USE_MESSAGES_FLOW_B_ROUTE_COMMIT: commit,
    source
  };
}
