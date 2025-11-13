# Encrypted Voice / Video Call — NAT Traversal / TURN 與頻寬偵測

> 對應 README「Encrypted Voice / Video Call Roadmap」第四項。說明 STUN/TURN 佈建、憑證與頻寬策略，供 Web PWA 與未來 iOS App 共用。

## 1. STUN / TURN 架構

- 使用 **coturn** 佈署兩組節點：
  - `turn1.sentry.mobi`（台灣），`turn2.sentry.mobi`（東京）
  - IPv4/IPv6、TCP/UDP/TLS/443 皆開啟，避免企業網封鎖。
- STUN 伺服器使用相同節點，Port 3478/5349。
- 與 Cloudflare Warp/Argo 互通需額外開放 2408 port（可選）。
- **目前狀態**：先行在 `tun.sentry.red`（Linode）完成 coturn 安裝與憑證布署，開放 TCP/UDP `3478`, `5349`, `49160-49200`；`/etc/turnserver.conf` 以 `use-auth-secret` 搭配 `TURN_SHARED_SECRET`，供 Web / Node 端 `/api/v1/calls/turn-credentials` 發放短期憑證。待第二個節點到位後，依同樣設定補上 `turn2.sentry.mobi`。

## 2. 認證與金鑰

- TURN 使用短期憑證（長度 16 bytes username + HMAC-based password）。
- `POST /api/v1/calls/turn-credentials`：伺服器產生 `username = timestamp:uid`，`password = HMAC(shared_secret, username)`，TTL 5 分鐘。Node API 會驗證 `uidHex + accountToken/accountDigest` 後直接回傳 `iceServers` 結構，客戶端不需再呼叫 Worker。
- 回傳結構：

```jsonc
{
  "ttl": 300,
  "iceServers": [
    { "urls": ["stun:turn1.sentry.mobi:3478"] },
    {
      "urls": [
        "turn:turn1.sentry.mobi:3478?transport=udp",
        "turns:turn1.sentry.mobi:5349?transport=tcp"
      ],
      "username": "1700000000:ABCD1234",
      "credential": "base64-hmac"
    }
  ]
}
```

- iOS 端沿用相同 API，使用 `RTCIceServer` 結構。

## 2.1 Network Config API

- `GET /api/v1/calls/network-config` 需附帶 `uidHex + accountToken/accountDigest`，回傳與 `web/src/shared/calls/network-config.json` 相同 schema，並依照環境變數自動帶入：
  - TURN 憑證 TTL（沿用 `TURN_TTL_SECONDS`）
  - STUN/TURN 端點：`TURN_STUN_URIS`、`CALL_EXTRA_STUN_URIS`
  - ICE Policy：`CALL_ICE_TRANSPORT_POLICY`, `CALL_ICE_BUNDLE_POLICY`, `CALL_ICE_GATHER_POLICY`
  - 頻寬探針、Fallback 參數：`CALL_RTCP_TIMEOUT_MS`, `CALL_RTCP_MAX_ATTEMPTS`, `CALL_RTCP_TARGET_KBPS`, `CALL_FALLBACK_MAX_RETRIES`, `CALL_FALLBACK_RELAY_AFTER`, `CALL_FALLBACK_BLOCKED_AFTER`
  - 版本與 TURN endpoint override：`CALL_NETWORK_VERSION`, `CALL_TURN_ENDPOINT`
- 前端（Web / iOS）會優先呼叫此 API，若失敗才回退至打包在 Pages 的 `/shared/calls/network-config.json`，最後才使用程式內建的極簡預設值。如此在調整 TURN 拓撲或參數時只需更新後端環境變數即可，無須重新佈署前端。

## 3. 設定檔模板

```ini
listening-port=3478
tls-listening-port=5349
external-ip=<public-ip>
realm=sentry.mobi
server-name=turn.sentry.mobi
lt-cred-mech
cert=/etc/letsencrypt/live/turn.sentry.mobi/fullchain.pem
pkey=/etc/letsencrypt/live/turn.sentry.mobi/privkey.pem
use-auth-secret
static-auth-secret=<TURN_SHARED_SECRET>
```

## 4. 頻寬與延遲偵測

### 4.1 前置探針

- 建立 dummy RTCPeerConnection，測試：
  - `RTCIceCandidatePairStats.currentRoundTripTime`
  - 上下行可用頻寬（`availableOutgoingBitrate`, `availableIncomingBitrate`）
- 根據結果設定初始媒體設定：

| 條件 | 預設模式 |
| ---- | -------- |
| RTT < 150ms & 上下行 > 2Mbps | 視訊 540p + 語音 |
| RTT < 300ms & 寬頻 > 512kbps | 視訊 360p |
| 其餘 | 語音模式 |

### 4.2 通話中監測

- 每 3 秒讀取 `getStats()`：
  - 若 `packetsLost / totalPackets > 5%` → 降低視訊碼率
  - `availableOutgoingBitrate < 200kbps` → 切語音
  - `currentRoundTripTime > 800ms` → 顯示「網路延遲」提示
- 將結果同步到信令 `call-media-update` 中，以協調雙端狀態。

## 5. Web / iOS 共用設定

- 將 ICE 設定與閾值寫入 `shared/calls/network-config.json`（待建立）：

```jsonc
{
  "turnSecretsEndpoint": "/api/v1/calls/turn-credentials",
  "turnTtlSeconds": 300,
  "rtcpProbe": { "timeoutMs": 1500 },
  "bandwidthProfiles": [
    { "name": "video-medium", "minBitrate": 900000, "maxBitrate": 1400000 },
    { "name": "video-low", "minBitrate": 300000, "maxBitrate": 600000 },
    { "name": "audio", "minBitrate": 32000, "maxBitrate": 64000 }
  ]
}
```

- iOS App 可直接載入此檔或轉為 Plist。
- 相關環境變數：
  - `TURN_SHARED_SECRET`：產生 credential 的 HMAC key（與 coturn `static-auth-secret` 相同）
  - `TURN_TTL_SECONDS`：憑證 TTL（預設 300）
  - `TURN_STUN_URIS` / `TURN_RELAY_URIS`：Node API 打包 `iceServers` 時使用的 URL 清單，逗號分隔
  - `CALL_EXTRA_STUN_URIS`：額外追加的 STUN 列表，會與 `TURN_STUN_URIS` 一起注入 `/calls/network-config`
  - `CALL_TURN_ENDPOINT`：若 TURN credential API 另有 gateway，可在此覆寫 `turnSecretsEndpoint`
  - `CALL_NETWORK_VERSION`：回傳給客戶端的設定版本號，便於做分流
  - `CALL_ICE_TRANSPORT_POLICY` / `CALL_ICE_BUNDLE_POLICY` / `CALL_ICE_GATHER_POLICY`：調整 WebRTC ICE 策略
  - `CALL_RTCP_TIMEOUT_MS`, `CALL_RTCP_MAX_ATTEMPTS`, `CALL_RTCP_TARGET_KBPS`：頻寬探針閾值
  - `CALL_FALLBACK_MAX_RETRIES`, `CALL_FALLBACK_RELAY_AFTER`, `CALL_FALLBACK_BLOCKED_AFTER`：PeerConnection 失敗重試與 relay-only 切換門檻
  - `CALL_SESSION_TTL_SECONDS`：`/api/v1/calls/invite` 預設 session 有效時間，超時後 Worker 會自動清除（見 backend 文檔）

## 6. Fallback 策略

- 若 TURN 也無法連線：
  - 提示「無法建立通話，請檢查網路設定」並回傳報告。
  - 觸發 `call-media-update` 報告 `network=blocked`，伺服器記錄。
- 支援 relay 優先的策略：`iceTransportPolicy = "all"`，但在偵測多次 P2P 失敗後改為 `relay`。

## 7. 監控與告警

- coturn log 送到 Loki/CloudWatch，指標：
  - `Total Allocations`, `Total Bandwidth`, `401/438 錯誤數`
- Prometheus Exporter 觀察：
  - `turn_allocations_active`
  - `turn_tls_sessions`
  - `turn_traffic_sent/received`
- 設置告警：當 `allocations_active > 80% capacity` 或 `401 spikes` 時通知 on-call。

## 8. 待辦清單

1. 申請 `turn*.sentry.mobi` DNS 與 TLS 憑證。
2. 建立 Terraform/Ansible 腳本佈署 coturn。
3. ✅ `/api/v1/calls/turn-credentials` 端點與帳號驗證綁定（Node API 已上線，見本文第 2 節）。
4. ✅ App / Web 共用的 `network-config` 檔案與載入邏輯（`shared/calls/network-config.json` + `features/calls/network-config.js`）。
5. 帶寬自動降階演算法（寫入 `calls/network-manager.js` + Swift counterpart）。

---

**狀態**：設計完成，後續依此實作並於 README 更新進度。
