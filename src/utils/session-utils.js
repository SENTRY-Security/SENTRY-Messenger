const DEFAULT_MAX_FUTURE_SKEW = 3600; // seconds

/**
 * Normalize client-supplied session timestamps to integer seconds.
 * - Accepts seconds; converts millisecond-style values (>1e11) to seconds.
 * - Clamps unreasonable future values to current server time.
 * @param {number|undefined|null|string} raw
 * @param {{ now?: number, maxFutureSkew?: number }} [opts]
 * @returns {{ ts: number|null, clamped: boolean }} normalized seconds and whether clamping occurred
 */
export function normalizeSessionTs(raw, { now = Math.floor(Date.now() / 1000), maxFutureSkew = DEFAULT_MAX_FUTURE_SKEW } = {}) {
  let ts = Number(raw);
  let clamped = false;
  if (!Number.isFinite(ts) || ts <= 0) return { ts: null, clamped };
  if (ts > 1e11) {
    ts = Math.floor(ts / 1000); // treat as milliseconds
    clamped = true;
  }
  ts = Math.floor(ts);
  const maxAllowed = now + Math.max(0, Number(maxFutureSkew) || 0);
  if (ts > maxAllowed) {
    ts = now;
    clamped = true;
  }
  return { ts, clamped };
}
