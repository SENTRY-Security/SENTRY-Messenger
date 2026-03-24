// safe-worker/src/index.js
// SAFE Browser Worker — runs KasmVNC Chromium on Cloudflare Containers.
//
// Architecture:
//   Client (SAFE tab) ──HTTP/WS──▶ Worker fetch()
//                                      │
//                            ┌─────────▼──────────┐
//                            │  BrowserSession DO  │  (extends Container)
//                            │  ┌────────────────┐ │
//                            │  │ KasmVNC Chrome  │ │  port 6901
//                            │  └────────────────┘ │
//                            └────────────────────┘
//
// Routes:
//   GET  /api/safe/status        — container status (running/sleeping/etc.)
//   POST /api/safe/start         — start or wake the container
//   POST /api/safe/stop          — stop the container
//   *    /api/safe/browser/**    — proxy all HTTP/WebSocket to KasmVNC

import { Container } from '@cloudflare/containers';

// ── CORS helpers ─────────────────────────────────────────────────

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

function json(data, status, request, env) {
  return Response.json(data, {
    status,
    headers: corsHeaders(request, env),
  });
}

// ── Worker fetch ─────────────────────────────────────────────────

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

    // All /api/safe/* routes require auth
    if (!url.pathname.startsWith('/api/safe/')) {
      return json({ error: 'Not found' }, 404, request, env);
    }

    // Auth: Bearer header for API calls; token-in-path for iframe sub-resources
    // Path format: /api/safe/browser/{token}/vnc.html, /api/safe/browser/{token}/app/ui.js, etc.
    const auth = request.headers.get('Authorization') || '';
    let token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      const m = url.pathname.match(/^\/api\/safe\/browser\/([^/]+)\//);
      if (m) token = decodeURIComponent(m[1]);
    }
    if (!token) {
      return json({ error: 'Authorization required' }, 401, request, env);
    }

    // Each token maps to a unique Container instance (1 user = 1 browser)
    const id = env.BROWSER_SESSION.idFromName(token);
    const stub = env.BROWSER_SESSION.get(id);
    return stub.fetch(request);
  }
};

// ── BrowserSession Container ─────────────────────────────────────
//
// Extends Container — each instance IS a running KasmVNC Chromium.
// The Container class handles:
//   - Starting/stopping the Docker container
//   - Proxying HTTP and WebSocket to the container's port
//   - Sleep after inactivity

export class BrowserSession extends Container {
  // KasmVNC serves its HTML5 client + WebSocket on port 6901
  defaultPort = 6901;

  // Auto-sleep after 10 minutes of no activity
  // (WebSocket messages automatically renew the timeout)
  sleepAfter = '10m';

  // Internet access required — users browse FB/IG/LINE/Telegram
  enableInternet = true;

  // VNC_PW is auto-generated per session and stored in DO storage.
  // Initialized in fetch() before container starts.
  envVars = {};

  // ── Lifecycle hooks ──────────────────────────────────────────

  onStart() {
    console.log('[SAFE] Container started:', this.ctx.id.toString());
  }

  onStop() {
    console.log('[SAFE] Container stopped:', this.ctx.id.toString());
  }

  onError(error) {
    console.error('[SAFE] Container error:', this.ctx.id.toString(), error);
  }

  // Restore envVars from DO storage (needed after DO memory eviction)
  async _ensureEnvVars() {
    if (this.envVars?.VNC_PW) return;
    const pw = await this.ctx.storage.get('vnc_pw');
    if (pw) this.envVars = { VNC_PW: pw };
  }

  // ── Request handler ──────────────────────────────────────────
  //
  // Routes:
  //   GET  /api/safe/status      → return container state
  //   POST /api/safe/start       → start container, return KasmVNC URL
  //   POST /api/safe/stop        → stop container
  //   *    /api/safe/browser/**  → proxy to KasmVNC (HTTP + WebSocket)

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Status check ───────────────────────────────────────────
    if (path === '/api/safe/status' && request.method === 'GET') {
      const state = await this.getState();
      const startedAt = await this.ctx.storage.get('started_at');
      const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
      return Response.json({
        status: state.status,
        port: this.defaultPort,
        elapsed,
      });
    }

    // ── Start container ────────────────────────────────────────
    if (path === '/api/safe/start' && request.method === 'POST') {
      try {
        // Auto-generate VNC password per session (or reuse existing)
        let vncPassword = await this.ctx.storage.get('vnc_pw');
        if (!vncPassword) {
          vncPassword = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
          await this.ctx.storage.put('vnc_pw', vncPassword);
        }

        // Set password before starting
        this.envVars = { VNC_PW: vncPassword };

        // Check current state — return actual status
        const currentState = await this.getState();
        if (currentState.status === 'healthy') {
          return Response.json({
            status: 'healthy',
            password: vncPassword,
            browserPath: '/api/safe/browser/',
          });
        }
        // Already starting — don't restart, just return current status
        if (currentState.status === 'running') {
          return Response.json({
            status: 'running',
            password: vncPassword,
            browserPath: '/api/safe/browser/',
          });
        }

        // Record start time for elapsed tracking
        await this.ctx.storage.put('started_at', Date.now());

        // Start container in background — don't block the response.
        // Frontend will poll /api/safe/status every 3s to track progress.
        this.ctx.waitUntil(
          this.startAndWaitForPorts().catch(err => {
            console.error('[SAFE] Background start failed:', err?.message);
          })
        );

        return Response.json({
          status: 'starting',
          password: vncPassword,
          browserPath: '/api/safe/browser/',
        });
      } catch (err) {
        return Response.json({
          status: 'error',
          message: err?.message || 'Failed to start container',
        }, { status: 500 });
      }
    }

    // ── Stop container ─────────────────────────────────────────
    if (path === '/api/safe/stop' && request.method === 'POST') {
      try {
        await this.stop();
        return Response.json({ status: 'stopped' });
      } catch (err) {
        return Response.json({
          status: 'error',
          message: err?.message || 'Failed to stop container',
        }, { status: 500 });
      }
    }

    // ── Destroy container ────────────────────────────────────────
    if (path === '/api/safe/destroy' && request.method === 'DELETE') {
      try {
        await this.stop();
        await this.ctx.storage.deleteAll();
        return Response.json({ status: 'destroyed' });
      } catch (err) {
        return Response.json({
          status: 'error',
          message: err?.message || 'Failed to destroy container',
        }, { status: 500 });
      }
    }

    // ── Proxy to KasmVNC ───────────────────────────────────────
    // Rewrite /api/safe/browser/** → /** on port 6901
    // This handles both HTTP (static assets) and WebSocket (VNC stream)
    if (path.startsWith('/api/safe/browser')) {
      // Restore envVars before any potential container start
      await this._ensureEnvVars();

      const state = await this.getState();
      if (state.status !== 'running' && state.status !== 'healthy') {
        try {
          await this.startAndWaitForPorts();
        } catch (err) {
          return Response.json({
            status: 'error',
            message: 'Container not running: ' + (err?.message || ''),
          }, { status: 503 });
        }
      }

      // Strip /api/safe/browser/{token} prefix, keep the rest of the path
      const containerPath = path.replace(/^\/api\/safe\/browser\/[^/]*/, '') || '/';
      const containerUrl = new URL(request.url);
      containerUrl.pathname = containerPath;

      // Pass the original request to preserve WebSocket upgrade headers
      return super.fetch(new Request(containerUrl.toString(), request));
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}
