# Security Architecture

> 基於 repo 程式碼掃描。描述系統整體安全架構，包括加密層、信任邊界、資料流。

## 1. 架構總覽

```
┌───────────────────────────────────────────────────────────────┐
│                       Client (Browser)                        │
│                                                               │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Crypto Layer │  │  App Logic   │  │   UI / DOM           │ │
│  │             │  │              │  │                      │ │
│  │ • dr.js     │  │ • login-flow │  │ • plaintext render   │ │
│  │ • aead.js   │  │ • store.js   │  │ • media display      │ │
│  │ • ed2curve  │  │ • vault.js   │  │ • call UI            │ │
│  │ • prekeys   │  │ • contacts   │  │                      │ │
│  │ • kdf.js    │  │ • messages   │  │                      │ │
│  └──────┬──────┘  └──────┬───────┘  └──────────────────────┘ │
│         │                │                                     │
│         └────────┬───────┘                                     │
│                  │                                             │
│     ┌────────────┴────────────┐                                │
│     │  WebCrypto API          │                                │
│     │  (AES-GCM, HKDF,       │                                │
│     │   HMAC, SHA-256)        │                                │
│     └─────────────────────────┘                                │
│     ┌────────────────────────┐                                 │
│     │  TweetNaCl.js          │                                 │
│     │  (Ed25519, X25519,     │                                 │
│     │   nacl.box)            │                                 │
│     └────────────────────────┘                                 │
└───────────────────────┬───────────────────────────────────────┘
                        │ TLS 1.2+
                        │
┌───────────────────────┴───────────────────────────────────────┐
│                 Cloudflare Edge (CDN/Proxy)                    │
│  • TLS 終端                                                    │
│  • Pages (靜態資源)                                             │
│  • Workers (API 路由)                                           │
│  • Durable Objects (WebSocket relay)                           │
└───────────────────────┬───────────────────────────────────────┘
                        │
┌───────────────────────┴───────────────────────────────────────┐
│                    Storage Layer                               │
│  ┌──────┐  ┌──────┐  ┌──────┐  ┌───────────────┐             │
│  │  D1  │  │  R2  │  │  KV  │  │ Durable Objects│             │
│  │ (SQL)│  │(Blob)│  │(K/V) │  │ (State/WS)     │             │
│  └──────┘  └──────┘  └──────┘  └───────────────┘             │
└───────────────────────────────────────────────────────────────┘
```

## 2. 加密層架構

### 2.1 密碼學函式庫

| 函式庫 | 用途 | 來源 |
|--------|------|------|
| WebCrypto API | AES-GCM, HKDF-SHA256, HMAC-SHA256, SHA-256 | 瀏覽器原生 |
| TweetNaCl.js | Ed25519 簽章, X25519 DH, nacl.box | `tweetnacl` npm |
| `@nicolo-ribaudo/cheetah-argon2` | Argon2id KDF | CDN + SRI |
| `@cloudflare/opaque-ts@0.7.5` | OPAQUE PAKE | CDN + SRI |
| 自訂 `ed2curve.js` | Ed25519 → X25519 轉換 | `shared/crypto/ed2curve.js` |

### 2.2 加密操作矩陣

| 操作 | 演算法 | 金鑰大小 | IV/Nonce | AAD | 來源 |
|------|--------|----------|----------|-----|------|
| 訊息加密 | AES-256-GCM | 256 bit | 12 bytes random | `v:1;d:{deviceId};c:{counter}` | `dr.js` |
| MK Wrapping | AES-256-GCM | 256 bit (Argon2id) | 12 bytes random | 無 | `kdf.js` |
| Device Key Wrapping | AES-256-GCM | HKDF(MK) | 12 bytes random | 無 | `aead.js` |
| Media Chunk 加密 | AES-256-GCM | HKDF(MK, 'media/chunk-v1') | 12 bytes random | 無 | `chunked-upload.js` |
| Media Manifest 加密 | AES-256-GCM | HKDF(MK, 'media/manifest-v1') | 12 bytes random | 無 | `chunked-upload.js` |
| Call Frame 加密 | AES-GCM | HKDF(conv_token, direction) | Counter-based | 無 | `key-manager.js` |
| Vault Key Wrapping | AES-256-GCM | HKDF(MK, 'message-key/v1') | 12 bytes random | 無 | `message-key-vault.js` |
| Contact Secrets | AES-256-GCM | HKDF(MK, 'contact-secrets/backup/v1') | 12 bytes random | 無 | `aead.js` |

### 2.3 HKDF Info Tag 白名單

AEAD 模組限制 info tag 為以下固定清單（防止 tag 混淆攻擊）：

- `blob/v1` — 通用 blob 加密
- `media/v1` — 媒體通用
- `profile/v1` — 使用者 profile
- `settings/v1` — 設定
- `snapshot/v1` — 狀態快照
- `contact-secrets/backup/v1` — 聯絡人備份
- `devkeys/v1` — 裝置金鑰
- `contact/v1` — 聯絡人

來源：`shared/crypto/aead.js:33-42`

## 3. 身份與認證架構

```
NFC Card (NTAG424 DNA)
        │
        │ UID + CMAC + Counter
        ▼
┌─────────────────┐
│ SDM Exchange    │ ──── 一次性 session token (~60s)
│ (Worker 驗證)    │ ──── account_digest (HMAC(UID))
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ OPAQUE PAKE     │ ──── 密碼驗證（密碼不離開客戶端）
│ (login/register)│ ──── session_key
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ MK Unwrap       │ ──── Argon2id(password, salt) → KEK
│                 │ ──── AES-GCM.decrypt(KEK, wrapped_mk) → MK
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Device Keys     │ ──── HKDF(MK) + AES-GCM → unwrap device private keys
│ Restore         │ ──── IK, SPK, OPK privates
└─────────────────┘
```

- 來源：`features/login-flow.js`、`features/opaque.js`、`app/crypto/kdf.js`

## 4. 訊息加密架構

### 4.1 金鑰衍生鏈

```
X3DH (4× DH) ─── HKDF('x3dh-salt', 'x3dh-root', 64B)
                     │
                 Root Key (RK)
                     │
              KDF_RK(RK, DH_output) ─── HKDF(RK||DH, 'dr-rk', 'root', 64B)
                     │                         │
              New Root Key            Chain Key (CK)
                                           │
                                KDF_CK(CK) ─── HKDF(CK, 'dr-ck', 'chain', 64B)
                                       │              │
                                Message Key     Next Chain Key
                                    │
                              AES-256-GCM
                                    │
                              Ciphertext
```

### 4.2 AAD 格式

訊息加密的 AAD（Additional Authenticated Data）為字串格式：

```
v:{version};d:{deviceId};c:{counter}
```

- `version`：目前固定為 `1`
- `deviceId`：發送裝置 UUID
- `counter`：目前訊息序號（Ns）
- 來源：`shared/crypto/dr.js:44-65`

### 4.3 嚴格安全政策

DR 模組在檔案開頭宣告嚴格安全政策（`dr.js:1-15`）：

1. 解密失敗直接失敗，不 fallback
2. Counter mismatch 直接拒絕
3. 不降級協議
4. 不靜默恢復
5. 通話重置必須明確

## 5. 媒體安全架構

```
原始檔案
    │
    ├── 格式偵測 + 轉碼（影片 → 720p H.264 fMP4）
    │
    ├── 分 Chunk（5MB / byte-range 或 segment-aligned）
    │
    ├── Per-Chunk:
    │     salt = random(16 bytes)
    │     key = HKDF(MK, salt, 'media/chunk-v1')
    │     iv = random(12 bytes)
    │     encrypted = AES-256-GCM(key, iv, chunk)
    │
    ├── Upload encrypted chunks → R2 (presigned URL)
    │
    ├── Manifest:
    │     { v:3, chunks:[{index, size, cipher_size, iv_b64, salt_b64}],
    │       totalSize, contentType, name, tracks, duration }
    │
    ├── Manifest Encryption:
    │     salt = random(16 bytes)
    │     key = HKDF(MK, salt, 'media/manifest-v1')
    │     iv = random(12 bytes)
    │     manifest_ct = AES-256-GCM(key, iv, manifest_json)
    │
    └── manifest_envelope 作為訊息內容經 DR 加密發送
```

- 目錄路徑透過 HMAC-SHA256 迭代衍生（防止伺服器推知檔案結構）
- 來源：`features/chunked-upload.js`、`features/chunked-download.js`

## 6. 通話安全架構

```
Conversation Token (from contact secrets)
        │
        HKDF('call-master-key:{callId}:{epoch}', random_salt, 512bit)
        │
    Call Master Key (CMK)
        │
        ├── HMAC-SHA256(CMK, '{callId}:{epoch}') → cmkProof（防竄改）
        │
        ├── HKDF(CMK, 'call-audio-tx:caller', 256bit) → audioTxKey
        ├── HKDF(CMK, 'call-audio-tx:callee', 256bit) → audioRxKey
        ├── HKDF(CMK, 'call-video-tx:caller', 256bit) → videoTxKey
        ├── HKDF(CMK, 'call-video-tx:callee', 256bit) → videoRxKey
        │
        ├── HKDF(CMK, 'call-audio-nonce:caller', 96bit) → audioTxNonce
        ├── HKDF(CMK, 'call-video-nonce:caller', 96bit) → videoTxNonce
        └── ...
```

- Caller / Callee 方向性金鑰（防止雙向金鑰重用）
- cmkProof 在解密前驗證（防竄改 callId/epoch）
- Epoch 參數支援通話中金鑰輪換
- 來源：`features/calls/key-manager.js`

## 7. WebSocket 安全架構

### 7.1 認證流程

```
Client                          Worker                      Durable Object
──────                          ──────                      ──────────────
  │── GET /api/v1/ws/token ───▶│                              │
  │◀── { jwt } ────────────────│                              │
  │                             │                              │
  │── WebSocket upgrade ───────▶│── verify JWT ──────────────▶│
  │   (jwt in query/header)     │   set x-account-digest      │
  │                             │   set x-device-id            │
  │                             │   set x-session-ts           │
  │                             │                              │
  │◀══ WS connected ══════════════════════════════════════════│
  │                             │                              │
  │── { type: 'auth', token } ═══════════════════════════════▶│
  │                             │                   verify JWT │
  │                             │        store authenticated=true
  │◀══ { type: 'auth-ok' } ══════════════════════════════════│
```

### 7.2 安全限制

| 限制 | 值 | 來源 |
|------|-----|------|
| Signal JSON 大小上限 | 16 KB | `account-ws.js:23` |
| SDP JSON 大小上限 | 64 KB | `account-ws.js:25` |
| Signal 字串大小上限 | 4,096 bytes | `account-ws.js:27` |
| Ephemeral 緩衝上限 | 50 messages/conversation | `account-ws.js:29` |
| Ephemeral 緩衝 TTL | 5 minutes | `account-ws.js:31` |
| Presence TTL | 120 seconds | `account-ws.js` |

### 7.3 Stale Session 防護

- WebSocket 連線記錄 `sessionTs`（來自 JWT）
- 重新認證時比對 sessionTs，拒絕過期 session
- 同裝置重連時關閉舊連線
- 來源：`account-ws.js:559-591`

## 8. Message Key Vault 架構

```
DR 解密完成
    │
    ├── message_key + context（conversationId, messageId, direction, counter...）
    │
    ├── Wrap:
    │     key = HKDF(MK, salt, 'message-key/v1')
    │     blob = AES-256-GCM(key, iv, JSON{mk_b64, context})
    │
    ├── PUT /api/v1/vault/put
    │     { conversation_id, header_counter, encrypted_key_blob }
    │     + 可選 DR state snapshot（原子附帶）
    │
    └── 本地 LRU cache（400 entries）
```

**歷史訊息回放**：
1. 優先使用伺服器 listSecureMessages 附帶的 wrapped key（避免額外 API round-trip）
2. 其次查找本地 LRU cache
3. 最後 fallback 至 API GET /api/v1/vault/get

**自我修復**：解封失敗時自動刪除損壞的 vault entry（`message-key-vault.js:547-562`）

來源：`features/message-key-vault.js`

## 9. 安全設計原則

基於程式碼觀察到的設計原則：

1. **零知識伺服器**：伺服器僅儲存密文和公鑰，無法讀取訊息內容
2. **無 Fallback**：加密失敗直接失敗，不降級或靜默恢復
3. **金鑰隔離**：每個用途使用獨立的 HKDF info tag，防止金鑰混淆
4. **前向保密**：DR 鏈式金鑰衍生，過去的金鑰無法推導未來金鑰
5. **最小化記憶體留存**：金鑰盡可能僅存於記憶體，不持久化
6. **原子操作**：vault put 可原子附帶 DR state snapshot
7. **計數器保護**：AAD 包含 counter，防止訊息重排和重放

## 10. 架構弱點

1. ⚠️ **Send-side ratchet 停用**：`dr.js:357-364` 中 send-side ratchet 更新被註解，`myRatchetPriv`/`myRatchetPub` 不在發送時輪替
2. ⚠️ **自訂 JWT 驗證**：`account-ws.js` 使用自訂 JWT 驗證而非標準函式庫
3. ⚠️ **AEAD 無 AAD**：除 DR 訊息外，其他 AEAD 操作（blob、media、vault）不使用 AAD
4. ⚠️ **IV 重用風險**：12-byte random IV 依賴隨機不重複（HKDF salt 分散風險，但無明確追蹤）
5. ⚠️ **Manifest 無獨立簽章**：manifest 加密但無額外的完整性驗證（依賴 GCM 的 authentication tag）
6. ⚠️ **Debug 日誌輸出金鑰雜湊**：`dr.js` 在多處輸出金鑰的 hash 值（Lines 213-235, 305-330, 368-378）
7. ✅ ~~DR 狀態並發無 mutex~~ — 已有 `enqueueDrSessionOp()` 序列化機制（`dr-session.js:1546`），所有 encrypt/decrypt 操作均透過 queue 串行化
8. ⚠️ **Invite Dropbox 硬編碼 salt**：`invite-dropbox.js:6` 使用固定字串 `'invite-dropbox-salt'`，降低語義安全性
9. ⚠️ **Call key 零 salt**：`key-manager.js:25` 的 `ZERO_SALT = new Uint8Array(32)` 用於 HKDF 子金鑰衍生
