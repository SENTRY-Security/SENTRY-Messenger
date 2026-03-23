# Open Questions

> 在 repo 程式碼掃描過程中發現的未解決問題。需要作者確認或進一步分析。

## 1. 密碼學設計問題

### Q-1: Send-side ratchet 停用原因

**位置**：`shared/crypto/dr.js:357-364`

**觀察**：Send-side ratchet 更新程式碼被註解掉，`myRatchetPriv`/`myRatchetPub` 不在發送時輪替。同時 `NsTotal` 累計也被停用（Lines 337-342），註解提到「send-side ratcheting is disabled」。

**問題**：
1. 這是設計決策還是暫時停用？
2. 若為設計決策，理由為何？
3. 對前向保密的具體影響是否已評估？
4. 接收方是否仍會觸發 DH ratchet？（是的，根據程式碼 `dr.js:504+`）

**安全影響**：若發送方不輪替 ephemeral key，則該方向的所有訊息使用同一 chain key 序列，洩漏任一 chain key 可推導後續所有訊息。

---

### Q-2: message_key_b64 在 DR packet 中的用途

**位置**：`shared/crypto/dr.js` envelope 格式

**觀察**：DR encrypted packet 格式中包含 `message_key_b64` 欄位。根據程式碼分析，此欄位用於 Message Key Vault 儲存（解密後的 message key 存入 vault 供歷史回放），但需確認在 WebSocket 傳輸時是否被包含在 envelope 中。

**問題**：
1. `message_key_b64` 在透過 WebSocket 傳輸前是否被移除？
2. 若包含在 wire format 中，接收方可直接使用此 key 解密而不需 DR state，將嚴重破壞安全性
3. 需確認 drEncryptText 的返回值在傳輸前是否有欄位過濾

---

### Q-3: DR Header 可見性

**位置**：`shared/crypto/dr.js` envelope

**觀察**：DR encrypted packet 的 `header` 欄位（dr, v, device_id, ek_pub_b64, pn, n）似乎在密文外。

**問題**：
1. Header 是否以明文形式隨 envelope 傳輸？
2. 若是，伺服器可見 ephemeral public key 和 counter
3. Header 資訊是否構成有意義的 metadata 洩漏？
4. `ek_pub_b64` 在 header 中明文暴露是否為 DR 協議的標準行為？（是的，Signal 協議中 header 也是明文）

---

### Q-4: Skipped Keys 總量上限

**位置**：`shared/crypto/dr.js:128-156`

**觀察**：每條 chain 最多 100 個 skipped keys，但似乎沒有跨 chain 的總量上限。

**問題**：
1. 是否有全域 skipped keys 數量上限？
2. 惡意 peer 是否可透過大量 DH ratchet + 大 gap 消耗記憶體？
3. 建議上限是多少？

---

## 2. 伺服器安全問題

### Q-5: CSP Headers 設定

**位置**：`data-worker/src/worker.js`

**問題**：
1. Content Security Policy 如何設定？
2. 是否限制 script-src、connect-src？
3. 是否使用 `strict-dynamic` 或 nonce-based CSP？

---

### Q-6: HTTP API Rate Limiting

**位置**：`data-worker/src/worker.js`

**觀察**：WebSocket 層有訊息大小限制，但 HTTP API 的 rate limiting 未明確觀察到。

**問題**：
1. 是否有 per-IP 或 per-account rate limiting？
2. 暴力破解 SDM exchange 或 OPAQUE login 的防護措施？
3. Cloudflare 層是否提供 WAF/rate limiting？

---

### Q-7: Cloudflare 日誌內容

**位置**：基礎設施層

**問題**：
1. Cloudflare Workers/Pages 預設記錄哪些資訊？
2. API request body 是否被記錄？
3. 若記錄，encrypted envelope 和 wrapped blobs 是否出現在日誌中？
4. 日誌保留期間為多長？

---

### Q-8: 自訂 JWT 驗證的完整性

**位置**：`data-worker/src/account-ws.js:141-180`

**觀察**：JWT 驗證使用自訂 HMAC-SHA256 實作，而非標準函式庫。

**問題**：
1. 是否有 timing-safe comparison？
2. 是否處理所有 edge case（empty token, malformed base64, etc.）？
3. 考慮使用標準 JWT 函式庫替代？

---

## 3. 金鑰管理問題

### Q-9: Contact Secrets 加密金鑰衍生

**位置**：`features/contact-secrets.js`、localStorage `contactSecrets-v2`

**問題**：
1. Contact secrets snapshot 使用哪個金鑰加密？
2. 金鑰如何衍生？（info tag 為 `'contact-secrets/backup/v1'`，但 salt 來源？）
3. 登出時是否清除 localStorage？

---

### Q-10: Message Key Vault 加密細節

**位置**：`features/message-key-vault.js:306-312`

**觀察**：Vault 使用 info tag `'message-key/v1'` 和 MK 衍生金鑰加密。

**問題**：
1. Vault entry 的 salt 如何產生？（每次 wrap 獨立隨機？）
2. 是否有 vault entry 的過期/清理機制？
3. Vault 總大小是否有上限？

---

### Q-11: Call Key Epoch 輪換

**位置**：`features/calls/key-manager.js`

**觀察**：Epoch 參數支援通話中金鑰輪換，但具體觸發機制未觀察到。

**問題**：
1. Epoch 輪換的觸發條件是什麼？（時間間隔？手動？事件驅動？）
2. README 提到「每 10 分鐘輪換」，但程式碼中的具體實作位置？
3. Epoch 變更時，舊金鑰如何處理？

---

## 4. 協議問題

### Q-12: 群組訊息加密模型

**問題**：
1. 群組訊息是否使用 N 個 pairwise DR session（每個成員獨立 session）？
2. 或使用 sender key 機制（一個 sender key 加密，分發給所有成員）？
3. 群組成員變更時，金鑰如何更新？

---

### Q-13: 頭像加密

**問題**：
1. 使用者頭像上傳時是否經過加密？
2. 頭像儲存在 R2 的哪個路徑？
3. 頭像是否為公開資料（任何人可存取）還是需要認證？

---

### Q-14: Receipt / Read Status

**問題**：
1. 是否有已讀回執機制？
2. 若有，是否加密？
3. 伺服器是否可推知訊息已讀狀態？

---

### Q-15: 裝置更換時的 DR Session 處理

**問題**：
1. 使用者更換裝置後，舊的 DR session 如何處理？
2. 對方是否會收到 session 重建通知？
3. 是否有機制防止舊裝置持續使用舊 DR state？

---

## 5. 並發安全問題

### Q-18: DR 狀態並發 mutex ✅ 已解答

**位置**：`dr-session.js:1546`（enqueueDrSessionOp）

**結論**：外部 mutex **已存在**。`enqueueDrSessionOp()` 是一個 queue-based 序列化機制，所有 encrypt/decrypt 操作均透過它串行化：
- 發送端：`sendDrPlaintext`（line 1774）、`sendDrMedia`（line 2979）
- 接收端：`state-live.js:380`（decryptIncomingSingle）

**殘餘問題**：`seedTransportCounterFromServer()` 是否也使用此 mutex 需確認（H-7 相關）。

---

## 6. 測試與品質問題

### Q-16: 密碼學模組測試覆蓋率

**問題**：
1. `shared/crypto/dr.js` 的單元測試覆蓋率？
2. 是否有已知測試向量（test vectors）？
3. 是否有 fuzz testing？
4. 邊界案例測試（max counter, empty message, 最大 gap 等）？

---

### Q-17: Debug 日誌生產環境控制

**位置**：`shared/crypto/dr.js:213-235, 305-330, 368-378, 423-485`

**觀察**：DR 模組在多處輸出金鑰的 hash 值和詳細 debug 資訊。

**問題**：
1. 生產環境是否停用這些 debug 日誌？
2. 是否有環境變數或 build flag 控制？
3. 若未停用，金鑰 hash 值是否構成安全風險？

---

## 優先順序建議

| 優先 | 問題 | 理由 |
|------|------|------|
| 🔴 高 | Q-1 (Send ratchet) | 直接影響前向保密設計 |
| 🔴 高 | Q-2 (message_key 傳輸) | 若在 wire 中傳輸將完全破壞加密 |
| 🔴 高 | Q-8 (JWT 驗證) | 認證邏輯正確性 |
| 🟡 中 | Q-4 (Skipped keys 上限) | 潛在 DoS 向量 |
| 🟡 中 | Q-5 (CSP) | XSS 防護 |
| 🟡 中 | Q-6 (Rate limiting) | 暴力破解防護 |
| 🟡 中 | Q-10 (Vault 加密) | Vault 安全性 |
| 🟡 中 | Q-11 (Call epoch) | 通話金鑰輪換 |
| 🟢 低 | Q-12 (群組模型) | 架構理解 |
| 🟢 低 | Q-13 (頭像) | 低風險 metadata |
| 🟢 低 | Q-14 (Receipt) | Metadata 暴露 |
| ✅ | Q-18 (DR mutex) | 已解答：`enqueueDrSessionOp()` 序列化機制已存在 |
| 🔴 高 | NEW: Account token 應否 hash | DB 洩漏風險 |
