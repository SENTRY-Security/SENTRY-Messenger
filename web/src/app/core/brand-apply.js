
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

// Drop-shadow presets matching the CSS keyframe animations on each page.
// Logos that use pulsing glow animations define the shadow in CSS @keyframes,
// so we only need to supply the shadow for the initial static render here.
const GLOW_SHADOW = 'drop-shadow(0 0 18px rgba(56,189,248,0.45)) drop-shadow(0 0 40px rgba(99,102,241,0.25))';

/**
 * Logo selectors and their drop-shadow configuration.
 * `glow: true` means the element has a pulsing glow animation — apply
 * the GLOW_SHADOW on initial render (CSS animation will take over).
 */
const LOGO_SELECTORS = [
  // login.html
  { sel: '.splash-logo',                  glow: false },
  { sel: '.tm-logo',                      glow: true  },
  { sel: '.brand img',                    glow: false },
  // app.html
  { sel: 'img.brand',                     glow: false },  // topbar logo (img WITH class, not img INSIDE .brand)
  { sel: '.loading-logo',                 glow: true  },
  { sel: '#appLoadingModal .loading-logo', glow: true  },
  // logout.html
  { sel: '.logout-logo',                  glow: true  },
  // video viewer
  { sel: '.vv-buffering-logo',            glow: false },
  { sel: '.vv-seekbar-thumb-logo',        glow: false }
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
  for (const { sel, glow } of LOGO_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el || el.tagName !== 'IMG') continue;
    if (el.alt) el.alt = brand.name;

    const shadow = glow ? GLOW_SHADOW : '';
    // Synchronous: set src + CSS filter immediately (no flash of unstyled logo)
    applyMonoLogoSync(el, brand.logo, { dropShadow: shadow });
    // Async: fetch SVG → rewrite to white → replace src with data URI
    applyMonoLogo(el, brand.logo, { dropShadow: shadow });
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
