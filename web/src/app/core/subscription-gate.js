// Centralized subscription gate.
// Single source of truth — replaces hardcoded `return true` in messages-pane and drive-pane.

import { sessionStore } from '../ui/mobile/session-store.js';

export function isSubscriptionActive() {
  const s = sessionStore.subscriptionState;
  return !!(s?.found && !s?.expired);
}

export function requireSubscriptionActive(reason) {
  if (isSubscriptionActive()) return true;
  try {
    document.dispatchEvent(new CustomEvent('subscription:gate', {
      detail: { reason: reason || null }
    }));
  } catch { /* SSR guard */ }
  return false;
}
