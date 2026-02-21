#!/usr/bin/env node
// Build script: esbuild bundle + static asset copy + SRI integrity + build manifest
//
// Entry points → single bundled file each (ES module output).
// CSS, HTML, images, _headers → copied as-is.
// After copy, SRI hashes are computed for key bundles and injected into HTML.
// A build-manifest.json is written to dist/ for offline auditing.
// Cloudflare Pages Functions (web/functions/) are NOT touched here.

import { build } from 'esbuild';
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, 'src');
const dist = resolve(__dirname, 'dist');

// --- Build-time debug flag (from env or parent .env) ---
// DEBUG_MODE=true  → debug flags enabled (development)
// DEBUG_MODE=false → debug flags disabled (production, default)
const debugMode = String(process.env.DEBUG_MODE || 'false').toLowerCase() === 'true';
console.log(`DEBUG_MODE=${debugMode}`);


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
  sourcemap: false,
  target: ['es2022'],
  define: {
    '__DEBUG_MODE__': JSON.stringify(debugMode)
  },
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
const staticDirs = ['pages', 'assets', 'libs', 'shared', 'app/boot'];
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

// ============================================================================
// SRI: compute hashes for bundled files & inject into HTML
// ============================================================================

/** Compute sha384 base64 hash for a file */
function sri384(filePath) {
  const buf = readFileSync(filePath);
  const hash = createHash('sha384').update(buf).digest('base64');
  return `sha384-${hash}`;
}

/** Compute sha256 hex hash for a file */
function sha256hex(filePath) {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

// Key bundled files that need SRI in HTML
const bundledSRI = {};

// JS entry bundles
const jsEntryFiles = [
  'dist/app/ui/app-mobile.js',
  'dist/app/ui/login-ui.js',
  'dist/app/ui/debug-page.js',
  'dist/app/ui/media-permission-demo.js'
];
for (const f of jsEntryFiles) {
  const abs = resolve(__dirname, f);
  try {
    bundledSRI['/' + relative('dist', f)] = sri384(abs);
  } catch { /* file may not exist in some builds */ }
}

// CSS bundle
const cssBundlePath = resolve(dist, 'assets/app-bundle.css');
try {
  bundledSRI['/assets/app-bundle.css'] = sri384(cssBundlePath);
} catch { /* optional */ }

// JS chunk files
const chunksDir = resolve(dist, 'app/ui/chunks');
try {
  for (const f of readdirSync(chunksDir)) {
    if (f.endsWith('.js') && !f.endsWith('.js.map')) {
      const abs = resolve(chunksDir, f);
      bundledSRI[`/app/ui/chunks/${f}`] = sri384(abs);
    }
  }
} catch { /* chunks dir may not exist */ }

console.log(`\nSRI hashes computed for ${Object.keys(bundledSRI).length} bundled files.`);

// --- Inject SRI into HTML <link> and <script> loader blocks ---

// app.html: inject integrity for app-bundle.css
const appHtmlPath = resolve(dist, 'pages/app.html');
try {
  let html = readFileSync(appHtmlPath, 'utf8');
  const cssIntegrity = bundledSRI['/assets/app-bundle.css'];
  if (cssIntegrity) {
    // Add integrity to the async CSS <link>
    html = html.replace(
      /(<link\s+rel="stylesheet"\s+href="\/assets\/app-bundle\.css")/g,
      `$1 integrity="${cssIntegrity}" crossorigin="anonymous"`
    );
  }
  writeFileSync(appHtmlPath, html);
  console.log('SRI injected into app.html');
} catch (err) {
  console.warn('Warning: could not inject SRI into app.html:', err.message);
}

// login-boot.js: inject SRI for login-ui.js loader
const loginBootPath = resolve(dist, 'app/boot/login-boot.js');
const loginHtmlPath = resolve(dist, 'pages/login.html');
try {
  let js = readFileSync(loginBootPath, 'utf8');
  const jsIntegrity = bundledSRI['/app/ui/login-ui.js'];
  if (jsIntegrity) {
    js = js.replace(
      '(function loadLoginModule(){',
      `var __SRI_LOGIN_JS__ = "${jsIntegrity}";\n(function loadLoginModule(){`
    );
    js = js.replace(
      "script.src = '/app/ui/login-ui.js?v=' + encodeURIComponent(stamp);",
      "script.src = '/app/ui/login-ui.js?v=' + encodeURIComponent(stamp);\n    if (typeof __SRI_LOGIN_JS__ === 'string') { script.integrity = __SRI_LOGIN_JS__; script.crossOrigin = 'anonymous'; }"
    );
  }
  writeFileSync(loginBootPath, js);
  console.log('SRI injected into login-boot.js');
} catch (err) {
  console.warn('Warning: could not inject SRI into login-boot.js:', err.message);
}

// debug-boot.js: inject SRI for debug-page.js loader
const debugBootPath = resolve(dist, 'app/boot/debug-boot.js');
const debugHtmlPath = resolve(dist, 'pages/debug.html');
try {
  let js = readFileSync(debugBootPath, 'utf8');
  const jsIntegrity = bundledSRI['/app/ui/debug-page.js'];
  if (jsIntegrity) {
    js = js.replace(
      '(function loadDebugModule(){',
      `var __SRI_DEBUG_JS__ = "${jsIntegrity}";\n(function loadDebugModule(){`
    );
    js = js.replace(
      "script.src = '/app/ui/debug-page.js?v=' + encodeURIComponent(stamp);",
      "script.src = '/app/ui/debug-page.js?v=' + encodeURIComponent(stamp);\n    if (typeof __SRI_DEBUG_JS__ === 'string') { script.integrity = __SRI_DEBUG_JS__; script.crossOrigin = 'anonymous'; }"
    );
  }
  writeFileSync(debugBootPath, js);
  console.log('SRI injected into debug-boot.js');
} catch (err) {
  console.warn('Warning: could not inject SRI into debug-boot.js:', err.message);
}

// app-boot.js: inject SRI for app-mobile.js loader
const appBootPath = resolve(dist, 'app/boot/app-boot.js');
try {
  let js = readFileSync(appBootPath, 'utf8');
  const jsIntegrity = bundledSRI['/app/ui/app-mobile.js'];
  if (jsIntegrity) {
    js = js.replace(
      '(function loadAppModule() {',
      `var __SRI_APP_JS__ = "${jsIntegrity}";\n(function loadAppModule() {`
    );
    js = js.replace(
      "script.src = versionedSrc;",
      "script.src = versionedSrc;\n    if (typeof __SRI_APP_JS__ === 'string') { script.integrity = __SRI_APP_JS__; script.crossOrigin = 'anonymous'; }"
    );
  }
  writeFileSync(appBootPath, js);
  console.log('SRI injected into app-boot.js');
} catch (err) {
  console.warn('Warning: could not inject SRI into app-boot.js for JS:', err.message);
}

// ============================================================================
// Build Manifest: commit hash + file hashes for auditing
// ============================================================================

let gitCommit = 'unknown';
let gitBranch = 'unknown';
let gitDirty = false;
try {
  gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  gitBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  gitDirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim().length > 0;
} catch { /* not a git repo or git not available */ }

// Inject commit hash into boot JS files for version display
// (must happen BEFORE manifest generation so hashes are final)
const bootFilesForCommit = [
  resolve(dist, 'app/boot/app-head.js'),
  resolve(dist, 'app/boot/login-head.js')
];
for (const bootPath of bootFilesForCommit) {
  try {
    let js = readFileSync(bootPath, 'utf8');
    js = js.replace(
      /window\.APP_BUILD_AT\s*=/,
      `window.APP_BUILD_COMMIT = '${gitCommit.slice(0, 8)}';\nwindow.APP_BUILD_AT =`
    );
    writeFileSync(bootPath, js);
  } catch { /* optional */ }
}
console.log('Commit hash injected into boot files.');

/** Recursively collect all files in a directory */
function walkDir(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      files.push(...walkDir(full, base));
    } else {
      files.push({
        path: '/' + relative(base, full),
        size: st.size,
        sha256: sha256hex(full)
      });
    }
  }
  return files;
}

// Generate manifest AFTER all HTML modifications are complete
const manifestFiles = walkDir(dist)
  .filter(f => !f.path.endsWith('.map')                // exclude source maps
            && !f.path.endsWith('build-manifest.json')) // exclude self
  .sort((a, b) => a.path.localeCompare(b.path));

const manifest = {
  version: '1.0',
  buildTime: new Date().toISOString(),
  git: {
    commit: gitCommit,
    branch: gitBranch,
    dirty: gitDirty
  },
  sri: bundledSRI,
  files: manifestFiles
};

writeFileSync(resolve(dist, 'build-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\nBuild manifest written (${manifestFiles.length} files, commit ${gitCommit.slice(0, 8)})`);

console.log('Build complete → dist/');
