/**
 * MessageKeyVault stores per-message DR keys for replay (incoming + outgoing).
 * Keys are wrapped client-side with the master key; the server only stores opaque blobs.
 */
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';
import { getMkRaw, getAccountDigest } from '../core/store.js';
import { log, logForensicsEvent, logCapped } from '../core/log.js';
import { putMessageKeyVault as apiPutMessageKeyVault, getMessageKeyVault as apiGetMessageKeyVault, deleteMessageKeyVault as apiDeleteMessageKeyVault, getLatestStateVault as apiGetLatestStateVault } from '../api/message-key-vault.js';
import { decryptContactSecretPayload } from '../core/contact-secrets.js';

const WRAP_INFO_TAG = 'message-key/v1';
const WRAP_CONTEXT_VERSION = 1;
const CACHE_MAX = 400;
const VAULT_LOG_LIMIT = 5;
const FORENSICS_PREFIX_LEN = 8;
const FORENSICS_SUFFIX_LEN = 4;

const cache = new Map();
const logCounts = new Map();

function normalizeHeaderCounter(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function emitLogKey(key, payload) {
  const count = logCounts.get(key) || 0;
  if (count >= VAULT_LOG_LIMIT) return;
  logCounts.set(key, count + 1);
  try {
    log({ [key]: payload });
  } catch {
    /* ignore logging errors */
  }
}

function buildLogContext(params = {}) {
  let accountDigest = null;
  try {
    accountDigest = getAccountDigest();
  } catch { }
  return {
    accountDigestSuffix4: accountDigest ? String(accountDigest).slice(-4) : null,
    conversationId: params.conversationId || null,
    messageId: params.messageId || null,
    senderDeviceId: params.senderDeviceId || null,
    targetDeviceId: params.targetDeviceId || null,
    direction: params.direction || null,
    msgType: params.msgType || null,
    headerCounter: normalizeHeaderCounter(params.headerCounter)
  };
}

function normalizeForensicsId(value) {
  if (value === null || typeof value === 'undefined') return null;
  const str = String(value);
  return str.length ? str : null;
}

function sliceForensicsPrefix(value, len = FORENSICS_PREFIX_LEN) {
  const str = normalizeForensicsId(value);
  if (!str) return null;
  return str.slice(0, len);
}

function sliceForensicsSuffix(value, len = FORENSICS_SUFFIX_LEN) {
  const str = normalizeForensicsId(value);
  if (!str) return null;
  return str.slice(-len);
}

function buildVaultForensicsContext(params = {}) {
  let accountDigest = null;
  try {
    accountDigest = getAccountDigest();
  } catch { }
  return {
    accountDigestSuffix4: sliceForensicsSuffix(accountDigest, 4),
    convIdPrefix: sliceForensicsPrefix(params.conversationId),
    messageIdPrefix: sliceForensicsPrefix(params.messageId),
    senderDeviceIdSuffix4: sliceForensicsSuffix(params.senderDeviceId)
  };
}

function emitVaultForensics(key, params = {}, extra = {}) {
  logForensicsEvent(key, {
    ...buildVaultForensicsContext(params),
    ...extra
  }, { conversationId: params?.conversationId ?? null });
}

function emitVaultTrace(kind, params = {}, status = null, errorCode = null) {
  const key = kind === 'put' ? 'vaultPutTrace' : 'vaultGetTrace';
  logCapped(key, {
    conversationId: params?.conversationId ?? null,
    messageId: params?.messageId ?? null,
    status: status ?? null,
    errorCode: errorCode || null
  });
}

function cacheKey({ conversationId, messageId, senderDeviceId }) {
  return `${conversationId || 'unknown'}::${messageId || 'unknown'}::${senderDeviceId || 'unknown'}`;
}

function setCache(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
}

function getCache(key) {
  const val = cache.get(key);
  if (!val) return null;
  // Support legacy string cache (if any remains) and new object cache
  if (typeof val === 'string') return { messageKeyB64: val, drStateSnapshot: null };
  return val; // { messageKeyB64, drStateSnapshot }
}

function buildContext(params) {
  return {
    version: WRAP_CONTEXT_VERSION,
    conversationId: params.conversationId || null,
    messageId: params.messageId || null,
    senderDeviceId: params.senderDeviceId || null,
    targetDeviceId: params.targetDeviceId || null,
    direction: params.direction || null,
    msgType: params.msgType || null,
    headerCounter: normalizeHeaderCounter(params.headerCounter),
    createdAt: Date.now()
  };
}

async function unwrapMessageKey(wrapped, mkRaw) {
  if (!wrapped) return null;
  const payload = await unwrapWithMK_JSON(wrapped, mkRaw);
  const mkB64 = payload?.mk_b64 || payload?.mkB64 || null;
  const context = payload?.context || payload?.wrap_context || null;
  if (!mkB64) return null;
  return { mkB64, context };
}

export class MessageKeyVault {
  static async putMessageKey(params = {}) {
    const mkRaw = Object.prototype.hasOwnProperty.call(params, 'mkRaw')
      ? params.mkRaw
      : getMkRaw();
    const conversationId = params?.conversationId || null;
    const messageId = params?.messageId || null;
    const senderDeviceId = params?.senderDeviceId || null;
    const targetDeviceId = params?.targetDeviceId || null;
    const direction = params?.direction || null;
    const msgType = params?.msgType || null;
    const messageKeyB64 = params?.messageKeyB64 || null;
    const headerCounter = normalizeHeaderCounter(params?.headerCounter);
    const accountDigest = params?.accountDigest || null;
    const drStateSnapshot = params?.drStateSnapshot || null;

    // Reuse preparePayload logic
    const { wrapped, context } = await MessageKeyVault.preparePayload(params);

    const logContext = buildLogContext({
      conversationId,
      messageId,
      senderDeviceId,
      targetDeviceId,
      direction,
      msgType,
      headerCounter
    });
    const forensicsParams = { conversationId, messageId, senderDeviceId };

    emitLogKey('vaultPutAttempt', {
      ...logContext,
      wrapInfoTag: WRAP_INFO_TAG
    });
    emitVaultForensics('VAULT_PUT_ATTEMPT', forensicsParams, {
      status: null,
      errorCode: null
    });

    const { r, data } = await apiPutMessageKeyVault({
      accountDigest,
      conversationId,
      messageId,
      senderDeviceId,
      targetDeviceId,
      direction,
      msgType,
      headerCounter,
      wrapped_mk: wrapped,
      wrap_context: context,
      dr_state: drStateSnapshot
    });

    if (!r?.ok || (data && typeof data === 'object' && data.error)) {
      const errMsg = data?.message || data?.error || 'message key vault put failed';
      const err = new Error(errMsg);
      err.status = r?.status || null;
      emitLogKey('vaultPutResult', {
        ...logContext,
        status: r?.status || null,
        errorCode: data?.error || 'VaultPutFailed'
      });
      emitVaultForensics('VAULT_PUT_RESULT', forensicsParams, {
        status: r?.status || null,
        errorCode: data?.error || 'VaultPutFailed'
      });
      emitVaultTrace('put', { conversationId, messageId }, r?.status || null, data?.error || 'VaultPutFailed');
      throw err;
    }

    emitLogKey('vaultPutResult', {
      ...logContext,
      status: r?.status || 200,
      errorCode: null,
      duplicate: !!data?.duplicate
    });
    emitVaultForensics('VAULT_PUT_RESULT', forensicsParams, {
      status: r?.status || 200,
      errorCode: null
    });
    emitVaultTrace('put', { conversationId, messageId }, r?.status || 200, null);
    setCache(cacheKey({ conversationId, messageId, senderDeviceId }), {
      messageKeyB64,
      drStateSnapshot
    });
    return { ok: true, duplicate: !!data?.duplicate };
  }

  static async preparePayload(params = {}) {
    const mkRaw = Object.prototype.hasOwnProperty.call(params, 'mkRaw')
      ? params.mkRaw
      : getMkRaw();
    const conversationId = params?.conversationId || null;
    const messageId = params?.messageId || null;
    const senderDeviceId = params?.senderDeviceId || null;
    const targetDeviceId = params?.targetDeviceId || null;
    const direction = params?.direction || null;
    const msgType = params?.msgType || null;
    const messageKeyB64 = params?.messageKeyB64 || null;
    const headerCounter = normalizeHeaderCounter(params?.headerCounter);

    const logContext = buildLogContext({
      conversationId,
      messageId,
      senderDeviceId,
      targetDeviceId,
      direction,
      msgType,
      headerCounter
    });
    const forensicsParams = { conversationId, messageId, senderDeviceId };

    if (!mkRaw) {
      emitLogKey('mkHardblockTrace', {
        sourceTag: 'message-key-vault:put',
        reason: 'mk_missing',
        ...logContext
      });
      emitLogKey('vaultPutResult', {
        ...logContext,
        status: null,
        errorCode: 'MKMissing'
      });
      emitVaultForensics('VAULT_PUT_RESULT', forensicsParams, {
        status: null,
        errorCode: 'MKMissing'
      });
      emitVaultTrace('put', { conversationId, messageId }, null, 'MKMissing');
      throw new Error('MKMissing');
    }
    if (!conversationId || !messageId || !senderDeviceId || !targetDeviceId || !direction || !messageKeyB64) {
      emitLogKey('mkHardblockTrace', {
        sourceTag: 'message-key-vault:put',
        reason: 'missing_params',
        ...logContext,
        hasKey: !!messageKeyB64
      });
      emitLogKey('vaultPutResult', {
        ...logContext,
        status: null,
        errorCode: 'MissingParams'
      });
      emitVaultForensics('VAULT_PUT_RESULT', forensicsParams, {
        status: null,
        errorCode: 'MissingParams'
      });
      emitVaultTrace('put', { conversationId, messageId }, null, 'MissingParams');
      throw new Error('MessageKeyVaultMissingParams');
    }
    const context = buildContext({
      conversationId,
      messageId,
      senderDeviceId,
      targetDeviceId,
      direction,
      msgType,
      headerCounter
    });

    const wrapped = await wrapWithMK_JSON({
      mk_b64: messageKeyB64,
      mkB64: messageKeyB64,
      context
    }, mkRaw, WRAP_INFO_TAG);

    return { wrapped, context };
  }

  static async getMessageKey(params = {}) {
    const mkRaw = Object.prototype.hasOwnProperty.call(params, 'mkRaw')
      ? params.mkRaw
      : getMkRaw();
    const conversationId = params?.conversationId || null;
    const messageId = params?.messageId || null;
    const senderDeviceId = params?.senderDeviceId || null;
    // Server-provided wrapped key (from includeKeys in listSecureMessages)
    const serverWrappedMk = params?.serverWrappedMk || null;
    const serverWrapContext = params?.serverWrapContext || null;
    const serverDrStateSnapshot = params?.serverDrStateSnapshot || null;
    const logContext = buildLogContext({ conversationId, messageId, senderDeviceId });
    const forensicsParams = { conversationId, messageId, senderDeviceId };
    if (!mkRaw) {
      emitLogKey('mkHardblockTrace', {
        sourceTag: 'message-key-vault:get',
        reason: 'mk_missing',
        ...logContext
      });
      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: null,
        errorCode: 'MKMissing'
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: null,
        errorCode: 'MKMissing'
      });
      emitVaultTrace('get', { conversationId, messageId }, null, 'MKMissing');
      return { ok: false, error: 'MKMissing' };
    }
    if (!conversationId || !messageId || !senderDeviceId) {
      emitLogKey('mkHardblockTrace', {
        sourceTag: 'message-key-vault:get',
        reason: 'missing_params',
        ...logContext
      });
      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: null,
        errorCode: 'MissingParams'
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: null,
        errorCode: 'MissingParams'
      });
      emitVaultTrace('get', { conversationId, messageId }, null, 'MissingParams');
      return { ok: false, error: 'MissingParams' };
    }
    const cacheK = cacheKey({ conversationId, messageId, senderDeviceId });
    const cached = getCache(cacheK);
    emitLogKey('vaultGetAttempt', {
      ...logContext
    });
    emitVaultForensics('VAULT_GET_ATTEMPT', forensicsParams, {
      status: null,
      errorCode: null
    });
    if (cached) {
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: true,
        status: 200,
        errorCode: null
      });
      emitVaultTrace('get', { conversationId, messageId }, 200, null);
      return {
        ok: true,
        messageKeyB64: cached.messageKeyB64,
        drStateSnapshot: cached.drStateSnapshot || null,
        fromCache: true
      };
    }

    // Priority 1: Use server-provided wrapped key (avoids API call)
    if (serverWrappedMk) {
      try {
        const unwrapped = await unwrapMessageKey(serverWrappedMk, mkRaw);
        if (unwrapped?.mkB64) {
          // Decrypt DR state snapshot if provided
          let drStateSnapshot = null;
          if (serverDrStateSnapshot) {
            try {
              const decryptRes = await decryptContactSecretPayload(serverDrStateSnapshot, mkRaw);
              if (decryptRes.ok && decryptRes.snapshot) {
                drStateSnapshot = JSON.parse(decryptRes.snapshot);
              }
            } catch (err) {
              emitLogKey('vaultDrStateDecryptFail', {
                ...logContext,
                error: err?.message || String(err),
                source: 'server_provided'
              });
            }
          }
          
          setCache(cacheK, {
            messageKeyB64: unwrapped.mkB64,
            drStateSnapshot
          });
          
          emitLogKey('vaultGetResult', {
            ...logContext,
            found: true,
            status: 200,
            errorCode: null,
            source: 'server_provided'
          });
          emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
            found: true,
            status: 200,
            errorCode: null,
            source: 'server_provided'
          });
          emitVaultTrace('get', { conversationId, messageId }, 200, null);
          
          return {
            ok: true,
            messageKeyB64: unwrapped.mkB64,
            context: unwrapped.context || serverWrapContext || null,
            drStateSnapshot,
            fromServerKeys: true
          };
        }
      } catch (err) {
        emitLogKey('vaultUnwrapErrorTrace', {
          ...logContext,
          errorName: err?.name || err?.constructor?.name || 'Error',
          errorMessage: err?.message || 'unwrap failed',
          source: 'server_provided'
        });
        // Fall through to API call
      }
    }

    // Priority 2: Fetch from API
    let res;
    try {
      res = await apiGetMessageKeyVault({ conversationId, messageId, senderDeviceId });
    } catch (err) {
      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: err?.status || null,
        errorCode: 'VaultGetFailed'
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: err?.status || null,
        errorCode: 'VaultGetFailed'
      });
      emitVaultTrace('get', { conversationId, messageId }, err?.status || null, 'VaultGetFailed');
      return { ok: false, error: 'VaultGetFailed', status: err?.status || null, message: err?.message || 'requestFailed' };
    }
    const r = res?.r;
    const data = res?.data;
    if (!r?.ok) {
      const errorCode = data?.error || 'VaultGetFailed';
      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: r?.status || null,
        errorCode
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: r?.status || null,
        errorCode
      });
      emitVaultTrace('get', { conversationId, messageId }, r?.status || null, errorCode);
      return { ok: false, error: errorCode, status: r?.status || null, message: data?.message || data?.error || 'vault get failed' };
    }
    if (data && typeof data === 'object' && data.error) {
      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: r?.status || null,
        errorCode: data?.error || 'VaultGetFailed'
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: r?.status || null,
        errorCode: data?.error || 'VaultGetFailed'
      });
      emitVaultTrace('get', { conversationId, messageId }, r?.status || null, data?.error || 'VaultGetFailed');
      return { ok: false, error: data.error, status: r?.status || null, message: data?.message || data.error };
    }
    const wrapped = data?.wrapped_mk || data?.entry?.wrapped_mk || null;
    if (!wrapped) {
      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: r?.status || 404,
        errorCode: 'NotFound'
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: r?.status || 404,
        errorCode: 'NotFound'
      });
      emitVaultTrace('get', { conversationId, messageId }, r?.status || 404, 'NotFound');
      return { ok: false, error: 'NotFound', status: r?.status || 404, message: 'message key not found' };
    }
    let unwrapped;
    try {
      unwrapped = await unwrapMessageKey(wrapped, mkRaw);
    } catch (err) {
      emitLogKey('vaultUnwrapErrorTrace', {
        ...logContext,
        errorName: err?.name || err?.constructor?.name || 'Error',
        errorMessage: err?.message || 'unwrap failed',
        wrapInfoTag: typeof wrapped?.info === 'string' ? wrapped.info : null
      });

      // Self-Healing: Delete the bad key so we don't keep failing on it.
      try {
        await apiDeleteMessageKeyVault({ conversationId, messageId, senderDeviceId });
        emitLogKey('vaultHealingTrace', {
          ...logContext,
          action: 'delete_bad_key',
          reason: 'unwrap_failed'
        });
        emitVaultForensics('VAULT_HEALING', forensicsParams, { action: 'delete', reason: 'unwrap_failed' });
      } catch (delErr) {
        emitLogKey('vaultHealingTrace', {
          ...logContext,
          action: 'delete_failed',
          error: delErr?.message || String(delErr)
        });
      }

      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: r?.status || null,
        errorCode: 'UnwrapFailed'
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: r?.status || null,
        errorCode: 'UnwrapFailed'
      });
      emitVaultTrace('get', { conversationId, messageId }, r?.status || null, 'UnwrapFailed');
      // Treat as found=false so the app can fallback to other mechanisms
      return { ok: false, error: 'UnwrapFailed', status: r?.status || null, message: err?.message || 'unwrap failed' };
    }
    if (!unwrapped?.mkB64) {
      emitLogKey('vaultGetResult', {
        ...logContext,
        found: false,
        status: r?.status || null,
        errorCode: 'InvalidPayload'
      });
      emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
        found: false,
        status: r?.status || null,
        errorCode: 'InvalidPayload'
      });
      emitVaultTrace('get', { conversationId, messageId }, r?.status || null, 'InvalidPayload');
      return { ok: false, error: 'InvalidPayload', status: r?.status || null, message: 'missing mk' };
    }

    // ATOMIC PIGGYBACK READ
    let drStateSnapshot = null;
    if (data.dr_state) {
      try {
        const decryptRes = await decryptContactSecretPayload(data.dr_state, mkRaw);
        if (decryptRes.ok && decryptRes.snapshot) {
          // Parse the JSON string into an object because callers expect an object/string?
          // Actually `importContactSecretsSnapshot` expects an object. 
          // `decryptContactSecretPayload` returns a string (JSON).
          // Let's parse it here for convenience, or pass string?
          // Contact Secrets `importContactSecretsSnapshot` takes an OBJECT (parsed).
          drStateSnapshot = JSON.parse(decryptRes.snapshot);
        }
      } catch (err) {
        emitLogKey('vaultDrStateDecryptFail', {
          ...logContext,
          error: err?.message || String(err)
        });
      }
    }

    setCache(cacheK, {
      messageKeyB64: unwrapped.mkB64,
      drStateSnapshot
    });

    emitLogKey('vaultGetResult', {
      ...logContext,
      found: true,
      status: r?.status || 200,
      errorCode: null
    });
    emitVaultForensics('VAULT_GET_RESULT', forensicsParams, {
      found: true,
      status: r?.status || 200,
      errorCode: null
    });
    emitVaultTrace('get', { conversationId, messageId }, r?.status || 200, null);

    return {
      ok: true,
      messageKeyB64: unwrapped.mkB64,
      context: unwrapped.context || null,
      drStateSnapshot
    };
  }

  static async deleteMessageKey(params = {}) {
    const conversationId = params?.conversationId || null;
    const messageId = params?.messageId || null;
    const senderDeviceId = params?.senderDeviceId || null;
    if (!conversationId || !messageId || !senderDeviceId) return { ok: false, error: 'MissingParams' };

    try {
      await apiDeleteMessageKeyVault({ conversationId, messageId, senderDeviceId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
  static async getLatestState(params = {}) {
    const conversationId = params?.conversationId || null;
    const senderDeviceId = params?.senderDeviceId || null;
    if (!conversationId) throw new Error('conversationId required');

    let result = null;
    try {
      const { r, data } = await apiGetLatestStateVault({ conversationId, senderDeviceId });
      if (!r.ok) throw new Error(data?.message || r.statusText);
      result = data;
    } catch (err) {
      log({ getLatestStateError: err?.message || err, conversationId });
      throw err;
    }

    // Log success findings
    if (result) {
      log({
        getLatestStateOk: true,
        hasOutgoing: !!result.outgoing,
        hasIncoming: !!result.incoming,
        conversationId
      });
    }
    return result;
  }
}
