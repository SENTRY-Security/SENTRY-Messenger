# SENTRY Message 安全與隱私說明書

SENTRY Message 以硬體級身分驗證與端對端加密為核心設計，讓日常對話、好友邀請與媒體共享都能在保密前提下進行。本文件面向使用者，完整說明系統如何運作、資料在各元件之間的流向，以及我們為了守護隱私所採取的技術措施。

---

## 核心承諾
- **硬體唯一身分**：每張 NTAG424 DNA 晶片都擁有不可複製的 UID 與計數器，作為唯一登入憑證。
- **零知識登入**：登入密碼與主金鑰（Master Key, MK）僅在您的裝置記憶體中存在，伺服器不會看到明文。
- **端對端保護**：訊息與媒體都以 AES-256-GCM 在本機加密後才上傳，後端只儲存密文索引。
- **最小揭露原則**：雲端資料倉儲僅保留必要的封套（envelope）與索引；所有可識別資訊皆先經過包裹或加密。
- **透明可稽核**：所有內部服務呼叫都使用 HMAC-SHA256 簽章，確保 API 與資料庫操作可追蹤且無竄改。

---

## 硬體身分驗證：NTAG424 DNA
- **晶片簽章驗證**：登入時，前端會讀取晶片的 UID、計數器與 CMAC。Node.js API 使用 `verifySdmCmacFromEnvWithFallback` 透過環境變數中的 Root Key 派生 SDM 金鑰後驗證 MAC。
- **防止重放攻擊**：每張晶片都有遞增的計數器。登入流程會將最新計數提交給 Cloudflare Worker，若偵測到倒退值將拒絕登入。
- **金鑰輪替**：API 會同時嘗試現行與舊版 Root Key，支援安全換鑰而不中斷使用者服務。
- **除錯套件保護**：即使在開發環境使用 `debug-kit`，系統仍使用相同的 KDF 與 CMAC 流程，避免曝露正式密鑰。

---

## 零知識登入流程
1. **感應晶片**：瀏覽器或行動裝置讀取 NTAG424 參數，並透過 HTTPS 呼叫 `/api/v1/auth/sdm/exchange`。
2. **一次性 Session**：伺服器驗證成功後，只發出有效 60 秒的一次性 Session Token，存放於前端記憶體（`store.js`）。
3. **輸入密碼**：
   - 若您曾設定密碼，前端會使用 Argon2id 派生 KEK，解包伺服器傳回的 `wrapped_mk`。
   - 首次登入時會產生新的隨機 MK，立即以 Argon2id + AES-256-GCM 包裝後送回 `/api/v1/mk/store` 存於 Worker。
4. **資料只在記憶體**：解密後的 MK 與裝置私鑰保留在 JavaScript 記憶體中；離開頁面或登出即清空。
5. **SessionStorage 交棒**：登入頁僅將 `mk_b64` 與 `uid_hex` 暫存在 `sessionStorage`，App 頁面載入後會立刻取出並刪除。

---

## 金鑰與加密技術
- **主金鑰 (MK)**：32 位元隨機字串，用於包裝所有個人資料、聯絡人、訊息內容與裝置備份。
- **密碼防護**：`web/src/app/crypto/kdf.js` 以 Argon2id（預設 64 MiB、3 次迭代）推導 KEK，再以 AES-256-GCM 加密 MK，防禦暴力破解。
- **端對端訊息**：`crypto/aead.js` 使用 HKDF-SHA256 從 MK 派生每則訊息或檔案的 AES-GCM 金鑰；加密後的 envelope 才會傳至伺服器。
- **雙重前向安全性**：`crypto/dr.js` 實作 X3DH + Double Ratchet，讓訊息在送達後即便金鑰外洩也無法還原歷史對話。
- **裝置金鑰備份**：`crypto/prekeys.js` 生成 Ed25519 / X25519 鍵對，並以 MK 包裝備份到 Worker，確保遺失裝置時仍可復原而不洩露私鑰。

---

## 系統架構與資料流
| 元件 | 角色 | 保護措施 |
| --- | --- | --- |
| 前端（Cloudflare Pages） | 登入、加密、UI | 僅在 RAM 持有密鑰；自動登出；僅上傳密文 |
| Node API (`src/`) | SDM 驗證、媒體簽名、WebSocket | 檢核輸入、簽署 Worker 請求、限制上傳 MIME、最短存活 Session |
| Cloudflare Worker (`data-worker/src/worker.js`) | D1 操作、好友邀請、prekeys | 僅接受 HMAC 驗證請求；儲存密文字典；計數器檢查 |
| R2 物件儲存 | 媒體與頭像 | 只存加密檔案；下載/上傳 URL 時效 15 分鐘；MIME 白名單 |
| WebSocket (`src/ws`) | 線上狀態、通知 | 僅記錄 UID；連線關閉即清除；不傳遞明文訊息 |

---

## 典型操作情境
### 登入
1. 感應 NTAG424，產出 URL 參數。
2. 前端發出 Exchange 請求 → 伺服器驗證 MAC 與計數器。
3. 取得一次性 Session → 使用密碼解開 MK。
4. 初始化或補充裝置金鑰（預設一次建立 1 IK、1 SPK、100 OPK）。
5. 登入成功後立即清除 Session Token。

### 傳送訊息
1. 前端用 MK 衍生的 AES-GCM 金鑰包裝內容。
2. 內容封套以 `/api/v1/messages/secure` 送到 Node API。
3. API 使用 HMAC-SHA256 簽署後轉交 Worker，寫入 D1 `messages_secure` 表。
4. WebSocket 僅廣播「有新訊息」提醒，不附任何明文。

### 上傳檔案
1. 前端呼叫 `/api/v1/media/sign-put`，伺服器驗證 MIME 類型並產生短時效上傳 URL。
2. 檔案以 AES-GCM 在本機加密後再進行 PUT 上傳。
3. 封套（含 object key）寫入 D1；任何下載再透過簽名 URL，超過有效期需重新取得。

### 新增好友
1. 擁有者呼叫 `/api/v1/friends/create` 建立邀請，Worker 產生秘密字串與可選的預先金鑰束。
2. 邀請 QR 內含 `inviteId` 與 `secret`，僅能使用一次，預設 5 分鐘到期。
3. 掃描者以 secret 解開擁有者的加密聯絡資訊，並透過 Worker 完成 X3DH 金鑰交換。
4. Worker 只存加密後的聯絡資料，雙方透過 WebSocket 收到聯絡人更新通知。

---

## 隱私保護細節
- **記憶體清除**：前端在登出、切換頁面或「背景執行」事件時，會根據 `autoLogoutOnBackground` 設定（預設開啟）呼叫 `secureLogout()` 清除 MK 與聊天快取。
- **最小紀錄**：Node API 的 `pino` 日誌僅輸出操作結果，不含敏感參數；Worker 也僅記錄錯誤狀態。
- **資料庫設計**：D1 以 `tags`、`messages_secure`、`friend_invites` 等表拆分權責，所有敏感欄位（wrapped_mk_json、payload_json）都保持為密文字串。
- **參數正規化**：API 在寫入前會移除 UID、MAC 中的任何非 16 進位字元，避免注入或格式錯誤。
- **簽章驗證**：每一個 Node→Worker 呼叫都會使用 `signHmac` 與 Worker 端的 `verifyHMAC` 驗證路徑與本文，阻擋偽造請求。
- **內容類型防護**：上傳媒體前會檢查 `UPLOAD_ALLOWED_TYPES` 白名單；關聯子資料夾名稱會經過 Unicode 正規化與危險字元清洗。
- **連線保護**：WebSocket 僅使用 UID 作為識別，關閉後立即移除；presence 訂閱只會回傳線上名單。

---

## 使用者可握有的控制
- **硬體在手**：沒有晶片就無法觸發登入流程；晶片遺失只需在 Worker 中標記計數器，即可阻擋重放。
- **密碼自行管理**：密碼只在本機使用，可自由變更；若忘記密碼需重新初始化晶片與 MK，確保無後門重置。
- **自主登出**：隨時可啟用「返回背景即登出」；裝置遺失時只要 Session 到期或瀏覽器關閉即無法再讀取資料。
- **透明下載**：每次下載媒體都需透過新的簽名 URL，使用者能從有效期限掌握分享範圍。

---

## 未來強化方向
- 為 UID 建立額外的 HMAC 匿名化層，讓資料庫看不到原始 UID。
- 引入硬體安全模組（HSM）管理 NTAG Root Key，強化伺服器端金鑰保護。
- 提供公開安全稽核報告與第三方穿透測試結果。
- 擴充「隱匿式訊息」模式，讓伺服器完全看不到對話雙方 ID。

---

若您對 SENTRY Message 的安全設計有任何疑問，歡迎透過官方客服或社群與我們聯繫。我們會持續公開改版紀錄與安全進展，保障您的訊息與身分隱私。
