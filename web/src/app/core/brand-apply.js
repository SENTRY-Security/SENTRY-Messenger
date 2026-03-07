
// core/brand-apply.js
// Utility to apply brand config to the current page's DOM elements.
// Works on login.html, app.html, and logout.html.
//
// Brand names in text are wrapped in <span data-brand-name> elements
// so they can be targeted individually (important for future i18n).
//
// Logo rendering uses logo-mono.js: SVG logos are fetched and rewritten
// to monochrome white for dark backgrounds; non-SVG logos are shown as-is.

import { resolveBrand } from './brand-config.js';
import { getBrandKey, getBrandName, getBrandLogo } from './store.js';
import { applyMonoLogo, applyMonoLogoSync, looksLikeSvg } from './logo-mono.js';

/**
 * Logo selectors across all pages.
 * CSS stylesheets handle brightness(0) invert(1) and @keyframes glow;
 * applyMonoLogo adds .mono-done / .color-logo classes to switch animations.
 */
const LOGO_SELECTORS = [
  // login.html
  '.splash-logo',
  '.tm-logo',
  '.brand img',
  // app.html
  'img.brand',               // topbar logo (img WITH class, not img INSIDE .brand)
  '.loading-logo',
  '#appLoadingModal .loading-logo',
  // logout.html
  '.logout-logo',
  // video viewer
  '.vv-buffering-logo',
  '.vv-seekbar-thumb-logo'
];

/**
 * Apply brand styling to the current page.
 * Call this after SDM exchange (login page) or on page load (app/logout).
 *
 * Logo handling:
 *   - SVG logos are fetched, parsed, and rewritten to monochrome white.
 *   - Non-SVG logos (PNG/JPG) are shown in original colors.
 *   - On fetch failure, falls back to CSS brightness(0) invert(1).
 *
 * @param {string|null} [brandKey] - brand key; defaults to store value
 */
export function applyBrand(brandKey) {
  const key = brandKey || getBrandKey() || null;
  const overrides = {
    brandName: getBrandName() || null,
    brandLogo: getBrandLogo() || null
  };
  const brand = resolveBrand(key, overrides);

  // --- Document title ---
  if (document.title) {
    document.title = document.title.replace(/SENTRY MESSENGER/g, brand.name);
  }

  // --- Favicon ---
  const faviconEl = document.querySelector('link[rel="icon"]');
  if (faviconEl && brand.favicon) {
    faviconEl.href = brand.favicon;
  }

  // --- Logo images ---
  for (const sel of LOGO_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'IMG') continue;
    if (el.alt) el.alt = brand.name;

    // Synchronous: set src, add .color-logo if non-SVG (CSS handles brightness/invert)
    applyMonoLogoSync(el, brand.logo);
    // Async: fetch SVG → rewrite to white → replace src with data URI → add .mono-done
    applyMonoLogo(el, brand.logo);
  }

  // --- Brand text elements (elements whose entire content is the brand name) ---
  const brandTextSelectors = [
    '.splash-brand',
    '.brand h1',
    '.loading-brand',
    '.logout-brand',
    '#appLoadingModal .loading-brand'
  ];
  for (const sel of brandTextSelectors) {
    const el = document.querySelector(sel);
    if (el) el.textContent = brand.name;
  }

  // --- All [data-brand-name] spans (brand name embedded in sentences) ---
  const brandNameSpans = document.querySelectorAll('[data-brand-name]');
  for (const span of brandNameSpans) {
    span.textContent = brand.name;
  }

  // --- aria-label on tmBrand (login transition) ---
  const tmBrand = document.getElementById('tmBrand');
  if (tmBrand) {
    tmBrand.setAttribute('aria-label', brand.name);
  }

  // --- E2EE sublabel ---
  const e2eeSelectors = ['.tm-sublabel', '.loading-sublabel', '.logout-sublabel'];
  for (const sel of e2eeSelectors) {
    const el = document.querySelector(sel);
    if (el && brand.e2eeLabel) el.textContent = brand.e2eeLabel;
  }

  // --- Store brand info on window for inline scripts (scramble animation etc.) ---
  try {
    window.__BRAND_NAME = brand.name;
    window.__BRAND_LOGO = brand.logo;
    window.__BRAND_LOGO_EXTERNAL = !looksLikeSvg(brand.logo);
  } catch { /* ignore */ }
}

/**
 * Get current brand config (resolved from store).
 */
export function getCurrentBrand() {
  return resolveBrand(getBrandKey(), {
    brandName: getBrandName() || null,
    brandLogo: getBrandLogo() || null
  });
}
