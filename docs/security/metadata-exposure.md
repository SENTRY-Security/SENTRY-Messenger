# Metadata Exposure Analysis

> 基於 repo 程式碼掃描。分析伺服器、儲存、網路觀察者各自可見的 metadata。

## 1. 伺服器可見 Metadata

### 1.1 通訊 Metadata

| Metadata | 可見位置 | 影響 |
|----------|----------|------|
| 發送者 `account_digest` | `messages_secure.sender_digest` | 伺服器知道誰發送了訊息 |
| 接收者 `account_digest` | `conversation_acl` 表 | 伺服器知道對話參與者 |
| `conversation_id` | `messages_secure.conversation_id` | 伺服器知道訊息屬於哪個對話 |
| 訊息 `counter` | `messages_secure.counter` | 伺服器知道訊息序號 |
| 訊息 `timestamp` | `messages_secure.ts` | 伺服器知道精確發送時間 |
| 訊息 `device_id` | `messages_secure.device_id` | 伺服器知道發送裝置 |
| 訊息大小 | `envelope` 欄位大小 | 伺服器可推測訊息長度 |
| DR header | `header_counter`, `ek_pub` 在 envelope 中 | ⚠️ 待確認：header 是否在密文外 |

### 1.2 聯絡人 / 社交圖譜

| Metadata | 可見位置 | 影響 |
|----------|----------|------|
| 對話參與者 | `conversation_acl` | 伺服器知道誰與誰建立了對話 |
| 群組成員 | `conversation_acl` (role) | 伺服器知道群組成員和角色 |
| 邀請關係 | `invite_dropbox` 表 | 伺服器知道誰邀請了誰 |
| 邀請狀態 | `invite_dropbox.status` | 伺服器知道邀請是否被接受 |
| 帳號建立時間 | `accounts.created_at` | 伺服器知道帳號年齡 |

### 1.3 媒體 Metadata

| Metadata | 可見位置 | 影響 |
|----------|----------|------|
| 檔案大小 | R2 object size | 伺服器知道媒體大致大小 |
| Chunk 數量 | R2 objects per upload | 伺服器知道檔案被分成幾個 chunks |
| 上傳/下載時間 | R2 access logs | 伺服器知道媒體存取時間 |
| 媒體類型 (`content_type`) | `sign-put-chunked` API request | 伺服器在上傳簽名請求中可見 content_type |
| 檔案大小（精確） | `sign-put-chunked` API request `total_size` | 伺服器在上傳簽名請求中可見精確大小 |
| 檔案名稱 | 在加密 manifest 中（伺服器不可見） | ✓ 已保護 |
| 上傳方向 | `sign-put-chunked` API request `direction` | 伺服器知道是發送還是接收 |

### 1.4 通話 Metadata

| Metadata | 可見位置 | 影響 |
|----------|----------|------|
| 通話發起/接收 | WebSocket signaling | 伺服器知道誰打給誰 |
| 通話時長 | signaling timestamps | 可推算通話持續時間 |
| 通話類型 | `call-invite` payload | 伺服器知道是語音或視訊 |
| ICE candidates | signaling relay | 伺服器可見 IP 位址 |
| TURN usage | TURN credentials | 伺服器知道是否使用 relay |

### 1.5 臨時對話 Metadata

| Metadata | 可見位置 | 影響 |
|----------|----------|------|
| Owner identity | `ephemeral_sessions.owner_digest` | 伺服器知道 Owner |
| Guest identity | `ephemeral_sessions.guest_digest` | 伺服器知道 Guest（臨時 ID） |
| Session 時長 | `created_at`, `expires_at` | 伺服器知道對話持續時間 |
| 延長次數 | `extended_count` | 伺服器知道是否延長 |
| 連結是否被使用 | `consumed_at` | 伺服器知道連結何時被開啟 |

### 1.6 Message Key Vault Metadata

| Metadata | 可見位置 | 影響 |
|----------|----------|------|
| `conversationId` | `wrap_context` (明文) | 伺服器知道對話 ID |
| `messageId` | `wrap_context` (明文) | 伺服器知道訊息 ID |
| `senderDeviceId` | `wrap_context` (明文) | 伺服器知道發送裝置 |
| `targetDeviceId` | `wrap_context` (明文) | 伺服器知道接收裝置 |
| `direction` | `wrap_context` (明文) | 伺服器知道訊息方向 |
| `msgType` | `wrap_context` (明文) | 伺服器知道訊息類型（text/media） |
| `headerCounter` | `wrap_context` (明文) | 伺服器知道 DR counter |
| `createdAt` | `wrap_context` (明文) | 伺服器知道時間戳 |

- 來源：`features/message-key-vault.js:194`
- 注意：`wrap_context` 以明文傳送至伺服器用於索引/查詢，`wrapped_mk` 本身為密文

## 2. 儲存層可推知的資訊

### D1 Database

- **通訊頻率**：`messages_secure` 表中的時間戳分佈
- **通訊量**：每個 conversation 的訊息數量
- **活躍度**：帳號最後活動時間
- **社交圖譜**：`conversation_acl` 表的完整關係網
- **群組結構**：群組大小、角色分佈

### R2 Object Storage

- **媒體使用量**：每個帳號的儲存空間使用
- **媒體類型推測**：基於 chunk 數量和大小（影片通常更大、更多 chunks）
- **存取模式**：下載頻率可推測訊息重要性

### KV Store

- **Session 活躍度**：token 建立/刷新頻率
- **登入頻率**：session 建立時間戳

## 3. 網路觀察者可見資訊

假設 TLS 正確實作，外部網路觀察者可見：

| 資訊 | 可否觀察 | 說明 |
|------|----------|------|
| 連線目標 | ✓ | 所有流量指向 Cloudflare CDN（不直接暴露後端） |
| 連線時間 | ✓ | 可推測使用者何時在線 |
| 流量模式 | ✓ | 可區分訊息（小封包）vs 媒體（大封包）vs 通話（持續流量） |
| WebSocket 心跳 | ✓ | 可推測使用者是否在線 |
| WebRTC 流量 | ✓ | P2P 通話時可能暴露雙方 IP |
| TURN 流量 | ✓ | 經由 Cloudflare TURN relay |
| 訊息內容 | ✗ | TLS 加密 |
| API payload | ✗ | TLS 加密 |

### WebRTC 特殊考量

- **P2P 連線**：ICE 候選可能包含使用者真實 IP
- **TURN relay**：若使用 TURN，對方只看到 TURN server IP
- **signaling**：經由 WebSocket relay，但 ICE candidates 可能包含 `host` 類型候選（local IP）
- **⚠️ 待確認**：是否僅使用 relay candidates 以避免 IP 洩漏

## 4. 現有緩解措施

| 風險 | 緩解 | 狀態 |
|------|------|------|
| IP 暴露 | Cloudflare CDN 代理所有 HTTP/WS 流量 | ✓ 已實作 |
| 訊息大小洩漏 | ⚠️ 無 padding 機制 | ✗ 未實作 |
| 時間模式 | ⚠️ 無 timing obfuscation | ✗ 未實作 |
| Cover traffic | ⚠️ 無噪音流量 | ✗ 未實作 |
| 社交圖譜 | ⚠️ ACL 表為明文 | ✗ 無緩解 |
| 通話 IP | TURN relay 選項 | 部分實作 |

## 5. 尚未解決的風險

1. **社交圖譜完全暴露**：`conversation_acl` 表明確記錄所有對話關係，伺服器可建立完整社交圖譜
2. **通訊模式分析**：訊息 timestamp 和 counter 允許伺服器分析通訊頻率、活躍時段
3. **媒體使用推測**：R2 中的 chunk 數量和大小可推測是否傳送了圖片/影片/大檔案
4. **WebRTC IP 洩漏**：P2P 通話可能暴露使用者真實 IP（若未強制使用 TURN relay）
5. **訊息大小洩漏**：無 padding，密文大小直接反映明文大小
6. **即時線上狀態**：WebSocket 連線存活即表示使用者在線
7. **群組成員資格**：伺服器完全可見
