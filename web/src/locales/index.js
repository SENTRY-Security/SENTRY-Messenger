// i18n core module — lightweight runtime translation
// Supports nested keys, parameter interpolation, and key-level fallback to English.

let currentLang = 'en';
let messages = {};
let fallbackMessages = {};

/**
 * Resolve a dot-separated key from a nested object.
 * @param {object} obj
 * @param {string} path  e.g. 'messages.sendFailed'
 * @returns {string|undefined}
 */
function resolve(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

/**
 * Detect the preferred language from browser settings only.
 * Language preference is stored in encrypted user settings (loaded after login),
 * NOT in localStorage, to prevent nationality metadata leakage before login.
 */
function detectLang() {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en';
}

/**
 * Normalise a BCP-47 tag to one of the supported locale file names.
 * e.g. 'zh-TW' → 'zh-Hant', 'zh-Hant-TW' → 'zh-Hant', 'en-US' → 'en', 'ja' → 'ja'
 */
const SUPPORTED_LOCALE_SET = new Set(['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'th', 'vi', 'es', 'pt']);

function normaliseTag(tag) {
  const t = String(tag).toLowerCase();
  // Traditional Chinese variants
  if (t === 'zh-hant' || t === 'zh-tw' || t === 'zh-hk' || t === 'zh-mo'
      || t.startsWith('zh-hant')) return 'zh-Hant';
  // Simplified Chinese variants
  if (t === 'zh-hans' || t === 'zh-cn' || t === 'zh-sg'
      || t.startsWith('zh-hans') || t === 'zh') return 'zh-Hans';
  // Strip region for other languages (en-US → en, ja-JP → ja, ko-KR → ko, etc.)
  const base = t.split('-')[0];
  // Return base if it's a supported locale, otherwise fall back to 'en'
  return SUPPORTED_LOCALE_SET.has(base) ? base : 'en';
}

/**
 * Fetch and parse a JSON locale file. Returns {} on failure.
 */
async function loadJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return {};
    return await res.json();
  } catch {
    return {};
  }
}

/**
 * Initialise i18n — load language packs.
 * Always loads English as fallback, then attempts the target locale.
 * @param {string} [lang] BCP-47 tag; auto-detected if omitted.
 */
export async function initI18n(lang) {
  const raw = lang || detectLang();
  const locale = normaliseTag(raw);

  // Always load English as ultimate fallback
  fallbackMessages = await loadJSON('/locales/en.json');

  if (locale !== 'en') {
    const loaded = await loadJSON(`/locales/${locale}.json`);
    if (Object.keys(loaded).length) {
      messages = loaded;
    } else {
      // Unsupported locale — stay with English
      console.warn(`[i18n] Locale "${locale}" not found, falling back to English`);
      messages = {};
    }
  } else {
    messages = {};
  }

  currentLang = locale;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
  }
}

/**
 * Translate a key with optional parameter interpolation.
 * Falls back: messages[key] → fallbackMessages[key] → raw key.
 *
 * @param {string} key   Dot-separated key, e.g. 'common.loading'
 * @param {object} [params]  Interpolation values, e.g. { count: 3 }
 * @returns {string}
 */
export function t(key, params) {
  let val = resolve(messages, key) ?? resolve(fallbackMessages, key);
  // Fall back to inline bootstrap translator (synchronous XHR loaded in HTML)
  // when async fetch hasn't completed yet
  if (val == null && typeof window !== 'undefined' && typeof window.__t === 'function') {
    val = window.__t(key, params);
    if (val !== key) return val;  // __t already handled interpolation
  }
  if (val == null) val = key;
  if (!params || typeof val !== 'string') return val;
  return val.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
}

/**
 * Get the current active locale.
 * @returns {string}
 */
export function getCurrentLang() {
  return currentLang;
}

/**
 * Switch language at runtime. Reloads locale data and applies DOM translations.
 * Does NOT persist to localStorage — language is stored in encrypted user settings only.
 * @param {string} lang  BCP-47 tag
 */
export async function setLang(lang) {
  await initI18n(lang);
  applyDOMTranslations();
}

/**
 * Scan the DOM for data-i18n* attributes and apply translations.
 * Supports: data-i18n (textContent), data-i18n-placeholder, data-i18n-aria-label,
 *           data-i18n-title, data-i18n-alt
 */
export function applyDOMTranslations() {
  if (typeof document === 'undefined') return;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) el.placeholder = t(key);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-aria-label');
    if (key) el.setAttribute('aria-label', t(key));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) el.title = t(key);
  });
  document.querySelectorAll('[data-i18n-alt]').forEach(el => {
    const key = el.getAttribute('data-i18n-alt');
    if (key) el.alt = t(key);
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    if (key) el.innerHTML = t(key);
  });
}
