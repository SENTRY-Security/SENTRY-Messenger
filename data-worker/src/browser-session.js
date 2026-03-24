// data-worker/src/browser-session.js
// SAFE Browser — Chromium + noVNC on Cloudflare Containers.
// Merged into data-worker so /api/safe/* routes are handled directly.
//
// Container stack: Alpine + Xvfb + Chromium + x11vnc + noVNC (websockify)
// noVNC serves HTML5 client + WebSocket on port 6901.

import { Container } from '@cloudflare/containers';

export class BrowserSession extends Container {
  // noVNC WebSocket proxy listens on port 6901
  defaultPort = 6901;

  // Auto-sleep after 10 minutes of no activity
  sleepAfter = '10m';

  // Internet access required — users browse FB/IG/LINE/Telegram
  enableInternet = true;

  // VNC_PW is auto-generated per session and stored in DO storage.
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
  //   POST /api/safe/start       → start container, return noVNC URL
  //   POST /api/safe/stop        → stop container
  //   *    /api/safe/browser/**  → proxy to noVNC (HTTP + WebSocket)

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── Status check ───────────────────────────────────────────
    if (path === '/api/safe/status' && request.method === 'GET') {
      const state = await this.getState();
      const startedAt = await this.ctx.storage.get('started_at');
      const elapsed = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
      const lastError = await this.ctx.storage.get('last_error');
      return Response.json({
        status: state.status,
        port: this.defaultPort,
        elapsed,
        ...(lastError ? { last_error: lastError } : {}),
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
        console.log('[SAFE] /start — currentState:', JSON.stringify(currentState));
        if (currentState.status === 'healthy') {
          return Response.json({
            status: 'healthy',
            password: vncPassword,
            browserPath: '/api/safe/browser/',
          });
        }

        // "running" but not "healthy" — port 6901 not responding.
        // If it's been running > 60s without becoming healthy, force restart.
        const startedAt = await this.ctx.storage.get('started_at');
        const elapsed = startedAt ? (Date.now() - startedAt) / 1000 : 0;

        if (currentState.status === 'running' && elapsed < 120) {
          // Still within startup window — let it finish
          return Response.json({
            status: 'running',
            password: vncPassword,
            browserPath: '/api/safe/browser/',
          });
        }

        // Either stopped, or running but stuck (> 120s without healthy).
        // Force stop first if stuck, then restart fresh.
        if (currentState.status === 'running') {
          console.log('[SAFE] Container stuck in running state for', Math.round(elapsed), 's — restarting');
          try { await this.stop(); } catch (_) { /* ignore */ }
        }

        // Record start time and clear previous errors
        await this.ctx.storage.put('started_at', Date.now());
        await this.ctx.storage.delete('last_error');

        // Start container in background — don't block the response.
        // Frontend will poll /api/safe/status every 3s to track progress.
        this.ctx.waitUntil(
          this.startAndWaitForPorts().catch(async (err) => {
            const msg = err?.message || 'Unknown start error';
            console.error('[SAFE] Background start failed:', msg);
            await this.ctx.storage.put('last_error', msg);
          })
        );

        return Response.json({
          status: 'starting',
          password: vncPassword,
          browserPath: '/api/safe/browser/',
          containerState: currentState.status,
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
      const errors = [];
      // Stop container — ignore errors (may already be stopped/deleted externally)
      try { await this.stop(); } catch (err) {
        errors.push('stop: ' + (err?.message || 'unknown'));
      }
      // Always clear DO storage regardless of stop result
      try { await this.ctx.storage.deleteAll(); } catch (err) {
        errors.push('storage: ' + (err?.message || 'unknown'));
      }
      return Response.json({
        status: 'destroyed',
        ...(errors.length ? { warnings: errors } : {}),
      });
    }

    // ── Debug: test proxy to container ─────────────────────────
    if (path === '/api/safe/debug-proxy' && request.method === 'GET') {
      const state = await this.getState();
      if (state.status !== 'running' && state.status !== 'healthy') {
        return Response.json({ error: 'Container not running', state: state.status }, { status: 503 });
      }
      try {
        // Try to fetch the root page from the container's noVNC server
        const proxyReq = new Request(new URL('/', request.url).toString(), { method: 'GET' });
        const resp = await super.fetch(proxyReq);
        const text = await resp.text();
        return Response.json({
          proxyStatus: resp.status,
          proxyHeaders: Object.fromEntries(resp.headers.entries()),
          bodyLength: text.length,
          bodyPreview: text.slice(0, 500),
          containerState: state.status,
        });
      } catch (err) {
        return Response.json({
          error: 'Proxy fetch failed',
          message: err?.message || String(err),
          stack: err?.stack?.slice(0, 500),
          containerState: state.status,
        }, { status: 500 });
      }
    }

    // ── Proxy to noVNC ─────────────────────────────────────────
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

      // Check if this is a WebSocket upgrade request
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
        // WebSocket: must pass through the original request for upgrade handshake
        return super.fetch(new Request(containerUrl.toString(), request));
      }

      // HTTP: build a clean request to avoid inheriting signal/body issues
      // from the original request chain (worker → DO → container)
      const proxyHeaders = new Headers();
      // Forward only headers the container's web server needs
      for (const name of ['accept', 'accept-encoding', 'accept-language',
                          'if-modified-since', 'if-none-match', 'range']) {
        const val = request.headers.get(name);
        if (val) proxyHeaders.set(name, val);
      }
      return super.fetch(new Request(containerUrl.toString(), {
        method: request.method,
        headers: proxyHeaders,
      }));
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}
