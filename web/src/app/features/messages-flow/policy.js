// Central gap-queue policy knobs (bounded retry only).

export const GAP_QUEUE_RETRY_MAX = 3;
export const GAP_QUEUE_RETRY_INTERVAL_MS = 2000;

// Live message decrypt retry policy.
// When a live (B-route) decrypt fails with a recoverable reason code
// (e.g. SECURE_PENDING, DR_STATE_UNAVAILABLE, VAULT_PUT_FAILED),
// the facade retries up to LIVE_RETRY_MAX times with exponential backoff.
// Total worst-case wait ≈ 7 s (1 + 2 + 4), aligned with GAP_QUEUE_RETRY_MAX.
export const LIVE_RETRY_MAX = 3;
export const LIVE_RETRY_BASE_MS = 1000;
