# Key Management

> 基於 repo 程式碼實際掃描。所有金鑰類型、用途、儲存位置均可回溯至具體檔案。

## 金鑰種類盤點

### 1. Master Key (MK)

| 屬性 | 值 |
|------|-----|
| **用途** | 保護 Device Private Keys 的 KEK（Key Encryption Key） |
| **產生** | `crypto.getRandomValues(new Uint8Array(32))` — 32 bytes 隨機 |
| **儲存** | 客戶端記憶體 (`store.js:_MK_RAW`)，wrapped blob 在伺服器 |
| **保護** | Argon2id (m=64MiB, t=3, p=1) + AES-256-GCM wrapping |
| **生命週期** | 帳號建立時產生，密碼變更時重新 wrap |
| **輪替** | 無自動輪替機制 |
| **撤銷** | 無明確撤銷機制 |
| **程式碼** | `app/crypto/kdf.js:75-89`（wrap）、`app/crypto/kdf.js:35-73`（unwrap） |
| **備份** | Wrapped blob 儲存在伺服器 `/api/v1/mk/store` |

**Wrapped MK Blob 格式**：
```json
{
  "v": 1,
  "kdf": "argon2id",
  "m": 64,
  "t": 3,
  "p": 1,
  "salt_b64": "<16 bytes base64>",
  "iv_b64": "<12 bytes base64>",
  "ct_b64": "<32 bytes encrypted MK base64>"
}
```

### 2. Identity Key (IK)

| 屬性 | 值 |
|------|-----|
| **用途** | X3DH 長期身份金鑰，用於簽章 SPK |
| **演算法** | Ed25519（簽章）/ X25519（DH，via libsodium `crypto_sign_ed25519_pk_to_curve25519` 轉換） |
| **產生** | `sodium.crypto_sign_keypair()`（libsodium-wrappers-sumo） |
| **儲存** | 私鑰：客戶端記憶體 + MK-wrapped blob on server |
| **儲存** | 公鑰：D1 `prekey_bundles.ik_pub` |
| **生命週期** | 裝置建立時產生，理論上永久 |
| **輪替** | ⚠️ 無觀察到的 IK 輪替機制 |
| **程式碼** | `shared/crypto/prekeys.js`（generateInitialBundle） |

### 3. Signed Prekey (SPK)

| 屬性 | 值 |
|------|-----|
| **用途** | X3DH 簽名預金鑰，用於非同步金鑰交換 |
| **演算法** | X25519（DH） |
| **產生** | `sodium.crypto_box_keypair()` + IK 簽章（libsodium） |
| **簽章** | Ed25519 sign(SPK_pub, IK_priv) |
| **儲存** | 私鑰：客戶端記憶體 + MK-wrapped blob |
| **儲存** | 公鑰 + 簽章：D1 `prekey_bundles.spk_pub`, `spk_sig` |
| **輪替** | ⚠️ 無觀察到的 SPK 定期輪替機制 |
| **程式碼** | `shared/crypto/prekeys.js` |

### 4. One-Time Prekeys (OPKs)

| 屬性 | 值 |
|------|-----|
| **用途** | X3DH 一次性預金鑰，每次 session 建立消耗一個 |
| **演算法** | X25519（DH） |
| **產生** | `sodium.crypto_box_keypair()`（libsodium），初始 50 個，用完補充 |
| **儲存** | 私鑰：客戶端 MK-wrapped blob（`opk_priv_map`） |
| **儲存** | 公鑰：D1 `prekey_bundles.opks`（JSON 陣列） |
| **消耗** | 每次 X3DH session 建立消耗一個 OPK |
| **補充** | Login 時檢查剩餘數量，不足時補充並 republish |
| **程式碼** | `shared/crypto/prekeys.js`（generateOpksFrom） |
| **追蹤** | `next_opk_id` 單調遞增 |

### 5. Double Ratchet State

| 屬性 | 值 |
|------|-----|
| **用途** | 維護 per-conversation 的加密狀態 |
| **包含** | `rk`（Root Key）、`ckS`（Send Chain Key）、`ckR`（Receive Chain Key）、ratchet keypair、counters |
| **產生** | X3DH 完成後初始化 |
| **儲存** | 客戶端記憶體 + 持久化快照 |
| **輪替** | 每次 DH ratchet（收到新 ephemeral key 時）自動輪替 |
| **程式碼** | `shared/crypto/dr.js`（drEncryptText, drDecryptText） |

**DR State 結構**：
```
{
  rk: Uint8Array(32),           // Root Key
  ckS: Uint8Array(32),          // Send Chain Key
  ckR: Uint8Array(32) | null,   // Receive Chain Key
  Ns: number,                    // Send counter
  Nr: number,                    // Receive counter
  PN: number,                    // Previous send counter
  myRatchetPriv: Uint8Array(32), // Current ephemeral private key
  myRatchetPub: Uint8Array(32),  // Current ephemeral public key
  theirRatchetPub: Uint8Array(32) | null, // Peer's ephemeral key
  skippedKeys: Map              // Out-of-order message key cache
}
```

### 6. Message Keys

| 屬性 | 值 |
|------|-----|
| **用途** | 個別訊息的對稱加密金鑰 |
| **演算法** | AES-256-GCM |
| **產生** | KDF_CK: HKDF-SHA256(chain_key) → split 64 bytes → (message_key, next_chain_key) |
| **儲存** | Message Key Vault（加密後儲存在 D1） |
| **生命週期** | 使用後持久化至 vault 以供歷史訊息回放 |
| **程式碼** | `shared/crypto/dr.js`（kdfCK） |

### 7. Media Chunk Key

| 屬性 | 值 |
|------|-----|
| **用途** | 媒體檔案 per-chunk 加密金鑰 |
| **演算法** | AES-256-GCM |
| **產生** | HKDF-SHA256(file_key, chunk_index) — ⚠️ 待確認具體衍生邏輯 |
| **儲存** | 金鑰資訊在 manifest 中（manifest 加密為訊息的一部分） |
| **生命週期** | 上傳完成後，金鑰保留在 manifest 中 |
| **程式碼** | `features/chunked-upload.js` |

### 8. Call E2EE Key

| 屬性 | 值 |
|------|-----|
| **用途** | 通話媒體 per-frame 加密金鑰 |
| **演算法** | AES-GCM with counter-based nonce |
| **產生** | HKDF from shared DR secret — ⚠️ 待確認具體衍生機制 |
| **儲存** | 客戶端記憶體 |
| **輪替** | 每 10 分鐘自動輪換 |
| **程式碼** | `features/calls/key-manager.js` |

### 9. Invite Dropbox Key

| 屬性 | 值 |
|------|-----|
| **用途** | 加密聯絡人邀請資料（invite dropbox envelope） |
| **演算法** | X25519 ECDH → HKDF-SHA256 → AES-256-GCM |
| **產生** | 每次邀請產生 ephemeral X25519 keypair，與 owner 公鑰 ECDH |
| **HKDF info tag** | `'contact-init/dropbox/v1'` |
| **IV** | 12 bytes random |
| **金鑰驗證** | 要求 32 bytes（X25519 標準） |
| **程式碼** | `app/crypto/invite-dropbox.js` |

### 10. Contact Backup Key

| 屬性 | 值 |
|------|-----|
| **用途** | 加密聯絡人備份（contact-secrets snapshot） |
| **演算法** | HKDF-SHA256(MK, 'contact-storage-v1') → AES-256-GCM |
| **產生** | 從 Master Key 衍生 |
| **IV** | 12 bytes random per backup |
| **儲存格式** | `iv_b64:ct_b64` |
| **程式碼** | `features/contact-backup.js:762-778` |

### 11. Contact Slot Key

| 屬性 | 值 |
|------|-----|
| **用途** | 計算聯絡人的不可逆 slot_id，隱藏 peer_digest 不讓伺服器知道聯絡人關係 |
| **演算法** | HMAC-SHA256 |
| **產生** | HKDF-SHA256(MK, 'contact-slot-v1') → 256-bit HMAC key |
| **slot_id 計算** | `HMAC-SHA256(slot_key, peer_digest.toUpperCase())` → base64url |
| **儲存** | 僅客戶端記憶體（每次使用時從 MK 即時衍生，不持久化） |
| **特性** | 確定性（同一 MK + 同一 peer → 同一 slot_id）；不可逆（伺服器無法從 slot_id 反推 peer_digest） |
| **程式碼** | `features/contacts.js`（`deriveContactSlotKey`, `deriveContactSlotId`） |

### 12. Group Shared Key

| 屬性 | 值 |
|------|-----|
| **用途** | 群組訊息加密（所有成員共用同一金鑰） |
| **產生** | `crypto.getRandomValues(32 bytes)` → `deriveConversationContextFromSecret()` |
| **分發** | 建立群組時分發給所有成員 |
| **特性** | 所有成員持有相同金鑰，無 per-device 區分 |
| **程式碼** | `features/groups.js:67-100` |

## 金鑰傳遞方式

```
                    Password
                       │
                   Argon2id
                       │
                      KEK ──────── wrap/unwrap ──── MK (Master Key)
                                                     │
                                            HKDF + AES-GCM
                                                     │
                                              Device Private
                                              ┌──────┴──────┐
                                              │              │
                                          IK (Ed25519)   SPK (X25519)
                                              │              │
                                         Sign(SPK)     X3DH DH
                                              │              │
                                              └──────┬───────┘
                                                     │
                                                   X3DH
                                                     │
                                          ┌──── Root Key ────┐
                                          │                   │
                                    Send Chain Key      Receive Chain Key
                                          │                   │
                                    KDF_CK                KDF_CK
                                          │                   │
                                    Message Key          Message Key
                                          │                   │
                                    AES-GCM              AES-GCM
                                    Encrypt              Decrypt
```

## 金鑰儲存位置總覽

| 金鑰 | 客戶端記憶體 | sessionStorage | localStorage | 伺服器 D1 | 伺服器 R2 |
|------|-------------|---------------|-------------|-----------|-----------|
| MK (明文) | ✓ | ✗ | ✗ | ✗ | ✗ |
| MK (wrapped) | ✓ | ✗ | ✗ | ✓ | ✗ |
| IK private | ✓ | ✗ | ✗ | ✗ (in wrapped blob) | ✗ |
| IK public | ✓ | ✗ | ✗ | ✓ | ✗ |
| SPK private | ✓ | ✗ | ✗ | ✗ (in wrapped blob) | ✗ |
| SPK public | ✓ | ✗ | ✗ | ✓ | ✗ |
| OPK privates | ✓ | ✗ | ✗ | ✗ (in wrapped blob) | ✗ |
| OPK publics | ✗ | ✗ | ✗ | ✓ | ✗ |
| DR state | ✓ | ✗ | ✗ (contact-secrets) | ✗ | ✗ |
| Message keys | 暫存 | ✗ | ✗ | ✓ (vault, encrypted) | ✗ |
| Call keys | ✓ | ✗ | ✗ | ✗ | ✗ |
| Media keys | 暫存 | ✗ | ✗ | ✗ (in encrypted manifest) | ✗ |
| Contact slot key | ✓ (即時衍生) | ✗ | ✗ | ✗ | ✗ |

## 裝置更換影響

| 場景 | 影響 | 恢復機制 |
|------|------|----------|
| 同裝置重新登入 | MK unwrap → device keys restore → DR state 從 contact-secrets 恢復 | 正常流程 |
| 新裝置（有備份） | 從伺服器取得 wrapped blob → unwrap with password | Contact secrets backup restore |
| 新裝置（無備份） | 生成新 IK/SPK/OPKs → 所有現有 DR session 需重建 | 對方需重新建立 session |
| 密碼變更 | MK 不變，重新 wrap MK with 新密碼衍生的 KEK | 所有既有金鑰保持不變 |
| NFC 卡遺失 | ⚠️ 無法登入（SDM 認證失敗） | ⚠️ 無自助恢復機制 |

## 待確認與未完整實作

1. ⚠️ **IK 輪替**：目前無觀察到的 IK 定期輪替機制。Signal 協議建議定期輪替
2. ⚠️ **SPK 輪替**：目前無觀察到的 SPK 定期輪替機制。Signal 協議建議每 1-7 天輪替
3. ⚠️ **Skipped Key 限制**：DR skipped message key cache 的最大容量需確認
4. ⚠️ **Message Key Vault 加密方式**：vault 中的 `encrypted_key_blob` 使用何種金鑰加密需確認
5. ⚠️ **Contact Secrets 加密**：localStorage 中的聯絡人快照的加密金鑰衍生方式需確認
6. ⚠️ **Call Key 衍生**：通話金鑰如何從 DR shared secret 衍生需確認
7. ⚠️ **Multi-device DR session sync**：目前假設單裝置，多裝置場景下 DR state 不同步
