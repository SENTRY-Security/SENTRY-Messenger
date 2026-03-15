# Security Findings — 依嚴重程度排序

> 彙整自 `security-review-checklist.md`、`security-architecture.md`、`media-and-attachment-security.md`、`security-assumptions-and-out-of-scope.md` 的所有掃描項目。

---

## 🔴 Critical（嚴重）

| # | 項目 | 來源 | 說明 |
|---|------|------|------|
| C-1 | Account token 明文儲存 | `security-review-checklist.md` §4.3 | 應 hash 後儲存，明文儲存導致資料庫洩漏即全面失守 |
| ~~C-2~~ | ~~Debug endpoints 未停用~~ | `security-review-checklist.md` §4.3 | ✅ 已修復：透過 `ENABLE_DEBUG_ENDPOINTS` 環境變數控制，生產環境預設 `false` 回傳 404（`wrangler.toml`、`worker.js`） |
| C-3 | 無 CSRF token 驗證 | `security-review-checklist.md` §4.3 | 缺少 CSRF 防護，可能遭受跨站請求偽造攻擊 |
| C-4 | Send-side ratchet 停用 | `security-review-checklist.md` §2.2, `security-architecture.md` §10 | `dr.js:357-364` 中 send-side ratchet 更新被註解，`myRatchetPriv`/`myRatchetPub` 不在發送時輪替，削弱前向保密性 |

## 🟠 High（高）

| # | 項目 | 來源 | 狀態 | 說明 |
|---|------|------|------|------|
| ~~H-1~~ | ~~自訂 JWT 驗證（未使用標準函式庫）~~ | `security-architecture.md` §10 | ✅ 已修復 | 抽取共用 `jwt.js` 模組，`account-ws.js` 和 `worker.js` 統一使用同一 sign/verify 實作 |
| ~~H-2~~ | ~~Debug 日誌輸出金鑰雜湊~~ | `security-architecture.md` §10 | ✅ 已修復 | 移除 `dr.js` 中所有 `hashPrefix()` 相關的 console 輸出（x3dh、ratchet、encrypt、decrypt 全路徑） |
| ~~H-3~~ | ~~Debug 頁面 / SDM 模擬器生產環境可存取~~ | `security-assumptions-and-out-of-scope.md` §6 | ✅ 已修復 | 三層防護：(1) `ENABLE_DEBUG_PAGES` 環境變數 → 生產回傳 404 (2) IP 白名單 (3) `__PRODUCTION__` build flag 關閉 debug switches |
| ~~H-4~~ | ~~Error messages 洩漏內部狀態~~ | `security-review-checklist.md` §4.3 | ✅ 已修復 | 移除 `Replay` 回應的 `lastCtr` 和 `CounterTooLow` 回應的 `maxCounter`/`details` 欄位 |
| H-5 | MK 洩漏影響所有媒體 | `media-and-attachment-security.md` §7.2 | ⚠️ 待處理 | 所有 chunks 使用同一 MK 衍生金鑰，MK 洩漏等同全部媒體洩漏 |

## 🟡 Medium（中）

| # | 項目 | 來源 | 說明 |
|---|------|------|------|
| M-1 | Rate limiting 非分散式 | `security-review-checklist.md` §4.3 | In-memory Map 實作，跨 isolate 無效，無法有效防禦分散式暴力攻擊 |
| M-2 | Media chunk 加密無 AAD | `security-review-checklist.md` §5.1, `media-and-attachment-security.md` §7.2 | Chunk index 未綁定於 AAD，理論上 chunk 可被替換或重排 |
| M-3 | Manifest 無獨立簽章 | `security-review-checklist.md` §5.2, `security-architecture.md` §10 | 僅依賴 GCM auth tag，無額外數位簽章 |
| M-4 | AEAD 操作普遍缺少 AAD | `security-architecture.md` §10 | 除 DR 訊息外，blob、media、vault 等 AEAD 操作均不使用 AAD |
| M-5 | IV 重用風險 | `security-architecture.md` §10 | 12-byte random IV 依賴隨機不重複，無明確追蹤機制 |
| M-6 | Invite Dropbox 硬編碼 salt | `security-architecture.md` §10 | `invite-dropbox.js:6` 使用固定字串 `'invite-dropbox-salt'`，降低語義安全性 |
| M-7 | Call key 使用零 salt | `security-architecture.md` §10 | `key-manager.js:25` 的 `ZERO_SALT = new Uint8Array(32)` 用於 HKDF 子金鑰衍生 |
| M-8 | Epoch 輪換機制待確認 | `security-review-checklist.md` §6.2 | 通話中金鑰輪換機制是否正確運作需驗證 |
| M-9 | InsertableStreams 不支援時的 fallback | `security-review-checklist.md` §6.2 | 瀏覽器不支援 InsertableStreams 時的行為未明確定義 |
| M-10 | CSP headers 設定待確認 | `security-review-checklist.md` §9 | Content-Security-Policy 是否正確限制 script-src |
| M-11 | CORS 設定待確認 | `security-review-checklist.md` §9 | 是否使用過於寬鬆的 `allow-origin: *` |
| M-12 | HTTP API rate limiting 待確認 | `security-review-checklist.md` §9 | API 端點限流機制是否完備 |

## 🟢 Low（低）

| # | 項目 | 來源 | 說明 |
|---|------|------|------|
| L-1 | JavaScript GC 不保證立即清除金鑰 | `security-review-checklist.md` §3.3 | 記憶體中金鑰可能在 GC 週期內殘留 |
| L-2 | `localStorage` contactSecrets-v2 登出時是否清除 | `security-review-checklist.md` §3.3 | 持久化儲存中的密鑰資料可能在登出後殘留 |
| L-3 | 社交圖譜可見 | `security-review-checklist.md` §7 | `conversation_acl` 明文儲存，伺服器可見社交關係 |
| L-4 | 通訊時間可見 | `security-review-checklist.md` §7 | Timestamp 明文，伺服器可見通訊時間 |
| L-5 | 訊息大小可推知 | `security-review-checklist.md` §7 | 無 padding 機制，訊息密文大小可推知明文長度 |
| L-6 | 在線狀態可推知 | `security-review-checklist.md` §7 | WebSocket/presence 機制暴露使用者在線狀態 |
| L-7 | P2P 連線可能暴露 IP | `security-review-checklist.md` §6.3 | ICE candidate 類型未限制為 relay only |
| L-8 | Chunk 大小洩漏明文大小 | `media-and-attachment-security.md` §7.2 | GCM overhead 固定 16 bytes，密文大小可推知明文 |
| L-9 | 上傳時序可推知通訊行為 | `media-and-attachment-security.md` §7.2 | R2 寫入時間與訊息時間可關聯 |
| L-10 | 頭像加密待確認 | `media-and-attachment-security.md` §7.2 | 使用者頭像是否經過加密上傳需確認 |
| L-11 | Cloudflare 日誌是否記錄 API request body | `security-review-checklist.md` §11 | 第三方基礎設施可能保留請求內容 |
| ~~L-12~~ | ~~Debug 日誌生產環境是否停用~~ | `security-review-checklist.md` §9 | ✅ 已修復：`__PRODUCTION__` build flag 在生產環境關閉所有 debug switches |
| L-13 | D1/R2 資料殘留無 TTL 清理 | `security-review-checklist.md` §11 | 訊息和媒體無自動清理機制 |

---

## 統計摘要

| 嚴重程度 | 總數 | 已修復 | 待處理 |
|----------|------|--------|--------|
| 🔴 Critical | 4 | 1 | 3 |
| 🟠 High | 5 | 4 | 1 |
| 🟡 Medium | 12 | 0 | 12 |
| 🟢 Low | 13 | 1 | 12 |
| **總計** | **34** | **6** | **28** |

## 已通過項目（已修復/確認安全）

以下為 checklist 中已確認通過的項目：

- ✅ TOFU：首次 X3DH 儲存 peer Identity Key，後續偵測 key 變更（`contact-secrets.js`）
- ✅ Safety Number：雙方可透過 60 位數字指紋帶外驗證身份（`safety-number.js`）
- ✅ Identity Key 變更時觸發 `dr:identity-key-changed` 事件（`dr-session.js`）
- ✅ WebSocket 訊息大小限制（Signal: 16KB, SDP: 64KB）
- ✅ Ephemeral buffer 限制（50 messages, 5 min TTL）
- ✅ SQL injection 防護 — 全部 358 處使用 parameterized queries
- ✅ 輸入正規化：account_digest、conversation_id 等
- ✅ 訊息 counter 嚴格遞增（server-side 檢查）
- ✅ GitHub Actions secrets 不透過 echo 傳入
- ✅ DR 狀態並發已有 `enqueueDrSessionOp()` 序列化機制
- ✅ **C-2**：Debug endpoints 透過 `ENABLE_DEBUG_ENDPOINTS` 環境變數控制，生產環境回傳 404
- ✅ **H-1**：JWT 驗證統一為共用 `jwt.js` 模組（`account-ws.js`、`worker.js`）
- ✅ **H-2**：移除 `dr.js` 中所有金鑰雜湊 debug 日誌輸出
- ✅ **H-3**：Debug 頁面三層防護（env gate + IP 白名單 + `__PRODUCTION__` build flag）
- ✅ **H-4**：移除錯誤回應中的內部狀態欄位（`lastCtr`、`maxCounter`）
- ✅ **L-12**：Debug flags 在生產環境建置時強制關閉
