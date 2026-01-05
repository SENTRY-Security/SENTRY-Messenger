// Policy for notify-retry scheduling (single policy file for timers).
// Keep caps small to avoid runaway timers or queue growth.
export const NOTIFY_RETRY_FIRST_WAIT_MS = 3000; // wait before first retry attempt
export const NOTIFY_RETRY_INTERVAL_MS = 2000; // interval between retry attempts
export const NOTIFY_RETRY_MAX_ATTEMPTS = 5; // total retry attempts
export const NOTIFY_RETRY_QUEUE_LIMIT = 200; // max queued messages awaiting retry

const NOTIFY_RETRY_MAX_DELAY_MS = 10_000; // safety cap for any scheduled delay

export function scheduleNotifyRetryTimeout(fn, delayMs) {
  const safeDelay = Math.min(Math.max(0, Number(delayMs) || 0), NOTIFY_RETRY_MAX_DELAY_MS);
  return setTimeout(() => {
    if (typeof fn === 'function') fn();
  }, safeDelay);
}
