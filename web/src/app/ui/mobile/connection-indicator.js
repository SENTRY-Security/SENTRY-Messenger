// Connection status indicator (online/connecting/offline)
import { t } from '/locales/index.js';

export function createConnectionIndicator(element) {
  let lastState = 'offline';

  function update(state) {
    if (!element) return;
    if (state != null) lastState = state;
    element.classList.remove('online', 'connecting', 'degraded');
    if (lastState === 'online') {
      element.classList.add('online');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.online')}`;
      return;
    }
    if (lastState === 'degraded') {
      element.classList.add('degraded');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.unstableNetwork')}`;
      return;
    }
    if (lastState === 'connecting') {
      element.classList.add('connecting');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.connecting')}`;
      return;
    }
    element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.offline')}`;
  }

  /** Re-render with the current state (e.g. after a language switch). */
  function refresh() { update(); }

  return { update, refresh };
}
