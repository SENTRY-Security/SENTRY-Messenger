# Security Assumptions & Out of Scope

> 基於 repo 程式碼實際掃描。明確區分「系統承諾防護」與「系統不承諾防護」。

## 核心安全假設

### 1. 客戶端執行環境可信

- **假設**：使用者的瀏覽器和作業系統未被植入惡意軟體
- **依據**：所有金鑰材料僅存於客戶端記憶體（`store.js` `_MK_RAW`, `_DEVICE_PRIV`）。若執行環境被入侵，記憶體中的金鑰可被直接讀取，E2EE 失去意義
- **位置**：`web/src/app/core/store.js:29-30`

### 2. Web Crypto API 和 `crypto.getRandomValues()` 安全

- **假設**：瀏覽器提供的密碼學 API 正確實作且隨機數生成器有足夠熵
- **依據**：所有金鑰生成依賴 `crypto.getRandomValues()`（IV、salt、nonce）；AES-GCM 加解密使用 Web Crypto API
- **位置**：`shared/crypto/dr.js`（IV 生成）、`app/crypto/kdf.js`（salt 生成）

### 3. TweetNaCl.js 實作正確

- **假設**：`nacl-fast.min.js` 正確實作 Ed25519 和 X25519
- **依據**：X3DH 和 Double Ratchet 的 Diffie-Hellman 操作使用 TweetNaCl
- **位置**：`web/src/libs/nacl-fast.min.js`、`shared/crypto/nacl.js`
- **風險**：JavaScript 密碼學實作通常比 native 實作更易受 side-channel 攻擊

### 4. TLS 1.3 正確實作且未被降級

- **假設**：HTTPS/WSS 連線使用 TLS 1.3，Cloudflare Edge 不進行降級
- **依據**：所有 API 通訊和 WebSocket 通過 Cloudflare CDN
- **位置**：`web/src/_headers`（HSTS 設定）

### 5. Cloudflare 基礎設施可信（在 metadata 層級）

- **假設**：Cloudflare 不主動篡改 Worker 程式碼或 D1/R2/KV 資料
- **依據**：系統部署在 Cloudflare Pages + Workers 上，Cloudflare 作為基礎設施提供者
- **重要限制**：此為對第三方的信任依賴，非密碼學保證

### 6. OPAQUE (opaque-ts) 和 Argon2 (argon2-browser) 實作正確

- **假設**：Cloudflare 維護的 `@cloudflare/opaque-ts@0.7.5` 和 `argon2-browser@1.18.0` 正確實作相應協議
- **依據**：SRI 雜湊驗證已用於 CDN 載入（`shared/utils/cdn-integrity.js`）
- **位置**：`features/opaque.js`（dynamic import with SRI）

### 7. NFC 硬體安全元件 (NTAG424 DNA) 未被破解

- **假設**：NXP NTAG424 DNA 的 CMAC 和 SDM 機制提供正確的身份證明
- **依據**：系統使用 NFC 標籤作為身份綁定的物理因子
- **位置**：`features/sdm.js`、`data-worker/src/worker.js`（SDM 驗證）

## 系統不承諾解決的問題

### 1. 終端已被植入（Endpoint Compromise）

若使用者裝置已安裝鍵盤記錄器、螢幕錄製工具或 root-level 惡意軟體，系統無法保護：
- 記憶體中的金鑰
- 輸入的密碼
- 解密後的訊息
- 螢幕上顯示的內容

### 2. 螢幕錄影/截圖

系統未實作：
- 螢幕截圖偵測或阻止
- DRM 保護
- 防翻拍機制

### 3. 作業系統層 Compromise

若 OS 核心被入侵：
- 瀏覽器沙箱可被繞過
- 記憶體可被直接讀取
- 網路流量可在 TLS 終止前/後被攔截

### 4. 使用者操作失誤

系統不防護使用者主動操作導致的安全問題：
- 將連結或密碼分享給不信任的人
- 使用弱密碼（系統有 Argon2id 但無密碼強度檢查 — ⚠️ 待確認）
- 在不安全的網路環境中使用（但 TLS 提供傳輸保護）

### 5. 第三方基礎設施風險

| 第三方 | 風險 | 緩解 |
|--------|------|------|
| Cloudflare Pages | 靜態資產篡改 | ⚠️ 無客戶端 integrity check |
| Cloudflare Workers | Worker 記憶體存取 | E2EE 設計：Worker 僅見密文 |
| Cloudflare D1 | 資料庫存取 | 僅儲存密文和 metadata |
| Cloudflare R2 | 物件儲存存取 | 僅儲存加密 chunks |
| Cloudflare TURN | 媒體流觀察 | InsertableStreams E2EE |
| CDN (esm.sh, jsdelivr) | 供應鏈攻擊 | SRI hash 驗證 |

### 6. 開發/Debug 模式風險

- `web/src/app/ui/debug-page.js` — Debug 頁面（⚠️ 需確認生產環境是否可存取）
- `web/src/app/ui/mobile/debug-flags.js` — Debug 開關
- `web/src/app/features/sdm-sim.js` — NFC 標籤模擬器（開發用）
- `web/src/pages/debug.html` — Debug HTML 頁面
- 大量 `console.log` 輸出 — 可能在生產環境洩漏 E2EE 狀態資訊
- ⚠️ 需確認：debug 頁面和 SDM 模擬在生產環境是否被禁用

### 7. Traffic Analysis（流量分析）

系統未實作：
- 訊息 padding（統一訊息大小）
- Cover traffic（噪音流量）
- Timing obfuscation（時間混淆）

因此，網路觀察者可推知：
- 通訊雙方身份（基於 IP 和連線模式）
- 通訊頻率和時間
- 訊息大致大小
- 是否進行通話（WebRTC 流量模式不同）

### 8. 伺服器主動攻擊（Active Server Adversary）

系統對伺服器的防護為「誠實但好奇」（honest-but-curious）模型。系統**不**完全防護伺服器主動攻擊：
- ⚠️ 伺服器可替換 Prekey Bundle 進行 MITM（無帶外驗證機制）
- 伺服器可選擇性不轉發訊息（DoS）
- 伺服器可觀察所有 metadata
- 伺服器可偽造 `ephemeral-extended` 等控制訊息

### 9. 多裝置安全同步

- ⚠️ 目前系統假設**單帳號單裝置**（`docs/messages-flow-spec.md:15-17`）
- Contact secrets 快照備份允許某種程度的多裝置支援，但 DR session 狀態不跨裝置同步
- 新裝置需要重新建立所有 DR session

### 10. 密碼恢復

- **無密碼恢復機制**：若使用者忘記密碼且無法進行 NFC 認證，帳號將無法存取
- MK 用密碼衍生的 KEK 保護；密碼遺失 = MK 遺失 = 所有金鑰遺失
- 這是零知識設計的固有限制
