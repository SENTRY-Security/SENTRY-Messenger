/**
 * Receiver checkpoints persist DR receiver state (wrapped with MK) per conversation/device for lossless replay.
 */
import { wrapWithMK_JSON, unwrapWithMK_JSON } from '../crypto/aead.js';
import { b64, b64u8 } from '../crypto/nacl.js';
import { getMkRaw, getAccountDigest, getDeviceId } from '../core/store.js';
import { log } from '../core/log.js';
import { DEBUG } from '../ui/mobile/debug-flags.js';
import {
  putReceiverCheckpoint as apiPutReceiverCheckpoint,
  getLatestReceiverCheckpoint as apiGetLatestReceiverCheckpoint
} from '../api/receiver-checkpoints.js';

const WRAP_INFO_TAG = 'receiver-checkpoint/v1';
const RETENTION_PER_DEVICE = 128;
const SKIPPED_PER_CHAIN_LIMIT = 128;
const SKIPPED_TOTAL_LIMIT = 256;
const LOG_LIMIT = 5;
const encoder = new TextEncoder();

let recordLogCount = 0;
let loadLogCount = 0;
let putAttemptLogCount = 0;
let putResultLogCount = 0;
let getAttemptLogCount = 0;
let getResultLogCount = 0;
let replayLoadedLogCount = 0;
let theirPubLogCount = 0;

function logMkMissingHardblock({ sourceTag, reason, conversationId = null, peerDeviceId = null } = {}) {
  try {
    const digest = getAccountDigest();
    const deviceId = getDeviceId();
    log({
      mkHardblockTrace: {
        sourceTag,
        reason,
        serverHasMK: null,
        mkHash12: null,
        accountDigestSuffix4: digest ? String(digest).slice(-4) : null,
        deviceIdSuffix4: deviceId ? String(deviceId).slice(-4) : null,
        conversationId: conversationId || null,
        peerDeviceIdSuffix4: peerDeviceId ? String(peerDeviceId).slice(-4) : null,
        evidence: null
      }
    });
  } catch {
    /* logging best-effort */
  }
}

async function logMkUnwrapHardblock({ sourceTag, errorMessage, mkRaw, conversationId = null, peerDeviceId = null } = {}) {
  try {
    const digest = getAccountDigest();
    const deviceId = getDeviceId();
    const mkHash = await hashBytesHex(mkRaw || null);
    log({
      mkUnwrapHardblockTrace: {
        sourceTag,
        reason: 'checkpoint_unwrap_failed',
        serverHasMK: null,
        mkHash12: mkHash ? mkHash.slice(0, 12) : null,
        accountDigestSuffix4: digest ? String(digest).slice(-4) : null,
        deviceIdSuffix4: deviceId ? String(deviceId).slice(-4) : null,
        conversationId: conversationId || null,
        peerDeviceIdSuffix4: peerDeviceId ? String(peerDeviceId).slice(-4) : null,
        evidence: null,
        errorMessage: errorMessage || null
      }
    });
  } catch {
    /* logging best-effort */
  }
}

function logCapped(kind, payload) {
  if (kind === 'record' && recordLogCount >= LOG_LIMIT) return;
  if (kind === 'load' && loadLogCount >= LOG_LIMIT) return;
  if (kind === 'record') recordLogCount += 1;
  if (kind === 'load') loadLogCount += 1;
  try {
    log({
      receiverCheckpoint: {
        kind,
        ...payload
      }
    });
  } catch {
    /* ignore logging errors */
  }
}

function normalizeMessageId(value) {
  if (!value) return null;
  const token = String(value).trim();
  if (!token) return null;
  if (token.length < 4 || token.length > 200) return null;
  return token;
}

async function hashBytesHex(u8) {
  if (!(u8 instanceof Uint8Array) || u8.length === 0) return null;
  if (!crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', u8);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

async function hashStringHex(str) {
  if (!str || !crypto?.subtle) return null;
  try {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(str));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function cloneU8(src) {
  if (src instanceof Uint8Array) return new Uint8Array(src);
  return null;
}

function serializeSkippedKeys(skippedKeys, { perChainLimit = SKIPPED_PER_CHAIN_LIMIT, totalLimit = SKIPPED_TOTAL_LIMIT } = {}) {
  const out = {};
  const canonical = [];
  let total = 0;
  if (!(skippedKeys instanceof Map)) return { skipped: out, totalCount: 0, canonical: '' };
  for (const [chainId, chain] of skippedKeys.entries()) {
    if (!(chain instanceof Map)) continue;
    const sorted = Array.from(chain.entries())
      .filter(([idx, mk]) => Number.isFinite(idx) && typeof mk === 'string' && mk.length)
      .sort((a, b) => Number(a[0]) - Number(b[0]));
    const trimmed = sorted.slice(-perChainLimit);
    const chainObj = {};
    for (const [idx, mk] of trimmed) {
      if (total >= totalLimit) break;
      chainObj[idx] = mk;
      canonical.push(`${chainId}:${idx}:${mk}`);
      total += 1;
    }
    if (Object.keys(chainObj).length) out[chainId] = chainObj;
    if (total >= totalLimit) break;
  }
  canonical.sort();
  return { skipped: out, totalCount: total, canonical: canonical.join('|') };
}

function buildPayloadFromState({
  state,
  conversationId,
  peerAccountDigest,
  peerDeviceId,
  cursorMessageId,
  cursorServerMessageId,
  headerCounter,
  messageTs
}) {
  if (!state?.rk || !(state?.ckR instanceof Uint8Array) || !(state?.myRatchetPriv instanceof Uint8Array) || !(state?.myRatchetPub instanceof Uint8Array)) {
    throw new Error('receiver checkpoint requires complete DR state (rk/ckR/myRatchet)');
  }
  const { skipped, totalCount, canonical } = serializeSkippedKeys(state.skippedKeys);
  const payload = {
    v: 1,
    conversationId,
    peerAccountDigest,
    peerDeviceId,
    cursor: {
      messageId: normalizeMessageId(cursorMessageId),
      serverMessageId: normalizeMessageId(cursorServerMessageId),
      headerCounter: Number.isFinite(headerCounter) ? Math.floor(headerCounter) : null,
      ts: Number.isFinite(messageTs) ? Math.floor(messageTs) : null
    },
    dr: {
      rk_b64: b64(state.rk),
      ckR_b64: b64(state.ckR),
      ckS_b64: state.ckS instanceof Uint8Array ? b64(state.ckS) : null,
      Ns: Number.isFinite(state.Ns) ? Math.floor(state.Ns) : 0,
      Nr: Number.isFinite(state.Nr) ? Math.floor(state.Nr) : 0,
      PN: Number.isFinite(state.PN) ? Math.floor(state.PN) : 0,
      NsTotal: Number.isFinite(state.NsTotal) ? Math.floor(state.NsTotal) : 0,
      NrTotal: Number.isFinite(state.NrTotal) ? Math.floor(state.NrTotal) : 0,
      myRatchetPriv_b64: b64(state.myRatchetPriv),
      myRatchetPub_b64: b64(state.myRatchetPub),
      theirRatchetPub_b64: state.theirRatchetPub instanceof Uint8Array ? b64(state.theirRatchetPub) : null,
      pendingSendRatchet: !!state.pendingSendRatchet,
      role: state?.baseKey?.role || null,
      skipped
    },
    meta: {
      wrapInfoTag: WRAP_INFO_TAG,
      createdAt: Date.now(),
      skippedCount: totalCount
    }
  };
  return { payload, skippedCount: totalCount, skippedCanonical: canonical };
}

function mapFromSkippedObject(skippedObj) {
  const out = new Map();
  if (!skippedObj || typeof skippedObj !== 'object') return out;
  for (const chainId of Object.keys(skippedObj)) {
    const chainMap = new Map();
    const entries = skippedObj[chainId];
    const keys = Object.keys(entries || {});
    keys.sort((a, b) => Number(a) - Number(b));
    for (const idxKey of keys) {
      const mk = entries[idxKey];
      const idxNum = Number(idxKey);
      if (!Number.isFinite(idxNum)) continue;
      if (typeof mk !== 'string' || !mk) continue;
      chainMap.set(idxNum, mk);
    }
    if (chainMap.size) out.set(chainId, chainMap);
  }
  return out;
}

function buildHolderFromPayload(payload, { stateKey } = {}) {
  const dr = payload?.dr || {};
  const rk = b64u8(dr.rk_b64);
  const ckR = b64u8(dr.ckR_b64);
  const ckS = dr.ckS_b64 ? b64u8(dr.ckS_b64) : null;
  const myPriv = dr.myRatchetPriv_b64 ? b64u8(dr.myRatchetPriv_b64) : null;
  const myPub = dr.myRatchetPub_b64 ? b64u8(dr.myRatchetPub_b64) : null;
  const theirPub = dr.theirRatchetPub_b64 ? b64u8(dr.theirRatchetPub_b64) : null;
  if (!(rk instanceof Uint8Array) || !(ckR instanceof Uint8Array) || !(myPriv instanceof Uint8Array) || !(myPub instanceof Uint8Array)) {
    return null;
  }
  const holder = {
    rk,
    ckR,
    ckS,
    Ns: Number.isFinite(dr.Ns) ? Math.floor(dr.Ns) : 0,
    Nr: Number.isFinite(dr.Nr) ? Math.floor(dr.Nr) : 0,
    PN: Number.isFinite(dr.PN) ? Math.floor(dr.PN) : 0,
    NsTotal: Number.isFinite(dr.NsTotal) ? Math.floor(dr.NsTotal) : 0,
    NrTotal: Number.isFinite(dr.NrTotal) ? Math.floor(dr.NrTotal) : 0,
    myRatchetPriv: myPriv,
    myRatchetPub: myPub,
    theirRatchetPub: theirPub,
    pendingSendRatchet: !!dr.pendingSendRatchet,
    skippedKeys: mapFromSkippedObject(dr.skipped),
    baseKey: {
      conversationId: payload?.conversationId || null,
      peerAccountDigest: payload?.peerAccountDigest || null,
      peerDeviceId: payload?.peerDeviceId || null,
      role: dr.role || 'receiver',
      stateKey: stateKey || null
    },
    snapshotTs: Number.isFinite(payload?.meta?.createdAt) ? payload.meta.createdAt : Date.now(),
    snapshotSource: 'receiver-checkpoint',
    historyCursorId: payload?.cursor?.messageId || payload?.cursor?.serverMessageId || null,
    historyCursorTs: Number.isFinite(payload?.cursor?.ts) ? payload.cursor.ts : null,
    __bornReason: 'receiver-checkpoint'
  };
  return holder;
}

async function verifyPayloadAgainstMetadata(payload, checkpointMeta = {}) {
  const dr = payload?.dr || {};
  const metaNr = Number.isFinite(checkpointMeta?.Nr) ? Number(checkpointMeta.Nr) : null;
  if (metaNr !== null && Number(dr?.Nr) !== metaNr) return { ok: false, reason: 'NrMismatch' };
  const theirHashMeta = checkpointMeta?.theirRatchetPubHash || null;
  if (theirHashMeta) {
    const theirHash = await hashBytesHex(b64u8(dr?.theirRatchetPub_b64 || ''));
    if (!theirHash || theirHash.slice(0, theirHashMeta.length) !== theirHashMeta) {
      return { ok: false, reason: 'TheirPubMismatch' };
    }
  }
  const ckRHashMeta = checkpointMeta?.ckRHash || null;
  if (ckRHashMeta) {
    const ckRHash = await hashBytesHex(b64u8(dr?.ckR_b64 || ''));
    if (!ckRHash || ckRHash.slice(0, ckRHashMeta.length) !== ckRHashMeta) {
      return { ok: false, reason: 'CkRHashMismatch' };
    }
  }
  const skippedHashMeta = checkpointMeta?.skippedHash || null;
  if (skippedHashMeta) {
    const canonical = serializeSkippedKeys(mapFromSkippedObject(dr?.skipped)).canonical || '';
    const skippedHash = await hashStringHex(canonical);
    if (!skippedHash || skippedHash.slice(0, skippedHashMeta.length) !== skippedHashMeta) {
      return { ok: false, reason: 'SkippedHashMismatch' };
    }
  }
  const checkpointHashMeta = checkpointMeta?.checkpointHash || null;
  if (checkpointHashMeta) {
    const payloadHash = await hashStringHex(JSON.stringify(payload));
    if (!payloadHash || payloadHash.slice(0, checkpointHashMeta.length) !== checkpointHashMeta) {
      return { ok: false, reason: 'CheckpointHashMismatch' };
    }
  }
  return { ok: true };
}

export const ReceiverCheckpoints = {
  async recordCheckpoint({
    conversationId,
    peerAccountDigest,
    peerDeviceId,
    state,
    cursorMessageId,
    serverMessageId,
    headerCounter,
    messageTs
  }) {
    const mkRaw = getMkRaw();
    if (!mkRaw) {
      logMkMissingHardblock({
        sourceTag: 'receiver-checkpoints:record',
        reason: 'mk_missing',
        conversationId,
        peerDeviceId
      });
      return { ok: false, error: 'MK_MISSING_HARDBLOCK' };
    }
    if (!conversationId || !peerDeviceId || !state) return { ok: false, error: 'MissingParams' };
    const accountDigest = (getAccountDigest() || '').toUpperCase() || null;
    let payloadInfo;
    try {
      payloadInfo = buildPayloadFromState({
        state,
        conversationId,
        peerAccountDigest: peerAccountDigest || accountDigest,
        peerDeviceId,
        cursorMessageId,
        cursorServerMessageId: serverMessageId,
        headerCounter,
        messageTs
      });
    } catch (err) {
      return { ok: false, error: 'StateInvalid', message: err?.message || 'checkpoint payload build failed' };
    }
    const { payload, skippedCount, skippedCanonical } = payloadInfo;
    const theirRatchetPubB64 = payload?.dr?.theirRatchetPub_b64 || null;
    if (!theirRatchetPubB64) {
      return { ok: false, error: 'MissingTheirRatchetPub', message: 'receiver checkpoint requires theirRatchetPub' };
    }
    let theirRatchetPubU8;
    try {
      theirRatchetPubU8 = b64u8(theirRatchetPubB64);
    } catch (err) {
      return { ok: false, error: 'InvalidTheirRatchetPub', message: err?.message || 'theirRatchetPub decode failed' };
    }
    if (!(theirRatchetPubU8 instanceof Uint8Array) || theirRatchetPubU8.length === 0) {
      return { ok: false, error: 'MissingTheirRatchetPub', message: 'receiver checkpoint requires theirRatchetPub' };
    }
    if (DEBUG.replay && putAttemptLogCount < LOG_LIMIT) {
      putAttemptLogCount += 1;
      try {
        log({
          checkpointPutAttempt: {
            conversationId,
            peerDeviceId,
            Nr: payload?.dr?.Nr ?? null,
            cursorMessageId: payload?.cursor?.messageId || null,
            cursorServerMessageId: payload?.cursor?.serverMessageId || null,
            headerCounter: payload?.cursor?.headerCounter ?? null
          }
        });
      } catch {
        /* ignore logging errors */
      }
    }
    const wrapContext = {
      version: 1,
      conversationId,
      peerAccountDigest: peerAccountDigest || accountDigest,
      peerDeviceId,
      cursorMessageId: payload.cursor.messageId,
      cursorServerMessageId: payload.cursor.serverMessageId,
      headerCounter: payload.cursor.headerCounter,
      Nr: payload.dr.Nr,
      Ns: payload.dr.Ns,
      PN: payload.dr.PN,
      skippedCount
    };
    const checkpointHash = await hashStringHex(JSON.stringify(payload));
    const theirRatchetPubHash = await hashBytesHex(theirRatchetPubU8);
    if (!theirRatchetPubHash) {
      return { ok: false, error: 'TheirRatchetPubHashUnavailable', message: 'theirRatchetPub hash failed' };
    }
    const ckRHash = await hashBytesHex(b64u8(payload.dr.ckR_b64 || ''));
    const skippedHash = skippedCanonical ? await hashStringHex(skippedCanonical) : null;
    const wrapped = await wrapWithMK_JSON(payload, mkRaw, WRAP_INFO_TAG);
    try {
      const apiRes = await apiPutReceiverCheckpoint({
        conversationId,
        peerDeviceId,
        cursorMessageId: payload.cursor.messageId,
        cursorServerMessageId: payload.cursor.serverMessageId,
        headerCounter: payload.cursor.headerCounter,
        Nr: payload.dr.Nr,
        Ns: payload.dr.Ns,
        PN: payload.dr.PN,
        theirRatchetPubHash,
        ckRHash,
        skippedHash,
        skippedCount,
        wrapInfoTag: WRAP_INFO_TAG,
        checkpointHash,
        wrapped_checkpoint: wrapped,
        wrap_context: wrapContext,
        retentionLimit: RETENTION_PER_DEVICE
      });
      const status = apiRes?.r?.status ?? null;
      if (DEBUG.replay && putResultLogCount < LOG_LIMIT) {
        putResultLogCount += 1;
        try {
          log({
            checkpointPutResult: {
              conversationId,
              peerDeviceId,
              Nr: payload?.dr?.Nr ?? null,
              cursorMessageId: payload?.cursor?.messageId || null,
              cursorServerMessageId: payload?.cursor?.serverMessageId || null,
              headerCounter: payload?.cursor?.headerCounter ?? null,
              status,
              ok: !!apiRes?.r?.ok && !apiRes?.data?.error,
              error: apiRes?.data?.error || null
            }
          });
        } catch {
          /* ignore logging errors */
        }
      }
      if (!apiRes?.r?.ok || apiRes?.data?.error) {
        return { ok: false, error: apiRes?.data?.error || 'StoreFailed', status, message: apiRes?.data?.message || null };
      }
      if (DEBUG.replay) {
        logCapped('record', {
          conversationId: conversationId ? conversationId.slice(0, 8) : null,
          peerDeviceId: peerDeviceId ? String(peerDeviceId).slice(-4) : null,
          cursorMessageId: payload.cursor.messageId ? payload.cursor.messageId.slice(0, 8) : null,
          Nr: payload.dr.Nr,
          skippedCount
        });
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: 'StoreFailed', message: err?.message || 'store failed', status: err?.status || null };
    }
  },

  async loadLatestCheckpoint({ conversationId, peerAccountDigest, peerDeviceId }) {
    const mkRaw = getMkRaw();
    if (!mkRaw) {
      logMkMissingHardblock({
        sourceTag: 'receiver-checkpoints:load',
        reason: 'mk_missing',
        conversationId,
        peerDeviceId
      });
      return { error: 'MK_MISSING_HARDBLOCK' };
    }
    if (!conversationId || !peerDeviceId) return { error: 'MissingParams' };
    if (DEBUG.replay && getAttemptLogCount < LOG_LIMIT) {
      getAttemptLogCount += 1;
      try {
        log({
          checkpointGetLatestAttempt: {
            conversationId,
            peerDeviceId
          }
        });
      } catch {
        /* ignore logging errors */
      }
    }
    let res;
    try {
      res = await apiGetLatestReceiverCheckpoint({ conversationId, peerDeviceId });
    } catch (err) {
      return { error: err?.payload?.error || 'RequestFailed', status: err?.status || null, message: err?.message || 'request failed' };
    }
    const data = res?.data || null;
    const status = res?.r?.status ?? null;
    if (DEBUG.replay && getResultLogCount < LOG_LIMIT) {
      getResultLogCount += 1;
      try {
        log({
          checkpointGetLatestResult: {
            conversationId,
            peerDeviceId,
            status,
            error: data?.error || null
          }
        });
      } catch {
        /* ignore logging errors */
      }
    }
    if (!data) return { error: 'RequestFailed', status };
    if (status && status !== 200 && status !== 404) {
      return { error: data?.error || 'RequestFailed', status, message: data?.message || null };
    }
    if (data?.error === 'NotFound' || status === 404 || !data?.checkpoint) {
      return { error: 'NotFound', status: res?.r?.status || 404 };
    }
    const checkpoint = data.checkpoint || null;
    if (!checkpoint?.wrapped_checkpoint) {
      return { error: 'NotFound', status: data?.status || null };
    }
    let payload;
    try {
      payload = await unwrapWithMK_JSON(checkpoint.wrapped_checkpoint, mkRaw);
    } catch (err) {
      await logMkUnwrapHardblock({
        sourceTag: 'receiver-checkpoints:load',
        errorMessage: err?.message || 'unwrap failed',
        mkRaw,
        conversationId,
        peerDeviceId
      });
      return { error: 'MK_UNWRAP_FAILED_HARDBLOCK', message: err?.message || 'unwrap failed' };
    }
    if (DEBUG.replay && theirPubLogCount < LOG_LIMIT) {
      theirPubLogCount += 1;
      try {
        const metaTheirRatchetPubHash = checkpoint?.theirRatchetPubHash || null;
        let payloadTheirRatchetPubHash = null;
        try {
          payloadTheirRatchetPubHash = await hashBytesHex(b64u8(payload?.dr?.theirRatchetPub_b64 || ''));
        } catch {
          payloadTheirRatchetPubHash = null;
        }
        const match = !!metaTheirRatchetPubHash
          && !!payloadTheirRatchetPubHash
          && payloadTheirRatchetPubHash.slice(0, metaTheirRatchetPubHash.length) === metaTheirRatchetPubHash;
        log({
          replayCheckpointTheirPubVerify: {
            conversationId,
            peerDeviceId,
            metaTheirRatchetPubHash,
            payloadTheirRatchetPubHash,
            match
          }
        });
      } catch {
        /* ignore logging errors */
      }
    }
    const integrity = await verifyPayloadAgainstMetadata(payload, checkpoint);
    if (!integrity.ok) {
      await logMkUnwrapHardblock({
        sourceTag: 'receiver-checkpoints:load',
        errorMessage: integrity.reason || 'integrity check failed',
        mkRaw,
        conversationId,
        peerDeviceId
      });
      return { error: 'MK_UNWRAP_FAILED_HARDBLOCK', message: integrity.reason || 'integrity check failed' };
    }
    const holder = buildHolderFromPayload(payload, {
      stateKey: `replay-${conversationId || 'unknown'}::${peerAccountDigest || 'unknown'}::${peerDeviceId || 'unknown'}`
    });
    if (!holder) {
      return { error: 'MalformedCheckpoint' };
    }
    if (DEBUG.replay) {
      logCapped('load', {
        conversationId: conversationId ? conversationId.slice(0, 8) : null,
        peerDeviceId: peerDeviceId ? String(peerDeviceId).slice(-4) : null,
        Nr: checkpoint?.Nr ?? null
      });
      if (replayLoadedLogCount < LOG_LIMIT) {
        replayLoadedLogCount += 1;
        try {
          log({
            replayCheckpointLoaded: {
              conversationId,
              peerDeviceId,
              Nr: checkpoint?.Nr ?? null,
              headerCounter: checkpoint?.headerCounter ?? null
            }
          });
        } catch {
          /* ignore logging errors */
        }
      }
    }
    return { checkpoint, payload, holder };
  },

  buildHolderFromPayload
};
