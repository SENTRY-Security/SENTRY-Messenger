// Connection status indicator (online/connecting/offline)
import { t } from '/locales/index.js';

export function createConnectionIndicator(element) {
  function update(state) {
    if (!element) return;
    element.classList.remove('online', 'connecting', 'degraded');
    if (state === 'online') {
      element.classList.add('online');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.online')}`;
      return;
    }
    if (state === 'degraded') {
      element.classList.add('degraded');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.unstableNetwork')}`;
      return;
    }
    if (state === 'connecting') {
      element.classList.add('connecting');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.connecting')}`;
      return;
    }
    element.innerHTML = `<span class="dot" aria-hidden="true"></span>${t('status.offline')}`;
  }
  return { update };
}
