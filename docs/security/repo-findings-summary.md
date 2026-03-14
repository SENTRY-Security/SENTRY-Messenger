# Repository Findings Summary

> 基於完整 repo 掃描的安全發現摘要。所有發現均可回溯至具體程式碼位置。

## 1. 掃描範圍

| 項目 | 範圍 |
|------|------|
| 客戶端加密模組 | `web/src/shared/crypto/` (dr.js, aead.js, ed2curve.js, prekeys.js) |
| 客戶端 KDF | `web/src/app/crypto/kdf.js` |
| 認證流程 | `web/src/app/features/login-flow.js`, `opaque.js` |
| 訊息金鑰 Vault | `web/src/app/features/message-key-vault.js` |
| 媒體加密 | `web/src/app/features/chunked-upload.js`, `chunked-download.js` |
| 通話加密 | `web/src/app/features/calls/key-manager.js`, `media-session.js` |
| 伺服器 API | `data-worker/src/worker.js` |
| WebSocket | `data-worker/src/account-ws.js` |
| 資料庫 Schema | `data-worker/migrations/0001-0011` |
| 客戶端狀態 | `web/src/app/core/store.js` |
| NFC/SDM | `web/src/app/features/sdm.js` |

## 2. 正面發現

### 2.1 架構設計

| 發現 | 位置 | 說明 |
|------|------|------|
| **零知識設計** | 全系統 | 伺服器僅儲存密文和公鑰，無法讀取訊息或媒體內容 |
| **嚴格無 Fallback 政策** | `dr.js:1-15` | 明確宣告解密失敗不 fallback、不降級、不靜默恢復 |
| **金鑰用途隔離** | `aead.js:33-42` | HKDF info tag 白名單防止金鑰跨域使用 |
| **SRI 驗證** | HTML | CDN 載入的 OPAQUE 和 Argon2id 使用 SRI hash 驗證完整性 |
| **OPAQUE PAKE** | `opaque.js` | 密碼永遠不離開客戶端，伺服器無法推導密碼 |

### 2.2 密碼學實作

| 發現 | 位置 | 說明 |
|------|------|------|
| **標準演算法選擇** | 全系統 | AES-256-GCM、HKDF-SHA256、Ed25519、X25519 |
| **Per-message 認證** | `dr.js:44-65` | AAD 包含 version、deviceId、counter |
| **Per-chunk 獨立加密** | `chunked-upload.js` | 每個 chunk 使用獨立 HKDF salt + IV |
| **方向性通話金鑰** | `key-manager.js` | Caller/Callee 使用不同金鑰，防止雙向重用 |
| **CMK Proof** | `key-manager.js:276-287` | HMAC 驗證防止 callId/epoch 竄改 |
| **Stale session 防護** | `account-ws.js:571-591` | 拒絕過期 session，關閉舊連線 |

### 2.3 資料保護

| 發現 | 位置 | 說明 |
|------|------|------|
| **MK 僅存記憶體** | `store.js:_MK_RAW` | Master Key 不持久化至 storage |
| **Wrapped blob 保護** | `kdf.js` | MK 使用 Argon2id + AES-GCM 加密後才上傳伺服器 |
| **Device keys 加密備份** | `login-flow.js` | 私鑰使用 MK 衍生金鑰加密後儲存 |
| **目錄路徑雜湊** | `chunked-upload.js:60-80` | HMAC 迭代衍生防止伺服器推知檔案結構 |

## 3. 安全關切

### 3.1 高優先

| 編號 | 發現 | 位置 | 風險 |
|------|------|------|------|
| H-1 | **Send-side ratchet 停用** | `dr.js:357-364` | 發送方 ephemeral key 不在每次發送時輪替，降低前向保密粒度 |
| H-2 | **無 Prekey Bundle 帶外驗證** | X3DH 流程 | 伺服器可替換 prekey bundle 進行 MITM |
| H-3 | **自訂 JWT 驗證** | `account-ws.js:141-180` | 自訂實作增加驗證邏輯出錯的風險 |
| H-4 | **Vault 降低前向保密** | `message-key-vault.js` | Message key 持久化，MK 洩漏可解密歷史訊息 |
| H-5 | **自訂 ed2curve 轉換** | `ed2curve.js` | 自訂 field arithmetic，需確認正確性 |

### 3.2 中優先

| 編號 | 發現 | 位置 | 風險 |
|------|------|------|------|
| M-1 | **無 IK/SPK 定期輪替** | `prekeys.js` | 長期使用同一金鑰增加洩漏影響範圍 |
| M-2 | **Chunk 加密無 AAD** | `chunked-upload.js` | Chunk index 未綁定加密，理論上可替換 |
| M-3 | **AEAD envelope 無 AAD** | `aead.js` | 除 DR 訊息外，其他加密操作不使用 AAD |
| M-4 | **Debug 日誌輸出金鑰雜湊** | `dr.js:213-235, 305-330` | 生產環境可能洩漏金鑰資訊 |
| M-5 | **社交圖譜完全暴露** | `conversation_acl` D1 表 | 伺服器可建立完整社交圖譜 |
| M-6 | **訊息大小洩漏** | 全系統 | 無 padding 機制，密文大小反映明文大小 |
| M-7 | **媒體 content_type 在上傳請求中明文** | `sign-put-chunked` API | 伺服器在簽名請求中可見 content_type 和 total_size |
| M-8 | **Vault wrap_context 明文傳送** | `message-key-vault.js:194` | 伺服器可見 msgType、direction 等 metadata |

### 3.3 低優先

| 編號 | 發現 | 位置 | 風險 |
|------|------|------|------|
| L-1 | **localStorage 殘留** | `contactSecrets-v2` | 登出後加密快照可能殘留 |
| L-2 | **Argon2id 低端裝置效能** | `kdf.js` | m=64MiB 可能在低端裝置 OOM |
| L-3 | **WebRTC IP 洩漏** | `media-session.js` | P2P 連線可能暴露真實 IP |
| L-4 | **InsertableStreams 相容性** | `key-manager.js` | 不支援的瀏覽器無法使用通話 E2EE |
| L-5 | **Cloudflare 單點依賴** | 架構 | 服務中斷 = 系統不可用 |

## 4. 待確認事項

以下事項在程式碼掃描中無法完全確認，需作者或進一步分析：

| 編號 | 事項 | 相關檔案 |
|------|------|----------|
| Q-1 | Send-side ratchet 停用是設計決策還是 bug？ | `dr.js:357-364` |
| Q-2 | `message_key_b64` 是否在 DR envelope 傳輸中包含？ | `dr.js` envelope 格式 |
| Q-3 | 頭像圖片是否經過加密？ | 上傳流程 |
| Q-4 | CSP headers 如何設定？ | `worker.js` |
| Q-5 | HTTP API 是否有 rate limiting？ | `worker.js` |
| Q-6 | DR header 是否在密文外（明文可見）？ | `dr.js` envelope |
| Q-7 | Contact secrets backup 的加密金鑰如何衍生？ | `contact-secrets.js` |
| Q-8 | Call key epoch 輪換的觸發機制？ | `key-manager.js` |
| Q-9 | 群組訊息是否為 N 個 pairwise DR session？ | 群組加密模型 |
| Q-10 | Cloudflare 日誌是否記錄 API request body？ | 基礎設施 |

## 5. 與 Signal Protocol 的差異

| 方面 | Signal Protocol | SENTRY 實作 | 影響 |
|------|-----------------|-------------|------|
| 實作 | libsignal（C/Rust） | 自訂 JavaScript | 需獨立審計 |
| Safety Number | ✓ 提供 | ✗ 未實作 | 無法防禦 MITM 伺服器 |
| SPK 輪替 | 1-7 天 | ✗ 不輪替 | 增加金鑰洩漏影響 |
| Sealed Sender | ✓ 提供 | ✗ 未實作 | 伺服器可見發送者 |
| Message padding | ✓ 固定大小 | ✗ 無 padding | 訊息大小可推知 |
| Key Vault | ✗ 無 | ✓ 有 | SENTRY 犧牲部分前向保密換取歷史回放 |
| Send ratchet | ✓ 啟用 | ⚠️ 停用 | 降低前向保密粒度 |
| PAKE 認證 | ✗ 使用 PIN/密碼 | ✓ OPAQUE | SENTRY 更強的密碼認證 |
| NFC 身份 | ✗ 電話號碼 | ✓ NTAG424 DNA | SENTRY 獨特的實體身份綁定 |

## 6. 總體評估

**安全設計品質**：良好。系統遵循密碼學最佳實踐，使用標準演算法，金鑰管理架構合理。

**主要風險**：
1. 自訂密碼學實作需要第三方審計
2. Send-side ratchet 停用降低前向保密
3. Vault 設計是有意的安全取捨（歷史回放 vs 前向保密）
4. 無帶外金鑰驗證（信任伺服器不進行 MITM）

**建議優先行動**：
1. 文件化 send-side ratchet 停用的設計理由
2. 考慮實作 Safety Number / Key Fingerprint
3. 安排核心密碼學模組的第三方審計
4. 確認 debug 日誌在生產環境的控制方式
5. 考慮為媒體 chunk 加入 AAD（chunk index binding）
