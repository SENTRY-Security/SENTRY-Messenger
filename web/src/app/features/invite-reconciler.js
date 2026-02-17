import { invitesConsume, invitesConfirm, invitesUnconfirmed, invitesStatus } from '../api/invites.js';
import { openInviteEnvelope } from '../crypto/invite-dropbox.js';
import { ensureDevicePrivAvailable } from './device-priv.js';
import { findContactCoreByAccountDigest } from '../ui/mobile/contact-core-store.js';
import { listDeliveryIntents, removeDeliveryIntent } from '../ui/mobile/session-store.js';
import { logCapped } from '../core/log.js';

let _reconciling = false;
let _reconcilingDeliveries = false;
let _handleContactInitEvent = null;
let _replayDeliveryIntent = null;

export function initInviteReconciler({ handleContactInitEvent, replayDeliveryIntent }) {
  _handleContactInitEvent = typeof handleContactInitEvent === 'function' ? handleContactInitEvent : null;
  _replayDeliveryIntent = typeof replayDeliveryIntent === 'function' ? replayDeliveryIntent : null;
}

export async function reconcileUnconfirmedInvites() {
  if (_reconciling) return { total: 0, alreadyReady: 0, replayed: 0, failed: 0, skipped: true };
  _reconciling = true;
  try {
    const res = await invitesUnconfirmed();
    const invites = res?.invites || [];
    if (!invites.length) return { total: 0, alreadyReady: 0, replayed: 0, failed: 0 };

    let alreadyReady = 0;
    let replayed = 0;
    let failed = 0;

    for (const inv of invites) {
      const inviteId = inv.invite_id;
      try {
        const consumeRes = await invitesConsume({ inviteId });
        const envelope = consumeRes?.ciphertext_envelope;
        if (!envelope) { failed++; continue; }

        let devicePriv;
        try {
          devicePriv = await ensureDevicePrivAvailable();
        } catch {
          failed++;
          continue;
        }
        if (!devicePriv?.spk_priv_b64) { failed++; continue; }

        let payload;
        try {
          payload = await openInviteEnvelope({
            ownerPrivateKeyB64: devicePriv.spk_priv_b64,
            envelope
          });
        } catch {
          failed++;
          continue;
        }

        const peerDigest = payload?.guestAccountDigest || null;
        if (!peerDigest) { failed++; continue; }

        const existing = findContactCoreByAccountDigest(peerDigest);
        const readyEntry = Array.isArray(existing) ? existing.find(e => e.entry?.isReady) : null;

        if (readyEntry) {
          await invitesConfirm({ inviteId });
          alreadyReady++;
        } else if (_handleContactInitEvent) {
          const msg = {
            guestAccountDigest: payload.guestAccountDigest,
            guestDeviceId: payload.guestDeviceId,
            guestBundle: payload.guestBundle,
            guestProfile: payload.guestProfile
          };
          await _handleContactInitEvent(msg, { inviteId });
          replayed++;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        logCapped('reconcileInviteFailed', { inviteId, error: err?.message }, 5);
      }
    }
    return { total: invites.length, alreadyReady, replayed, failed };
  } finally {
    _reconciling = false;
  }
}

/**
 * Reconcile delivery intents for the scanner (B) side.
 * When B delivers an envelope but crashes before local session setup,
 * the delivery intent (with ephemeral key material) persists in localStorage.
 * This function re-derives the session from stored material.
 */
export async function reconcileUnconfirmedDeliveries() {
  if (_reconcilingDeliveries) return { total: 0, alreadyReady: 0, replayed: 0, failed: 0, skipped: true };
  _reconcilingDeliveries = true;
  try {
    const intents = listDeliveryIntents();
    if (!intents.length) return { total: 0, alreadyReady: 0, replayed: 0, failed: 0 };

    let alreadyReady = 0;
    let replayed = 0;
    let failed = 0;

    for (const intent of intents) {
      const inviteId = intent?.inviteId;
      if (!inviteId) { failed++; continue; }
      try {
        const ownerDigest = intent.ownerAccountDigest;
        if (!ownerDigest) { removeDeliveryIntent(inviteId); failed++; continue; }

        // Check if the contact is already established locally
        const existing = findContactCoreByAccountDigest(ownerDigest);
        const readyEntry = Array.isArray(existing) ? existing.find(e => e.entry?.isReady) : null;
        if (readyEntry) {
          removeDeliveryIntent(inviteId);
          alreadyReady++;
          continue;
        }

        // If deliver never completed, check server status to see if it went through
        if (!intent.deliverCompleted) {
          try {
            const statusRes = await invitesStatus({ inviteId });
            const status = statusRes?.status;
            if (status === 'CREATED' || status === 'EXPIRED') {
              // Deliver never went through or invite expired – clean up
              removeDeliveryIntent(inviteId);
              failed++;
              continue;
            }
            // DELIVERED, CONSUMED, CONFIRMED – deliver succeeded, proceed with replay
          } catch {
            // Network error – skip for now, retry on next reconcile
            failed++;
            continue;
          }
        }

        // Replay the delivery: re-derive session from stored material
        if (_replayDeliveryIntent) {
          await _replayDeliveryIntent(intent);
          replayed++;
        } else {
          failed++;
        }
      } catch (err) {
        failed++;
        logCapped('reconcileDeliveryIntentFailed', { inviteId, error: err?.message }, 5);
      }
    }
    return { total: intents.length, alreadyReady, replayed, failed };
  } finally {
    _reconcilingDeliveries = false;
  }
}
