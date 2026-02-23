// Connection status indicator (online/connecting/offline)

export function createConnectionIndicator(element) {
  function update(state) {
    if (!element) return;
    element.classList.remove('online', 'connecting', 'degraded');
    if (state === 'online') {
      element.classList.add('online');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>在線`;
      return;
    }
    if (state === 'degraded') {
      element.classList.add('degraded');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>網路不穩`;
      return;
    }
    if (state === 'connecting') {
      element.classList.add('connecting');
      element.innerHTML = `<span class="dot" aria-hidden="true"></span>連線中…`;
      return;
    }
    element.innerHTML = `<span class="dot" aria-hidden="true"></span>離線`;
  }
  return { update };
}
