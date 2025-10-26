# SENTRY Message — 技術筆記

SENTRY Message 是一套以 **NTAG424 SDM** 與 **前端零知識密鑰管理** 為核心的訊息原型。下列內容整理專案目錄、系統架構、加密流程與好友邀請機制，方便技術維護與後續擴充。

---

## 專案目錄結構

```
.
├─ package.json            # Node API（Express + WebSocket）
├─ src/                    # 伺服端程式碼
│  ├─ routes/              # REST API（auth/media/friends/prekeys/...）
│  ├─ controllers/         # 業務邏輯（messages、friends 等）
│  ├─ ws/                  # WebSocket server（presence、contact-share）
│  ├─ middlewares/         # async helper、速率限制…
│  └─ utils/               # HMAC、logger、S3/R2 包裝
├─ data-worker/            # Cloudflare Worker + D1 schema，負責儲存索引
│  ├─ src/worker.js        # HMAC 驗證、D1 CRUD、friends invite logic
│  └─ migrations/          # D1 資料表定義
└─ web/                    # 前端（Pages 專案）
   ├─ src/app/             # ESM 模組
   │  ├─ core/             # 共用 store、HTTP、log
   │  ├─ crypto/           # argon2id、HKDF+AES-GCM、X3DH/DR
   │  ├─ features/         # login-flow、media、profile、settings、sdm
   │  └─ ui/               # login/app 綁定邏輯與行為
   └─ pages/               # login.html / app.html（行動優先 UI）
```

---

## 系統架構


| 元件                                | 職責                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **前端 (web)**                      | 以 ESM 模組管理狀態與加密；登入頁完成 SDM 驗證與 MK 解封，App 頁提供檔案、好友、設定等 UI。                                         |
| **Node API (src)**                  | 驗證 SDM、管理媒體索引、預簽 URL、devkeys/ prekeys 管理、WebSocket presence。所有敏感資料皆需前端加密後才上傳。                     |
| **Cloudflare Worker (data-worker)** | 接受 Node 端以 HMAC 簽章的請求，寫入 D1：NTAG tag 狀態、好友邀請、訊息索引、prekey 庫存等。                                         |
| **R2 (物件儲存)**                   | 儲存加密後媒體與頭像，透過`sign-put` / `sign-get` 取得短時 URL。                                                                    |
| **SessionStorage (瀏覽器)**         | 僅在登入→App 交棒時暫存`mk_b64`、`account_token`、`account_digest`（以及相容用的 `uid_hex`、`uid_digest`）；App 頁還原後立即刪除。 |

資料流概況：

1. Login 頁與 API 溝通完成 SDM 驗證與 MK 解封。
2. App 頁載入後，透過 WebSocket 與 REST API 同步聯絡人、媒體、presence；若無 MK 立即導回登入。
3. 所有加密/解密皆在前端記憶體完成；後端只見密文與索引。

---

## 端對端流程整理

以下以兩位使用者（A、B）建立好友並互傳訊息為例，整理整體系統的實際執行步驟，方便排錯與撰寫測試腳本。

### 1. 身分啟動與帳號建立

1. **SDM Debug / Exchange**

   - 呼叫 `/api/v1/auth/sdm/debug-kit` 取得測試用的 `uidHex`、`sdmmac`、`sdmcounter`。
   - 將資料送至 `/api/v1/auth/sdm/exchange`，Node 端驗證 SDM 並向 Worker 建立帳號紀錄，回傳一次性 `session`、`accountToken`、`accountDigest`、`opaqueServerId` 等。
2. **OPAQUE 註冊＋登入**

   - 使用 `@cloudflare/opaque-ts`：`register-init → register-finish → login-init → login-finish`（Node 端代理至 Worker `/d1/opaque/*`）。
   - 完成後取得長期登入所需的 password-based session。
3. **主金鑰（MK）處理**

   - 首次登入：產生 MK，呼叫 `/api/v1/mk/store` 以 Argon2 封裝並儲存。
   - 之後登入：以 OPAQUE 取得 password 解出 MK，暫存在 `sessionStorage`，App 頁載入後立即清空。

### 2. 裝置金鑰與 Prekeys

1. **設備備份**

   - 若沒有既有備份，前端產生 IK（Ed25519）、SPK（X25519 + SIG）、一批 OPKs。
   - `/api/v1/keys/publish` 將公開 prekey bundle 送往 Worker。
   - 利用 MK 加密裝置私鑰，呼叫 `/api/v1/devkeys/store` 保存。
2. **對方 prekey 取得**

   - 發起端在需要時呼叫 `/api/v1/keys/bundle` 取得對方 SPK/OPK（Worker 會消耗一支 OPK）。

### 3. 好友邀請與共享

1. **建立邀請（使用者 A）**

   - `/api/v1/friends/invite` 產生 `inviteId/secret`。
   - 產生 conversation token（HKDF(invite secret)），將個資封裝後呼叫 `/api/v1/friends/invite/contact` 儲存 owner contact envelope。
2. **接受邀請（使用者 B）**

   - 取得 `inviteId/secret` 後呼叫 `/api/v1/friends/accept`：驗證 secret → 綁定帳號 → 儲存 guest contact envelope、guest bundle → 回傳 owner contact envelope。
   - 兩端透過 WebSocket 接收 `contact-share` 事件，解密後更新 `contacts-<uid>` conversation、`contactSecrets-v1`，保留 `conversation.token` 與（若有的）`dr_init.guest_bundle`。

### 4. Double Ratchet 訊息傳遞

1. **初始化 DR 狀態**

   - 發送前檢查 `drState(peer)` 是否存在：
     - 若無且 `contactSecrets` 有 `dr_init`，呼叫 `bootstrapDrFromGuestBundle`。
     - 若仍無狀態，透過 `prekeysBundle` + `x3dhInitiate` 主動建立（消耗對方 OPK）。
2. **送出訊息**

   - `drEncryptText` 產生 header（含 `iv_b64`）與密文。

- `/api/v1/messages/secure` 送交 Node → Worker，儲存 `payload_envelope`。

3. **接收解密**
   - 透過 `/api/v1/messages/secure?conversationId=...` 或 WebSocket 取得新訊息。
   - `decryptConversationEnvelope` → 驗證 header → `drDecryptText` 還原 plaintext。
   - 若仍缺乏 DR 狀態，`ensureDrReceiverState` 會重試 bootstrap。

### 5. 媒體（如需要）

1. `encryptAndPutWithProgress` 用 MK 加密 → `/media/sign-put` 取得預簽 URL → 上傳 R2。
2. 呼叫 `/api/v1/messages` 建立媒體索引，header 記錄 R2 key 與 envelope。
3. 接收端利用 `/media/sign-get` 下載後再以 MK 解密。

---

## 測試腳本建議

為確保整個端到端流程可重現，建議撰寫專用的 Node 腳本（例如 `scripts/test-e2e-session.mjs`）涵蓋：

1. A、B 各自完成：SDM exchange → OPAQUE → MK 存取 → prekeys/devkeys。
2. A 建立 invite 並附上 contact envelope，B 接受後確認 Worker 儲存 owner/guest contact 與 `dr_init`。
3. 兩端利用 API 建立 DR state，互傳 secure message，再從 `/messages/secure` 取回並以 `drDecryptText` 驗證密文可正確解密。

這支腳本可以協助在無 UI 的情況下確認所有 API 互動是否完備，也能作為 CI 端的端對端回歸測試基礎。
**注意**：每當後端流程或資料格式更新時，請同步維護並重跑 `scripts/test-api-flow.mjs`；Playwright E2E (`npm run test:front:login`) 也必須涵蓋同樣的加密邏輯，確認最新流程完全一致且不依賴 fallback。

---

## 加密流程（更新版）

### 1. 登入與主金鑰 (MK)

1. 感應 NTAG424：取得 `uid`、`sdmmac`、`sdmcounter`（瀏覽器層僅整理為 URL 參數）。
2. `POST /api/v1/auth/sdm/exchange`：Node 以 AES‑CMAC + 變體 KDF（`src/lib/ntag424-*.js`）驗證 SDM，並要求 Worker 建立／查詢帳號。
3. 回傳一次性物件 `{ session, account_token, account_digest, uid_digest, hasMK, wrapped_mk? }`（Session 60 秒內單次使用）。
4. 前端輸入密碼後，強制進行 OPAQUE：
   - `web/src/app/features/opaque.js` 使用 `@cloudflare/opaque-ts` 與後端的 `/api/v1/auth/opaque/*` 交握（目前預期路由；Worker 端已提供 `/d1/opaque/*` 資料層）。
   - 若該帳號尚未註冊 OPAQUE，會先註冊再登入（`ensureOpaque()`）。
5. 解封／建立 MK：
   - 若 `hasMK=true` → `unwrapMKWithPasswordArgon2id` 還原 MK。
   - 若 `hasMK=false` → 產生隨機 MK → `wrapMKWithPasswordArgon2id` → `POST /api/v1/mk/store`（帶 `accountToken/accountDigest`）。
6. 交棒與清理：MK 僅存在記憶體；登入頁只用 `sessionStorage` 短暫傳遞 `mk_b64`、`account_token`、`account_digest` 到 App 頁，取用後立即刪除。

環境變數重點（不含值）：`DATA_API_HMAC`、`NTAG424_KM`、`NTAG424_KDF`、`NTAG424_SALT`、`NTAG424_INFO`、`NTAG424_KVER`、`ACCOUNT_HMAC_KEY`、`OPAQUE_OPRF_SEED`、`OPAQUE_AKE_PRIV_B64`、`OPAQUE_AKE_PUB_B64`、`OPAQUE_SERVER_ID`、`ACCOUNT_TOKEN_BYTES`。

注意：目前 Node API 尚未實作 `/api/v1/auth/opaque/*` 路由，前端已串接；請依 Worker 的 `/d1/opaque/store|fetch` 介面補上對應 proxy（見「測試 TODO」）。

### 2. 裝置金鑰與 Prekeys（X3DH/DR 前置）

1. App 啟動時，`login-flow` 會檢查裝置備份：
   - 無備份 → 產生 IK（Ed25519）/ SPK（X25519）+ SIG + 100 OPKs → `/api/v1/keys/publish`（含 `accountToken/accountDigest`）→ 以 MK 包裝後 `/api/v1/devkeys/store`。
   - 有備份 → 以 MK 解包 → 依需求補 20 支 OPKs（同樣附上帳號欄位）。
   - **Devkeys API 限制**：`/api/v1/devkeys/store|fetch` 僅接受 `accountToken`／`accountDigest`，不再允許傳 `uidHex`。若僅提供 `accountToken`，Node API 會自動以 `SHA-256(accountToken)` 產生對應 digest 後再 proxy 給 Worker，確保 UID 仍保持隱匿。
2. Worker：`/d1/prekeys/publish` 以 `account_digest` 索引 upsert IK/SPK/SPK_SIG、批次 `INSERT OR IGNORE` OPKs；`/d1/prekeys/bundle` 依對方帳號配發一支 OPK。

### 3. 訊息、聯絡與媒體的包裝

- JSON／metadata 以 `wrapWithMK_JSON` 包裝；大型檔案以 `encryptWithMK`/`decryptWithMK`（HKDF‑SHA256 → AES‑256‑GCM）。
- 內部 conversation 命名以 `acctDigest` 隱匿：
  - `drive-<acctDigest>`（資料夾名稱可再以 MK‑HMAC 片段化）
  - `profile-<acctDigest>`、`avatar-<acctDigest>`、`contacts-<acctDigest>`、`settings-<acctDigest>`
- 安全訊息：`/api/v1/messages/secure` 僅寫入 envelope 至 D1 `messages_secure`（欄位：`iv_b64`、`payload_b64`）。
- 好友聯絡卡：邀請 `secret` 經 HKDF → AES‑GCM，僅 Worker 可驗封有效性；內容仍為密文儲存。

### 4. 使用者設定

- 設定存於 `settings-<acctDigest>`，內容 `{ showOnlineStatus, autoLogoutOnBackground }`，以 MK 包裝。
- App 啟動時 `ensureSettings()`；切換即 `saveSettings()`，並受 `autoLogoutOnBackground` 控制主動清理記憶體祕密。

### 5. 加密覆蓋度（摘要）

- Login/MK：Argon2id + AES‑GCM（前端）；OPAQUE（密碼驗證，待 Node 路由補上）。
- Device keys：IK/SPK/OPKs 公鑰上傳；私鑰以 MK 包裝備份（Worker：`device_backup`）。
- Messaging：Double Ratchet（`web/src/app/crypto/dr.js`）+ 每則訊息 envelope（D1：`messages_secure`）。
- Media/Profile/Contacts/Settings：皆以 MK 衍生 AES‑GCM 包裝；R2 僅存密文；D1 僅存 envelope/索引。
- Node↔Worker：所有請求以 HMAC‑SHA256 簽章與常數時間比較驗證。

---

## 好友邀請流程

### 建立邀請（Owner 端）

1. 使用者在 App 內點「好友分享」：
   - App 呼叫 `friendsCreateInvite(uidHex)`。
   - Node 端向 Worker `/d1/friends/invite` 寫入 `{ invite_id, secret, expires_at, prekey_bundle }`。
2. 前端將邀請資訊封裝成 QR：`encodeFriendInvite({inviteId, secret, ownerUid})`。
3. 同時，App 會把自身聯絡資訊（暱稱、頭像）以 invite secret 對稱加密後呼叫 `/d1/friends/invite/contact` 儲存，方便掃描者取得 owner profile。
4. 頁面顯示：
   - QR 與倒數計時（worker 過期後會要求重新生成）。
   - 掃描模式時開啟攝影機，並透過 WebSocket 訂閱 presence。

### 掃描邀請（Guest 端）

1. 說明：掃描模式在前端解析 QR 內容後觸發 `handleInviteScan`。
2. 前端流程：
   - 驗證/解析 invite payload → 透過 Worker `/d1/friends/accept` 交握。
   - 若 owner 先前上傳過聯絡資訊，Worker 會回傳 owner 的加密封套；Guest 端以 invite secret 解開，取得暱稱/頭像。
   - 建立 X3DH：
     - 取 owner 的 IK/SPK/OPK。
     - 使用 guest 裝置金鑰計算 SharedSecret → 產生 guest bundle，回傳 Worker。
3. 接著，Guest 端把自己的聯絡資訊同樣以 invite secret 對稱加密，呼叫 `/d1/friends/invite/contact` 寫入。
4. 雙方聯絡人寫入：
   - Worker 在 `/d1/friends/accept` 內呼叫 `insertContactMessage`，將 owner/guest profile 分別寫入 `contacts-<uid>` conversation 中（密文形式）。
   - 前端監聽 WebSocket `contact-share` 或 `contacts-reload`，載入後以 MK 解密顯示。

### QR 倒數與重新生成

- 前端保留 inviter secrets 於 `sessionStorage`（`inviteSecrets-v1`），若倒數結束會自動再生成一次新邀請。
- App 關閉或登出時會清除快取，避免長時效密鑰殘留。

---

## 補充：安全預設

- App 頁若偵測畫面離開前景，且設定中 `autoLogoutOnBackground = true`（預設），會立即呼叫 `secureLogout()` 清空所有記憶體狀態並顯示安全提醒。
- 所有 WebSocket 事件在連線關閉時會清除 presence 狀態並嘗試重連。
- 任何敏感欄位都於登入時顯示提示：「請重新感應晶片」。

如需進一步的 API 位址或開發環境設定，請參考 `src/` 內各路由與 `data-worker/` 的 D1 schema。

---

## 營運流程：清除雲端資料並重新部署

下列步驟僅適用於正式環境重置／重新部署。請務必確認 `.env` 已設定正確的 R2 連線資訊（`S3_ENDPOINT` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_BUCKET`），並在執行前匯出 Cloudflare 帳號 ID：

```bash
export CLOUDFLARE_ACCOUNT_ID=436a742b2a3f99a70289f00ca8688b8e
```

### 1. 清除 Cloudflare D1 與 R2

腳本會透過 Wrangler 連線到遠端 D1，對主要資料表執行 `DELETE`，同時以 AWS CLI 相容介面清空 R2 bucket：

```bash
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID \
  ./scripts/cleanup/wipe-all.sh
```

成功執行後會看到 `D1 清除完成`、`R2 清除完成` 的提示。若 Wrangler 顯示 `Unexpected fields ... "account_id"` 等警告，可忽略（舊版設定格式）。

### 2. 重新部署 Worker / API / Pages

重新部署時使用整合腳本一次處理 Cloudflare Worker、D1 migration、Node API（pm2）以及 Pages 靜態網站。建議同步執行遠端 migration 以恢復資料表 schema：

```bash
bash ./scripts/deploy-prod.sh --apply-migrations
```

腳本會依序：

- `wrangler deploy` → 發佈 `data-worker`
- `wrangler d1 migrations apply message_db --remote` → 套用最新 migration
- `npm ci && pm2 reload message-api --update-env` → 更新 Node API
- `wrangler pages deploy ./src --project-name message-web --branch=production` → 佈署 Cloudflare Pages

執行完成後，終端機會顯示 Pages 部署網址與 API 健康檢查指令，可依提示驗證。

如需部分部署或在新 session 自動化執行，請依實際修改範圍選擇指令：


| 修改範圍                                        | 指令範例                                                        | 備註                                       |
| ----------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| Node API（`src/`、`scripts/` 等後端檔案）       | `bash ./scripts/deploy-prod.sh --skip-worker --skip-pages`      | 僅重新安裝依賴並透過 PM2 reload            |
| Cloudflare Worker / D1 schema（`data-worker/`） | `bash ./scripts/deploy-prod.sh --apply-migrations --skip-pages` | 若變更 schema 記得保留`--apply-migrations` |
| 前端（`web/`）                                  | `bash ./scripts/deploy-prod.sh --skip-worker --skip-api`        | 只重新部署 Pages（會保留後端現況）         |

部署後可使用腳本尾端提示的 `curl` 指令，快速檢查 API / Pages 是否恢復正常。

> **新 session 提醒**：Codex 重新啟動時，請先閱讀 `Prompt.md`，再回到本檔查閱架構、測試與部署章節。遵循 SOP：先開發 → 跑四項測試 → 視修改範圍部署 → 驗證健康檢查 → 回報結果。

---

## 目前狀態與待處理事項（2025-04-10）

- **登入頁資料清理行為已調整**：`web/src/app/ui/login-ui.js` 現在只移除我們種下的 key，並支援 `window.__LOGIN_SEED_LOCALSTORAGE` 在頁面初始化後重新寫回 `localStorage`。Playwright `performLogin`、`full-flow` 亦改用此機制，若新增測試前置資料，請走同樣流程。
- **E2E 現況**：`npm run test:front:login` 中的 `app-operations`、`login` 測試已通過，`full-flow` 仍失敗。

  - 暱稱更新時呼叫 `/api/v1/friends/contact/share` 會回傳 `Forbidden: sender not part of invite`，導致對方裝置看不到新暱稱。請檢查 Worker 對 invite 的存活條件，或調整 fallback 行為。
  - 刪除好友後在 mobile 佈局中 `#btnUserMenu` 會暫時 hidden，Playwright 無法觸發登出。需檢查 UI 狀態（可能要在切回 drive 後等待列印完成，或直接操作其他可見元素）。
  - 新增的 Playwright `full-flow` 段落（A、B 互傳多筆文字訊息後雙方登出再登入）重現嚴重問題：重新登入後 `messagesRendered` 為空陣列，舊訊息全部無法解密顯示，實際手機測試亦會發生。推測與 DR state 或 `contactSecrets` 還原流程在重登入時失敗有關，需優先除錯。
  - 2025-10-27：已實作 wrapped_dev session handoff（登入頁將最新 device backup 暫存至 `sessionStorage`，App 載入時直接以 MK 解包），重新登入時不再觸發 `/devkeys/fetch` 404。但 `full-flow` 仍在「B 重登入測試」的第一則訊息卡住（UI 顯示「部分訊息無法解密」），代表 DR snapshot/ratchet 還原仍失敗；需比對 `contactSecrets-v1` 是否同步寫入最新 `drState/drHistory`，並檢查 `recoverDrState()` 對 responder 角色的 bootstrap 流程。
  - 2025-10-27（晚間）：`contact-secrets` 新增 Automation Debug log，已確認 owner/guest 兩端的 snapshot 與 history 都會更新，但 Playwright `full-flow` 仍在多則訊息（尚未重登入）階段觸發 `drDecryptText → OperationError`。`dr-state-before-message` 顯示 `Nr` 未前進，推測 history cursor 仍會在相同 timestamp 下回復舊 snapshot。下一步需增加 snapshot key（例如 messageId 或自增序）避免同秒訊息互相覆寫，並於 `recoverDrState` / `prepareDrForMessage` 中優先使用最新 entry。
  - 2025-10-27（深夜）：已實作 `messageId + timestamp` 為 DR history 游標、`contactSecrets` 也會持久化 `drHistoryCursorId`。目前 `full-flow` 測試仍於第 1 輪訊息中斷，`[dr-state-B-before-decrypt]` 顯示 `Nr=1` 但 decrypt 仍失敗，推測 `recoverDrState()` 在 `ensureDrReceiverState()` 之後仍可能覆蓋 receive-chain，需要進一步追蹤 `recordDrMessageHistory` / `prepareDrForMessage` 的觸發時序。
  - 2025-10-27（深夜續）：「訊息重複 decrypt」問題已加入 `messageId` 去重，但 `full-flow` 仍會在第一次訊息就 `OperationError`，console 可見 `[dr-skip-duplicate]`、`[dr-history-log]` 交錯，顯示 UI 在尚未渲染完成前就再次觸發 `listSecureAndDecrypt`。需再追蹤 `messagesPane` 的 refresh 時機，避免真正首次 decrypt 被視為 duplicate。

  **首要處理目標（2025-04-10）**

  - [X]  重新執行 `npx playwright test tests/e2e/full-flow.spec.mjs --project=chromium-mobile`，收集 console 與 request log，確認重新登入後大量 `OperationError` 來自 DR state 遺失。
  - [x]  登入流程完成後，利用 `contactSecrets-v1` 快照還原最新的 Double Ratchet snapshot（含 seed），確保拉取 secure messages 前 state 已成對。
  - [x]  若快照缺失或落後，依 `conversation.dr_init` guest bundle 重新 bootstrap DR，並同步更新 `contactSecrets` 內的快照。
  - [x]  每次成功解密訊息時即時更新並持久化 DR 快照／seed，避免登出再登入後 state 回到舊值。
  - [ ]  移除自動補 prekey / devkeys 的 workaround（`login-flow.js`、`dr-session.js`、`share-controller.js` 等），改為直接回報缺件錯誤，方便追蹤根因。
  - [ ]  完成上述修正後重跑 `npx playwright test tests/e2e/full-flow.spec.mjs --project=chromium-mobile`，確認 E2E 全綠。
- **除錯提示**：

  - Worker 狀態可用 `npx wrangler d1 execute message_db --remote --command "SELECT invite_id, owner_uid, guest_uid FROM friend_invites"` 快速檢查 owner/guest 映射。
  - `friendsShareContactUpdate` 暫時加入 `console.log('[contact-share-request|error]')`，觀察送出的 inviteId / sender。
  - 若 Playwright 報 `EADDRINUSE :8788`，記得 `lsof -i :8788` 後 `kill -9 <PID>` 再執行測試。
- **最新進度（2025-10-10）**

  - `devkeys` API 目前僅接受 `accountToken/accountDigest`，若僅提供 token 會由 Node API 端重新計算 digest；前端、腳本與 Worker proxy 均已同步移除 `uidHex` 參數。
  - Playwright `tests/e2e/full-flow.spec.mjs` 仍在第一輪訊息就失敗：B 端 `drDecryptText` 報 `OperationError`，log 顯示 `dr-state` 仍缺少對應的 receive chain；下一步須追查 `ensureDrReceiverState`／DR snapshot 在初次登入時的還原流程，並驗證 message key 派生是否與 sender 相符。
  - TODO：1) 以 log 中的 `ckS/ckR` 重現 DR 派生，鎖定不一致原因；2) 調整 `messages`/DR 初始化時序，確保 B 端可在拉訊息前建立成功的 DR state；3) 啟動 API 後重跑 `npx playwright test tests/e2e/full-flow.spec.mjs --project=chromium-mobile` 及相關 API 腳本驗證。
- **最新進度（2025-10-28）**

  - 重新整理裝置私鑰 handoff 流程：`ensureDevicePrivAvailable()` 會先套用 sessionStorage 交棒，再等待登入頁設定 store，若仍未取得才呼叫 `/api/v1/devkeys/fetch` 讀取既有備份，完全移除自動重建 prekey 的 fallback。
  - 自動化腳本結果：`npm run test:prekeys-devkeys`、`npm run test:messages-secure`、`npm run test:friends-messages`、`npm run test:login-flow` 全數通過；`npm run test:front:login` 中的 `app-operations`、`login` 也通過，但 `full-flow` 仍失敗。
  - `full-flow` 失敗點更新：已移除 secure messages 的全域去重機制，第一輪訊息已可成功渲染；目前卡在重登入後的訊息互通，log 顯示登出 handoff 後 `contactSecrets-v1` 仍可能為空（`restore-skip storage-empty`），導致重新登入時 DR snapshot 遺失、`drDecryptText` 報 `OperationError`。需完成 contact-secrets 的 logout→login handoff 與重新載入流程。
  - 2025-10-28（晚間）：`web/src/app/features/messages.js` 現在會根據 `created_at`/`messageId` 重新排序後才逐一解密，並新增 `mutateState=false` 模式（`messages-pane` 的預覽刷新改用此路徑）以避免背景載入覆寫 DR snapshot。雖然改善了首輪訊息重複 decrypt 的情況，`npx playwright test tests/e2e/full-flow.spec.mjs --project=chromium-mobile` 仍在重登入後第一則訊息（例：`A重登入測試-*`）發生 `drDecryptText → OperationError`，log 顯示 receiver 端 `theirRatchetPub` 仍落在舊值。下一步需追蹤重登入後有哪些流程仍以 `mutateState=true` 重播舊訊息，或在「對話開啟時」鎖定單一資料來源，避免 cursor 被倒帶。
  - 2025-10-28（深夜）：`messages.js` 對前景載入新增 DR 去重快取、歷史訊息改為只讀模式，避免 append 時回滾 snapshot；`dr-session.js` 的 `prepareDrForMessage` 亦加入 timestamp/cursor 判斷與 duplicate log。`full-flow` 已可穩定通過多輪往返訊息，但在 Playwright 的「登出 → 重登入」階段仍失敗：A 端 relogin 後 `drState` 為空，顯示 `contactSecrets-v1` handoff 仍是舊資料（log 只有 502 bytes）。需補上 logout→login 的 snapshot 檢查（記錄 local/session bytes）並查明為何 `purgeLoginStorage()` 沒有採用最新快照。
- **最新進度（2025-10-26）**

  - Login 頁於清除 `localStorage` 前會自動備份/回寫 `contactSecrets-v1`，避免 QA 透過 `__LOGIN_SEED_LOCALSTORAGE` 注入的 DR snapshot 在重新登入時遺失。
  - `share-controller` 不再覆寫既有 `contactSecret.role`，防止 owner 端資料廣播時把 guest 端角色意外改成 owner/responder。
  - `dr-session.js`／`messages.js` 增加 snapshot 還原與 `dr-debug`/`dr-send` 詳細紀錄，當 `OperationError` 發生時會先回滾快照再嘗試 `recoverDrState`，並輸出 `rk/ckS/ckR/theirRatchetPub` 供比對。
  - 仍未解決重新登入後的 DR 收訊問題：`tests/e2e/full-flow.spec.mjs --project=chromium-mobile` 每次都卡在 B 端首則訊息無法解密（`OperationError`）。`[dr-send]` 顯示 sender 端已成功 ratchet，`[dr-debug]` 則指出 receiver 的 snapshot `theirRatchetPub` 仍停留在初次 bootstrap 的 initiator pub，導致 header `ek_pub_b64` 不匹配。這代表 responder 角色在恢復時沒有正確採用最新 guest bundle/快照，需要進一步追查 `recoverDrState` 與 `contactSecrets` 儲存流程。
- **下一步建議 / 工作清單**（完成後請在 README 勾選）：

  1. ~~修復 `contact/share` 403（確認 invite 刪除時機或允許 owner fallback）。~~
  2. ~~調整好友刪除 → 登出流程，確保 UI 有可點擊的 user menu。~~
  3. ~~重跑 `npx playwright test tests/e2e/full-flow.spec.mjs` 與 `npm run test:front:login` 確認全數通過。~~

  4. [X]  實作端對端檔案傳輸（文字訊息以外的圖片 / 影片 / 一般檔案），確保全程加密並強制 500 MB 以內。（完成：聊天視窗支援附件加密上傳 / 下載）
  5. [ ]  更新 Node API、Worker、R2 儲存策略：建立「已傳送的檔案」「已接收的檔案」固定資料夾，並確保 500 MB 限制與密文儲存。（進行中）
  6. [ ]  前端 UI：聊天介面新增選檔 / 預覽 / 上傳進度，Drive 顯示兩個系統資料夾與相關操作。（尚未開始）
   7. [ ]  建立 / 擴充 E2E 測試（Playwright）覆蓋檔案傳送、接收、Drive 同步、下載驗證；缺測試時補上。（尚未開始）
  8. [ ]  DR snapshot 還原：實作 messageId-based history cursor、防止同時間戳覆寫，並重新驗證 `tests/e2e/full-flow.spec.mjs`。（已加上 messageId 游標，仍需排查首輪 decrypt 失敗 & UI 重複 fetch）
  9. [ ]  追蹤 `messages-pane` 在首次載入時的 duplicate 判斷（`[dr-skip-duplicate]`），調整 `messages.js` / `recordDrMessageHistory` 的去重條件與 cursor 更新時序，確保第一則訊息不會被誤判，修復後重跑 `npx playwright test tests/e2e/full-flow.spec.mjs --project=chromium-mobile`。
  10. [ ]  完成 `contactSecrets-v1` 的 logout→login handoff：logout 時確實寫入 sessionStorage，login `purge`/App 初始化可回填 localStorage，避免重新登入時 `restoreContactSecrets()` 為空並導致 DR state 遺失，修復後重跑 `full-flow`。
  11. [ ]  調整 `listSecureAndDecrypt` 在多處呼叫時的狀態隔離：僅允許「開啟中的對話」以 `mutateState=true` 更新 DR snapshot，其餘背景刷新一律使用 snapshot clone，並加入 log/guard 以偵測重複回朔，確認重登入後 `theirRatchetPub` 不再被舊封包覆蓋。
  12. [ ]  追蹤 logout→login seed 實際長度：登入頁 `purgeLoginStorage()` 已紀錄 `login-session-snapshot` bytes，但實際 relogin 仍只看到 502 bytes；需進一步比較 logout 時 local/session bytes 與登入時採用的 seed，確保最新 `drState` 會同步到 `contactSecrets-v1`，並提供 checksum 以利 QA 驗證。


## 自動化測試腳本（給協作與驗收用）

這些腳本是給開發者自用的端到端（E2E）驗證工具，用來快速檢查雲端端點與資料流程是否正常。請先確認：

- Node API `.env` 已填妥（`DATA_API_URL`、`DATA_API_HMAC` 等）。
- Worker 已部署且 D1 可用（`wrangler deploy`、`wrangler d1 migrations apply`）。
- 以環境變數 `ORIGIN_API` 指定要測試的 API 來源（預設 `http://127.0.0.1:3000`）。

可用腳本

- `npm run test:prekeys-devkeys`

  - 路徑：`scripts/test-prekeys-devkeys.mjs`
  - 內容：SDM debug-kit → Exchange → `/api/v1/keys/publish`（IK/SPK/SPK_SIG + OPKs）→ `/api/v1/devkeys/store`（假 envelope）→ `/api/v1/devkeys/fetch`
  - 期望：publish/store 皆 204，fetch 回傳 `wrapped_dev`
- `npm run test:messages-secure`

  - 路徑：`scripts/test-messages-secure.mjs`
  - 內容：SDM debug-kit → Exchange → `/api/v1/messages/secure` 建立 envelope → `/api/v1/messages/secure?conversationId=` 列出
  - 期望：create 202；list 至少一筆
- `npm run test:friends-messages`

  - 路徑：`scripts/test-friends-messages.mjs`
  - 內容：兩位模擬用戶分別註冊→登入→建立好友邀請→受邀方加入→雙向傳送隱匿訊息並解密驗證
  - 需求：需先啟動 Node API；可透過 `ORIGIN_API` 指定目標環境（預設 `http://127.0.0.1:3000`）
- `npm run test:login-flow`

  - 路徑：`scripts/test-login-flow.mjs`
  - 內容：debug-kit → Exchange → OPAQUE（無紀錄則註冊）→ 首次 `/api/v1/mk/store` → 再 Exchange 應 `hasMK=true` → 再次 OPAQUE login
  - 參數：可用 `--uid <UIDHEX>` 固定測試 UID；`ORIGIN_API` 指定 API
  - 備註：若 OPAQUE 路由尚未完整，可能回 `RecordNotFound` 或 base64 解析錯誤；建議用前端 `ensureOpaque()` 路徑（會自動註冊再登入）或完成後端路由再跑此腳本。
- `npm run test:front:login`

  - 路徑：`tests/e2e/*.spec.mjs`（Playwright）
  - 前置：自動清除上一輪的 E2E 截圖、Playwright report 與暫存測試資料，再重建測試用帳號
  - 內容：登入後依序驗證暱稱同步、頭像更換、檔案上傳/刪除、雙向訊息讀寫、對話刪除（雙邊同步保留聯絡人）、聯絡人刪除與登出
  - 截圖：關鍵步驟輸出至 `artifacts/e2e/screens/`，供驗收留存
  - 需求：本機 API 需先啟動（例：`NODE_ENV=development node src/server.js`）；首次可跑 `npx playwright install --with-deps`
  - 參數：以 `ORIGIN_API` 指定 API；預設使用 `http://127.0.0.1:3000`

執行範例

```bash
# 本機 API
ORIGIN_API=http://127.0.0.1:3000 npm run test:prekeys-devkeys
ORIGIN_API=http://127.0.0.1:3000 npm run test:messages-secure

# 線上 API
ORIGIN_API=https://api.message.sentry.red npm run test:prekeys-devkeys
ORIGIN_API=https://api.message.sentry.red npm run test:messages-secure

# 登入流程（可選，待 OPAQUE 路由穩定）
ORIGIN_API=https://api.message.sentry.red npm run test:login-flow

# 前端 E2E 登入（需本機 API）
NODE_ENV=development node src/server.js &
API_PID=$!
ORIGIN_API=http://127.0.0.1:3000 npm run test:front:login
kill $API_PID
```

### GitHub Actions（E2E）

Repo 已內建工作流程 `.github/workflows/e2e.yml`：

- 觸發：PR 到 `main`、或手動（Workflow Dispatch）。
- 需求：在 repo 的 Settings → Secrets and variables → Actions，新增 `E2E_ORIGIN_API`（建議填 Staging API，例如 `https://api.message.sentry.red`）。
- 內容：
  - Job `Prekeys & Devkeys`：呼叫 `/api/v1/keys/publish`、`/api/v1/devkeys/store|fetch`。
  - Job `Messages Secure`：呼叫 `/api/v1/messages/secure` 建立/列出 envelope。
- 安全性：如果沒有設定 `E2E_ORIGIN_API`，工作流程會自動跳過，不會打到外部 API。

建議在 GitHub → Settings → Branches → Branch protection rules：

- 建立 `main` 分支保護：
  - Require a pull request before merging
  - Require status checks to pass before merging（勾選 `E2E Checks / Prekeys & Devkeys`、`E2E Checks / Messages Secure`）
  - Include administrators（視團隊需要）

---

## Codex 修改追蹤

- 2025-10-10 04:58 UTC：追蹤「收訊端無法解密」問題，新增裝置私鑰等待機制（store 與 DR session）以避免 DR 初始化在備份尚未回復時失敗，後續可直接重用記憶體中的裝置金鑰並降低 404 造成的重試噪音。

---

## Codex 工作紀錄


| 日期 (UTC) | 說明                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2025-10-10 | 針對收訊端無法解密的問題：在`web/src/app/features/dr-session.js` 新增裝置金鑰備援流程，若備份缺失會自動重新發佈預共享金鑰並儲存 wrapped_dev，預期可避免 DR 初始化因 404 中斷。 |

---

## 授權條款

本專案採用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。任何人皆可依照該授權條款自由使用、修改與散佈此專案；若部署於可供他人透過網路存取的服務，請務必公開對應的來源碼與修改內容，以確保社群共享與使用者權益。
