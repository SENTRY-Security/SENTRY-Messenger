#!/usr/bin/env node
/**
 * Render a .doc file using word-viewer.js and take a screenshot via Playwright.
 * Usage: node test/render-doc-screenshot.mjs [input.doc] [output.png]
 */
import { readFileSync, writeFileSync } from 'fs';
import playwright from 'playwright-core';
const chromium = playwright.chromium;
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const inputFile = process.argv[2] || resolve(__dirname, 'assets/01 身分關係揭露表-a 事前揭露(公職人員或關係人填寫).doc');
const outputFile = process.argv[3] || resolve(__dirname, 'assets/render-output.png');

// Read the .doc file
const docBytes = readFileSync(inputFile);
const base64Doc = docBytes.toString('base64');

// Read the CSS
const cssPath = resolve(__dirname, '../web/src/assets/app-modals.css');
const cssContent = readFileSync(cssPath, 'utf-8');

// Read word-viewer.js source
const viewerPath = resolve(__dirname, '../web/src/app/ui/mobile/viewers/word-viewer.js');
const viewerSource = readFileSync(viewerPath, 'utf-8');

// Build a self-contained HTML page that renders the doc
const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
body { font-family: "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", sans-serif; font-size: 12pt; margin: 20px; background: #fff; color: #000; max-width: 600px; }
.word-viewer { background: #1e293b; }
.word-page { padding: 10px; }
.word-p { margin: 4pt 0; line-height: 1.5; }
.word-empty { min-height: 1em; }
.word-h { margin: 8pt 0 4pt 0; }
.word-link { color: #60a5fa; }
.word-list { position: relative; }
.word-list-bullet { display: inline-block; min-width: 20pt; }
.word-page-break { page-break-before: always; height: 0; }
${cssContent.split('\n').filter(l => l.includes('word-tbl') || l.includes('word-tc') || l.includes('word-tab')).join('\n')}
.word-tbl-wrap { overflow-x: auto; margin: 8pt 0; }
.word-tbl { border-collapse: collapse; width: 100%; font-size: inherit; }
.word-tbl-fixed { table-layout: fixed; width: auto; }
.word-tbl-bordered .word-tc { border: 1px solid #94a3b8; }
.word-tc { padding: 4pt 6pt; vertical-align: top; }
.word-tc .word-p { margin: 0 0 2pt 0; }
.word-tc .word-p:last-child { margin-bottom: 0; }
.word-tc-merged { display: none; }
.word-tab { display: inline-block; min-width: 24pt; }
.word-math { font-style: italic; }
</style>
</head><body>
<div id="output">Loading...</div>
<script>
// Minimal stubs + capture all console output
window.JSZip = null;
const _origLog = console.log, _origInfo = console.info, _origWarn = console.warn;
console.log = (...a) => { _origLog(...a); };
console.info = (...a) => { _origLog('[INFO]', ...a); };
console.warn = (...a) => { _origLog('[WARN]', ...a); };
</script>
<script type="module">
// Stub imports that word-viewer.js needs
const log = () => {};
const escapeHtml = (s) => s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') : '';
const t = (key) => key;

// Inline the word-viewer.js source with import replacements
${viewerSource
  .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"]\s*;?/g, '')
  .replace(/export\s+/g, '')
}

// Parse and render
async function main() {
  try {
    const base64 = ${JSON.stringify(base64Doc)};
    const binary = atob(base64);
    const ab = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(ab);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const result = renderDocBinary(bytes.buffer);
    document.getElementById('output').innerHTML = result.html;
    window.__renderDone = true;
    // Collect console logs for diagnosis
    window.__logs = window.__logs || [];
  } catch (e) {
    document.getElementById('output').textContent = 'ERROR: ' + e.message + '\\n' + e.stack;
    window.__renderDone = true;
  }
}
main();
</script>
</body></html>`;

// Write temp HTML
const tempHtml = resolve(__dirname, 'assets/_render_temp.html');
writeFileSync(tempHtml, html);

// Launch browser and screenshot
const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});
const page = await browser.newPage({ viewport: { width: 420, height: 2000 } });
await page.goto('file://' + tempHtml);
// Capture console logs
page.on('console', msg => console.log('[browser]', msg.text()));
await page.waitForFunction(() => window.__renderDone === true, { timeout: 15000 });
await page.waitForTimeout(300);
// Dump diagnostic info
const diag = await page.evaluate(() => {
  const tables = document.querySelectorAll('table');
  const tblInfo = [];
  tables.forEach((t, i) => {
    const rows = t.querySelectorAll('tr');
    tblInfo.push({ idx: i, rows: rows.length, classes: t.className });
  });
  const html = document.getElementById('output')?.innerHTML || '';
  // Check for table-specific patterns
  const hasBordered = html.includes('word-tbl-bordered');
  const hasFixed = html.includes('word-tbl-fixed');
  const tdCount = (html.match(/<td/g) || []).length;
  const trCount = (html.match(/<tr/g) || []).length;
  const colspanMatches = html.match(/colspan="(\d+)"/g) || [];
  const borderInlineCount = (html.match(/border-/g) || []).length;
  // Extract first table's opening tag
  const tblMatch = html.match(/<table[^>]*>/);
  // Dump first 20 TR rows with their TD count and first cell text
  const allRows = document.querySelectorAll('tr');
  const rowDump = [];
  allRows.forEach((tr, i) => {
    const tds2 = tr.querySelectorAll('td');
    const cells = [];
    tds2.forEach(td => {
      const text = td.textContent.trim().slice(0, 30);
      const cs = td.getAttribute('colspan') || '1';
      const disp = td.style.display;
      cells.push({ text, colspan: cs, hidden: disp === 'none' });
    });
    if (i < 25) rowDump.push({ row: i, cellCount: tds2.length, cells });
  });
  // Dump table 2 cells in detail
  const table2 = tables.length > 1 ? tables[1] : tables[0];
  const t2El = document.querySelectorAll('table')[tables.length > 1 ? 1 : 0];
  const t2Rows = t2El ? t2El.querySelectorAll('tr') : [];
  const t2Dump = [];
  t2Rows.forEach((tr, ri) => {
    const tds3 = tr.querySelectorAll('td');
    const cells2 = [];
    tds3.forEach((td, ci) => {
      cells2.push({
        text: td.textContent.trim().slice(0, 60),
        cs: td.getAttribute('colspan') || '1',
        rs: td.getAttribute('rowspan') || '1',
        w: td.style.width || '',
        hidden: td.style.display === 'none'
      });
    });
    t2Dump.push({ r: ri, cells: cells2 });
  });
  // Collect DOC-TBL debug logs
  const debugLogs = (window.__docTblLogs || []).slice(0, 50);
  return { tableCount: tables.length, t2Dump, debugLogs };
});
console.log('Diagnostic:', JSON.stringify(diag, null, 2));
// Get actual content height
const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
await page.setViewportSize({ width: 420, height: Math.min(bodyHeight + 40, 8000) });
await page.screenshot({ path: outputFile, fullPage: true });
await browser.close();

// Cleanup
import { unlinkSync } from 'fs';
try { unlinkSync(tempHtml); } catch {}

console.log('Screenshot saved to:', outputFile);
