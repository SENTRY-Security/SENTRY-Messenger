#!/usr/bin/env node
// Build script: esbuild bundle + static asset copy
//
// Entry points → single bundled file each (ES module output).
// CSS, HTML, images, _headers → copied as-is.
// Cloudflare Pages Functions (web/functions/) are NOT touched here.

import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, 'src');
const dist = resolve(__dirname, 'dist');

// --- Plugin: resolve absolute paths (/shared/..., /libs/...) to src/ ---
const absolutePathPlugin = {
  name: 'absolute-paths',
  setup(b) {
    b.onResolve({ filter: /^\/(shared|libs)\// }, (args) => ({
      path: resolve(src, args.path.slice(1))
    }));
  }
};

// --- Clean ---
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// --- Bundle JS entry points ---
const entryPoints = [
  'src/app/ui/app-mobile.js',      // main app (app.html)
  'src/app/ui/login-ui.js',        // login page (login.html)
  'src/app/ui/debug-page.js',      // debug page
  'src/app/ui/media-permission-demo.js'  // mic-test page
];

console.time('esbuild');
const result = await build({
  entryPoints,
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: resolve(dist, 'app/ui'),
  chunkNames: 'chunks/[name]-[hash]',
  minify: true,
  sourcemap: true,
  target: ['es2022'],
  plugins: [absolutePathPlugin],
  external: [
    'https://esm.sh/*',
    'https://cdn.jsdelivr.net/*',
    'tweetnacl'                    // Node-only dynamic import, browser uses window.nacl
  ],
  logLevel: 'info',
  metafile: true
});
console.timeEnd('esbuild');

// --- Report JS bundle sizes ---
if (result.metafile) {
  const outputs = result.metafile.outputs;
  const entries = Object.entries(outputs)
    .filter(([k]) => k.endsWith('.js'))
    .sort((a, b) => b[1].bytes - a[1].bytes);
  console.log('\nJS bundle output:');
  let total = 0;
  for (const [file, info] of entries) {
    const kb = (info.bytes / 1024).toFixed(1);
    total += info.bytes;
    console.log(`  ${file}  ${kb} KB`);
  }
  console.log(`  Total: ${(total / 1024).toFixed(1)} KB\n`);
}

// --- Bundle CSS (app-bundle.css → single minified file) ---
console.time('css-bundle');
const cssResult = await build({
  entryPoints: ['src/assets/app-bundle.css'],
  bundle: true,
  outdir: resolve(dist, 'assets'),
  minify: true,
  logLevel: 'info',
  metafile: true
});
console.timeEnd('css-bundle');

if (cssResult.metafile) {
  const cssOutputs = Object.entries(cssResult.metafile.outputs)
    .filter(([k]) => k.endsWith('.css'));
  for (const [file, info] of cssOutputs) {
    console.log(`CSS bundle: ${file}  ${(info.bytes / 1024).toFixed(1)} KB`);
  }
}

// --- Copy static assets ---
const staticDirs = ['pages', 'assets', 'libs', 'shared'];
for (const dir of staticDirs) {
  cpSync(resolve(src, dir), resolve(dist, dir), { recursive: true });
}

// Copy top-level files
const staticFiles = ['index.html', '_headers'];
for (const file of staticFiles) {
  try {
    cpSync(resolve(src, file), resolve(dist, file));
  } catch { /* optional file */ }
}

console.log('Static assets copied.');
console.log('Build complete → dist/');
