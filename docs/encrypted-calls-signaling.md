# Encrypted Voice / Video Call — 信令與狀態機設計

> 對應 README「Encrypted Voice / Video Call Roadmap」第二項。此文件描述行動版 PWA 與未來 iOS App 可共用的信令事件、狀態機與 API 規範，作為實作與測試依據。

## 1. 設計目標

1. **可靠性**：避免連點造成重複呼叫，提供互斥鎖與超時機制。
2. **多端一致**：Web（PWA）與 iOS App 共用同一套事件與 payload schema。
3. **可觀察性**：信令事件具備 `traceId` / `capabilities` 等欄位，以利除錯與版本控管。
4. **可擴充性**：預留多方通話、視訊切換、螢幕分享等未來需求。

## 2. 信令通道

| 通道 | 用途 | 備註 |
| ---- | ---- | ---- |
| WebSocket `/ws` | 前景信令、PWA 即時互動 | 現有連線新增 `type: 'call-*'` 事件 |
| Push（Web Push / APNs） | 背景/離線喚醒 | payload 僅傳遞 `callToken` + 摘要，詳細資料待前景連線補抓 |
| REST Fallback `/api/v1/calls/*` | WebSocket 阻斷時的補救 | 主要用於 `cancel` / `reject` 等關鍵操作 |

## 3. 事件與資料結構

所有事件 JSON 格式包含下列共通欄位：

```jsonc
{
  "type": "call-invite",
  "traceId": "uuid-v4",
  "version": 1,
  "from": "UID_HEX",
  "to": "UID_HEX",
  "callId": "uuid-v4",
  "capabilities": {
    "audio": true,
    "video": true,
    "screenshare": false,
    "platform": "web" // or ios
  },
  "ts": 1730956800000
}
```

### 3.1 事件清單

| 事件 | 描述 | 觸發方 |
| ---- | ---- | ------ |
| `call-invite` | 撥出方發起呼叫，包含媒體能力與預設模式（voice/video）。 | Caller |
| `call-ringing` | 接收方已顯示 UI，回報給撥出方。 | Callee |
| `call-accept` | 接收方接受呼叫，攜帶 `answer` 指紋與媒體設定。 | Callee |
| `call-reject` | 接收方拒接，附加原因（busy/decline/offline）。 | Callee |
| `call-cancel` | 撥出方在對方接聽前取消。 | Caller |
| `call-busy` | 接收方當前正通話，立即回應。 | Callee |
| `call-end` | 任何一方結束通話，攜帶 `reason`（hangup/network/error）。 | Either |
| `call-ice-candidate` | WebRTC ICE candidate 交換。 | Either |
| `call-media-update` | 切換語音/視訊/螢幕分享等能力。 | Either |
| `call-timeout` | 服務端判斷呼叫逾時（無人回應），主動通知雙方。 | Server |

### 3.2 錯誤碼

| 代碼 | 描述 |
| ---- | ---- |
| `CALL_ALREADY_IN_PROGRESS` | 任一方已有進行中的呼叫。 |
| `CALL_NOT_FOUND` | `callId` 無效或已結束。 |
| `CALL_CAPABILITY_MISMATCH` | 一方不支援要求的能力（例如視訊）。 |
| `CALL_PAYLOAD_INVALID` | schema 不符。 |

## 4. 狀態機

### 4.1 撥出方

```
IDLE
 └─[invite sent]→ DIALING
     ├─[call-ringing]→ RINGING
     ├─[call-accept]→ CONNECTING
     │   └─[media ready]→ IN_CALL
     ├─[call-reject/call-busy]→ ENDED
     ├─[timeout/ cancel]→ ENDED
     └─[network failure]→ RETRY (max 2) → ENDED
```

### 4.2 接收方

```
IDLE
 └─[call-invite]→ INCOMING
     ├─[user accepts]→ CONNECTING → IN_CALL
     ├─[user rejects]→ ENDED
     ├─[busy / auto-decline]→ ENDED
     └─[timeout (no action)]→ ENDED
```

### 4.3 互斥與鎖定

- 每個帳號同時間只能有 1 個 `callId` 處於 `DIALING/INCOMING/IN_CALL`。
- 伺服器於 `call-invite` 時寫入 Redis / D1 `call_sessions`，包含 `expiresAt`。
- 若接收方發出第二個 `call-invite`（例如雙開）→ 回應 `CALL_ALREADY_IN_PROGRESS`。

## 5. 超時與重試策略

| 階段 | 時間 | 動作 |
| ---- | ---- | ---- |
| 撥出等待 ringing | 5 秒 | 未收到 `call-ringing` → 重發 `call-invite`（最多 2 次）。 |
| ring duration | 45 秒 | 無回應 → server 發出 `call-timeout`。 |
| 接通後 ICE 建立 | 20 秒 | 無 `call-accept` / ICE 完成 → 自動 `call-end` with reason `network`. |
| ICE candidate 重試 | 每 2 秒 | 最多 5 次，失敗則降級 TURN。 |

## 6. 能力探針與版本控管

- `capabilities.platform`: `web`, `ios`, `android`（預留）。
- `capabilities.version`: 對應信令 schema 版本。Server 根據版本切換兼容邏輯。
- `capabilities.features`: 陣列（例 `["video", "screenshare"]`）。
- 伺服器保留 `minSupportedVersion`，若客戶端過舊則回傳 `CALL_CAPABILITY_MISMATCH`。

## 7. API 介面

| Method | Path | 用途 |
| ------ | ---- | ---- |
| POST | `/api/v1/calls/invite` | Fallback：在 WS 尚未建立時送出邀請。 |
| POST | `/api/v1/calls/cancel` | Fallback 取消。 |
| POST | `/api/v1/calls/ack` | 背景喚醒後立即告知服務端正在處理，用於延長逾時。 |

## 8. 推播 payload

```jsonc
{
  "type": "call-invite",
  "callId": "uuid",
  "fromUid": "AABBCC",
  "nickname": "Alice",
  "capabilities": { "audio": true, "video": false },
  "token": "short-lived JWT for call bootstrap",
  "ttlSeconds": 60
}
```

> iOS 需要 PushKit（VoIP push）+ APNs (user-visible)。`token` 用於在 App 啟動後快速向 `/api/v1/calls/ack` 取得完整信令。

## 9. 待辦 / 實作指引

- 建立 `call_sessions` D1 table (callId, callerUid, calleeUid, status, expiresAt)。
- 實作 WebSocket handler：轉發 `call-*` 事件，並驗證鎖定。
- 撰寫 TypeScript + Swift 共用 schema（可用 JSON Schema / Protocol Buffers）。
- 加入 logger tag `call.*`，便於日後在 Grafana 查詢。

---

**狀態**：已完成設計文檔，後續 Roadmap 項目（端對端加密媒體、NAT/TURN…）將延續本規格。
