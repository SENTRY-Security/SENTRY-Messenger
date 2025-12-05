# Topup System API 規格（訂閱延展憑證）

目標：前端掃描儲值系統簽發的延展憑證（QR/NFC），每次掃碼都向 Portal 驗證與消耗，確保「一次性 / 可追蹤 / 不可重放」。不記錄 UID，僅使用 `digest`（64 hex）。

## 簽章與憑證格式

- 演算法：Ed25519
- 公鑰管理：依 `key_id` 由 Portal 取得對應公鑰；儲值系統固定使用 `key_id = "v1"`（如需輪轉，新增 `v2`、`v3`…）。
- 憑證 payload：
  ```json
  {
    "token_id": "uuid-string",          // 憑證唯一 ID（必須唯一）
    "digest": "HEX64",                  // 帳號 digest
    "issued_at": 1719999999,            // UNIX 秒
    "extend_days": 30,                  // 要增加的天數（整數），延展方式為 max(expires_at, now) + extend_days*86400
    "nonce": "random-string",           // 任意隨機字串，加強唯一性
    "key_id": "v1"                      // 公鑰版本
  }
  ```
- 簽章內容：`"${token_id}.${digest}.${issued_at}.${extend_days}.${nonce}"` 以 UTF-8 串接後用 Ed25519 簽章，輸出 base64，放在 `signature_b64`。

## API 鑑權

- 呼叫 Portal API 時，以 `X-Portal-HMAC` 驗證：`HMAC-SHA256(PORTAL_HMAC_SECRET, path + "\n" + body)`；`Content-Type: application/json`。
- Portal 需驗證 HMAC，時戳不需額外欄位（已有 `valid_until` 控制）。

## API 介面

### 1) POST `/api/v1/subscription/redeem`

- Body：
  ```json
  {
    "payload": { ...payload 上述欄位 ... },
    "signature_b64": "base64",
    "dryRun": false
  }
  ```
- 流程：
  1. 驗 HMAC。
  2. 驗簽 `signature_b64`（依 `key_id` 取公鑰），比對 payload.digest 與 token_id 格式。
  3. 查 tokens 表：若 `token_id` 狀態為 `used/invalid` → 回覆對應錯誤。
  4. `dryRun=true`：僅回驗證結果，不寫入、不中斷重放防護（token 仍維持原狀態）。
  5. `dryRun=false`：原子操作：
     - 計算 `base = max(current_expires_at, now)`；`new_expires_at = base + extend_days*86400`；更新/建立 `subscriptions.expires_at = new_expires_at`。
     - tokens 標記 `status=used`、`used_at=now`、`used_by_digest=payload.digest`，並寫入 `extend_logs`（記錄 extend_days 與 new_expires_at）。
- 回應：
  ```json
  {
    "status": "ok | used | invalid",
    "expires_at": 1722595599,   // 更新後到期時間
    "added_days": 30,           // 此次實際增加的天數（同 extend_days）
    "used_at": 1720000000,      // 若為 used
    "token_id": "uuid-string",
    "message": "描述（可選）"
  }
  ```
- 錯誤碼要求：400 BadRequest（格式/簽章錯誤）、401 Unauthorized（HMAC 驗證失敗）、409 Conflict（token 已用）、410 Gone（token 無效或被撤銷）、429 Too Many Requests（風控）。

### 2) GET `/api/v1/subscription/status?digest=HEX64&limit=50`

- 回應：
  ```json
  {
    "digest": "HEX64",
    "expires_at": 1722595599,
    "logs": [
      {
        "token_id": "uuid-string",
        "extend_days": 30,
        "expires_at_after": 1722595599,
        "used_at": 1720000000,
        "status": "used | expired | invalid",
        "issued_at": 1719999999,
        "valid_until": 1720003599,
        "key_id": "v1"
      }
    ]
  }
  ```
- `limit` 預設 50，最大 200，按 `used_at DESC`。

### 3) POST `/api/v1/subscription/validate`（可選）

- 與 `redeem` 相同 Body，但強制 `dryRun=true`，回傳同樣的結果，只做驗簽與狀態檢查，不消耗 token。

## Portal 側資料表（要求）

- `subscriptions(digest PK, expires_at INTEGER, updated_at INTEGER, created_at INTEGER)`
- `tokens(token_id PK, digest, issued_at, extend_days, nonce, key_id, signature_b64, status TEXT, used_at, used_by_digest, created_at)`
- `extend_logs(id PK AUTOINC, token_id FK, digest, extend_days, expires_at_after, used_at, created_at)`
- `status` 僅允許：`issued, used, invalid`
- token_id UNIQUE，`used_at`/`used_by_digest` 填寫於 redeem。

## 前端 / Node 串接要點

- 掃碼後呼叫 `/subscription/redeem`（或先 `/validate` 再 `/redeem`），以 Portal 回應為準，不依賴本地狀態。
- 若回 `used/expired/invalid`，提示並不要更新本地 expires_at。
- 歷史列表用 `/subscription/status`。

## 安全防護

- 必須驗簽；token_id 必須唯一；憑證生成後若需撤銷請改寫 `status=invalid` 並阻擋使用。
- 所有寫入操作在 Portal 端原子完成，前端不得自行寫狀態。
- HMAC 秘密僅存於我們的後端，不外泄到前端。  
