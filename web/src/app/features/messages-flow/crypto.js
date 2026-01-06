// /app/features/messages-flow/crypto.js
// Crypto adapter for DR operations. Stub only in this phase.

export function createMessageCryptoAdapter(deps = {}) {
  void deps;
  return {
    // TODO: ensure DR state is ready for the conversation.
    ensureDrReady() {
      throw new Error('messages-flow crypto adapter not implemented');
    },

    // TODO: decrypt and advance DR state.
    decryptAndAdvance() {
      throw new Error('messages-flow crypto adapter not implemented');
    },

    // TODO: derive skipped keys for gap handling.
    deriveSkippedKeys() {
      throw new Error('messages-flow crypto adapter not implemented');
    }
  };
}
