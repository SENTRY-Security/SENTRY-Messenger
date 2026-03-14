# Media & Attachment Security

> 基於 repo 程式碼掃描。分析媒體檔案從選擇到傳輸、儲存、下載的完整安全流程。

## 1. 上傳流程

### 1.1 檔案處理

```
使用者選擇檔案
    │
    ├── 格式偵測
    │     ├── 影片 → WebCodecs 轉碼至 720p H.264 fMP4
    │     │          → segment-aligned chunking
    │     └── 非影片 → 直接 byte-range chunking
    │
    ├── Chunk 分割
    │     ├── Byte-range: 固定 5MB chunks
    │     └── Segment-aligned: fMP4 segment 邊界
    │
    └── Per-chunk 加密 + 上傳
```

- 來源：`features/chunked-upload.js`

### 1.2 Per-Chunk 加密

每個 chunk 獨立加密，使用不同的 HKDF salt 和 IV：

```
Per Chunk:
    salt = crypto.getRandomValues(new Uint8Array(16))   // 16 bytes
    key  = HKDF-SHA256(MK, salt, 'media/chunk-v1')      // 256 bit
    iv   = crypto.getRandomValues(new Uint8Array(12))   // 12 bytes

    encrypted_chunk = AES-256-GCM(key, iv, chunk_data)
    // 無 AAD
```

| 參數 | 值 | 說明 |
|------|-----|------|
| 演算法 | AES-256-GCM | 認證加密 |
| 金鑰衍生 | HKDF-SHA256(MK, salt, 'media/chunk-v1') | 每 chunk 獨立金鑰 |
| Salt | 16 bytes random | Per-chunk unique |
| IV | 12 bytes random | Per-chunk unique |
| AAD | 無 | ⚠️ 不含 chunk index 或其他 context |
| Info Tag | `'media/chunk-v1'` | AEAD 白名單中的合法 tag |

- 來源：`features/chunked-upload.js:276-293`

### 1.3 Manifest 格式

manifest 記錄所有 chunk 的 metadata，本身也被加密：

```json
{
  "v": 3,
  "segment_aligned": false,
  "chunkSize": 5242880,
  "totalSize": 15728640,
  "totalChunks": 3,
  "contentType": "image/jpeg",
  "name": "photo.jpg",
  "chunks": [
    {
      "index": 0,
      "size": 5242880,
      "cipher_size": 5242896,
      "iv_b64": "...",
      "salt_b64": "...",
      "trackIndex": 0
    }
  ],
  "tracks": [{ "type": "muxed", "codec": "jpeg" }],
  "duration": 0
}
```

### 1.4 Manifest 加密

```
manifest_json = JSON.stringify(manifest)

salt = crypto.getRandomValues(new Uint8Array(16))
key  = HKDF-SHA256(MK, salt, 'media/manifest-v1')
iv   = crypto.getRandomValues(new Uint8Array(12))

manifest_ct = AES-256-GCM(key, iv, manifest_json)
```

**Manifest Envelope**（隨訊息傳送）：

```json
{
  "v": 3,
  "aead": "aes-256-gcm",
  "iv_b64": "...",
  "hkdf_salt_b64": "...",
  "info_tag": "media/manifest-v1",
  "key_type": "mk"
}
```

- `key_type: 'mk'` — 使用 Master Key 衍生解密金鑰
- `key_type: 'shared'` — 使用 envelope 中的 `key_b64`（用於共享場景）
- 來源：`features/chunked-upload.js:1031-1053`

### 1.5 目錄路徑雜湊

儲存路徑透過 HMAC-SHA256 迭代衍生，防止伺服器推知檔案結構：

```
token_0 = HMAC-SHA256(MK, 'drive-dir:' + root_token + ':' + segment_0)
token_1 = HMAC-SHA256(MK, 'drive-dir:' + token_0 + ':' + segment_1)
...
path = hex(token_N)[0:32]
```

- 來源：`features/chunked-upload.js:60-80`

## 2. 上傳安全機制

### 2.1 Presigned URL

- 每個 chunk 透過 API 取得 presigned URL
- chunk 數量預先配置
- 來源：`features/chunked-upload.js`

### 2.2 上傳重試

| 參數 | 值 |
|------|-----|
| 超時 | 120 秒/chunk |
| 重試次數 | 最多 2 次 |
| 重試條件 | timeout 或 network error |

- 來源：`features/chunked-upload.js:132-133`

### 2.3 自適應並發

上傳使用 AIMD（Additive Increase Multiplicative Decrease）控制並發：

- 成功 → 並發 +1
- 失敗 → 並發 /2
- 避免過度使用網路頻寬

## 3. 下載流程

### 3.1 Manifest 下載與解密

```
1. GET /api/v1/media/manifest-url → presigned URL
2. Fetch manifest (ciphertext)
3. Decrypt:
   key = HKDF-SHA256(MK, manifest_envelope.hkdf_salt_b64, 'media/manifest-v1')
   manifest = AES-256-GCM.decrypt(key, iv, manifest_ct)
4. Parse JSON → chunk list
```

### 3.2 Chunk 下載與解密

```
Per Chunk:
    1. GET /api/v1/media/chunk-urls (batch of 20)
    2. Fetch encrypted chunk
    3. key = HKDF-SHA256(resolve_key, chunk.salt_b64, 'media/chunk-v1')
    4. plaintext = AES-256-GCM.decrypt(key, chunk.iv, chunk_ct)
    5. Yield plaintext chunk (有序)
```

### 3.3 下載安全參數

| 參數 | 值 |
|------|-----|
| 超時 | 30 秒/chunk |
| 重試次數 | 最多 3 次 |
| 重試退避 | 指數退避（最高 8 秒） |
| 並發 | AIMD: floor=3, ceiling=12, initial=6 |
| URL 批次 | 20 chunks/request |
| 預取 | 下載當前批次時預取下批 URL |

- 來源：`features/chunked-download.js`

## 4. 金鑰解析

下載時根據 `key_type` 決定解密金鑰：

| key_type | 金鑰來源 | 使用場景 |
|----------|----------|----------|
| `'mk'`（預設） | Master Key from store | 一般媒體 |
| `'shared'` | `manifestEnvelope.key_b64` | 共享或臨時對話媒體 |

- 來源：`features/chunked-download.js:32-44`

## 5. 儲存安全

### 5.1 R2 物件安全

| 屬性 | 狀態 |
|------|------|
| 加密 at rest | ✓ Per-chunk AES-256-GCM |
| 加密 in transit | ✓ TLS |
| 存取控制 | Presigned URL（時限） |
| 伺服器可讀 | ✗ 僅見密文 |

### 5.2 伺服器可推知資訊

| 資訊 | 可推知？ | 說明 |
|------|----------|------|
| 檔案大小 | ✓ | R2 object 總大小 |
| Chunk 數量 | ✓ | R2 objects per upload |
| 媒體類型 | 部分 | 影片通常更多 chunks，更大 |
| 檔案名稱 | ✗ | 在加密 manifest 中 |
| MIME type | ✗ | 在加密 manifest 中 |
| 存取時間 | ✓ | R2 access logs |
| 上傳者 | ✓ | API 認證資訊 |

## 6. 影片特殊處理

### 6.1 轉碼

- 使用 WebCodecs API
- 目標：720p H.264 fMP4
- 客戶端完成（伺服器不接觸原始影片）

### 6.2 Segment-Aligned Chunking

fMP4 影片使用 segment-aligned chunking（而非固定 5MB byte-range）：

```json
{
  "segment_aligned": true,
  "chunkSize": 0,
  "tracks": [
    { "type": "video", "codec": "avc1.42E01E" },
    { "type": "audio", "codec": "mp4a.40.2" }
  ]
}
```

- 每個 segment 獨立可解密（支援 streaming playback）
- Track index 記錄於 chunk metadata

## 7. 安全分析

### 7.1 優點

1. **Per-chunk 獨立加密**：每個 chunk 使用獨立 HKDF salt + random IV，一個 chunk 的 key 洩漏不影響其他 chunks
2. **Manifest 加密**：metadata（檔案名稱、類型、大小）在加密 manifest 中，伺服器不可見
3. **客戶端轉碼**：影片轉碼在客戶端完成，伺服器不接觸原始媒體
4. **目錄路徑雜湊**：HMAC 衍生路徑防止伺服器推知檔案結構
5. **Presigned URL**：限時存取，防止未授權下載

### 7.2 已知問題

1. ⚠️ **無 Chunk AAD**：chunk 加密不使用 AAD（無 chunk index binding），理論上 chunk 可被替換或重新排列（manifest integrity 提供間接保護）
2. ⚠️ **Manifest 無獨立簽章**：manifest 依賴 AES-GCM auth tag 驗證完整性，無額外的數位簽章
3. ⚠️ **Chunk 大小洩漏**：每個 chunk 的密文大小可推知明文大小（GCM overhead 固定 16 bytes）
4. ⚠️ **所有 chunks 使用同一 MK 衍生**：若 MK 洩漏，所有媒體可被解密
5. ⚠️ **頭像加密待確認**：使用者頭像是否經過加密上傳需確認
6. ⚠️ **上傳時序可推知通訊行為**：R2 寫入時間與訊息時間可關聯
