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

---

## 測試 TODO（覆蓋清單）

請以單元測試＋整合測試覆蓋下列重點。勾選代表驗證通過並可自動化於 CI。

- 認證／登入

  - [ ]  SDM Exchange：正確 MAC/計數通過；錯誤 MAC 拒絕；倒退計數拒絕（重放）。
  - [ ]  一次性 Session：逾時拒絕、重複使用拒絕、UID 不符拒絕。
  - [ ]  OPAQUE：`/api/v1/auth/opaque/register-init|finish`、`/api/v1/auth/opaque/login-init|finish` 路由實作與端對端註冊/登入流程（含缺記錄→自動註冊→再登入）。
  - [ ]  Argon2id KDF：`wrapMKWithPasswordArgon2id`/`unwrapMKWithPasswordArgon2id` 正確解包；錯誤密碼失敗；參數（m/t/p）不同失敗。
- 帳號與匿名化

  - [ ]  `resolveAccount`：以 `accountToken`、`accountDigest`、`uidHex` 三種入口都能解析；不存在時允許建立；重複建立時 UNIQUE 處理。
  - [ ]  `ACCOUNT_TOKEN_BYTES` 長度變更仍可用；`account_digest=SHA-256(token)` 一致。
  - [ ]  `ACCOUNT_HMAC_KEY` 變更導致 `uid_digest` 變更；原帳號查詢仍以 `account_digest` 成功。
- 裝置金鑰／Prekeys

  - [ ]  `generateInitialBundle` 內容完整（IK/SPK/SPK_SIG/OPKs 100 筆）。
  - [ ]  `/api/v1/keys/publish`：首次 upsert `prekey_users`，OPKs `INSERT OR IGNORE`；再次呼叫不重覆。
  - [ ]  `/api/v1/devkeys/store` + `/devkeys/fetch`：wrapped_dev 往返成功；密文結構正確（AES‑GCM envelope）。
  - [ ]  補貨 20 支 OPKs：`used` 標記與分配順序正確。
- 訊息（Double Ratchet + Envelope）

  - [ ]  `dr.js`：雙方初始化（含有無 OPK）→ `drEncryptText`/`drDecryptText` 往返正確；Ratchet 進位、PN/Ns/Nr 更新正確。
  - [ ]  `/api/v1/messages/secure`：只存 envelope（`iv_b64`、`payload_b64`），不可見明文；分頁（`cursorTs`）與排序正確。
- 媒體與 Profile/Settings/Contacts

  - [ ]  `wrapWithMK_JSON`/`unwrapWithMK_JSON` 與 `encryptWithMK`/`decryptWithMK` 正確；不同 `infoTag` 無法互解。
  - [ ]  `sign-put`/`sign-get`：簽名有效期間內可用；逾時失效；MIME 白名單限制生效；R2 僅存密文。
  - [ ]  Contacts/Settings 皆以 MK 包裝；Worker 僅見 envelope 與索引。
- Node ↔ Worker 傳輸完整性

  - [ ]  `signHmac`/Worker `verifyHMAC`：合法請求通過；缺 `x-auth`/簽章錯誤拒絕；常數時間比較防側信道。
  - [ ]  基礎 Rate Limit：`/api/*` 每分鐘 120 次上限生效（`src/app.js`）。
- 前端安全性與記憶體衛生

  - [ ]  `sessionStorage` 交棒機制：App 頁取用後立即刪除；重新整理不殘留。
  - [ ]  `secureLogout`（或相同行為）：登出/背景事件清除 MK、DR 狀態、暫存欄位。
  - [ ]  CDN 載入的 `argon2-browser`、TweetNaCl：失敗時的 fallback 與錯誤提示；（建議）加入 SRI 或改為 bundling。
- 端到端流程（冒煙測試）

  - [ ]  完整登入（SDM→OPAQUE→MK 解封/初始化）。
  - [ ]  產生/接受好友邀請→X3DH 初始化→互傳 3 則訊息→重新整理後可解密歷史訊息。
  - [ ]  上傳一張圖片→從清空快取的瀏覽器下載並解密顯示。

備註：實作 OPAQUE 的 Node 路由後，請新增對 Worker `/d1/opaque/store|fetch` 的 proxy 與錯誤回報；再補上對 `ensureOpaque()` 的整合測試。

## TODO：隱匿式訊息功能實作計畫

> 目標：伺服器端對訊息僅看到隨機 conversation token、完全不暴露對話雙方身分或訊息方向。

~~1. **定義對話識別與封包格式**~~
~~2. **更新 Worker / D1 schema**~~

---

## 帳號匿名化導入進度

- ~~Phase 1：Worker 與 D1 以 `accountToken/acct_digest` 取代 UID，建立 `accounts` 表與雜湊工具。~~
- ~~Phase 2：Node API 更新所有路由改採 `accountToken`/`acctDigest` 欄位，移除 UID 依賴。~~
- ~~Phase 3：前端核心（store/login-flow）接入新欄位與 digest 交棒流程。~~
- ~~Phase 4：前端各功能模組（好友、訊息、WebSocket、設定）全面改用 `acctDigest`。~~
- Phase 5：測試與驗證，新增單元測試並人工跑完整登入/訊息/媒體流程。

### 環境變數補充

- 新增 `ACCOUNT_HMAC_KEY`（32-byte hex），供 Worker 將 NTAG424 UID 雜湊成 `uid_digest`。
  ~~3. **調整 Node API 層**~~
  ~~4. **前端資料結構調整**~~
  ~~5. **訊息發送流程**~~

~~6. **訊息載入與同步**~~
~~   - 透過 `/api/v1/messages/secure` 以 `conversationId` 下載封包並逐筆解密。~~
~~   - 實作分頁 / 增量載入、錯誤處理（失敗時嘗試重建 session）。~~
~~   - 規畫輪詢或 WebSocket 推播（待後續擴充）。~~

7. **測試與驗證**

   - 撰寫單元測試／整合測試涵蓋：token 交換、訊息送出/讀取、DR 狀態維護。
   - 手動驗證伺服器端紀錄僅看見亂數 token 與密文。
8. **文件更新 / 效能評估**

   - README 與開發文件補充流程圖與 API 參數。
   - 評估 token 數量、索引策略、DR state 釋放（避免 session 爆滿）。

### 步驟1：對話識別與封包格式（規格草案）

**Conversation Token**

- 從好友邀請結果的 shared secret（invite secret）導出：
  ```text
  conv_token = HKDF( secret = invite_secret,
                     salt   = 0x00...00 (32 bytes),
                     info   = "sentry/conv-token",
                     len    = 32 )
  conv_id    = base64url( SHA-256( conv_token ) )[0:44]
  ```
- `conv_token` 僅保存在前端（加密聯絡資料 + sessionStore）；`conv_id` 作為伺服端唯一索引，無法逆推對話雙方。

**訊息封包**

- Double Ratchet 產出 `(header_bytes, ciphertext_bytes)` 後，組裝：
  ```json
  {
    "v": 1,
    "hdr_b64": "...",          // header bytes → Base64url
    "ct_b64": "...",           // ciphertext bytes → Base64url
    "meta": {
      "ts": 1700000000,
      "sender_fingerprint": "...", // HMAC-SHA256(conv_token, sender_uid) → Base64url
      "msg_type": "text"
    }
  }
  ```
- 將上述 JSON 字串以 `AES-256-GCM(key=conv_token, iv=random12)` 封裝，生成：
  ```json
  {
    "v": 1,
    "iv_b64": "...",
    "payload_b64": "..." // 加密後的封包
  }
  ```
- 伺服端僅接觸 `conv_id` 與此 envelope。收訊端以 `conv_token` 解封 → 還原 DR header/ciphertext → 繼續 Double Ratchet 流程。

**DR State 儲存**

- `sessionStore.drState[conv_id]` 保存當前雙方 ratchet 狀態（僅記憶體）。
- 聯絡人封套（加密存於 `contacts-<uid>` conversation）新增欄位：
  ```json
  {
    "nickname": "...",
    "avatar": { ... },
    "conversation": {
      "token_b64": "...",      // conv_token base64url
      "rk_b64": "...",         // 初始 root key (若需要)
      "dh_pub_b64": "..."      // 對方初始 DH 公鑰（供重建 DR）
    }
  }
  ```
- 登出時清除記憶體；重新登入後由聯絡人封套重建 `conv_token` 與 DR 初始值。

> 後續步驟將依此規格調整 D1 schema、API 與前端流程。

---

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

- `npm run test:login-flow`
  - 路徑：`scripts/test-login-flow.mjs`
  - 內容：debug-kit → Exchange → OPAQUE（無紀錄則註冊）→ 首次 `/api/v1/mk/store` → 再 Exchange 應 `hasMK=true` → 再次 OPAQUE login
  - 參數：可用 `--uid <UIDHEX>` 固定測試 UID；`ORIGIN_API` 指定 API
  - 備註：若 OPAQUE 路由尚未完整，可能回 `RecordNotFound` 或 base64 解析錯誤；建議用前端 `ensureOpaque()` 路徑（會自動註冊再登入）或完成後端路由再跑此腳本。

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
```
