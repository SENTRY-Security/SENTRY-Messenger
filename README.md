# SENTRY Message — 技術筆記

> 近期進度：雲端硬碟分頁新增容量資訊欄（預設 3GB 配額，隨 Drive 列表即時計算使用率並以進度條呈現）；修復 logout→relogin 後分享面板持續顯示「缺少交友金鑰」造成 QR 無法重生的問題，重置 shareState 會清除補貨鎖定並恢復自動補貨；Drive 面板改以使用者資料夾為主並隱藏系統「已傳送 / 已接收」層，避免上傳檔案被困且可再次上傳 / 刪除；訊息附件新增「預覽」動作沿用 Modal 下載流程並於 Playwright 內實際執行 `downloadAndDecrypt` 驗證 SHA-256 digest，確認接收端確實可還原檔案。

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
   - [D1 Schema 盤點（只讀）](#d1-schema-盤點只讀)
6. [測試與自動化](#測試與自動化)
7. [最新進度與工作項目](#最新進度與工作項目)
8. [授權條款](#授權條款)

---

## 簡介與快速開始

- **目標**：驗證「晶片感應 → 零知識登入 → 端對端密訊＆媒體」的連貫體驗，~~同時確保所有祕密僅存於使用者裝置記憶體~~。實際設計：明文與 MK 僅在瀏覽器記憶體使用，但伺服端會保存密文（訊息/媒體）以及以 MK 包裝的密鑰備份（`wrapped_mk`、`wrapped_dev`、contactSecrets/DR 快照）以支援跨裝置還原。
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

### 好友邀請與離線投遞 contact-init（單一路徑）

1. **建立邀請**：Owner 端補貨 per-device 預鍵後，呼叫 `/api/v1/invites/create` 取得 `inviteId/expiresAt/ownerPublicKeyB64/prekeyBundle`，QR payload 僅包含這些欄位。
2. **掃描投遞**：Guest 掃描後在 client 端跑 X3DH，將 contact-init payload 以 owner 公鑰 sealed 加密，`/api/v1/invites/deliver` 上傳密文（必帶 `accountToken`）。
3. **離線取回**：Owner 上線後呼叫 `/api/v1/invites/consume` 拿回密文，使用本機私鑰解密並寫入 contact secrets/contact core；後續 contact-share 以 secure-message 傳遞。
4. **一次性 + TTL**：invite 5 分鐘有效；deliver/consume 過期回 410；deliver 只能成功一次（409），consume 只能成功一次（404/409）。
5. **狀態查詢**：Owner/Guest 可用 `/api/v1/invites/status` 查詢狀態（HTTP-only），不依賴 WS。
6. **伺服端不可知**：server 僅保存密文與狀態，無法解密；WS 僅通知 `invite-delivered`，不承擔一致性。

### ~~Double Ratchet 訊息傳遞~~（棄用，重構目標：per-device Signal X3DH/DR，移除 session-init/ack 與 conversation fingerprint 授權，封包 header 標準化）

1. **設備金鑰交棒**：`ensureDevicePrivAvailable()` 僅依賴登入交棒／記憶體；若 sessionStorage 缺件，直接報錯不再自動補建。
2. **初始化**：若 `drState` 缺失、且 `dr_init` 可用 → `bootstrapDrFromGuestBundle()`；否則呼叫 `prekeysBundle` + `x3dhInitiate` 建立新會話（消耗對方 OPK）。
3. **傳送訊息**：`drEncryptText` 產生 header + ciphertext → `/api/v1/messages/secure` 儲存 envelope（D1 `messages_secure`）。
4. **接收解密**：
   - `listSecureAndDecrypt()` 先排序訊息；若為重播情境會利用 `prepareDrForMessage` 檢查 timestamp / messageId 是否早於 cursor，必要時還原 snapshot。
   - 若 snapshot 缺失會落到 `recoverDrState()`（可強制使用 `guest_bundle`），同時記錄 `[dr-decrypt-fail-payload]` 供 `tests/scripts/debug-dr-replay.mjs` 重播。
   - 每次成功解密會 `recordDrMessageHistory()`（包含 messageKey）並 `persistDrSnapshot()`。
5. **DR 恢復判定**：`recoverDrState()` 允許 initiator/guest 端只要恢復出有效 ratchet（`rk` + send/recv 任一鏈與 myRatchetKey 成立）即視為成功，不再硬性要求 responder `ckR`；避免誤判失敗後強制 reset，實作位於 `web/src/app/features/dr-session.js`。

### WebSocket 連線 / presence / 呼叫訊號

- **單次鑑權**：同一 WebSocket 連線只接受一次 `auth`；若重送相同帳號 token 會回覆成功並更新 sessionTs，若嘗試切換帳號會先卸載舊帳號的 presence watcher 與 client 註冊後再綁定新帳號，避免一條連線同時掛多個 digest 造成事件外洩（`src/ws/index.js`）。
- **呼叫鎖復原**：`call-invite` 寫入 call event 失敗時會釋放雙方鎖並回傳 `CALL_EVENT_FAILED`，避免 30~120 秒的 busy 假陽性（`src/ws/index.js`）。
- **鎖續約與過期清理**：`CALL_RENEW_EVENTS` 續約鎖，`CALL_RELEASE_EVENTS` 釋放；`CALL_LOCK_TTL_MS` 預設 120 秒（下限 30 秒），掃描每 5 秒清除過期，實作同於 `src/ws/index.js`。


### 媒體、設定與資料夾命名

- **媒體 / Drive**：`encryptAndPutWithProgress()` 用 MK 加密 → `/media/sign-put` → R2 上傳；接收端 `/media/sign-get` → 解密。Drive 系統資料夾命名為 `drive-<acctDigest>`（必要時以 MK-HMAC 分段）。
- **設定**：`settings-<acctDigest>` 以 MK 包裝 `{ showOnlineStatus, autoLogoutOnBackground, autoLogoutRedirectMode, autoLogoutCustomUrl }`，所有欄位都以 MK-AEAD 加密儲存；App 啟動時 `ensureSettings()`，更新立即 `saveSettings()`。
- **其餘 envelope**：Profile/聯絡人/訊息/媒體皆以 MK 衍生 AES-GCM；儲存層只保存密文。

---

## 安全預設與環境配置

- **登出清理**：`secureLogout()` 先 `flushDrSnapshotsBeforeLogout()` 與 `persistContactSecrets()`，將 JSON 寫入 sessionStorage + `contactSecrets-v1-latest`，再清除 cache/indexedDB 等。
- **登入頁**：`purgeLoginStorage()` 會挑選最長 snapshot 回填 localStorage，並輸出 checksum（`contactSecretsSeed*`）供 QA 比對。
- **背景自動登出**：`autoLogoutOnBackground`（預設 true）在 App 退到背景時觸發 `secureLogout()`；若 `autoLogoutRedirectMode=custom` 且 `autoLogoutCustomUrl` 通過 HTTPS 驗證，登出後會導向指定網址。**即使此設定被關閉，只要 App 頁面被重新整理就會立即強制 `secureLogout()` 並導向登出頁**。
- **環境變數**（常用）：`NTAG424_*`, `ACCOUNT_HMAC_KEY`, `OPAQUE_*`, `DATA_API_*`, `S3_*`, `UPLOAD_MAX_BYTES`, `SIGNED_{PUT,GET}_TTL`, `SERVICE_*`, `ACCOUNT_TOKEN_BYTES`, `CORS_ORIGIN` 等。
- **儲值系統（訂閱延展）**：`PORTAL_API_ORIGIN`（例如 `https://portal.messenger.sentry.red`）、`PORTAL_HMAC_SECRET` 必填。Node API 透過 `/api/v1/subscription/{redeem,validate,status}` 代理至 Portal，HMAC 計算為 `HMAC-SHA256(secret, path + "\n" + body)`；憑證為 Ed25519 簽章、`extend_days` 天數延展，Portal 端負責唯一性與消耗，前端不直接呼叫 Portal。

---

## 營運與部署流程

### 一鍵部署

```bash
bash ./scripts/deploy-prod.sh --apply-migrations
```

流程：`wrangler deploy` → `wrangler d1 migrations apply --remote` → `npm ci && pm2 reload message-api` → `wrangler pages deploy`。可用 `--skip-{worker,api,pages}` 部分部署；若變更 D1 schema 請保留 `--apply-migrations`。

### 正式釋出流程（必須）

1. 本地修正完成後，依 Prompt 規範自行驗證功能（目前已無自動化測試腳本）。
2. 執行 `bash ./scripts/deploy-prod.sh --apply-migrations`，不可跳過任何部件（Worker / Node API / Pages 必須同步部署）。
3. 佈署完成後，於正式環境手動驗證核心流程（登入、交友、訊息、媒體），並記錄結果。

> **TUN 服務備註**：詳細主機資訊與操作規範請參考 `docs/internal/tun-host.md`（本檔案已被 `.gitignore` 排除，不隨版本控制分發；需向維運成員索取或於本地自行建立）。

5. 若任何 Production 測試失敗，需先排除問題並重新部署，直到正式環境也全部通過為止。

### D1 Schema 盤點（只讀）

目的：只讀盤點目前 D1 的實際 schema（tables / indexes / triggers / views），禁止任何寫入或 migration。

步驟（建議在 `data-worker/` 目錄執行）：
1. 確認 D1 綁定與資料庫名稱：`data-worker/wrangler.toml` 內的 `[[d1_databases]]`（本專案為 `binding = "DB"`、`database_name = "message_db"`）。
2. 確認 Wrangler 已登入且帳號可用：`wrangler whoami`。若有多帳號，請指定 `CLOUDFLARE_ACCOUNT_ID`。
3. 確認目標 D1 存在：
   ```bash
   CLOUDFLARE_ACCOUNT_ID=<your-account-id> wrangler d1 list --json
   ```
4. 只讀查詢 schema（範例）：
   ```bash
   # 列出所有 tables / indexes / triggers / views（含建立語句）
   CLOUDFLARE_ACCOUNT_ID=<your-account-id> wrangler d1 execute message_db --remote \
     --command "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type, name;"

   # 逐表欄位 / index / foreign key
   CLOUDFLARE_ACCOUNT_ID=<your-account-id> wrangler d1 execute message_db --remote \
     --command "PRAGMA table_info('<TABLE_NAME>');"
   CLOUDFLARE_ACCOUNT_ID=<your-account-id> wrangler d1 execute message_db --remote \
     --command "PRAGMA index_list('<TABLE_NAME>');"
   CLOUDFLARE_ACCOUNT_ID=<your-account-id> wrangler d1 execute message_db --remote \
     --command "PRAGMA index_info('<INDEX_NAME>');"
   CLOUDFLARE_ACCOUNT_ID=<your-account-id> wrangler d1 execute message_db --remote \
     --command "PRAGMA foreign_key_list('<TABLE_NAME>');"
   ```

備註：部分系統表（例如 `_cf_KV`）可能回 `SQLITE_AUTH`，僅需記錄「不可讀取」即可，禁止改用任何寫入或升權方式。

---

## 部署後的回歸驗證

目前無可用的自動化回歸腳本。部署後請人工驗證核心流程（登入 → 交友/建鏈 → 互傳文字與附件 → 登出/重登入）。如需重建 e2e 測試，請先規劃新的腳本與資料夾結構並更新本文件。

---

## 測試與自動化

舊有 mjs/Playwright 測試已移除，尚未重建新的測試套件。所有變更需自行撰寫/執行對應的手動或自動驗證並在此文件紀錄。

## 最新進度與工作項目

- [ ] 強化 DR 發送鏈防撞：同鏈單 sender 鎖（跨分頁/多實例）、重送時 header.n 與 counter 同步，送出前校驗 state/peerDeviceId，有異常直接中止並提示重建

## 授權條款

本專案採用 [GNU Affero General Public License v3.0](LICENSE)（AGPL-3.0-only）。若部署於可供他人透過網路存取的服務，請公開對應來源碼與修改內容，以確保社群共享與使用者權益。
