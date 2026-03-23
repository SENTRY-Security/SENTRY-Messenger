
// core/brand-config.js
// Centralized brand definitions for multi-brand support.
// Frontend only stores brand display config — UID→brand mapping lives in the backend.
// The backend returns `brand`, `brand_name`, `brand_logo` in the SDM exchange response.
import { t } from '/locales/index.js';

/**
 * Default brand key used when backend doesn't return a brand or brand is unknown.
 */
export const DEFAULT_BRAND_KEY = 'sentry';

/**
 * Built-in brand definitions keyed by brand identifier (returned by backend).
 *
 * Each brand entry:
 * - name:      Full display name (e.g. header, login page)
 * - shortName: Abbreviated name for compact UI
 * - logo:      Path to logo SVG/PNG (relative to web root, or absolute URL)
 * - favicon:   Path to favicon (relative to web root)
 * - subtitle:  Login page subtitle text
 * - e2eeLabel: E2EE badge text shown on transition screens
 */
export const BRANDS = Object.freeze({
  sentry: {
    name: 'SENTRY MESSENGER',
    shortName: 'SENTRY',
    logo: '/assets/images/logo.svg',
    favicon: '/assets/favicon.ico',
    get subtitle() { return t('auth.tapChipAndEnterPassword'); },
    e2eeLabel: 'END-TO-END ENCRYPTED'
  }
  // Additional brands can be defined here. However, brands with external logos
  // are typically configured via the admin API (set-brand) and resolved dynamically
  // using brand_name / brand_logo from the backend response.
});

/**
 * Resolve a brand key to its config, with optional dynamic overrides.
 *
 * Dynamic overrides (brandName, brandLogo) come from the backend via the
 * SDM exchange response and are stored in sessionStorage. These take
 * precedence over built-in BRANDS entries, allowing the admin system to
 * define brands with external logo URLs without frontend code changes.
 *
 * @param {string|null|undefined} key - brand key from backend
 * @param {{ brandName?: string|null, brandLogo?: string|null }} [overrides] - dynamic overrides from store
 * @returns {Readonly<{name:string, shortName:string, logo:string, favicon:string, subtitle:string, e2eeLabel:string}>}
 */
export function resolveBrand(key, overrides) {
  const base = (key && BRANDS[key]) ? { ...BRANDS[key] } : { ...BRANDS[DEFAULT_BRAND_KEY] };

  // Apply dynamic overrides from backend
  if (overrides?.brandName) {
    base.name = overrides.brandName;
    // Derive shortName from first word of name
    base.shortName = overrides.brandName.split(/\s+/)[0] || base.shortName;
    // Note: brand names in text are wrapped in <span data-brand-name> elements,
    // so subtitle text does not need string replacement here.
  }
  if (overrides?.brandLogo) {
    base.logo = overrides.brandLogo;
  }

  return base;
}
