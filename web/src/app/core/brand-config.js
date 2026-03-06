
// core/brand-config.js
// Centralized brand definitions for multi-brand support.
// Frontend only stores brand display config — UID→brand mapping lives in the backend.
// The backend returns a `brand` key in the SDM exchange response.

/**
 * Default brand key used when backend doesn't return a brand or brand is unknown.
 */
export const DEFAULT_BRAND_KEY = 'sentry';

/**
 * Brand definitions keyed by brand identifier (returned by backend).
 *
 * Each brand entry:
 * - name:      Full display name (e.g. header, login page)
 * - shortName: Abbreviated name for compact UI
 * - logo:      Path to logo SVG/PNG (relative to web root)
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
    subtitle: '感應 SENTRY MESSENGER 晶片後輸入密碼即可登入。',
    e2eeLabel: 'END-TO-END ENCRYPTED'
  }
  // Example: add more brands here
  // acme: {
  //   name: 'ACME MESSENGER',
  //   shortName: 'ACME',
  //   logo: '/assets/images/brands/acme/logo.svg',
  //   favicon: '/assets/images/brands/acme/favicon.ico',
  //   subtitle: '感應 ACME 晶片後輸入密碼即可登入。',
  //   e2eeLabel: 'END-TO-END ENCRYPTED'
  // }
});

/**
 * Resolve a brand key to its config. Falls back to default brand.
 * @param {string|null|undefined} key - brand key from backend
 * @returns {Readonly<{name:string, shortName:string, logo:string, favicon:string, subtitle:string, e2eeLabel:string}>}
 */
export function resolveBrand(key) {
  if (key && BRANDS[key]) return BRANDS[key];
  return BRANDS[DEFAULT_BRAND_KEY];
}
