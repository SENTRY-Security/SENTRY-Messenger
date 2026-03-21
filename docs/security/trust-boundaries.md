# Trust Boundaries

> 基於 repo 程式碼實際掃描。所有斷言可回溯至具體檔案。

## 邊界圖

```
┌─────────────────────────────────────────────────────────────────────┐
│                    TRUST ZONE 1: 客戶端（完全信任）                    │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  明文資料     │  │  金鑰材料     │  │  加密/解密引擎            │  │
│  │              │  │              │  │                          │  │
│  │ • 訊息明文   │  │ • MK (記憶體) │  │ • DR encrypt/decrypt    │  │
│  │ • 媒體明文   │  │ • IK/SPK/OPK │  │ • AEAD (AES-GCM)        │  │
│  │ • 通話媒體   │  │   私鑰(記憶體)│  │ • HKDF key derivation   │  │
│  │ • 密碼       │  │ • DR state   │  │ • Argon2id (password)   │  │
│  │              │  │ • Message Key│  │ • X3DH initiate/respond │  │
│  │              │  │ • Call E2EE  │  │ • InsertableStreams      │  │
│  │              │  │   key        │  │                          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  本地儲存     │  │  WebRTC      │  │  UI / 瀏覽器              │  │
│  │              │  │              │  │                          │  │
│  │ • IndexedDB  │  │ • DTLS/SRTP  │  │ • DOM rendering         │  │
│  │ • sessionStor│  │ • ICE 候選   │  │ • Input handling        │  │
│  │ • localStorage│ │ • 媒體軌道   │  │ • File API              │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                     ════════╪════════  TRUST BOUNDARY: TLS 傳輸層
                             │
┌────────────────────────────┴────────────────────────────────────────┐
│              TRUST ZONE 2: 傳輸層（條件信任）                         │
│                                                                     │
│  • HTTPS/WSS (TLS 1.3)                                             │
│  • Cloudflare Edge Network                                         │
│  • TURN Relay (Cloudflare)                                         │
│  • 假設：TLS 正確實作且未被降級                                       │
│  • 假設：Cloudflare 不主動篡改流量                                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                     ════════╪════════  TRUST BOUNDARY: 密文邊界
                             │
┌────────────────────────────┴────────────────────────────────────────┐
│              TRUST ZONE 3: 伺服器端（不信任內容）                      │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ Workers API   │  │ Durable Obj  │  │  D1 Database             │  │
│  │              │  │              │  │                          │  │
│  │ • 路由請求   │  │ • WS 連線管理│  │ • accounts (digest)      │  │
│  │ • ACL 檢查   │  │ • 訊息轉發   │  │ • messages_secure        │  │
│  │ • Counter 驗 │  │ • 存活偵測   │  │   (envelope=密文)        │  │
│  │   證         │  │ • 緩衝佇列   │  │ • prekey_bundles (公鑰)  │  │
│  │ • SDM 驗證   │  │              │  │ • dev_keys_backup(密文)  │  │
│  │ • OPAQUE     │  │              │  │ • message_key_vault      │  │
│  │   server     │  │              │  │   (加密 key blob)        │  │
│  └──────────────┘  └──────────────┘  │ • conversation_acl       │  │
│                                      │ • ephemeral_sessions     │  │
│  ┌──────────────┐  ┌──────────────┐  │ • opaque_registrations   │  │
│  │ R2 Storage   │  │ KV Store     │  └──────────────────────────┘  │
│  │              │  │              │                                 │
│  │ • 加密chunks │  │ • Session    │                                 │
│  │ • 加密媒體   │  │   tokens     │                                 │
│  │ (密文blob)   │  │ • Rate limit │                                 │
│  └──────────────┘  └──────────────┘                                 │
└─────────────────────────────────────────────────────────────────────┘
```

## 各邊界資料分類

### 邊界 1→2（客戶端 → 傳輸層）

| 資料 | 狀態 | 說明 |
|------|------|------|
| 訊息 | 密文 | DR 加密後的 envelope（header + iv + ciphertext） |
| 媒體 | 密文 | Per-chunk AES-256-GCM 加密 blob |
| 通話媒體 | 密文 | InsertableStreams AES-GCM per-frame 加密 |
| Prekey Bundle | 公鑰 | 僅公開金鑰部分（ik_pub, spk_pub, opks[].pub） |
| 認證令牌 | 明文 | account_token 在 HTTP header 中（TLS 保護） |
| OPAQUE KE 訊息 | 協議保護 | OPAQUE 保護下的金鑰交換訊息 |
| SDM 參數 | 明文 | UID、CMAC、counter（TLS 保護） |
| Wrapped MK | 密文 | Argon2id + AES-GCM 保護的 MK blob |

### 邊界 2→3（傳輸層 → 伺服器）

與上述相同 — TLS 終止於 Cloudflare Edge，Worker 可見 TLS 內層。

**關鍵觀察**：Cloudflare Workers 運行在 Cloudflare 的隔離沙箱中。Worker 程式碼是專案自有的，但 Cloudflare 作為基礎設施提供者理論上可存取 Worker 記憶體。此為對 Cloudflare 的信任依賴。

## 各區域可見/不可見資料

### 伺服器可見

| 資料 | 可見位置 | 來源 |
|------|----------|------|
| `account_digest` | HTTP headers, D1 | `web/src/app/api/account.js` |
| `device_id` | HTTP headers, D1 | `web/src/app/core/store.js` |
| `conversation_id` | API payload, D1 | Message routing |
| `counter` (message序號) | `messages_secure.counter` | Server-side validation |
| `timestamp` | `messages_secure.ts` | Message metadata |
| `envelope` (密文) | `messages_secure.envelope` | 加密後的 DR 封包 |
| `media_chunks` (密文) | R2 | 加密後的 chunk blob |
| `prekey_bundle` (公鑰) | D1 `prekey_bundles` | X3DH 公開部分 |
| `wrapped_mk` (密文) | API response | Argon2id 保護的 MK blob |
| `opaque_registration` | D1 | OPAQUE 註冊記錄 |
| NFC UID + CMAC | API request | SDM 交換 |
| WebSocket 連線元資料 | Durable Objects | 連線/斷線時間、IP |
| Call signaling | WebSocket relay | offer/answer/ICE candidates |
| Ephemeral session metadata | D1 | session_id, expires_at, guest_digest |

### 伺服器不可見（設計意圖）

| 資料 | 保護機制 | 程式碼位置 |
|------|----------|-----------|
| 訊息明文 | DR E2EE | `shared/crypto/dr.js` |
| 媒體明文 | Per-chunk AES-256-GCM | `features/chunked-upload.js` |
| 通話音視訊 | InsertableStreams | `features/calls/key-manager.js` |
| Master Key | 僅客戶端記憶體 | `app/core/store.js` _MK_RAW |
| Device Private Keys | 僅客戶端記憶體 | `app/core/store.js` _DEVICE_PRIV |
| 使用者密碼 | OPAQUE PAKE | `features/opaque.js` |
| DR State | 僅客戶端 | `features/dr-session.js` |

## 提升權限風險點

### 1. XSS → 完全金鑰存取

- **路徑**：若攻擊者可在應用頁面執行 JavaScript，可讀取記憶體中的 `_MK_RAW`、`_DEVICE_PRIV`、所有 DR state
- **影響**：完全破解 E2EE
- **緩解**：CSP headers（`web/src/_headers`）、HTML escaping
- **風險等級**：高
- **位置**：`web/src/app/core/store.js:29-30`（變數定義）

### 2. 伺服器 → Prekey MITM

- **路徑**：伺服器替換使用者的 Prekey Bundle，將自己插入為中間人
- **影響**：可解密後續所有訊息
- **緩解**：⚠️ 目前無緩解機制
- **風險等級**：中（需要主動攻擊，非被動）
- **位置**：`features/login-flow.js`（prekey publish）、`data-worker/src/worker.js`（prekey fetch）

### 3. Wrapped MK 離線破解

- **路徑**：取得 `wrapped_mk` blob（伺服器可見），嘗試暴力破解密碼
- **影響**：若密碼弱，可取得 MK → 解密 device keys → 解密 vault keys → 解密訊息
- **緩解**：Argon2id (m=64MiB, t=3, p=1)
- **風險等級**：中（取決於密碼強度）
- **位置**：`web/src/app/crypto/kdf.js`

### 4. Session Token 竊取

- **路徑**：XSS 竊取 `x-account-token` header → 冒充使用者呼叫 API
- **影響**：可以使用者身份操作（但無法解密訊息，因為無 MK）
- **緩解**：應改用 httpOnly cookie（⚠️ 目前未實作）
- **風險等級**：中
- **位置**：`web/src/app/core/http.js`、`web/src/app/api/account.js`
