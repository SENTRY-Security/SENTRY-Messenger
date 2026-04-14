# Data Classification

> 基於 repo 程式碼和資料庫 schema 實際掃描。所有表格可回溯至 migration 檔案和程式碼。

## 分類定義

| 等級 | 定義 | 保護要求 |
|------|------|----------|
| **C1 — 最高機密** | 洩漏導致加密系統完全失效 | 僅存於客戶端記憶體，禁止持久化 |
| **C2 — 高機密** | 洩漏導致部分訊息可被解密 | 加密儲存，存取受控 |
| **C3 — 機密** | 洩漏暴露使用者社交圖譜 | 加密或存取控制 |
| **C4 — 敏感** | 洩漏暴露使用模式 | 存取控制 |
| **C5 — 公開** | 設計上可公開 | 無特殊要求 |

## 客戶端資料

### 記憶體中（In-Memory Only）

| 資料 | 分類 | 變數位置 | 生命週期 |
|------|------|----------|----------|
| Master Key (MK) | C1 | `store.js:_MK_RAW` | Login → Logout/Tab close |
| Device Private (IK priv, SPK priv, OPK priv) | C1 | `store.js:_DEVICE_PRIV` | Login → Logout/Tab close |
| DR State (rk, ckS, ckR, ratchet keys) | C1 | DR session holders | Per-conversation active |
| Message Key (per-message AES key) | C2 | 解密時暫存 | 解密操作完成後銷毀 |
| 使用者密碼 | C1 | 暫存於 login flow | Login 完成後清除 |
| 解密後訊息明文 | C1 | DOM / 變數 | UI 顯示期間 |
| 解密後媒體明文 | C1 | Blob URL / 變數 | UI 顯示期間 |
| OPAQUE session key | C1 | 暫存 | OPAQUE 流程完成後丟棄 |
| Call E2EE key | C1 | `key-manager.js` | 通話期間，每 1 分鐘輪換 |
| Cached media stream | C4 | `_cachedMediaStream` | 60 秒後釋放 |

### sessionStorage

| 資料 | 分類 | Key | 加密？ | 說明 |
|------|------|-----|--------|------|
| Device ID | C4 | `device_id` | 否 | UUID，裝置識別 |
| Device Counter | C4 | `deviceCounter:*` | 否 | 訊息序號 |
| Wrapped Device Handoff | C2 | `WRAPPED_DEV_HANDOFF` | 是 (AES-GCM) | 跨 tab 金鑰傳遞 |
| Ephemeral session state | C4 | 各 ephemeral keys | 否 | 臨時對話暫存 |
| Pending vault puts | C4 | `pendingVaultPuts` | 否 | 待上傳的 vault 項目 |

### localStorage

| 資料 | 分類 | Key | 加密？ | 說明 |
|------|------|-----|--------|------|
| Contact Secrets Snapshot | C2 | `contactSecrets-v2` | 是 (MK 加密) | 聯絡人金鑰快照 |
| Delivery intents | C4 | `deliveryIntents` | 部分 | 訊息傳送意圖 |

**⚠️ 注意**：localStorage 在瀏覽器關閉後**不會**被清除。若使用者登出但未明確清除 localStorage，加密的聯絡人快照仍殘留在裝置上。

## 伺服器端資料 (D1 Database)

> 來源：`data-worker/migrations/0001_consolidated.sql` 至 `0011_add_pending_key_exchange.sql`

### accounts 表

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `account_digest` | C4 | ✓ 明文 | 帳號 HMAC 摘要（衍生自 NFC UID） |
| `pairing_code` | C4 | ✓ 明文 | 配對碼 |
| `brand`, `brand_*` | C5 | ✓ 明文 | 品牌元資料 |
| `created_at` | C4 | ✓ 明文 | 帳號建立時間 |

### opaque_registrations 表

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `registration_record` | C3 | ✓ 但無法推導密碼 | OPAQUE 註冊記錄 |
| `server_id` | C4 | ✓ 明文 | OPAQUE 伺服器 ID |

### prekey_bundles 表

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `ik_pub` | C5 | ✓ 公鑰 | Identity Key 公開部分 |
| `spk_pub`, `spk_sig` | C5 | ✓ 公鑰+簽章 | Signed Prekey 公開部分 |
| `opks` (JSON) | C5 | ✓ 公鑰陣列 | One-Time Prekeys 公開部分 |

### dev_keys_backup 表

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `wrapped_blob` | C2 | ✗ 密文 | MK 加密的裝置私鑰 blob |

### messages_secure 表（Zero-Meta Phase 0-B 後）

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `id` | C4 | ✓ 明文 | 訊息 UUID |
| `conversation_id` | C4 | ✓ 明文 | 對話識別 |
| `sender_digest` | C4 | ✓ 明文 | 發送者摘要 |
| `counter` | C4 | ✓ 明文 | 訊息序號 |
| `envelope` | C1 | ✗ 密文 | DR 加密封包（header + iv + ciphertext） |
| `ts` | C4 | ✓ 明文 | 時間戳 |
| `sender_device_id` | C4 | ✓ 明文 | 發送裝置 ID |
| `receiver_device_id` | — | ✗ 一律 NULL | Phase 0-B 後不再寫入（單裝置架構下冗餘） |
| `header_counter` | C4 | ✓ 明文 | DR header 中的 counter |

### message_key_vault 表

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `conversation_id` | C4 | ✓ 明文 | 對話識別 |
| `header_counter` | C4 | ✓ 明文 | 對應的訊息 counter |
| `encrypted_key_blob` | C2 | ✗ 密文 | 加密的訊息金鑰 |

### contacts 表（Zero-Meta Phase 0-A/0-B 後）

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `owner_digest` | C4 | ✓ 明文 | 擁有者帳號摘要 |
| `slot_id` | C5 | ✓ 不可逆 hash | `HMAC-SHA256(slot_key, peer_digest)` — 伺服器無法反推 |
| `peer_digest` | — | ✗ 新格式為 NULL | 舊格式殘留，遷移後自動清除 |
| `encrypted_blob` | C2 | ✗ 密文 | AES-256-GCM(contact_storage_key) 加密的聯絡人資料 |
| `is_blocked` | — | ✗ 新格式固定 0 | 實際值在加密 blob 內（伺服器不可見） |
| `updated_at` | C5 | ✓ 每日精度 | Phase 0-B 後截斷至天（`/86400*86400`），伺服器僅見日期不見精確時間 |

### conversation_acl 表（Zero-Meta Phase 0-B 後）

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `conversation_id` | C4 | ✓ 明文 | 對話 ID |
| `account_digest` | C4 | ✓ 明文 | 參與者摘要 |
| `role` | — | ✗ 一律 NULL | Phase 0-B 後不再寫入明文角色 |

### ephemeral_invites / ephemeral_sessions 表

| 欄位 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| `token` | C3 | ✓ 明文 | 一次性邀請 token |
| `prekey_bundle_json` | C5 | ✓ 公鑰 | Owner 的 Prekey Bundle |
| `guest_digest` | C4 | ✓ 明文 | Guest 臨時摘要 |
| `expires_at` | C4 | ✓ 明文 | 過期時間 |
| `pending_key_exchange_json` | C5 | ✓ 公鑰 | Guest 的公開金鑰 bundle |

## R2 Storage (Object Storage)

| 資料 | 分類 | 伺服器可否讀取 | 說明 |
|------|------|---------------|------|
| 媒體 chunks | C1 (密文保護) | ✗ 密文 | Per-chunk AES-256-GCM 加密 |
| 頭像圖片 | C4 | ✗ 密文 | ✅ 已確認：頭像使用 AES-256-GCM + HKDF(MK, random_salt) 加密上傳（`.enc`） |
| Chunk metadata | C4 | ✓ 明文 | R2 key（路徑結構可能洩漏 account/conversation 關聯） |

## 資料存留風險

| 位置 | 風險 | 建議 |
|------|------|------|
| D1 `messages_secure` | 密文持久儲存，若未來加密被破解可解密 | 設定 TTL 或定期清理 |
| D1 `message_key_vault` | 加密的金鑰持久儲存 | 同上 |
| R2 media chunks | 加密 chunks 持久儲存 | 同上 |
| localStorage `contactSecrets-v2` | 登出後殘留 | 登出時明確清除 |
| sessionStorage | 瀏覽器崩潰時可能殘留 | 依賴瀏覽器清理 |
| D1 `opaque_registrations` | OPAQUE 記錄持久儲存 | 低風險（OPAQUE 設計可公開） |
| Server logs (Cloudflare) | ⚠️ 待確認：是否記錄 API request body | 應僅記錄路由和狀態碼 |

## 伺服器理論上不應看見但需確認的資料

| 資料 | 宣稱 | 需確認 |
|------|------|--------|
| 訊息明文 | 不可見 | ✓ 已確認（envelope 為密文） |
| 媒體明文 | 不可見 | ✓ 已確認（per-chunk 加密） |
| 密碼 | 不可見 | ✓ 已確認（OPAQUE 保護） |
| Master Key | 不可見 | ✓ 已確認（wrapped blob，Argon2id 保護） |
| Device Private Keys | 不可見 | ✓ 已確認（wrapped blob，MK 保護） |
| 頭像圖片 | ⚠️ 待確認 | 需檢查上傳流程是否加密 |
| 群組成員列表 | 可見 | ✓ `conversation_acl` 表為明文 |
| 聯絡人列表 | ✅ 已緩解 | `contacts` 表已透過 Zero-Meta 0-A 隱藏 `peer_digest`（改用不可逆 slot_id）。`invite_dropbox` 表仍可推知邀請關係 |
| 通話時長 | 可見 | WebSocket signaling timestamps 可推算 |
| 訊息是否已讀 | 可見 | ⚠️ 需確認 receipt 機制 |
