# SENTRY Messenger

**端對端加密即時通訊系統** — 採用 Signal Protocol (X3DH + Double Ratchet) 實現高安全性的訊息傳遞。

> 官網：https://sentry.red ・ 版本：0.1.9 ・ 授權：AGPL-3.0-only

---

## 目錄

- [架構概覽](#架構概覽)
- [核心功能](#核心功能)
- [視訊通話架構](#視訊通話架構)
- [分片加密串流](#分片加密串流)
- [專案結構](#專案結構)
- [密碼學協定](#密碼學協定)
- [訊息流程架構](#訊息流程架構)
- [資料庫 Schema](#資料庫-schema)
- [API 端點](#api-端點)
- [WebSocket 即時通訊](#websocket-即時通訊)
- [安全設計原則](#安全設計原則)
- [快速開始](#快速開始)
- [部署](#部署)
- [測試](#測試)
- [環境變數](#環境變數)

---

## 架構概覽

### 三層 Hybrid 部署架構

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                     SENTRY Messenger                         │
                    └──────────────────────────────────────────────────────────────┘

  ┌──────────────────────┐     ┌───────────────────────┐     ┌─────────────────────────┐
  │   Frontend (web/)    │     │  Backend (src/)        │     │  Data Layer              │
  │                      │     │                        │     │  (data-worker/)          │
  │  Cloudflare Pages    │────▶│  Express + WebSocket   │────▶│  Cloudflare Workers      │
  │  Vanilla JS SPA      │     │  Linode VPS (PM2)      │     │  D1 (SQLite) + R2 Storage│
  │  esbuild bundler     │     │  HMAC-signed requests  │     │                          │
  └──────────────────────┘     └───────────────────────┘     └─────────────────────────┘
         │                              │                              │
         │  ◀── HTTPS/WSS ──▶          │  ◀── HMAC-auth REST ──▶     │
         │                              │                              │
  ┌──────┴──────┐               ┌───────┴───────┐             ┌───────┴───────┐
  │ X3DH + DR   │               │ Rate Limit    │             │ D1 Database   │
  │ 客戶端加密   │               │ Helmet/CORS   │             │ R2 媒體儲存   │
  │ IndexedDB   │               │ JWT WS Auth   │             │ OPAQUE 紀錄   │
  └─────────────┘               └───────────────┘             └───────────────┘
```

1. **Frontend (`web/`)** — 純靜態 SPA，部署至 Cloudflare Pages，所有加密/解密在客戶端完成
2. **Backend (`src/`)** — Node.js Express API + WebSocket 伺服器，部署於 VPS (PM2)，負責路由轉發與即時信令
3. **Data Worker (`data-worker/`)** — Cloudflare Workers，直接存取 D1 資料庫與 R2 物件儲存，以 HMAC 驗證 Backend 請求

---

## 核心功能

### 密碼學協定

| 功能 | 技術 | 說明 |
|------|------|------|
| 金鑰交換 | X3DH (Extended Triple Diffie-Hellman) | 非同步建立共享密鑰，支援離線初始化 |
| 訊息加密 | Double Ratchet | 每則訊息獨立金鑰，前向保密 + 後向保密 |
| 對稱加密 | XChaCha20-Poly1305 / AES-256-GCM | 訊息內容 AEAD 加密 |
| 身份驗證 | Ed25519 簽章 + OPAQUE PAKE | 無密碼洩漏風險的密碼認證 |
| NFC 認證 | NTAG 424 DNA SDM (CMAC/HKDF/EV2) | 實體 NFC 標籤身份綁定 |
| 金鑰派生 | HKDF-SHA256 / Argon2id | 密碼學安全的金鑰衍生 |
| 主金鑰保護 | Argon2id + AES-256-GCM wrapping | 使用者密碼保護主金鑰 |
| 媒體分片加密 | HKDF-SHA256 → AES-256-GCM per-chunk | 每 chunk 獨立鑰匙與 IV，info tag 域分離 |
| 通話 E2EE | InsertableStreams + AES-GCM | WebRTC 逐幀加密，counter-based nonce，10 分鐘金鑰輪換 |

### 通訊功能

- **端對端加密訊息** — 文字、媒體、檔案，伺服器無法解密
- **語音/視訊通話** — WebRTC P2P + Cloudflare TURN relay，InsertableStreams E2EE 媒體加密
- **AI 人臉/背景馬賽克** — MediaPipe Face Detection 三階段模糊（人臉馬賽克 / 背景馬賽克 / 關閉），三層偵測策略（Native FaceDetector → MediaPipe WASM → 膚色偵測）
- **分片加密串流** — 影片上傳自動轉碼為 fMP4，Per-chunk AES-256-GCM 加密，MSE/ManagedMediaSource 即時串流播放（單檔上限 1GB），AIMD 自適應併發控制
- **WebCodecs 智慧轉碼** — HEVC/VP9 → H.264 fMP4 自動轉碼，支援降級重試（720p/1.5Mbps），已是 H.264 時直接 remux 免轉碼
- **聯絡人邀請** — 加密 Invite Dropbox 機制（支援離線互加 + 確認回饋）
- **群組對話** — 多人加密聊天室，角色權限管理（owner/admin/member）
- **已讀回條** — Commit-driven 訊息狀態追蹤（✓ sent / ✓✓ delivered）
- **即時推播** — WebSocket 即時訊息通知與通話信令
- **訊息重播** — Message Key Vault 支援歷史訊息回放
- **聯絡人備份** — 加密備份/還原聯絡人密鑰至伺服器
- **訂閱管理** — 訂閱碼兌換、驗證、QR 掃描上傳與配額管理
- **軟刪除** — 訊息/對話 Cursor-based 軟刪除（timestamp 驅動）
- **頭像管理** — 聯絡人頭像上傳/下載（Presigned URL + R2）
- **媒體預覽** — 圖片檢視器、PDF 檢視器、媒體權限管理
- **檔案儲存空間** — Drive Pane 檔案管理，資料夾建立/瀏覽/上傳，配額管理（預設 3GB）
- **傳輸進度 UI** — 上傳/下載雙進度條，可展開處理步驟 checklist（格式偵測→轉碼→加密上傳），即時速度與已傳輸量顯示
- **SDM 模擬** — 開發用 NFC 標籤模擬（Sim Chips）
- **離線同步** — Hybrid Flow 離線/線上訊息同步、Gap 偵測與填補
- **帳號管理** — 管理員帳號清除（purge）與強制登出

### 安全特性

- **零知識架構** — 伺服器僅儲存密文，無法解密任何訊息內容
- **前向保密 (Forward Secrecy)** — 每則訊息使用獨立金鑰，密鑰洩漏不影響歷史訊息
- **後向保密 (Break-in Recovery)** — Double Ratchet 自動修復，即使當前密鑰洩漏也會在新交換後恢復安全
- **抗重放攻擊** — Per-conversation Counter 單調遞增，伺服器端強制驗證
- **無 Fallback 政策** — 嚴格密碼協定，拒絕任何降級/重試/回滾
- **離線密鑰交換** — 透過 X3DH Prekey Bundle，對方離線時也能安全初始化
- **強制登出** — 帳號清除時透過 WebSocket `force-logout` 即時踢出所有裝置

---

## 視訊通話架構

### WebRTC P2P 通話

```
  Caller                        Signaling (WebSocket)                     Callee
  ──────                        ─────────────────────                     ──────
    │── call-invite ────────────────────────────────────────────────────▶│
    │◀──────────────────────────────────────────────────── call-ringing ─│
    │◀──────────────────────────────────────────────────── call-accept ──│
    │                                                                    │
    │── SDP offer (+ ICE candidates) ──────────────────────────────────▶│
    │◀──────────────────────────────── SDP answer (+ ICE candidates) ───│
    │                                                                    │
    │◀═══════════════ DTLS/SRTP ═══════════════════════════════════════▶│
    │               WebRTC P2P 加密媒體通道（via TURN relay if needed）    │
```

- **架構**: 純 P2P 點對點通話（非 SFU），WebSocket 僅用於信令交換
- **ICE**: 完整候選收集（host + srflx + relay），Cloudflare STUN + 動態 TURN 憑證
- **DTLS**: ECDSA P-256 憑證，確保傳輸層加密
- **媒體**: 音訊（echo cancellation + noise suppression + auto gain control）+ 視訊
- **Safari 相容**: 完整 ICE 候選嵌入 SDP、獨立 `<audio>` 元素、usernameFragment 注入

### E2EE 媒體加密（InsertableStreams）

| 方向 | Info Tag | 說明 |
|------|----------|------|
| 音訊發送 | `call-audio-tx:caller` | AES-GCM 逐幀加密 |
| 音訊接收 | `call-audio-tx:callee` | 對端解密 |
| 視訊發送 | `call-video-tx:caller` | AES-GCM 逐幀加密 |
| 視訊接收 | `call-video-tx:callee` | 對端解密 |

- 每幀獨立 nonce（counter-based），防止重放
- 金鑰每 10 分鐘自動輪換

### MediaPipe 人臉/背景馬賽克

```
Camera VideoTrack
  ↓
Hidden <video> element
  ↓
Canvas drawImage (30 FPS)
  ↓
Face Detection (每 200ms 偵測一次，結果快取)
  ├── Tier 1: Native FaceDetector API (Chrome/Edge 86+)
  ├── Tier 2: MediaPipe Face Detection WASM (Safari/Firefox/iOS)
  │           CDN: @mediapipe/tasks-vision@0.10.14
  │           Model: BlazeFace Short Range TFLite (~1.5MB)
  └── Tier 3: 膚色區域偵測 (YCbCr 閾值 + BFS 連通分量)
  ↓
Pixelation (14×14 pixel blocks, 20% padding)
  ├── FACE mode → 馬賽克偵測到的人臉區域
  ├── BACKGROUND mode → 馬賽克人臉以外的所有區域
  └── OFF mode → 直接通過不處理
  ↓
canvas.captureStream() → processed VideoTrack
  ↓
RTCRtpSender.replaceTrack() → 送出處理後的視訊
```

- **瀏覽器支援**: Chrome 51+ / Firefox 43+ / Safari 15+ / iOS Safari 15+
- **Safari 心跳**: 每 ~33ms 維持 captureStream 活性
- **模式切換**: 通話介面左上角按鈕，藍色（人臉）→ 紫色（背景）→ 灰色（關閉）

---

## 分片加密串流

### 上傳流程

```
使用者選擇檔案
  ↓
格式偵測 (canRemuxVideo)
  ↓                                    ┌─────────────────────────────┐
  ├── 影片檔案 ──▶ WebCodecs 轉碼?     │  WebCodecs 智慧轉碼         │
  │                  │                  │  HEVC/VP9 → H.264 fMP4      │
  │                  ├── 需要轉碼 ──────│  失敗 → 降級 720p/1.5Mbps   │
  │                  ├── 已是 H.264 ────│  → 跳過，直接 remux          │
  │                  └── 已是 fMP4 ─────│  → Streaming Upload (低記憶) │
  │                                     └─────────────────────────────┘
  │                  ↓
  │           MP4 Remux → fMP4 分段
  │                  ↓
  │           每段 = 一個 chunk
  │
  ├── 非影片檔案 ──▶ 固定 5MB byte-range chunks
  ↓
Per-chunk 加密: HKDF-SHA256(MK, random_salt, 'media/chunk-v1') → AES-256-GCM
  │  ├── Bulk Encryptor: CryptoKey 一次匯入，所有 chunk 共用（省去 per-chunk importKey）
  │  └── 加密後立即釋放明文 buffer → 降低記憶體峰值
  ↓
AIMD 自適應並行上傳 → S3 Presigned URL (ArrayBuffer 直傳，無 Blob 複製)
  │  ├── 初始併發: navigator.connection 自動偵測 (4g→6, 3g→3, 2g→2)
  │  ├── Additive Increase: RTT 穩定 → +1 (上限 15)
  │  └── Multiplicative Decrease: timeout/error/RTT 飆升 → ×0.5 (下限 2)
  ↓
上傳 Manifest (v3): chunk 清單 + codec 資訊 + track 資訊 + 影片時長
  ↓
Manifest 加密: HKDF-SHA256(MK, salt, 'media/manifest-v1') → AES-256-GCM
```

### 下載 & 串流播放

```
訊息包含: { baseKey, manifestEnvelope }
  ↓
下載 & 解密 Manifest (media/manifest-v1)
  ↓
URL 批次簽章 (每批 20 URLs，預取下一批)
  ↓
AIMD 自適應並行下載 (每 chunk 30s timeout, 3 retries + exponential backoff)
  │  ├── 初始併發: navigator.connection 自動偵測 (4g→6, 3g→3, 2g→2)
  │  ├── Additive Increase: RTT 穩定 → +1 (上限 10)
  │  └── Multiplicative Decrease: timeout/error → ×0.5 (下限 2)
  ↓
Per-chunk 解密: AES-256-GCM
  ↓                                    ┌─────────────────────────────┐
MSE 串流播放                            │  MediaSource Extensions      │
  ├── Desktop: MediaSource API         │  Codec 自動偵測 from fMP4    │
  ├── iOS 17.1+: ManagedMediaSource    │  H.264 / HEVC profiles      │
  │     (startstreaming/endstreaming)  │  Duration 預設定（防 auto-pause）│
  └── Fallback: Blob URL 整檔播放      │  Buffer 自動回收 (5s behind) │
                                        │  QuotaExceeded 自動 evict    │
                                        └─────────────────────────────┘
```

### Manifest 結構 (v3)

```json
{
  "v": 3,
  "segment_aligned": true,
  "totalSize": 52428800,
  "totalChunks": 12,
  "contentType": "video/mp4",
  "name": "video.mp4",
  "duration": 127.5,
  "chunks": [
    { "index": 0, "size": 4194304, "cipher_size": 4194320, "iv_b64": "...", "salt_b64": "..." }
  ],
  "tracks": [
    { "type": "muxed", "codec": "avc1.64001E" }
  ]
}
```

### 串流效能指標

| 指標 | 數值 |
|------|------|
| 單檔上限 | 1 GB |
| 最大 chunk 數 | 2,000 |
| 固定 chunk 大小（非影片） | 5 MB |
| 上傳併發 | AIMD 自適應 2~15（依網速自動調整） |
| 下載併發 | AIMD 自適應 2~10（依網速自動調整） |
| 併發初始值偵測 | `navigator.connection.effectiveType` (4g→6, 3g→3, 2g→2) |
| AIMD 調整策略 | RTT 穩定 → +1；timeout/error/RTT 1.5x → ×0.5 |
| URL 預取批次 | 20 URLs/批 |
| 上傳逾時/chunk | 120 秒 |
| 下載逾時/chunk | 30 秒 |
| 上傳重試 | 2 次，exponential backoff (2s→4s) |
| 下載重試 | 3 次，exponential backoff (1s→8s) |
| 加密加速 | Bulk Encryptor（CryptoKey 單次匯入，全 chunk 共用） |
| 上傳傳輸 | ArrayBuffer 直傳（無 Blob 複製） |
| Duration 預設定 | Manifest 含影片時長，播放前即設定 MediaSource.duration |
| MSE 最大 in-flight appends | 15 |
| Buffer 回收保留 | currentTime - 5s |

---

## 專案結構

```
SENTRY-Messenger/
│
├── src/                              # ═══ Node.js Backend ═══
│   ├── server.js                     # HTTP + WebSocket 啟動入口，graceful shutdown
│   ├── app.js                        # Express 設定 (Helmet, CORS, 壓縮, Rate Limit, Pino logging)
│   │
│   ├── routes/                       # API 路由層
│   │   ├── index.js                  # 路由聚合器（掛載 /api 前綴）
│   │   ├── auth.routes.js            # SDM/OPAQUE 認證 + MK 存取
│   │   ├── keys.routes.js            # X3DH SPK/OPK 發布與 Bundle 取得
│   │   ├── devkeys.routes.js         # 裝置金鑰備份/還原
│   │   ├── friends.routes.js         # 聯絡人刪除（掛載於 / 及 /v1）
│   │   ├── ws-token.routes.js        # WebSocket JWT 產生
│   │   └── v1/                       # v1 API 端點
│   │       ├── messages.routes.js    #   訊息 CRUD / 原子發送 / Probe
│   │       ├── media.routes.js       #   媒體上傳/下載 Presigned URL
│   │       ├── calls.routes.js       #   通話邀請/信令/TURN/Metrics
│   │       ├── contact-secrets.routes.js  # 聯絡人密鑰備份
│   │       ├── contacts.routes.js    #   聯絡人同步 + 頭像 Presigned URL
│   │       ├── groups.routes.js      #   群組管理（CRUD + 成員新增/移除）
│   │       ├── invites.routes.js     #   Invite Dropbox（含 confirm/unconfirmed）
│   │       ├── account.routes.js     #   帳號資訊
│   │       ├── message-key-vault.routes.js # 訊息金鑰保險庫 CRUD
│   │       ├── subscription.routes.js #   訂閱管理（兌換/驗證/掃描上傳）
│   │       ├── admin.routes.js       #   管理員操作（帳號清除）
│   │       └── debug.routes.js       #   除錯端點（遠端 Console）
│   │
│   ├── controllers/                  # 業務邏輯層
│   │   ├── messages.controller.js    # 訊息建立/原子發送/狀態查詢/刪除
│   │   ├── contact-secrets.controller.js # 聯絡人密鑰備份/還原
│   │   ├── calls.controller.js       # 通話生命週期管理
│   │   ├── account.controller.js     # 帳號證據/狀態
│   │   ├── groups.controller.js      # 群組 CRUD
│   │   ├── friends.controller.js     # 好友關係
│   │   ├── invites.controller.js     # Invite Dropbox 操作
│   │   ├── subscription.controller.js # 訂閱兌換
│   │   └── message-key-vault.controller.js # Key Vault 操作
│   │
│   ├── ws/                           # WebSocket 伺服器
│   │   └── index.js                  # 連線管理/認證/通話信令/Presence/帳號鎖定
│   │
│   ├── services/                     # 外部服務整合
│   │   ├── s3.js                     # R2/S3 Presigned URL 產生
│   │   ├── call-worker.js            # Cloudflare Worker API 呼叫封裝
│   │   ├── portal-subscription.js    # 訂閱入口整合
│   │   └── subscription-local.js     # 本地訂閱模擬
│   │
│   ├── lib/                          # 密碼學工具
│   │   ├── ntag424-kdf.js            # NTAG 424 DNA 金鑰派生 (HKDF/EV2)
│   │   └── ntag424-verify.js         # SDM CMAC 驗證
│   │
│   ├── utils/                        # 共用工具
│   │   ├── env.js                    # 環境變數載入
│   │   ├── logger.js                 # Pino 結構化日誌
│   │   ├── account-context.js        # 帳號認證解析
│   │   ├── account-verify.js         # 帳號 digest 驗證
│   │   ├── conversation-auth.js      # 對話存取控制
│   │   ├── call-validators.js        # 通話 ID/事件驗證
│   │   ├── hmac.js                   # HMAC 簽章 (Worker API 通訊)
│   │   ├── ws-token.js               # WebSocket JWT 產生/驗證
│   │   └── session-utils.js          # Session 時間戳正規化
│   │
│   ├── middlewares/                   # Express 中介軟體
│   │   ├── async.js                  # Async 錯誤包裝器
│   │   └── error.js                  # 全域錯誤處理 + 404
│   │
│   └── schemas/                      # 驗證 Schema
│       └── message.schema.js         # Zod 訊息 payload 驗證
│
├── data-worker/                      # ═══ Cloudflare Worker ═══
│   ├── src/
│   │   ├── worker.js                 # D1 查詢 + R2 操作 + HMAC 驗證
│   │   └── u8-strict.js              # Uint8Array 驗證
│   ├── migrations/                   # D1 資料庫遷移（共 6 個）
│   │   ├── 0001_consolidated.sql     # 主要 Schema（核心表）
│   │   ├── 0002_fix_missing_tables.sql  # 補建缺失表（contact_secret_backups 等）
│   │   ├── 0003_restore_deletion_cursors.sql  # deletion_cursors + legacy prekey
│   │   ├── 0004_add_conversation_deletion_log.sql  # 對話刪除紀錄表
│   │   ├── 0005_add_min_ts_to_deletion_cursors.sql # 新增 min_ts 欄位
│   │   ├── 0006_drop_min_counter_from_deletion_cursors.sql # 移除 min_counter
│   │   └── 0007_add_pairing_code.sql # 配對碼支援
│   └── wrangler.toml                 # Workers 設定 (D1 binding)
│
├── web/                              # ═══ Frontend SPA ═══
│   ├── build.mjs                     # esbuild 打包設定
│   ├── package.json                  # 前端依賴 (esbuild)
│   ├── scripts/
│   │   └── verify-build.mjs         # 打包完整性驗證腳本
│   └── src/
│       ├── index.html                # 入口頁（導向 login）
│       │
│       ├── pages/                    # 頁面
│       │   ├── login.html            # 登入頁
│       │   ├── app.html              # 主應用頁
│       │   ├── debug.html            # 除錯面板
│       │   ├── logout.html           # 登出導向
│       │   └── mic-test.html         # 麥克風測試
│       │
│       ├── functions/                # Cloudflare Pages Functions
│       │   ├── [[path]].ts           # 路由處理
│       │   └── apple-app-site-association.ts  # iOS App 關聯
│       │
│       ├── app/                      # 應用程式核心
│       │   ├── api/                  # API 呼叫封裝
│       │   │   ├── account.js        #   帳號 API
│       │   │   ├── auth.js           #   認證 API (SDM/OPAQUE/MK)
│       │   │   ├── calls.js          #   通話 API
│       │   │   ├── contact-secrets.js #  聯絡人密鑰備份 API
│       │   │   ├── devkeys.js        #   裝置金鑰 API
│       │   │   ├── friends.js        #   好友關係 API
│       │   │   ├── groups.js         #   群組 API
│       │   │   ├── invites.js        #   Invite Dropbox API
│       │   │   ├── media.js          #   媒體簽章 API
│       │   │   ├── message-key-vault.js # Message Key Vault API
│       │   │   ├── messages.js       #   訊息 API
│       │   │   ├── prekeys.js        #   X3DH 預金鑰取得
│       │   │   ├── subscription.js   #   訂閱 API
│       │   │   └── ws.js             #   WebSocket 連線管理
│       │   │
│       │   ├── core/                 # 核心基礎設施
│       │   │   ├── store.js          #   中央狀態儲存 (帳號/裝置/聯絡人/訊息)
│       │   │   ├── contact-secrets.js #  聯絡人密鑰持久化 (加密/解密)
│       │   │   ├── http.js           #   HTTP 客戶端
│       │   │   └── log.js            #   結構化日誌
│       │   │
│       │   ├── crypto/               # 密碼學實作
│       │   │   ├── dr.js             #   Double Ratchet 協定
│       │   │   ├── aead.js           #   AEAD 加密 (XChaCha20/AES-GCM)
│       │   │   ├── nacl.js           #   TweetNaCl 包裝 (X25519/Ed25519)
│       │   │   ├── prekeys.js        #   X3DH 預金鑰工具
│       │   │   ├── kdf.js            #   金鑰派生 (HKDF/Argon2id)
│       │   │   └── invite-dropbox.js #   離線邀請加密
│       │   │
│       │   ├── features/             # 功能模組
│       │   │   ├── dr-session.js     #   X3DH 初始化 + DR Session 管理（核心）
│       │   │   ├── contact-share.js  #   聯絡人分享加密/解密
│       │   │   ├── contact-backup.js #   聯絡人密鑰備份協調
│       │   │   ├── contacts.js       #   聯絡人列表管理
│       │   │   ├── conversation.js   #   對話 Context 處理
│       │   │   ├── conversation-updates.js # 對話更新通知
│       │   │   ├── device-priv.js    #   裝置私鑰管理
│       │   │   ├── invite-reconciler.js #  邀請協調/確認
│       │   │   ├── login-flow.js     #   認證流程編排
│       │   │   ├── opaque.js         #   OPAQUE 認證
│       │   │   ├── sdm.js            #   SDM 認證流程
│       │   │   ├── sdm-sim.js        #   SDM 模擬 (Sim Chips)
│       │   │   ├── profile.js        #   使用者個人檔案
│       │   │   ├── settings.js       #   應用程式設定
│       │   │   ├── groups.js         #   群組管理
│       │   │   ├── media.js          #   媒體處理（上傳/下載）
│       │   │   ├── chunked-upload.js #   分片加密上傳（影片轉碼 + fMP4 + AES-GCM + AIMD 自適應併發）
│       │   │   ├── chunked-download.js #  分片解密下載（AIMD 自適應併發 + URL 預取）
│       │   │   ├── adaptive-concurrency.js # AIMD 自適應併發控制器（TCP 壅塞控制啟發）
│       │   │   ├── mse-player.js    #   MSE/ManagedMediaSource 串流播放器
│       │   │   ├── webcodecs-transcoder.js # WebCodecs H.264 轉碼器
│       │   │   ├── mp4-remuxer.js   #   MP4 → fMP4 Remux（Box 解析 + 分段 + Duration 提取）
│       │   │   ├── transfer-progress.js #  傳輸進度 UI（雙進度條 + 步驟 checklist + 即時速度）
│       │   │   ├── semantic.js       #   語意版本管理
│       │   │   ├── messages.js       #   訊息處理
│       │   │   ├── messages-flow-facade.js # 訊息流程 Facade 入口
│       │   │   ├── messages-notify-policy.js # 訊息通知策略
│       │   │   ├── messages-sync-policy.js  # 訊息同步策略
│       │   │   ├── timeline-store.js #   Timeline 訊息儲存
│       │   │   ├── message-key-vault.js # Message Key Vault
│       │   │   ├── secure-conversation-manager.js # 對話安全管理
│       │   │   ├── secure-conversation-signals.js # 控制訊息
│       │   │   ├── restore-coordinator.js # 還原管線
│       │   │   ├── restore-policy.js #   還原策略
│       │   │   │
│       │   │   ├── messages-flow/    #   訊息流程管線
│       │   │   │   ├── index.js      #     Facade 入口
│       │   │   │   ├── state.js      #     狀態機
│       │   │   │   ├── crypto.js     #     加解密操作
│       │   │   │   ├── flags.js      #     功能旗標
│       │   │   │   ├── policy.js     #     發送/同步策略
│       │   │   │   ├── queue.js      #     訊息佇列
│       │   │   │   ├── reconcile.js  #     伺服器/本地同步
│       │   │   │   ├── reconcile/    #     同步決策模組
│       │   │   │   │   └── decision.js #     同步決策邏輯
│       │   │   │   ├── normalize.js  #     訊息正規化
│       │   │   │   ├── presentation.js #   UI 呈現邏輯
│       │   │   │   ├── vault-replay.js #   Vault 重播解密
│       │   │   │   ├── hybrid-flow.js #    Hybrid 離線/線上流程
│       │   │   │   ├── gap-queue.js  #     Gap 偵測佇列
│       │   │   │   ├── local-counter.js #  本地 Counter 管理
│       │   │   │   ├── notify.js     #     通知觸發
│       │   │   │   ├── probe.js      #     訊息探測
│       │   │   │   ├── scroll-fetch.js #   捲動載入
│       │   │   │   ├── server-api.js #     Server API 整合
│       │   │   │   ├── live/         #     即時訊息同步
│       │   │   │   │   ├── index.js         # Live 模組入口
│       │   │   │   │   ├── coordinator.js   # 同步協調器
│       │   │   │   │   ├── job.js           # 同步任務
│       │   │   │   │   ├── state-live.js    # Live 狀態管理
│       │   │   │   │   ├── server-api-live.js # Live API 整合
│       │   │   │   │   └── adapters/        # 適配器層
│       │   │   │   │       └── index.js     #   適配器入口
│       │   │   │   └── messages/     #     訊息處理子管線
│       │   │   │       ├── index.js         # 子管線入口
│       │   │   │       ├── decrypt.js       # 訊息解密
│       │   │   │       ├── counter.js       # Counter 管理
│       │   │   │       ├── gap.js           # Gap 偵測/填補
│       │   │   │       ├── pipeline.js      # 處理管線
│       │   │   │       ├── pipeline-state.js # 管線狀態
│       │   │   │       ├── cache.js         # 訊息快取
│       │   │   │       ├── parser.js        # 訊息解析器
│       │   │   │       ├── vault.js         # Vault 操作
│       │   │   │       ├── receipts.js      # 回條處理
│       │   │   │       ├── placeholder-store.js # Placeholder 管理
│       │   │   │       ├── entry-fetch.js   # 取得入口
│       │   │   │       ├── entry-incoming.js # 接收入口
│       │   │   │       ├── live-repair.js   # Live 修復
│       │   │   │       ├── sync-server.js   # 伺服器同步
│       │   │   │       ├── sync-offline.js  # 離線同步
│       │   │   │       └── ui/              # 訊息 UI 層
│       │   │   │           ├── renderer.js       # 訊息渲染
│       │   │   │           ├── timeline-handler.js # Timeline 處理
│       │   │   │           ├── interactions.js   # 互動操作
│       │   │   │           ├── media-preview.js  # 媒體預覽
│       │   │   │           └── outbox-hooks.js   # Outbox 鉤子
│       │   │   │
│       │   │   ├── queue/            #   訊息佇列
│       │   │   │   ├── outbox.js     #     發送佇列
│       │   │   │   ├── inbox.js      #     接收處理
│       │   │   │   ├── receipts.js   #     已讀回條
│       │   │   │   ├── media.js      #     媒體 metadata
│       │   │   │   ├── send-policy.js #    發送重試策略
│       │   │   │   └── db.js         #     本地佇列 DB
│       │   │   │
│       │   │   ├── calls/            #   通話功能 (WebRTC + MediaPipe)
│       │   │   │   ├── index.js      #     通話模組入口
│       │   │   │   ├── events.js     #     通話狀態事件
│       │   │   │   ├── signaling.js  #     通話信令
│       │   │   │   ├── key-manager.js #    Per-call E2EE 金鑰（InsertableStreams）
│       │   │   │   ├── media-session.js #  WebRTC P2P 媒體管理
│       │   │   │   ├── face-blur.js  #     MediaPipe 人臉/背景馬賽克 Pipeline
│       │   │   │   ├── identity.js   #     參與者身份
│       │   │   │   ├── network-config.js # Cloudflare STUN/TURN 設定
│       │   │   │   ├── state.js      #     通話狀態機
│       │   │   │   └── call-log.js   #     通話紀錄
│       │   │   │
│       │   │   ├── soft-deletion/    #   訊息軟刪除
│       │   │   │   ├── deletion-api.js  #  刪除 API 封裝
│       │   │   │   └── deletion-store.js #  刪除狀態儲存
│       │   │   │
│       │   │   └── messages-support/ #   輔助儲存
│       │   │       ├── conversation-clear-store.js
│       │   │       ├── conversation-tombstone-store.js
│       │   │       ├── processed-messages-store.js
│       │   │       ├── receipt-store.js
│       │   │       ├── vault-ack-store.js
│       │   │       └── ws-sender-adapter.js  # WebSocket 發送適配器
│       │   │
│       │   ├── ui/                   # UI 層
│       │   │   ├── app-ui.js         #   主應用 UI
│       │   │   ├── app-mobile.js     #   Mobile 入口
│       │   │   ├── login-ui.js       #   登入畫面
│       │   │   ├── debug-page.js     #   除錯面板
│       │   │   ├── version-info.js   #   版本資訊顯示
│       │   │   ├── media-permission-demo.js # 媒體權限示範
│       │   │   │
│       │   │   └── mobile/           #   Mobile UI
│       │   │       ├── controllers/  #     MVC Controllers
│       │   │       │   ├── base-controller.js           # 基礎 Controller
│       │   │       │   ├── active-conversation-controller.js
│       │   │       │   ├── conversation-list-controller.js
│       │   │       │   ├── message-sending-controller.js
│       │   │       │   ├── message-flow-controller.js
│       │   │       │   ├── message-status-controller.js
│       │   │       │   ├── share-controller.js
│       │   │       │   ├── call-log-controller.js
│       │   │       │   ├── group-builder-controller.js
│       │   │       │   ├── layout-controller.js
│       │   │       │   ├── media-handling-controller.js
│       │   │       │   ├── composer-controller.js
│       │   │       │   ├── secure-status-controller.js
│       │   │       │   └── toast-controller.js
│       │   │       │
│       │   │       ├── messages-pane.js     # 訊息 Timeline 顯示
│       │   │       ├── contacts-view.js     # 聯絡人列表
│       │   │       ├── conversation-threads.js # 對話串列表
│       │   │       ├── drive-pane.js        # 檔案儲存檢視
│       │   │       ├── profile-card.js      # 個人檔案卡片
│       │   │       ├── session-store.js     # Session 狀態
│       │   │       ├── contact-core-store.js # 聯絡人資料管理
│       │   │       ├── ws-integration.js    # WebSocket 整合
│       │   │       ├── presence-manager.js  # 線上狀態管理
│       │   │       ├── notification-audio.js # 通知音效
│       │   │       ├── call-audio.js        # 通話音訊
│       │   │       ├── call-overlay.js      # 通話 UI Overlay
│       │   │       ├── connection-indicator.js # 連線狀態指示
│       │   │       ├── browser-detection.js # 瀏覽器偵測
│       │   │       ├── debug-flags.js       # 除錯旗標
│       │   │       ├── media-permission-manager.js # 媒體權限管理
│       │   │       ├── messages-ui-policy.js # 訊息 UI 策略
│       │   │       ├── modal-utils.js       # Modal 工具
│       │   │       ├── swipe-utils.js       # 滑動手勢工具
│       │   │       ├── ui-utils.js          # UI 通用工具
│       │   │       ├── zoom-disabler.js     # 縮放禁用
│       │   │       ├── viewers/             # 檔案檢視器
│       │   │       │   ├── image-viewer.js  #   圖片檢視器
│       │   │       │   └── pdf-viewer.js    #   PDF 檢視器
│       │   │       └── modals/              # Modal 對話框
│       │   │           ├── password-modal.js
│       │   │           ├── settings-modal.js
│       │   │           └── subscription-modal.js
│       │   │
│       │   └── lib/                  # 前端工具函式庫
│       │       ├── identicon.js      #   身份頭像生成
│       │       ├── invite.js         #   邀請連結處理
│       │       ├── logging.js        #   日誌工具
│       │       ├── qr.js             #   QR Code 產生/掃描
│       │       └── vendor/           #   第三方函式庫
│       │           ├── cropper.esm.js       # 圖片裁切
│       │           ├── qr-scanner.min.js    # QR 掃描器
│       │           ├── qr-scanner-worker.min.js # QR Worker
│       │           └── qrcode-generator.js  # QR 產生器
│       │
│       ├── libs/                     # 第三方預編譯函式庫
│       │   ├── nacl-fast.min.js     #   TweetNaCl 壓縮版
│       │   └── ntag424-sim.js       #   NFC 標籤模擬
│       │
│       ├── shared/                   # 前後端共用程式碼
│       │   ├── crypto/
│       │   │   ├── dr.js             #   Double Ratchet (共用實作)
│       │   │   ├── aead.js           #   AEAD 加密
│       │   │   ├── nacl.js           #   NaCl 工具
│       │   │   ├── ed2curve.js       #   Ed25519 → X25519 曲線轉換
│       │   │   └── prekeys.js        #   X3DH 預金鑰
│       │   ├── conversation/
│       │   │   └── context.js        #   對話 Context 衍生
│       │   ├── contacts/
│       │   │   └── contact-share.js  #   聯絡人加密共用
│       │   ├── calls/
│       │   │   ├── schemas.js        #   通話 Schema (JS)
│       │   │   ├── schemas.ts        #   通話 Schema (TS 型別)
│       │   │   └── network-config.json # STUN/TURN 設定
│       │   └── utils/
│       │       ├── base64.js         #   Base64 工具
│       │       ├── cdn-integrity.js  #   CDN 完整性驗證
│       │       ├── sri.js            #   SRI (Subresource Integrity)
│       │       └── u8-strict.js      #   Uint8Array 驗證
│       │
│       └── assets/                   # 靜態資源
│           ├── *.css                 #   模組化樣式表（app-base, app-layout, app-messages 等）
│           ├── favicon.ico           #   網站圖示
│           ├── audio/                #   UI 音效 (notify, click, call-in/out, accept, end-call)
│           └── images/               #   圖片資源 (avatar, logo, encryption.gif)
│
├── tests/                            # ═══ 測試 ═══
│   ├── e2e/                          # Playwright E2E 測試
│   │   ├── login-smoke.spec.mjs      #   登入煙霧測試
│   │   └── global-setup.mjs          #   全域設定
│   ├── unit/                         # 單元測試
│   │   ├── contact-secrets.spec.mjs
│   │   ├── encoding.spec.mjs
│   │   ├── logging.spec.mjs
│   │   ├── semantic.spec.mjs
│   │   ├── snapshot-normalization.spec.mjs
│   │   └── timeline-precision.spec.mjs
│   ├── dr-offline-sim.mjs            # Double Ratchet 離線模擬
│   ├── fixtures/                     # 測試資料
│   │   ├── accounts.local.json       #   本地帳號設定
│   │   └── accounts.sample.json      #   範例帳號設定
│   ├── scripts/                      # 測試輔助腳本
│   │   ├── capture-screens.mjs       #   畫面截圖
│   │   ├── debug-dr-replay.mjs       #   DR 重播除錯
│   │   └── proto-harness.mjs         #   協定測試框架
│   └── assets/                       # 測試資源
│
├── scripts/                          # ═══ 部署與工具 ═══
│   ├── deploy-hybrid.sh              # 一鍵 Hybrid 部署
│   ├── deploy-prod.sh                # 正式環境部署
│   ├── wipe-all.sh                   # 全環境清除
│   ├── serve-web.mjs                 # 本地 Web 伺服器
│   ├── debug-history-fetch.js        # 歷史訊息取得除錯
│   ├── inspect-server-backup.mjs     # 伺服器備份檢視
│   ├── cleanup/                      # 清除工具
│   │   ├── d1-wipe-all.sql           #   D1 全表清除 SQL
│   │   └── wipe-all.sh               #   清除腳本
│   └── lib/                          # 腳本共用函式庫
│       ├── argon2-wrap.mjs           #   Argon2 包裝
│       └── u8-strict.js              #   Uint8Array 驗證
│
├── tools/                            # ═══ 工具 ═══
│   └── inspect-contact-secrets-snapshot.mjs  # 聯絡人密鑰快照檢視
│
├── docs/                             # ═══ 文件 ═══
│   ├── messages-flow-architecture.md # 訊息流程架構
│   ├── messages-flow-spec.md         # 訊息流程權威規格
│   ├── messages-flow-invariants.md   # 不變量文件
│   ├── messages-flow-refactor-audit.md # 訊息流程重構審計
│   ├── message-flow-legacy-checks.md # Legacy 檢查清單
│   ├── topup-system-spec.md          # 儲值系統規格
│   └── internal/                     # 內部文件
│
├── playwright.config.ts              # Playwright 測試設定
└── package.json                      # 專案設定
```

---

## 密碼學協定

### X3DH 金鑰交換

```
    Alice (Initiator)                           Bob (Responder)
    ─────────────────                           ─────────────────
    持有: IKa (Identity Key)                    持有: IKb, SPKb (Signed Prekey), OPKb (One-Time Prekey)

    1. 取得 Bob 的 Prekey Bundle
       ← [IKb, SPKb, SPK_sig, OPKb]

    2. 驗證 SPKb 簽章 (Ed25519)

    3. 產生 Ephemeral Key: EKa

    4. 計算共享密鑰:
       DH1 = DH(IKa, SPKb)      ─── 身份 × 簽名預金鑰
       DH2 = DH(EKa, IKb)       ─── 暫時 × 身份
       DH3 = DH(EKa, SPKb)      ─── 暫時 × 簽名預金鑰
       DH4 = DH(EKa, OPKb)      ─── 暫時 × 一次性預金鑰 (可選)

    5. SK = HKDF(DH1 || DH2 || DH3 [|| DH4])

    6. 發送初始訊息:
       → [IKa, EKa, OPK_id, ciphertext(SK)]
```

- **SPK (Signed Prekey)**: 中期輪換的簽名預金鑰
- **OPK (One-Time Prekey)**: 一次性預金鑰，用後即刪（增強前向保密）
- **預金鑰管理**: 客戶端定期發布新 SPK + 批量 OPK 至伺服器

### Double Ratchet 訊息加密

```
    Root Chain:     RK₀ ──DH──▶ RK₁ ──DH──▶ RK₂ ──DH──▶ ...
                     │            │            │
    Sending Chain:  CKs₀──KDF──▶CKs₁──KDF──▶CKs₂
                     │            │            │
    Message Keys:   MK₀          MK₁          MK₂
                     │            │            │
    Encrypt:     plaintext    plaintext    plaintext
                     ↓            ↓            ↓
                  cipher₀     cipher₁     cipher₂
```

- **DH Ratchet**: 每次對話方向切換時，交換新的 DH 公鑰，推進 Root Key
- **Symmetric Ratchet**: 每則訊息用 KDF 推進 Chain Key，衍生獨立 Message Key
- **Skipped Keys**: 支援亂序接收，最多保留 100 個跳過的金鑰
- **AEAD 附加資料 (AAD)**: `v:{version};d:{deviceId};c:{counter}` 防止訊息重排/篡改

### 加密演算法

| 用途 | 演算法 | Nonce 長度 |
|------|--------|-----------|
| 訊息內容 | XChaCha20-Poly1305 | 192 bit |
| 聯絡人密鑰/MK wrapping | AES-256-GCM | 128 bit |
| 金鑰派生 | HKDF-SHA256 | — |
| 密碼雜湊 | Argon2id (m=64MB, t=3, p=4) | — |
| 簽章 | Ed25519 | — |
| 金鑰交換曲線 | X25519 (via ed2curve) | — |

### NFC 認證 (NTAG 424 DNA SDM)

```
NFC 標籤 tap → UID + Counter + CMAC
                       ↓
              HKDF/EV2 金鑰派生 (NTAG424_KM + salt)
                       ↓
              CMAC 驗證 → Counter 單調性檢查 (防重放)
                       ↓
              帳號 token 發放
```

### OPAQUE 密碼認證

- 基於 P-256 曲線的 OPAQUE PAKE 協定
- 兩階段流程: `register-init` → `register-finish` / `login-init` → `login-finish`
- 伺服器不持有明文密碼，防止離線字典攻擊
- 成功後衍生 Session Key

---

## 訊息流程架構

### 雙路徑模型 (A Route / B Route)

```
                          ┌─────────────────────────────┐
                          │     Entry Events             │
                          │  login / ws / enter /        │
                          │  resume / scroll             │
                          └──────────┬──────────────────┘
                                     │
                          ┌──────────▼──────────────────┐
                          │       Facade (入口)          │
                          │  messages-flow/index.js      │
                          └──────────┬──────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                  │
         ┌──────────▼──────────┐           ┌──────────▼──────────┐
         │    A Route           │           │    B Route           │
         │    Replay (Vault)    │           │    Live Decrypt      │
         │                      │           │                      │
         │  mutateState=false   │           │  mutateState=true    │
         │  allowReplay=true    │           │  allowReplay=false   │
         │                      │           │                      │
         │  ● vaultGet only     │           │  ● DR 推進 state     │
         │  ● AES-GCM 解密     │           │  ● vaultPut incoming │
         │  ● 不推進 DR        │           │  ● persist snapshot  │
         │  ● 不 vaultPut      │           │  ● gap fill          │
         │                      │           │  ● catch-up          │
         └──────────────────────┘           └──────────────────────┘
```

### 發送流程

```
使用者輸入訊息
  ↓
sendDrPlaintext()              # dr-session.js
  ↓
取得 peer prekey bundle         # X3DH（首次交換）
  ↓
x3dhInitiate() → 共享密鑰      # 或使用既有 DR state
  ↓
drEncryptText() → 加密          # Double Ratchet 加密
  ↓
enqueueDrSessionOp()           # 排入 outbox 佇列
  ↓
processOutboxJobNow()          # 批次處理
  ↓
atomicSend API                 # 訊息 + vault key 原子寫入
  ↓
伺服器 D1 持久化               # messages_secure + message_key_vault
  ↓
WebSocket 通知對方             # secure-message 事件
```

### 接收流程

```
WebSocket: "secure-message" 事件
  ↓
Facade: onWsIncomingMessageNew()
  ↓
Pipeline: B route 處理
  ↓
DR state 解密 + 推進
  ↓
vaultPut() → 儲存 incoming key  # 供日後 A route 重播
  ↓
persist DR snapshot             # 本地 + 可選遠端
  ↓
Timeline: 加入訊息              # Commit-driven
  ↓
觸發通知 / 音效 / 未讀計數     # 僅 Commit 後觸發
```

### 訊息狀態

| 狀態 | 符號 | 意義 |
|------|------|------|
| Sent | ✓ | 發送端已完成伺服器持久化 |
| Delivered | ✓✓ | 對端已完成 live decrypt + vaultPut incoming |

---

## 資料庫 Schema

D1 (SQLite) 共 27 張表（經 7 次遷移），以下為完整表結構：

### 帳號與裝置

```sql
accounts              # 帳號表
├── account_digest    # PK — SHA256 帳號摘要
├── account_token     # API 認證 token
├── uid_digest        # UID hash (SDM 用，UNIQUE)
├── uid_plain         # UID 明文 (可選)
├── last_ctr          # 最後 SDM counter (防重放)
├── wrapped_mk_json   # 加密的 Master Key (Argon2id + AES-GCM)
├── created_at        # 建立時間
└── updated_at        # 更新時間

devices               # 裝置表
├── (account_digest, device_id)  # PK
├── label, status     # 裝置資訊 (status 預設 'active')
├── last_seen_at      # 最後上線
├── created_at        # 建立時間
└── updated_at        # 更新時間

device_backup         # 裝置私鑰備份 (加密)
├── account_digest    # PK (FK → accounts)
├── wrapped_dev_json  # 加密的裝置私鑰
└── updated_at        # 自動更新觸發器

device_signed_prekeys # X3DH SPK (簽名預金鑰)
├── (account_digest, device_id, spk_id)  # UNIQUE
├── spk_pub, spk_sig  # 公鑰與簽章
└── ik_pub            # Identity Key 公鑰

device_opks           # X3DH OPK (一次性預金鑰)
├── (account_digest, device_id, opk_id)  # UNIQUE
├── opk_pub           # 公鑰
├── issued_at         # 發行時間
└── consumed_at       # 消費時間 (NULL = 未使用)
```

### 訊息與加密

```sql
conversations         # 對話表
├── id                # PK — 對話 ID
├── token_b64         # 對話 token
└── created_at        # 建立時間

conversation_acl      # 對話參與者
├── (conversation_id, account_digest, device_id)  # PK
├── role              # 角色
└── updated_at        # 自動更新觸發器

messages_secure       # 加密訊息
├── id                # PK — 訊息 ID
├── conversation_id   # 對話 ID (FK)
├── sender_account_digest, sender_device_id    # 發送方
├── receiver_account_digest, receiver_device_id # 接收方
├── header_json       # X3DH/DR header
├── ciphertext_b64    # 加密內容
├── counter           # per-conversation 單調遞增
└── created_at        # 時間戳

message_key_vault     # 訊息金鑰保險庫 (E2EE 重播)
├── (account_digest, conversation_id, message_id, sender_device_id)  # UNIQUE
├── target_device_id  # 目標裝置
├── direction         # outgoing / incoming
├── msg_type          # 訊息類型
├── header_counter    # 對應 counter
├── wrapped_mk_json   # MK 包裝後的 message key
├── wrap_context_json # 包裝上下文 metadata
└── dr_state_snapshot # DR 狀態快照 (可選)

attachments           # 媒體附件
├── object_key        # PK — R2 物件路徑
├── conversation_id   # 對話 ID (FK)
├── message_id        # 訊息 ID
├── sender_account_digest, sender_device_id  # 發送方
├── envelope_json     # 加密信封
├── size_bytes        # 檔案大小
└── content_type      # MIME 類型

deletion_cursors      # 軟刪除游標
├── (conversation_id, account_digest)  # PK
├── min_ts            # 最小時間戳（刪除過濾基準）
└── updated_at        # 更新時間

conversation_deletion_log  # 對話刪除紀錄
├── id                # PK (自增)
├── owner_digest      # 帳號
├── conversation_id   # 對話 ID
├── encrypted_checkpoint  # 加密的刪除檢查點
└── created_at        # 建立時間
```

### 群組與聯絡人

```sql
groups                # 群組
├── group_id          # PK
├── conversation_id   # 關聯對話 (FK)
├── creator_account_digest  # 建立者 (FK → accounts)
├── name, avatar_json # 群組資訊
└── created_at, updated_at

group_members         # 群組成員
├── (group_id, account_digest)  # PK
├── role              # owner / admin / member (CHECK)
├── status            # active / left / kicked / removed (CHECK)
├── inviter_account_digest  # 邀請者
├── joined_at         # 加入時間
├── muted_until       # 靜音到期時間
└── last_read_ts      # 最後已讀時間戳

group_invites         # 群組邀請
├── invite_id         # PK
├── group_id          # 關聯群組 (FK)
├── issuer_account_digest  # 發起者 (FK, ON DELETE SET NULL)
├── secret            # 邀請密鑰
├── expires_at        # 過期時間
└── used_at           # 使用時間

contacts              # 聯絡人 (加密 metadata)
├── (owner_digest, peer_digest)  # PK
├── encrypted_blob    # 加密的聯絡人資料
├── is_blocked        # 封鎖狀態
└── updated_at        # 更新時間

contact_secret_backups  # 聯絡人密鑰備份
├── id                # PK (自增)
├── account_digest    # 帳號
├── version           # 備份版本
├── payload_json      # 備份內容 { payload, meta }
├── snapshot_version  # 快照版本
├── entries, checksum, bytes  # 完整性資訊
├── device_label, device_id   # 來源裝置
└── created_at, updated_at

invite_dropbox        # 離線邀請投遞箱
├── invite_id         # PK
├── owner_account_digest  # 擁有者 (FK → accounts)
├── owner_device_id   # 擁有者裝置
├── owner_public_key_b64  # X3DH 公鑰
├── expires_at        # 過期時間
├── status            # CREATED → DELIVERED → CONSUMED
├── delivered_by_account_digest  # 投遞者
├── ciphertext_json   # 加密的初始化資料
└── consumed_at       # 消費時間
```

### 通話

```sql
call_sessions         # 通話 Session
├── call_id           # PK
├── caller_uid, callee_uid          # UID
├── caller_account_digest, callee_account_digest  # 帳號摘要
├── status, mode      # 狀態與模式
├── capabilities_json # 裝置能力
├── metadata_json     # 額外 metadata
├── metrics_json      # 通話品質指標
├── connected_at, ended_at  # 連線/結束時間
├── end_reason        # 結束原因
├── expires_at        # 過期時間
└── last_event        # 最後事件類型

call_events           # 通話事件
├── event_id          # PK
├── call_id           # 關聯通話 (FK)
├── type              # 事件類型
├── payload_json      # 事件資料
├── from_account_digest, to_account_digest  # 雙方
└── trace_id          # 追蹤 ID
```

### 認證與訂閱

```sql
opaque_records        # OPAQUE 認證紀錄
├── account_digest    # PK
├── record_b64        # OPAQUE auth record
├── client_identity   # 客戶端識別
└── created_at, updated_at

subscriptions         # 訂閱
├── digest            # PK — 帳號摘要
├── expires_at        # 到期時間
└── created_at, updated_at

tokens                # 訂閱 Token
├── token_id          # PK
├── digest            # 帳號摘要
├── extend_days       # 延展天數
├── nonce, key_id     # 驗證資訊
├── signature_b64     # 簽章
├── status            # 狀態
└── used_at, used_by_digest  # 使用紀錄

extend_logs           # 延展紀錄
├── id                # PK (自增)
├── token_id, digest  # Token 與帳號
├── extend_days       # 延展天數
└── expires_at_after  # 延展後到期時間

media_objects         # 媒體物件追蹤
├── obj_key           # PK — S3 物件路徑
├── conv_id, sender_id  # 對話與發送者
├── size_bytes        # 檔案大小
└── content_type      # MIME 類型
```

---

## API 端點

### 認證 (`/api/v1/auth/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/auth/sdm/exchange` | POST | NFC 標籤 SDM 認證 → 帳號 token |
| `/auth/sdm/debug-kit` | POST | 產生測試用 SDM 憑證 |
| `/auth/opaque/register-init` | POST | OPAQUE 註冊初始化 |
| `/auth/opaque/register-finish` | POST | OPAQUE 註冊完成 |
| `/auth/opaque/login-init` | POST | OPAQUE 登入初始化 |
| `/auth/opaque/login-finish` | POST | OPAQUE 登入完成 |
| `/auth/opaque/debug` | GET | OPAQUE 設定除錯（非敏感資訊） |
| `/mk/store` | POST | 儲存 wrapped MK（首次設定） |
| `/mk/update` | POST | 更新 wrapped MK（變更密碼） |

### 金鑰管理 (`/api/v1/keys/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/keys/publish` | POST | 發布預金鑰 (SPK + OPK 批量) |
| `/keys/bundle` | POST | 取得對方預金鑰包 (X3DH 用，需 `peer_account_digest`) |
| `/devkeys/store` | POST | 儲存裝置金鑰備份（AEAD 或 Argon2id envelope） |
| `/devkeys/fetch` | POST | 取得裝置金鑰備份 |

### 訊息 (`/api/v1/messages/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/messages/secure` | POST | 發送加密訊息 |
| `/messages/atomic-send` | POST | 原子發送（訊息 + vault key 一起寫入） |
| `/messages` | POST | 建立標準訊息 |
| `/messages/secure` | GET | 取得加密訊息列表 |
| `/messages/probe` | GET | 訊息探測端點（回傳 `{probe: 'ok'}`） |
| `/messages/secure/max-counter` | GET | 取得 conversation 最大 counter |
| `/messages/by-counter` | GET | 依 counter 取得特定訊息 |
| `/conversations/:convId/messages` | GET | 取得指定對話的訊息列表 |
| `/messages/send-state` | POST | 取得訊息發送狀態 |
| `/messages/outgoing-status` | POST | 批量取得 outgoing 狀態 |
| `/messages/delete` | POST | 刪除訊息 |
| `/messages/secure/delete-conversation` | POST | 刪除整個對話 |
| `/deletion/cursor` | POST | 設定軟刪除 cursor |

### 媒體 (`/api/v1/media/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/media/sign-put` | POST | 取得 R2 上傳 Presigned URL（單檔） |
| `/media/sign-get` | POST | 取得 R2 下載 Presigned URL（單檔） |
| `/media/sign-put-chunked` | POST | 取得分片上傳 Presigned URLs（baseKey + manifest + chunks，max 2000 chunks） |
| `/media/sign-get-chunked` | POST | 取得分片下載 Presigned URLs（支援指定 chunk_indices） |
| `/media/cleanup-chunked` | POST | 刪除 baseKey 下所有物件（取消/錯誤清理） |

### 通話 (`/api/v1/calls/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/calls/invite` | POST | 發起通話邀請 |
| `/calls/cancel` | POST | 取消通話 |
| `/calls/ack` | POST | 確認通話事件 |
| `/calls/report-metrics` | POST | 回報通話品質指標 |
| `/calls/turn-credentials` | POST | 取得 TURN 憑證（動態，有時效） |
| `/calls/network-config` | GET | 取得 STUN/TURN 網路設定 |
| `/calls/:callId` | GET | 取得通話 Session 詳情 |

### 聯絡人與邀請

| 端點 | 方法 | 說明 |
|------|------|------|
| `/contacts/uplink` | POST | 上傳聯絡人（加密 upsert） |
| `/contacts/downlink` | POST | 下載聯絡人快照 |
| `/contacts/avatar/sign-put` | POST | 取得頭像上傳 Presigned URL（max 5MB） |
| `/contacts/avatar/sign-get` | POST | 取得頭像下載 Presigned URL |
| `/contact-secrets/backup` | POST | 備份聯絡人密鑰 |
| `/contact-secrets/backup` | GET | 還原聯絡人密鑰 |
| `/invites/create` | POST | 建立 Invite Dropbox |
| `/invites/deliver` | POST | 投遞邀請（guest → owner） |
| `/invites/consume` | POST | 消費邀請（owner 取回） |
| `/invites/confirm` | POST | 確認邀請已接收 |
| `/invites/unconfirmed` | POST | 列出未確認的邀請 |
| `/invites/status` | POST | 查詢邀請狀態 |

### 群組 (`/api/v1/groups/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/groups/create` | POST | 建立群組 |
| `/groups/members/add` | POST | 新增群組成員 |
| `/groups/members/remove` | POST | 移除群組成員 |
| `/groups/:groupId` | GET | 取得群組詳情 |

### 訊息金鑰保險庫 (`/api/v1/message-key-vault/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/message-key-vault/put` | POST | 儲存訊息金鑰至保險庫 |
| `/message-key-vault/get` | POST | 取得保險庫中的訊息金鑰 |
| `/message-key-vault/latest-state` | POST | 取得最新 DR 狀態快照 |
| `/message-key-vault/count` | POST | 取得保險庫金鑰數量 |
| `/message-key-vault/delete` | POST | 刪除保險庫中的金鑰 |

### 訂閱 (`/api/v1/subscription/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/subscription/redeem` | POST | 兌換訂閱碼 |
| `/subscription/validate` | POST | 驗證訂閱 |
| `/subscription/status` | GET | 取得訂閱狀態 |
| `/subscription/token-status` | GET | 取得 Token 狀態 |
| `/subscription/scan-upload` | POST | 上傳掃描檔案（multipart, max 8MB） |

### 管理員 (`/api/v1/admin/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/admin/purge-account` | POST | 清除帳號資料（需 HMAC `x-auth` header） |

### 除錯 (`/api/v1/debug/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/debug/config` | GET | 取得除錯設定（遠端 Console 啟用狀態） |
| `/debug/console` | POST | 轉送前端 Console 日誌 |

### 其他

| 端點 | 方法 | 說明 |
|------|------|------|
| `/friends/delete` | POST | 刪除聯絡人（掛載於 `/api/` 及 `/api/v1/`） |
| `/ws/token` | POST | 取得 WebSocket JWT token |
| `/account/evidence` | GET | 取得帳號資訊 |
| `/health` | GET | 健康檢查 |
| `/status` | GET | 服務狀態 |

---

## WebSocket 即時通訊

### 連線流程

```
Client                                Server
  │                                      │
  │──── WebSocket 連線 ─────────────────▶│
  │◀─── hello (server greeting) ────────│
  │──── auth (JWT token) ──────────────▶│
  │◀─── auth_ok / auth_fail ───────────│
  │                                      │
  │◀─── secure-message (新訊息) ────────│
  │◀─── vault-ack (金鑰確認) ──────────│
  │◀─── call-invite (通話邀請) ────────│
  │──── presence-subscribe ────────────▶│
  │◀─── presence-update ───────────────│
  │                                      │
```

### 訊息類型

#### 連線與認證

| 類型 | 方向 | 說明 |
|------|------|------|
| `hello` | S→C | 伺服器歡迎訊息（含 timestamp） |
| `auth` | C→S | JWT 認證請求（token） |
| `auth` | S→C | 認證結果（ok/fail + reason, exp, reused） |
| `ping` | C→S | 心跳探測 |
| `pong` | S→C | 心跳回應（含 timestamp） |

#### 訊息通知

| 類型 | 方向 | 說明 |
|------|------|------|
| `secure-message` | S→C | 新加密訊息通知（含 counter, sender/target digest, deviceId） |
| `message-new` | C→S | 通知對方有新訊息（含 preview, ts, count） |
| `vault-ack` | C→S / S→C | 金鑰保險庫寫入確認（雙向轉發） |
| `contacts-reload` | C→S / S→C | 聯絡人列表更新通知 |
| `contact-removed` | C→S / S→C | 聯絡人刪除通知（含 conversationId） |
| `conversation-deleted` | C→S / S→C | 對話刪除通知 |
| `invite-delivered` | S→C | 邀請投遞通知（含 inviteId） |
| `force-logout` | S→C | 強制登出（帳號清除等原因） |

#### 通話信令

| 類型 | 方向 | 說明 |
|------|------|------|
| `call-invite` | S↔C | 通話邀請 |
| `call-ringing` | S↔C | 響鈴中 |
| `call-accept` | S↔C | 接聽 |
| `call-reject` | S↔C | 拒接 |
| `call-cancel` | S↔C | 取消 |
| `call-busy` | S↔C | 忙線中 |
| `call-end` | S↔C | 結束 |
| `call-offer` | S↔C | SDP Offer（max 64KB） |
| `call-answer` | S↔C | SDP Answer（max 64KB） |
| `call-ice-candidate` | S↔C | ICE 候選 |
| `call-media-update` | S↔C | 媒體狀態更新 |
| `call-error` | S→C | 通話錯誤通知 |
| `call-event-ack` | S→C | 通話事件確認 |

#### Presence

| 類型 | 方向 | 說明 |
|------|------|------|
| `presence-subscribe` | C→S | 訂閱線上狀態（accountDigests 陣列） |
| `presence` | S→C | 線上狀態列表（初始回應） |
| `presence-update` | S→C | 線上狀態變更（單一帳號）|

### Payload 限制

| 項目 | 限制 |
|------|------|
| 一般信令 JSON | 16 KB |
| SDP 描述 | 64 KB（支援 Safari 延伸 codec） |
| 字串欄位 | 128–4096 bytes（依欄位） |

---

## 安全設計原則

### 嚴格密碼協定 — 無 Fallback 政策

本專案遵循**嚴格密碼協定**，禁止任何 fallback、retry、rollback、resync、auto-repair 邏輯：

| 規則 | 說明 |
|------|------|
| 解密失敗 | 直接失敗，不嘗試備用金鑰 |
| Counter 不一致 | 直接拒絕（409 CounterTooLow），不自動對齊 |
| 協定降級 | 禁止使用舊版本/舊金鑰重試 |
| 模糊錯誤處理 | 不允許 try-catch fallback |
| 對話重置 | 必須顯式操作，不隱式重建 state |

### 零知識設計

- 伺服器只儲存 `ciphertext_b64` + `header_json`，無法解密訊息內容
- 聯絡人資料以 `encrypted_blob` 儲存，伺服器無法讀取
- Master Key 以 Argon2id + AES-GCM 包裝後儲存，伺服器無法取得明文

### Commit-driven Side Effects

- **通知/未讀/音效** — 僅在 B route commit（vaultPut + DR snapshot 成功）後觸發
- **Placeholder reveal** — 僅在 commit 後替換
- WebSocket/fetch/probe 不直接產生 user-visible side effects

### Counter 完整性

- 每個 conversation 維護**單調遞增 counter**
- 伺服器端強制驗證 `counter > max_counter`
- 客戶端 per-conversation 序列化處理，防止並行推進

---

## 快速開始

### 前置需求

- Node.js >= 18
- Cloudflare 帳號 (Workers + D1 + R2 + Pages)
- 已設定遠端主機 SSH (`~/.ssh/config` 中的 `Message` host)

### 本地開發

```bash
# 安裝 Backend 依賴
npm install

# 建立 .env 檔案並填入必要環境變數
# 必填：WS_TOKEN_SECRET (>= 32 字元)、DATA_API_URL、DATA_API_HMAC

# 啟動 Backend 開發伺服器
npm run dev

# ─── 另一個終端 ───

# 安裝 Frontend 依賴
cd web && npm install

# 開發模式（raw 複製，不壓縮）
npm run build:raw

# 或使用 Wrangler 本地預覽
npm run preview
```

### Frontend 打包

```bash
cd web
npm run build        # esbuild 打包（壓縮 + code splitting）→ dist/
npm run build:raw    # 直接複製 src → dist（開發用）
npm run verify       # 打包完整性驗證
npm run verify:cdn   # CDN 完整性驗證（含 verbose）
npm run preview      # Wrangler Pages 本地預覽
```

---

## 部署

### 一鍵 Hybrid 部署

```bash
./scripts/deploy-hybrid.sh
```

部署流程：

1. **Cloudflare Worker** — `wrangler d1 migrations apply` + `wrangler deploy` 部署 `data-worker/`
2. **Cloudflare Pages** — `npm run build`（esbuild bundle + SRI）→ `wrangler pages deploy ./dist`
3. **Backend** — git push → SSH 到遠端 → `npm install --production && pm2 reload message-api`

### Frontend Bundle 打包

```bash
cd web
npm run build        # esbuild 打包 → dist/（ES2022, code splitting, minify, SRI）
npm run build:raw    # 直接複製 src → dist（開發用，不壓縮）
npm run verify       # 打包完整性驗證（SHA256 + SRI SHA384）
npm run verify:cdn   # CDN 完整性驗證（含 verbose）
npm run preview      # Wrangler Pages 本地預覽
```

**Bundle 特性：**
- **esbuild** ES2022 target，code splitting + minification + source maps
- **SRI** (Subresource Integrity) — 所有 JS/CSS 注入 SHA384 完整性雜湊
- **Build Manifest** — `dist/build-manifest.json` 含 git commit hash + 每檔 SHA256
- **Entry Points**: `app-mobile.js`、`login-ui.js`、`debug-page.js`、`media-permission-demo.js`
- **CSS Bundle**: `app-bundle.css` 單檔壓縮

### GitHub Actions CI/CD

```yaml
deploy.yml:
  ├── job: deploy-worker     # Cloudflare Worker (D1 migrations + wrangler deploy)
  ├── job: deploy-pages      # Cloudflare Pages (npm build → wrangler pages deploy ./dist)
  └── job: deploy-backend    # Node.js VPS (SSH → git pull → npm install → pm2 reload)
```

### Worker D1 遷移

```bash
cd data-worker
wrangler d1 migrations apply message_db     # 套用資料庫遷移（共 7 個）
wrangler deploy                              # 部署 Worker
```

### 手動部署

```bash
# Worker
cd data-worker && wrangler deploy

# Pages（bundle 模式）
cd web && npm run build && wrangler pages deploy ./dist --project-name message-web-hybrid

# Pages（raw 模式，開發用）
cd web && wrangler pages deploy ./src

# Backend (VPS)
ssh Message "cd /path/to/app && git pull && npm install --production && pm2 reload message-api"
```

---

## 測試

```bash
# ─── 整合測試（scripts/）───
npm run test:login-flow          # 完整認證流程
npm run test:prekeys-devkeys     # X3DH 預金鑰管理
npm run test:messages-secure     # 安全訊息加解密
npm run test:friends-messages    # 好友訊息收發
npm run test:calls-encryption    # 通話加密

# ─── E2E 測試 (Playwright) ───
npm run test:front:login         # 登入 UI 煙霧測試

# ─── 單元測試 ───
node --test tests/unit/          # 全部單元測試

# ─── 模擬測試 ───
node tests/dr-offline-sim.mjs    # Double Ratchet 離線模擬

# ─── 前端驗證 ───
cd web && npm run verify         # 打包完整性驗證
cd web && npm run verify:cdn     # CDN 完整性驗證（含 verbose）
```

### 測試涵蓋範圍

| 類別 | 測試項目 |
|------|----------|
| 認證 | SDM 交換、OPAQUE 註冊/登入、MK 儲存 |
| 金鑰 | SPK/OPK 發布、Bundle 取得、裝置金鑰備份 |
| 訊息 | 加密發送、原子寫入、Counter 驗證、刪除 |
| 好友 | 聯絡人刪除、訊息收發 |
| 通話 | 加密信令、TURN 憑證 |
| 前端 | 登入流程、聯絡人加密、Timeline 精度、編碼、快照正規化 |
| 模擬 | Double Ratchet 離線模擬 |

---

## 環境變數

### 核心設定

| 變數 | 說明 | 範例 |
|------|------|------|
| `PORT` | HTTP 監聽埠 | `3000` |
| `NODE_ENV` | 環境模式 | `development` / `production` |
| `SERVICE_NAME` | 服務名稱 | `message-api` |
| `SERVICE_VERSION` | 服務版本 | `0.1.0` |
| `WS_TOKEN_SECRET` | WebSocket JWT 簽章金鑰 (>= 32 字元) | `<random-string>` |
| `DATA_API_URL` | Cloudflare Worker URL | `https://message-data.xxx.workers.dev` |
| `DATA_API_HMAC` | Worker 通訊 HMAC 密鑰 | `<secret>` |
| `CORS_ORIGIN` | 允許的 CORS 來源 (逗號分隔) | `https://sentry.red,https://app.sentry.red` |
| `DISABLE_RATE_LIMIT` | 停用 API 限速 (`1` = 停用) | `1` |

### S3/R2 儲存

| 變數 | 說明 | 範例 |
|------|------|------|
| `S3_ENDPOINT` | R2 / S3 相容端點 URL | |
| `S3_BUCKET` | 儲存桶名稱 | |
| `S3_ACCESS_KEY` | S3 存取金鑰 | |
| `S3_SECRET_KEY` | S3 秘密金鑰 | |
| `UPLOAD_MAX_BYTES` | 單檔上傳大小限制 | `1073741824` (1GB) |
| `DRIVE_QUOTA_BYTES` | 每個對話儲存配額 | `3221225472` (3GB) |
| `SIGNED_PUT_TTL` | 上傳簽章 URL 有效期 (秒) | `900` |
| `SIGNED_GET_TTL` | 下載簽章 URL 有效期 (秒) | `900` |

### NFC 認證 (NTAG 424 DNA)

| 變數 | 說明 | 範例 |
|------|------|------|
| `NTAG424_KM` | 主金鑰 | `<32 hex chars>` |
| `NTAG424_KDF` | 派生模式 | `HKDF` / `EV2` |
| `NTAG424_SALT` | HKDF salt | `sentry.red` |
| `NTAG424_INFO` | HKDF info | `ntag424-slot-0` |
| `NTAG424_KVER` | 金鑰版本 | `1` |

### OPAQUE PAKE 認證

| 變數 | 說明 | 範例 |
|------|------|------|
| `OPAQUE_OPRF_SEED` | OPRF 種子 | `<64 hex chars>` |
| `OPAQUE_AKE_PRIV_B64` | AKE 私鑰 | `<base64>` |
| `OPAQUE_AKE_PUB_B64` | AKE 公鑰 | `<base64>` |
| `OPAQUE_SERVER_ID` | 伺服器識別符 | `api.sentry` |

### WebRTC 通話

| 變數 | 說明 | 範例 |
|------|------|------|
| `CLOUDFLARE_TURN_TOKEN_ID` | Cloudflare TURN token ID | `<token-id>` |
| `CLOUDFLARE_TURN_TOKEN_KEY` | Cloudflare TURN token 密鑰 | `<token-key>` |
| `TURN_TTL_SECONDS` | TURN 憑證有效期 (秒) | `300` |
| `TURN_SHARED_SECRET` | TURN 憑證簽章密鑰 (備用) | `<secret>` |
| `TURN_STUN_URIS` | STUN 伺服器列表 (逗號分隔) | `stun:stun.cloudflare.com:3478` |
| `TURN_RELAY_URIS` | TURN relay 伺服器列表 | `turn:relay.example.com` |
| `CALL_LOCK_TTL_MS` | 通話鎖定逾時 (毫秒, 最小 30s) | `120000` |
| `CALL_SESSION_TTL_SECONDS` | 通話 Session 過期時間 | `90` |
| `CALL_EXTRA_STUN_URIS` | 額外 STUN 伺服器 | `stun:stun.l.google.com:19302` |

### 除錯與遠端 Console

| 變數 | 說明 | 範例 |
|------|------|------|
| `REMOTE_CONSOLE_ENABLED` | 啟用遠端 Console 日誌 | `true` |
| `REMOTE_CONSOLE_LOG` | 遠端 Console 日誌路徑 | `/var/log/remote-console.log` |

---

## 技術棧

### Backend 依賴

| 套件 | 用途 |
|------|------|
| express | HTTP API 框架 |
| ws | WebSocket 伺服器 |
| helmet | HTTP 安全標頭 |
| compression | 回應壓縮 |
| cors | CORS 中間件 |
| express-rate-limit | API 限速 |
| pino / pino-http | 結構化日誌 |
| jsonwebtoken | JWT 產生/驗證 |
| dotenv | 環境變數載入 |
| @cloudflare/opaque-ts | OPAQUE PAKE 協定 |
| @noble/curves, @noble/hashes, @noble/ed25519 | 密碼學原語 |
| tweetnacl | NaCl 加密函式庫 |
| ed2curve | Ed25519 → X25519 轉換 |
| elliptic | 橢圓曲線加密 |
| @aws-sdk/client-s3 | R2/S3 操作 |
| @aws-sdk/s3-presigned-post | S3 Presigned POST |
| @aws-sdk/s3-request-presigner | S3 Presigned URL |
| zod | Schema 驗證 |
| nanoid | 安全亂數 ID |
| multer | Multipart 檔案上傳 |
| jimp | 伺服器端圖片處理 |
| jsqr | QR Code 解碼 |
| qrcode-reader | QR Code 讀取 |
| pdfjs-dist | PDF 解析 |
| node-aes-cmac | AES-CMAC (NTAG424) |
| pm2 | 程序管理 |

### Frontend 工具與技術

| 工具 / 技術 | 用途 |
|------|------|
| esbuild | JS 打包（ES2022, code splitting, minify, SRI） |
| Vanilla JS | 無框架 SPA |
| Cloudflare Pages | 靜態部署（含 Pages Functions API proxy） |
| WebRTC | P2P 音訊/視訊通話（ECDSA P-256 DTLS） |
| InsertableStreams | 通話 E2EE 逐幀加密（AES-GCM） |
| MediaPipe Face Detection | 人臉偵測 WASM（BlazeFace TFLite, @mediapipe/tasks-vision） |
| WebCodecs | 影片轉碼（HEVC/VP9 → H.264 fMP4） |
| MediaSource Extensions | 加密影片即時串流播放（含 ManagedMediaSource for iOS） |
| mp4box.js | MP4 demux/mux（轉碼 + remux 用） |
| Canvas captureStream | 視訊人臉/背景馬賽克 pipeline |
| Web Crypto API | HKDF-SHA256, AES-256-GCM, SHA-256 |
| Argon2 (WASM) | 密碼 KDF（m=64MiB, t=3, p=1） |
| TweetNaCl | Ed25519 / X25519 密碼學操作 |
| cropper.esm.js | 圖片裁切 (vendor) |
| qr-scanner.min.js | QR Code 掃描 (vendor) |
| qrcode-generator.js | QR Code 產生 (vendor) |

### 開發工具

| 工具 | 用途 |
|------|------|
| @playwright/test | E2E 測試框架 |
| wrangler | Cloudflare CLI（Workers/D1/Pages） |
| GitHub Actions | CI/CD（三階段自動部署） |

### Infrastructure

| 服務 | 用途 |
|------|------|
| Cloudflare Workers | 資料層 API |
| Cloudflare D1 | SQLite 資料庫 |
| Cloudflare R2 | 媒體物件儲存 |
| Cloudflare Pages | 前端部署（esbuild bundle + Pages Functions） |
| Cloudflare TURN | WebRTC 通話 relay（動態憑證） |
| Linode VPS | Backend + WebSocket |
| PM2 | 程序管理 + 自動重啟 |

---

## 授權

AGPL-3.0-only
