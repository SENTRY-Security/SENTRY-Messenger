# Signal 化重構設計摘要

前提：一次切換、可清空 D1，單裝置但 schema 預留 device_id；保留 SDM/ MK 包裝備份，登出清空本機。

## D1 Schema（0014_signal_reset.sql）
- devices(account_digest, device_id, label?, created_at, updated_at) PK(account_digest, device_id)。
- device_signed_prekeys(id, account_digest, device_id, spk_id, spk_pub, spk_sig, created_at)；UNIQUE(account_digest, device_id, spk_id)。
- device_opks(id, account_digest, device_id, opk_id, opk_pub, issued_at, consumed_at)；UNIQUE(account_digest, device_id, opk_id)、索引(consumed_at)。
- conversations(id, token_b64, created_at)；conversation_acl(conversation_id, account_digest, device_id NULLable, role, created_at, updated_at)。
- messages_secure(id, conversation_id, sender_account_digest, sender_device_id, receiver_account_digest, receiver_device_id?, header_json, ciphertext_b64, counter, created_at)；索引 conversation ts/id、sender counter。
- attachments(object_key PK, conversation_id, message_id, sender_account_digest, sender_device_id, envelope_json, size_bytes, content_type, created_at)；索引 conversation/message_id。

## Worker API（草案）
- `POST /d1/prekeys/publish`  
  入參：account_digest, device_id, signed_prekey {id,pub,sig}, opks[{id,pub}]。行為：upsert devices/device_signed_prekeys，插入/覆蓋 opks（允許重建，會覆寫同 device_id 的未消耗 opk_id）。回傳 next_opk_id。
- `GET /d1/prekeys/bundle?peer_accountDigest=&peer_deviceId=`  
  回傳：peer device identity {spk_pub, spk_sig, opk {id,pub}}；消耗該 opk（標記 consumed_at）。若 peer_deviceId 未給，取預設（單裝置）最新 device/opk。
- `POST /d1/messages`（secure store）  
  入參：id, conversation_id, sender_account_digest, sender_device_id, receiver_account_digest, receiver_device_id?, header_json, ciphertext_b64, counter, created_at(optional)。寫入 messages_secure。回傳 accepted + created_at。
- `GET /d1/messages?conversationId=&cursorTs=&cursorId=&limit=`  
  依 (created_at DESC, id DESC) + counter 回傳 {items, nextCursor:{ts,id}, hasMoreAtCursor}；授權由 conversation_acl (account_digest, device_id NULLable) 驗證。
- `POST /d1/conversations/acl`（如需）：管理 conversation_acl ，device_id 可為 NULL 代表該帳號任意裝置。

## Node API（草案）
- `POST /api/v1/keys/publish`：透傳 account_token/digest + device_id + signed_prekey + opks 至 Worker；回傳 next_opk_id。  
- `GET /api/v1/keys/bundle?peerAccountDigest=&peerDeviceId=`：取 Worker bundle；Node 僅做 account 授權（token/digest），不再需要 conversation fingerprint。
- `POST /api/v1/messages/secure`：body {conversation_id, header_json, ciphertext_b64, counter, created_at?, receiver_device_id?}; headers X-Account-Token/Digest；Node 驗授權後寫 Worker /d1/messages。回傳 {id, created_at}。
- `GET /api/v1/messages/secure?conversationId=&cursorTs=&cursorId=&limit=`：透傳游標；回傳 Worker 結構。
- 移除 conversation fingerprint、session-init/ack 相關邏輯；ACL 僅 digest/device。

## 前端流程（草案）
- 登入/交棒：保留 SDM -> MK -> wrapped_dev；生成/領取 device_id，連同 signed_prekey/OPKs 上傳（MK 包裝備份存伺服端）。
- 會話建立：以 peer_account_digest(+device_id) 為 key，X3DH Initiator/Responder；不再送 session-init/ack 控制訊息。
- 封包 header：`{dh: ek_pub_b64, pn, n, counter, version, device_id}`；消息結構 = header_json + ciphertext_b64（text/media 共用 message_key，media meta 帶 key_type）。
- 解密：按 counter/chain 跳號填 skipped-keys，失敗先用歷史快照/message_key replay，再必要時 recover（不強制 reset）；state key 改 peer digest + device_id。
- ACL/WS：消息通知 payload 改 digest+conversation_id(+device_id)，前端不再使用 conversation fingerprint，token 只作 envelope key（若保留）。
- 快照/備份：contactSecrets/backup 改存 per-peerDevice DR snapshot + messageKey history，仍以 MK 封裝；logout flush，登入還原。
