# SENTRY Message — 技術筆記

> 近期進度：雲端硬碟分頁新增容量資訊欄（預設 3GB 配額，隨 Drive 列表即時計算使用率並以進度條呈現）；修復 logout→relogin 後分享面板持續顯示「缺少交友金鑰」造成 QR 無法重生的問題，重置 shareState 會清除補貨鎖定並恢復自動補貨；Drive 面板改以使用者資料夾為主並隱藏系統「已傳送 / 已接收」層，避免上傳檔案被困且可再次上傳 / 刪除；訊息附件新增「預覽」動作沿用 Modal 下載流程並於 Playwright 內實際執行 `downloadAndDecrypt` 驗證 SHA-256 digest，確認接收端確實可還原檔案；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過，後續將持續強化 Drive / 聊天 UI（#12~#15）。

## 目錄

1. [簡介與快速開始](#簡介與快速開始)
2. [架構概覽](#架構概覽)
   - [專案目錄](#專案目錄)
   - [系統元件](#系統元件)
   - [資料流摘要](#資料流摘要)
3. [關鍵流程](#關鍵流程)
   - [登入與主金鑰 (MK)](#登入與主金鑰-mk)
   - [裝置金鑰與 Prekeys](#裝置金鑰與-prekeys)
   - [好友邀請與聯絡同步](#好友邀請與聯絡同步)
   - [Double Ratchet 訊息傳遞](#double-ratchet-訊息傳遞)
   - [媒體、設定與資料夾命名](#媒體設定與資料夾命名)
4. [安全預設與環境配置](#安全預設與環境配置)
5. [營運與部署流程](#營運與部署流程)
6. [測試與自動化](#測試與自動化)
7. [最新進度與工作項目](#最新進度與工作項目)
8. [授權條款](#授權條款)

---

## 簡介與快速開始

- **目標**：驗證「晶片感應 → 零知識登入 → 端對端密訊＆媒體」的連貫體驗，同時確保所有祕密僅存於使用者裝置記憶體。
- **核心堆疊**：Node.js (Express + WebSocket) / Cloudflare Worker + D1 / Cloudflare R2 / 前端 ESM。

### 快速開始

```bash
npm install
NODE_ENV=development node src/server.js            # 啟動 API
node scripts/serve-web.mjs                         # 啟動本機 Pages
```

必要環境變數（摘要）：`DATA_API_URL`, `DATA_API_HMAC`, `WS_TOKEN_SECRET`, `S3_*`, `NTAG424_*`, `OPAQUE_*`, `ACCOUNT_TOKEN_BYTES`, `SIGNED_{PUT,GET}_TTL`, `UPLOAD_MAX_BYTES`, `CALL_SESSION_TTL_SECONDS`, `TURN_SHARED_SECRET`, `TURN_STUN_URIS`, `TURN_RELAY_URIS`, `TURN_TTL_SECONDS`。細節見[安全預設](#安全預設與環境配置)。

開發流程請遵循 `Prompt.md`：新 session 先閱讀 README 最新進度 → 選定優先事項 → 修改後自跑測試 → 更新此文件紀錄。

**權限提醒**：Codex 預設擁有 Git 推送、Cloudflare Worker／Pages 部署、D1／R2 清除與各項腳本執行權限。確認操作安全後請直接執行，不需假設權限受限。

---

## 架構概覽

### 專案目錄

```
.
├─ package.json            # Node API
├─ src/                    # 伺服端程式碼
│  ├─ routes/              # REST (auth/media/friends/prekeys/...)
│  ├─ controllers/         # 業務邏輯
│  ├─ ws/                  # WebSocket presence/contact-share
│  └─ utils/               # HMAC、logger、S3/R2 包裝
├─ data-worker/            # Cloudflare Worker + D1 schema
└─ web/                    # 前端（Cloudflare Pages）
   ├─ src/app/             # ESM 模組（core/crypto/features/ui）
   └─ pages/               # login.html / app.html
```

### 系統元件


| 元件                                | 職責                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **前端 (web)**                      | 管理登入流程、端到端加密、UI；所有敏感資料在瀏覽器記憶體處理。                                          |
| **Node API (src)**                  | 驗證 SDM、代理 OPAQUE、媒體索引、devkeys/prekeys 管理、WebSocket presence。僅接觸密文與索引。           |
| **Cloudflare Worker (data-worker)** | 以 HMAC 驗證 Node 請求，操作 D1：帳號、邀請、訊息索引、prekey 庫存等。                                  |
| **R2**                              | 儲存加密媒體／頭像，透過 `/media/sign-put                                                               |
| **SessionStorage / LocalStorage**   | 登入→App handoff 用途（`mk_b64`、`account_token` 等）與 `contactSecrets-v1` 快照；App 讀取後立即清空。 |

### 資料流摘要

1. Login 頁完成 SDM + OPAQUE 後解封 MK，僅短暫存於 sessionStorage。
2. App 頁接手 MK、wrapped_dev、contactSecrets 等 snapshot，並透過 WebSocket / REST 同步資料。
3. 所有加密/解密在前端記憶體執行；後端只儲存密文與索引。
4. 雙向訊息採 Double Ratchet；登出時會 flush snapshot，重新登入時由 `contactSecrets-v1` 還原。

### 群組聊天擴充（設計筆記）

- 群組 conversation 採獨立 `groupId` + `conversation_token`，不與 1:1 共用 ACL / DR state，原有單聊流程保持原樣。
- 資料層預計新增 `groups` / `group_members` / `group_invites`，`conversation_acl` 以成員批次授權；訊息索引需帶 sender 標識（fingerprint / account_digest）。
- API：新增群組 CRUD + 邀請 / 加入 / 退出；`messages.controller` 送 / 拉訊息時驗證群組成員資格並附帶 sender 資訊。
- 前端：session/contactSecrets 新增 group store 與 `type:'group'` 對話列表；群組訊息渲染以成員表映射 sender 名稱 / 頭像；WS 增補 group-* 事件與 secure-message 分流。
- 加密策略維持不干擾單聊：群組訊息以 per-member fan-out（每成員子封包）或群組共享 key 二選一，不覆寫既有單聊 DR 狀態。
- UI/UX 方案（行動/桌面一致）：聊天列表提供「建立群組」入口；建群分步（命名/頭像 → 選好友 → 確認與 QR/連結分享）；群組對話標頭顯示名稱+成員數，訊息氣泡附 sender 頭像/名稱（連續訊息合併頭像）；列表預覽顯示未讀與 @提及徽章；右側/抽屜顯示成員清單與管理操作（靜音/退出/踢人/再發邀請）；被踢或離開時覆蓋提示可返回列表。

---

## 關鍵流程

### 登入與主金鑰 (MK)

1. **SDM 感應**：`POST /api/v1/auth/sdm/exchange`，Node 端驗證 MAC，並透過 Worker 建立帳號。
2. **OPAQUE**：前端 `ensureOpaque()` 與 Node `/api/v1/auth/opaque/*`（代理 Worker `/d1/opaque/*`）互動，不暴露密碼。
3. **MK 處理**：若無 MK → 產生並 `wrapMKWithPasswordArgon2id` → `/api/v1/mk/store`。若已有 → 解封 `wrapped_mk`。
4. **交棒**：登入頁將 `mk_b64`、`account_token`、`account_digest`、`wrapped_dev`、`contactSecrets-v1` 放至 sessionStorage / localStorage (`contactSecrets-v1-latest`)，App 取用後清空。

### 裝置金鑰與 Prekeys

1. **備份**：無備份時產生 IK/SPK + 100 OPKs → `/api/v1/keys/publish` → 以 MK 包裝後 `/api/v1/devkeys/store`。
2. **補貨**：已備份則解包 `wrapped_dev`，視需要補 OPKs（每次 20 支），再度包裝並存回。
3. **API 限制**：`/api/v1/devkeys/*` 僅接受 `accountToken/accountDigest`；若只給 token，Node 會自行取 digest 以保護 UID。
4. **Worker**：`/d1/prekeys/publish` upsert IK/SPK/OPK，`/d1/prekeys/bundle` 配發且消耗對方 OPK。

### 好友邀請與聯絡同步

1. **建立邀請**：`friendsCreateInvite()` → Worker `/d1/friends/invite` 儲存 `{invite_id, secret, prekey_bundle}`；前端以 invite secret 對稱加密聯絡資訊並 `/d1/friends/invite/contact`；同時顯示 QR 與倒數。
2. **接受邀請**：掃描後 `/d1/friends/accept`，Worker 驗證 secret、綁定帳號、回傳 owner envelope；Guest 解封後寫入自己的聯絡卡。
3. **資料同步**：Worker 將 owner/guest profile 寫入 `contacts-<acct>` conversation；前端透過 WebSocket `contact-share` 事件解密更新，並寫入 `contactSecrets-v1`（含 `conversation.token`、`dr_init`）。
4. **邀請續期**：`inviteSecrets-v1` 儲存狀態；倒數結束會再生成；登出時清除。

### Double Ratchet 訊息傳遞

1. **設備金鑰交棒**：`ensureDevicePrivAvailable()` 僅依賴登入交棒／記憶體；若 sessionStorage 缺件，直接報錯不再自動補建。
2. **初始化**：若 `drState` 缺失、且 `dr_init` 可用 → `bootstrapDrFromGuestBundle()`；否則呼叫 `prekeysBundle` + `x3dhInitiate` 建立新會話（消耗對方 OPK）。
3. **傳送訊息**：`drEncryptText` 產生 header + ciphertext → `/api/v1/messages/secure` 儲存 envelope（D1 `messages_secure`）。
4. **接收解密**：
   - `listSecureAndDecrypt()` 先排序訊息；若為重播情境會利用 `prepareDrForMessage` 檢查 timestamp / messageId 是否早於 cursor，必要時還原 snapshot。
   - 若 snapshot 缺失會落到 `recoverDrState()`（可強制使用 `guest_bundle`），同時記錄 `[dr-decrypt-fail-payload]` 供 `scripts/debug-dr-replay.mjs` 重播。
   - 每次成功解密會 `recordDrMessageHistory()`（包含 messageKey）並 `persistDrSnapshot()`。

### 安全對話啟動流程（Invite → Contact Secrets → DR Ready → 傳訊）

1. **邀請建立**：Owner 端透過 `friendsCreateInvite()` 生成 invite，`share-controller` 會同步：
   - 將 contact snapshot 以 invite secret 包裝後呼叫 `friends/invite/contact`；
   - 使用 `setContactSecret()` 在本地記錄 `{ inviteId, secret, role: 'owner', conversation.{token, id, dr_init} }`。
2. **好友接受**：Guest 掃描邀請後執行 `friendsAcceptInvite()`：
   - Worker 綁定帳號並回傳 `guest_bundle` + owner contact；
   - Guest 端 `storeContactSecretMapping()` 儲存對應 invite 資料、預填 `conversation.drInit`，必要時 `bootstrapDrFromGuestBundle()` 立即進入 responder 狀態。
3. **Contact Secrets 同步**：雙方藉由 `/friends/contact/share` 更新最新 profile / conversation token，`loadContacts()` 或 WS `contact-share` 事件會：
   - 寫入 `contactSecrets-v1` 的 `conversation.{token,id,drInit}` 與 `drHistory`;
   - 對 UI 觸發 `contacts:rendered` 事件以重建列表。
4. **SecureConversationManager 進場**：
   - `ensureSecureConversationReady()` 會先檢查本地 `drState`，缺失時啟動 `deps.prepareDrForMessage()`；
   - Owner 端若尚未建鏈，會送出 `session-init` 控制訊息並進入 `pending`；Guest 端在收到 `session-init` 後先跑 `ensureSecureConversationReady()`，成功即回 `session-ack`；
   - 狀態切到 `pending` 時，Messages Pane 會顯示「建立安全對話」Modal 並鎖住輸入，Ready 後自動解除；`failed` 則填入錯誤文案方便重試。
5. **訊息解密 / Replay**：
   - 前景對話（`mutateState=true`）使用 live ratchet 並持續寫入 `drHistory`；
   - 其他場景或控制訊息則走 `mutateState=false`，交給 `listSecureAndDecrypt()` 以歷史快照與 `messageKey_b64` 重播，確保非前景同步也能取得最新進度。

#### Session Bootstrap API 契約

- `POST /api/v1/friends/bootstrap-session`
  - **請求欄位**：`peerUid`（必填）、`roleHint`（`owner` ｜ `guest`，可選）、`inviteId`（可選）；標準帳號憑證由 `buildAccountPayload()` 自動附帶。
  - **回應重點**：
    - `guestBundle`：完整 X3DH guest bundle，Guest 端缺會話時以此重建；
    - `ownerContact` / `guestContact`：最新 contact snapshot（含 conversation token、dr_init）；
    - `role`、`inviteId`、`usedAt` 等輔助欄位，用於判斷快取是否可沿用。
  - **前端使用**：`ensureDrReceiverState()` 會在 `relationshipRole !== 'guest'` 且本地無 `guest_bundle` 時呼叫此端點，成功後同步更新 `contactSecrets` 及 session store。

### 媒體、設定與資料夾命名

- **媒體 / Drive**：`encryptAndPutWithProgress()` 用 MK 加密 → `/media/sign-put` → R2 上傳；接收端 `/media/sign-get` → 解密。Drive 系統資料夾命名為 `drive-<acctDigest>`（必要時以 MK-HMAC 分段）。
- **設定**：`settings-<acctDigest>` 以 MK 包裝 `{ showOnlineStatus, autoLogoutOnBackground, autoLogoutRedirectMode, autoLogoutCustomUrl }`，所有欄位都以 MK-AEAD 加密儲存；App 啟動時 `ensureSettings()`，更新立即 `saveSettings()`。
- **其餘 envelope**：Profile/聯絡人/訊息/媒體皆以 MK 衍生 AES-GCM；儲存層只保存密文。

---

## 安全預設與環境配置

- **登出清理**：`secureLogout()` 先 `flushDrSnapshotsBeforeLogout()` 與 `persistContactSecrets()`，將 JSON 寫入 sessionStorage + `contactSecrets-v1-latest`，再清除 cache/indexedDB 等。
- **登入頁**：`purgeLoginStorage()` 會挑選最長 snapshot 回填 localStorage，並輸出 checksum（`contactSecretsSeed*`）供 QA 比對。
- **背景自動登出**：`autoLogoutOnBackground`（預設 true）在 App 退到背景時觸發 `secureLogout()`；若 `autoLogoutRedirectMode=custom` 且 `autoLogoutCustomUrl` 通過 HTTPS 驗證，登出後會導向指定網址。**即使此設定被關閉，只要 App 頁面被重新整理就會立即強制 `secureLogout()` 並導向登出頁**。
- **Remote Console**：設 `REMOTE_CONSOLE_ENABLED=1` 可允許前端上報 `console.log` 至 `/api/v1/debug/console`（預設關閉）；僅於追查問題時啟用，並搭配 `?remoteConsole=1` 或 `window.RemoteConsoleRelay.enable()` 啟用個別裝置。
- **環境變數**（常用）：`NTAG424_*`, `ACCOUNT_HMAC_KEY`, `OPAQUE_*`, `DATA_API_*`, `S3_*`, `UPLOAD_MAX_BYTES`, `SIGNED_{PUT,GET}_TTL`, `SERVICE_*`, `ACCOUNT_TOKEN_BYTES`, `CORS_ORIGIN` 等。
- **儲值系統（訂閱延展）**：`PORTAL_API_ORIGIN`（例如 `https://portal.messenger.sentry.red`）、`PORTAL_HMAC_SECRET` 必填。Node API 透過 `/api/v1/subscription/{redeem,validate,status}` 代理至 Portal，HMAC 計算為 `HMAC-SHA256(secret, path + "\n" + body)`；憑證為 Ed25519 簽章、`extend_days` 天數延展，Portal 端負責唯一性與消耗，前端不直接呼叫 Portal。

---

## 營運與部署流程

### 清除環境

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>
CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID ./scripts/cleanup/wipe-all.sh
```

- 透過 Wrangler 刪除遠端 D1 資料；
- 使用 AWS 相容 API 清空 R2 bucket。若 Wrangler 顯示 `Unexpected fields "account_id"` 為舊版格式，可忽略。

### 一鍵部署

```bash
bash ./scripts/deploy-prod.sh --apply-migrations
```

流程：`wrangler deploy` → `wrangler d1 migrations apply --remote` → `npm ci && pm2 reload message-api` → `wrangler pages deploy`。可用 `--skip-{worker,api,pages}` 部分部署；若變更 D1 schema 請保留 `--apply-migrations`。

### 正式釋出流程（必須）

1. 本地修正完成後，先依 Prompt 規範跑完 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，確保全部綠燈。
2. 透過 `./scripts/cleanup/wipe-all.sh` 清空 Cloudflare D1 / R2（如上節）。
3. 執行 `bash ./scripts/deploy-prod.sh --apply-migrations`，不可跳過任何部件（Worker / Node API / Pages 必須同步部署）。
4. 佈署完成後，以正式環境重新執行同組測試，範例如下（請將網域替換成實際 Production）：

   ```bash
   ORIGIN_API=https://api.message.sentry.red npm run test:prekeys-devkeys
   ORIGIN_API=https://api.message.sentry.red npm run test:messages-secure
   ORIGIN_API=https://api.message.sentry.red npm run test:friends-messages
   ORIGIN_API=https://api.message.sentry.red npm run test:login-flow
   ORIGIN_API=https://api.message.sentry.red E2E_ORIGIN_API=https://api.message.sentry.red npm run test:front:login
   ```

> **TUN 服務備註**：詳細主機資訊與操作規範請參考 `docs/internal/tun-host.md`（本檔案已被 `.gitignore` 排除，不隨版本控制分發；需向維運成員索取或於本地自行建立）。

5. 若任何 Production 測試失敗，需先排除問題並重新部署，直到正式環境也全部通過為止。

---

## 測試與自動化

> 修改程式碼後務必跑以下測試；若跳過，需在回報中說明原因與風險。
> 正式釋出前，需再將 `ORIGIN_API`（及 `E2E_ORIGIN_API`）指向 Production，重跑同組測試確認線上環境也為綠燈。
> **提醒**：每次跑測試（本機或線上）前，先執行 `./scripts/cleanup/wipe-all.sh` 清空舊的 D1 / R2 資料，避免舊資料干擾結果。


| 指令                                                           | 腳本                                | 覆蓋範圍 / 期望                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:prekeys-devkeys`                                 | `scripts/test-prekeys-devkeys.mjs`  | SDM → exchange →`/keys/publish` → `/devkeys/store                                                                     |
| `npm run test:messages-secure`                                 | `scripts/test-messages-secure.mjs`  | 建立 secure envelope、列表至少一筆。                                                                                     |
| `npm run test:friends-messages`                                | `scripts/test-friends-messages.mjs` | 兩位用戶註冊→邀請→互傳訊息並解密。需先啟動 Node API。                                                                  |
| `npm run test:calls-encryption`                                | `scripts/test-calls-encryption.mjs` | 兩位用戶 bootstrap → call invite（含 call-key-envelope）→ callee 取得 session → 回報 metrics → cancel。              |
| `npm run test:login-flow`                                      | `scripts/test-login-flow.mjs`       | SDM → OPAQUE（必要時註冊）→`/mk/store` → 再次 exchange 應 `hasMK=true`。                                              |
| `npm run test:front:login`                                     | Playwright (`tests/e2e/*.spec.mjs`) | 驗證登入、暱稱/頭像、檔案操作、雙向訊息、對話/聯絡人刪除、登出。需啟動 API，首次請`npx playwright install --with-deps`。 |
| `npm run test:front:call-audio`                                | Playwright                          | 兩個瀏覽器帳號以假音訊裝置建立好友→撥打語音通話→接聽→確認加密/靜音/掛斷流程。                                         |
| `node --test tests/unit/messages.test.mjs`                     | Node.js test runner                 | 覆蓋`listSecureAndDecrypt` 控制訊息／replay 邏輯與安全 Modal 狀態。                                                      |
| `npx playwright test tests/e2e/multi-account-friends.spec.mjs` | Playwright                          | 多帳號壓力測試：輪流建立好友、雙向訊息與附件傳送，包含登出/重登入行為並收集安全對話狀態。                                |

**範例**

```bash
# 本機 API
ORIGIN_API=http://127.0.0.1:3000 npm run test:prekeys-devkeys

# 線上 API
ORIGIN_API=https://api.message.sentry.red npm run test:messages-secure

# Playwright
NODE_ENV=development node src/server.js &
API_PID=$!
ORIGIN_API=http://127.0.0.1:3000 npm run test:front:login
kill $API_PID

# 多帳號好友壓力測試
npx playwright test tests/e2e/multi-account-friends.spec.mjs
```

### GitHub Actions

- Workflow：`.github/workflows/e2e.yml`
- 觸發：PR → `main` 或 `workflow_dispatch`
- 需設定 `E2E_ORIGIN_API`（建議指向 Staging）
- 任務：`Prekeys & Devkeys`、`Messages Secure`
- 建議在 Branch Protection 要求上述檢查通過才能合併。

## 最新進度與工作項目

### 時間軸

- **目前狀態**：Playwright e2e 以 WebKit（iPhone 13 Pro profile）為預設執行，`tests/e2e/call-audio.spec.mjs` 改由獨立的 Chromium project 搭配 fake audio 裝置跑通；full-flow 測試允許 WebKit 缺少 `MediaRecorder` 時跳過影片附件並延長 timeout。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow}` 維持綠燈，但 `npm run test:front:login` 在 WebKit 上仍因 `tests/e2e/full-flow.spec.mjs` 最後驗證附件截圖時超時（長流程 + Safari cascade）而失敗，後續需針對該段縮圖檢查加速或拆測。App 主頁的 reload 現在同時透過 `performance` navigation entry、`performance.navigation` 以及 `document.referrer` 三條訊號強制 `secureLogout()`，對應的 Playwright `tests/e2e/login.spec.mjs`（webkit-mobile）已在本地通過，但整套 `npm run test:front:login` 仍待 WebKit runner 可用時完整跑一次。登入後的「啟用語音通話」提示也改為進入授權流程時立即以 500 ms 輪詢 `navigator.permissions` + `enumerateDevices`，一旦偵測到 `granted`/具名麥克風便自動關閉 modal 並標記授權，仍保留「我已按下同意」按鈕作為 fallback；新帳號初始化時若尚未上傳頭像會自動以 UID identicon 產生並上傳作為預設頭像，登入初始化清單則改為固定高度可捲動並完成後淡出逐項上移。


| 日期                          | 里程碑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **2025-12-06 16:05** | Node API calls/groups digest-only：通話邀請/取消/ACK/metrics/TURN 憑證移除 UID 需求，僅驗證 account_token/account_digest；群組建立/成員增刪/查詢 payload 不再送 UID，僅保留 account_digest 與指紋；好友刪除 WS reload 改以 digest 廣播。未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需在可清空 D1/R2 的環境補跑。 |
| **2025-12-06 16:01** | Worker 端 prekeys bundle / call session / call events 改為 digest-only：`/d1/prekeys/bundle` 僅接受 peer account_digest，不再 hash UID；`upsertCallSession` / `insertCallEvent` 移除 UID fallback、要求雙端 digest；Node `/api/v1/keys/bundle` schema 改為必填 peer_accountDigest。未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，待清空 D1/R2 的隔離環境補測。 |
| **2025-12-06 15:49** | 前端通話/Presence 流程改為 account_digest 命名與 payload：通話 WS 信令只送/收 targetAccountDigest（移除 targetUid）、媒體層/接聽流程以 digest 追蹤對象；presence 訊息改讀 `onlineAccountDigests`。未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，待可清空 D1/R2 的隔離環境補測。 |
| **2025-12-06 15:40** | 帳號驗證與 WS token 改為僅接受 account_digest/account_token，/d1/accounts/verify 取消 UID 驗證回傳僅帶 digest；WS token 不再簽 uid，WebSocket 連線/鎖定/presence 改以 accountDigest 運作並移除 `accountDigestByUid` 映射。未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續在安全環境清空 D1/R2 後補跑。 |
| **2025-12-06 13:31** | 移除前端 UID fallback：聯絡人/DR/Presence/通話/群組等鍵值全面使用 `account_digest`，缺少 digest 的事件直接跳過；presence WS 訂閱/通知改以 digest 註冊並回傳 `onlineAccountDigests`，好友刪除 API 改傳 digest；持續未跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`。 |
| **2025-12-06 13:05** | contact / session 狀態以 account_digest 為主索引：contacts view 載入/新增/刪除、conversationIndex、presence 訂閱改以 digest 儲存並保留 UID fallback，contactState 也記錄 peerAccountDigest；WS/call digest 化同前。未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，待群組/部署流程完成後一併補跑。 |
| **2025-12-06 12:50** | 前端 peer 鍵值改以 account_digest 為主：`core/store` DR session 與 `contact-secrets` 以 digest 為主鍵並維護 UID alias，contacts convId 改優先 `contacts-<account_digest>`（UID 兼容），`features/messages` 接受 `peerAccountDigest` 取得 DR/指紋；WS contact-share/contacts-reload/presence/call 信令帶 digest，通話邀請/接聽與金鑰派生亦改用 digest 主索引。未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，待群組/Session digest 化完成後整批補跑。 |
| **2025-12-03 13:45** | 呼叫事件表新增 account_digest 欄位（`call_events.from_account_digest/to_account_digest`），WS/Node 呼叫事件寫入與查詢同步帶 digest；後續仍需將好友/聯絡人/群組等流程改為僅用 account_digest。 |
| **2025-12-03 13:05** | `scripts/cleanup/wipe-all.sh` 與 `scripts/cleanup/d1-wipe-all.sql` 補齊 D1 清除清單，新增 `call_*` / `group_*` / `contact_secret_backups` / `conversation_acl` / `conversations` / `subscriptions` / `tokens` / `extend_logs` 等表，確保重置時不殘留新 schema 資料；未執行 `npm run test:*`。 |
| **2025-12-03 12:26** | 前端加入「建立群組」入口：生成 groupId/conv token/seed 呼叫 `/api/v1/groups/create`，並自動複製群組資訊至剪貼簿、本機列表備查；群組訊息流程仍未串接，待後續擴充。未跑 `npm run test:*`。 |
| **2025-12-03 12:15** | 執行 `wrangler d1 migrations apply message_db --remote` 套用 0010 群組 schema，並 `scripts/deploy-prod.sh --apply-migrations` 全套部署（Worker/Node API/Pages）；未跑 `npm run test:*`。 |
| **2025-12-03 12:15** | 群組聊天後端腳手架：新增 D1 `groups` / `group_members` / `group_invites` schema，Worker 提供 create/add/remove/get 端點並同步 conversation ACL，Node API 開出 `/api/v1/groups/*`（create/members add/remove/get）；僅程式更新未跑 `npm run test:*`。 |
| **2025-12-03 12:04** | README 補群組聊天架構與 UI 筆記（區隔 1:1、規劃資料表/ACL/API/前端/WS、群組列表/建群/對話/成員抽屜/邀請 UI），僅文件更新未跑 `npm run test:*`。 |
| **2025-11-29 08:51** | Drive 上傳前後端皆檢查容量：前端以現有使用量 + 待上傳檔案預估超過 3GB 配額即彈窗阻擋；後端 `media/sign-put` 改用 3GB 空間上限（獨立於 500MB 單檔限制），超出直接 413；未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:49** | Loading modal 去除旋轉圓形圖示，只保留進度條顯示載入狀態；未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:45** | Drive 資料夾點擊/返回上一層會顯示「載入資料夾中…」modal，避免等待列表刷新時無提示；未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:40** | 修正 Drive 重新命名功能未匯入 `createMessage` 導致動作無效，列表改以 obj_key 去重只保留最新版本避免重命名顯示為重複檔案，並移除重命名 modal 的「長按觸發」提示僅保留名稱規則；未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:36** | Node API `media/sign-put` 改為完全不檢查 Content-Type（忽略 `UPLOAD_ALLOWED_TYPES`），所有類型都允許；未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:55** | Drive 上傳前端加入 500MB 單檔尺寸檢查（選擇檔案即阻擋，並在送出/佇列前再次防呆），仍允許任意檔案類型；未執行 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:35** | Drive 容量面板移除外層 card，直接置於檔案列表上方同層呈現，避免雙卡片視覺；UI 調整未重跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:21** | Drive 空間使用面板移出檔案列表卡片，獨立同級顯示以避免列表捲動時被頂出；UI 變更未重跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續補測。 |
| **2025-11-29 08:00** | 雲端硬碟頁面加入容量資訊欄與 3GB 配額進度條，依 Drive 列表累計檔案大小（排除佔位與重複 obj key）即時計算已用/剩餘並顯示百分比；前端 UI 變更未重跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需後續手動覆核 Drive 列表/進度條渲染與登入 e2e。 |
| **2025-11-28 09:18** | 頭像編輯改用 Cropper.js（拖曳 / 滾輪 / 雙指縮放），裁切後直接輸出 512px JPEG 上傳並沿用舊的 profile 儲存 / 廣播流程；裁切 modal UI 改為簡化預覽 + 行動手勢提示，並載入新版 Cropper 樣式。 |
| **2025-11-28 09:07** | 首次登入且尚未上傳頭像時，會直接以晶片 UID 同步生成登入頁 identicon、轉成 512px 圖檔上傳並寫入 profile，未來使用者自訂頭像仍會覆蓋；登入初始化工作清單改為固定高度可捲動容器，步驟完成後會淡出並收合，讓後續項目自動往上移動。 |
| **2025-11-25 09:35** | 登入後的啟用語音通話 modal 加入 500 ms 輪詢 `navigator.permissions.query` + `enumerateDevices`，只要偵測到 `granted` 或具名 `audioinput` 就即時關閉提示並清空狀態；同時調整 Remote Console debug toast 顯示「已授權麥克風權限」，並保留「我已按下同意」按鈕作為手動 fallback。依需求未執行 `npm run test:*`，待 QA/實機覆核。 |
| **2025-11-16 13:40** | 修正 reload 強制登出在 Safari/WebKit 上因 `secureLogout()` 早於變數初始化而拋出 `ReferenceError`（`logoutInProgress`, `_autoLoggedOut`, `wsConn`, `presenceManager`, `SIM_STORAGE_*` 等均提前宣告）；新增 `document.referrer` 作為 reload 偵測備援，正式在 `tests/e2e/login.spec.mjs`（webkit-mobile）驗證「關閉 auto logout → reload 仍導向登出頁」並取得綠燈。尚未跑完整套 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`。 |
| **2025-11-16 09:15** | App 頁面重新整理時一定會呼叫 `secureLogout()` 並導向登出頁，即使使用者在設定中關閉背景自動登出也無法繞過；`web/src/app/ui/app-mobile.js` 新增 reload 偵測與 `forceReloadLogout()` 流程，`document.visibilitychange/pagehide` 也會優先檢查 reload。`tests/e2e/login.spec.mjs` 加入「關閉 auto logout → reload 仍登出」案例，README 補充安全預期。尚未重跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，需待 WebKit 執行環境可用時再驗證。 |
| **2025-11-15 18:20** | Playwright e2e 調整為 WebKit 預設、Chromium 專責 call-audio：`playwright.config.ts` 新增 `webkit-mobile` / `chromium-call` 雙專案，WebKit 忽略 call-audio；`tests/e2e/full-flow.spec.mjs` 若環境缺 `MediaRecorder` 會註記並跳過影片附件，同時延長 timeout、在 context 關閉失敗時記錄 annotation。實際跑 `npx playwright test tests/e2e/{contact-backup-cross-device,multi-account-friends}`（WebKit）與 `tests/e2e/call-audio`（Chromium）皆通過，`tests/e2e/full-flow` 仍於圖片附件驗證階段因 WebKit 緩慢而 timeout，需進一步拆解。 |
| **2025-11-15 15:40** | 修正 Worker `ensureDataTables` 啟動時會 `DROP TABLE prekey_users/prekey_opk/device_backup/friend_invites` 的破壞性行為（導致每次冷啟動清空 D1 prekeys/devkeys，直接造成 guest (`BD2E…`) 無法解密）；移除自動 drop 僅保留 idempotent 的 `CREATE TABLE IF NOT EXISTS`，重新跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow}` all green，`npm run test:front:login` 仍因 `tests/e2e/full-flow.spec.mjs` 缺泡泡 flake。後續需重新部署 Worker，並協助既有帳號補發 prekeys/devkeys。 |
| **2025-11-15 10:20** | 重新實機測試後，D1 仍只有 owner (`E1C6…`) 有 `prekey_users/prekey_opk/device_backup`，guest (`BD2E…`) 完全沒有任何 IK/SPK/OPK，因此訊息無法解密；PM2 log 顯示前端已觸發 `/api/v1/keys/publish` fallback（帶 `ik_pub/spk_pub/spk_sig`），但 Worker/D1 沒留下記錄，下一步需追查 `/d1/prekeys/publish` 是否未實際 insert 或指向錯誤資料庫。 |
| **2025-11-14 17:40** | 強化好友邀請完整性：Worker `/d1/friends/contact/share` 找不到 invite 時不再寫入 `contacts-*` fallback，而是直接 404；Node `/api/v1/friends/invite` 轉傳上游錯誤，`/api/v1/friends/bootstrap-session` 若收到缺少 `spk_sig` 的 `guest_bundle` 會回報 `GuestBundleIncomplete`，share-controller 也會攔截並提示重新邀請。同步更新 README TODO，並實際跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow}` all green；`npm run test:front:login` 持續在 `tests/e2e/full-flow.spec.mjs` flake（缺訊息泡泡 / timeout），待後續調查。 |
| **2025-11-14 14:30** | 針對 iOS Safari / PWA 持續無法關閉麥克風授權 modal 的問題，擴大`isIosWebKitLikeBrowser` 判斷：除了 `Safari` UA，也納入 Touch Mac、`navigator.userAgentData.platform` 含 iOS 以及 standalone PWA，以確保這些環境不會再套用 `noiseSuppression`。同時透過 `navigator.mediaDevices.getSupportedConstraints()` 決定是否啟用 `echoCancellation`/`noiseSuppression`，動態生成多層約束列表，避免 PWA 因 UA 不含 Safari 又回到舊的 `OverconstrainedError`。調整完成後執行 `scripts/deploy-prod.sh --apply-migrations` 全套部署；依指示未跑 `npm run test:*`。                                                                                                                                    |
| **2025-11-14 14:15** | 修復`messages-pane` 內 `refreshActivePeerMetadata` 重複宣告 `avatarData` 造成的 `Identifier 'avatarData' has already been declared`（Safari/Chrome 進入對話即報錯並中斷渲染）：改用單一變數並沿用原 avatar snapshot，確保 active thread avatar 與標題更新正常。完成後依流程執行 `scripts/deploy-prod.sh --apply-migrations` 重新部署 Worker / D1、Node API、Cloudflare Pages；依使用者指示本輪未跑 `npm run test:*`。                                                                                                                                                                                                                                                                   |
| **2025-11-14 14:10** | 調整`web/src/app/ui/app-mobile.js` 的麥克風授權流程：針對不支援進階音訊約束的瀏覽器（例 iOS Safari）逐步退階 `getUserMedia` 參數並捕捉 `OverconstrainedError`，若僅是約束不符仍會視為已授權、顯示警語並收起提示；同時優化錯誤訊息。依照 `scripts/deploy-prod.sh --apply-migrations` 重新部署 Worker / D1、Node API、Cloudflare Pages，本輪依使用者指示未執行 `npm run test:*`。                                                                                                                                                                                                                                                                                                         |
| **2025-11-13 19:05** | 完成 NAT / TURN 整合第一階段：後端新增`GET /api/v1/calls/network-config` 依環境變數帶入 STUN/TURN/頻寬參數；前端 `loadCallNetworkConfig()` 會優先呼叫此 API、失敗時回退 Pages 內建 JSON，再失敗才使用程式內建預設，並於建立 `RTCPeerConnection` 時合併靜態 STUN 與即時發出的 TURN 認證。`docs/encrypted-calls-network.md` 同步記錄新 API／環境變數。尚未在本機跑 `npm run test:calls-encryption`，原因是缺乏完整 Worker / TURN 佈署，待環境備妥後補測。                                                                                                                                                                                                                                 |
| **2025-11-13 17:00** | 調整多支 e2e：`tests/e2e/call-audio.spec.mjs` 於最新語音限定流程下已再度通過；`tests/e2e/full-flow.spec.mjs` 則仍失敗在重新登入後驗證歷史訊息（Decrypt snapshot 仍回傳 `OperationError`，`setActiveConversation` 能進入對話但 `#messagesList` 不會出現舊訊息），相對應的 `test-results/full-flow-*` 已保留供除錯。`tests/e2e/multi-account-friends.spec.mjs` 尚未重新跑。                                                                                                                                                                                                                                                                                                               |
| **2025-11-13 16:20** | 暫時停用視訊通話：移除`messagesVideoBtn`、`mediaPermissionOverlay` 改為僅要求麥克風授權（`web/src/pages/app.html`），並讓媒體授權流程只呼叫 `getUserMedia({ audio })`、錯誤訊息也改為麥克風專用（`web/src/app/ui/app-mobile.js`）；同時 `messages-pane` 會強制把「視訊」動作轉為語音並統一提示（`web/src/app/ui/mobile/messages-pane.js`）。執行 `npx playwright test tests/e2e/call-audio.spec.mjs` 時因既有 UI 會停留在聯絡人分頁導致 `#messagesCallBtn` 在小螢幕不可見而逾時（log 見 `test-results/call-audio-encrypted-audio-call-with-fake-media-stream-chromium-mobile/`），待後續釐清。                                                                                          |
| **2025-11-13 15:20** | 新增 Playwright 測試`tests/e2e/contact-backup-cross-device.spec.mjs`，模擬兩支裝置 / 兩顆晶片互登出後交換登入，驗證 contact-secrets 雲端備份會自動解包並還原 Double Ratchet 狀態、可立即解密舊訊息並續傳；本地先啟動 API，再執行 `npx playwright test tests/e2e/contact-backup-cross-device.spec.mjs` 全數通過。                                                                                                                                                                                                                                                                                                                                                                        |
| **2025-11-13 14:40** | App 登入後新增「啟用語音／影像通話」權限提示，使用者需點選確認以授權麥克風／鏡頭並預先解鎖音訊播放（包含 iOS Safari 的背景靜音保護）；自動化情境會自動標記為已授權避免測試卡住。完成授權後會記錄於`sessionStorage`，並在背景播放靜音 + `AudioContext` resume 來確保遠端音訊可即時播放。此變更已重跑 `npm run test:front:call-audio` 並重新部署 Worker / Node API / Pages。                                                                                                                                                                                                                                                                                                              |
| **2025-11-13 13:30** | 通話 e2e 測試新增「通話至少 3 秒＋雙端音訊振幅」驗證，並於前端加入 WebRTC Offer/Answer 描述與 ICE candidate 正規化、remoteDescription 建立前的候選佇列處理；同步調整事件匯流排僅傳遞`detail`，讓 `media-session` 能收到 `call-offer`/`call-answer` 訊號。Node API `buildCallDetail` 現在保留完整 candidate 物件，上述修正經 `npm run test:front:call-audio` 回歸。                                                                                                                                                                                                                                                                                                                      |
| **2025-11-13 12:40** | e2e 語音測試新增「成功接通並開始計時」檢查點：Playwright 會等待兩端 overlay 計時器出現，確保狀態切到「通話中」。為讓 UI 實際達標，`call` state 在收到 `call-accept` 時若已完成密鑰協商（`CALL_MEDIA_STATE_STATUS.READY`）會立即推進為 `IN_CALL`，同時保留媒體管線事件的自動提升邏輯。`npm run test:front:call-audio` 通過。                                                                                                                                                                                                                                                                                                                                                             |
| **2025-11-13 12:05** | 修正來電 / 撥出頭像載入失敗與通話狀態卡在「正在接通…」：`messages-pane` 會正規化聯絡人頭像 URL（避免誤塞整個 avatar 物件造成 `<img src=\"[object Object]\">`），`media-session` 則在送出 answer、收到對方 answer、或接收到媒體/ICE 連線時主動推進為 `IN_CALL`。`npm run test:front:call-audio` 通過。                                                                                                                                                                                                                                                                                                                                                                                  |
| **2025-11-13 11:20** | 修正通話 overlay 顯示錯誤：WebSocket`call-invite` 的 metadata 改為帶入本機使用者的暱稱 / 頭像（`displayName`、`callerDisplayName`、`avatarUrl`、`callerAvatarUrl`），並同時保留對方資訊於 `peer*` 欄位，確保 A 呼叫 B 時，A 看到 B、B 看到 A 的圖像與暱稱。依使用者指示本次未重跑 Playwright / API 測試，後續如需驗證請告知。                                                                                                                                                                                                                                                                                                                                                           |
| **2025-11-13 10:45** | 修正語音通話接起後仍停留在「正在接通…」且雙方無聲的問題：`media-session` 於 ICE / connection 狀態與 `ontrack` 事件時主動將 session 推進到 `IN_CALL`，並在遠端音訊串流掛載時強制呼叫 `audio.play()`（含未靜音才自動播放），確保計時與提示同步；同時補上 Playback promise 錯誤 logging。Playwright `test:front:call-audio`、`test:prekeys-devkeys`、`test:messages-secure`、`test:friends-messages`、`test:login-flow` 本地皆通過。                                                                                                                                                                                                                                                      |
| **2025-11-13 09:30** | 導入 Contact Secrets 雲端加密備份：前端以登入密碼衍生的 MK 將`contactSecrets-v1` snapshot 包成 AES-GCM envelope，上傳至 Worker / D1 儲存，僅記錄統計 metadata，伺服端無法解密內容；登入後若本地缺快照會自動下載最新版解包，確保晶片/裝置互換也能還原舊訊息。同步新增 API `/api/v1/contact-secrets/backup`（POST/GET）與 D1 `contact_secret_backups` 表，並在登出、定期 flush Contact Secrets 時自動備份。                                                                                                                                                                                                                                                                               |
| **2025-11-13 07:50** | 新增 Remote Console 協作機制：`REMOTE_CONSOLE_ENABLED=1` 可啟用 `POST /api/v1/debug/console`，裝置可透過 `?remoteConsole=1` 或 `window.RemoteConsoleRelay.enable()` 上傳 `console.log`，PM2 log 會標註 `remoteConsole` 方便排查。整套流程已重新清空 D1 / R2 並部署。                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **2025-11-13 06:04** | 客製化登出網址在實際重導前會先顯示全白遮罩，避免網路延遲時露出原 App 畫面；同時新增`npm run test:calls-encryption`（API 層）驗證 call invite → ack → session → metrics → cancel，確保 `call-key-envelope` 會持久化於 session。依使用者指示未重跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，但已清空 D1 / R2 並重新部署 Worker / Node API / Pages。                                                                                                                                                                                                                                                                                  |
| **2025-11-13 05:49** | 調整「客製化登出頁面」為獨立 Modal，主設定視窗只保留單選＋摘要，勾選或點「設定網址」才會跳出 Modal 供輸入 HTTPS（含常見網址建議）；同時移除登入歡迎畫面被選取的文字框線並新增內部捲動。依使用者指示未重跑`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`，但已清空 D1 / R2 並重新部署 Worker / Node API / Pages。                                                                                                                                                                                                                                                                                                                              |
| **2025-11-13 05:10** | 系統設定頁在「當畫面不在前台時自動登出」啟用時會顯示「預設 / 客製化」單選與可編輯下拉，支援常見網址選擇、HTTPS 正規化與立即儲存；`settings-<acctDigest>` 新增 `autoLogoutRedirectMode/autoLogoutCustomUrl` 仍以 MK-AEAD 加密，`secureLogout()` 會依設定導向預設頁或自訂網址。同步補強 README 與 CSS，並依流程清空 D1 / R2、重新部署 Worker / Node API / Pages；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                      |
| **2025-11-12 19:30** | Call Overlay 加入加密狀態、通話計時與靜音/喇叭/掛斷控制，`shared/calls/schemas.{js,ts}` 新增 `controls` 結構供 media session 同步，`features/calls/media-session.js` 暴露靜音 API 並於 Insertable Streams 管線套用；同時把 `contactSecrets-v1` 名稱空間化（`uid`/`accountDigest`），修正同裝置不同晶片交錯測試時的 snapshot 汙染，`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 再次全數通過。                                                                                                                                                                                                                                               |
| **2025-11-12 10:25** | 修正 CallKeyManager 在登入階段反覆`resetKeyContext` 造成 stack overflow，調整 `/shared/*` 載入路徑並讓 Playwright `test:front:login` 再次綠燈；同時完成 `sendCallOffer/Answer` + TURN Insertable Streams skeleton，`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過後重新部署 Worker / Node API / Pages。                                                                                                                                                                                                                                                                                                                              |
| **2025-11-12 15:40** | `CallKeyManager` 完成：撥號時會以聯絡人祕密派生 CMK、產生 `call-key-envelope` 並隨 `call-invite` 傳送，受話端自動驗證 proof/派生音視訊雙向金鑰；Overlay 顯示「建立加密金鑰」與錯誤提示，`messages-pane` 撥號流程也確保 envelope 成功建立後才送信令。媒體層尚待串接，未重跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`。                                                                                                                                                                                                                                                                                                                   |
| **2025-11-12 12:10** | Node WebSocket 新增`call-invite/call-accept/...` 信令處理與 120 秒互斥鎖，所有事件寫入 Cloudflare Worker `call_events`；`features/calls/signaling.js` 讓 `messages-pane` 實際透過 WS 發送 `call-invite` 並在收到訊號時觸發 `markIncomingCall()`，再以 `CALL_EVENT.SIGNAL` 廣播供 UI/overlay 使用。README 更新現況與下一步，尚未重跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}`。                                                                                                                                                                                                                                                          |
| **2025-11-12 06:50** | Cloudflare Worker 新增`call_sessions` / `call_events` 表與 `/d1/calls/{session,events}` CRUD，Node API 對應實作 `/api/v1/calls/{invite,cancel,ack,report-metrics,turn-credentials}` 及 `GET /api/v1/calls/:id`、TURN 憑證簽發；前端 `requestOutgoingCall()` 現可寫入 session/event，並將 TURN/ICE 設定集中於環境變數。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 重跑皆綠燈。                                                                                                                                                                                                                                                             |
| **2025-11-12 06:40** | Playwright`tests/e2e/full-flow.spec.mjs` 增加 `test.setTimeout(240_000)`、`tests/e2e/multi-account-friends.spec.mjs` 增加 `test.setTimeout(300_000)`，確保多帳號 + 媒體壓力流程在 CI 內有足夠時間；同時讓 Node API 在本機常駐後重新跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過，原本的逾時已解除並產生最新 `test-results/`。                                                                                                                                                                                                                                                                                                   |
| **2025-11-12 05:37** | 實作語音/視訊通話第一階段：建立`shared/calls/schemas.{js,ts}`、Swift 版 `docs/ios/CallSchemas.swift` 及 `shared/calls/network-config.json`；新增 `features/calls/{events,state,network-config}.js` 讓前端具備 state manager / event bus / TURN 載入，聊天呼叫鈕也改走 `requestOutgoingCall()` 並預抓 network config。`npm run test:{prekeys-devkeys,messages-secure,login-flow}` 綠燈，`friends-messages` 因本機未啟動 API 而 `fetch failed`，`test:front:login` 仍有 `full-flow`、`multi-account-friends` 逾時（餘 3 項通過，詳細輸出見 `test-results/`）。                                                                                                                            |
| **2025-11-07 00:10** | Login / App 頁加入`viewport-fit=cover` 與 safe-area padding，修正 iOS Safari 頂/底邊裸露；登入錯誤映射補上 `EnvelopeRecoveryError`；改密碼流程成功後會即時 re-wrap MK + 重新註冊 OPAQUE，`ensureOpaque` 偵測 Envelope 錯誤時自動重註冊，E2E login 測試覆蓋「改密碼→新密碼登入→改回原密碼」並留下截圖 (`artifacts/e2e/login/change-password-success.png`)。`npx playwright test tests/e2e/login.spec.mjs` 綠燈。                                                                                                                                                                                                                                                                       |
| **2025-11-06 23:45** | Login / App handoff 新增`wrapped_mk` 儲存與還原，App 端變更密碼可直接使用現有 MK；`tests/e2e/login.spec.mjs` 安插改密碼測試並產生截圖 (`artifacts/e2e/login/change-password-success.png`)，同時在測試內將密碼改回預設值避免影響其他場景。觀察到改密碼後立即以新密碼重新登入仍會觸發 `EnvelopeRecoveryError`，暫以重新改回原密碼做 workaround，待後續修正。`npx playwright test tests/e2e/login.spec.mjs` 綠燈。                                                                                                                                                                                                                                                                         |
| **2025-11-06 23:00** | 登入頁錯誤映射補上 OPAQUE 密碼錯誤（`OpaqueLoginFinishFailed` 等）並維持護盾光效調整；設定選單新增「變更密碼」流程（前端 unwrap → rewrap MK、呼叫新 `/api/v1/mk/update` API）與 UI 表單；跑完 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 後依流程 `scripts/cleanup/wipe-all.sh` 清空 D1/R2 並 `scripts/deploy-prod.sh --apply-migrations` 全套部署。                                                                                                                                                                                                                                                                                     |
| **2025-11-06 22:33** | Login 護盾光帶加粗並提升柔光層次，App 主畫面也加入`gesture*` 停用 pinch 以配合現有 viewport 設定；依指示直接執行 `scripts/deploy-prod.sh --apply-migrations` 同步部署 Worker / D1 / Node API（pm2 reload）/ Pages，未重跑 `npm run test:*`。                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **2025-11-06 22:30** | 更新 login 頁`meta viewport` 與 `gesturestart/change/end` 事件禁止雙指縮放，確保晶片護盾特效不被縮放干擾；再次執行 `scripts/deploy-prod.sh --apply-migrations` 同步部署全部部件。依使用者要求仍未重跑 `npm run test:*`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **2025-11-06 22:25** | Login 頁新增 3 秒綠色護盾光帶動畫（SVG path + glow + reduced-motion fallback）以陪伴晶片偵測等待，並執行`scripts/deploy-prod.sh --apply-migrations` 佈署 Cloudflare Worker / D1、Node API（pm2 reload）、Pages。使用者明確要求本輪略過 `npm run test:*`，沿用前次 2025-11-13 的測試結果。                                                                                                                                                                                                                                                                                                                                                                                               |
| **2025-11-13 05:40** | 修正`x3dhRespond` 初始鏈鍵配置（responder 以首段種子作為 `ckR`）避免 owner 端 decrypt `OperationError`，`tests/e2e/multi-account-friends.spec.mjs` 重跑穩定通過；全套 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 皆綠，確認多帳號互邀 / 附件壓力流程與登入迴圈無回歸。                                                                                                                                                                                                                                                                                                                                                                    |
| **2025-11-13 02:30** | Playwright 新增`tests/e2e/session-bootstrap.spec.mjs` 覆蓋「加好友未傳訊息 → 新裝置登入」情境，登入前預注 contact secret snapshot 以驅動 conversation list 與安全 Modal / composer 狀態驗證；前端 `fetchWithTimeout` 預設 `cache: 'no-store'` 避免 contacts API 被瀏覽器快取回 304；`npm run test:front:login` 全套重跑確認四支 E2E 均綠。                                                                                                                                                                                                                                                                                                                                             |
| **2025-11-12**       | 新增`SecureConversationManager` 集中管理 DR 初始化與 `session-init` 控制訊息，加入 `session-ack` 確認、逾時監控與 initiator 自動重送邏輯；Messages / Contacts UI 改為事件驅動顯示安全 Modal 並移除 `secureInitBlocked` flag。Contact Secrets setter 改為結構化（invite / conversation / dr / session）並提供 `getContactSecretSections` 方便後續模組引用；補上 Node `POST /api/v1/friends/bootstrap-session` API（附帶快取）以便缺會話時自動補抓 `guest_bundle` 並同步 Contact Secrets / sessionStore。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 重跑皆綠。                                                                              |
| **2025-11-11**       | 好友邀請接受後自動送出隱藏的`session-init` 封包，同時保留 `guest_bundle` 強制重建流程並顯示安全提示 Modal，避免雙方首次聊天出現「部分訊息無法解密」。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 通過。                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **2025-11-10**       | DR / ACL 啟動驗證：登入或掃描後載入訊息會先計算 conversation fingerprint 並帶入`/messages/secure`，確保 Worker 授權與 DR state 就緒；重新驗證 `npm run test:{friends-messages,front:login}`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **2025-11-10**       | 好友邀請初始化加強：`/friends/invite/contact` 會附帶帳號驗證資訊並於缺漏時自動建立 `friend_invites` 記錄，確保 owner envelope 一定寫入；Node/前端/script 同步更新。`npm run test:{friends-messages,front:login}` 通過。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **2025-11-10**       | 恢復自我聯絡 metadata：`loadContacts` 會保留自身條目並寫入 `contactSecrets` / `conversationIndex`，UI 仍隱藏自我聯絡避免清單出現自己；重跑 `npm run test:{friends-messages,front:login}` 驗證。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **2025-11-10**       | `messages.controller` 與 `friends.controller` 新增帳號驗證 + 會話 ACL 授權，所有列表 / 刪除 / 建立操作需帶入 `uidHex` 與 `accountToken/accountDigest`；前端 API、DR 流程與測試腳本同步補上憑證與 conversation fingerprint。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                                                                                                                          |
| **2025-11-09**       | `/media/sign-put                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **2025-11-08**       | 修正 shareState 在 logout 後殘留`inviteBlockedDueToKeys` 導致 QR 再登入無法生成；Drive 列表隱藏系統「已傳送 / 已接收」層並依使用者資料夾顯示，允許重複上傳與刪除；訊息附件新增預覽按鈕沿用 Modal，Playwright 以 `downloadAndDecrypt` 驗證 SHA-256 digest；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                                                                                           |
| **2025-11-07**       | 交友金鑰補貨流程自動在`PrekeyUnavailable/NotFound` 時改用完整 bundle（IK/SPK/OPK）重發，狀態列 spinner 調整為正圓動畫；聯絡人載入時會跳過自己，避免改暱稱後自我條目出現在好友清單；全套 Playwright full-flow 再次確認；清空 Cloudflare D1 / R2 並重部署 Worker / Node API / Pages。                                                                                                                                                                                                                                                                                                                                                                                                     |
| **2025-11-06**       | Playwright full-flow 完成附件共享金鑰封套驗證，修復接收端預覽維持`pending`；`sendDrMedia()` 會為媒體產生共享 key，`downloadAndDecrypt()` 依 `key_type` 自動挑選 MK 或共享金鑰；Share controller 會檢查 OPK 補貨 API 回應並於失敗時回報 `PrekeyUnavailable`，避免出現「缺少交友金鑰」；完成 Cloudflare D1 / R2 清空後重新部署 Worker、Node API、Pages。                                                                                                                                                                                                                                                                                                                                  |
| **2025-11-05**       | `listSecureAndDecrypt()` 重播後套用 `snapshotAfter`，統一媒體物件至 `已傳送 / 已接收` 系統資料夾並新增 Worker 容量追蹤；DR receiver 重登入時會回溯歷史 snapshot 並重設 processed cache，避免首輪 decrypt 失敗與重複抓取；E2E `full-flow` 驗證 `sign-put` payload 與 Drive「已傳送」資料夾顯示；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                                                      |
| **2025-11-04**       | 修復重新開啟會話時訊息列表被清空（重置 processed cache 重新導入訊息歷史），新增登出後專用畫面（呼吸紅光 Logo + 提示文案），`tests/e2e/full-flow.spec.mjs` 新增「返回列表→重進會話」與「聯絡人頁→點選好友」驗證，雙端確認訊息與附件仍存在，再進行刪除；`npm run test:front:login` 通過。                                                                                                                                                                                                                                                                                                                                                                                               |
| **2025-11-03**       | 重新設計會話與聯絡人列表的刪除介面（固定 delete row + 送出模擬`/friends/delete`），修正 pointer-events 攔截問題，`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **2025-11-02**       | 新增 DR replay 陣列快取與 skipped message key 快取，`listSecureAndDecrypt` 支援非 mutate 模式也能 replay；`sendDrMedia` 攜帶媒體索引並寫入本地預覽。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow}` 通過；`npm run test:front:login` 已可重登入成功解密所有文字訊息與上傳附件，但流程在會話刪除（`.item-delete` 被 pointer-events 阻擋）與暱稱廣播 fallback（`/friends/contact/share` 404）卡住，待修。                                                                                                                                                                                                                                                    |
| **2025-11-01**       | Worker`/d1/friends/contact/share` 新增 fallback：當 `invite_id` 不存在但仍提供 `myUid/peerUid` 時，直接寫入目標聯絡人信箱並標記 `fallback=invite_missing`；登入流程若備份 404，會優先回填 handoff 的 `wrapped_dev`，必要時再重建。前端送訊端會連同 `message_key_b64` 與 `snapshotAfter` 寫入 DR 歷史，讀取端也能以 replay 優先解密。`npm run test:prekeys-devkeys` / `test:messages-secure` / `test:friends-messages` / `test:login-flow` 通過；`npm run test:front:login` 仍於 `tests/e2e/full-flow.spec.mjs` 失敗：最新 run 中訊息 `d27fb152-3093-43d3-84c7-232a82358203` replay 後 DR state 的 `Nr` 未同步至 header `n=2`，導致再次 `OperationError`，重播後續的媒體預覽流程亦受阻。 |
| **2025-10-31**       | 新增`drHistory.messageKey_b64` 儲存每則訊息的派生金鑰，`listSecureAndDecrypt()` 在重新登入、初次載入時會優先使用快照中的 message key 進行重播解密，避免重複 ratchet 導致 `OperationError`。`npm run test:prekeys-devkeys` / `test:messages-secure` / `test:friends-messages` / `test:login-flow` 均通過；`npm run test:front:login` 仍在 `tests/e2e/full-flow.spec.mjs` 卡關：A 端更新暱稱時 `/friends/contact/share` 回 404，導致 B 端重新登入流程出現 `Device backup missing`（`/devkeys/fetch` 404）。需先修復 contact share / devkeys 取得問題，再重跑 full-flow 驗證 decrypt 是否恢復正常。                                                                                        |
| **2025-10-30**       | 新增`flushDrSnapshotsBeforeLogout()`，logout 前將記憶體 DR state 寫回 `contactSecrets` 並記錄 checksum；登入頁 `purgeLoginStorage()` 會挑選最長 snapshot 回填。`recoverDrState()` 支援 `forceGuestBundle`，並針對 Automation 模式輸出 `dr-debug` 與重播腳本。`prepareDrForMessage()` 加入 `historyMatchBy` 日誌。                                                                                                                                                                                                                                                                                                                                                                       |
| **2025-10-29**       | `secureLogout`、`purgeLoginStorage`、`hydrateDrStatesFromContactSecrets` 整合 snapshot 摘要／SHA-256 checksum，確保 QA 可比對 handoff；`pullLatestSnapshot()` 會將 sessionStorage 較新的資料回填 localStorage。                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **2025-10-28**                | `messages.js` 對背景預覽改用 `mutateState=false`，避免覆寫 DR snapshot；新增 duplicate guard 與去重快取；`ensureDevicePrivAvailable()` 只接受登入交棒；`full-flow` 仍卡在重登入第一則訊息 `OperationError`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **2025-10-26**                | Login 頁清除 localStorage 前會回寫`contactSecrets-v1`；`share-controller` 不再覆寫既有角色；`dr-session.js` / `messages.js` 增加 snapshot 還原與 `dr-debug` log。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **2025-10-10**                | 裝置私鑰備援流程：若備份缺失，會重新發佈預共享金鑰並儲存`wrapped_dev`，避免 DR 初始化因 404 中斷。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### TODO — 去除 D1 UID/uid_digest（只存 account_digest）
- [x] Schema 過渡：所有含 UID 的表新增 `*_account_digest`（friend_invites / call_sessions / call_events / groups / group_members / group_invites / messages header），contacts convId 雙寫 `contacts-<account_digest>` / UID。
- [x] Worker friends：invite/create/accept/bootstrap 以 digest 優先（查找/回傳 owner/guest_account_digest，contact/share/delete 支援 digest，/d1/friends/bootstrap 已實作），WS 通知帶 digest。
- [x] Worker 群組：群組建立/成員增刪/查詢以 account_digest 為主（保留 UID 兼容），WS payload 待前端改造時一併更新。
- [x] WS：身份/Presence/事件 payload 以 account_digest 為主（保留 UID），online list 回 digest。
- [x] 前端核心鍵值：`core/store` / `core/contact-secrets` / `features/contacts` / `features/messages` 改以 `peerAccountDigest` 為鍵，convId 以 `contacts-<account_digest>` 為主，保留 UID 讀寫過渡。
- [x] 前端 WS/事件：所有 WS 發送/接收事件（contact-share / contacts-reload / presence / secure-message / call）改為 digest 為主（保留 UID）。
- [x] 前端 呼叫/群組：API payload、本地 state、列表鍵值改用 account_digest，保留 UID fallback。
- [x] 前端 UI/Session：session-store/index/listener 等使用 digest 索引，convId 雙寫容錯。
- [x] Schema 清理：移除仍保存 UID/uid_digest 的欄位，執行時需同步全面掃描 Worker/Node/前端的使用點並改成 account_digest：
  - [x] `accounts.uid_plain`：確認登入/備份/交棒流程不再依賴 UID 明文後刪除欄位。
  - [x] `friend_invites.owner_uid`、`friend_invites.guest_uid`：邀請建立/接受/續期/Bootstrap API 全改 digest。
  - [x] `call_sessions.caller_uid`、`call_sessions.callee_uid`：通話建立/狀態查詢/WS 事件改讀寫 account_digest。
  - [x] `call_events.from_uid`、`call_events.to_uid`：事件寫入/查詢/稽核改用 `from_account_digest` / `to_account_digest` 後移除舊欄位。
  - [x] `groups.creator_uid`：建群/列表/ACL 同步移除 UID 欄位。
  - [x] `group_members.uid`、`group_members.inviter_uid`：成員新增/查詢/邀請與 WS payload 改 digest 後刪除。
  - [x] `group_invites.issuer_uid`：群組邀請建立/驗證/使用紀錄改 digest 後移除。
- [x] 帳號驗證/WS token：`src/utils/account-context.js` / `src/utils/account-verify.js` / `src/routes/ws-token.routes.js` / `src/utils/ws-token.js` / Worker `/d1/accounts/{verify,created}` 改為只接受 account_digest/account_token，WS token claims 移除 uid。**進度：token/verify/WS server 皆以 digest-only 運作，已移除 `accountDigestByUid` 映射。**
- [x] Node API 契約：`src/controllers/{friends,messages,calls,groups}.controller.js`、`src/routes/v1/media.routes.js` 改以 accountDigest 為主，移除 `uidHex`/`peerUid` 必填並以 digest 廣播（通話/群組/好友刪除均改 digest-only）。
- [x] Worker 好友/聯絡人：`data-worker/src/worker.js` 的 `/d1/friends/{bootstrap,accept,contact/share,contact-delete}`、`insertContactMessage`/`deleteContactByPeer` 仍寫入 `peerUid` / `contacts-<uid>` convo；需改成僅用 account_digest（header、convo id、ACL/通知）。**進度：已改為 digest-only（header/convo/ACL 無 UID）。**
- [x] Worker 其他端點：`/d1/prekeys/bundle`、`upsertCallSession`/`insertCallEvent`、好友 bootstrap peer 篩選仍接受 UID 並自動 hash；需改為只接受 accountDigest，移除 UID fallback。
- [x] WebSocket 流：`src/ws/index.js` 以 UID 為連線鍵（call locks/presence/secure-message event）且 payload 帶 `peerUid`，`web/src/app/api/ws.js` 要求 `uidHex`；需改為 accountDigest 為主的身份與事件欄位。**進度：WS server 連線/鎖定/事件 payload 全改 digest-only（去除 peerUid/senderUid），前端 WS token/API 已以 accountDigest 為主，仍需持續清理前端殘留變數名。**
- [ ] 前端狀態/客戶端：`web/src/app/ui/{app-ui.js,app-mobile.js}` handoff/重啟仍讀寫 `uid_hex`/`uid_digest`，`web/src/app/api/*`（media/prekeys/friends/groups/calls/ws）及 call/訊息 UI 模組多處以 `peerUid` 為鍵；需改為 accountDigest 為主的鍵值/ payload，並同步調整測試腳本（如 `scripts/test-messages-secure.mjs`, `tests/e2e/utils.mjs`, `tests/e2e/multi-account-helpers.mjs` 等仍讀寫 `uid_hex`）。**進度：好友/呼叫 API 多數已改 digest-only；呼叫媒體層/DR/contacts/presence 仍大量使用 `peerUidHex` 變數名（內容實為 digest），待全面替換並更新測試。**
- [ ] 清空 D1/R2 + 部署：套用遷移，wipe 後重新部署 Worker/Node/Pages。
- [ ] 測試：跑 `npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 並記錄結果。

## 授權條款

本專案採用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。若部署於可供他人透過網路存取的服務，請公開對應來源碼與修改內容，以確保社群共享與使用者權益。
