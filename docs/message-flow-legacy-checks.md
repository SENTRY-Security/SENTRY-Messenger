# Message Flow Isolation Checks (legacy)

## share-controller invite consume/scan path (rg)

```
4:import { invitesCreate, invitesDeliver, invitesConsume, invitesStatus } from '../../api/invites.js';
259:    inviteConsumeBtn,
313:  inviteConsumeBtn?.addEventListener('click', () => {
319:    consumeInviteDropbox(inviteId, { source: 'manual' })
755:    if (inviteConsumeBtn) {
756:      inviteConsumeBtn.style.display = hasInvite ? 'inline-flex' : 'none';
757:      inviteConsumeBtn.disabled = !hasInvite || expired || !!loading;
943:  function ensureActiveInvite() {
966:      ensureActiveInvite().catch((err) => console.error('[share-controller]', { inviteEnsureError: err?.message || err }));
992:      ensureActiveInvite().catch((err) => console.error('[share-controller]', { inviteEnsureError: err?.message || err }));
1000:  async function ensureInviteScanner() {
1013:      handleInviteScan(text);
1041:      const scanner = await ensureInviteScanner();
1063:  async function handleInviteScan(raw) {
1154:      await invitesDeliver({ inviteId: parsed.inviteId, ciphertextEnvelope: envelope });
2062:  async function consumeInviteDropbox(inviteId, { source = 'manual' } = {}) {
2083:      const res = await invitesConsume({ inviteId: id });
2388:    handleInviteScan,
2389:    consumeInviteDropbox,
```

## contact entry functions (rg)

```
web/src/app/ui/mobile/share-controller.js:25:import { normalizeNickname, persistProfileForAccount, PROFILE_WRITE_SOURCE } from '../../features/profile.js';
web/src/app/ui/mobile/share-controller.js:361:  function storeContactSecretMapping({ peerAccountDigest, peerDeviceId, sessionKey, conversation, drState, role }) {
web/src/app/ui/mobile/share-controller.js:1755:      storeContactSecretMapping({
web/src/app/ui/mobile/share-controller.js:1763:        await persistProfileForAccount(
web/src/app/ui/mobile/share-controller.js:1822:  async function handleContactInitEvent(msg = {}, opts = {}) {
web/src/app/ui/mobile/share-controller.js:2029:        await persistProfileForAccount(profilePayload, peerDigest);
web/src/app/ui/mobile/share-controller.js:2034:    storeContactSecretMapping({
web/src/app/ui/mobile/share-controller.js:2104:      const initResult = await handleContactInitEvent(msg, { inviteId: id });
web/src/app/ui/mobile/share-controller.js:2391:    handleContactInitEvent,
web/src/app/ui/app-mobile.js:61:  persistProfileForAccount,
web/src/app/ui/app-mobile.js:2802:  handleContactInitEvent,
web/src/app/features/profile.js:491:export async function persistProfileForAccount(profile, accountDigest) {
```

## UI-only boundary verification (rg)

```
rg -n "listSecureAndDecrypt\\(" web/src/app/ui/mobile/messages-pane.js
# expected: 0 hits

rg -n "import \\{.*listSecureAndDecrypt" web/src/app/ui/mobile/messages-pane.js
# expected: 0 hits

rg -n "listSecureAndDecrypt\\(" web/src/app/features/messages-flow-legacy.js
# expected: >=1 hits (wrapper)
```
