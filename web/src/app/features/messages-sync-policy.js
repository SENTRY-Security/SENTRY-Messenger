// Policy for offline decrypt catch-up and incoming vaultPut retry queue.
// Keep these values small to avoid excessive network/decrypt work or replay delays.

export const OFFLINE_CATCHUP_CONVERSATION_LIMIT = 5;
export const OFFLINE_CATCHUP_MESSAGE_LIMIT = 50;
// Coalesce resume triggers (visibility/pageshow) to avoid duplicate sync bursts.
export const OFFLINE_SYNC_TRIGGER_COALESCE_MS = 1000;
// Cap server catch-up probes to a small set of recent conversations.
export const SERVER_CATCHUP_CONVERSATION_LIMIT = 5;
// Debounce server catch-up triggers to coalesce bursty resume events.
export const SERVER_CATCHUP_TRIGGER_COALESCE_MS = 500;
// Limit outgoing-status reconciliation batch size to keep requests lightweight.
export const OUTGOING_STATUS_RECONCILE_ID_LIMIT = 50;
export const PENDING_VAULT_PUT_QUEUE_LIMIT = 500;
export const PENDING_VAULT_PUT_RETRY_MAX = 3;
export const PENDING_VAULT_PUT_RETRY_INTERVAL_MS = 2000;
export const COUNTER_GAP_RETRY_MAX = 3;
export const COUNTER_GAP_RETRY_INTERVAL_MS = 2000;
export const OFFLINE_SYNC_LOG_CAP = 5;
export const NOTIFY_RETRY_INITIAL_DELAY_MS = 3000;
export const NOTIFY_RETRY_INTERVAL_MS = 2000;
export const NOTIFY_RETRY_MAX_ATTEMPTS = 5;
// Single setTimeout policy for notify-retry scheduling; cap delay to avoid runaway timers.
const NOTIFY_RETRY_MAX_DELAY_MS = 10_000;

export function scheduleNotifyRetryTimeout(fn, delayMs) {
  const safeDelay = Math.min(Math.max(0, Number(delayMs) || 0), NOTIFY_RETRY_MAX_DELAY_MS);
  return setTimeout(() => {
    if (typeof fn === 'function') fn();
  }, safeDelay);
}
