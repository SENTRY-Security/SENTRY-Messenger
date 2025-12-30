WrappedKeyVault Spec (Design Only)
==================================

## B1. Minimal Interfaces (TypeScript/JSDoc)

```ts
type WrappedBlob = Uint8Array | string | { v: number; data: any };

type VaultContext = {
  conversationId: string;
  senderDeviceId: string;
  messageId: string;
  counter: number;
  msgType: string;
};

/**
 * Wrap a per-message mk with server-storable envelope (server never unwraps).
 */
function wrapKey(mk: Uint8Array, context: VaultContext): Promise<WrappedBlob> {}

/**
 * Unwrap previously wrapped mk; MUST verify context matches to prevent cross-unwrap.
 */
function unwrapKey(wrapped: WrappedBlob, context: VaultContext): Promise<Uint8Array> {}

/**
 * Persist wrapped keys for later replay.
 */
function putWrappedKeys(entries: Array<{
  conversationId: string;
  messageId: string;
  senderDeviceId: string;
  counter: number;
  wrapped: WrappedBlob;
}>): Promise<void> {}

/**
 * Fetch wrapped keys by conversation/message/counter.
 */
function getWrappedKeys(query: {
  conversationId: string;
  messageIds?: string[];
  senderDeviceId?: string;
  counterRange?: { min?: number; max?: number };
}): Promise<Array<{ messageId: string; wrapped: WrappedBlob }>> {}
```

## B2. Minimal Insertion Points (no implementation yet)

- `web/src/app/features/dr-session.js:1320-1359` (send path after `drEncryptText` computes `message_key_b64`)
  - Why: mk, messageId, counter, msgType are all present before enqueuing outbox; we can wrap and stage for persistence without touching DR protocol.
  - Risk: must avoid blocking send path; ensure wrapping does not mutate `state` or counter; messageId must already be final (enforced upstream).

- `web/src/app/features/dr-session.js:2888-2941` (outbox `onSent` hook with `snapshotBefore/After/messageKeyB64`)
  - Why: guaranteed server ack; ideal to call `putWrappedKeys` so storage only happens on success; has `peerAccountDigest/peerDeviceId/counter`.
  - Risk: hook runs async; must avoid extending outbox critical path; counter drift if hook crashes—should not alter DR state.

- `web/src/app/features/messages.js:1646-1695` (replay decrypt path before `drDecryptText`)
  - Why: `messageId`, `header.n`, `meta.msg_type`, `peerDeviceId`, and replay flags are available; we can detect self-sent history (`isHistoryReplay && isSelfSender`) and try `unwrapKey` to inject mk.
  - Risk: Need a clear switch to avoid touching live receive state; counter/header mismatch may persist—must gate on context (conversationId, senderDeviceId, counter) to avoid cross-use.

- `web/src/app/features/messages.js:1187-1199` (state acquisition when `mutateState=false`)
  - Why: replay currently clones the latest holder per packet; if `unwrapKey` succeeds we can decrypt without mutating ckR/ckS, keeping DR protocol untouched.
  - Risk: state clone must remain read-only; avoid altering `drState()` store or counters during replay.

## B3. Risks and MVP Boundary (≤10 lines)

- Supporting only self-sent packets (using senderDigest == self + targetDeviceId != self) covers the reported replay gap without touching peer inbound flows.
- MVP scope: wrap on successful sends, store via `putWrappedKeys`, and during replay use `unwrapKey` for self-sent history when `mutateState=false`; skip other msgTypes until validated.
- Exclude protocol changes (DR/X3DH/OPAQUE) and DB schema; vault can piggyback on existing contact-secrets backup channel or a dedicated blob store.
- Residual risk: missing wrapped entries for legacy messages means old failures persist; must degrade to current behavior (fail fast, no fallback).
