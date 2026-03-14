# Message Lifecycle Security

> 基於 repo 程式碼掃描。追蹤一則訊息從發送到接收的完整安全生命週期。

## 1. 發送端生命週期

```
使用者輸入明文
    │
    ▼
┌─── Step 1: DR State 查找 ───┐
│ 從 contact-secrets 取得      │
│ per-conversation DR state    │
│ (rk, ckS, Ns, myRatchetKey) │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 2: Chain Key 推進 ──┐
│ KDF_CK(ckS)                 │
│ = HKDF(ckS, 'dr-ck',        │
│         'chain', 64B)        │
│ → message_key (前32B)        │
│ → next_ckS (後32B)          │
│ Ns += 1                     │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 3: 加密 ────────────┐
│ iv = crypto.getRandomValues   │
│       (new Uint8Array(12))    │
│                               │
│ aad = `v:1;d:{deviceId};     │
│        c:{Ns}`                │
│                               │
│ ciphertext = AES-256-GCM(    │
│   message_key, iv,            │
│   plaintext, aad)             │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 4: 封裝 ────────────┐
│ envelope = {                  │
│   aead: 'aes-256-gcm',       │
│   header: {                   │
│     dr: 1, v: 1,             │
│     device_id, ek_pub_b64,   │
│     pn: PN, n: Ns            │
│   },                          │
│   iv_b64, ciphertext_b64     │
│ }                             │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 5: 傳輸 ────────────┐
│ WebSocket:                    │
│ {                             │
│   type: 'secure-message',    │
│   conversationId,             │
│   deviceId,                   │
│   counter: Ns,                │
│   envelope: b64(envelope),    │
│   ts: Date.now(),             │
│   senderAccountDigest         │
│ }                             │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 6: Vault 儲存 ──────┐
│ vaultPut({                    │
│   conversationId,             │
│   messageId,                  │
│   senderDeviceId,             │
│   targetDeviceId,             │
│   direction: 'outgoing',     │
│   messageKeyB64,              │
│   headerCounter: Ns           │
│ })                            │
│                               │
│ → HKDF(MK, 'message-key/v1')│
│ → AES-GCM wrap              │
│ → PUT /api/v1/vault/put     │
└──────────────────────────────┘
```

- 來源：`shared/crypto/dr.js:382-502`（drEncryptText）

## 2. 伺服器端處理

```
WebSocket Durable Object
    │
    ├── 驗證 sender authenticated
    │
    ├── 寫入 D1 messages_secure:
    │     { id, conversation_id, sender_digest, counter,
    │       device_id, envelope, ts, header_counter }
    │
    ├── 查找 conversation_acl:
    │     取得所有參與者 account_digest
    │
    ├── 對每個參與者:
    │     ├── 查找 presence KV
    │     ├── 若在線 → 透過 WebSocket relay 轉發
    │     └── 若離線 → 訊息已儲存在 D1，待下次上線 catch-up
    │
    └── 回應 sender: { ok: true, messageId }
```

**伺服器可見資料**：
- `conversation_id`、`sender_digest`、`counter`、`ts`、`device_id` — 明文
- `envelope` — 密文（伺服器無法解密）

**伺服器不可見資料**：
- 訊息明文內容
- Message key
- DR state

來源：`data-worker/src/worker.js`、`data-worker/src/account-ws.js`

## 3. 接收端生命週期

```
WebSocket 收到 secure-message
    │
    ▼
┌─── Step 1: 解析 envelope ───┐
│ 解 base64 → JSON            │
│ 提取 header, iv, ciphertext │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 2: DH Ratchet 檢查 ─┐
│ if header.ek_pub !=          │
│    state.theirRatchetPub:    │
│                               │
│   保存 skipped keys          │
│   DH = X25519(myRatchetPriv, │
│              their_new_ek)    │
│   (rk, ckR) = KDF_RK(rk, DH)│
│   theirRatchetPub = ek_pub   │
│   Nr = 0                     │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 3: Chain Key 推進 ──┐
│ while Nr < header.n:         │
│   KDF_CK(ckR) →             │
│     skip_key + next_ckR      │
│   儲存 skip_key 至 cache     │
│   Nr += 1                    │
│                               │
│ KDF_CK(ckR) →               │
│   message_key + next_ckR     │
│ Nr += 1                      │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 4: 解密 ────────────┐
│ 重建 aad =                   │
│   `v:{v};d:{device_id};     │
│    c:{n}`                    │
│                               │
│ plaintext = AES-256-GCM      │
│   .decrypt(message_key,      │
│            iv, ciphertext,   │
│            aad)              │
│                               │
│ ✗ 失敗 → 直接拒絕（無重試） │
│ ✓ 成功 → 繼續               │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 5: State 快照 ──────┐
│ 快照 DR state 供 rollback    │
│ (解密前已保存，Lines 576-590)│
│ 成功後更新至新 state         │
└──────────────┬───────────────┘
               │
               ▼
┌─── Step 6: Vault 儲存 ──────┐
│ vaultPut({                    │
│   direction: 'incoming',     │
│   messageKeyB64,              │
│   headerCounter               │
│ })                            │
│ + 可選 DR state snapshot     │
└──────────────┬───────────────┘
               │
               ▼
       UI 顯示明文
```

- 來源：`shared/crypto/dr.js:504-800+`（drDecryptText）

## 4. Skipped Keys 管理

### 4.1 為什麼需要 Skipped Keys

訊息可能亂序到達（例如 n=5 在 n=3 之前到達）。DR 協議需要推進 chain key 到正確位置，中間的 message key 必須保存以便稍後解密。

### 4.2 實作細節

```
Skipped Keys Store:
  Map<chainId, Map<messageIndex, keyB64>>

  chainId = 由 ratchet public key 衍生
  messageIndex = header.n
  keyB64 = base64(message_key)

  最大容量: 100 keys per chain
  使用後: 立即刪除（take-and-delete）
```

- 來源：`shared/crypto/dr.js:128-156`

### 4.3 安全考量

- 若 message index gap 過大（>100），中間的 keys 可能被丟棄
- 已使用的 skipped key 立即刪除，防止重放
- ⚠️ 總體 skipped key 數量上限需確認（可能成為記憶體攻擊向量）

## 5. 離線訊息處理

### 5.1 接收方離線

```
1. 發送方發送訊息 → 伺服器寫入 D1
2. 接收方上線 → catch-up:
   GET /api/v1/messages/list?conversation_id=...&after_counter=...
3. 伺服器回傳遺漏訊息（含 envelope）
4. 客戶端依序解密
```

### 5.2 Gap Detection

- 客戶端追蹤每個 conversation 的 `lastSeenCounter`
- 偵測到 gap 時觸發 gap-fill 請求
- 來源：`features/messages-flow/gap-queue.js`

### 5.3 B Route (Live Decrypt)

- 進階的 live decrypt 路徑已實作但預設關閉（`USE_MESSAGES_FLOW_LIVE=false`）
- 來源：`features/messages-flow/live/coordinator.js`

## 6. 歷史訊息回放

### 6.1 回放流程

```
使用者捲動至舊訊息
    │
    ▼
GET /api/v1/messages/list (含 includeKeys=true)
    │
    ▼
伺服器回傳 messages + wrapped_keys
    │
    ▼
┌─── 金鑰取得優先順序 ────────┐
│ 1. 伺服器附帶的 wrapped key │
│    → HKDF(MK) + AES-GCM    │
│    → message_key             │
│                               │
│ 2. 本地 LRU cache（400）    │
│                               │
│ 3. API GET /vault/get       │
│    (可由 networkFallback     │
│     flag 關閉)               │
└──────────────┬───────────────┘
               │
               ▼
AES-256-GCM.decrypt(message_key, iv, ciphertext, aad)
    │
    ▼
顯示明文
```

- 來源：`features/message-key-vault.js:315-640`

### 6.2 Vault 自我修復

- 解封失敗時自動刪除損壞的 vault entry
- 記錄修復動作至 forensics log
- 來源：`features/message-key-vault.js:547-562`

## 7. 臨時訊息生命週期

臨時對話的訊息使用不同的加密路徑：

```
Guest / Owner
    │
    ├── Ephemeral X3DH session（一次性金鑰交換）
    │
    ├── DR Encrypt/Decrypt（同一般訊息）
    │
    ├── 伺服器暫存：
    │     Durable Object 記憶體（最多 50 則，5 分鐘 TTL）
    │     ⚠️ 不寫入 D1 messages_secure
    │
    ├── Session 到期 → 自動銷毀
    │     → 伺服器清除所有暫存
    │     → 客戶端清除 sessionStorage
    │
    └── 無 Message Key Vault（歷史不可回放）
```

- 來源：`data-worker/src/account-ws.js`（ephemeral buffer）、`app/ui/ephemeral-ui.js`

## 8. 安全性質摘要

| 性質 | 狀態 | 說明 |
|------|------|------|
| 端對端加密 | ✓ | 伺服器僅見密文 |
| 前向保密 | 部分 | DR 提供，但 vault 降低效果 |
| 後向保密 | ✓ | DH ratchet 更新後，舊金鑰無法推導新金鑰 |
| 抗重放 | ✓ | Counter + AAD 驗證 |
| 抗重排序 | ✓ | Counter 在 AAD 中，篡改 counter 導致 GCM 驗證失敗 |
| 抗降級 | ✓ | 嚴格安全政策，無 fallback |
| 可否認性 | 部分 | DR 設計提供，但 vault 保留 message key 可能影響 |
| 亂序容忍 | ✓ | Skipped keys cache（最多 100/chain） |

## 9. 已知問題

1. ⚠️ **Send-side ratchet 停用**：`dr.js:357-364` 中 send-side ratchet 更新被註解掉，表示發送方的 ephemeral key 不在每次發送時輪替，降低了前向保密的粒度
2. ⚠️ **Skipped keys 無總數上限**：可能被惡意 peer 利用產生大量 skipped keys 消耗記憶體
3. ⚠️ **Vault 降低前向保密**：message key 儲存在 vault 中，若 MK 洩漏則歷史訊息可被解密
4. ⚠️ **B Route 預設關閉**：live decrypt 路徑關閉可能導致離線後 catch-up 使用 legacy 邏輯
5. ⚠️ **Debug 日誌含金鑰雜湊**：`dr.js` 多處輸出金鑰 hash 值，生產環境應審查是否停用
