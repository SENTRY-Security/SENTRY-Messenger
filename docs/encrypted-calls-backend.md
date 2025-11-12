# Encrypted Voice / Video Call — 後端服務與監控

> 對應 README「Encrypted Voice / Video Call Roadmap」第六項。此文件整理呼叫後端 API、資料表、事件紀錄與監控指標，確保 Web 與 iOS App 共用。

## 1. 資料模型

### 1.1 `call_sessions`（D1/SQLite）

| 欄位 | 型別 | 說明 |
| ---- | ---- | ---- |
| `call_id` | TEXT (PK) | UUID |
| `caller_uid` | TEXT | 呼叫方 |
| `callee_uid` | TEXT | 被叫方 |
| `status` | TEXT | `dialing`, `ringing`, `connected`, `ended`, `failed` |
| `mode` | TEXT | `voice`, `video` |
| `capabilities` | JSON | audio/video/screenshare |
| `created_at` | INTEGER | epoch ms |
| `connected_at` | INTEGER | 連線時間 |
| `ended_at` | INTEGER | 結束時間 |
| `end_reason` | TEXT | `hangup`, `reject`, `timeout`, `network`, `error` |
| `metrics` | JSON | 封包遺失、平均 RTT、降階次數 |

### 1.2 `call_events`

紀錄每個信令事件，方便除錯。

| 欄位 | 說明 |
| ---- | ---- |
| `event_id` (PK) | UUID |
| `call_id` | |
| `type` | `invite`, `accept`, `media-update`… |
| `payload` | JSON 簡要資訊 |
| `ts` | epoch ms |

## 2. API 介面

| Method | Path | 用途 |
| ------ | ---- | ---- |
| `POST /api/v1/calls/turn-credentials` | 發放 STUN/TURN 憑證（前一項已定義） |
| `POST /api/v1/calls/report-metrics` | 客戶端回報 QoS（封包遺失、重連次數） |
| `GET /api/v1/calls/:id` | 取得 call session 狀態（調試 / CallKit 同步） |
| `POST /api/v1/calls/ack` | 背景喚醒後告知正在處理，延長 server timeout |

所有 API 需驗證 `accountToken + uidHex`，並與 `call_sessions` 比對。

## 3. 事件管道

- 呼叫事件同時寫入
  - **Cloudflare Worker** → D1
  - **Kafka / PubSub**（optional）→ 供 BI/分析
- `call_events` 僅保留 7 天，定期批次匯出到 S3 以供分析。

## 4. 監控指標

### 4.1 Prometheus Metrics

| Metric | 說明 |
| ------ | ---- |
| `call_session_active` (gauge) | 目前活躍通話數 |
| `call_event_total{type}` | 各類事件計數 |
| `call_connect_duration_ms` (histogram) | 從 invite 到 connect 的時間 |
| `call_duration_ms` (histogram) | 通話時長 |
| `call_qos_packet_loss_ratio` (histogram) | 封包遺失比例 |
| `call_reconnect_count` | 重新連線次數 |

### 4.2 日誌

- 所有 `call-*` 事件附 `traceId`, `callId`, `uid`。
- 重要錯誤：`TURN_ALLOC_FAIL`, `SIGNAL_TIMEOUT`, `MEDIA_KEY_ROTATE_ERROR`。
- 可透過 Loki / ELK 搜尋 `callId` 快速定位。

### 4.3 告警條件

| 條件 | 門檻 | 行動 |
| ---- | ---- | ---- |
| `call_session_active` > 80% TURN capacity | 5 分鐘 | 提醒擴容 |
| `call_connect_duration_ms_p95` > 8s | 15 分鐘 | 檢查信令或 TURN |
| `call_event_total{type="call-end",reason="network"}` 占比 > 30% | 10 分鐘 | 標記網路事故 |
| `call_qos_packet_loss_ratio_p95` > 0.15 | 10 分鐘 | 降低預設畫質 |

## 5. 後台管理與自動化

- 建立簡易管理界面（僅內部使用）：
  - 搜尋 callId / uid
  - 查看事件時間線（invite → ringing → accept → end）
  - 下載 QoS 報告
- 週報：聚合指標（平均時長、成功率、常見錯誤）。
- BI：將 `call_sessions` 匯入 BigQuery 供趨勢分析。

## 6. 安全與隱私

- 事件記錄僅含加密後 metadata，不存任何通話內容。
- Call session 在 30 天後自動刪除，QoS 數據匿名化。
- 只有授權的 SRE/安全人員可查詢詳細事件。

## 7. 實作待辦

1. 於 Worker 新增 `/d1/calls/*` endpoints 與 migrations。
2. Node API 新增上述 REST endpoints。
3. 建立 Prometheus exporter（或以 OpenTelemetry 方式輸出）。
4. 設計 Loki/Grafana dashboard。
5. 編寫自動清理腳本（每日刪除過期 sessions / events）。

---

**狀態**：規劃完成；待依此實作 Worker/Node API 與監控。*** End Patch
