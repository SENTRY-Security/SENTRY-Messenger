

// core/log.js
// Minimal logging utility for front-end modules (ESM).
// - setLogSink(fn | Element | selectorString)
// - log(any)
// - installGlobalErrorLogging()
//
// The sink can be:
//  1) a function (line: string) => void
//  2) a DOM Element (we append textContent with \n)
//  3) a CSS selector string (resolved once at setLogSink)
//
// If no sink is set, logs fall back to console.log.

let _sink = null;   // function | Element | null
let _sinkIsFn = false;

/**
 * Configure the log sink.
 * @param {Function | Element | string | null} target
 */
export function setLogSink(target) {
  if (!target) {
    _sink = null; _sinkIsFn = false; return;
  }
  if (typeof target === 'function') {
    _sink = target; _sinkIsFn = true; return;
  }
  if (typeof target === 'string') {
    const el = typeof document !== 'undefined' ? document.querySelector(target) : null;
    _sink = el || null; _sinkIsFn = false; return;
  }
  // assume Element
  _sink = target; _sinkIsFn = false;
}

function stringify(x) {
  try {
    if (typeof x === 'string') return x;
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

/**
 * Log a line to sink or console.
 * @param {any} x
 */
export function log(x) {
  const line = stringify(x);
  if (_sinkIsFn && typeof _sink === 'function') {
    try { _sink(line); return; } catch { /* fallthrough */ }
  }
  if (_sink && typeof _sink.textContent === 'string') {
    try {
      const needsNL = _sink.textContent && !_sink.textContent.endsWith('\n');
      _sink.textContent += (needsNL ? '\n' : '') + line;
      return;
    } catch { /* fallthrough */ }
  }
  // fallback
  try { console.log(line); } catch {}
}

/**
 * Install global error logging to the current sink (or console).
 * Safe to call multiple times.
 */
export function installGlobalErrorLogging() {
  if (typeof window === 'undefined') return;
  if (window.__globalLogInstalled) return;
  window.__globalLogInstalled = true;
  window.addEventListener('error', (e) => {
    log({ jsError: String(e?.error?.message || e?.message || e) });
  });
  window.addEventListener('unhandledrejection', (e) => {
    log({ unhandledRejection: String(e?.reason?.message || e?.reason || e) });
  });
}

// optional default install
try { installGlobalErrorLogging(); } catch {}