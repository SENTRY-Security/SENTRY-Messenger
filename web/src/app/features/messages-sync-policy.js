// Policy for offline decrypt catch-up and incoming vaultPut retry queue.
// Keep these values small to avoid excessive network/decrypt work or replay delays.

export const OFFLINE_CATCHUP_CONVERSATION_LIMIT = 5;
export const OFFLINE_CATCHUP_MESSAGE_LIMIT = 50;
export const PENDING_VAULT_PUT_QUEUE_LIMIT = 500;
export const PENDING_VAULT_PUT_RETRY_MAX = 3;
export const PENDING_VAULT_PUT_RETRY_INTERVAL_MS = 2000;
export const OFFLINE_SYNC_LOG_CAP = 5;
