// /app/features/messages-flow/server-api.js
// Server API adapter for messages-flow. Stub only in this phase.

export function createMessageServerApi(deps = {}) {
  void deps;
  return {
    // TODO: implement using existing API wrappers.
    async getSecureMaxCounter(conversationId) {
      void conversationId;
      throw new Error('messages-flow server api not implemented');
    },

    // TODO: implement using existing API wrappers.
    async listSecure(conversationId, { limit, cursor } = {}) {
      void conversationId;
      void limit;
      void cursor;
      throw new Error('messages-flow server api not implemented');
    },

    // TODO: implement using existing API wrappers.
    async getSecureByCounter(conversationId, counter) {
      void conversationId;
      void counter;
      throw new Error('messages-flow server api not implemented');
    },

    // TODO: implement using existing API wrappers.
    async getSecureByMessageId(conversationId, messageId) {
      void conversationId;
      void messageId;
      throw new Error('messages-flow server api not implemented');
    }
  };
}
