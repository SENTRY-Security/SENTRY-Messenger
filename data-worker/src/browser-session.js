// data-worker/src/browser-session.js
// SAFE Browser — KasmVNC Chromium on Cloudflare Containers.
// Merged into data-worker so /api/safe/* routes are handled directly.

import { Container } from '@cloudflare/containers';

export class BrowserSession extends Container {
  // KasmVNC serves its HTML5 client + WebSocket on port 6901
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
      return Response.json({
        status: state,
        port: this.defaultPort,
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

        // Start container and wait for KasmVNC to be ready on port 6901
        await this.startAndWaitForPorts();

        return Response.json({
          status: 'running',
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

    // ── Proxy to KasmVNC ───────────────────────────────────────
    if (path.startsWith('/api/safe/browser')) {
      const state = await this.getState();
      if (state !== 'running') {
        try {
          await this.startAndWaitForPorts();
        } catch (err) {
          return Response.json({
            status: 'error',
            message: 'Container not running: ' + (err?.message || ''),
          }, { status: 503 });
        }
      }

      // Strip the /api/safe/browser prefix, keep the rest of the path
      const containerPath = path.replace('/api/safe/browser', '') || '/';
      const containerUrl = new URL(request.url);
      containerUrl.pathname = containerPath;

      const proxyRequest = new Request(containerUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });

      return super.fetch(proxyRequest);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
}
