// safe-worker/src/index.js
// SAFE Browser Worker — manages KasmVNC Chromium containers on CF Containers.
//
// Architecture:
//   Client (SAFE tab) ──WebSocket──▶ Worker ──▶ Durable Object (BrowserSession)
//                                                     │
//                                                     ▼
//                                              CF Container
//                                           (kasmweb/chromium)
//                                              port 6901 (KasmVNC WebSocket)
//
// Routes:
//   POST /api/safe/session         — create or wake a browser session
//   GET  /api/safe/session/ws      — WebSocket upgrade → proxied to container
//   DELETE /api/safe/session        — destroy a browser session

// ── CORS helper ──────────────────────────────────────────────────

function getAllowedOrigins(env) {
  return (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = getAllowedOrigins(env);
  const match = allowed.includes(origin) ? origin : '';
  return {
    'Access-Control-Allow-Origin': match,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

// ── Main Worker fetch ────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    // Validate origin
    const origin = request.headers.get('Origin') || '';
    const allowed = getAllowedOrigins(env);
    if (origin && !allowed.includes(origin)) {
      return new Response('Forbidden', { status: 403 });
    }

    // Extract session ID from auth header: "Bearer <sessionToken>:<sessionId>"
    const auth = request.headers.get('Authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (!token) {
      return Response.json({ error: 'Authorization required' }, {
        status: 401,
        headers: corsHeaders(request, env),
      });
    }

    // Use token as Durable Object ID (deterministic per user session)
    const doId = env.BROWSER_SESSION.idFromName(token);
    const stub = env.BROWSER_SESSION.get(doId);

    // Route to Durable Object
    const doUrl = new URL(request.url);
    doUrl.hostname = 'do';

    return stub.fetch(new Request(doUrl.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
    }));
  }
};

// ── BrowserSession Durable Object ────────────────────────────────
//
// Manages a single KasmVNC Chromium container instance.
// Handles:
//   - Container lifecycle (start / stop / health)
//   - WebSocket proxy between client and KasmVNC

export class BrowserSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.container = null;       // CF Container handle (future)
    this.containerReady = false;
    this.idleTimeout = null;
    this.idleMs = parseInt(env.CONTAINER_IDLE_MS, 10) || 600000;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/safe/session — start or get container status
    if (path === '/api/safe/session' && request.method === 'POST') {
      return this.handleStart(request);
    }

    // GET /api/safe/session/ws — WebSocket proxy to container
    if (path === '/api/safe/session/ws' && request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // DELETE /api/safe/session — destroy container
    if (path === '/api/safe/session' && request.method === 'DELETE') {
      return this.handleDestroy(request);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  // ── Container lifecycle ──────────────────────────────────────

  async handleStart(_request) {
    // NOTE: CF Containers API is not yet public. This is a forward-looking
    // implementation that will work once containers.start() is available
    // in Durable Objects. For now, this supports an external KasmVNC
    // instance specified via environment or storage.

    // Check if we have a stored external endpoint (for VPS/local dev)
    let endpoint = await this.state.storage.get('endpoint');

    if (!endpoint) {
      // In production with CF Containers, we would do:
      //   this.container = await this.state.container.start({
      //     image: 'kasmweb/chromium:1.18.0',
      //     instanceType: { vcpu: 1, memory_mib: 2048, disk_mb: 4096 },
      //     enableInternet: true,
      //     env: { VNC_PW: crypto.randomUUID().slice(0, 12) },
      //   });
      //   endpoint = `https://${this.container.hostname}:6901`;
      //
      // For now, return instructions for setting the endpoint manually.
      return Response.json({
        status: 'no_endpoint',
        message: 'No browser endpoint configured. Use POST /api/safe/session with body { "endpoint": "wss://..." } to set one.',
      }, { status: 200 });
    }

    this.resetIdleTimer();
    this.containerReady = true;

    return Response.json({
      status: 'ready',
      endpoint: endpoint,
      idleTimeoutMs: this.idleMs,
    });
  }

  async handleDestroy(_request) {
    await this.state.storage.delete('endpoint');
    this.containerReady = false;
    this.clearIdleTimer();

    // If CF Container:
    // await this.container?.stop();

    return Response.json({ status: 'destroyed' });
  }

  // ── WebSocket proxy ──────────────────────────────────────────

  async handleWebSocket(request) {
    const endpoint = await this.state.storage.get('endpoint');
    if (!endpoint) {
      return Response.json({ error: 'No browser endpoint' }, { status: 503 });
    }

    // Create a WebSocket pair for the client
    const [client, server] = Object.values(new WebSocketPair());

    // Accept the server side
    server.accept();

    // Connect to the KasmVNC WebSocket endpoint
    let upstream;
    try {
      upstream = new WebSocket(endpoint);
    } catch (err) {
      server.close(1011, 'Failed to connect to browser: ' + err.message);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Proxy: client ↔ upstream (KasmVNC)
    server.addEventListener('message', (event) => {
      try {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(event.data);
        }
      } catch { /* upstream closed */ }
      this.resetIdleTimer();
    });

    server.addEventListener('close', (event) => {
      try { upstream.close(event.code, event.reason); } catch { }
    });

    upstream.addEventListener('open', () => {
      // Upstream ready — any queued messages from client will flow
    });

    upstream.addEventListener('message', (event) => {
      try {
        if (server.readyState === WebSocket.OPEN) {
          server.send(event.data);
        }
      } catch { /* client closed */ }
    });

    upstream.addEventListener('close', (event) => {
      try { server.close(event.code, event.reason); } catch { }
    });

    upstream.addEventListener('error', () => {
      try { server.close(1011, 'Upstream connection error'); } catch { }
    });

    this.resetIdleTimer();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Idle timer ──────────────────────────────────────────────

  resetIdleTimer() {
    this.clearIdleTimer();
    this.idleTimeout = setTimeout(() => {
      // Container goes to sleep after idle period
      this.containerReady = false;
      // CF Container would auto-sleep; for external, we just mark inactive
    }, this.idleMs);
  }

  clearIdleTimer() {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }
}
