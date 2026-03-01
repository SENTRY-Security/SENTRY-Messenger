// /app/features/adaptive-concurrency.js
// AIMD (Additive Increase / Multiplicative Decrease) adaptive concurrency controller.
// Inspired by TCP congestion control; used by chunked-upload and chunked-download
// to automatically find the optimal parallelism for the current network conditions.
//
// Usage:
//   const ac = new AdaptiveConcurrency({ initial: 6, floor: 2, ceiling: 15 });
//   ac.concurrency   // current limit
//   ac.recordSuccess(durationMs)  // call after each successful chunk
//   ac.recordFailure()            // call on timeout / network error

/**
 * Detect a reasonable initial concurrency based on the Network Information API.
 * Falls back to `fallback` when the API is unavailable.
 */
export function detectInitialConcurrency(fallback = 4) {
  try {
    const conn = navigator?.connection || navigator?.mozConnection || navigator?.webkitConnection;
    if (!conn) return fallback;
    const ect = conn.effectiveType; // '4g', '3g', '2g', 'slow-2g'
    if (ect === '4g') return 6;
    if (ect === '3g') return 3;
    return 2; // 2g / slow-2g
  } catch {
    return fallback;
  }
}

export class AdaptiveConcurrency {
  /**
   * @param {object} opts
   * @param {number} [opts.initial]   - starting concurrency (default: auto-detect)
   * @param {number} [opts.floor=2]   - minimum concurrency
   * @param {number} [opts.ceiling=15] - maximum concurrency
   * @param {number} [opts.window=3]  - how many samples before evaluating
   * @param {number} [opts.rttThreshold=1.5] - RTT increase ratio that triggers decrease
   * @param {number} [opts.decreaseFactor=0.5] - multiplicative decrease factor
   */
  constructor({
    initial,
    floor = 2,
    ceiling = 15,
    window = 3,
    rttThreshold = 1.5,
    decreaseFactor = 0.5
  } = {}) {
    this._floor = Math.max(1, floor);
    this._ceiling = Math.max(this._floor, ceiling);
    this._window = Math.max(1, window);
    this._rttThreshold = rttThreshold;
    this._decreaseFactor = decreaseFactor;

    // Current concurrency limit
    this._concurrency = Math.min(
      this._ceiling,
      Math.max(this._floor, initial ?? detectInitialConcurrency(4))
    );

    // RTT tracking (sliding window of recent durations in ms)
    this._recentRtts = [];
    this._baselineRtt = 0;    // smoothed baseline RTT
    this._sampleCount = 0;    // total samples since last adjustment
    this._failureCount = 0;   // failures in current window
  }

  /** Current concurrency limit. */
  get concurrency() {
    return this._concurrency;
  }

  /**
   * Record a successful chunk completion.
   * @param {number} durationMs - how long the chunk took (upload or download)
   */
  recordSuccess(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;

    this._recentRtts.push(durationMs);
    this._sampleCount++;

    // Initialise baseline from first few samples
    if (this._baselineRtt === 0 && this._recentRtts.length >= this._window) {
      this._baselineRtt = median(this._recentRtts);
    }

    // Evaluate every `_window` samples
    if (this._sampleCount >= this._window) {
      this._evaluate();
    }
  }

  /**
   * Record a failure (timeout, network error, etc.).
   * Triggers an immediate multiplicative decrease.
   */
  recordFailure() {
    this._failureCount++;

    // Immediate decrease on failure
    const prev = this._concurrency;
    this._concurrency = Math.max(
      this._floor,
      Math.ceil(this._concurrency * this._decreaseFactor)
    );
    if (this._concurrency !== prev) {
      console.info(`[adaptive] failure → concurrency ${prev} → ${this._concurrency}`);
    }

    // Reset window
    this._sampleCount = 0;
    this._failureCount = 0;
    this._recentRtts = [];
  }

  /** Internal: evaluate recent samples and adjust concurrency. */
  _evaluate() {
    const currentRtt = median(this._recentRtts.slice(-this._window));
    const hadFailures = this._failureCount > 0;

    // Reset counters
    this._sampleCount = 0;
    this._failureCount = 0;

    if (hadFailures) {
      // Already handled in recordFailure(), just update baseline
      this._baselineRtt = currentRtt || this._baselineRtt;
      this._recentRtts = [];
      return;
    }

    if (this._baselineRtt <= 0) {
      // Not enough data yet — keep collecting
      this._baselineRtt = currentRtt;
      this._recentRtts = [];
      return;
    }

    const ratio = currentRtt / this._baselineRtt;
    const prev = this._concurrency;

    if (ratio > this._rttThreshold) {
      // RTT spiked → multiplicative decrease
      this._concurrency = Math.max(
        this._floor,
        Math.ceil(this._concurrency * this._decreaseFactor)
      );
      // Update baseline to current (higher) RTT to avoid repeated decreases
      this._baselineRtt = currentRtt;
      if (this._concurrency !== prev) {
        console.info(`[adaptive] RTT spike (${ratio.toFixed(2)}x) → concurrency ${prev} → ${this._concurrency}`);
      }
    } else {
      // RTT stable or improving → additive increase.
      // Increase by +2 when RTT is well below baseline (fast network with
      // headroom), +1 otherwise. This halves ramp-up time on fast connections
      // while staying conservative when RTT is near the spike threshold.
      if (this._concurrency < this._ceiling) {
        const increment = ratio < 0.85 ? 2 : 1;
        this._concurrency = Math.min(this._ceiling, this._concurrency + increment);
        console.info(`[adaptive] stable RTT (${ratio.toFixed(2)}x) → concurrency ${prev} → ${this._concurrency}`);
      }
      // Slowly adapt baseline toward current RTT (exponential moving average)
      this._baselineRtt = this._baselineRtt * 0.7 + currentRtt * 0.3;
    }

    // Keep only recent samples
    this._recentRtts = this._recentRtts.slice(-this._window);
  }
}

/** Compute median of a numeric array. */
function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
