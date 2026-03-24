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
| **SQL injection 全面防護** | `worker.js` 全部 358 處 | 所有 DB 操作使用 parameterized queries（`?N` 佔位符） |
| **嚴格輸入正規化** | `worker.js` | account_digest（64 hex）、conversation_id（8-128 alphanum）、device_id（max 120）等均有驗證 |
| **訊息 counter 嚴格遞增** | `worker.js` atomic-send | 伺服器端 `counter <= MAX(previous)` 檢查，防止重放 |

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
| H-2 | ~~**無 Prekey Bundle 帶外驗證**~~ | X3DH 流程 | ✅ 已實作：TOFU identity key tracking + Safety Number 帶外驗證機制（`contact-secrets.js:checkAndStorePeerIk`, `safety-number.js`） |
| ~~H-3~~ | ~~**自訂 JWT 驗證**~~ | `jwt.js`, `worker.js` | ✅ 已遷移至 `jose` 套件（panva/jose，經安全審計）— HS256 使用 `jwtVerify`（constant-time + `algorithms: ['HS256']`），RS256 使用 `importSPKI`+`jwtVerify`（`algorithms: ['RS256']` + `exp` 驗證 + clockTolerance）。修復 P0 `verifyJwtRS256` 未驗證 `exp`、P0 alg confusion、P1 非 constant-time 簽章比對 |
| H-4 | **Vault 降低前向保密** | `message-key-vault.js` | Message key 持久化，MK 洩漏可解密歷史訊息 |
| H-5 | **自訂 ed2curve 轉換** | `ed2curve.js` | 自訂 field arithmetic，需確認正確性 |
| H-6 | ~~**DR 狀態並發競態條件**~~ | `dr-session.js` | ✅ 已有 mutex：`enqueueDrSessionOp()` 序列化所有 encrypt/decrypt 操作（`dr-session.js:1546`），收發端均使用（`state-live.js:380`） |
| H-7 | **NsTotal 非同步 seeding 競態** | `dr-session.js:357-453` | seedTransportCounterFromServer() 可能覆蓋 drEncryptText() 的遞增結果 |
| H-8 | **Account token 明文儲存** | `worker.js` accounts 表 | `account_token` 未 hash，DB 洩漏即可存取所有帳號 |
| H-9 | **Rate limiting 非分散式** | `worker.js:317` | 使用 in-memory Map，不同 Cloudflare isolate 各自獨立，跨區域無效 |
| H-10 | **Error messages 洩漏內部狀態** | `worker.js` 多處 | 回傳 "CounterTooLow"（含 maxCounter）、"Replay"、"SessionExpired" 等可用於列舉 |

### 3.2 中優先

| 編號 | 發現 | 位置 | 風險 |
|------|------|------|------|
| M-1 | **無 IK/SPK 定期輪替** | `prekeys.js` | 長期使用同一金鑰增加洩漏影響範圍 |
| M-2 | **Chunk 加密無 AAD** | `chunked-upload.js` | Chunk index 未綁定加密，理論上可替換 |
| M-3 | **AEAD envelope 無 AAD** | `aead.js` | 除 DR 訊息外，其他加密操作不使用 AAD |
| M-4 | **Debug 日誌輸出金鑰雜湊** | `dr.js:213-235, 305-330` | 生產環境可能洩漏金鑰資訊 |
| M-5 | **社交圖譜部分暴露**（部分緩解） | `conversation_acl` D1 表 | `conversation_acl` 仍明文暴露對話關係。**已緩解**：`contacts` 表透過 Zero-Meta 0-A（`0017_contacts_zero_meta.sql`）將 `peer_digest` 改為不可逆 `slot_id`（HMAC 衍生），`peer_digest` 和 `is_blocked` 移入加密 blob，伺服器無法從 contacts 表推知聯絡人關係 |
| M-6 | **訊息大小洩漏** | 全系統 | 無 padding 機制，密文大小反映明文大小 |
| M-7 | **媒體 content_type 在上傳請求中明文** | `sign-put-chunked` API | 伺服器在簽名請求中可見 content_type 和 total_size |
| M-8 | **Vault wrap_context 明文傳送** | `message-key-vault.js:194` | 伺服器可見 msgType、direction 等 metadata |
| M-9 | **Invite Dropbox 硬編碼 HKDF salt** | `invite-dropbox.js:6` | 使用固定字串 `'invite-dropbox-salt'` 而非 per-envelope 隨機 salt |
| M-10 | **Call key sub-material 使用零 salt** | `key-manager.js:25,307` | `ZERO_SALT = new Uint8Array(32)` 用於 HKDF 衍生子金鑰 |
| M-11 | **AAD 未綁定完整 header** | `dr.js:44-65` | AAD 僅含 version+deviceId+counter，未包含 ek_pub_b64 和 pn，header 可被篡改 |
| M-12 | **AEAD 失敗時 state rollback** | `dr.js:1112-1145` | 解密失敗時回滾 DR state 至快照，可能違反 no-fallback 政策 |
| M-13 | **Call nonce counter 重連時歸零** | `key-manager.js:249-254` | Frame counter 僅存記憶體，tab crash 後重連同一通話可能導致 AES-GCM nonce 重用 |
| M-14 | **Delivery intent 存於 localStorage** | `invite-reconciler.js` | 邀請恢復用的 ephemeral key material 存於 localStorage，XSS 可洩漏 |

### 3.3 低優先

| 編號 | 發現 | 位置 | 風險 |
|------|------|------|------|
| L-1 | **localStorage 殘留** | `contactSecrets-v2` | 登出後加密快照可能殘留 |
| L-2 | **Argon2id 低端裝置效能** | `kdf.js` | m=64MiB 可能在低端裝置 OOM |
| L-3 | **WebRTC IP 洩漏** | `media-session.js` | P2P 連線可能暴露真實 IP |
| L-4 | **InsertableStreams 相容性** | `key-manager.js` | 不支援的瀏覽器無法使用通話 E2EE |
| L-5 | **Cloudflare 單點依賴** | 架構 | 服務中斷 = 系統不可用 |
| L-6 | **Argon2id t=3 迭代次數偏低** | `kdf.js` | OWASP 建議 t≥4，目前 t=3 |
| L-7 | **Presence 任何人可查詢** | `account-ws.js` | 任何帳號可透過 add-watcher 訂閱他人上線狀態 |
| L-8 | **Debug API endpoints 未停用** | `worker.js` | `/auth/sdm/debug-kit` 和 `/auth/opaque/debug` 在生產環境可存取 |
| L-9 | **無 CSRF token 驗證** | `worker.js` | 依賴 same-origin policy，無 Origin header 驗證 |
| L-10 | **TURN credentials 長通話不刷新** | `media-session.js` | 預設 TTL 300s，長通話時 credentials 可能過期 |
| L-11 | **群組無 per-device 成員控制** | `groups.js` | 群組僅追蹤 accountDigest，無法選擇性移除特定裝置 |

## 3.4 CI/CD 與部署安全

| 編號 | 發現 | 位置 | 風險 |
|------|------|------|------|
| D-1 | ~~**Secrets 透過 echo 傳入 wrangler**~~ | `.github/workflows/deploy.yml:94-105` | ✅ 已修復：改用 env vars + `printf` 傳入 stdin（commit `74ddeb4`） |
| D-2 | **SSH 密碼認證** | `.github/workflows/deploy.yml:177-179` | 使用密碼而非 SSH key，密碼儲存在 Actions secrets |
| D-3 | **Debug page 在生產環境可存取** | `web/functions/[[path]].ts:2,108-115` | 依 IP 白名單（硬編碼 `60.248.6.250`）控制 debug.html 存取 |
| D-4 | **缺少 CSP/HSTS headers** | `web/src/_headers` | 僅設 Cache-Control，無 CSP、HSTS、X-Frame-Options |
| D-5 | **CORS 設定不安全** | `web/functions/[[path]].ts:209-226` | `allow-origin: *` + `allow-credentials: true` 且 allow-headers 為 `*` |
| D-6 | **Source maps 在生產環境啟用** | `web/build.mjs:53` | `sourcemap: true` 暴露原始碼 |
| D-7 | **Debug flags 預設啟用** | `web/src/app/ui/mobile/debug-flags.js` | `replay: true`, `drVerbose: true`, `conversationReset: true` |
| D-8 | **Build manifest 公開可存取** | `web/build.mjs:346` | `build-manifest.json` 含 git commit、branch、完整檔案列表 |
| D-9 | **API proxy 無 rate limiting** | `web/functions/[[path]].ts:156-217` | 所有 `/api/*` 直接 proxy，無速率限制 |
| D-10 | **Wipe script 無安全護欄** | `scripts/wipe-all.sh` | 使用 `--yes` 無確認，無備份，刪除所有 D1 和 R2 資料 |
| D-11 | **UAT 與 Production 共用 S3 帳號** | `scripts/setup-environments.sh:210-214` | UAT 使用同一 Cloudflare 帳號和 API token |

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
| Safety Number | ✓ 提供 | ✓ 已實作（TOFU + 60 位數字指紋） | 帶外驗證可防禦 MITM |
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
1. 自訂密碼學實作需要第三方審計（DR、X3DH、ed2curve 等核心模組）
2. Send-side ratchet 停用降低前向保密
3. Vault 設計是有意的安全取捨（歷史回放 vs 前向保密）
4. ~~無帶外金鑰驗證~~ ✅ 已實作 TOFU + Safety Number（殘餘風險：首次連線仍信任伺服器）
5. ~~自訂 JWT 驗證~~ ✅ 已遷移至 jose 套件（經安全審計）

**建議優先行動**：

立即（1 週內）：
1. 輪換 deploy.yml 中暴露的所有密鑰
2. SSH 改用 key-based 認證
3. 移除硬編碼 debug IP，實作角色控制
4. 停用生產環境 debug logging（`debug-flags.js` 中 replay/drVerbose 設為 false）
5. 停用生產環境 source maps
6. 加入 CSP、HSTS 等安全 headers
7. 修正 CORS 設定

短期（1 個月內）：
8. 文件化 send-side ratchet 停用的設計理由
9. ~~考慮實作 Safety Number / Key Fingerprint~~ ✅ 已實作（`safety-number.js`, `contact-secrets.js:checkAndStorePeerIk`）
10. 安排核心密碼學模組的第三方審計
11. 考慮為媒體 chunk 加入 AAD（chunk index binding）
12. 加入 API rate limiting
13. 分離 UAT 和 Production 的 S3/R2 存取
