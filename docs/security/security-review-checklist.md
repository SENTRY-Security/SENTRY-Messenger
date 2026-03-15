# Security Review Checklist

> 供內部或第三方安全審計使用的逐項檢查清單。所有項目均可回溯至具體程式碼。

## 1. 密碼學原語

### 1.1 對稱加密

- [ ] AES-256-GCM 金鑰長度為 256 bit（`dr.js`, `aead.js`）
- [ ] IV 長度為 96 bit（12 bytes）且每次加密獨立隨機產生（`dr.js:450`, `aead.js:115-120`）
- [ ] 同一金鑰下 IV 不重複（依賴 CSPRNG 隨機性）
- [ ] GCM authentication tag 正確驗證（WebCrypto API 自動處理）
- [ ] 解密失敗時不洩漏明文（`dr.js` 安全政策第 1 條）

### 1.2 金鑰衍生

- [ ] HKDF-SHA256 正確使用 salt 和 info（`dr.js:67-81`）
- [ ] Root Key 衍生：`hkdfBytes(rk||dhOut, 'dr-rk', 'root', 64)`（`dr.js:84`）
- [ ] Chain Key 衍生：`hkdfBytes(ck, 'dr-ck', 'chain', 64)`（`dr.js:88`）
- [ ] X3DH SK 衍生：`hkdfBytes(DH1||DH2||DH3||DH4, 'x3dh-salt', 'x3dh-root', 64)`
- [ ] Info tag 白名單限制在 `aead.js:33-42` 中的 8 個合法值
- [ ] 不同用途的金鑰使用不同 info tag（防止 domain separation failure）

### 1.3 Argon2id

- [ ] 參數：m=64MiB, t=3, p=1（`kdf.js`）
- [ ] Salt 為 16 bytes random（`kdf.js`）
- [ ] 輸出用於 AES-256 金鑰
- [ ] 低端裝置效能可接受

### 1.4 非對稱加密

- [ ] Ed25519 金鑰產生使用 `nacl.sign.keyPair()`（`prekeys.js`）
- [ ] X25519 金鑰產生使用 `nacl.box.keyPair()`（`prekeys.js`）
- [ ] Ed25519→X25519 轉換正確（`ed2curve.js`）
- [ ] X25519 clamping 正確：`d[0] &= 248, d[31] &= 127, d[31] |= 64`（`ed2curve.js:210-212`）
- [ ] SPK 簽章驗證在 X3DH initiator 端執行
- [x] TOFU：首次 X3DH 儲存 peer Identity Key，後續偵測 key 變更（`contact-secrets.js:checkAndStorePeerIk`）
- [x] Safety Number：雙方可透過 60 位數字指紋帶外驗證身份（`safety-number.js:computeSafetyNumber`）
- [x] Identity Key 變更時觸發 `dr:identity-key-changed` 事件（`dr-session.js`）

## 2. Double Ratchet

### 2.1 X3DH Key Exchange

- [ ] 4 個 DH 操作正確執行（DH1-DH4）（`dr.js:158-238`）
- [ ] DH 結果正確串接（`dh1 || dh2 || dh3 || dh4`）
- [ ] SK 正確衍生（HKDF with 'x3dh-salt', 'x3dh-root'）
- [ ] OPK 正確消耗（使用後從 bundle 移除）
- [ ] Ephemeral key 在 X3DH 完成後丟棄

### 2.2 Ratchet Operations

- [ ] DH ratchet 在收到新 ephemeral key 時正確觸發（`dr.js:504+`）
- [ ] ⚠️ **Send-side ratchet 停用** — 確認此為設計決策而非 bug（`dr.js:357-364`）
- [ ] Root Key 和 Chain Key 分離正確
- [ ] Chain Key 在每次訊息後正確推進

### 2.3 Counter 管理

- [ ] Send counter (Ns) 每次發送後遞增
- [ ] Receive counter (Nr) 每次接收後遞增
- [ ] Previous counter (PN) 在 DH ratchet 時正確記錄
- [ ] Counter 包含在 AAD 中

### 2.4 Skipped Keys

- [ ] Skipped keys 正確儲存（`dr.js:128-156`）
- [ ] 每 chain 最多 100 keys
- [ ] 使用後立即刪除（take-and-delete）
- [ ] 總量上限是否合理（防止記憶體攻擊）

### 2.5 AAD

- [ ] AAD 格式：`v:{version};d:{deviceId};c:{counter}`（`dr.js:44-65`）
- [ ] Version、deviceId、counter 正確序列化
- [ ] AAD 在加密和解密時一致
- [ ] 篡改任一欄位導致 GCM 驗證失敗

## 3. 金鑰管理

### 3.1 Master Key

- [ ] 32 bytes random（`crypto.getRandomValues`）
- [ ] 僅存於客戶端記憶體（`store.js:_MK_RAW`）
- [ ] Wrapped blob 格式正確（`kdf.js`）
- [ ] 密碼變更時正確重新 wrap

### 3.2 Device Keys

- [ ] IK/SPK/OPK 正確產生
- [ ] 私鑰使用 MK 加密儲存於伺服器
- [ ] 公鑰正確發佈至 prekey bundle
- [ ] OPK 補充邏輯正確（登入時檢查剩餘量）

### 3.3 金鑰清除

- [ ] 登出時清除記憶體中金鑰
- [ ] ⚠️ JavaScript GC 不保證立即清除
- [ ] sessionStorage 在 tab 關閉時清除
- [ ] localStorage `contactSecrets-v2` 登出時是否清除

## 4. 伺服器端安全

### 4.1 認證

- [ ] JWT 驗證正確（`account-ws.js:141-180`）
  - [ ] HMAC-SHA256 簽章驗證
  - [ ] 過期時間檢查
  - [ ] Header 格式驗證
- [ ] WebSocket 二次認證（`account-ws.js:232+`）
- [ ] Stale session 拒絕（`account-ws.js:571-591`）
- [ ] NFC SDM CMAC 驗證（`worker.js`）

### 4.2 授權

- [ ] 訊息發送需 conversation ACL 驗證
- [ ] Prekey bundle 存取控制
- [ ] Media presigned URL 授權
- [ ] Vault 存取限於帳號所有者

### 4.3 輸入驗證

- [x] WebSocket 訊息大小限制（Signal: 16KB, SDP: 64KB）
- [x] Ephemeral buffer 限制（50 messages, 5 min TTL）
- [x] SQL injection 防護 — 全部 358 處使用 parameterized queries（`?N`）
- [x] 輸入正規化：account_digest（64 hex）、conversation_id（8-128 alphanum）等
- [x] 訊息 counter 嚴格遞增（server-side `counter <= MAX(previous)` 檢查）
- [x] ~~Account token 明文儲存（應 hash 後儲存）~~ — ✅ Phase 1 已修復：新增 `account_token_hash` 欄位，驗證時優先比對 hash、舊帳號 fallback 明文並自動回填 hash（`worker.js`、`0012_add_account_token_hash.sql`）
- [x] ~~Rate limiting 非分散式~~ — ✅ 已修復：新增 `RateLimiter` Durable Object，全域 IP 限流 + 認證/prekey/訊息/pairing code 分層限流
- [x] ~~Error messages 洩漏狀態（"CounterTooLow" 含 maxCounter）~~ — ✅ 已修復：移除 `lastCtr`、`maxCounter`、`details` 等內部狀態欄位（`worker.js`）
- [x] ~~Debug endpoints 未停用（`/auth/sdm/debug-kit`, `/auth/opaque/debug`）~~ — ✅ 已修復：透過 `ENABLE_DEBUG_ENDPOINTS` 環境變數控制，生產環境預設 `false`，僅 UAT 啟用（`wrangler.toml`、`worker.js`）
- [ ] 無 CSRF token 驗證 — ⬇️ 降級為 Low：系統不使用 cookie 認證（token 透過 `x-account-token` header 傳送），傳統 CSRF 攻擊不成立，可選加 `Origin` header 驗證作為縱深防禦

### 4.4 OPAQUE

- [ ] 使用 `@cloudflare/opaque-ts@0.7.5` with SRI
- [ ] Registration 流程正確（init → finish）
- [ ] Login 流程正確（init → finish → session key）
- [ ] 密碼不經網路傳輸

## 5. 媒體安全

### 5.1 Chunk 加密

- [ ] Per-chunk 獨立 HKDF salt + random IV
- [ ] Key = HKDF(MK, salt, 'media/chunk-v1')
- [ ] ⚠️ 無 AAD（chunk index 未綁定）
- [ ] Presigned URL 存取控制

### 5.2 Manifest

- [ ] Manifest 加密：HKDF(MK, salt, 'media/manifest-v1')
- [ ] Manifest 包含 chunk metadata（iv, salt, size）
- [ ] Manifest 版本 v3
- [ ] ⚠️ 無獨立簽章

## 6. 通話安全

### 6.1 Key Derivation

- [ ] CMK = HKDF(conv_token, 'call-master-key:{callId}:{epoch}', random_salt)
- [ ] cmkProof = HMAC(CMK, '{callId}:{epoch}')
- [ ] 方向性金鑰（caller/callee 分離）
- [ ] Per-media-type 金鑰（audio/video 分離）

### 6.2 Frame Encryption

- [ ] Counter-based nonce（防重放）
- [ ] InsertableStreams 正確設定
- [ ] ⚠️ Epoch 輪換機制待確認
- [x] ~~InsertableStreams 不支援時的 fallback 行為~~ — ✅ 已修復：本地或對端不支援時 `failCall` 拒絕通話，不允許靜默降級為未加密（`media-session.js`）

### 6.3 WebRTC

- [ ] ICE candidate 類型（是否限制為 relay only）
- [ ] TURN 認證
- [ ] DTLS/SRTP 底層加密
- [ ] ⚠️ P2P 連線可能暴露 IP

## 7. Metadata 保護

- [ ] 訊息內容加密 ✓
- [ ] 媒體內容加密 ✓
- [ ] ⚠️ 社交圖譜可見（`conversation_acl` 明文）
- [ ] ⚠️ 通訊時間可見（timestamp 明文）
- [ ] ⚠️ 訊息大小可推知（無 padding）
- [ ] ⚠️ 在線狀態可推知（WebSocket/presence）

## 8. 臨時對話安全

- [ ] 一次性 token 正確消耗（atomic）
- [ ] Guest 臨時身份（不關聯常駐帳號）
- [ ] Session 到期自動銷毀
- [ ] 暫存訊息不寫入 D1
- [ ] ⚠️ 暫存訊息在 DO 記憶體中（最多 50 則, 5 分鐘 TTL）

## 9. 環境安全

- [ ] SRI 驗證所有 CDN 載入（OPAQUE、Argon2id）
- [ ] ⚠️ CSP headers 設定待確認
- [ ] ⚠️ CORS 設定待確認
- [x] ~~HTTP API rate limiting 待確認~~ — ✅ 已修復：與 M-1 共同處理，`RateLimiter` DO 全域 IP 限流覆蓋所有端點
- [ ] TLS 1.2+ 強制（Cloudflare 處理）
- [x] ~~Debug 日誌是否在生產環境停用~~ — ✅ 已修復：`debug-flags.js` 透過 `__PRODUCTION__` build flag 在生產環境強制關閉所有 debug switches（`build.mjs`、`deploy.yml`）

## 10. 部署與 CI/CD 安全

- [x] GitHub Actions secrets 不透過 `echo` 傳入指令（`deploy.yml:94-105`）— 已改用 env vars + printf
- [ ] SSH 使用 key-based 認證而非密碼（`deploy.yml:177-179`）
- [ ] Debug page 不在生產環境可存取（`[[path]].ts:108-115`）
- [ ] Debug flags 在生產環境停用（`debug-flags.js`）
- [ ] Source maps 在生產環境停用（`build.mjs:53`）
- [ ] `build-manifest.json` 不公開可存取（`build.mjs:346`）
- [ ] CSP header 設定限制 script-src（`_headers`）
- [ ] HSTS header 啟用（`_headers`）
- [ ] CORS 設定不使用 `allow-origin: *`（`[[path]].ts:209-226`）
- [ ] API proxy 有 rate limiting（`[[path]].ts:156-217`）
- [ ] UAT 與 Production 使用不同 API token（`setup-environments.sh`）
- [ ] Wipe script 需要明確確認（`wipe-all.sh`）

## 11. 資料殘留

- [ ] D1 訊息 TTL/清理機制
- [ ] R2 媒體 TTL/清理機制
- [ ] localStorage 登出時清除
- [ ] sessionStorage 依賴瀏覽器清理
- [ ] ⚠️ Cloudflare 日誌是否記錄 API request body
