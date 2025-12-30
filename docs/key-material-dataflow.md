Key Material Dataflow Report
============================

## A1. Encrypt / Decrypt Paths

- `web/src/app/ui/mobile/messages-pane.js:4487-4521`
  ```js
  elements.composer?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = (elements.input?.value || '').trim();
    if (!text) return;
    const ts = Math.floor(Date.now() / 1000);
    const messageId = crypto.randomUUID();
    const localMsg = appendLocalOutgoingMessage({ text, ts, id: messageId });
    const res = await sendDrText({
      peerAccountDigest: state.activePeerDigest,
      peerDeviceId: state.activePeerDeviceId || null,
      text,
      messageId
    });
    applyAckDeliveryReceipt({ convId: res?.convId || state.conversationId, ack: res, localMessage: localMsg });
  });
  ```

- `web/src/app/features/dr-session.js:1320-1359`
  ```js
  const transportCounter = reserveTransportCounter(state, { peerAccountDigest: peer, peerDeviceId, conversationId: finalConversationId, messageId, msgType });
  const preSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false, forceNow: true });
  const pkt = await drEncryptText(state, text, { deviceId: senderDeviceId, version: 1 });
  const messageKeyB64 = pkt?.message_key_b64 || null;
  const postSnapshot = snapshotDrState(state, { setDefaultUpdatedAt: false });
  const headerPayload = { ...pkt.header, peerAccountDigest: peer, peerDeviceId, iv_b64: pkt.iv_b64, meta };
  const job = await enqueueOutboxJob({
    conversationId: finalConversationId,
    messageId,
    headerJson,
    ciphertextB64: ctB64,
    counter: transportCounter,
    senderDeviceId,
    receiverAccountDigest: peer,
    receiverDeviceId: peerDeviceId || null,
    dr: preSnapshot ? { snapshotBefore: preSnapshot, snapshotAfter: postSnapshot, messageKeyB64 } : null
  });
  ```

- `web/src/app/features/queue/outbox.js:140-178`
  ```js
  async function attemptSend(job) {
    const payload = {
      conversationId: job.conversationId,
      header: job.header || (job.headerJson ? safeParseHeader(job.headerJson) : null),
      ciphertextB64: job.ciphertextB64,
      counter: job.counter,
      senderDeviceId: job.senderDeviceId,
      receiverAccountDigest: job.receiverAccountDigest,
      receiverDeviceId: job.receiverDeviceId,
      id: job.messageId,
      createdAt: job.createdAt
    };
    const { r, data } = await createSecureMessage(payload);
    const ackOk = r?.status === 202 && data && data.accepted === true && data.id;
    if (!ackOk) throw new Error(msg);
    return { r, data };
  }
  ```

- `src/controllers/messages.controller.js:190-229`
  ```js
  const headerJson = messageInput.header_json || JSON.stringify(messageInput.header || {});
  const ciphertextB64 = typeof messageInput.ciphertext_b64 === 'string'
    ? messageInput.ciphertext_b64
    : (typeof messageInput.ciphertext === 'string' ? messageInput.ciphertext : null);
  const counter = Number.isFinite(messageInput.counter) ? Number(messageInput.counter) : null;
  const path = '/d1/messages';
  const body = JSON.stringify({
    conversation_id: auth.conversationId,
    sender_account_digest: auth.accountDigest,
    sender_device_id: senderDeviceId,
    receiver_account_digest: receiverDigest,
    receiver_device_id: receiverDeviceId,
    header_json: headerJson,
    ciphertext_b64: ciphertextB64,
    counter,
    id: messageInput.id,
    created_at: messageInput.created_at || messageInput.ts || undefined
  });
  const r = await fetch(`${DATA_API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-auth': sig }, body });
  ```

- `web/src/app/ui/mobile/messages-pane.js:2813-2833`
  ```js
  const listResult = await listSecureAndDecrypt({
    conversationId: state.conversationId,
    tokenB64: state.conversationToken,
    peerAccountDigest: state.activePeerDigest,
    peerDeviceId: state.activePeerDeviceId || null,
    limit: fetchLimit,
    cursorTs,
    cursorId,
    mutateState,
    allowReplay: true,
    silent: !!silent,
    onMessageDecrypted: handleMessageDecrypted,
    prefetchedList: prefetch ? { items: prefetch.data.items || [], nextCursor: prefetch.data.nextCursor ?? null, nextCursorTs: prefetch.data.nextCursorTs ?? null, hasMoreAtCursor: !!prefetch.data.hasMoreAtCursor } : null
  });
  ```

- `web/src/app/features/messages.js:1380-1451`
  ```js
  headerRaw = jobPacket?.header_json || raw?.header_json || raw?.headerJson || raw?.header || null;
  if (!header) throw new Error('缺少訊息標頭或密文，無法進行 DR 解密');
  if (!header.dr) { logDeliverySkip('nonDrPayload', { headerKeys: Object.keys(header || {}) }); return; }
  packet = { header_json: headerRaw, ciphertext_b64: ciphertextB64, counter: jobPacket?.counter ?? header?.n ?? null };
  messageId = job?.messageId || serverMessageId;
  direction = deviceMatchesSelf ? 'incoming' : (isSelfSender ? 'outgoing' : 'incoming');
  state = getStateForDevice(peerDeviceForMessage);
  const headerCounter = Number(header?.n);
  const sameReceiveChain = state?.theirRatchetPub && typeof header?.ek_pub_b64 === 'string'
    && naclB64(state.theirRatchetPub) === header.ek_pub_b64;
  if (sameReceiveChain && Number.isFinite(headerCounter) && currentNr >= headerCounter) {
    logDeliverySkip('duplicateCounter', { counter: headerCounter, transportCounter, Nr: currentNr, Ns: stateNs });
    return;
  }
  ```

- `web/src/app/features/messages.js:1646-1695`
  ```js
  logDrCore('decrypt:attempt', { conversationId: convId, peerAccountDigest: peerKey, messageId, headerCounter: Number(header?.n ?? packet.counter ?? null) });
  const aad = header && deps.buildDrAadFromHeader ? deps.buildDrAadFromHeader(header) : null;
  const preDecryptSnapshot = deps.cloneDrStateHolder ? deps.cloneDrStateHolder(state) : null;
  const text = await deps.drDecryptText(state, pkt, {
    onMessageKey: (mk) => { messageKeyB64 = mk; },
    packetKey: messageId,
    msgType: msgTypeForDecrypt
  });
  deps.persistDrSnapshot({ peerAccountDigest: peerKey, state });
  const semantic = classifyDecryptedPayload(text, { meta, header });
  if (semantic.kind === SEMANTIC_KIND.CONTROL_STATE) { markMessageProcessed(convId, messageId); logControlHandled(semantic.subtype); return; }
  ```

- `web/src/app/features/messages.js:1878-1945`
  ```js
  const messageObj = buildMessageObject({ plaintext: text, payload, header, raw, direction, ts: messageTs, messageId, messageKeyB64 });
  const timelineEntry = {
    conversationId: convId,
    messageId: cacheMessageId || messageId || null,
    direction: messageObj.direction || direction || 'incoming',
    msgType: resolvedMsgType || messageObj.type || payloadMsgType || msgTypeForDecrypt || null,
    ts: messageObj.ts || messageTs || null,
    text: messageObj.text || null,
    media: messageObj.media || null
  };
  const appended = timelineAppendUserMessage(convId, timelineEntry);
  if (appended) replayCounters.timelineAppendCount += 1;
  if (messageObj.direction === 'incoming' && messageObj.id) {
    maybeSendDeliveryReceipt({ conversationId: convId, peerAccountDigest: peerKey, messageId: messageObj.id, tokenB64, peerDeviceId: peerDeviceForMessage });
    if (sendReadReceipt) maybeSendReadReceipt(convId, peerKey, peerDeviceForMessage, messageObj.id);
  }
  ```

## A2. mk / Chain Key / drState Lifecycle

- mk derivation from send chain: `web/src/shared/crypto/dr.js:343-385`
  ```js
  if (!st.ckS) { /* derive/send ratchet */ }
  const mkOut = await kdfCK(st.ckS);
  const { a: mk, b: nextCkS } = split64(mkOut);
  const mkB64 = b64(mk);
  st.ckS = nextCkS;
  st.Ns += 1;
  st.NsTotal = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) + 1 : st.Ns;
  const cipherParams = { name: 'AES-GCM', iv, additionalData: aad };
  const ctBuf = await crypto.subtle.encrypt(cipherParams, key, new TextEncoder().encode(plaintext));
  return { header: { ek_pub_b64: b64(st.myRatchetPub), pn: st.PN, n: st.Ns }, iv_b64: b64(iv), ciphertext_b64: b64(new Uint8Array(ctBuf)), message_key_b64: mkB64 };
  ```

- History capture (outgoing): `web/src/app/features/dr-session.js:503-544`
  ```js
  const entry = { ts: stamp, messageId: messageId || null, snapshot, messageKey_b64: messageKeyB64 || preservedKey || null };
  if (snapshotNext) entry.snapshotAfter = snapshotNext;
  history.push(entry);
  setContactSecret(peer, { deviceId, dr: { history }, meta: { source: 'dr-history-append' } });
  ```
  and on ack: `web/src/app/features/dr-session.js:2888-2941` hooks `onSent` to call `recordDrMessageHistory` and `persistDrSnapshot` with `snapshotBefore/After/messageKeyB64`.

- drState snapshot/persist: `web/src/app/features/dr-session.js:591-655`
  ```js
  const snap = { v: 1, rk_b64: b64(rkU8), Ns: numberOrDefault(state.Ns, 0), Nr: numberOrDefault(state.Nr, 0), PN: numberOrDefault(state.PN, 0), NsTotal: nsTotal, NrTotal: nrTotal, myRatchetPriv_b64: b64(state.myRatchetPriv), myRatchetPub_b64: b64(state.myRatchetPub), theirRatchetPub_b64: b64(state.theirRatchetPub), pendingSendRatchet: !!state.pendingSendRatchet, role: state.baseKey?.role || null, selfDeviceId };
  if (ckSU8) snap.ckS_b64 = b64(ckSU8);
  if (ckRU8) snap.ckR_b64 = b64(ckRU8);
  ```

- Contact-secret normalization (persist/restore): `web/src/app/core/contact-secrets.js:742-781`
  ```js
  function normalizeDrSnapshot(input, { source, peerKey, deviceId }) {
    const rk = normalizeDrKeyString(input.rk ?? input.rk_b64, { required: true });
    const ckS = normalizeDrKeyString(input.ckS ?? input.ckS_b64, { required: hasCkS, hasKey: hasCkS });
    const ckR = normalizeDrKeyString(input.ckR ?? input.ckR_b64, { required: hasCkR, hasKey: hasCkR });
    const out = { v: Number.isFinite(Number(input.v)) ? Number(input.v) : 1, rk_b64: rk, Ns: toNumberOrDefault(input.Ns, 0), Nr: toNumberOrDefault(input.Nr, 0), PN: toNumberOrDefault(input.PN, 0), NsTotal: toNumberRequired(input.NsTotal ?? input.Ns_total, 'NsTotal'), NrTotal: toNumberRequired(input.NrTotal ?? input.Nr_total, 'NrTotal'), myRatchetPriv_b64: normalizeOptionalB64(...), myRatchetPub_b64: normalizeOptionalB64(...), theirRatchetPub_b64: normalizeOptionalB64(...), pendingSendRatchet: !!input.pendingSendRatchet, updatedAt: toTimestampOrNull(input.updatedAt ?? input.snapshotTs ?? input.ts ?? null) };
    if (ckS) out.ckS_b64 = ckS; if (ckR) out.ckR_b64 = ckR;
    return out;
  }
  ```

- History structure and replay guard: `web/src/app/core/contact-secrets.js:789-813` normalizes `drHistory` entries with `snapshot`, `snapshotAfter`, `messageKey_b64`. `restoreDrStateFromHistory` is disabled (`web/src/app/features/dr-session.js:549`), so cached message keys are not used for replay.

- Replay state holder: `web/src/app/ui/mobile/messages-pane.js:2734-2740` sets `mutateState = mutateLive && !forceReplay && !append;` so replay (`forceReplay`) runs with `mutateState=false`. In `web/src/app/features/messages.js:1187-1199` a non-mutating replay clones the current holder per message instead of advancing Nr/Ns between packets, reusing the latest live state rather than historical send-chain snapshots.

## A3. Persisted Storage Interfaces

- Contact-secret snapshot layout: `web/src/app/core/contact-secrets.js:1254-1360`
  ```js
  function createEmptyContactSecret() {
    return {
      peerDeviceId: null,
      role: null,
      conversationToken: null,
      conversationId: null,
      conversationDrInit: null,
      devices: {}, // deviceId -> { drState, drSeed, drHistory, drHistoryCursorTs, drHistoryCursorId, updatedAt }
      updatedAt: null
    };
  }
  const normalizedState = dev?.drState ? normalizeDrSnapshot(dev.drState, { ... }) : null;
  devicesObj[devId] = { drState: normalizedState, drSeed: dev.drSeed || null, drHistory: normalizeDrHistory(dev.drHistory, { ... }), drHistoryCursorTs, drHistoryCursorId, updatedAt };
  ```

- Contact-secret backup API: `src/controllers/contact-secrets.controller.js:54-99`
  ```js
  export const backupContactSecrets = async (req, res) => {
    const input = BackupRequestSchema.parse(req.body || {});
    const auth = await resolveAccountAuth({ accountToken: input.accountToken, accountDigest: input.accountDigest });
    const workerPayload = { accountDigest: auth.accountDigest, payload: input.payload, checksum: input.checksum || null, snapshotVersion: input.snapshotVersion ?? null, entries: input.entries ?? null, updatedAt: input.updatedAt ?? Date.now(), bytes: input.bytes ?? null, withDrState: input.withDrState ?? null, deviceLabel: input.deviceLabel ?? null, deviceId: input.deviceId, reason: input.reason || 'auto' };
    const data = await callWorkerRequest('/d1/contact-secrets/backup', { method: 'POST', body: workerPayload });
    return res.json(data || { ok: true });
  };
  ```

- Secure message API wrapper: `web/src/app/api/messages.js:29-69` enforces `conversationId/header/ciphertext/counter/id/receiverDeviceId` and POSTs `/api/v1/messages/secure`, propagating device/account headers.

- Profile control-state storage (MK-wrapped envelope per account): `web/src/app/features/profile.js:104-170`
  ```js
  const { r, data } = await listSecureMessages({ conversationId: convId, limit });
  const header = it?.header_json ? JSON.parse(it.header_json) : it?.header;
  const normalizedEnvelope = assertEnvelopeStrict(entry.envelope, { allowInfoTags: PROFILE_ALLOWED_INFO_TAGS });
  const profile = await unwrapWithMK_JSON(normalizedEnvelope, mk);
  return { ...profile, msgId, ts: createdAt };
  ```

## A4. Evidence-Based Conclusion (≤10 lines)

- Replay mode forces `mutateState=false` (`web/src/app/ui/mobile/messages-pane.js:2734-2740`), so each packet decrypts with a fresh clone of the *current* holder; Nr/ckR/ckS advances are discarded between packets.
- For self-sent history packets, the current holder points at the latest send chain; older headers (`ek_pub_b64/n`) no longer match that chain, yielding wrong mk and AES-GCM auth failures (`web/src/app/features/messages.js:1646-1695` vs `web/src/shared/crypto/dr.js:343-385`).
- Outbound mk values are captured (`message_key_b64`) in `drHistory` (`web/src/app/features/dr-session.js:503-544`, `2888-2941`) but never replayed because `restoreDrStateFromHistory` is disabled and no mk cache is consulted during decrypt.
- Missing material for replay: a persisted outbound mk/send-chain snapshot per message (or a way to unwrap it) usable in read-only replay without mutating live ckS/Ns.
