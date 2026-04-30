# Protocol Overview

> 基於 repo 程式碼掃描。描述系統各協議的實際實作狀態。

## 1. 註冊流程

### 1.1 NFC SDM 交換

```
NFC Card (NTAG424 DNA)          Client                      Server
───────────────────             ──────                      ──────
       │ 使用者觸碰 NFC          │                           │
       │──── UID + CMAC ───────▶│                           │
       │     + counter           │                           │
       │                         │── POST /auth/sdm/exchange─▶│
       │                         │   { uid, sdmmac,          │
       │                         │     sdmcounter, nonce }   │
       │                         │                           │── CMAC 驗證
       │                         │                           │── Counter 檢查
       │                         │◀── { session, has_mk,  ───│
       │                         │     wrapped_mk,           │
       │                         │     account_token,        │
       │                         │     account_digest }      │
```

- 來源：`features/sdm.js:27-43`（URL 解析）、`features/login-flow.js:193-241`（exchange）
- `session` 為一次性 token（~60 秒有效）
- `account_digest` 為 UID 的 HMAC 衍生
- SDM 驗證在伺服器端完成（`worker.js`）

### 1.2 OPAQUE 註冊

```
Client                                              Server
──────                                              ──────
  │── OPAQUE RegistrationRequest ──────────────────▶│
  │   POST /auth/opaque/register-init               │
  │   { account_digest, client_request }             │
  │                                                  │
  │◀── OPAQUE RegistrationResponse ─────────────────│
  │                                                  │
  │── client.registerFinish(response) ──────────────▶│
  │   POST /auth/opaque/register-finish              │
  │   { account_digest, registration_record }        │
  │                                                  │── 儲存 registration
  │◀── { ok: true } ───────────────────────────────│     record 至 D1
```

- 來源：`features/opaque.js:38-70`
- 使用 `@cloudflare/opaque-ts@0.7.5`（CDN 載入 + SRI）
- 密碼永遠不離開客戶端

### 1.3 Master Key 建立

```
Client                                              Server
──────                                              ──────
  │ 產生 MK = crypto.getRandomValues(32 bytes)       │
  │                                                  │
  │ KEK = Argon2id(password, random_salt)             │
  │ wrapped_mk = AES-GCM(KEK, IV, MK)               │
  │                                                  │
  │── POST /mk/store ──────────────────────────────▶│
  │   { session, wrapped_mk_blob }                   │── 儲存 blob
  │                                                  │
  │◀── { ok: true } ───────────────────────────────│
```

- 來源：`app/crypto/kdf.js:75-89`、`features/login-flow.js:397-420`

### 1.4 Device Key 建立

```
Client                                              Server
──────                                              ──────
  │ 產生 IK = Ed25519 keypair                        │
  │ 產生 SPK = X25519 keypair                        │
  │ SPK_sig = Ed25519.sign(SPK_pub, IK_priv)         │
  │ 產生 50x OPK = X25519 keypairs                   │
  │                                                  │
  │── POST /prekeys/publish ───────────────────────▶│
  │   { ik_pub, spk_pub, spk_sig, opks[] }          │── 儲存 prekey bundle
  │                                                  │
  │ wrapped_dev = HKDF(MK) + AES-GCM(device_priv)   │
  │                                                  │
  │── POST /devkeys/store ─────────────────────────▶│
  │   { wrapped_blob }                               │── 儲存 encrypted blob
  │                                                  │
  │◀── { ok: true } ───────────────────────────────│
```

- 來源：`features/login-flow.js:459-626`、`shared/crypto/prekeys.js`

## 2. 登入流程

```
1. SDM Exchange (同註冊 1.1)
   → 取得 account_token, account_digest, wrapped_mk

2. OPAQUE Login
   Client                                          Server
   ──────                                          ──────
     │── client.authInit(password) ─────────────▶│
     │   POST /auth/opaque/login-init            │
     │   { account_digest, KE1 }                 │
     │                                            │
     │◀── { KE2 } ──────────────────────────────│
     │                                            │
     │── client.authFinish(KE2) ────────────────▶│
     │   POST /auth/opaque/login-finish          │
     │   { account_digest, KE3 }                 │
     │                                            │── 驗證 KE3
     │◀── { session_key_b64 } ──────────────────│

3. MK Unwrap
   wrapped_mk → Argon2id(password, salt) → KEK → AES-GCM decrypt → MK

4. Device Key Restore
   POST /devkeys/fetch → wrapped_blob → HKDF(MK) + AES-GCM → device_priv
   → 檢查/補充 OPKs → POST /prekeys/publish (if needed)
```

- 來源：`features/login-flow.js:193-636`

## 3. Session 建立 (X3DH)

```
Alice (initiator)                                   Bob (responder)
─────────────────                                   ───────────────
  │── 取得 Bob 的 Prekey Bundle ────────────────────│
  │   { ik_pub, spk_pub, spk_sig, opk }            │
  │                                                  │
  │ 驗證 spk_sig (Ed25519 verify)                    │
  │                                                  │
  │ 生成 ephemeral keypair (ek)                      │
  │                                                  │
  │ DH1 = X25519(IK_priv_A, SPK_pub_B)              │
  │ DH2 = X25519(EK_priv, IK_pub_B)                 │
  │ DH3 = X25519(EK_priv, SPK_pub_B)                │
  │ DH4 = X25519(EK_priv, OPK_pub_B)                │
  │                                                  │
  │ SK = HKDF(DH1 || DH2 || DH3 || DH4)             │
  │ → 初始化 DR state: rk=SK, ckS=..., ckR=null     │
  │                                                  │
  │── 首則訊息 + { ik_pub_A, ek_pub, opk_id } ─────▶│
  │                                                  │
  │                                                  │ DH1 = X25519(SPK_priv_B, IK_pub_A)
  │                                                  │ DH2 = X25519(IK_priv_B, EK_pub)
  │                                                  │ DH3 = X25519(SPK_priv_B, EK_pub)
  │                                                  │ DH4 = X25519(OPK_priv_B, EK_pub)
  │                                                  │
  │                                                  │ SK = HKDF(DH1 || DH2 || DH3 || DH4)
  │                                                  │ → 初始化 DR state
```

- 來源：`shared/crypto/dr.js`（x3dhInitiate, x3dhRespond）

## 4. 訊息收送

### 4.1 訊息加密（發送）

```
plaintext
  │
  ├── 如果需要 DH ratchet:
  │     生成新 ephemeral keypair
  │     DH = X25519(new_ek_priv, their_ratchet_pub)
  │     (rk, ckS) = KDF_RK(rk, DH)
  │
  ├── KDF_CK(ckS) → (message_key, next_ckS)
  │     ckS = next_ckS
  │     Ns += 1
  │
  ├── iv = crypto.getRandomValues(12 bytes)
  │
  ├── aad = buildDrAad({ version, deviceId, counter: Ns })
  │
  └── ciphertext = AES-GCM(message_key, iv, plaintext, aad)

  → { header: { dr:1, v, device_id, ek_pub_b64, pn, n }, iv_b64, ciphertext_b64 }
```

- 來源：`shared/crypto/dr.js` drEncryptText

### 4.2 訊息解密（接收）

```
{ header, iv_b64, ciphertext_b64 }
  │
  ├── 如果 header.ek_pub != state.theirRatchetPub:
  │     DH ratchet（接收側）
  │     保存 skipped keys
  │
  ├── 如果 header.n < state.Nr:
  │     嘗試 skipped key cache
  │     若無 cache → 拒絕（重放或亂序）
  │
  ├── KDF_CK 推進至 header.n
  │     中間 keys 加入 skipped cache
  │
  ├── 重建 aad
  │
  └── plaintext = AES-GCM.decrypt(message_key, iv, ciphertext, aad)

  ✓ 解密成功 → vaultPut(message_key) 供歷史回放
  ✗ 解密失敗 → 直接失敗（無 fallback/retry）
```

- 來源：`shared/crypto/dr.js` drDecryptText

## 5. 附件 / 媒體處理

```
使用者選擇檔案
  │
  ├── 格式偵測
  │     ├── 影片 → WebCodecs 轉碼至 720p H.264 fMP4
  │     └── 非影片 → 直接處理
  │
  ├── 分 chunk（⚠️ chunk 大小待確認）
  │
  ├── Per-chunk 加密:
  │     chunk_key = HKDF(file_key, chunk_info_tag)
  │     chunk_iv = random 12 bytes
  │     encrypted_chunk = AES-256-GCM(chunk_key, chunk_iv, chunk_data)
  │
  ├── 上傳 encrypted chunks 至 R2
  │     POST /media/upload-chunk (presigned URL)
  │
  ├── 產生 manifest:
  │     { chunks: [{ url, iv, ... }], total_size, ... }
  │
  └── manifest 作為訊息內容經 DR 加密發送
```

- 來源：`features/chunked-upload.js`、`features/chunked-download.js`

## 6. WebRTC 通話

```
Caller                     Signaling (WebSocket)              Callee
──────                     ─────────────────────              ──────
  │── call-invite ─────────────────────────────────────────▶│
  │◀──────────────────────────────────────── call-accept ───│
  │                                                          │
  │── SDP offer + ICE ─────────────────────────────────────▶│
  │◀───────────────────────────────── SDP answer + ICE ─────│
  │                                                          │
  │◀═══════════════════ DTLS/SRTP ════════════════════════▶│
  │                                                          │
  │    InsertableStreams E2EE:                                │
  │    frame → AES-GCM(call_key, counter_nonce, frame) →    │
  │    encrypted frame via SRTP                              │
  │                                                          │
  │    Key rotation: every 1 minute                          │
  │    Nonce: counter-based (防重放)                          │
```

- 來源：`features/calls/media-session.js`、`features/calls/key-manager.js`

## 7. 版本控制與相容性

### 7.1 DR Envelope Version

- **目前版本**：`v: 1`（`header.v` 欄位）
- **AAD 包含版本**：`buildDrAad({ version })` — version mismatch 導致解密失敗
- 來源：`shared/crypto/dr.js`

### 7.2 Wrapped MK Blob Version

- **目前版本**：`v: 1`
- **格式**：`{ v:1, kdf:'argon2id', m, t, p, salt_b64, iv_b64, ct_b64 }`
- 來源：`app/crypto/kdf.js`

### 7.3 Message Key Vault

- ⚠️ vault entry 格式版本待確認

### 7.4 媒體 Manifest

- **目前版本**：v3（README 中提及）
- ⚠️ manifest 具體結構待從 chunked-upload.js 確認

## 8. 自訂協議 / Envelope 格式

### 8.1 DR Encrypted Packet

```json
{
  "aead": "aes-256-gcm",
  "header": {
    "dr": 1,
    "v": 1,
    "device_id": "uuid",
    "ek_pub_b64": "base64(ephemeral_public_key)",
    "pn": 0,
    "n": 42
  },
  "iv_b64": "base64(12_bytes)",
  "ciphertext_b64": "base64(encrypted_data)",
  "message_key_b64": "base64(32_bytes)"
}
```

- `dr: 1` — Double Ratchet 版本
- `v: 1` — AAD version
- `pn` — Previous send counter
- `n` — Current send counter
- `message_key_b64` — ⚠️ 待確認：是否在傳輸中包含或僅用於 vault

### 8.2 WebSocket Message Envelope

```json
{
  "type": "secure-message",
  "conversationId": "uuid",
  "deviceId": "uuid",
  "counter": 42,
  "envelope": "base64(DR_encrypted_packet)",
  "ts": 1710000000000,
  "senderAccountDigest": "hex"
}
```

### 8.3 Ephemeral Message Envelope

```json
{
  "type": "ephemeral-message",
  "conversationId": "uuid",
  "header": { "counter": 1, "deviceId": "eph-xxx", "version": 1 },
  "iv_b64": "base64",
  "ciphertext_b64": "base64",
  "ts": 1710000000000
}
```

## 9. 協議缺口

1. ⚠️ 缺乏正式協議規格文件（目前僅有實作，無獨立 spec）
2. ⚠️ 自訂 DR 實作未經第三方審計
3. ⚠️ AAD 結構的確切二進位格式需要明確文件化
4. ⚠️ 媒體 manifest 格式需要正式文件化
5. ⚠️ Key Vault 加密方式需要正式文件化
6. ⚠️ 群組訊息加密模型（是否為 N 個 pairwise DR session）需確認
7. ✅ ~~密碼學原語使用未審計函式庫（TweetNaCl + 手刻 ed2curve）~~ — 已替換為 `libsodium-wrappers-sumo`（經多家安全公司審計），Ed25519→X25519 轉換改用 libsodium 內建函式
