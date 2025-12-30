# Outbound Key Vault Integration (design only)

Goal: deterministic self-sent history replay without protocol/schema changes or retries.

## A) Outbound capture (post-send)
- `web/src/app/features/dr-session.js:1333-1341` — `drEncryptText` returns `messageKeyB64`, `headerN`, and the reserved `transportCounter`; minimal tap point to copy MK bytes before state is mutated.
- `web/src/app/features/dr-session.js:1491-1509` — after `processOutboxJobNow` success and `send:done` log, ack `msg.id` is available; call `OutboundKeyVault.recordOutboundKey` here with `{ conversationId: finalConversationId, serverMessageId: msg.id, messageId, senderDeviceId, targetDeviceId: peerDeviceId, counterN: transportCounter, msgType, mkBytes }` (mk from `messageKeyB64`, wrapped via existing client MK/device key). No behavior change to delivery path.
- `web/src/app/features/dr-session.js:1893-1947` and `1990-2004` — media send path mirrors text: MK arrives as `messageKeyB64` right after `drEncryptText`, final ids land after the outbox job returns. Same vault recording call with media `msg_type` and the resolved `finalMessageId`.

## B) Replay consumption (self/outgoing must go through vault)
- `web/src/app/features/messages.js:1462-1476` — `isHistoryReplay && isSelfSender` is already computed and rewires `peerDeviceForMessage` to the target device; use this to flag self-sent replay packets before any decrypt attempt.
- `web/src/app/features/messages.js:1707-1716` — choke point before `deps.drDecryptText`; header counter, `stateKey`, `msgTypeForDecrypt`, device ids, and `isHistoryReplay` are all in scope. For self-sent history replay with stale `header.n`/transport counter, route to `OutboundKeyVault.getOutboundKey` and decrypt with the returned MK instead of ratchet state. This path is mandatory (no fallback to DR for that class of packets).

## C) Vault miss = not replayable (explicit evidence)
- At the same decrypt entry (`web/src/app/features/messages.js:1707-1716`), when the vault lookup for a self-sent replay packet returns null, immediately emit a structured log (`gate: outboundVaultMissing` under `DEBUG.replay`) including `{ conversationId, serverMessageId, messageId, senderDeviceId, targetDeviceId, selfDeviceId, stateKey, headerCounter }`, and fail the packet as “不可回放”. Do not retry/backoff; keep current state rollback and dead-letter recording so the failure type stays attributable.
