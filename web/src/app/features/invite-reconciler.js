import { invitesConsume, invitesConfirm, invitesUnconfirmed } from '../api/invites.js';
import { openInviteEnvelope } from '../crypto/invite-dropbox.js';
import { ensureDevicePrivAvailable } from './device-priv.js';
import { findContactCoreByAccountDigest } from '../ui/mobile/contact-core-store.js';
import { logCapped } from '../core/log.js';

let _reconciling = false;
let _handleContactInitEvent = null;

export function initInviteReconciler({ handleContactInitEvent }) {
  _handleContactInitEvent = typeof handleContactInitEvent === 'function' ? handleContactInitEvent : null;
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
