#!/usr/bin/env node
// Minimal static server for web/src with API_ORIGIN override for login/app pages.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8788);
const ORIGIN = String(process.env.E2E_ORIGIN_API || process.env.ORIGIN_API || 'http://127.0.0.1:3000');
const ROOT = path.resolve(process.cwd(), 'web/src');

const app = express();

function rewriteApiOrigin(html) {
  return html.replace(/window\.API_ORIGIN\s*=\s*'[^']*';/g, `window.API_ORIGIN = '${ORIGIN}';`);
}

function relaxCSP(html) {
  // Widen script-src to allow https: so dynamic imports (esm.sh) and argon2 CDN can load during tests.
  return html.replace(
    /(http-equiv\s*=\s*"Content-Security-Policy"[^>]*content=\s*")([^"]*)(")/i,
    (_, pre, content, post) => {
      const updated = content
        .replace(/script-src\s+'self';/g, "script-src 'self' https:;")
        .replace(/default-src\s+'self';/g, "default-src 'self' https:;"
        );
      return pre + updated + post;
    }
  );
}

async function sendRewritten(res, fileRel) {
  const filePath = path.join(ROOT, fileRel);
  const raw = await fs.readFile(filePath, 'utf8');
  const out = relaxCSP(rewriteApiOrigin(raw));
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(out);
}

app.get('/__healthz', (req, res) => res.status(200).send('ok'));
app.get('/pages/login.html', (req, res) => sendRewritten(res, 'pages/login.html').catch((e) => res.status(500).send(e?.message || 'err')));
app.get('/pages/app.html', (req, res) => sendRewritten(res, 'pages/app.html').catch((e) => res.status(500).send(e?.message || 'err')));
app.use(express.static(ROOT));

app.listen(PORT, '0.0.0.0', () => {
  // eslint-disable-next-line no-console
  console.log(`[serve-web] listening on http://localhost:${PORT} (origin=${ORIGIN})`);
});
