# Threat Model

> 本文件基於 repo 程式碼實際掃描結果撰寫。所有斷言均可回溯至具體檔案路徑。
> 若某處無法從程式碼確認，以「⚠️ 待確認」標示。

## 1. 系統目標

SENTRY Messenger 是一個端對端加密即時通訊系統，目標為：

- 提供訊息內容對伺服器不可見的通訊管道
- 支援文字、媒體、檔案的加密傳輸與儲存
- 支援語音/視訊通話的端對端加密
- 提供臨時對話（Ephemeral Chat）功能，允許未註冊使用者加入限時加密對話
- 確保前向保密（Forward Secrecy）與後向保密（Break-in Recovery）

## 2. 保護資產

| 資產 | 分類 | 說明 |
|------|------|------|
| 訊息明文 | 最高機密 | 文字訊息內容、控制訊息 |
| 媒體明文 | 最高機密 | 圖片、影片、檔案原始內容 |
| 通話媒體流 | 最高機密 | 語音/視訊原始幀 |
| Master Key (MK) | 最高機密 | 用於保護所有裝置金鑰，僅存於客戶端記憶體 |
| Device Private Keys | 最高機密 | IK 私鑰、SPK 私鑰、OPK 私鑰 |
| Double Ratchet State | 最高機密 | 當前鏈金鑰、根金鑰、ratchet 金鑰 |
| 使用者密碼 | 最高機密 | 用於 OPAQUE 認證和 MK 衍生 |
| Message Keys | 高機密 | 個別訊息的對稱加密金鑰（Key Vault 儲存） |
| 聯絡人關係 | 機密 | 誰與誰有聯絡 |
| 訊息 Metadata | 敏感 | 時間戳、大小、傳送/接收狀態 |
| 帳號識別 | 敏感 | account_digest、device_id |

## 3. 攻擊者模型

### 3.1 被動網路觀察者

- **能力**：觀察所有網路流量（TLS 外層）
- **可見**：連線時間、IP 位址、封包大小模式、連線頻率
- **不可見**：TLS 內層所有內容（假設 TLS 1.3 正確實作）
- **緩解**：HTTPS/WSS 強制（`web/src/_headers` 設定 HSTS）

### 3.2 惡意/被入侵的伺服器

- **能力**：完全控制 Cloudflare Worker、D1 資料庫、R2 儲存、KV 快取
- **可見**：
  - 所有 Metadata（發送者/接收者 digest、時間戳、訊息大小、conversation_id）
  - 加密後的訊息密文（`messages_secure.envelope`）
  - 加密後的媒體 chunks（R2 blobs）
  - Prekey Bundles 公鑰部分（`prekey_bundles` 表）
  - 加密後的 Master Key blob（`wrapped_mk` 欄位）
  - 加密後的 Device Key blob（`dev_keys_backup` 表）
  - 加密後的 Message Key Vault（`message_key_vault` 表）
  - WebSocket 信令（call signaling metadata）
  - NFC SDM 驗證資料（UID、CMAC、counter）
  - OPAQUE 註冊記錄（但無法從中推導密碼）
- **不可見**（設計意圖）：
  - 訊息明文
  - 媒體明文
  - Master Key 明文
  - Device Private Keys
  - 使用者密碼（OPAQUE 保護）
  - 通話媒體明文（InsertableStreams E2EE）
- **已知限制**：
  - 伺服器可觀察通訊模式（誰與誰、何時、多少）
  - 伺服器可拒絕服務（不轉發訊息、不回應 API）
  - 伺服器可替換 Prekey Bundle（中間人攻擊）— ✅ 已實作 TOFU（首次信任後偵測 key 變更）+ Safety Number 帶外驗證
  - 伺服器可重放或重新排序密文（但客戶端有 counter 驗證）

### 3.3 惡意聯絡人/對話方

- **能力**：擁有共享的 DR session 金鑰
- **可見**：對話內所有訊息明文
- **威脅**：截圖、轉發、社交工程
- **緩解**：超出系統防護範圍（見 Section 5）

### 3.4 本地攻擊者（物理存取）

- **能力**：存取使用者裝置
- **可見**：
  - 若 App 開啟且 MK 已解鎖：所有記憶體中金鑰、所有聯絡人資料、所有可解密訊息
  - 若 App 關閉：sessionStorage 中的 device_id、localStorage 中加密的聯絡人快照
- **緩解**：
  - Auto-logout on background（`settings.js` `autoLogoutOnBackground`）
  - sessionStorage 在瀏覽器關閉後清除
  - 敏感金鑰僅存於記憶體（`store.js` `_MK_RAW`, `_DEVICE_PRIV`）

### 3.5 XSS / 客戶端注入攻擊者

- **能力**：在應用頁面執行任意 JavaScript
- **可見**：記憶體中所有金鑰和明文資料
- **緩解**：
  - Content-Security-Policy headers（`web/src/_headers`）
  - HTML escaping（`escapeHtml()` in ephemeral-ui.js）
  - ⚠️ 待確認：CSP 的具體限制嚴格程度

## 4. 明確防護範圍

| 威脅 | 是否防護 | 機制 | 程式碼位置 |
|------|----------|------|-----------|
| 訊息內容被伺服器讀取 | ✓ | X3DH + Double Ratchet E2EE | `shared/crypto/dr.js` |
| 媒體被伺服器讀取 | ✓ | Per-chunk AES-256-GCM | `features/chunked-upload.js` |
| 通話被伺服器監聽 | ✓ | InsertableStreams AES-GCM | `features/calls/key-manager.js` |
| 密碼洩漏至伺服器 | ✓ | OPAQUE PAKE | `features/opaque.js` |
| 歷史訊息因金鑰洩漏受損 | ✓ | Forward Secrecy (DR ratchet) | `shared/crypto/dr.js` |
| 訊息重放攻擊 | ✓ | Per-conversation monotonic counter | `shared/crypto/dr.js`, `worker.js` |
| NFC 標籤偽造 | ✓ | NTAG424 SDM CMAC 驗證 | `worker.js` (server-side) |
| MK 離線暴力破解 | 部分 | Argon2id (m=64MiB, t=3, p=1) | `app/crypto/kdf.js` |

## 5. 明確不防護範圍

| 威脅 | 原因 |
|------|------|
| 終端已被植入惡意軟體 | 無法在已受損環境中保護金鑰 |
| 螢幕錄影/截圖 | 無 DRM，瀏覽器無法阻止 |
| 社交工程 | 非技術問題 |
| 使用者自願洩漏金鑰 | 非技術問題 |
| 伺服器拒絕服務 | E2EE 系統無法防止伺服器不轉發訊息 |
| Traffic Analysis | 訊息時間/大小模式可被觀察，系統未實作 padding 或 cover traffic |
| 伺服器替換 Prekey Bundle (MITM) | ✅ 已實作 TOFU + Safety Number 驗證機制 |

## 6. 各元件信任假設

| 元件 | 信任等級 | 假設 |
|------|----------|------|
| 客戶端瀏覽器 | 完全信任 | 假設執行環境未被篡改 |
| JavaScript 執行環境 | 完全信任 | 假設 `crypto.getRandomValues()` 和 Web Crypto API 安全 |
| Cloudflare Pages | 信任傳遞 | 假設靜態資產未被篡改（依賴 Cloudflare 完整性） |
| Cloudflare Workers | 不信任內容 | Worker 無法解密訊息；可觀察 metadata |
| D1 Database | 不信任內容 | 僅儲存密文和 metadata |
| R2 Storage | 不信任內容 | 僅儲存加密 chunks |
| KV Store | 不信任內容 | Session tokens、暫存資料 |
| TURN Relay | 不信任內容 | 僅轉發加密媒體流（InsertableStreams） |
| NFC 硬體 (NTAG424) | 信任硬體 | 假設 NXP 安全元件未被破解 |
| TweetNaCl.js | 信任函式庫 | `nacl-fast.min.js` 作為 Ed25519/X25519 實作 |
| OPAQUE (opaque-ts) | 信任函式庫 | Cloudflare 維護的 OPAQUE 實作 |
| Argon2 (argon2-browser) | 信任函式庫 | WASM 實作的 Argon2id |

## 7. 主要攻擊面

### 7.1 API 端點

- **位置**：`data-worker/src/worker.js`
- **風險**：未認證端點、參數注入、ACL bypass
- **觀察**：
  - 大部分端點要求 `account_token` + `account_digest` 認證
  - Ephemeral consume 端點無需認證（設計如此）
  - Counter 驗證在伺服器端強制執行
  - ⚠️ 需確認所有端點的輸入驗證完整性

### 7.2 WebSocket 訊息中繼

- **位置**：`data-worker/src/account-ws.js`
- **風險**：訊息偽造、未授權訂閱、跨 session 訊息洩漏
- **觀察**：
  - WS 連線需 JWT token 認證
  - 訊息路由基於 conversation ACL
  - Ephemeral 訊息緩衝（最多 50 則，5 分鐘 TTL）

### 7.3 密碼學實作

- **位置**：`web/src/shared/crypto/dr.js`
- **風險**：協議降級、nonce 重用、金鑰洩漏
- **觀察**：
  - 嚴格無 fallback 政策（程式碼開頭明確宣告）
  - Counter 單調遞增檢查
  - Skipped message key cache（限制大小）
  - ⚠️ 需確認 skipped key cache 的最大容量限制

### 7.4 媒體上傳/下載

- **位置**：`web/src/app/features/chunked-upload.js`, `chunked-download.js`
- **風險**：未加密 metadata、chunk 重排攻擊、記憶體耗盡
- **觀察**：
  - Per-chunk 獨立金鑰（HKDF 衍生）
  - Manifest 包含 chunk 順序和金鑰資訊
  - ⚠️ 需確認 manifest 本身是否加密

### 7.5 臨時對話

- **位置**：`web/src/app/ui/ephemeral-ui.js`
- **風險**：Token 猜測、session 劫持、金鑰交換失敗
- **觀察**：
  - 32 字元 nano ID token（高熵）
  - 原子消費（`UPDATE WHERE consumed_at IS NULL`）
  - 金鑰交換 WS + HTTP 雙路徑 fallback
  - 所有狀態在 session 結束時清除

## 8. 已觀察到的風險與待確認事項

### 高優先級

1. ~~**無 Prekey Bundle 帶外驗證**~~：✅ 已實作 TOFU identity key tracking（`contact-secrets.js:checkAndStorePeerIk`）和 Safety Number 帶外驗證（`safety-number.js:computeSafetyNumber`）。Identity key 變更時觸發 `dr:identity-key-changed` 事件。
   - 位置：`dr-session.js`（ensureDrSession, bootstrapDrFromGuestBundle）
   - 狀態：已緩解（使用者可透過 Safety Number 帶外比對確認無 MITM）

2. **Message Key Vault 伺服器端儲存**：加密的訊息金鑰儲存在伺服器 D1 資料庫。若加密金鑰洩漏，歷史訊息可被解密。
   - 位置：`web/src/app/features/message-key-vault.js`
   - 影響：部分降低前向保密效果

3. **Custom Headers 認證（非 httpOnly Cookie）**：`x-account-token` 和 `x-account-digest` 透過自訂 header 傳送，XSS 攻擊可竊取。
   - 位置：`web/src/app/core/http.js`, `web/src/app/api/account.js`
   - 影響：XSS 攻擊可竊取認證令牌

### 中優先級

4. **Argon2id 參數可能對行動裝置過重**：m=64MiB 在低端裝置可能導致 OOM。
   - 位置：`web/src/app/crypto/kdf.js`

5. **WebSocket Token 未繫結裝置指紋**：WS token 可被竊取並在其他裝置使用。
   - 位置：`data-worker/src/worker.js` JWT 簽發邏輯

6. **console.log 在生產環境可能洩漏敏感資訊**：大量 `console.log` 記錄 E2EE 狀態。
   - 位置：`web/src/app/ui/ephemeral-ui.js` 等多處

### 待確認

7. ⚠️ CSP headers 的具體限制是否足夠嚴格
8. ⚠️ Skipped message key cache 的最大容量
9. ⚠️ Manifest 是否包含在 E2EE envelope 內
10. ⚠️ TURN 憑證的生命週期與輪換機制
11. ⚠️ 群組訊息的加密模型（是否為 pairwise DR session）
12. ⚠️ contact-secrets 的加密方式與完整性驗證
