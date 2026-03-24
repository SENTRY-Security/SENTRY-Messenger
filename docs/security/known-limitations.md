# Known Limitations

> 基於 repo 程式碼掃描，誠實列出目前已知限制和尚未完整實作的安全性質。

## 1. 密碼學限制

### 1.1 ~~無 Prekey Bundle 帶外驗證~~ ✅ 已實作

- **現狀**：已實作 TOFU（Trust-on-First-Use）和 Safety Number 帶外驗證
  - TOFU：首次 X3DH 時儲存 peer Identity Key，後續 handshake 偵測 key 變更（`contact-secrets.js:checkAndStorePeerIk`）
  - Safety Number：60 位數字指紋供使用者帶外比對（`safety-number.js:computeSafetyNumber`）
  - Key 變更時觸發 `dr:identity-key-changed` 事件通知 UI
- **殘餘風險**：首次連線仍信任伺服器（TOFU 固有限制），使用者需主動比對 Safety Number 才能完全排除 MITM
- **位置**：`dr-session.js`（ensureDrSession, bootstrapDrFromGuestBundle）、`contact-secrets.js`、`safety-number.js`

### 1.2 IK/SPK 無定期輪替

- **現狀**：Identity Key 和 Signed Prekey 在裝置建立後不會自動輪替
- **Signal 建議**：SPK 應每 1-7 天輪替
- **風險**：長期使用同一 SPK 增加金鑰洩漏的影響範圍
- **位置**：`shared/crypto/prekeys.js`

### 1.3 Message Key Vault 降低前向保密效果

- **現狀**：解密後的 message key 儲存在伺服器端 vault（加密保護），用於歷史訊息回放
- **影響**：若 vault 加密金鑰洩漏，歷史訊息可被解密；純 DR 的前向保密被 vault 機制部分抵消
- **設計取捨**：犧牲部分前向保密以支援歷史訊息回放功能
- **位置**：`features/message-key-vault.js`

### 1.4 JavaScript 密碼學的固有限制

- **Side-channel**：JavaScript 執行受 JIT 編譯器影響，timing attack 難以完全防護
- **記憶體管理**：無法確保金鑰材料在使用後被安全擦除（GC 不保證立即清除）
- **隨機數**：依賴瀏覽器 `crypto.getRandomValues()` 實作品質

## 2. 協議限制

### 2.1 單裝置假設

- **現狀**：系統假設每個帳號在同一時間只使用一個裝置（`docs/messages-flow-spec.md:15-17`）
- **影響**：多裝置場景下 DR state 不同步，可能導致訊息解密失敗
- **位置**：`docs/messages-flow-spec.md`

### 2.2 B Route (Live Decrypt) 預設關閉

- **現狀**：messages-flow 的 live decrypt 路徑（B route）已實作但預設關閉（`USE_MESSAGES_FLOW_LIVE=false`）
- **影響**：離線 catch-up 和 gap-fill 機制可能使用 legacy 邏輯
- **位置**：`features/messages-flow/live/coordinator.js`

### 2.3 Counter Gap 處理

- **現狀**：偵測到 counter gap 時的具體行為需進一步確認
- **風險**：若 gap 處理不當，可能導致訊息遺失或重複
- **位置**：`features/messages-flow/gap-queue.js`

## 3. 平台限制

### 3.1 瀏覽器安全限制

- **記憶體保護**：瀏覽器無法提供 `mlock()` 或安全記憶體區域
- **Tab 隔離**：同源 tab 共享 localStorage，跨 tab 攻擊面
- **Developer Console**：記憶體中金鑰可透過 DevTools 讀取
- **擴充套件**：惡意瀏覽器擴充套件可讀取頁面 DOM 和記憶體

### 3.2 Argon2id 在低端裝置的效能

- **現狀**：m=64MiB 可能在低端行動裝置導致 OOM 或極慢的登入體驗
- **位置**：`app/crypto/kdf.js`

### 3.3 WebRTC 相容性

- **現狀**：InsertableStreams（Encoded Transform）不被所有瀏覽器支援
- **影響**：部分瀏覽器可能無法使用通話 E2EE
- **位置**：`features/calls/key-manager.js`

## 4. 架構限制

### 4.1 Cloudflare 依賴

- **現狀**：系統完全依賴 Cloudflare 基礎設施（Pages, Workers, D1, R2, KV, Durable Objects）
- **風險**：Cloudflare 服務中斷 = 系統不可用；Cloudflare 作為 metadata 可見方
- **不可遷移性**：Durable Objects 是 Cloudflare 專有 API

### 4.2 無離線訊息支援（超出暫存）

- **現狀**：使用者離線時，訊息由伺服器暫存。但長時間離線後的 catch-up 機制依賴 B route（目前預設關閉）
- **位置**：`features/messages-flow/live/`

### 4.3 帳號恢復

- **現狀**：無自助密碼恢復機制。NFC 卡遺失 + 忘記密碼 = 帳號永久鎖定
- **設計取捨**：零知識設計的固有代價

## 5. README 與實際可能的差異

| README 宣稱 | 實際狀況 | 說明 |
|-------------|----------|------|
| 「前向保密 + 後向保密」 | 部分正確 | Message Key Vault 降低了部分前向保密效果 |
| 「零知識架構」 | 大致正確 | 伺服器仍可見大量 metadata（社交圖譜、時間、大小） |
| 「抗重放攻擊」 | 正確 | Counter 驗證在客戶端和伺服器端實作 |
| 「無 Fallback 政策」 | 正確 | DR 實作中明確宣告，程式碼可驗證 |
| 「InsertableStreams E2EE」 | 正確但有限制 | 不支援 InsertableStreams 的瀏覽器無法使用 |
| 「金鑰每 10 分鐘自動輪換」（通話） | ⚠️ 待確認 | 需確認 key-manager.js 中的輪換邏輯 |

## 6. 需要未來第三方審查的區域

1. **Double Ratchet 實作** — `shared/crypto/dr.js` — 自訂實作，非使用已審計函式庫
2. **X3DH 實作** — `shared/crypto/dr.js` — 同上
3. **Ed25519 ↔ X25519 轉換** — `shared/crypto/ed2curve.js` — 自訂實作
4. **AEAD 封裝** — `shared/crypto/aead.js` — 自訂封裝層
5. **Per-chunk 加密** — `features/chunked-upload.js` — 自訂 chunk 加密流程
6. **Call E2EE** — `features/calls/key-manager.js` — 自訂 InsertableStreams 加密
7. **Message Key Vault 加密** — `features/message-key-vault.js` — 加密方式需審計
8. **OPAQUE 整合** — `features/opaque.js` — 與 opaque-ts 的整合邏輯
9. **Invite Dropbox 加密** — `app/crypto/invite-dropbox.js` — 邀請加密機制
10. ~~**JWT 驗證**~~ — ✅ 已遷移至 `jose` 套件（經安全審計），不再需要獨立審計
