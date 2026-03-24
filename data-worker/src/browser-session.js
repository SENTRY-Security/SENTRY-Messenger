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

    // ── Proxy to noVNC ─────────────────────────────────────────
    if (path.startsWith('/api/safe/browser')) {
      // Restore envVars before any potential container start
      await this._ensureEnvVars();

      // Ensure container is healthy (ports ready) before proxying.
      // 'running' means container started but noVNC may not be listening yet.
      const state = await this.getState();
      if (state.status !== 'healthy') {
        try {
          // startAndWaitForPorts waits until the port responds (healthy)
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
