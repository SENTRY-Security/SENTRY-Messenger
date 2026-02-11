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

export function isAutomationEnvironment() {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && (window.Cypress || window.Playwright)) return true;
  try {
    const ua = navigator.userAgent || '';
    if (/Playwright|HeadlessChrome|puppeteer/i.test(ua)) return true;
  } catch { }
  return false;
}
