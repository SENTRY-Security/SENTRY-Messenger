/**
 * RateLimiter — Durable Object for distributed rate limiting.
 *
 * Each instance is keyed by a composite string (e.g. "ip:1.2.3.4" or
 * "account:ABCD1234") via idFromName().  State is kept in-memory with
 * alarm-based expiry so there is no persistent storage cost.
 *
 * Sliding-window algorithm: requests are tracked per window and the DO
 * returns { allowed, remaining, retryAfter } for each check.
 */
export class RateLimiter {
  constructor(state, _env) {
    this.state = state;
    // { action → { count, windowStart } }
    this.buckets = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/check') {
      return this.handleCheck(request);
    }

    if (url.pathname === '/reset') {
      return this.handleReset(request);
    }

    return new Response('not found', { status: 404 });
  }

  async handleCheck(request) {
    const { action, limit, windowSec } = await request.json();
    if (!action || !limit || !windowSec) {
      return Response.json({ error: 'missing params' }, { status: 400 });
    }

    const now = Math.floor(Date.now() / 1000);
    let bucket = this.buckets.get(action);

    // Reset window if expired
    if (!bucket || now - bucket.windowStart >= windowSec) {
      bucket = { count: 0, windowStart: now };
    }

    bucket.count += 1;
    this.buckets.set(action, bucket);

    // Schedule alarm to clean up stale buckets
    this.scheduleCleanup(windowSec);

    const allowed = bucket.count <= limit;
    const remaining = Math.max(0, limit - bucket.count);
    const retryAfter = allowed ? 0 : bucket.windowStart + windowSec - now;

    return Response.json({ allowed, remaining, retryAfter });
  }

  async handleReset(request) {
    const { action } = await request.json();
    if (action) {
      this.buckets.delete(action);
    } else {
      this.buckets.clear();
    }
    return Response.json({ ok: true });
  }

  scheduleCleanup(delaySec) {
    // Only set alarm if none pending — avoids unnecessary overwrites
    this.state.storage.getAlarm().then((existing) => {
      if (!existing) {
        this.state.storage.setAlarm(Date.now() + delaySec * 1000);
      }
    });
  }

  async alarm() {
    const now = Math.floor(Date.now() / 1000);
    let maxWindow = 0;
    for (const [action, bucket] of this.buckets) {
      // We don't know per-bucket windowSec here, so we keep buckets
      // for up to 10 minutes as a safe upper bound.  The real expiry
      // is checked in handleCheck.
      if (now - bucket.windowStart > 600) {
        this.buckets.delete(action);
      } else {
        maxWindow = Math.max(maxWindow, 600 - (now - bucket.windowStart));
      }
    }
    // Re-schedule if there are remaining buckets
    if (this.buckets.size > 0 && maxWindow > 0) {
      this.state.storage.setAlarm(Date.now() + maxWindow * 1000);
    }
  }
}
