# SENTRY Message — iOS 客戶端開發指南

目的：讓 iOS 專案在未讀過原始 Web/PWA 程式碼的情況下，完整實作並驗證 SENTRY Messenger（登入、好友、對話、附件、通話）。本文件以「客戶端要做什麼」為主，並列出後端 API、加解密流程與 UI 指南。

## 0. API Endpoint 一覽（iOS 常用）
- **Auth / OPAQUE**
  - `POST /api/v1/auth/sdm/exchange` — body `{uid, sdmmac, sdmcounter, nonce?}` → `{session, hasMK, wrapped_mk?, accountToken, accountDigest, uidDigest, opaqueServerId}`；一次性 session 60s。
  - `POST /api/v1/mk/store` — `{session, uidHex, accountToken?, accountDigest?, wrapped_mk}` → 204；首次設定密碼用。
  - `POST /api/v1/mk/update` — `{uidHex, accountToken, accountDigest, wrapped_mk}` → 204；登入後更改密碼。
  - `POST /api/v1/auth/opaque/register-{init,finish}` — `{accountDigest, request_b64}` / `{accountDigest, record_b64, client_identity?}`。
  - `POST /api/v1/auth/opaque/login-{init,finish}` — `{accountDigest, ke1_b64, context?}` → `{ke2_b64, opaqueSession}`；`{opaqueSession, ke3_b64}` → `{ok, session_key_b64}`。
  - `POST /api/v1/auth/sdm/debug-kit` — `{uidHex?}` 取得 SDM 偵錯套件（僅開發）。
- **Keys / Device / Prekeys**
  - `POST /api/v1/devkeys/fetch` — `{accountToken? accountDigest?}` → `{wrapped_dev}` 或 404。
  - `POST /api/v1/devkeys/store` — `{wrapped_dev, session?, accountToken? accountDigest?}` → 204。
  - `POST /api/v1/keys/publish` — `{uidHex?, accountToken/accountDigest, bundle:{ik_pub?, spk_pub?, spk_sig?, opks[]}}` → 204。
  - `POST /api/v1/keys/bundle` — `{peer_uidHex? peer_accountDigest?}` → guest/owner bundle（會消耗 OPK）。
- **Friends / Contact Secrets**
  - `POST /api/v1/friends/invite` → `{inviteId, secret, prekey_bundle...}`。
  - `POST /api/v1/friends/invite/contact` — `{inviteId, secret, envelope}`（contact snapshot）。
  - `POST /api/v1/friends/accept` — `{inviteId, secret, contactEnvelope?, guestBundle?, ownerUid?}` → `{owner_contact, guest_bundle, guest_contact, conversation_token, dr_init?}`。
  - `POST /api/v1/friends/contact/share` — `{inviteId, secret, myUid, envelope, peerUid?, conversationId?, conversationFingerprint?}`。
  - `POST /api/v1/friends/delete` — `{uidHex, peerUid, accountToken/accountDigest}`。
  - `POST /api/v1/friends/bootstrap-session` — `{peerUid, uidHex?, roleHint?, inviteId?, accountToken/accountDigest}` → guestBundle + 最新 contact snapshots。
  - `POST /api/v1/contact-secrets/backup` / `GET /api/v1/contact-secrets/backup?limit=&version=` — 備份 / 取回 contactSecrets snapshot。
- **Messages / Conversations**
  - `POST /api/v1/messages/secure` — `{conversation_id, payload_envelope, id?, created_at?, uidHex, accountToken/accountDigest, conversationFingerprint?}`。
  - `GET /api/v1/messages/secure?conversationId=&limit=&cursorTs=` — headers `X-Uid-Hex`, `X-Account-Token`/`X-Account-Digest`, `X-Conversation-Fingerprint?`。
  - `POST /api/v1/messages` — 傳統媒體/索引（含 `ciphertext_b64`, `aead`, `header`, `convId`, `uidHex`, `accountToken/accountDigest`, `conversationFingerprint?`）。
  - `GET /api/v1/conversations/:convId/messages` — 文字/媒體列表（舊版，需 account headers）。
  - `POST /api/v1/messages/delete` — `{conversationId, ids?, keys?, accountToken/accountDigest}`。
  - `POST /api/v1/messages/secure/delete-conversation` — `{conversationId, accountToken/accountDigest, conversationFingerprint?}`。
- **Media / Drive**
  - `POST /api/v1/media/sign-put` — `{convId, contentType, size?, dir?, direction?, uidHex, accountToken/accountDigest, conversationFingerprint?}` → 上傳 URL + `objectPath`。
  - `POST /api/v1/media/sign-get` — `{key, uidHex, accountToken/accountDigest, conversationFingerprint?, downloadName?}` → 下載 URL。
- **WebSocket**
  - `POST /api/v1/ws/token` — `{uidHex, accountToken/accountDigest}` → `{token, expiresAt}`；連線 `/ws` 後先送 `{type:'auth', uid, token}`。
  - 事件：`secure-message`, `contact-share`, `contact-removed`, `contacts-reload`, `presence`（需 `presence-subscribe`），通話信令 `call-*`。
- **Calls**
  - `POST /api/v1/calls/{invite,cancel,ack,report-metrics,turn-credentials}`（皆需 account headers）。
  - `GET /api/v1/calls/:callId` — 查詢 session；`GET /api/v1/calls/network-config` 取 ICE/帶寬模板。
- **健康與除錯**
  - `GET /api/health` / `/api/status`；`POST /api/v1/debug/console`（前端遙測 log，需開環境變數）。
- **網域 / Base URL**
  - 依部署環境設定 `ORIGIN_API`（例如 `https://api.message.sentry.red` 或本機 `http://127.0.0.1:3000`），所有上述路徑皆以此為前綴。
  - WebSocket 以同域 `/ws`（例如 `wss://api.message.sentry.red/ws`）；TURN/STUN 端點由 `getCallNetworkConfig` 返回。

### 常見請求格式與 Header
- 所有 REST 皆為 `application/json`，Body 為 JSON；列表查詢可帶 query string。
- 驗證欄位：`uidHex`（14 hex）、`accountToken` 或 `accountDigest`（64 hex）；Conversation 相關需 `X-Conversation-Fingerprint` header（HMAC-SHA256(conversationToken, accountDigest/uidHex)）。
- Media 上傳 `sign-put` 取得 URL 後直傳；回傳的 `upload` 欄位可能包含 `method/headers/fields`（支援直傳與表單）。
- WebSocket 連線後第一則訊息必須 `{type:'auth', uid, token}`，否則不會處理其他事件。

## 1. 角色與邊界
- 端到端：所有解密、DR 狀態、主金鑰（MK）都僅存在裝置記憶體／Keychain；後端永遠只見到密文與索引。
- 雙憑證：大多數 API 需要 `uidHex` + `accountToken` 或 `accountDigest`（請維持相同欄位名稱）。Conversation 相關 API 需額外帶 `X-Conversation-Fingerprint`。
- 無長期登入：登出或 App 終止時需清除 MK、DR 狀態與快取，並將 `contactSecrets` 寫回 snapshot 以便下次手動載入。

## 2. 本地狀態與儲存
- 內存（必要）：MK 明文、DR state、裝置私鑰、未上傳的訊息佇列。
- Keychain（建議）：`wrapped_mk`、`wrapped_dev`、最新 `contactSecrets` snapshot checksum；避免存 MK 明文。
- 檔案（加密後）：`contactSecrets` snapshot（JSON 以 MK 衍生密鑰 AES-GCM 包裝）。
- `contactSecrets` v2 結構（Map<peerUid, record>）：
  - `inviteId`, `secret`, `role`（owner/guest）
  - `conversationToken`、`conversationId`、`conversationDrInit`
  - `drState`（rk/ckS/ckR/Ns/Nr/ratchet pub/priv…，均為 b64）
  - `drHistory`（[{ts, messageId, snapshot, snapshotAfter, messageKey_b64}]）與 `drHistoryCursor{Ts,Id}`
  - `drSeed`（可用於強制重建）、`sessionBootstrapTs`、`updatedAt`
  - Snapshot 外層包含 `v`, `generatedAt`, `entries[]`；checksum 使用 sum32。
  - 備份到後端時：`payload` 為上列 JSON 字串（可再用 MK AES-GCM 包裝），`checksum` 為 sum32。
  - Device/Keychain 建議存放：`wrapped_mk`（Argon2id + AES-GCM blob）、`wrapped_dev`（AES-GCM blob 或 argon2id blob；欄位 `{v,kdf?,aead?,m,t,p,salt_b64,iv_b64,ct_b64}`）。

## 3. 登入流程（SDM → OPAQUE → MK/Device）
1) **SDM 交換**  
`POST /api/v1/auth/sdm/exchange`，body `{uid, sdmmac, sdmcounter, nonce}` → 回 `session`（一次性）、`hasMK`、`wrapped_mk?`、`accountToken`、`accountDigest`、`uidDigest`、`opaqueServerId?`。  
錯誤時保持清空狀態。

2) **OPAQUE 驗證**  
使用 `accountDigest` + `opaqueServerId` 進行 OPAQUE 認證（前端產生 KE1/KE3，後端代理 Worker）。成功後可刷新 `accountToken/accountDigest`。

3) **MK 處理**  
- 首次：產生 32-byte MK → Argon2id(m=64MB,t=3,p=1) 派生 KEK → AES-GCM 包裝成 `wrapped_mk` → `POST /api/v1/mk/store {session, uidHex, accountToken, accountDigest, wrapped_mk}`（204 成功）。
- 已有：Argon2id + AES-GCM 解封 `wrapped_mk`，得 MK 明文。

4) **裝置金鑰與 Prekeys**  
- 備份取得：`POST /api/v1/devkeys/fetch {accountToken/accountDigest}`（404 表示缺）。解包 `wrapped_dev`（AES-GCM with MK）取得 devicePriv。  
- 無備份：生成 IK/SPK（Ed25519->X25519）+ 100 OPKs → `POST /api/v1/keys/publish {uidHex, bundle}`（204）；將 `wrapped_dev` 存回 `/api/v1/devkeys/store`（session 僅首次必填）。  
- 補貨：已備份時解包 devicePriv，`/keys/publish` 先同步 IK/SPK，再批次生成 20 OPKs 上傳，成功後更新 `wrapped_dev`。允許 409 fallback（缺 IK/SPK 時帶完整 bundle）。

5) **登入交棒與儲存**  
MK 明文、devicePriv 僅存 RAM；`wrapped_mk`、`wrapped_dev`、最新 `contactSecrets` snapshot 可存 Keychain。失敗時務必清除 MK/DR。

## 4. 好友邀請與 Conversation Token
- **建立邀請**：`POST /api/v1/friends/invite {uidHex, accountToken/accountDigest, prekeyBundle?, ttlSeconds?}` → 回 `{inviteId, secret, ownerUid, prekey_bundle}`。同時將自己的 contact snapshot 以 invite secret AES-GCM 包裝後呼叫 `/api/v1/friends/invite/contact`。
- **接受邀請**：`POST /api/v1/friends/accept {inviteId, secret, contactEnvelope?, guestBundle?, ownerUid?}` → 回 `{owner_contact, guest_bundle, guest_contact, conversation_token, dr_init?}`。成功後寫入 `contactSecrets`（role=guest / owner）。
- **聯絡同步**：`POST /api/v1/friends/contact/share {inviteId, secret, myUid, envelope, peerUid?, conversationId?, conversationFingerprint?}` 更新最新 profile/conversation token；WS 事件 `contact-share` 會推播。
- **Bootstrap 缺會話**：`POST /api/v1/friends/bootstrap-session {peerUid, roleHint?, inviteId?}` → guestBundle + 最新 contact snapshots，用於 DR 缺失時重建。
- **邀請格式**：contact envelope 為 `{iv, ct}`（AES-GCM），secret / inviteId 以 URL-safe b64。
- **Conversation Token / Id**：由 invite secret HKDF(SHA-256, salt=32zero, info='sentry/conv-token') 得 32-byte token → SHA-256 → conversationId（前 44 chars b64url）。`conversationFingerprint` = HMAC-SHA256(token, accountDigest 或 uid)。

## 5. Secure Conversation 與 DR
- X3DH：Initiator `x3dhInitiate(devicePriv, peerBundle)`；Responder `x3dhRespond(devicePriv, guestBundle)`。兩端持有 DR state：`rk, ckS/ckR, Ns/Nr, PN, myRatchetPriv/Pub, theirRatchetPub, pendingSendRatchet, skippedKeys`.
- Control message：`session-init` / `session-ack`（安全對話準備），狀態機 `idle → pending → ready/failed`，逾時 10s 會重送 init；連線前先檢查是否已有 receiver-ready（ckR存在）。
- DR 快照：每則訊息可寫入 `drHistory`（messageKey_b64、snapshot、snapshotAfter、messageId、ts），重播時可直接用 message key 解密並回填 snapshot。
- 送訊前必須 `ensureSecureConversationReady(peerUidHex, reason)`，缺鏈時觸發 bootstrap（guestBundle 或 prekeys bundle）。

## 6. 訊息與附件流程
### 6.1 API
- `POST /api/v1/messages/secure` body `{conversation_id, payload_envelope:{v,iv_b64,payload_b64}, id?, created_at?, uidHex, accountToken/accountDigest, conversationFingerprint?}` → {ok:true, id}。`payload_envelope` 是「conversation token AES-GCM」包的訊息物件。
- `GET /api/v1/messages/secure?conversationId=&limit=&cursorTs=` headers `X-Uid-Hex`, `X-Account-Token`/`X-Account-Digest`, `X-Conversation-Fingerprint`.
- `POST /api/v1/messages/secure/delete-conversation` body `buildAccountPayload({conversationId, conversationFingerprint})`。
- 傳統媒體索引：`POST /api/v1/messages`（legacy，含 aead/header）仍可用於 R2 物件索引。

### 6.2 Conversation Payload 內容（`payload_envelope` 解開後）
- `hdr_b64`: DR header（含 `dr, ek_pub_b64, pn, n, iv_b64`）。
- `ct_b64`: DR ciphertext（base64url）。
- `meta`: `{ ts, msg_type?, media?, sender_fingerprint?, preview? }`
  - `msg_type`: control / text / call-log …（透過 `secure-conversation-signals`）。
  - `media`: 若為附件，含 `{object_key, envelope, size, content_type, preview{object_key,envelope,size,width,height}}`，並保存於 `saveEnvelopeMeta(objectKey, envelope)`.

### 6.3 送出文字
1. 以 DR state `drEncryptText(state, plaintext)` → `{aead:'aes-256-gcm', header, iv_b64, ciphertext_b64, message_key_b64}`。  
2. 以 conversation token AES-GCM 包成 `{hdr_b64, ct_b64, meta:{ts, msg_type:'text', sender_fingerprint}}` → `payload_envelope`。  
3. `POST /api/v1/messages/secure`，必要時帶 `conversationFingerprint`。

### 6.4 接收/解密
1. 取得列表後依時間排序；以 `conversation token` 解封。  
2. 若 `drHistory` 命中 messageKey，優先用 messageKey 解密並套用 snapshotAfter；否則以 live DR 解。  
3. 成功解密後記錄 `drHistory`（含 messageKey_b64）並 persist snapshot + contactSecrets。

### 6.5 附件 / Drive
- 加密：MK 派生 AES-GCM；`encryptAndPutWithProgress` 產生 envelope（含 key、iv、aead、sha256）；可附 preview（縮圖同流程）。
- 上傳：`POST /api/v1/media/sign-put {convId, contentType, size?, dir?, direction?, uidHex, accountToken/accountDigest, conversationFingerprint?}` → {upload:{url,method,headers/fields}, objectPath, expiresIn}；將密文 PUT 至 R2。Drive 目錄命名 `drive-<accountDigest>`，dir 可多層。
- 索引訊息：`POST /api/v1/messages {convId, type:'media', ciphertext_b64, aead:'aes-256-gcm', header:{obj, size, preview?, dir, key_type?}, uidHex, accountToken/accountDigest, conversationFingerprint?}` 或直接寫入 secure payload meta.media。
- 下載：`POST /api/v1/media/sign-get {key, uidHex, accountToken/accountDigest, conversationFingerprint?}` → 短期 GET URL；下載後用 envelope 解密。支援共享金鑰（`key_type`）與 MK。
- 清除：`POST /api/v1/messages/delete {conversationId, ids?, keys?, accountToken/accountDigest}`。
 - 伺服端限制：預設最大上傳 500MB（`UPLOAD_MAX_BYTES`），Drive 系統資料夾配額預設 3GB（`DRIVE_QUOTA_BYTES`）；超量會回 HTTP 413 或拒絕。

## 7. WebSocket 實時事件
- 取得 token：`POST /api/v1/ws/token {uidHex, accountToken/accountDigest}` → `{token}`。
- 連線 `/ws`，先送 `{type:'auth', uid, token}`，回 `{type:'auth', ok, exp}`。
- 支援訊息：
  - `secure-message`: {conversationId, preview, ts, count, senderUid}（收到後去拉列表）
  - `contact-share`: {fromUid, inviteId, envelope}
  - `contact-removed`: {peerUid}
  - `contacts-reload`
  - `presence`: 需先送 `{type:'presence-subscribe', uids:[...]}`；server 會推播 `online` 清單
  - 通話信令：`call-invite/ringing/accept/reject/cancel/busy/end/ice-candidate/call-media-update/offer/answer`，每則含 `callId, fromUid, toUid, payload, traceId?`
- Server 會鎖同時通話：若對方忙或自己已有 call lock，invite 會回 `CALL_TARGET_BUSY/CALL_ALREADY_IN_PROGRESS`。

## 8. 通話（Voice/Video）
- API：`/api/v1/calls/{invite,cancel,ack,report-metrics,turn-credentials}`，`GET /api/v1/calls/:id`。皆需 `uidHex + accountToken/accountDigest`。
- Signaling 走 WebSocket，並寫入 `call_events`：caller/ callee 皆會收到 mirror payload。
- Call Key Envelope（Swift `docs/ios/CallSchemas.swift`）：
  - `CallKeyEnvelope`: `{type:'call-key-envelope', version, callId(UUID), epoch, cmkSalt, cmkProof, media:CallMediaDescriptor, capabilities?, metadata?, createdAt, expiresAt?}`
  - `CallMediaDescriptor`: audio/video/screenshare toggles（codec, bitrate, resolution, fps…），預設 audio: Opus 32kbps, video: VP8 540p@30, screenshare: VP9。
  - `CallMediaCapability`: 是否支援 audio/video/screenshare/insertableStreams/sframe、平台、max bitrate。
  - `CallMediaState`: 跟蹤 `status (idle/key_pending/ready/rotating/failed)`, `derivedKeys`(audioTx/Rx/videoTx/Rx), `frameCounters`, `rotateIntervalMs`(>=30s)，可套用 `apply(envelope:)`。
- Media 加密：使用 Insertable Streams，透過 CMK (call master key) HKDF 產生音訊/視訊 TX/RX 金鑰；Key Envelope 透過 DR 控制訊息交換並定期 rotate。
- TURN：`POST /api/v1/calls/turn-credentials {ttlSeconds?}` → STUN/TURN 清單（環境變數 `TURN_*`）。網路設定模板見 `web/src/shared/calls/network-config.json`。
- UI/體驗重點（取自 `docs/encrypted-calls-ui.md`）：
  - 畫面：撥號、來電、通話中（語音/視訊）、鎖屏/PIP。背景模糊對方頭像，掛斷紅色主鍵，控制列圓形 56px、間距 12px。
  - 動畫：撥號顯示「正在建立加密通道…」；接聽後「載入密鑰」。
  - 權限：麥克風/相機導引，缺權限時顯示警告與捷徑；iOS 使用 CallKit + PushKit，音訊類別 `PlayAndRecord`，監聽 route change。

## 9. 設定與其他功能
- 設定（存後端）：`settings-<accountDigest>` 以 MK AES-GCM 包 `{ showOnlineStatus, autoLogoutOnBackground(true), autoLogoutRedirectMode('default'|'custom'), autoLogoutCustomUrl }`。
- 自動登出：背景或 reload 觸發 `secureLogout()`，流程：flush DR snapshots → `persistContactSecrets` → 清掉 session/local/indexedDB → 導向 logout 頁或自訂 URL。
- Contact Secrets 备份：`POST /api/v1/contact-secrets/backup {payload, checksum, snapshotVersion, entries, updatedAt, bytes, deviceLabel?, deviceId?, reason?}`；`GET /api/v1/contact-secrets/backup?limit=&version=` 取最新。404 表示伺服端未啟用，可忽略。
- Dev / Debug：`REMOTE_CONSOLE_ENABLED` 可讓前端上報 console；iOS 可選擇在 Debug build 送 `/api/v1/debug/console`.

## 10. UI 分頁與元件（全頁拆解）
整體風格：深色漸層背景 `#0f172a→#1e293b`，動作色 `#22d3ee`，通話色 `#a855f7`，錯誤 `#ef4444`。字體建議 SF Pro（正文）+ Nunito（標題），動態字體啟用。所有按鈕預設圓角 12、主動作填滿、次要描邊，陰影適度。

- **Login 頁（login.html）**
  - 區塊：NFC/SDM 感應卡片（顯示 UID/Counter/CMAC 或 loading 動畫）、OPAQUE 進度條、錯誤提示條、登入步驟 checklist（SDM→OPAQUE→MK→Device→Contacts）。
  - UID 圖像：若尚未有頭像，依 UID 產生 identicon（前端已有 `identicon` 工具）；顯示於頂部圓形框，成功登入後也作為預設頭像上傳。
  - 控制：重新掃描、顯示 debug checksum、remote console 開關、reduced-motion fallback。
  - Handoff：登入完成提示交棒內容（MK 來源、contactSecrets bytes、wrapped_dev 是否存在），提供「進入 App」按鈕。

- **App Shell（app.html）**
  - 元件：頂部狀態區（網路/安全提示、版本資訊入口）、底部導覽（Contacts / Messages / Drive / Profile；含 badge）、全域 toast、modal/backdrop、媒體權限 overlay、logout redirect cover。
  - 安全對話提示：`session-init` / `session-ack` Modal，顯示「建立安全對話」/「失敗」與重試。

- **Contacts 分頁**
  - 清單：好友卡片（頭像、暱稱、狀態/最後上線、加密狀態 badge）、支援左滑刪除（呼叫 `/friends/delete`），自我聯絡項隱藏。
  - Invite：浮動主動作「+」→ 選擇 QR / 文字碼；顯示 invite 倒數、重新生成；owner contact envelope 會自動上傳。
  - 接受邀請：掃描/貼上後顯示「正在取得 prekeys / 建立安全對話」進度；若需要 session bootstrap 顯示提示。
  - Contact 更新：顯示「正在同步暱稱/頭像」小提示；WS `contact-share` 到達時局部刷新卡片。

- **Messages 分頁（列表）**
  - 對話列：頭像、暱稱、最後訊息預覽、時間戳、未讀 badge；安全狀態 badge（Ready/Building/Failed）。
  - 刪除：長按或滑動顯示刪除列，觸發 `/messages/secure/delete-conversation`。
  - 重新整理：下拉重載 `contactSecrets` + secure message cursor。

- **Conversation Thread（會話內頁）**
  - 標頭：好友頭像、暱稱、安全狀態（鎖圖示 + 文案）、通話捷徑（語音/視訊），返回按鈕。
  - 泡泡：左右對齊（incoming/outgoing），顯示時間、已讀（可由收到對方回送或 presence 推算）、安全提示（DR 重建時顯示「重播中」）。
  - 附件：預覽卡（檔名、大小、縮圖），下載進度條，完成後顯示 SHA-256 驗證結果；失敗時提供重試按鈕。
  - 控制訊息：session-init/ack、call-log、系統提示以灰色氣泡置中顯示。
  - Composer：文字輸入、附件按鈕（相機/檔案/照片庫）、發送鍵；無 DR Ready 時鎖定並顯示提示。

- **Drive 分頁**
  - 資料夾列：使用者自訂資料夾 + 系統 `drive-<digest>`，顯示容量進度條（預設 3GB）。
  - 檔案項目：名稱、大小、更新時間、方向（已傳送/已接收）；動作：預覽、重新上傳、刪除；支援子資料夾 breadcrumb。
  - 上傳流程：顯示加密→上傳進度，完成後提示索引寫入成功。

- **Profile / Settings 分頁**
  - 資訊：UID、AccountDigest、上次登入時間、裝置標籤；頭像更換（內建 identicon fallback）。
  - 設定：`showOnlineStatus`、`autoLogoutOnBackground`、`autoLogoutRedirectMode`（含自訂 URL 輸入驗證）、遠端 console 開關。
  - 備份：顯示 contactSecrets snapshot 大小、最後備份時間，手動「立即備份」按鈕；wrapped_dev/ wrapped_mk 狀態。
  - 登出：顯示紅色呼吸背景的 confirm modal，說明會清除快取並導向 logout 頁。

- **Media / Permission Overlay**
  - 麥克風/相機授權導引：顯示目前權限狀態、提示前往設定；提供「我已授權」自我回報；背景輪詢 permission + enumerateDevices，自動關閉。
  - 下載/上傳進度提示：全域條形或 toast 形式，顯示百分比與剩餘時間估計。

- **通話 Overlay**
  - 狀態：撥號（Connecting/Ringing）、來電（接聽/拒接/訊息回覆）、通話中（語音/視訊）、Rekeying/弱網提示。
  - 控制列：靜音、擴音/音訊路徑、視訊開關、螢幕分享（預留）、掛斷；圓形 56px，按下縮放 0.95。
  - 視訊：遠端全螢幕 + 本地浮動預覽，雙擊切換鏡頭；PIP 狀態縮圖（如使用 CallKit / 系統 PIP）。
  - 鎖屏/背景：顯示簡化卡片與掛斷；弱網或重連時顯示提示，並可降級純語音。

- **Logout / Error**
  - Logout 頁：紅色護盾呼吸動畫、文案提示；顯示自動登出原因（背景、reload、自訂 redirect）。
  - Error Modal：顯示 API 失敗或解密錯誤，提供「重試 / 回報」；DR 解密錯誤可提示「重播訊息」。

## 12. 實作格式備忘
- **Conversation Fingerprint**：`fingerprint = HMAC-SHA256(conversationToken, accountDigest 或 uidHex)`（base64url）；REST header `X-Conversation-Fingerprint`。
- **Payload Envelope（secure message）**：
  - 外層：`{v:1, iv_b64, payload_b64}` 用 conversation token AES-GCM 包裝。
  - 內層 payload：`{hdr_b64, ct_b64, meta}`；`hdr_b64` 是 DR header（含 `dr, ek_pub_b64, pn, n, iv_b64`），`ct_b64` 是 DR ciphertext（b64url），`meta` 自由欄位（至少有 `ts`，可含 `msg_type`, `media`, `sender_fingerprint`）。
- **Device/Prekey Bundle**：
  - 發佈：`{ik_pub, spk_pub, spk_sig, opks:[{id, pub}]}`；replenish 可只送 `opks`。
  - 取得：`{ik_pub, spk_pub, spk_sig, opk?}`；Responder guest bundle另含 `ek_pub`。
- **連線與逾時**：
  - OPAQUE 期望 ke1/ke2/ke3 長度需符合 opaque-ts；session TTL 60s；WebSocket call lock TTL 預設 120s。
  - Secure conversation `session-init` 逾時 10s 重送，最多 3 次；未 ready 時阻擋輸入。

## 13. 限制與錯誤碼備忘
- **HTTP 狀態**：驗證失敗 401/403，缺權限 400/409，Worker 失敗多回 502；`/devkeys/fetch` 404 代表無備份；超過上傳限制 413。
- **裝置金鑰策略**：解包 `wrapped_dev` 失敗時不應默默重建並覆蓋伺服端，除非確定備份遺失；若補貨失敗需回報錯誤給使用者。
- **媒體路徑與配額**：系統資料夾固定為 `已傳送` / `已接收`，上傳 key 形如 `<conversationId>/<系統資料夾>/<dir?>/<uid>`；預設配額 3GB/會話（env 可改），超量需提示。
- **自動登出**：即使關閉 `autoLogoutOnBackground`，若 App 頁面被 reload 仍強制 `secureLogout()` 並導向 logout；背景登出需在回前景時檢查 snapshot 是否已 flush。
- **Cache/儲存**：MK/DR/裝置私鑰僅在記憶體；`wrapped_mk`/`wrapped_dev`/contactSecrets snapshot 才能落 Keychain/檔案；避免把明文或 DR state 存檔。
- **WS 呼叫鎖**：同一 UID 同時間只能有一通 active call，invite 時若鎖住會收到 `CALL_TARGET_BUSY` 或 `CALL_ALREADY_IN_PROGRESS`；call-end/cancel/reject 會釋放鎖。

## 11. 開發與測試建議
- 模組化：將「密碼學 + 狀態」獨立 Swift Package，UI/Networking 分開，方便以純 Swift 單元測試 Double Ratchet、conversation envelope、Argon2id 包裝。
- 測試案例（可仿照 Node scripts）：登入流程（SDM→OPAQUE→MK store）、好友互邀、雙向訊息 + 重登入 replay、附件上傳/下載 SHA-256 驗證、Call invite→accept→cancel。
- 例外處理：任何解密失敗需保留 `dr-debug` 紀錄（messageId, header, snapshotBefore/After, error）供重播；API 403/409 時提示使用者並保留 retriable 任務。
- 安全：前景/背景切換若 `autoLogoutOnBackground=true` 立即執行 `secureLogout`；Crash/終止時在下次啟動檢查是否存在未 flush 的 snapshot，必要時拒絕自動登入並要求重新掃描。

---
如需對照後端細節，可查看 `docs/encrypted-calls-*.md`（通話）、`web/src/app/features/*`（Web 邏輯）、`src/controllers/*`（API 契約）。本指南覆蓋 iOS 必要流程，足以讓另一個 Codex/開發者在獨立 Workspace 完成實作。
