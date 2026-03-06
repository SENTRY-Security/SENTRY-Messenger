
// core/brand-apply.js
// Utility to apply brand config to the current page's DOM elements.
// Works on login.html, app.html, and logout.html.

import { resolveBrand } from './brand-config.js';
import { getBrandKey, getBrandName, getBrandLogo } from './store.js';

/**
 * Check if a logo URL is an external (absolute) URL.
 * External logos should NOT have the brightness(0) invert(1) filter applied
 * since they are full-color images, not monochrome SVGs.
 */
function isExternalLogo(url) {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/**
 * Apply brand styling to the current page.
 * Call this after SDM exchange (login page) or on page load (app/logout).
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
  const externalLogo = isExternalLogo(brand.logo);

  // --- Document title ---
  if (document.title) {
    document.title = document.title.replace(/SENTRY MESSENGER/g, brand.name);
  }

  // --- Favicon ---
  const faviconEl = document.querySelector('link[rel="icon"]');
  if (faviconEl && brand.favicon) {
    faviconEl.href = brand.favicon;
  }

  // --- Logo images: any img whose src includes the default logo path ---
  const logoSelectors = [
    '.splash-logo',
    '.tm-logo',
    '.brand img',
    '.loading-logo',
    '.logout-logo',
    '#appLoadingModal .loading-logo'
  ];
  for (const sel of logoSelectors) {
    const el = document.querySelector(sel);
    if (el && el.tagName === 'IMG') {
      el.src = brand.logo;
      if (el.alt) el.alt = brand.name;
      // Remove monochrome filter for external (colored) logos
      if (externalLogo) {
        el.style.filter = 'none';
      }
    }
  }

  // --- Brand text elements ---
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

  // --- aria-label on tmBrand (login transition) ---
  const tmBrand = document.getElementById('tmBrand');
  if (tmBrand) {
    tmBrand.setAttribute('aria-label', brand.name);
  }

  // --- Subtitle on login page ---
  const subtitle = document.querySelector('.subtitle');
  if (subtitle && brand.subtitle) {
    subtitle.textContent = brand.subtitle;
  }

  // --- E2EE sublabel ---
  const e2eeSelectors = ['.tm-sublabel', '.loading-sublabel', '.logout-sublabel'];
  for (const sel of e2eeSelectors) {
    const el = document.querySelector(sel);
    if (el && brand.e2eeLabel) el.textContent = brand.e2eeLabel;
  }

  // --- Notice text (login page privacy notice) ---
  const noticeText = document.querySelector('.notice-text');
  if (noticeText) {
    noticeText.textContent = noticeText.textContent.replace(/SENTRY MESSENGER/g, brand.name);
  }

  // --- Store brand info on window for inline scripts (scramble animation etc.) ---
  try {
    window.__BRAND_NAME = brand.name;
    window.__BRAND_LOGO = brand.logo;
    window.__BRAND_LOGO_EXTERNAL = externalLogo;
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
