// UI policy for history placeholders and reveal animations.
// Keep shimmer count low to avoid iOS WebKit jank during initial loads.
export const PLACEHOLDER_SHIMMER_MAX_ACTIVE = 30;
// Short reveal keeps swaps subtle without drawing attention.
export const PLACEHOLDER_REVEAL_MS = 120;
// Placeholder copy while decrypting history.
export const PLACEHOLDER_TEXT = '解密中…';
