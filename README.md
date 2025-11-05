# SENTRY Message — 技術筆記

> 近期進度：修復 logout→relogin 後分享面板持續顯示「缺少交友金鑰」造成 QR 無法重生的問題，重置 shareState 會清除補貨鎖定並恢復自動補貨；Drive 面板改以使用者資料夾為主並隱藏系統「已傳送 / 已接收」層，避免上傳檔案被困且可再次上傳 / 刪除；訊息附件新增「預覽」動作沿用 Modal 下載流程並於 Playwright 內實際執行 `downloadAndDecrypt` 驗證 SHA-256 digest，確認接收端確實可還原檔案；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過，後續將持續強化 Drive / 聊天 UI（#12~#15）。

---

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
8. [Codex 修改追蹤](#codex-修改追蹤)
9. [授權條款](#授權條款)

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

必要環境變數（摘要）：`DATA_API_URL`, `DATA_API_HMAC`, `WS_TOKEN_SECRET`, `S3_*`, `NTAG424_*`, `OPAQUE_*`, `ACCOUNT_TOKEN_BYTES`, `SIGNED_{PUT,GET}_TTL`, `UPLOAD_MAX_BYTES`。細節見[安全預設](#安全預設與環境配置)。

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

### 媒體、設定與資料夾命名

- **媒體 / Drive**：`encryptAndPutWithProgress()` 用 MK 加密 → `/media/sign-put` → R2 上傳；接收端 `/media/sign-get` → 解密。Drive 系統資料夾命名為 `drive-<acctDigest>`（必要時以 MK-HMAC 分段）。
- **設定**：`settings-<acctDigest>` 以 MK 包裝 `{ showOnlineStatus, autoLogoutOnBackground }`；App 啟動時 `ensureSettings()`，更新立即 `saveSettings()`。
- **其餘 envelope**：Profile/聯絡人/訊息/媒體皆以 MK 衍生 AES-GCM；儲存層只保存密文。

---

## 安全預設與環境配置

- **登出清理**：`secureLogout()` 先 `flushDrSnapshotsBeforeLogout()` 與 `persistContactSecrets()`，將 JSON 寫入 sessionStorage + `contactSecrets-v1-latest`，再清除 cache/indexedDB 等。
- **登入頁**：`purgeLoginStorage()` 會挑選最長 snapshot 回填 localStorage，並輸出 checksum（`contactSecretsSeed*`）供 QA 比對。
- **背景自動登出**：`autoLogoutOnBackground`（預設 true）在 App 退到背景時觸發 `secureLogout()`。
- **環境變數**（常用）：`NTAG424_*`, `ACCOUNT_HMAC_KEY`, `OPAQUE_*`, `DATA_API_*`, `S3_*`, `UPLOAD_MAX_BYTES`, `SIGNED_{PUT,GET}_TTL`, `SERVICE_*`, `ACCOUNT_TOKEN_BYTES`, `CORS_ORIGIN` 等。

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

5. 若任何 Production 測試失敗，需先排除問題並重新部署，直到正式環境也全部通過為止。

---

## 測試與自動化

> 修改程式碼後務必跑以下測試；若跳過，需在回報中說明原因與風險。
> 正式釋出前，需再將 `ORIGIN_API`（及 `E2E_ORIGIN_API`）指向 Production，重跑同組測試確認線上環境也為綠燈。


| 指令                            | 腳本                                | 覆蓋範圍 / 期望                                                                                                          |
| ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:prekeys-devkeys`  | `scripts/test-prekeys-devkeys.mjs`  | SDM → exchange →`/keys/publish` → `/devkeys/store                                                                     |
| `npm run test:messages-secure`  | `scripts/test-messages-secure.mjs`  | 建立 secure envelope、列表至少一筆。                                                                                     |
| `npm run test:friends-messages` | `scripts/test-friends-messages.mjs` | 兩位用戶註冊→邀請→互傳訊息並解密。需先啟動 Node API。                                                                  |
| `npm run test:login-flow`       | `scripts/test-login-flow.mjs`       | SDM → OPAQUE（必要時註冊）→`/mk/store` → 再次 exchange 應 `hasMK=true`。                                              |
| `npm run test:front:login`      | Playwright (`tests/e2e/*.spec.mjs`) | 驗證登入、暱稱/頭像、檔案操作、雙向訊息、對話/聯絡人刪除、登出。需啟動 API，首次請`npx playwright install --with-deps`。 |

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
```

### GitHub Actions

- Workflow：`.github/workflows/e2e.yml`
- 觸發：PR → `main` 或 `workflow_dispatch`
- 需設定 `E2E_ORIGIN_API`（建議指向 Staging）
- 任務：`Prekeys & Devkeys`、`Messages Secure`
- 建議在 Branch Protection 要求上述檢查通過才能合併。

---

## 重構待辦

- [x] **協定管理層**
  - [x] 建立 `SecureConversationManager` 集中處理 X3DH / DR 初始化、`session-init` 控制訊息與狀態轉換，統一產出 `pending/ready/failed` 狀態。
  - [x] Messages / Contacts UI 改為訂閱狀態事件（安全 Modal、輸入鎖定），移除舊有布林旗標與 `ensureDrReceiverState` 直呼。
  - [ ] 擬定控制訊息策略（如 session ack / 重送）並評估伺服器端 bootstrap API。
- [ ] **Contact Secrets 結構化**
  - [x] 拆分 invite metadata、DR snapshot、history、session-bootstrap 標記等資料結構，改寫為型別化 getter/setter。
  - [x] 重新整理 storage 序列化 / 還原流程，確保跨 session 邏輯簡潔。
- [ ] **控制訊息通道**
  - [ ] 定義 `msg_type` 枚舉並集中處理（例如 `session-init`, `session-ack`），避免散落於 UI 層判斷。
  - [ ] 評估 Server 端增加 session bootstrap API 或 Worker 流程，減少靠純訊息封包 workaround。
- [ ] **測試補強**
  - [ ] 增加「加好友未傳訊息 → 切換裝置 → 進入對話」等 E2E 場景，驗證安全 modal、錯誤訊息行為與狀態同步。
  - [ ] 覆蓋 `listSecureAndDecrypt` 控制訊息 / replay 場景的單元測試。
- [ ] **文件與設計視圖**
  - [ ] 製作新流程圖（邀請 → Contact Secrets → DR ready → 訊息傳遞），更新 README 或 `/docs`。
  - [ ] 補充重構後的狀態圖 / API 契約，便於後續維護。

---

## 最新進度與工作項目

### 時間軸

- **目前狀態**：`SecureConversationManager` 已接手 DR 初始化與 `session-init` 控制訊息，Messages / Contacts UI 透過狀態事件自動顯示安全對話 Modal、解除輸入鎖定並移除 `secureInitBlocked` 等布林旗標；`listSecureAndDecrypt` 改由集中管理器確保會話就緒與回溯。Contact Secrets 更新流程改為結構化 getter/setter（`invite/conversation/dr/session` 四層），同步新增 `getContactSecretSections` 方便後續模組引用並導入版本化儲存格式。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數綠燈。
- **下一步**：設計控制訊息枚舉與 session ack 流程，評估 server 端 bootstrap API 需求並補齊測試／文件。


| 日期                    | 里程碑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **2025-11-12（Codex）** | 新增 `SecureConversationManager` 集中管理 DR 初始化與 `session-init` 控制訊息，Messages / Contacts UI 改為事件驅動顯示安全 Modal 並移除 `secureInitBlocked` flag；Contact Secrets setter 改為結構化（invite / conversation / dr / session）並提供 `getContactSecretSections` 方便後續模組引用。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 重跑皆綠。 |
| **2025-11-11（Codex）** | 好友邀請接受後自動送出隱藏的 `session-init` 封包，同時保留 `guest_bundle` 強制重建流程並顯示安全提示 Modal，避免雙方首次聊天出現「部分訊息無法解密」。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 通過。 |
| **2025-11-10（Codex）** | DR / ACL 啟動驗證：登入或掃描後載入訊息會先計算 conversation fingerprint 並帶入 `/messages/secure`，確保 Worker 授權與 DR state 就緒；重新驗證 `npm run test:{friends-messages,front:login}`。 |
| **2025-11-10（Codex）** | 好友邀請初始化加強：`/friends/invite/contact` 會附帶帳號驗證資訊並於缺漏時自動建立 `friend_invites` 記錄，確保 owner envelope 一定寫入；Node/前端/script 同步更新。`npm run test:{friends-messages,front:login}` 通過。 |
| **2025-11-10（Codex）** | 恢復自我聯絡 metadata：`loadContacts` 會保留自身條目並寫入 `contactSecrets` / `conversationIndex`，UI 仍隱藏自我聯絡避免清單出現自己；重跑 `npm run test:{friends-messages,front:login}` 驗證。 |
| **2025-11-10（Codex）** | `messages.controller` 與 `friends.controller` 新增帳號驗證 + 會話 ACL 授權，所有列表 / 刪除 / 建立操作需帶入 `uidHex` 與 `accountToken/accountDigest`；前端 API、DR 流程與測試腳本同步補上憑證與 conversation fingerprint。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。 |
| **2025-11-09（Codex）** | `/media/sign-put|get` 強制驗證登入帳號並透過 Worker `/d1/conversations/authorize` 檢查會話授權，若缺 ACL 則憑指紋自動補建；聯絡人列表過濾自身 UID / Digest 以免更新頭像時出現自己。前端簽名請求自動帶入憑證，`scripts/r2-media-test.sh` 更新支援新欄位。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                        |
| **2025-11-08（Codex）** | 修正 shareState 在 logout 後殘留`inviteBlockedDueToKeys` 導致 QR 再登入無法生成；Drive 列表隱藏系統「已傳送 / 已接收」層並依使用者資料夾顯示，允許重複上傳與刪除；訊息附件新增預覽按鈕沿用 Modal，Playwright 以 `downloadAndDecrypt` 驗證 SHA-256 digest；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                                                                                           |
| **2025-11-07（Codex）** | 交友金鑰補貨流程自動在`PrekeyUnavailable/NotFound` 時改用完整 bundle（IK/SPK/OPK）重發，狀態列 spinner 調整為正圓動畫；聯絡人載入時會跳過自己，避免改暱稱後自我條目出現在好友清單；全套 Playwright full-flow 再次確認；清空 Cloudflare D1 / R2 並重部署 Worker / Node API / Pages。                                                                                                                                                                                                                                                                                                                                                                                                     |
| **2025-11-06（Codex）** | Playwright full-flow 完成附件共享金鑰封套驗證，修復接收端預覽維持`pending`；`sendDrMedia()` 會為媒體產生共享 key，`downloadAndDecrypt()` 依 `key_type` 自動挑選 MK 或共享金鑰；Share controller 會檢查 OPK 補貨 API 回應並於失敗時回報 `PrekeyUnavailable`，避免出現「缺少交友金鑰」；完成 Cloudflare D1 / R2 清空後重新部署 Worker、Node API、Pages。                                                                                                                                                                                                                                                                                                                                  |
| **2025-11-05（Codex）** | `listSecureAndDecrypt()` 重播後套用 `snapshotAfter`，統一媒體物件至 `已傳送 / 已接收` 系統資料夾並新增 Worker 容量追蹤；DR receiver 重登入時會回溯歷史 snapshot 並重設 processed cache，避免首輪 decrypt 失敗與重複抓取；E2E `full-flow` 驗證 `sign-put` payload 與 Drive「已傳送」資料夾顯示；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                                                      |
| **2025-11-04（Codex）** | 修復重新開啟會話時訊息列表被清空（重置 processed cache 重新導入訊息歷史），新增登出後專用畫面（呼吸紅光 Logo + 提示文案），`tests/e2e/full-flow.spec.mjs` 新增「返回列表→重進會話」與「聯絡人頁→點選好友」驗證，雙端確認訊息與附件仍存在，再進行刪除；`npm run test:front:login` 通過。                                                                                                                                                                                                                                                                                                                                                                                               |
| **2025-11-03（Codex）** | 重新設計會話與聯絡人列表的刪除介面（固定 delete row + 送出模擬`/friends/delete`），修正 pointer-events 攔截問題，`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **2025-11-02（Codex）** | 新增 DR replay 陣列快取與 skipped message key 快取，`listSecureAndDecrypt` 支援非 mutate 模式也能 replay；`sendDrMedia` 攜帶媒體索引並寫入本地預覽。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow}` 通過；`npm run test:front:login` 已可重登入成功解密所有文字訊息與上傳附件，但流程在會話刪除（`.item-delete` 被 pointer-events 阻擋）與暱稱廣播 fallback（`/friends/contact/share` 404）卡住，待修。                                                                                                                                                                                                                                                    |
| **2025-11-01（Codex）** | Worker`/d1/friends/contact/share` 新增 fallback：當 `invite_id` 不存在但仍提供 `myUid/peerUid` 時，直接寫入目標聯絡人信箱並標記 `fallback=invite_missing`；登入流程若備份 404，會優先回填 handoff 的 `wrapped_dev`，必要時再重建。前端送訊端會連同 `message_key_b64` 與 `snapshotAfter` 寫入 DR 歷史，讀取端也能以 replay 優先解密。`npm run test:prekeys-devkeys` / `test:messages-secure` / `test:friends-messages` / `test:login-flow` 通過；`npm run test:front:login` 仍於 `tests/e2e/full-flow.spec.mjs` 失敗：最新 run 中訊息 `d27fb152-3093-43d3-84c7-232a82358203` replay 後 DR state 的 `Nr` 未同步至 header `n=2`，導致再次 `OperationError`，重播後續的媒體預覽流程亦受阻。 |
| **2025-10-31（Codex）** | 新增`drHistory.messageKey_b64` 儲存每則訊息的派生金鑰，`listSecureAndDecrypt()` 在重新登入、初次載入時會優先使用快照中的 message key 進行重播解密，避免重複 ratchet 導致 `OperationError`。`npm run test:prekeys-devkeys` / `test:messages-secure` / `test:friends-messages` / `test:login-flow` 均通過；`npm run test:front:login` 仍在 `tests/e2e/full-flow.spec.mjs` 卡關：A 端更新暱稱時 `/friends/contact/share` 回 404，導致 B 端重新登入流程出現 `Device backup missing`（`/devkeys/fetch` 404）。需先修復 contact share / devkeys 取得問題，再重跑 full-flow 驗證 decrypt 是否恢復正常。                                                                                        |
| **2025-10-30（Codex）** | 新增`flushDrSnapshotsBeforeLogout()`，logout 前將記憶體 DR state 寫回 `contactSecrets` 並記錄 checksum；登入頁 `purgeLoginStorage()` 會挑選最長 snapshot 回填。`recoverDrState()` 支援 `forceGuestBundle`，並針對 Automation 模式輸出 `dr-debug` 與重播腳本。`prepareDrForMessage()` 加入 `historyMatchBy` 日誌。                                                                                                                                                                                                                                                                                                                                                                       |
| **2025-10-29（Codex）** | `secureLogout`、`purgeLoginStorage`、`hydrateDrStatesFromContactSecrets` 整合 snapshot 摘要／SHA-256 checksum，確保 QA 可比對 handoff；`pullLatestSnapshot()` 會將 sessionStorage 較新的資料回填 localStorage。                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **2025-10-28**          | `messages.js` 對背景預覽改用 `mutateState=false`，避免覆寫 DR snapshot；新增 duplicate guard 與去重快取；`ensureDevicePrivAvailable()` 只接受登入交棒；`full-flow` 仍卡在重登入第一則訊息 `OperationError`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **2025-10-26**          | Login 頁清除 localStorage 前會回寫`contactSecrets-v1`；`share-controller` 不再覆寫既有角色；`dr-session.js` / `messages.js` 增加 snapshot 還原與 `dr-debug` log。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **2025-10-10**          | 裝置私鑰備援流程：若備份缺失，會重新發佈預共享金鑰並儲存`wrapped_dev`，避免 DR 初始化因 404 中斷。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 工作清單

1. [X]  **優先**：恢復自我聯絡 metadata 流程：保留 `contactSecrets` / `conversationIndex` 的自我紀錄，僅在 UI 隱藏避免自我條目顯示。
2. [X]  **優先**：穩定邀請初始化：`/friends/invite/contact` 加入帳號驗證與缺漏補建流程，owner envelope 一定寫入，掃描端不再遇到 `friend_invites` 404。
3. [X]  **優先**：DR / ACL 啟動驗證：登入或掃描後確認 fingerprint / DR state 完整，杜絕「部分訊息無法解密」。
4. [X]  修復 `/friends/contact/share` 403。
5. [X]  調整好友刪除→登出流程，確保 mobile 可操作 user menu。
6. [X]  修復 `/friends/contact/share` 404 及重登入流程中 `/api/v1/devkeys/fetch` 404（`Device backup missing`），已可正常取得備份並送出聯絡更新。
7. [X]  追蹤 `full-flow` 重登入後 `OperationError`（`Nr`/`n` counter 落差），已靠 replay message key + skipped chain 快取修復。
8. [X]  驗證 replay 成功時 DR state 套用 `snapshotAfter` 以避免 `Nr` 落後，更新 replay 後的狀態同步邏輯並完成全套測試。
9. [X]  完成端對端檔案傳輸（圖片 / 影片 / 一般檔案），強制 500 MB 以內並全程加密。
10. [X]  更新 Node API / Worker / R2 儲存策略：建立「已傳送 / 已接收」系統資料夾並套用 500 MB 限制（`/media/sign-put` 透過 `/d1/media/usage` 檢查容量並寫入 `media_objects`）。
11. [X]  **優先**：DR snapshot 還原：messageId-based cursor 已實作，仍需排查重登入首輪 decrypt 失敗 & UI 重複 fetch。
12. [X]  **優先**：`messages-pane` duplicate 判斷與 `recordDrMessageHistory` 時序調整，避免第一則訊息誤判。
13. [X]  **優先**：完成 `contactSecrets-v1` logout→login handoff：logout 必須寫入 sessionStorage，login/App 初始化可回填 localStorage。
14. [X]  **優先**：`listSecureAndDecrypt` 狀態隔離：僅允許前景對話 `mutateState=true`，其餘使用 snapshot clone，並紀錄 log 以偵測回朔。
15. [X]  **優先**：比對 logout / relogin snapshot 長度：確保最新 `drState` 同步到 `contactSecrets-v1`，提供 checksum 供 QA 驗證。
16. [X]  `full-flow` Playwright：會話刪除按鈕被 topbar/內容攔截，導致 `.item-delete` 無法點擊，需調整 UI pointer-events。
17. [X]  附件接收端可視化：訊息附件新增「預覽」動作沿用 Modal 並提供下載，E2E 透過 `downloadAndDecrypt` 驗證 SHA-256 digest 確保可還原檔案。
18. [X]  好友邀請交友金鑰補貨強化：登入後應即時顯示補貨階段、精準提示失敗原因、提供人工重試並擴大自動重試，避免「缺少交友金鑰」無明確導因。
19. [X]  **安全**：WebSocket `/ws` 缺乏身份驗證，任何客戶端都能送出 `{type:'auth',uid}` 直接綁定任意 UID，導致 presence / contact-share 廣播外洩（見 `src/ws/index.js:46-105`）。現已改為 `/api/v1/ws/token` 簽發短期 HMAC token，server 驗證後才綁定連線。
20. [X]  **安全**：媒體簽章 API (`/api/v1/media/sign-put|get`) 已強制攜帶帳號憑證並呼叫 Worker `/d1/conversations/authorize` 核對會話 ACL，避免未授權取得簽名 URL。
21. [X]  **安全**：訊息與好友 REST API 已要求 `uidHex` + `accountToken/accountDigest` 驗證並呼叫 Worker `/d1/conversations/authorize`，未授權的 `convId` 請求會被拒絕；前端 API 與腳本同步帶入憑證與 conversation fingerprint。
22. [ ]  前端 UI：Drive / 聊天支援選檔、預覽、上傳進度、系統資料夾操作。（已隱藏系統「已傳送 / 已接收」夾層，待補多檔案與排序）
23. [ ]  Playwright 新增檔案傳輸、Drive 同步、下載驗證等情境。
24. [ ]  暱稱廣播 `/friends/contact/share` 仍回 404 fallback，B 端未即時更新新暱稱，需檢查 invite 缺失案例處理與重新拉取機制。

---

## Codex 修改追蹤


| 時間 (UTC)       | 說明                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2025-11-12 08:10 | 建立 `SecureConversationManager` 集中處理 DR 初始化 / `session-init` 狀態，Messages / Contacts UI 改為訂閱狀態事件並關閉舊有 `secureInitBlocked` 流程；`listSecureAndDecrypt` 改透過管理器確認會話就緒。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                          |
| 2025-11-10 11:40 | `loadContacts` 恢復自我聯絡紀錄，標記為 hidden 以供 UI 遮蔽但維持 `contactSecrets` / `conversationIndex`；`contacts-view` 僅在渲染時忽略 hidden 條目。`npm run test:{friends-messages,front:login}` 通過。                                                                                                                     |
| 2025-11-10 09:20 | Drive 上傳彈窗支援多檔案選擇、清單預覽與逐檔進度提示；批次上傳流程沿用加密上傳並在每檔完成後刷新列表。`npm run test:front:login` 通過。                                                                                                                                                                                                                  |
| 2025-11-10 07:15 | `messages.controller` / `friends.controller` 加入帳號驗證與會話 ACL 授權，前端 API、DR 流程與腳本同步帶入 `uidHex`、`accountToken/accountDigest` 及 conversation fingerprint；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。                                                                                       |
| 2025-11-09 06:30 | 強化 `/api/v1/media/sign-put|get`：簽名請求需帶入 UID 與 `accountToken/accountDigest`，並呼叫 Worker `/d1/conversations/authorize` 檢查 `conversation_acl`；好友聯絡分享會同步登記 ACL。前端簽名流程與 `scripts/r2-media-test.sh` 補齊新欄位。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全數通過。            |
| 2025-11-08 07:20 | Reset shareState 時同步清除`inviteBlockedDueToKeys`，修復重登入後分享面板無法再產生交友 QR；Drive pane 以使用者資料夾呈現並隱藏系統夾層、清理資料夾操作與刪除比對；訊息附件新增預覽按鈕沿用 Modal，並在 Playwright 內以 `downloadAndDecrypt` 驗證附件 digest；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 全部通過。       |
| 2025-11-07 08:40 | `share-controller` 補貨失敗時自動改送完整 IK/SPK/OPK bundle，並固定邀請狀態列 spinner 為正圓；`loadContacts` 過濾自己帳號避免自我條目；重跑 Playwright full-flow，清除 Cloudflare D1 / R2 後重新部署所有元件。                                                                                                                                                          |
| 2025-11-06 08:20 | 媒體訊息改用共享封套金鑰（`sendDrMedia` 產生 32-byte key、`downloadAndDecrypt` 依 `key_type` 解密），修復接收端附件預覽長時間 `pending`；Playwright `tests/e2e/full-flow.spec.mjs` 通過後清除 Cloudflare D1 / R2 並以 `scripts/deploy-prod.sh --apply-migrations` 重新部署 Worker / Node API / Pages。                                                                  |
| 2025-11-06 09:30 | `share-controller` 於補貨 OPK 時檢查 `/api/v1/keys/publish` 回應，若失敗會回拋錯誤並觸發自動重試，避免再次遇到「生成失敗：缺少交友金鑰」。                                                                                                                                                                                                                              |
| 2025-11-06 06:40 | Share controller 於生成邀請前自動補貨 OPK，`PrekeyUnavailable` 會觸發一次補貨並重試；登入頁新增首次初始化進度指示（OPAQUE、MK、Prekeys 等步驟顯示）；同時為 Playwright full-flow 新增附件 digest 驗證，確認接收端可成功解密下載並比對 SHA-256。                                                                                                                         |
| 2025-11-06 04:30 | `listSecureAndDecrypt` 在非前景對話改採 DR 狀態 clone + replay 補正，`prepareDrForMessage` 支援預覽模式並補強 history cursor；`pullLatestSnapshot` 比對 bytes/timestamp/checksum 後回寫 localStorage，logout handoff 會同步 meta/checksum；訊息面板新增 messageId 去重；`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 通過。 |
| 2025-11-05 10:40 | `/media/sign-put` 加入系統資料夾（已傳送/已接收）路徑與 500 MB 容量檢查，Worker 新增 `/d1/media/usage` 並記錄 `media_objects`，前端統一帶入 direction；重跑全套測試通過。                                                                                                                                                                                              |
| 2025-11-05 12:30 | `ensureDrReceiverState` 若缺會話狀態會回溯 `drHistory` snapshot，並在切換對話時重置 processed cache，緩解重登入首輪 decrypt 失敗與重複抓取；同步更新 Drive/聊天測試並重跑全套。                                                                                                                                                                                         |
| 2025-11-04 14:10 | 新增`/pages/logout.html`（紅光呼吸 Logo + 提示文案），`secureLogout` 改導向該頁；同步更新 README 與 E2E 驗證記錄。                                                                                                                                                                                                                                                      |
| 2025-11-04 12:05 | `messages-pane` 重新進入對話時會重置 processed cache，確保舊訊息仍會載入；`tests/e2e/full-flow.spec.mjs` 增加「回到列表再進入」與「聯絡人頁點選好友」雙端驗證；`npm run test:front:login` 通過。                                                                                                                                                                        |
| 2025-11-04 08:30 | `tests/e2e/full-flow.spec.mjs` 刪除前新增雙端回到訊息列表再進入對話的驗證步驟，確認歷史訊息與附件完好；`npm run test:front:login` 通過。                                                                                                                                                                                                                                |
| 2025-11-03 09:10 | 重新設計訊息/聯絡人 delete row、導入`sessionStore.deletedConversations` 與 `/friends/delete` 模擬請求，`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow,front:login}` 通過。                                                                                                                                                                  |
| 2025-11-02 07:40 | `listSecureAndDecrypt` 擴充 replay 條件、`drDecryptText` 新增 skipped message key 快取，修正重登入後 `OperationError`；同步補上 OperationError → 歷史快照還原流程。                                                                                                                                                                                                    |
| 2025-11-01 06:12 | Worker contact-share 增加 invite 缺失 fallback，並於登入流程缺備份時優先回填 handoff，再自動重建裝置金鑰；同期調整登入流程把 fallback 備份回傳給 handoff。                                                                                                                                                                                                              |
| 2025-10-10 04:58 | 針對收訊端解密失敗，於`web/src/app/features/dr-session.js` 新增裝置金鑰備援流程；若備份缺失會重新發佈預共享金鑰並儲存 `wrapped_dev`，避免 DR 初始化因 404 中斷。                                                                                                                                                                                                        |

> 後續 Codex 請持續在此表更新紀錄，並同步 `最新進度` 章節。

---

## 授權條款

本專案採用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。若部署於可供他人透過網路存取的服務，請公開對應來源碼與修改內容，以確保社群共享與使用者權益。
