# SENTRY Message — 技術筆記

> 近期進度：`npm run test:prekeys-devkeys`、`test:messages-secure`、`test:friends-messages`、`test:login-flow` 皆通過；`npm run test:front:login` 仍在 `tests/e2e/full-flow.spec.mjs` 的重登入階段解密失敗（`drDecryptText → OperationError`）。請依最新進度章節追蹤修復，完成後重跑 full-flow。

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

必要環境變數（摘要）：`DATA_API_URL`, `DATA_API_HMAC`, `S3_*`, `NTAG424_*`, `OPAQUE_*`, `ACCOUNT_TOKEN_BYTES`, `SIGNED_{PUT,GET}_TTL`, `UPLOAD_MAX_BYTES`。細節見[安全預設](#安全預設與環境配置)。

開發流程請遵循 `Prompt.md`：新 session 先閱讀 README 最新進度 → 選定優先事項 → 修改後自跑測試 → 更新此文件紀錄。

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

| 元件 | 職責 |
| --- | --- |
| **前端 (web)** | 管理登入流程、端到端加密、UI；所有敏感資料在瀏覽器記憶體處理。 |
| **Node API (src)** | 驗證 SDM、代理 OPAQUE、媒體索引、devkeys/prekeys 管理、WebSocket presence。僅接觸密文與索引。 |
| **Cloudflare Worker (data-worker)** | 以 HMAC 驗證 Node 請求，操作 D1：帳號、邀請、訊息索引、prekey 庫存等。 |
| **R2** | 儲存加密媒體／頭像，透過 `/media/sign-put|get` 產生短時 URL。 |
| **SessionStorage / LocalStorage** | 登入→App handoff 用途（`mk_b64`、`account_token` 等）與 `contactSecrets-v1` 快照；App 讀取後立即清空。 |

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

---

## 測試與自動化

> 修改程式碼後務必跑以下測試；若跳過，需在回報中說明原因與風險。

| 指令 | 腳本 | 覆蓋範圍 / 期望 |
| --- | --- | --- |
| `npm run test:prekeys-devkeys` | `scripts/test-prekeys-devkeys.mjs` | SDM → exchange → `/keys/publish` → `/devkeys/store|fetch`；expect publish/store 204、fetch 取得 `wrapped_dev`。 |
| `npm run test:messages-secure` | `scripts/test-messages-secure.mjs` | 建立 secure envelope、列表至少一筆。 |
| `npm run test:friends-messages` | `scripts/test-friends-messages.mjs` | 兩位用戶註冊→邀請→互傳訊息並解密。需先啟動 Node API。 |
| `npm run test:login-flow` | `scripts/test-login-flow.mjs` | SDM → OPAQUE（必要時註冊）→ `/mk/store` → 再次 exchange 應 `hasMK=true`。 |
| `npm run test:front:login` | Playwright (`tests/e2e/*.spec.mjs`) | 驗證登入、暱稱/頭像、檔案操作、雙向訊息、對話/聯絡人刪除、登出。需啟動 API，首次請 `npx playwright install --with-deps`。 |

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

## 最新進度與工作項目

### 時間軸

| 日期 | 里程碑 |
| --- | --- |
| **2025-11-02（Codex）** | `listSecureAndDecrypt` 允許非 mutate 模式使用歷史 message key，`drDecryptText` 新增 skipped message key 快取以處理 `n` 計數落差；`sendDrMedia` 透過 secure message 封包傳遞媒體索引並在前端實作預覽。`npm run test:{prekeys-devkeys,messages-secure,friends-messages,login-flow}` 通過；`npm run test:front:login` 已能完成重登入文字訊息解密與附件上傳，但仍於流程末段卡在會話刪除（`.item-delete` 按鈕被其他元素攔截）且暱稱廣播仍觀察到 `/friends/contact/share` 404 fallback，需續追。 |
| **2025-11-01（Codex）** | Worker `/d1/friends/contact/share` 新增 fallback：當 `invite_id` 不存在但仍提供 `myUid/peerUid` 時，直接寫入目標聯絡人信箱並標記 `fallback=invite_missing`；登入流程若備份 404，會優先回填 handoff 的 `wrapped_dev`，必要時再重建。前端送訊端會連同 `message_key_b64` 與 `snapshotAfter` 寫入 DR 歷史，讀取端也能以 replay 優先解密。`npm run test:prekeys-devkeys` / `test:messages-secure` / `test:friends-messages` / `test:login-flow` 通過；`npm run test:front:login` 仍於 `tests/e2e/full-flow.spec.mjs` 失敗：最新 run 中訊息 `d27fb152-3093-43d3-84c7-232a82358203` replay 後 DR state 的 `Nr` 未同步至 header `n=2`，導致再次 `OperationError`，重播後續的媒體預覽流程亦受阻。 |
| **2025-10-31（Codex）** | 新增 `drHistory.messageKey_b64` 儲存每則訊息的派生金鑰，`listSecureAndDecrypt()` 在重新登入、初次載入時會優先使用快照中的 message key 進行重播解密，避免重複 ratchet 導致 `OperationError`。`npm run test:prekeys-devkeys` / `test:messages-secure` / `test:friends-messages` / `test:login-flow` 均通過；`npm run test:front:login` 仍在 `tests/e2e/full-flow.spec.mjs` 卡關：A 端更新暱稱時 `/friends/contact/share` 回 404，導致 B 端重新登入流程出現 `Device backup missing`（`/devkeys/fetch` 404）。需先修復 contact share / devkeys 取得問題，再重跑 full-flow 驗證 decrypt 是否恢復正常。 |
| **2025-10-30（Codex）** | 新增 `flushDrSnapshotsBeforeLogout()`，logout 前將記憶體 DR state 寫回 `contactSecrets` 並記錄 checksum；登入頁 `purgeLoginStorage()` 會挑選最長 snapshot 回填。`recoverDrState()` 支援 `forceGuestBundle`，並針對 Automation 模式輸出 `dr-debug` 與重播腳本。`prepareDrForMessage()` 加入 `historyMatchBy` 日誌。 |
| **2025-10-29（Codex）** | `secureLogout`、`purgeLoginStorage`、`hydrateDrStatesFromContactSecrets` 整合 snapshot 摘要／SHA-256 checksum，確保 QA 可比對 handoff；`pullLatestSnapshot()` 會將 sessionStorage 較新的資料回填 localStorage。 |
| **2025-10-28** | `messages.js` 對背景預覽改用 `mutateState=false`，避免覆寫 DR snapshot；新增 duplicate guard 與去重快取；`ensureDevicePrivAvailable()` 只接受登入交棒；`full-flow` 仍卡在重登入第一則訊息 `OperationError`。 |
| **2025-10-26** | Login 頁清除 localStorage 前會回寫 `contactSecrets-v1`；`share-controller` 不再覆寫既有角色；`dr-session.js` / `messages.js` 增加 snapshot 還原與 `dr-debug` log。 |
| **2025-10-10** | 裝置私鑰備援流程：若備份缺失，會重新發佈預共享金鑰並儲存 `wrapped_dev`，避免 DR 初始化因 404 中斷。 |

### 工作清單

1. ~~修復 `/friends/contact/share` 403。~~
2. ~~調整好友刪除→登出流程，確保 mobile 可操作 user menu。~~
3. [X] 修復 `/friends/contact/share` 404 及重登入流程中 `/api/v1/devkeys/fetch` 404（`Device backup missing`），已可正常取得備份並送出聯絡更新；但 `full-flow` 仍在重播訊息時觸發 `OperationError`，持續追蹤。
4. [X] 追蹤 `full-flow` 重登入後 `OperationError`（如訊息 `562d5aba-89bc-4448-ad9f-9514ad3269e2`、`8151be64-02ba-4aba-9498-60f2e6dd2c6b`、`b237ad18-28e6-49bc-94d5-1585cfa36ce7`、`f77c4378-200c-47ed-931c-658211e853e5`、`d27fb152-3093-43d3-84c7-232a82358203`），查明 DR replay 解密仍失敗的原因（特別是 `Nr`/`n` counter 不同步的情境）。
5. [ ] 驗證 replay 成功時 DR state 是否應套用 `snapshotAfter` 以避免 `Nr` 落後；必要時調整 `prepareDrForMessage` 重播後的狀態同步邏輯。
5. [X] 完成端對端檔案傳輸（圖片 / 影片 / 一般檔案），強制 500 MB 以內並全程加密。
6. [ ] 更新 Node API / Worker / R2 儲存策略：建立「已傳送 / 已接收」系統資料夾並套用 500 MB 限制。
7. [ ] 前端 UI：Drive / 聊天支援選檔、預覽、上傳進度、系統資料夾操作。
8. [ ] Playwright 新增檔案傳輸、Drive 同步、下載驗證等情境。
9. [ ] DR snapshot 還原：messageId-based cursor 已實作，仍需排查重登入首輪 decrypt 失敗 & UI 重複 fetch。
10. [ ] `messages-pane` duplicate 判斷與 `recordDrMessageHistory` 時序調整，避免第一則訊息誤判。
11. [ ] 完成 `contactSecrets-v1` logout→login handoff：logout 必須寫入 sessionStorage，login/App 初始化可回填 localStorage。
12. [ ] `listSecureAndDecrypt` 狀態隔離：僅允許前景對話 `mutateState=true`，其餘使用 snapshot clone，並紀錄 log 以偵測回朔。
13. [ ] 比對 logout / relogin snapshot 長度：確保最新 `drState` 同步到 `contactSecrets-v1`，提供 checksum 供 QA 驗證。
14. [ ] `full-flow` Playwright：會話刪除按鈕被 topbar/內容攔截，導致 `.item-delete` 無法點擊，需調整 UI pointer-events。
15. [ ] 暱稱廣播 `/friends/contact/share` 仍回 404 fallback，B 端未即時更新新暱稱，需檢查 invite 缺失案例處理與重新拉取機制。

---

## Codex 修改追蹤

| 時間 (UTC) | 說明 |
| --- | --- |
| 2025-11-02 07:40 | `listSecureAndDecrypt` 擴充 replay 條件、`drDecryptText` 新增 skipped message key 快取，修正重登入後 `OperationError`；同步補上 OperationError → 歷史快照還原流程。 |
| 2025-11-01 06:12 | Worker contact-share 增加 invite 缺失 fallback，並於登入流程缺備份時優先回填 handoff，再自動重建裝置金鑰；同期調整登入流程把 fallback 備份回傳給 handoff。 |
| 2025-10-10 04:58 | 針對收訊端解密失敗，於 `web/src/app/features/dr-session.js` 新增裝置金鑰備援流程；若備份缺失會重新發佈預共享金鑰並儲存 `wrapped_dev`，避免 DR 初始化因 404 中斷。 |

> 後續 Codex 請持續在此表更新紀錄，並同步 `最新進度` 章節。

---

## 授權條款

本專案採用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。若部署於可供他人透過網路存取的服務，請公開對應來源碼與修改內容，以確保社群共享與使用者權益。
