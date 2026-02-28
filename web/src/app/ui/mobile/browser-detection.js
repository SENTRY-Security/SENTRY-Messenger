// Browser/device detection utilities

export function isIosWebKitLikeBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  const maxTouchPoints = Number(navigator.maxTouchPoints) || 0;
  const isTouchMac = platform === 'MacIntel' && maxTouchPoints > 1;
  const uaHintsPlatform = navigator.userAgentData?.platform || '';
  const isiOSUA = /iPad|iPhone|iPod/i.test(ua);
  const isiOSPlatformHint = /iOS/i.test(uaHintsPlatform || '');
  const isStandalone = typeof navigator.standalone === 'boolean' ? navigator.standalone : false;
  return isiOSUA || isTouchMac || isiOSPlatformHint || isStandalone;
}

export function supportsMediaConstraint(key) {
  if (typeof navigator === 'undefined') return false;
  const supported = navigator.mediaDevices?.getSupportedConstraints?.();
  if (!supported || typeof supported !== 'object') return false;
  return Boolean(supported[key]);
}

export function isConstraintUnsatisfiedError(err) {
  if (!err) return false;
  const code = (err.name || err.code || '').toLowerCase();
  return code === 'overconstrainederror' || code === 'constraintnotsatisfiederror';
}

export function getMicrophoneConstraintProfiles() {
  const supportsEchoCancellation = supportsMediaConstraint('echoCancellation');
  const supportsNoiseSuppression = supportsMediaConstraint('noiseSuppression') && !isIosWebKitLikeBrowser();
  const profiles = [];
  if (supportsNoiseSuppression) {
    const advanced = {};
    if (supportsEchoCancellation) advanced.echoCancellation = true;
    advanced.noiseSuppression = true;
    profiles.push({ audio: advanced, video: false });
  }
  if (supportsEchoCancellation) {
    profiles.push({ audio: { echoCancellation: true }, video: false });
  }
  profiles.push({ audio: true, video: false });
  return profiles;
}

/**
 * Audio constraints for real-time calls: echo cancellation, noise
 * suppression, and auto gain control.  Only requests features the
 * browser reports as supported.  All values are non-mandatory so
 * getUserMedia will not throw OverconstrainedError.
 */
export function getCallAudioConstraints() {
  const c = {};
  if (supportsMediaConstraint('echoCancellation')) c.echoCancellation = true;
  if (supportsMediaConstraint('noiseSuppression') && !isIosWebKitLikeBrowser()) c.noiseSuppression = true;
  if (supportsMediaConstraint('autoGainControl')) c.autoGainControl = true;
  return Object.keys(c).length > 0 ? c : true;
}

/**
 * Detect iOS version from user agent string.
 * Returns { isIos: boolean, major: number, minor: number } or { isIos: false } if not iOS.
 */
export function getIosVersion() {
  if (typeof navigator === 'undefined') return { isIos: false, major: 0, minor: 0 };
  const ua = navigator.userAgent || '';
  // iPhone/iPad/iPod: "CPU iPhone OS 17_1 like Mac OS X"
  const match = ua.match(/CPU\s+(?:iPhone\s+)?OS\s+(\d+)[_.](\d+)/i);
  if (match) {
    return { isIos: true, major: parseInt(match[1], 10), minor: parseInt(match[2], 10) };
  }
  // iPad with desktop UA: check platform + touch
  const platform = navigator.platform || '';
  const maxTouchPoints = Number(navigator.maxTouchPoints) || 0;
  if (platform === 'MacIntel' && maxTouchPoints > 1) {
    // iPad pretending to be Mac — try to extract Safari version
    const vMatch = ua.match(/Version\/(\d+)\.(\d+)/);
    if (vMatch) {
      return { isIos: true, major: parseInt(vMatch[1], 10), minor: parseInt(vMatch[2], 10) };
    }
    return { isIos: true, major: 0, minor: 0 };
  }
  return { isIos: false, major: 0, minor: 0 };
}

/**
 * Check if the current iOS version is below the minimum required (17.1).
 * Returns true if the user should be blocked. Returns false for non-iOS or adequate versions.
 */
export function isIosVersionTooOld() {
  const { isIos, major, minor } = getIosVersion();
  if (!isIos) return false;
  if (major === 0) return false; // Unknown version — don't block
  if (major < 17) return true;
  if (major === 17 && minor < 1) return true;
  return false;
}

export function isAutomationEnvironment() {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && (window.Cypress || window.Playwright)) return true;
  try {
    const ua = navigator.userAgent || '';
    if (/Playwright|HeadlessChrome|puppeteer/i.test(ua)) return true;
  } catch { }
  return false;
}
