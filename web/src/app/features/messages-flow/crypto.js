// Crypto adapter for replay-only decrypt. Stub only in this phase.

export function createMessageCryptoAdapter(deps = {}) {
  void deps;
  return {
    // TODO: decrypt AES-GCM payloads for replay/scroll fetch.
    decryptReplayCiphertext() {
      throw new Error('messages-flow crypto adapter not implemented');
    }
  };
}
