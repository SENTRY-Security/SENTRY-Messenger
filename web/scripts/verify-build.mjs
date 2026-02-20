#!/usr/bin/env node
// verify-build.mjs — Auditing script for SENTRY Messenger web builds
//
// Reads dist/build-manifest.json and re-verifies every file hash.
// Also checks CDN SRI hashes against the live endpoints.
//
// Usage:
//   node web/scripts/verify-build.mjs                # verify local build
//   node web/scripts/verify-build.mjs --check-cdn    # also verify CDN hashes
//   node web/scripts/verify-build.mjs --verbose       # show per-file results

import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname, '..');
const distDir = resolve(webDir, 'dist');

const args = process.argv.slice(2);
const checkCdn = args.includes('--check-cdn');
const verbose = args.includes('--verbose');

// ── Colours (disable in CI) ──
const NO_COLOR = process.env.NO_COLOR || !process.stdout.isTTY;
const green = (s) => NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`;
const red = (s) => NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`;
const dim = (s) => NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`;
const bold = (s) => NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`;

// ── Load manifest ──
let manifest;
const manifestPath = resolve(distDir, 'build-manifest.json');
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(red('ERROR: Cannot read dist/build-manifest.json'));
  console.error(dim('  Run `npm run build` first to generate the manifest.'));
  process.exit(1);
}

console.log(bold('SENTRY Messenger — Build Verification'));
console.log('─'.repeat(50));
console.log(`  Build time:  ${manifest.buildTime}`);
console.log(`  Git commit:  ${manifest.git?.commit ?? 'unknown'}`);
console.log(`  Git branch:  ${manifest.git?.branch ?? 'unknown'}`);
console.log(`  Dirty tree:  ${manifest.git?.dirty ? yellow('yes') : green('no')}`);
console.log(`  Total files: ${manifest.files?.length ?? 0}`);
console.log('─'.repeat(50));

// ── 1. Verify local file hashes ──
let pass = 0;
let fail = 0;
let missing = 0;

console.log(bold('\n[1/3] Verifying local file hashes...\n'));

for (const entry of manifest.files) {
  const absPath = resolve(distDir, entry.path.replace(/^\//, ''));
  try {
    statSync(absPath);
  } catch {
    missing++;
    console.log(red(`  MISSING  ${entry.path}`));
    continue;
  }

  const buf = readFileSync(absPath);
  const actual = createHash('sha256').update(buf).digest('hex');

  if (actual === entry.sha256) {
    pass++;
    if (verbose) console.log(green(`  OK       ${entry.path}`));
  } else {
    fail++;
    console.log(red(`  MISMATCH ${entry.path}`));
    console.log(dim(`    expected: ${entry.sha256}`));
    console.log(dim(`    actual:   ${actual}`));
  }
}

console.log(`\n  ${green(`${pass} passed`)}  ${fail ? red(`${fail} failed`) : `${fail} failed`}  ${missing ? yellow(`${missing} missing`) : `${missing} missing`}`);

// ── 2. Verify SRI hashes for bundled files ──
console.log(bold('\n[2/3] Verifying SRI integrity attributes...\n'));

let sriPass = 0;
let sriFail = 0;

for (const [urlPath, expectedSri] of Object.entries(manifest.sri || {})) {
  const absPath = resolve(distDir, urlPath.replace(/^\//, ''));
  try {
    const buf = readFileSync(absPath);
    const hash = createHash('sha384').update(buf).digest('base64');
    const actual = `sha384-${hash}`;
    if (actual === expectedSri) {
      sriPass++;
      if (verbose) console.log(green(`  OK       ${urlPath}`));
    } else {
      sriFail++;
      console.log(red(`  MISMATCH ${urlPath}`));
      console.log(dim(`    expected: ${expectedSri}`));
      console.log(dim(`    actual:   ${actual}`));
    }
  } catch {
    sriFail++;
    console.log(red(`  MISSING  ${urlPath}`));
  }
}

console.log(`\n  ${green(`${sriPass} passed`)}  ${sriFail ? red(`${sriFail} failed`) : `${sriFail} failed`}`);

// ── 3. (Optional) Verify CDN SRI hashes ──
if (checkCdn) {
  console.log(bold('\n[3/3] Verifying CDN resource hashes...\n'));

  // Read cdn-integrity.js to extract the hashes
  let cdnSriMap = {};
  try {
    const cdnSriPath = resolve(distDir, 'shared/utils/cdn-integrity.js');
    const cdnSriSrc = readFileSync(cdnSriPath, 'utf8');
    // Parse the URL → hash pairs from the source
    const re = /'(https:\/\/[^']+)':\s*\n?\s*'(sha384-[A-Za-z0-9+/=]+)'/g;
    let m;
    while ((m = re.exec(cdnSriSrc)) !== null) {
      cdnSriMap[m[1]] = m[2];
    }
  } catch (err) {
    console.log(yellow(`  Could not load cdn-integrity.js: ${err.message}`));
  }

  let cdnPass = 0;
  let cdnFail = 0;

  for (const [url, expectedHash] of Object.entries(cdnSriMap)) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) {
        cdnFail++;
        console.log(red(`  HTTP ${res.status}  ${url}`));
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const hash = createHash('sha384').update(buf).digest('base64');
      const actual = `sha384-${hash}`;
      if (actual === expectedHash) {
        cdnPass++;
        if (verbose) console.log(green(`  OK       ${url}`));
      } else {
        cdnFail++;
        console.log(red(`  MISMATCH ${url}`));
        console.log(dim(`    expected: ${expectedHash}`));
        console.log(dim(`    actual:   ${actual}`));
      }
    } catch (err) {
      cdnFail++;
      console.log(red(`  ERROR    ${url}: ${err.message}`));
    }
  }

  console.log(`\n  ${green(`${cdnPass} passed`)}  ${cdnFail ? red(`${cdnFail} failed`) : `${cdnFail} failed`}`);
  if (cdnFail > 0) fail += cdnFail;
} else {
  console.log(dim('\n[3/3] Skipped CDN verification (use --check-cdn to enable)'));
}

// ── Summary ──
console.log('\n' + '═'.repeat(50));
const totalFail = fail + sriFail + missing;
if (totalFail === 0) {
  console.log(green(bold('  BUILD VERIFIED — all hashes match.')));
} else {
  console.log(red(bold(`  VERIFICATION FAILED — ${totalFail} issue(s) found.`)));
}
console.log('═'.repeat(50) + '\n');

process.exit(totalFail > 0 ? 1 : 0);
