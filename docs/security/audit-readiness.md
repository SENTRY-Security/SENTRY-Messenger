# Audit Readiness Assessment

> 基於 repo 程式碼掃描。評估各模組的第三方安全審計準備度。

## 1. 整體評估

| 面向 | 評分 | 說明 |
|------|------|------|
| 文件完備度 | 🟡 中等 | README 完整但無正式安全規格文件；本文件集為首次系統化安全文件 |
| 程式碼可審計性 | 🟢 良好 | 模組化結構清晰，加密邏輯集中在 `shared/crypto/` |
| 測試覆蓋度 | 🟡 中等 | ⚠️ 需確認 crypto 模組的單元測試覆蓋率 |
| 安全政策明確性 | 🟢 良好 | `dr.js` 開頭有明確安全政策宣告（無 fallback、無降級） |
| 依賴管理 | 🟢 良好 | CDN 載入使用 SRI 驗證（OPAQUE、Argon2id） |
| 威脅模型 | 🟢 良好 | 本文件集已建立（`threat-model.md`） |

## 2. 模組級審計準備度

### 2.1 最高優先 — 核心密碼學

| 模組 | 檔案 | 行數 | 準備度 | 審計建議 |
|------|------|------|--------|----------|
| Double Ratchet | `shared/crypto/dr.js` | ~1166 | 🟢 | 自訂實作，需完整審計。特別關注 send-side ratchet 停用（Lines 357-364）和 skipped keys 管理 |
| AEAD Envelope | `shared/crypto/aead.js` | ~164 | 🟢 | 封裝層，需確認 info tag 白名單完整性 |
| Ed25519↔X25519 | `shared/crypto/ed2curve.js` | ~230 | 🟡 | 自訂 field arithmetic，需審計正確性和 timing safety |
| X3DH Prekeys | `shared/crypto/prekeys.js` | ~115 | 🟢 | 相對簡單，需確認 OPK 消耗邏輯 |
| Argon2id KDF | `app/crypto/kdf.js` | ~89 | 🟢 | 封裝第三方庫，需確認參數選擇合理性 |

### 2.2 高優先 — 安全關鍵流程

| 模組 | 檔案 | 行數 | 準備度 | 審計建議 |
|------|------|------|--------|----------|
| OPAQUE 整合 | `features/opaque.js` | ~70 | 🟢 | 與 opaque-ts 的整合邏輯 |
| Login Flow | `features/login-flow.js` | ~636 | 🟡 | 複雜流程，需追蹤金鑰材料在各步驟的處理 |
| Message Key Vault | `features/message-key-vault.js` | ~682 | 🟡 | Vault 加密方式、自我修復邏輯需審計 |
| Chunked Upload | `features/chunked-upload.js` | ~1100 | 🟡 | Per-chunk 加密、manifest 格式需審計 |
| Chunked Download | `features/chunked-download.js` | ~281 | 🟢 | 相對簡單的解密流程 |

### 2.3 中優先 — 通訊安全

| 模組 | 檔案 | 行數 | 準備度 | 審計建議 |
|------|------|------|--------|----------|
| Call Key Manager | `features/calls/key-manager.js` | ~452 | 🟡 | 自訂金鑰衍生和 epoch 管理 |
| Call Media Session | `features/calls/media-session.js` | ~1100 | 🟡 | WebRTC 設定、ICE candidate 處理 |
| WebSocket Auth | `data-worker/src/account-ws.js` | ~50KB | 🟡 | 自訂 JWT 驗證、stale session 防護 |
| Server API | `data-worker/src/worker.js` | Large | 🟡 | 所有 API endpoint 的輸入驗證和授權 |

### 2.4 低優先 — 輔助模組

| 模組 | 檔案 | 準備度 | 審計建議 |
|------|------|--------|----------|
| Invite Dropbox | `app/crypto/invite-dropbox.js` | 🟡 | 邀請加密機制 |
| Contact Secrets | `features/contact-secrets.js` | 🟡 | localStorage 加密快照 |
| Store | `app/core/store.js` | 🟢 | 金鑰記憶體管理 |

## 3. 審計前準備清單

### 3.1 文件準備

| 項目 | 狀態 | 說明 |
|------|------|------|
| 威脅模型 | ✓ 已建立 | `docs/security/threat-model.md` |
| 安全架構 | ✓ 已建立 | `docs/security/security-architecture.md` |
| 協議規格 | ✓ 已建立 | `docs/security/protocol-overview.md` |
| 金鑰管理 | ✓ 已建立 | `docs/security/key-management.md` |
| 資料分類 | ✓ 已建立 | `docs/security/data-classification.md` |
| 已知限制 | ✓ 已建立 | `docs/security/known-limitations.md` |
| 正式協議規格（獨立於實作） | ✗ 缺少 | 需獨立於程式碼的協議定義文件 |
| 加密原語選擇理由 | ✗ 缺少 | 為何選 AES-256-GCM、為何不用 XChaCha20 等 |
| AAD 二進位格式規格 | ✗ 缺少 | `v:1;d:...;c:...` 格式需正式文件化 |

### 3.2 測試準備

| 項目 | 狀態 | 說明 |
|------|------|------|
| DR 單元測試 | ⚠️ 待確認 | 需確認覆蓋率和邊界案例 |
| AEAD 單元測試 | ⚠️ 待確認 | 需確認 |
| KDF 單元測試 | ⚠️ 待確認 | 需確認 |
| 整合測試 | ⚠️ 待確認 | 端到端加密/解密流程 |
| 向量測試 | ⚠️ 待確認 | 是否有已知測試向量 |
| Fuzzing | ✗ 未實作 | 建議對 DR decode、AEAD unwrap 進行 fuzzing |

### 3.3 基礎設施準備

| 項目 | 狀態 | 說明 |
|------|------|------|
| 依賴清單 | ✓ | `package.json` |
| SRI 驗證 | ✓ | CDN 載入的庫使用 SRI |
| CSP 設定 | ⚠️ 待確認 | Content Security Policy headers |
| CORS 設定 | ⚠️ 待確認 | Cross-Origin Resource Sharing |
| Rate Limiting | 部分 | WebSocket 有大小限制，HTTP API 需確認 |

## 4. 建議的審計範圍

### 4.1 第一階段：核心密碼學（建議）

**範圍**：
1. `shared/crypto/dr.js` — Double Ratchet 完整實作
2. `shared/crypto/aead.js` — AEAD 封裝
3. `shared/crypto/ed2curve.js` — Ed25519↔X25519 轉換
4. `shared/crypto/prekeys.js` — Prekey 產生
5. `app/crypto/kdf.js` — Argon2id KDF

**重點關注**：
- Send-side ratchet 停用的影響
- Skipped keys 記憶體管理
- Ed2curve 自訂 field arithmetic 正確性
- HKDF salt/info 分離是否足夠
- 12-byte random IV 碰撞機率在實際使用量下是否可接受

**估計規模**：~1,764 行核心加密程式碼

### 4.2 第二階段：協議與流程

**範圍**：
1. `features/login-flow.js` — 完整認證流程
2. `features/opaque.js` — OPAQUE 整合
3. `features/message-key-vault.js` — Vault 加密
4. `data-worker/src/account-ws.js` — WebSocket 認證

**重點關注**：
- OPAQUE 與 opaque-ts 的整合是否正確
- Vault 的加密金鑰衍生方式
- JWT 自訂驗證的正確性
- Session 管理的競態條件

### 4.3 第三階段：媒體與通話

**範圍**：
1. `features/chunked-upload.js` — 媒體加密上傳
2. `features/chunked-download.js` — 媒體解密下載
3. `features/calls/key-manager.js` — 通話金鑰
4. `features/calls/media-session.js` — WebRTC 設定

**重點關注**：
- Per-chunk 加密無 AAD 的安全影響
- Manifest 完整性保護是否足夠
- Call key epoch 輪換機制
- ICE candidate 是否洩漏 IP

## 5. 審計阻礙因素

| 阻礙 | 影響 | 建議 |
|------|------|------|
| 無正式協議規格 | 審計者需從程式碼推導協議意圖 | 撰寫獨立協議規格文件 |
| 自訂 JWT 驗證 | 增加審計面 | 考慮使用標準 JWT 函式庫 |
| Debug 日誌含金鑰雜湊 | 生產環境潛在洩漏 | 增加環境變數控制 |
| Send-side ratchet 停用原因不明 | 審計者需理解設計意圖 | 文件化決策理由 |
| Vault 設計減弱前向保密 | 需明確說明取捨 | 文件化設計決策 |

## 6. 預估審計規模

| 階段 | 模組數 | 程式碼行數 | 建議工時 |
|------|--------|-----------|----------|
| 核心密碼學 | 5 | ~1,764 | 中等 |
| 協議與流程 | 4 | ~1,400+ | 中等 |
| 媒體與通話 | 4 | ~2,900+ | 中等 |
| 伺服器端 | 2 | ~50KB+ | 大 |
| **總計** | **15** | **~6,000+** | — |

> ⚠️ 工時估計需由實際審計團隊根據其經驗和方法論決定，上述僅為模組複雜度參考。
