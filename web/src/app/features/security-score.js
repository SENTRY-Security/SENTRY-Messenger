// Security score engine — evaluates device security posture
// Scoring dimensions: OS type, OS version, browser version, HTTPS, VPN

import { t } from '/locales/index.js';

// Weight allocation (total = 100)
const WEIGHTS = {
  osType: 25,
  osVersion: 25,
  browserVersion: 20,
  https: 15,
  vpn: 15
};

/**
 * Parse OS info from user agent string.
 * @returns {{ os: string, version: string, major: number }}
 */
export function parseOSInfo() {
  if (typeof navigator === 'undefined') return { os: 'unknown', version: '', major: 0 };
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouchPoints = Number(navigator.maxTouchPoints) || 0;

  // iOS detection
  const iosMatch = ua.match(/CPU\s+(?:iPhone\s+)?OS\s+(\d+)[_.](\d+)/i);
  if (iosMatch) {
    return { os: 'ios', version: `${iosMatch[1]}.${iosMatch[2]}`, major: parseInt(iosMatch[1], 10) };
  }
  // iPad pretending to be Mac
  if (platform === 'MacIntel' && maxTouchPoints > 1) {
    const vMatch = ua.match(/Version\/(\d+)\.(\d+)/);
    if (vMatch) return { os: 'ios', version: `${vMatch[1]}.${vMatch[2]}`, major: parseInt(vMatch[1], 10) };
    return { os: 'ios', version: '', major: 0 };
  }

  // Android
  const androidMatch = ua.match(/Android\s+(\d+)(?:\.(\d+))?/i);
  if (androidMatch) {
    const ver = androidMatch[2] ? `${androidMatch[1]}.${androidMatch[2]}` : androidMatch[1];
    return { os: 'android', version: ver, major: parseInt(androidMatch[1], 10) };
  }

  // macOS
  const macMatch = ua.match(/Mac OS X\s+(\d+)[_.](\d+)/i);
  if (macMatch) {
    return { os: 'macos', version: `${macMatch[1]}.${macMatch[2]}`, major: parseInt(macMatch[1], 10) };
  }

  // Windows
  const winMatch = ua.match(/Windows NT\s+(\d+\.\d+)/i);
  if (winMatch) {
    const ntVer = parseFloat(winMatch[1]);
    const winVer = ntVer >= 10.0 ? '10+' : ntVer >= 6.3 ? '8.1' : ntVer >= 6.1 ? '7' : 'old';
    return { os: 'windows', version: winVer, major: ntVer };
  }

  // Linux / ChromeOS
  if (/CrOS/i.test(ua)) return { os: 'chromeos', version: '', major: 0 };
  if (/Linux/i.test(ua)) return { os: 'linux', version: '', major: 0 };

  return { os: 'unknown', version: '', major: 0 };
}

/**
 * Parse browser name and version from user agent.
 * @returns {{ browser: string, version: string, major: number }}
 */
export function parseBrowserInfo() {
  if (typeof navigator === 'undefined') return { browser: 'unknown', version: '', major: 0 };
  const ua = navigator.userAgent || '';

  // Order matters — check specific browsers before generic ones
  const patterns = [
    { name: 'firefox', re: /Firefox\/(\d+)(?:\.(\d+))?/i },
    { name: 'edge', re: /Edg\/(\d+)(?:\.(\d+))?/i },
    { name: 'chrome', re: /Chrome\/(\d+)(?:\.(\d+))?/i },
    { name: 'safari', re: /Version\/(\d+)(?:\.(\d+))?.*Safari/i },
    { name: 'opera', re: /OPR\/(\d+)(?:\.(\d+))?/i }
  ];

  for (const { name, re } of patterns) {
    const m = ua.match(re);
    if (m) {
      const major = parseInt(m[1], 10);
      const minor = m[2] ? parseInt(m[2], 10) : 0;
      return { browser: name, version: `${major}.${minor}`, major };
    }
  }

  return { browser: 'unknown', version: '', major: 0 };
}

// Minimum "current" versions (approximate — updated periodically)
const LATEST_VERSIONS = {
  ios: 18,
  android: 15,
  macos: 15,
  windows: 10.0,
  chrome: 130,
  safari: 18,
  firefox: 130,
  edge: 130,
  opera: 114
};

/**
 * Score OS type (iOS is highest, then macOS, then others).
 * @param {string} os
 * @returns {number} 0–1
 */
function scoreOsType(os) {
  const scores = { ios: 1.0, macos: 0.85, chromeos: 0.65, windows: 0.55, android: 0.5, linux: 0.6, unknown: 0.3 };
  return scores[os] ?? 0.3;
}

/**
 * Score OS version freshness.
 * @param {string} os
 * @param {number} major
 * @returns {number} 0–1
 */
function scoreOsVersion(os, major) {
  if (!major) return 0.4; // unknown version
  const latest = LATEST_VERSIONS[os];
  if (!latest) return 0.5;
  const diff = latest - major;
  if (diff <= 0) return 1.0;
  if (diff === 1) return 0.8;
  if (diff === 2) return 0.6;
  if (diff === 3) return 0.4;
  return 0.2;
}

/**
 * Score browser version freshness.
 * @param {string} browser
 * @param {number} major
 * @returns {number} 0–1
 */
function scoreBrowserVersion(browser, major) {
  if (!major) return 0.4;
  const latest = LATEST_VERSIONS[browser];
  if (!latest) return 0.5;
  const diff = latest - major;
  if (diff <= 0) return 1.0;
  if (diff <= 2) return 0.85;
  if (diff <= 5) return 0.65;
  if (diff <= 10) return 0.45;
  return 0.2;
}

/**
 * Score HTTPS usage.
 * @returns {number} 0 or 1
 */
function scoreHttps() {
  if (typeof location === 'undefined') return 1;
  return location.protocol === 'https:' ? 1.0 : 0.0;
}

/**
 * Compute overall security assessment.
 * @param {{ vpn: boolean|null }} options
 * @returns {{ score: number, grade: string, details: Array<{key: string, label: string, value: string, score: number, suggestion: string|null}> }}
 */
export function computeSecurityScore({ vpn = null } = {}) {
  const osInfo = parseOSInfo();
  const browserInfo = parseBrowserInfo();
  const isHttps = scoreHttps();
  const vpnScore = vpn === true ? 1.0 : vpn === false ? 0.0 : 0.5; // null = unknown/checking

  const dimensions = {
    osType: scoreOsType(osInfo.os),
    osVersion: scoreOsVersion(osInfo.os, osInfo.major),
    browserVersion: scoreBrowserVersion(browserInfo.browser, browserInfo.major),
    https: isHttps,
    vpn: vpnScore
  };

  // Weighted total
  let total = 0;
  let maxTotal = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    total += dimensions[key] * weight;
    maxTotal += weight;
  }
  const score = Math.round((total / maxTotal) * 100);

  // Grade
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';

  // Build details with suggestions
  const osLabel = formatOsName(osInfo.os);
  const details = [
    {
      key: 'osType',
      icon: 'smartphone',
      label: t('security.osType'),
      value: osLabel,
      score: dimensions.osType,
      suggestion: osInfo.os !== 'ios' ? t('security.suggestIos') : null
    },
    {
      key: 'osVersion',
      icon: 'arrow-up-circle',
      label: t('security.osVersion'),
      value: osInfo.version || t('common.unknown'),
      score: dimensions.osVersion,
      suggestion: dimensions.osVersion < 0.8 ? t('security.suggestUpdateOs') : null
    },
    {
      key: 'browserVersion',
      icon: 'globe',
      label: t('security.browserVersion'),
      value: `${capitalize(browserInfo.browser)} ${browserInfo.version}`,
      score: dimensions.browserVersion,
      suggestion: dimensions.browserVersion < 0.8 ? t('security.suggestUpdateBrowser') : null
    },
    {
      key: 'https',
      icon: 'lock',
      label: t('security.https'),
      value: isHttps ? t('security.httpsOn') : t('security.httpsOff'),
      score: dimensions.https,
      suggestion: !isHttps ? t('security.suggestHttps') : null
    },
    {
      key: 'vpn',
      icon: 'shield',
      label: t('security.vpn'),
      value: vpn === true ? t('security.vpnOn') : vpn === false ? t('security.vpnOff') : t('security.vpnChecking'),
      score: dimensions.vpn,
      suggestion: vpn === false ? t('security.suggestVpn') : null
    }
  ];

  return { score, grade, details, osInfo, browserInfo };
}

function formatOsName(os) {
  const names = { ios: 'iOS', android: 'Android', macos: 'macOS', windows: 'Windows', chromeos: 'ChromeOS', linux: 'Linux' };
  return names[os] || t('common.unknown');
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
