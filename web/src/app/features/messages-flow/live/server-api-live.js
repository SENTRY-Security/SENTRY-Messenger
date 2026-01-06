// /app/features/messages-flow/live/server-api-live.js
// Server API adapter for live (B-route) flow. Stub only.

export function createLiveServerApi(deps = {}) {
  const adapters = deps?.adapters || null;

  return {
    // TODO: implement using live server API wrappers.
    async listSecureMessages(conversationId, limit, cursor) {
      if (adapters?.listSecureMessages) {
        return adapters.listSecureMessages(conversationId, limit, cursor);
      }
      throw new Error('messages-flow live server api not implemented');
    },

    // TODO: implement using live server API wrappers.
    async getMaxCounter(conversationId, senderDeviceId) {
      if (adapters?.getMaxCounter) {
        return adapters.getMaxCounter(conversationId, senderDeviceId);
      }
      throw new Error('messages-flow live server api not implemented');
    },

    // TODO: implement using live server API wrappers.
    async getMessageByCounter(conversationId, counter, opts = {}) {
      if (adapters?.getMessageByCounter) {
        return adapters.getMessageByCounter(conversationId, counter, opts);
      }
      throw new Error('messages-flow live server api not implemented');
    }
  };
}
