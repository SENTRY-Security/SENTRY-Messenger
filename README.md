# SENTRY Messenger

感應即開、離開即消。不留痕跡的安全通訊。

## 為什麼不是 App？

傳統通訊軟體需要安裝 App — 裝置上永遠留著圖示、通知紀錄、應用程式列表中的痕跡。即使刪除 App，仍可能被資料復原工具找回殘留資料。

SENTRY Messenger 是一個純 Web 應用程式。不需要安裝任何東西。

## 怎麼啟動？

使用者持有一張寫入專屬 URL 的 NFC 晶片（卡片、貼紙、戒指，任何形式）。手機感應晶片，瀏覽器自動開啟，輸入密碼，直接進入加密通訊。

沒有 App 圖示。沒有書籤。沒有桌面捷徑。啟動的唯一方式是那張晶片。

## 離開會怎樣？

螢幕關閉、切換到其他 App、或瀏覽器退到背景 — 系統立即執行：

1. 清除所有本地資料（記憶體、IndexedDB、LocalStorage）
2. 登出帳號
3. 將瀏覽器跳轉至使用者預先設定的網頁（預設為 Google）
4. 覆寫瀏覽紀錄，無法按上一頁返回

結果：拿起手機的人看到的是一個普通的 Google 頁面，沒有任何跡象顯示這支手機剛才在使用加密通訊軟體。

## 下次使用呢？

再次感應晶片、輸入密碼。所有訊息、聯絡人、檔案從伺服器端的加密備份中即時還原。從上次離開的地方繼續。

不在本地留下任何持久性資料。所有敏感資料以端對端加密保存在雲端。裝置只是一個臨時的檢視窗口。

---

**端對端加密即時通訊系統** — 基於 Signal Protocol (X3DH + Double Ratchet)，部署於 Cloudflare Workers 全 Serverless 架構。

> 官網：https://sentry.red ・ 版本：0.1.9 ・ 授權：AGPL-3.0-only

### 為什麼開源？

本專案以 AGPL-3.0 開源，基於兩個核心理念：

1. **分享設計與實作** — 將完整的工程實踐分享給開發者社群，包括 Signal Protocol 的實際應用、純前端影片分片加密串流管線（WebCodecs 轉碼 → per-chunk AES-256-GCM 加密 → MSE 串流解密播放），以及 Cloudflare Workers + Durable Objects 的全 Serverless 部署經驗。
2. **公開驗證安全性** — 端對端加密系統的信任應建立在可檢視的程式碼之上。本專案的密碼學實作（X3DH 金鑰交換、Double Ratchet、媒體分片加密、金鑰管理）皆開放審閱。完整的[安全審計文件](#安全審計與威脅模型)記錄了已知限制與修復狀態。

---

## 目錄

- [架構概覽](#架構概覽)
- [核心功能](#核心功能)
- [視訊通話架構](#視訊通話架構)
- [臨時對話 (Ephemeral Chat)](#臨時對話-ephemeral-chat)
- [分片加密串流](#分片加密串流)
- [Office 文件檢視器](#office-文件檢視器)
- [專案結構](#專案結構)
- [密碼學協定](#密碼學協定)
- [訊息流程架構](#訊息流程架構)
- [資料庫 Schema](#資料庫-schema)
- [API 端點](#api-端點)
- [WebSocket 即時通訊](#websocket-即時通訊)
- [Web Push 推播通知](#web-push-推播通知)
- [安全設計原則](#安全設計原則)
- [安全審計與威脅模型](#安全審計與威脅模型)
- [橫向部署與擴展優勢](#橫向部署與擴展優勢)
- [快速開始](#快速開始)
- [部署](#部署)
- [測試](#測試)
- [環境變數](#環境變數)

---

## 架構概覽

### 全 Serverless 雙層架構

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                     SENTRY Messenger                         │
                    └──────────────────────────────────────────────────────────────┘

  ┌──────────────────────┐                          ┌─────────────────────────────────┐
  │   Frontend (web/)    │                          │  Cloudflare Workers              │
  │                      │                          │  (data-worker/)                  │
  │  Cloudflare Pages    │─── HTTPS / WSS ────────▶│  API + WebSocket (Durable Objects)│
  │  Vanilla JS SPA      │                          │  D1 (SQLite) + R2 + KV           │
  │  esbuild bundler     │                          │                                  │
  └──────────────────────┘                          └─────────────────────────────────┘
         │                                                        │
  ┌──────┴──────┐                                         ┌───────┴───────┐
  │ X3DH + DR   │                                         │ D1 Database   │
  │ 客戶端加密   │                                         │ R2 媒體儲存   │
  │ IndexedDB   │                                         │ OPAQUE + SDM  │
  └─────────────┘                                         │ KV Sessions   │
                                                          │ Durable Objects│
                                                          │  (WebSocket)  │
                                                          └───────────────┘
```

1. **Frontend (`web/`)** — 純靜態 SPA，部署至 Cloudflare Pages，所有加密/解密在客戶端完成
2. **Cloudflare Workers (`data-worker/`)** — 統一後端，處理所有 REST API、WebSocket 即時通訊（Durable Objects）、OPAQUE 認證、SDM 驗證、金鑰管理，直接存取 D1/R2/KV

> **v0.1.9 架構遷移：** 原有的 Node.js Express + WebSocket 中繼層（`src/`）已完全移除。所有 API 端點與 WebSocket 連線管理已遷移至 Cloudflare Workers + Durable Objects，實現完全 Serverless 架構。不再需要 VPS、PM2 或任何伺服器維運。

---

## 核心功能

### 密碼學協定

| 功能 | 技術 | 說明 |
|------|------|------|
| 金鑰交換 | X3DH (Extended Triple Diffie-Hellman) | 非同步建立共享密鑰，支援離線初始化 |
| 訊息加密 | Double Ratchet | 每則訊息獨立金鑰，前向保密 + 後向保密 |
| 對稱加密 | XChaCha20-Poly1305 / AES-256-GCM | 訊息內容 AEAD 加密 |
| 身份驗證 | Ed25519 簽章 + OPAQUE PAKE | 密碼不經網路傳輸的認證協定 |
| NFC 認證 | NTAG 424 DNA SDM (CMAC/HKDF/EV2) | 實體 NFC 標籤身份綁定 |
| 金鑰派生 | HKDF-SHA256 / Argon2id | 金鑰衍生與密碼強化 |
| 主金鑰保護 | Argon2id + AES-256-GCM wrapping | 使用者密碼保護主金鑰 |
| 媒體分片加密 | HKDF-SHA256 → AES-256-GCM per-chunk | 每 chunk 獨立鑰匙與 IV，info tag 域分離 |
| 通話 E2EE | InsertableStreams + AES-GCM | WebRTC 逐幀加密，counter-based nonce，1 分鐘金鑰輪換 |
| 推播預覽 E2EE | ECDH P-256 + HKDF-SHA256 + AES-256-GCM | 推播通知預覽內容端對端加密，伺服器無法讀取 |

### 通訊功能

- **端對端加密訊息** — 文字、媒體、檔案均在客戶端加密，伺服器僅中繼密文
- **語音/視訊通話** — WebRTC P2P + Cloudflare TURN relay，InsertableStreams E2EE 媒體加密
- **AI 人臉/背景馬賽克** — MediaPipe Face Detection 三階段模糊（人臉馬賽克 / 背景馬賽克 / 關閉），三層偵測策略（Native FaceDetector → MediaPipe WASM → 膚色偵測）
- **分片加密串流** — 影片上傳自動轉碼為 fMP4，Per-chunk AES-256-GCM 加密，MSE/ManagedMediaSource 即時串流播放（單檔上限 1GB），AIMD 自適應併發控制
- **WebCodecs 智慧轉碼** — 所有影片自動轉碼至 720p/1.5Mbps H.264 fMP4（4K/1080p 自動縮放），HEVC/VP9 等非 H.264 格式自動轉碼，已是 H.264 且未超限時直接 remux 免轉碼，串流式轉碼→加密→上傳管線（低記憶體佔用）
- **臨時對話 (Ephemeral Chat)** — 一次性加密連結，未註冊 Guest 透過瀏覽器加入限時 E2EE 對話（X3DH + Double Ratchet），支援文字/圖片/語音視訊通話，倒數結束自動銷毀，7 語言 i18n
- **聯絡人邀請** — 加密 Invite Dropbox 機制（支援離線互加 + 確認回饋）
- **群組對話** — 多人加密聊天室，角色權限管理（owner/admin/member）
- **已讀回條** — Commit-driven 訊息狀態追蹤（✓ sent / ✓✓ delivered）
- **即時推播** — WebSocket 即時訊息通知與通話信令（Durable Objects per-account 隔離），推播預覽端對端加密（ECDH P-256 + AES-256-GCM，伺服器無法讀取通知內容）
- **訊息重播** — Message Key Vault 支援歷史訊息回放
- **聯絡人備份** — 加密備份/還原聯絡人密鑰至伺服器
- **訂閱管理** — 訂閱碼兌換、驗證、QR 掃描上傳與配額管理
- **軟刪除** — 訊息/對話 Cursor-based 軟刪除（timestamp 驅動）
- **頭像管理** — 聯絡人頭像上傳/下載（Presigned URL + R2）
- **媒體預覽** — 圖片檢視器、PDF 檢視器、媒體權限管理
- **Office 文件檢視器** — Word (.doc/.docx)、Excel (.xlsx/.xls)、PowerPoint (.pptx) 純前端解析與渲染，零伺服器依賴
- **檔案儲存空間** — Drive Pane 檔案管理，資料夾建立/瀏覽/上傳，配額管理（預設 3GB）
- **傳輸進度 UI** — 上傳/下載雙進度條，可展開處理步驟 checklist（格式偵測→轉碼→加密上傳），即時速度與已傳輸量顯示
- **SDM 模擬** — 開發用 NFC 標籤模擬（Sim Chips）
- **離線同步** — Hybrid Flow 離線/線上訊息同步、Gap 偵測與填補
- **帳號管理** — 管理員帳號清除（purge）與強制登出

### 安全特性

- **客戶端加密** — 訊息與媒體在客戶端加密後才離開裝置，伺服器僅儲存密文
- **前向保密 (Forward Secrecy)** — Double Ratchet 為每則訊息衍生獨立金鑰，設計上限制單一金鑰洩漏的影響範圍
- **後向保密 (Break-in Recovery)** — 新的 DH 交換後產生新的 Root Key，設計上使攻擊者無法持續解密後續訊息
- **抗重放攻擊** — Per-conversation Counter 單調遞增，伺服器端強制驗證
- **無 Fallback 政策** — 嚴格密碼協定，拒絕任何降級/重試/回滾
- **離線密鑰交換** — 透過 X3DH Prekey Bundle，對方離線時也能安全初始化
- **推播預覽 E2EE** — 推播通知預覽內容（發送者名稱、訊息摘要）在發送端以接收者裝置公鑰加密（ECDH P-256 + AES-256-GCM），伺服器僅中繼密文，Service Worker 在本地解密顯示
- **強制登出** — 帳號清除時透過 WebSocket `force-logout` 即時踢出所有裝置

> **已知限制：** 訊息與媒體內容在客戶端加密，伺服器不持有解密金鑰。但通訊 metadata（社交圖譜、時間戳、在線狀態等）對伺服器仍然可見。完整分析見 [Metadata Exposure](docs/security/metadata-exposure.md) 與 [Known Limitations](docs/security/known-limitations.md)。

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
- **DTLS**: ECDSA P-256 憑證，提供傳輸層加密
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
- 金鑰每 1 分鐘自動輪換

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
Pixelation (28×28 pixel blocks, 35% padding, ±30 color noise)
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

## 臨時對話 (Ephemeral Chat)

一次性加密臨時對話系統，允許已註冊使用者（Owner）產生一次性連結，讓未安裝 App 的外部人員（Guest）透過瀏覽器加入限時加密對話。倒數結束或任一方關閉頁面後，session 資料從伺服器端清除。

### 架構概覽

```
Owner (App 內)                  Cloudflare Worker                 Guest (瀏覽器)
─────────────                   ─────────────────                 ──────────────
     │                                │                                │
     │── POST create-link ───────────▶│ 建立 ephemeral_invites         │
     │◀── { token, session_id } ──────│                                │
     │                                │                                │
     │   分享連結 /e/{token}           │                                │
     │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ▶│
     │                                │                                │
     │                                │◀── POST consume { token } ─────│
     │                                │ 驗證 → 建立 ephemeral_sessions  │
     │                                │── { session, ownerBundle } ────▶│
     │                                │                                │
     │                                │    ┌── WebSocket 雙向連線 ──┐   │
     │                                │    │                        │   │
     │◀══════ ephemeral-key-exchange ══╪════╪════════════════════════╪═══│ Guest X3DH
     │ X3DH respond                   │    │                        │   │
     │══════ ephemeral-key-exchange-ack╪════╪════════════════════════╪══▶│
     │                                │    │                        │   │
     │◀═══ ephemeral-message (E2EE) ══╪════╪════════════════════════╪══▶│ DR 加密訊息
     │◀═══ ephemeral-call-* (信令) ═══╪════╪════════════════════════╪══▶│ 通話信令
     │                                │    │                        │   │
     │                                │    └────────────────────────┘   │
     │                                │                                │
     │                                │── session expired ────────────▶│ 倒數結束
     │                                │   清除 sessions + invites       │ 銷毀畫面
```

### 連結生命週期

#### 1. Owner 建立連結

Owner 在 App 內點擊「臨時對話」，前端產生 X3DH Prekey Bundle（`ik_pub`, `spk_pub`, `spk_sig`, `opks`），連同帳號驗證資訊一併送至後端：

```
POST /api/v1/ephemeral/create-link
{ account_token, account_digest, prekey_bundle }
→ { token, session_id, expires_at }
```

- 連結格式：`https://domain/e/{token}`
- 每位 Owner 最多同時擁有 **2 個**活躍 session
- 邀請連結有效期限預設 **24 小時**（未消費則自動過期）
- Owner 可在消費前撤銷連結（`POST /api/v1/ephemeral/revoke-invite`）

#### 2. Guest 消費連結

Guest 開啟連結，`boot()` 從 URL 解析 token（支援 `/e/{token}`、`#{token}`、`?t={token}` 三種格式）：

```
POST /api/v1/ephemeral/consume
{ token }
→ { session_id, conversation_id, guest_digest, guest_device_id, ws_token, expires_at, prekey_bundle, owner_digest }
```

- Token 僅能消費一次（`consumed_at` 標記）
- 消費後建立 `ephemeral_sessions` 記錄
- Guest 獲得臨時身份（`guest_digest` + `guest_device_id`）
- 返回 Owner 的 Prekey Bundle 供 X3DH 金鑰交換

#### 3. 連結過期與清理

- 未消費邀請：24 小時後過期（D1 `expires_at` 欄位）
- 已建立 Session：預設 **10 分鐘**倒數，可延長
- Owner 手動終止：`POST /api/v1/ephemeral/delete`
- Guest 主動結束：透過 WebSocket 發送 `ephemeral-guest-leave`

### 端對端加密 (E2EE)

臨時對話採用與主聊天相同的 Signal Protocol 加密流程（X3DH + Double Ratchet），訊息內容在客戶端加密後才經由伺服器中繼。

#### X3DH 金鑰交換

```
Owner (建立連結時)                              Guest (消費連結時)
────────────────                                ──────────────────
生成 Prekey Bundle:                             收到 Owner Bundle:
  ik_pub (身份金鑰)                               ik_pub, spk_pub, spk_sig, opks[0]
  spk_pub (簽名預金鑰)
  spk_sig (Ed25519 簽章)                         生成 Guest Bundle:
  opks[] (一次性預金鑰)                             ik_pub, spk_pub, spk_sig, ek_pub

                                                x3dhInitiate(guestPriv, ownerBundle)
                                                → ephDrState (Double Ratchet 初始狀態)

                                                透過 WS 發送 ephemeral-key-exchange
                         ◀─────────────────────── { guestBundle, opk_id }

x3dhRespond(ownerPriv, guestBundle)
→ ephDrState (匹配的 DR 狀態)

發送 ephemeral-key-exchange-ack ──────────────▶ keyExchangeComplete = true
```

- 金鑰交換具備**漸進式重試**機制（2s → 4s → 8s → 15s → 30s）
- 第 3 次重試起同時啟用 **HTTP Fallback**（`POST /api/v1/ephemeral/key-exchange-submit`），將 Guest Bundle 持久化至 D1，確保 Owner 離線/重連後仍可完成交換
- 收到 ACK 前，所有訊息發送被阻擋並提示「等待加密建立」

#### Double Ratchet 訊息加密

金鑰交換完成後，所有訊息（文字、圖片、控制訊息）皆經 Double Ratchet 加密：

```
明文 → drEncryptText(ephDrState, plaintext, { deviceId, version })
     → { header: { counter, deviceId, version }, iv_b64, ciphertext_b64 }

密文 → drDecryptText(ephDrState, { header, iv_b64, ciphertext_b64 })
     → 明文
```

- 每則訊息獨立金鑰（前向保密）
- Header 包含 counter（防重放）、deviceId、version
- 加密演算法：XChaCha20-Poly1305 / AES-256-GCM（AEAD）

### WebSocket 即時通訊

#### 連線建立

Guest 進入聊天後建立 WebSocket 連線：

```
WSS://{host}/api/ws?token={ws_token}&deviceId={guest_device_id}
→ 發送 { type: 'auth', accountDigest, token }
→ 收到 { type: 'auth', ok: true }
```

#### 訊息類型

| 類型 | 方向 | 說明 |
|------|------|------|
| `ephemeral-message` | 雙向 | E2EE 加密訊息（文字、圖片、控制） |
| `ephemeral-key-exchange` | Guest→Owner | Guest 的 X3DH 公開金鑰 |
| `ephemeral-key-exchange-ack` | Owner→Guest | Owner 確認金鑰交換完成 |
| `ephemeral-extended` | Server→雙方 | Session 延長通知（新 `expires_at`） |
| `ephemeral-deleted` | Server→Guest | Owner 終止 Session |
| `ephemeral-guest-leave` | Guest→Owner | Guest 主動結束對話 |
| `ephemeral-peer-reconnected` | Server→對方 | 對方重新連線 |
| `ephemeral-peer-disconnected` | Server→對方 | 對方斷線 |
| `ephemeral-call-*` | 雙向 | 通話信令（invite/offer/answer/accept/reject/ice-candidate/end） |

#### 斷線重連

- 指數退避重連：基礎 2s，上限 30s，加 30% 隨機抖動
- 重連前先刷新 WS Token（`POST /api/v1/ephemeral/ws-token`）
- Token 刷新失敗（session 過期/被刪除）→ 直接顯示銷毀畫面
- 重連成功後自動重新觸發未完成的金鑰交換
- 重連時伺服器發送 `ephemeral-peer-reconnected` 通知對方

#### 離線訊息緩衝

當對方無活躍 WebSocket 連線時（如頁面切到背景、斷線中），伺服器會暫存訊息：

- **緩衝上限**：每個對話最多 **50 則**訊息
- **緩衝 TTL**：**5 分鐘**過期自動清除
- **可緩衝類型**：`ephemeral-message`、`ephemeral-key-exchange`、`ephemeral-key-exchange-ack`
- 對方重新連線時自動按序 flush 所有緩衝訊息（`_flushEphemeralBuffers()`）
- 過期緩衝由 Durable Object alarm 定時清理

#### 控制訊息

透過 E2EE 加密通道傳送的特殊控制訊息（JSON `_ctrl` 欄位）：

| 控制類型 | 說明 |
|----------|------|
| `set-nickname` | Guest 設定暱稱，通知 Owner |
| `peer-away` | 頁面切到背景（`visibilitychange`） |
| `peer-back` | 頁面回到前景 |
| `no-webrtc` | 通知 Owner 此 Guest 瀏覽器不支援 WebRTC |

### 計時器與 Session 管理

#### 倒數計時器

- Session 建立時設定 `expires_at`（Unix timestamp）
- 前端每秒更新（`setInterval`），顯示 `MM:SS` 格式
- 進度條採用四色漸層（綠→黃→紅），搭配火焰 emoji 指示器
- 剩餘 ≤20% 時間：時鐘文字轉紅 + 呼吸動畫
- 倒數歸零：自動觸發 `destroyChat()`

#### Session 延長

- 剩餘 ≤5 分鐘時啟用「延長」按鈕
- 每次延長 **10 分鐘**
- 延長次數由 `extended_count` 追蹤
- Owner 或 Guest 均可觸發延長
- 延長後伺服器透過 `ephemeral-extended` 通知雙方同步新的 `expires_at`

#### Session 終止

三種終止方式：

1. **倒數結束** — 前端偵測 `remaining ≤ 0`，自動銷毀
2. **Owner 終止** — `POST /api/v1/ephemeral/delete`，伺服器發送 `ephemeral-deleted` 通知 Guest
3. **Guest 終止** — 點擊「結束」按鈕 → 確認 Modal → 發送 `ephemeral-guest-leave` → 銷毀畫面

銷毀流程（`destroyChat()`）：
1. 停止 Double Ratchet 金鑰交換重試
2. 停用 Ephemeral Call 模式
3. 清除計時器
4. 通知對方（若 WS 仍連線）
5. 關閉 WebSocket
6. 隱藏聊天 UI，顯示銷毀畫面
7. 清除所有狀態（`sessionState`, `ephDrState`, `sessionStorage`）

### 語音 / 視訊通話

臨時對話整合標準通話系統，透過 **Ephemeral Call Adapter** 橋接：

```
Guest UI                    Ephemeral Call Adapter              標準 Call Pipeline
─────────                   ──────────────────────              ─────────────────
voiceCallBtn.click()  ───▶  initiateEphemeralCall()
                            ↓
                            activateEphemeralCallMode({         initCallOverlay()
                              conversationId,                   initCallMediaSession()
                              sessionId,
                              peerDigest,
                              wsSend: (msg) => ws.send(msg),
                              side: 'guest'
                            })
                            ↓
                            ephemeral-call-* ◀══ 轉譯 ══▶ call-*
                            (WebSocket 訊息)              (標準信令)
```

- **WebRTC 偵測**：頁面載入時立即偵測（`boot()` 之前），檢查 `RTCPeerConnection` + `getUserMedia`
- 不支援時：Splash 畫面即顯示警告 → 暱稱畫面顯示警告 → 進入聊天後按鈕 disabled + 系統訊息通知 → 透過加密控制訊息通知 Owner
- **媒體預請求**：進入聊天時靜默播放 click 音效解鎖 Web Audio API，並預請求 mic + camera 權限（快取 60 秒）
- 通話信令透過 WebSocket `ephemeral-call-*` 訊息類型中繼

### Guest 端 UX 流程

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Splash 畫面    │     │   暱稱輸入畫面    │     │    聊天畫面      │     │   銷毀畫面       │
│                 │     │                 │     │                 │     │                 │
│ ① WebRTC 偵測   │     │ 火焰動畫頭像     │     │ Header (徽章)    │     │ 🔥              │
│ ② Matrix 動畫   │────▶│ 暱稱輸入 (≤20字) │────▶│ 倒數計時器       │────▶│ 對話已銷毀       │
│ ③ 進度條 0→100% │     │ WebRTC 警告      │     │ 訊息列表         │     │ 所有訊息已永久   │
│ ④ 驗證→加密→連線 │     │ 「加入對話」按鈕  │     │ 通話按鈕         │     │ 清除             │
│ ⑤ X3DH 金鑰交換 │     │                 │     │ 附件 + 輸入框    │     │                 │
└─────────────────┘     └─────────────────┘     │ 結束按鈕         │     └─────────────────┘
                                                └─────────────────┘
```

#### Splash 畫面（進度階段）

| 進度 | 狀態文字 | 實際操作 |
|------|----------|----------|
| 0% | 頁面載入 | WebRTC 偵測（`boot()` 之前） |
| 20% | 驗證連結有效性… | 解析 URL Token |
| 40% | 產生臨時身份金鑰… | 載入 NaCl 加密庫 |
| 60% | 交換加密協定… | 消費 Token + X3DH 金鑰交換 |
| 80% | 建立端對端加密通道… | 等待確認 |
| 100% | 連線完成 | 過渡至暱稱畫面 |

#### 錯誤處理

| HTTP 狀態 | 顯示訊息 |
|-----------|----------|
| 404 | 此連結已過期或已被使用 |
| 410 | 此連結已過期 |
| 其他 | 連線失敗：{error} |

### 資料庫 Schema

#### ephemeral_invites（一次性連結 Token）

| 欄位 | 類型 | 說明 |
|------|------|------|
| `token` | TEXT PK | 一次性邀請 Token |
| `owner_digest` | TEXT | Owner 帳號摘要（FK → accounts） |
| `owner_device_id` | TEXT | Owner 裝置 ID |
| `prekey_bundle_json` | TEXT | Owner X3DH Prekey Bundle（JSON） |
| `consumed_at` | INTEGER | 消費時間戳（NULL = 未消費） |
| `expires_at` | INTEGER | 過期時間戳 |
| `created_at` | INTEGER | 建立時間 |

#### ephemeral_sessions（活躍臨時對話）

| 欄位 | 類型 | 說明 |
|------|------|------|
| `session_id` | TEXT PK | Session 唯一 ID |
| `invite_token` | TEXT | 對應的邀請 Token |
| `owner_digest` | TEXT | Owner 帳號摘要 |
| `owner_device_id` | TEXT | Owner 裝置 ID |
| `guest_digest` | TEXT | Guest 臨時摘要 |
| `guest_device_id` | TEXT | Guest 臨時裝置 ID |
| `conversation_id` | TEXT | 對話 ID（FK → conversations） |
| `expires_at` | INTEGER | 過期時間戳（可延長） |
| `extended_count` | INTEGER | 延長次數 |
| `created_at` | INTEGER | 建立時間 |
| `deleted_at` | INTEGER | 軟刪除時間（NULL = 活躍） |
| `pending_key_exchange_json` | TEXT | HTTP Fallback 暫存 Guest 公開金鑰 Bundle |

索引：`owner+deleted_at`、`guest_digest`、`conversation_id`、`expires_at`

### API 端點 (`/api/v1/ephemeral/`)

| 方法 | 路徑 | 驗證 | 說明 |
|------|------|------|------|
| POST | `create-link` | Owner | 建立一次性連結（含 Prekey Bundle） |
| POST | `consume` | 無 | Guest 消費 Token，取得 Session 資訊 |
| POST | `extend` | Owner/Guest | 延長 Session 10 分鐘 |
| POST | `delete` | Owner | 終止 Session |
| POST | `revoke-invite` | Owner | 撤銷未消費的邀請連結 |
| POST | `list` | Owner | 列出所有活躍 Session |
| POST | `session-info` | Guest | 取得 Session 資訊（重連用） |
| POST | `ws-token` | Guest | 取得新 WebSocket Token（重連用） |
| POST | `key-exchange-submit` | Guest | HTTP Fallback 金鑰交換（持久化至 D1） |
| POST | `clear-pending-kex` | Owner | 清除已處理的待處理金鑰交換 |
| POST | `cleanup` | 系統 | 垃圾回收：清除過期 Session + 未消費邀請 |

#### 伺服器端路由與 Durable Objects

- **訊息路由**：`_handleEphemeralRelay()` 根據 `conversationId` / `sessionId` 查詢 `ephemeral_sessions` 表，確定目標 peer digest，透過對應 Durable Object 轉發
- **Owner 通知**：`notifyAccountDO()` — 路由至已註冊帳號的 AccountWebSocket DO
- **Guest 通知**：`notifyEphemeralDO()` — 路由至 `EPHEMERAL_` 前綴識別的臨時 Guest DO
- **WS Token**：HS256 JWT（`{ accountDigest, iat, exp }`），Guest token 有效期 = Session 剩餘時間

#### 社交分享預覽（OG Meta Tags）

臨時連結支援社交平台分享預覽（`/e/{token}` 路由 by Cloudflare Functions）：

- 爬蟲（社交平台 bot）：返回含 OG meta tags 的最小 HTML（不含 redirect）
- 真實瀏覽器：返回含 OG tags + JavaScript 即時 redirect 至 `/pages/ephemeral.html#{token}`
- 根據 `Accept-Language` / `?lang=` 參數提供本地化 OG 文字

### 安全設計

- **一次性 Token** — 32 字元 nano ID，使用 `UPDATE ... WHERE consumed_at IS NULL` 原子操作確保僅能消費一次
- **臨時身份** — Guest 獲得伺服器生成的臨時身份（`EPHEMERAL_` + 32 字元隨機 digest、`eph-` + 16 字元隨機 device_id），不關聯任何永久帳號
- **完整 E2EE** — 所有訊息（含控制訊息、圖片）皆經 Double Ratchet 加密，伺服器僅中繼密文
- **Session 限制** — 每位 Owner 最多 2 個同時活躍 Session
- **金鑰交換 Fallback** — WS 重試 + HTTP 持久化雙路徑，確保金鑰交換不會因網路問題永久失敗
- **前向保密** — 每則訊息使用獨立 DR 金鑰，洩漏不影響其他訊息
- **狀態銷毀** — Session 結束時清除所有客戶端狀態（`sessionState`、`ephDrState`、`sessionStorage`）
- **Peer Presence** — 透過 `visibilitychange` 事件偵測對方是否在前景，警告訊息可能未送達

### 國際化 (i18n)

臨時對話完整支援 **7 種語言**：English、繁體中文、簡體中文、日本語、한국어、ภาษาไทย、Tiếng Việt

- Splash 頁面採用**同步 XHR** 載入語言包（確保首次繪製即為正確語言）
- `boot()` 後非同步載入完整 i18n 模組
- 所有 UI 文字透過 `data-i18n`、`data-i18n-placeholder`、`data-i18n-html` 屬性標記
- 共計約 **70+ 個** ephemeral 專用 i18n key（涵蓋 splash、暱稱、聊天、通話、錯誤、計時器、終止等場景）

### 檔案結構

```
web/src/
├── pages/ephemeral.html                              # Guest 端完整 HTML（Splash + 暱稱 + 聊天 + 銷毀）
├── app/ui/ephemeral-ui.js                            # Guest 端控制器（Boot、WS、E2EE、Timer、Call）
├── app/ui/mobile/controllers/ephemeral-controller.js # Owner 端控制器（建立連結、管理 Session）
├── app/api/ephemeral.js                              # API 封裝（10 個端點）
├── app/features/calls/ephemeral-call-adapter.js      # 通話信令轉譯（ephemeral-call-* ↔ call-*）
├── shared/crypto/dr.js                               # Double Ratchet 加密/解密
├── shared/crypto/prekeys.js                          # X3DH Prekey Bundle 生成
└── locales/{en,zh-Hant,zh-Hans,ja,ko,th,vi}.json    # i18n 語言包

data-worker/
└── migrations/0010_add_ephemeral_sessions.sql         # DB Schema（invites + sessions）
```

---

## 分片加密串流

### 上傳流程

```
使用者選擇檔案
  ↓
格式偵測 (canRemuxVideo)
  ↓                                    ┌─────────────────────────────┐
  ├── 影片檔案 ──▶ WebCodecs 轉碼?     │  WebCodecs 自動轉碼 720p     │
  │                  │                  │  所有影片 → 720p/1.5Mbps     │
  │                  ├── 需要轉碼 ──────│  4K/1080p 自動縮放至 720p    │
  │                  ├── 已是 H.264 ────│  超限→轉碼，未超限→直接 remux │
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

## Office 文件檢視器

純前端 Office 文件解析與渲染引擎，**零伺服器依賴、零第三方渲染服務**。直接在瀏覽器內解析二進位/XML 格式並轉換為 HTML，支援 Word (.doc/.docx)、Excel (.xlsx/.xls)、PowerPoint (.pptx)。

### 架構

```
加密檔案 (R2)
    │
    ▼
客戶端解密 (AES-256-GCM)
    │
    ├── .docx/.xlsx/.pptx ──▶ JSZip 解壓 ──▶ OOXML XML 解析 ──▶ HTML 渲染
    │
    └── .doc ──▶ OLE2 Compound Binary 解析 ──▶ Piece Table + Sprm ──▶ HTML 渲染
```

所有解析在客戶端記憶體內完成，文件明文不離開瀏覽器，符合端對端加密原則。

### Word 檢視器 (.doc / .docx)

自行實作的完整 Word 文件解析器，不依賴任何 Word 渲染函式庫。支援兩種格式的完整規格：

#### .docx — OOXML (ECMA-376) 規格支援

**表格屬性 (§17.4)**

| 規格章節 | 元素 | 功能 | 狀態 |
|----------|------|------|------|
| §17.4.63 | `tblW` | 表格寬度 (dxa/pct/auto) | ✅ |
| §17.4.29 | `jc` | 表格水平對齊 (center/right/end) | ✅ |
| §17.4.51 | `tblInd` | 表格左縮排 | ✅ |
| §17.4.53 | `tblLayout` | 固定/自動佈局 | ✅ |
| §17.4.46 | `tblCellSpacing` | 儲存格間距 | ✅ |
| §17.4.40 | `tblBorders` | 表格邊框 (6 邊粒度解析 + insideH/V 回退) | ✅ |
| §17.4.42 | `tblCellMar` | 表格預設儲存格邊距 | ✅ |
| — | `tblGrid` | 欄寬定義 (colgroup) | ✅ |
| §17.4.82 | `trHeight` | 行高 (exact/atLeast) | ✅ |
| §17.4.17 | `gridSpan` | 水平合併 (colspan) | ✅ |
| §17.4.85 | `vMerge` | 垂直合併 (rowspan，含 gridSpan 索引計算) | ✅ |
| §17.4.22 | `hMerge` | 舊式水平合併 (legacy) | ✅ |
| §17.4.66 | `tcBorders` | 儲存格邊框 (per-cell override) | ✅ |
| §17.4.33 | `shd` | 儲存格著色 | ✅ |
| §17.4.84 | `vAlign` | 垂直對齊 | ✅ |
| §17.4.68 | `tcW` | 儲存格寬度 (dxa/pct) | ✅ |
| §17.4.43 | `tcMar` | 儲存格個別邊距 | ✅ |
| §17.4.87 | `textDirection` | 儲存格文字方向 (btLr/tbRl) | ✅ |
| §17.4.30 | `noWrap` | 儲存格不換行 | ✅ |
| — | 巢狀表格 | 遞迴 renderTable | ✅ |

**字元格式 (§17.3.2 rPr)**

| 規格章節 | 元素 | 功能 | 狀態 |
|----------|------|------|------|
| §17.3.2.1 | `b` / `bCs` | 粗體 (含 val=false 明確關閉) | ✅ |
| §17.3.2.16 | `i` / `iCs` | 斜體 (含 val=false 明確關閉) | ✅ |
| §17.3.2.40 | `u` | 底線 (樣式: double/dotted/dashed/wavy + 顏色) | ✅ |
| §17.3.2.37 | `strike` | 刪除線 | ✅ |
| §17.3.2.9 | `dstrike` | 雙刪除線 | ✅ |
| §17.3.2.38 | `sz` / `szCs` | 字型大小 | ✅ |
| §17.3.2.6 | `color` | 文字顏色 | ✅ |
| §17.3.2.26 | `rFonts` | 字型 (ascii/hAnsi/eastAsia/cs) | ✅ |
| §17.3.2.15 | `highlight` | 螢光筆標記 | ✅ |
| §17.3.2.30 | `shd` | 字元背景 | ✅ |
| §17.3.2.42 | `vertAlign` | 上標/下標 | ✅ |
| §17.3.2.32 | `smallCaps` | 小型大寫 | ✅ |
| §17.3.2.5 | `caps` | 全部大寫 | ✅ |
| §17.3.2.41 | `vanish` | 隱藏文字 | ✅ |
| §17.3.2.25 | `outline` | 文字外框 | ✅ |
| §17.3.2.31 | `shadow` | 陰影效果 | ✅ |
| §17.3.2.10 | `emboss` | 浮凸效果 | ✅ |
| §17.3.2.18 | `imprint` | 陰刻效果 | ✅ |
| §17.3.2.35 | `spacing` | 字元間距 (letter-spacing) | ✅ |
| §17.3.2.44 | `w` | 字元寬度縮放 | ✅ |
| §17.3.2.27 | `position` | 文字升降 | ✅ |
| §17.3.2.4 | `bdr` | 字元邊框 | ✅ |
| §17.3.2.11 | `em` | 東亞著重號 | ✅ |

**段落格式 (§17.3.1 pPr)**

| 元素 | 功能 | 狀態 |
|------|------|------|
| `jc` | 對齊 (left/center/right/justify) | ✅ |
| `spacing` | 段前/段後/行距 | ✅ |
| `ind` | 縮排 (left/right/firstLine/hanging) | ✅ |
| `pBdr` | 段落邊框 | ✅ |
| `shd` | 段落背景 | ✅ |
| `pageBreakBefore` | 分頁 | ✅ |
| `outlineLvl` | 標題層級 | ✅ |
| `numPr` | 清單編號/項目符號 | ✅ |
| `pStyle` + `basedOn` | 樣式繼承鏈 | ✅ |
| `docDefaults` | 文件預設樣式 | ✅ |

**其他功能**

| 功能 | 狀態 |
|------|------|
| 內嵌圖片 (`<w:drawing>`) | ✅ |
| 舊式圖片 (`<w:pict>`) | ✅ |
| 超連結 (`<w:hyperlink>`) | ✅ |
| OMML 數學公式 | ✅ |
| 分頁符號 / 換行 / Tab | ✅ |
| 書籤 / 校對標記 | ✅ (跳過) |

#### .doc — MS-DOC Binary ([MS-DOC]) 規格支援

**二進位解析管線**

```
OLE2 Compound File → FAT/Mini-FAT → WordDocument Stream + Table Stream
    → FIB (File Information Block)
    → Piece Table (FC ↔ CP 映射)
    → PlcBteChpx (字元格式)
    → PlcBtePapx (段落格式)
    → SttbfFfn (字型表)
    → LSTF/LFO (清單定義)
    → OfficeArt (圖片)
    → OLE Embedding (圖表)
```

**表格屬性 (TAP Sprms)**

| Sprm 代碼 | 名稱 | 功能 | 狀態 |
|-----------|------|------|------|
| 0xD608 | sprmTDefTable | 儲存格邊界 + TC 結構 (merge flags + BRC80 borders + fVertical) | ✅ |
| 0xD612 | sprmTDefTableShd | 儲存格著色 (SHD) | ✅ |
| 0xD613 | sprmTDefTableShd2nd | 備用著色格式 | ✅ |
| 0xD670 | sprmTCellShd | 新版儲存格著色 | ✅ |
| 0x5400 | sprmTJc | 表格對齊 (Word 97) | ✅ |
| 0x5407 | sprmTJc90 | 表格對齊 (Word 2000+) | ✅ |
| 0x9407 | sprmTDyaRowHeight | 行高 (exact/at-least) | ✅ |
| 0x9601 | sprmTDxaLeft | 表格左縮排 | ✅ |
| 0x9602 | sprmTDxaGapHalf | 儲存格間距 | ✅ |
| 0xD62F | sprmTCellPadding | 儲存格邊距 | ✅ |
| 0xD634 | sprmTBrcTopCv | 上邊框 RGB 顏色向量 | ✅ |
| 0xD635 | sprmTBrcLeftCv | 左邊框 RGB 顏色向量 | ✅ |
| 0xD636 | sprmTBrcBottomCv | 下邊框 RGB 顏色向量 | ✅ |
| 0xD637 | sprmTBrcRightCv | 右邊框 RGB 顏色向量 | ✅ |
| 0xD605 | sprmTTableBorders | 表格邊框 (BRC 格式，6 邊粒度) | ✅ |
| 0xD620 | sprmTTableBorders80 | 表格邊框 (BRC80 格式) | ✅ |

**TC 結構 ([MS-DOC] §2.9.327)**

| 欄位 | 功能 | 狀態 |
|------|------|------|
| fFirstMerged / fMerged | 水平合併 (colspan) | ✅ |
| fVertMerge / fVertRestart | 垂直合併 (rowspan) | ✅ |
| fVertical / fBackward | 文字方向 | ✅ |
| fRotateFont | 字型旋轉 | ✅ |
| wWidth | 偏好儲存格寬度 | ✅ |
| BRC80 × 4 | 四邊邊框 (ico → RGB + brcType → CSS) | ✅ |

**字元格式 (CHP Sprms)**

| Sprm 代碼 | 名稱 | 功能 | 狀態 |
|-----------|------|------|------|
| 0x0835 | sprmCFBold | 粗體 | ✅ |
| 0x0836 | sprmCFItalic | 斜體 | ✅ |
| 0x0837 | sprmCFStrike | 刪除線 | ✅ |
| 0x0875 | sprmCFDStrike | 雙刪除線 | ✅ |
| 0x0838 | sprmCFOutline | 文字外框 | ✅ |
| 0x083C | sprmCFShadow | 陰影 | ✅ |
| 0x0858 | sprmCFEmboss | 浮凸 | ✅ |
| 0x0854 | sprmCFImprint | 陰刻 | ✅ |
| 0x083A | sprmCFSmallCaps | 小型大寫 | ✅ |
| 0x083B | sprmCFCaps | 全部大寫 | ✅ |
| 0x0839 | sprmCFVanish | 隱藏文字 | ✅ |
| 0x2A3E | sprmCKul | 底線類型 (single/double/dotted/dashed/wavy) | ✅ |
| 0x4A43 | sprmCHps | 字型大小 | ✅ |
| 0x6870 | sprmCCv | 文字顏色 (COLORREF) | ✅ |
| 0x6877 | sprmCCvUl | 底線顏色 | ✅ |
| 0x4A4F/50/51 | sprmCRgFtc0/1/2 | 字型索引 (ASCII > Other > EastAsia 優先) | ✅ |
| 0x4845 | sprmCIco | 舊式顏色索引 (Word 97) | ✅ |
| 0x2A0C | sprmCHighlight | 螢光筆標記 | ✅ |
| 0x484B | sprmCHpsPos | 上下標位移 (signed half-points) | ✅ |
| 0x2A42 | sprmCIss | 上下標 (iss 格式) | ✅ |
| 0x8840 | sprmCDxaSpace | 字元間距 | ✅ |
| 0x4A61 | sprmCHpsKern | 字距微調 | ✅ |
| 0x6878 | sprmCBrc80 | 字元邊框 | ✅ |

**段落格式 (PAP Sprms)**

| Sprm 代碼 | 功能 | 狀態 |
|-----------|------|------|
| sprmPJc80 / sprmPJc | 對齊 | ✅ |
| sprmPDyaBefore / After | 段前/段後 | ✅ |
| sprmPDxaLeft / Right / Left1 | 縮排 | ✅ |
| sprmPDyaLine | 行距 (proportional/exact/at-least) | ✅ |
| sprmPOutLvl | 標題層級 | ✅ |
| sprmPIlvl / sprmPIlfo | 清單層級/格式 | ✅ |
| sprmPShd80 | 段落背景 | ✅ |
| sprmPBrcTop80 / Left / Bottom / Right | 段落邊框 | ✅ |
| sprmPFPageBreakBefore | 分頁 | ✅ |
| sprmPFInTable / sprmPFTtp | 表格隸屬標記 | ✅ |
| 樣式繼承 (istd + STSH) | 段落/字元樣式鏈解析 | ✅ |
| LSTF / LFO | 清單定義 + 覆蓋 | ✅ |

**其他功能**

| 功能 | 狀態 |
|------|------|
| OLE2 Compound File 解析 | ✅ |
| FIB (File Information Block) | ✅ |
| Piece Table (FC ↔ CP) | ✅ |
| SttbfFfn 字型表解析 | ✅ |
| OfficeArt 圖片抽取 | ✅ |
| OLE 嵌入圖表 | ✅ |
| HYPERLINK 欄位解析 | ✅ |
| 數學公式 (OMML) | ✅ |
| Fallback 文字擷取 | ✅ |

### OOXML 邊框樣式映射

Word 的 24 種邊框類型對應至 CSS：

| Word 邊框 | CSS 樣式 |
|-----------|----------|
| single, thick, thinThick*, thickThin* | solid |
| double, triple | double |
| dotted | dotted |
| dashed, dashSmallGap, dotDash, dotDotDash, dashDotStroked | dashed |
| wave | solid |
| doubleWave | double |
| threeDEmboss | ridge |
| threeDEngrave | groove |
| outset | outset |
| inset | inset |

### 規格覆蓋率

| 領域 | 覆蓋率 | 備註 |
|------|--------|------|
| DOCX 表格 (ECMA-376 §17.4) | ~95% | 僅缺 `tblStyle` 完整表格樣式定義解析 |
| MS-DOC 表格 ([MS-DOC] TAP) | ~98% | 僅缺 sprmTSetBrc 等極罕見 sprm |
| DOCX 字元格式 (§17.3.2) | ~95% | 僅缺 `kern`/`effect`(legacy)/`fitText` |
| MS-DOC 字元格式 (CHP) | ~97% | 僅缺 sprmCFBiDi 等 complex script |
| DOCX 段落格式 (§17.3.1) | ~95% | 核心屬性完整 |
| MS-DOC 段落格式 (PAP) | ~95% | 核心屬性完整 |

---

## 專案結構

```
SENTRY-Messenger/
│
├── data-worker/                      # ═══ Cloudflare Workers 統一後端 ═══
│   ├── src/
│   │   ├── worker.js                 # 主入口：REST API 路由、HMAC 驗證、
│   │   │                             #   OPAQUE/SDM 認證、D1/R2/KV 操作、
│   │   │                             #   金鑰管理、訊息 CRUD、媒體簽章、
│   │   │                             #   通話管理、聯絡人/群組/訂閱 API
│   │   ├── account-ws.js             # Durable Object：per-account WebSocket 管理
│   │   │                             #   JWT 認證、心跳、通話信令轉發、
│   │   │                             #   Presence (KV)、訊息/事件廣播
│   │   └── u8-strict.js              # Uint8Array 驗證工具
│   ├── package.json                  # Worker 依賴 (@cloudflare/opaque-ts)
│   ├── migrations/                   # D1 資料庫遷移
│   │   ├── 0001_consolidated.sql     # 主要 Schema（核心表）
│   │   ├── 0002_fix_missing_tables.sql  # 補建缺失表（contact_secret_backups 等）
│   │   ├── 0003_restore_deletion_cursors.sql  # deletion_cursors + legacy prekey
│   │   ├── 0004_add_conversation_deletion_log.sql  # 對話刪除紀錄表
│   │   ├── 0005_add_min_ts_to_deletion_cursors.sql # 新增 min_ts 欄位
│   │   ├── 0006_drop_min_counter_from_deletion_cursors.sql # 移除 min_counter
│   │   └── 0007_add_pairing_code.sql # 配對碼支援
│   └── wrangler.toml                 # Workers 設定 (D1 + KV + Durable Objects bindings)
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
│       │   │   ├── chunked-upload.js #   分片加密上傳（自動 720p 轉碼 + fMP4 + AES-GCM + AIMD 自適應併發）
│       │   │   ├── chunked-download.js #  分片解密下載（AIMD 自適應併發 + URL 預取）
│       │   │   ├── adaptive-concurrency.js # AIMD 自適應併發控制器（TCP 壅塞控制啟發）
│       │   │   ├── mse-player.js    #   MSE/ManagedMediaSource 串流播放器
│       │   │   ├── webcodecs-transcoder.js # WebCodecs 自動 720p/1.5Mbps H.264 轉碼器
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
│       │   │       │   ├── pdf-viewer.js    #   PDF 檢視器
│       │   │       │   ├── word-viewer.js   #   Word (.doc/.docx) 檢視器
│       │   │       │   ├── excel-viewer.js  #   Excel (.xlsx/.xls) 檢視器
│       │   │       │   └── pptx-viewer.js   #   PowerPoint (.pptx) 檢視器
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
│   ├── deploy-hybrid.sh              # 一鍵部署
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
| 推播預覽加密 | ECDH P-256 + AES-256-GCM | 96 bit (IV) |
| 推播預覽金鑰派生 | HKDF-SHA256 (info: `sentry-push-preview-v1`) | — |

### NFC 認證 (NTAG 424 DNA SDM)

```
NFC 標籤 tap → UID + Counter + CMAC
                       ↓
              Worker: HKDF/EV2 金鑰派生 (NTAG424_KM + salt)
                       ↓
              Worker: AES-CMAC 驗證 (RFC 4493) → Counter 單調性檢查 (防重放)
                       ↓
              KV session 發放 (TTL 300s) + 帳號 token
```

- AES-CMAC 使用 Web Crypto API AES-CBC 模擬 ECB（`nodejs_compat`）
- 支援 HKDF-SHA256 與 EV2-CMAC 兩種金鑰派生模式
- 支援 `NTAG424_KM_OLD` legacy key 自動 fallback

### OPAQUE 密碼認證

- 基於 P-256 曲線的 OPAQUE PAKE 協定（`@cloudflare/opaque-ts`）
- 完全在 Cloudflare Worker 執行
- 兩階段流程: `register-init` → `register-finish` / `login-init` → `login-finish`
- `login-init` 產生的 `expected` 暫存於 KV（TTL 120s），`login-finish` 消費後刪除
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
WebSocket 通知對方             # secure-message 事件（經 Durable Object 轉發）
```

### 接收流程

```
WebSocket: "secure-message" 事件（Durable Object → Client）
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

> 所有 API 端點均由 Cloudflare Workers 統一處理，前端直連 Worker URL。

### 認證 (`/api/v1/auth/`)

| 端點 | 方法 | 說明 | 狀態儲存 |
|------|------|------|----------|
| `/auth/sdm/exchange` | POST | NFC 標籤 SDM 認證 → 帳號 token | KV session (TTL 300s) |
| `/auth/sdm/debug-kit` | POST | 產生測試用 SDM 憑證 | KV counter (TTL 24h) |
| `/auth/brand` | GET | 品牌查詢（splash 用） | — |
| `/auth/opaque/register-init` | POST | OPAQUE 註冊初始化 | — |
| `/auth/opaque/register-finish` | POST | OPAQUE 註冊完成 → D1 | — |
| `/auth/opaque/login-init` | POST | OPAQUE 登入初始化 | KV expected (TTL 120s) |
| `/auth/opaque/login-finish` | POST | OPAQUE 登入完成 → Session Key | KV 消費後刪除 |
| `/auth/opaque/debug` | GET | OPAQUE 設定除錯（非敏感資訊） | — |
| `/mk/store` | POST | 儲存 wrapped MK（首次設定，消費 session） | KV session 單次消費 |
| `/mk/update` | POST | 更新 wrapped MK（變更密碼） | — |

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

### 其他

| 端點 | 方法 | 說明 |
|------|------|------|
| `/friends/delete` | POST | 刪除聯絡人 |
| `/ws/token` | POST | 取得 WebSocket JWT token |
| `/account/evidence` | GET | 取得帳號資訊 |
| `/health` | GET | 健康檢查 |
| `/status` | GET | 服務狀態 |

---

## WebSocket 即時通訊

### 架構

WebSocket 連線由 **Cloudflare Durable Objects** 管理（`AccountWebSocket` class），每個帳號對應一個 Durable Object 實例，支援同一帳號多裝置同時連線。

```
Client                          Worker                         Durable Object
  │                                │                               │
  │── POST /ws/token ─────────────▶│                               │
  │◀── JWT token ─────────────────│                               │
  │                                │                               │
  │── WebSocket /ws ──────────────▶│── Upgrade ──────────────────▶│
  │                                │                               │
  │◀─── hello (server greeting) ──────────────────────────────────│
  │──── auth (JWT token) ─────────────────────────────────────────▶│
  │◀─── auth_ok / auth_fail ─────────────────────────────────────│
  │                                                                │
  │◀─── secure-message / call-invite / presence-update ───────────│
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

## Web Push 推播通知

### 架構概覽

```
 發送者                    Cloudflare Worker (DO)              接收者裝置
┌────────┐  POST /messages  ┌──────────────────────┐  Web Push API  ┌─────────────┐
│ Client │ ───────────────▶ │ notifyAccountDO()    │ ────────────▶  │ Service     │
│  E2E   │  encrypted_      │   ↓                  │                │ Worker (SW) │
│ encrypt│  previews{}      │ _sendPushNotifications│                │   ↓         │
└────────┘                  │   ↓ VAPID + AES-GCM  │                │ E2E decrypt │
                            │   ↓ RFC 8291/8292    │                │ → showNotify│
                            └──────────────────────┘                └─────────────┘
```

推播通知基於 W3C Push API 標準，使用 VAPID 身份驗證（RFC 8292）和 AES-128-GCM 傳輸加密（RFC 8291）。所有推播流程在 Cloudflare Workers Durable Objects 內完成，不依賴第三方推播服務。

推播通知預覽內容（發送者名稱、訊息摘要、訊息類型）採用**端對端加密**：發送端以接收者裝置的 ECDH P-256 公鑰加密預覽內容（AES-256-GCM），伺服器僅中繼密文，Service Worker 使用裝置私鑰在本地解密後顯示通知。

### E2E 推播預覽加密

```
發送端 (Sender)                                      接收端 (Service Worker)
───────────────                                      ──────────────────────
1. 取得接收者裝置公鑰                                  1. 收到推播 payload (密文)
   GET /d1/push/preview-keys                            ↓
       ↓                                             2. 從 IndexedDB 載入裝置私鑰
2. 產生 Ephemeral ECDH P-256 keypair                    ↓
       ↓                                             3. ECDH(device_private, ephemeral_public)
3. ECDH(ephemeral_private, device_public)                → shared secret
   → shared secret                                      ↓
       ↓                                             4. HKDF-SHA256(shared, info="sentry-push-preview-v1")
4. HKDF-SHA256(shared, info="sentry-push-preview-v1")    → AES-256-GCM key
   → AES-256-GCM key                                    ↓
       ↓                                             5. AES-256-GCM 解密
5. AES-256-GCM 加密 {title, body, msgType}               → {title, body, msgType}
       ↓                                                ↓
6. 組合: [ephemeral_pub(65B) | IV(12B) | ciphertext]  6. 顯示通知
       ↓
7. Base64URL 編碼 → encrypted_previews[device_id]
```

| 屬性 | 說明 |
|------|------|
| 加密演算法 | ECDH P-256 + HKDF-SHA256 + AES-256-GCM |
| 金鑰隔離 | 每台裝置獨立 ECDH 金鑰對，私鑰僅存於裝置 IndexedDB |
| 前向保密 | 每次加密使用新的 Ephemeral keypair |
| 伺服器零知識 | 伺服器僅儲存裝置公鑰，無法解密預覽內容 |
| Wire Format | `[ephemeral P-256 pubkey (65B)] + [IV (12B)] + [ciphertext + GCM tag (16B)]` |

### 隱私設計

| 原則 | 說明 |
|------|------|
| 預覽 E2E 加密 | 推播預覽內容（發送者、訊息摘要）以接收者裝置公鑰加密，伺服器僅中繼密文 |
| Fallback 零內容 | 若裝置未註冊預覽公鑰或解密失敗，推播 payload 僅含 `{ title: "SENTRY MESSENGER" }`，不暴露任何內容 |
| 客戶端 i18n | 通知文字由 Service Worker 根據接收者的 `navigator.language` 在本地解析，伺服器不傳送任何語系資訊 |
| 訂閱隔離 | 每個 `account_digest` 獨立管理訂閱端點，Durable Object 隔離確保無跨帳號洩漏 |

### 訊息類型過濾

並非所有訊息都觸發推播。伺服器端執行兩層過濾：

**第一層 — 通知類型白名單（Notification Type Allowlist）**

僅以下 5 種通知類型允許觸發推播：

| 通知類型 | 說明 |
|----------|------|
| `secure-message` | 1:1 加密訊息 |
| `message-new` | 一般新訊息 |
| `biz-conv-message` | 群組對話訊息 |
| `call-invite` | 通話邀請 |
| `notify` | 系統通知 |

**第二層 — 控制訊息排除（Control Message Exclusion）**

即使通知類型通過第一層，若訊息的 `msgType`（從 `header_json` 提取）屬於以下控制類型，仍不發送推播：

```
read-receipt, delivery-receipt, session-init, session-ack, session-error,
profile-update, contact-share, conversation-deleted, placeholder
```

### 多語系支援 (i18n)

Service Worker 內嵌翻譯字典，根據接收者瀏覽器語系自動選擇通知文字：

| 語系 | 通知內容 |
|------|---------|
| `en` | You have a new message |
| `zh-Hant` | 你有一則新訊息 |
| `zh-Hans` | 你有一条新消息 |
| `ja` | 新しいメッセージがあります |
| `ko` | 새 메시지가 있습니다 |
| `th` | คุณมีข้อความใหม่ |
| `vi` | Bạn có tin nhắn mới |

語系解析邏輯與主應用的 `locales/index.js` 一致（BCP-47 標準化），不支援的語系自動 fallback 至英文。

### 訂閱管理

| 操作 | 端點 | 說明 |
|------|------|------|
| 註冊訂閱 | `POST /d1/push/subscribe` | 儲存 endpoint + p256dh + auth + preview_public_key 至 `push_subscriptions` |
| 取消訂閱 | `POST /d1/push/unsubscribe` | 移除指定 endpoint |
| 列出訂閱 | `POST /d1/push/list` | 列出帳號下所有推播訂閱 |
| 預覽公鑰查詢 | `POST /d1/push/preview-keys` | 取得接收者所有裝置的預覽加密公鑰（發送端用） |
| PIN 產生 | `POST /d1/push/pin/generate` | 產生 6 位數 PIN 碼（iOS PWA 訂閱用） |
| PIN 驗證 | `POST /d1/push/pin/verify` | 驗證 PIN 並完成訂閱（iOS PWA） |
| 自動清理 | — | 推送時收到 404/410 回應自動刪除失效訂閱 |

### 平台相容性

| 平台 | 支援狀態 | 備註 |
|------|---------|------|
| Chrome / Edge (Desktop & Android) | 完整支援 | 關閉瀏覽器後仍可接收 |
| Firefox (Desktop & Android) | 完整支援 | |
| Safari (macOS 13+) | 完整支援 | 需允許通知權限 |
| iOS Safari (16.4+) | PWA 模式支援 | 必須先加入主畫面（Add to Home Screen），支援 PIN 碼訂閱流程 |

### 相關檔案

| 檔案 | 說明 |
|------|------|
| `web/src/sw.js` | Service Worker — 推播接收、E2E 預覽解密、i18n、通知顯示 |
| `web/src/app/crypto/push-preview.js` | 推播預覽 E2E 加密/解密（ECDH P-256 + AES-256-GCM） |
| `web/src/app/features/push-preview-keys.js` | 推播預覽金鑰管理（產生、儲存、註冊） |
| `web/src/app/features/push-subscription.js` | 推播訂閱生命週期管理 |
| `web/src/app/features/queue/outbox.js` | 發送端 — 取得接收者公鑰並加密預覽 |
| `data-worker/src/account-ws.js` | Durable Object — `_sendPushNotifications()` 推播發送 |
| `data-worker/src/web-push.js` | VAPID JWT + AES-128-GCM 傳輸加密實作（RFC 8291/8292） |
| `data-worker/migrations/0015_add_push_subscriptions.sql` | 推播訂閱表 schema（含 `preview_public_key` 欄位） |
| `web/src/app/ui/mobile/modals/push-modal.js` | 前端推播設定 UI |

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

### 伺服器端資料處理

伺服器不持有訊息內容的解密金鑰。通訊 metadata（社交圖譜、時間戳等）仍對伺服器可見（詳見 [Metadata Exposure](docs/security/metadata-exposure.md)）：

- 訊息以 `ciphertext_b64` + `header_json` 儲存，解密金鑰僅存在於客戶端
- 聯絡人資料以 `encrypted_blob` 儲存，解密金鑰僅存在於客戶端
- Master Key 以 Argon2id + AES-GCM 包裝後儲存，需使用者密碼才能解包

### Commit-driven Side Effects

- **通知/未讀/音效** — 僅在 B route commit（vaultPut + DR snapshot 成功）後觸發
- **Placeholder reveal** — 僅在 commit 後替換
- WebSocket/fetch/probe 不直接產生 user-visible side effects

### Counter 完整性

- 每個 conversation 維護**單調遞增 counter**
- 伺服器端強制驗證 `counter > max_counter`
- 客戶端 per-conversation 序列化處理，防止並行推進

---

## 安全審計與威脅模型

本專案維護完整的安全文件，所有分析均基於實際程式碼掃描，可回溯至具體程式碼位置。

### 架構與協定

| 文件 | 說明 |
|------|------|
| [Protocol Overview](docs/security/protocol-overview.md) | 系統各協議的實際實作狀態，涵蓋註冊、X3DH、Double Ratchet、訊息傳輸等完整流程 |
| [Security Architecture](docs/security/security-architecture.md) | 整體安全架構分析，包括加密層、信任邊界、資料流與各元件安全性質 |
| [Key Management](docs/security/key-management.md) | 所有金鑰類型的完整盤點 — 用途、產生方式、儲存位置、生命週期與輪換機制 |
| [Message Lifecycle](docs/security/message-lifecycle.md) | 一則訊息從發送到接收的完整安全生命週期追蹤 |
| [Media & Attachment Security](docs/security/media-and-attachment-security.md) | 媒體檔案從選擇、加密、分片上傳到串流解密播放的完整安全分析 |

### 威脅模型與風險評估

| 文件 | 說明 |
|------|------|
| [Threat Model](docs/security/threat-model.md) | 威脅模型定義 — 攻擊者能力假設、安全目標、防護範圍 |
| [Trust Boundaries](docs/security/trust-boundaries.md) | 系統中各信任邊界與元件間的信任關係分析 |
| [Metadata Exposure](docs/security/metadata-exposure.md) | 伺服器、儲存層、網路觀察者各自可見的中繼資料盤點 |
| [Data Classification](docs/security/data-classification.md) | 系統中各類資料的機密等級分類（C1–C5） |
| [Security Assumptions & Out of Scope](docs/security/security-assumptions-and-out-of-scope.md) | 明確區分系統承諾防護與不承諾防護的項目 |

### 審計與發現

| 文件 | 說明 |
|------|------|
| [Security Review Checklist](docs/security/security-review-checklist.md) | 供內部或第三方審計使用的逐項檢查清單，每項對應具體程式碼位置 |
| [Security Findings by Severity](docs/security/security-findings-by-severity.md) | 所有安全發現依嚴重程度排序（Critical → Low），含修復狀態追蹤 |
| [Repo Findings Summary](docs/security/repo-findings-summary.md) | 完整倉庫掃描的安全發現摘要 |
| [Audit Readiness](docs/security/audit-readiness.md) | 各模組對第三方安全審計的準備度評估 |
| [Known Limitations](docs/security/known-limitations.md) | 已知限制與尚未完整實作的安全性質（誠實揭露） |
| [Open Questions](docs/security/open-questions.md) | 掃描過程中發現的未解決問題，待進一步確認 |

### 供應鏈完整性（Supply Chain Integrity）

E2EE 產品的安全邊界即客戶端程式碼本身。為確保使用者執行的 bundle 未經竄改且可獨立驗證：

#### 公開驗證端點

```
GET /.well-known/sentry-build.json
```

回傳當前部署的完整建構元資料：

| 欄位 | 內容 |
|------|------|
| `build.commit` | 建構時的完整 Git commit SHA |
| `build.timestamp` | 建構時間（ISO 8601） |
| `build.builder` | CI 環境（`github-actions` / `local`） |
| `hashes.algorithm` | `sha256` |
| `hashes.aggregate` | 所有檔案 hash 的聚合 hash（單一值代表整包部署） |
| `hashes.files` | 每個 dist/ 檔案的個別 SHA-256 hash |
| `sri` | 主要 JS/CSS 的 SRI 值（SHA-384） |
| `service_worker.hash` | `sw.js` 的 SHA-256 hash |

#### 可重現建構（Reproducible Build）

任何人可從相同 commit 重建並取得 byte-identical 輸出：

```bash
git checkout <commit-from-sentry-build.json>
cd web && npm ci && npm run build
npm run verify   # 自動比對所有 hash
```

詳見 [Reproducible Build 文件](docs/security/reproducible-build.md)。

#### 安全政策

| 政策 | 文件 | 重點 |
|------|------|------|
| Canary 部署禁止 | [canary-policy.md](docs/security/canary-policy.md) | 所有使用者同時收到相同 bundle，禁止分批/分群部署 |
| Service Worker 更新策略 | [sw-update-policy.md](docs/security/sw-update-policy.md) | `skipWaiting` + `clients.claim` 即時啟動；僅用於推播，無離線快取 |
| 緊急撤銷計畫 | [emergency-revoke-plan.md](docs/security/emergency-revoke-plan.md) | 遭入侵時的 IR 流程（回滾 → SW 強制更新 → 密鑰輪換 → 通知） |

#### CI/CD 強化

| 措施 | 狀態 |
|------|------|
| `npm ci`（鎖定依賴樹） | ✅ 已實施 |
| 建構後 hash 驗證（`verify-build.mjs`） | ✅ 已實施 |
| SRI 注入所有入口腳本 | ✅ 已實施 |
| `sentry-build.json` 自動產出 | ✅ 已實施 |
| SLSA provenance (Level 2) | ✅ 已實施 |
| cosign / Sigstore 簽章 | 🔲 規劃中 |
| 公開建構 hash log | 🔲 規劃中 |
| 獨立建構監視器 | 🔲 規劃中 |

---

## 橫向部署與擴展優勢

### 從 VPS 到全 Serverless 的架構遷移

原架構使用 Node.js Express + WebSocket 部署於 Linode VPS（PM2 管理），存在以下限制：單一伺服器承載所有連線、手動水平擴展困難、WebSocket sticky session 問題、需自行管理伺服器維運（OS 更新、SSL、監控、備份）。

遷移至 Cloudflare Workers + Durable Objects 後，實現了完全 Serverless 的架構：

### 自動彈性擴展

| 面向 | VPS 架構 (舊) | Workers 架構 (新) |
|------|--------------|-------------------|
| API 請求處理 | 單台 VPS，PM2 cluster | Cloudflare 全球邊緣網路自動分發 |
| WebSocket 連線 | 單台 VPS 承載上限 | Durable Objects per-account 隔離，無上限 |
| 擴展方式 | 手動加機器 + Load Balancer | 零配置自動擴展 |
| 冷啟動 | N/A（常駐進程） | 毫秒級冷啟動（Worker isolate） |

### 全球邊緣部署

- **API 延遲降低** — Cloudflare Workers 部署於全球 300+ 節點，使用者自動連至最近的邊緣節點處理 API 請求
- **WebSocket 就近接入** — Durable Objects 根據帳號自動分配至最近的資料中心，減少信令延遲
- **D1 智慧路由** — SQLite 資料庫自動複製讀取副本至邊緣，降低查詢延遲

### 運維零負擔

| 項目 | VPS 架構 (舊) | Workers 架構 (新) |
|------|--------------|-------------------|
| 伺服器維運 | OS 更新、安全修補、監控 | 完全免維運 |
| SSL 憑證 | 手動管理或 Let's Encrypt | Cloudflare 自動管理 |
| 程序管理 | PM2 守護、OOM 監控 | 平台自動管理 |
| 部署流程 | SSH + git pull + PM2 reload | `wrangler deploy`（零停機） |
| 高可用性 | 需手動設定冗餘 | 平台內建，自動 failover |
| DDoS 防護 | 需額外設定 | Cloudflare 內建防護 |

### Durable Objects — 有狀態 WebSocket 的最佳解

傳統 WebSocket 水平擴展的痛點是 **sticky session**：同一帳號的多個連線必須路由至同一台伺服器，才能正確轉發訊息。Durable Objects 天然解決了這個問題：

- **Per-account 隔離** — 每個帳號對應一個 `AccountWebSocket` 實例，所有裝置的 WebSocket 連線自動路由至同一個 DO
- **Hibernatable API** — 無活動時 DO 自動休眠（不佔用計算資源），收到訊息時毫秒級喚醒
- **內建持久化** — DO 可使用 Transactional Storage 持久化 Presence 狀態，無需外部 Redis
- **自動遷移** — Cloudflare 自動將 DO 遷移至最佳資料中心，無需手動管理

### 成本效益

| 項目 | VPS 架構 (舊) | Workers 架構 (新) |
|------|--------------|-------------------|
| 固定成本 | VPS 月租（無論流量高低） | 依用量計費（請求數 + CPU 時間） |
| 低流量時 | 仍需支付固定費用 | 近乎零成本 |
| 突發流量 | 可能當機或需臨時擴容 | 自動擴展，按量計費 |
| 維運人力 | 需 DevOps 投入 | 零維運成本 |

---

## 快速開始

### 前置需求

- Node.js >= 18
- Cloudflare 帳號 (Workers + D1 + R2 + KV + Pages)
- Wrangler CLI (`npm install -g wrangler`)

### 本地開發

```bash
# 安裝依賴
npm install
cd web && npm install && cd ..

# 啟動 Worker 本地開發 (D1 + KV + Durable Objects)
cd data-worker && npx wrangler dev

# ─── 另一個終端 ───

# 前端開發模式（raw 複製，不壓縮）
cd web && npm run build:raw

# 或使用 Wrangler 本地預覽
cd web && npm run preview
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

### 架構概覽

```
GitHub Push (main)
  │
  ├── deploy-worker    # Cloudflare Worker (D1 migrations + wrangler deploy + secrets)
  └── deploy-pages     # Cloudflare Pages (npm build → wrangler pages deploy ./dist)
```

僅需兩個部署目標，無伺服器維運。

### GitHub Actions CI/CD

```yaml
deploy.yml (main branch):
  ├── job: changes         # dorny/paths-filter 偵測變更路徑
  ├── job: deploy-worker   # data-worker/** 變更 → D1 migrations + wrangler deploy + secrets
  └── job: deploy-pages    # web/** 變更 → npm build + wrangler pages deploy

deploy-uat.yml (non-main branches):
  ├── job: deploy-worker   # --env uat → message-data-uat
  └── job: deploy-pages    # --env uat → UAT Pages
```

### Worker 部署

```bash
cd data-worker

# 套用 D1 資料庫遷移
wrangler d1 migrations apply message_db --remote

# 部署 Worker
wrangler deploy

# 設定 Secrets (首次或變更時)
wrangler secret put OPAQUE_OPRF_SEED
wrangler secret put OPAQUE_AKE_PRIV_B64
wrangler secret put OPAQUE_AKE_PUB_B64
wrangler secret put NTAG424_KM
wrangler secret put DATA_API_HMAC
wrangler secret put ACCOUNT_HMAC_KEY
wrangler secret put INVITE_TOKEN_KEY
wrangler secret put PORTAL_HMAC_SECRET
wrangler secret put S3_ACCESS_KEY
wrangler secret put S3_SECRET_KEY
wrangler secret put WS_TOKEN_SECRET
```

### Pages 部署

```bash
cd web

# Bundle 模式
npm run build && wrangler pages deploy ./dist --project-name message-web-hybrid

# Raw 模式（開發用）
wrangler pages deploy ./src
```

### Frontend Bundle 特性

- **esbuild** ES2022 target，code splitting + minification + source maps
- **SRI** (Subresource Integrity) — 所有 JS/CSS 注入 SHA384 完整性雜湊
- **Build Manifest** — `dist/build-manifest.json` 含 git commit hash + 每檔 SHA256
- **Entry Points**: `app-mobile.js`、`login-ui.js`、`debug-page.js`、`media-permission-demo.js`
- **CSS Bundle**: `app-bundle.css` 單檔壓縮

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

> 所有後端環境變數均設定於 Cloudflare Workers（`wrangler.toml` 或 `wrangler secret put`）。

### Worker 公開設定 (wrangler.toml `[vars]`)

| 變數 | 說明 | 範例 |
|------|------|------|
| `OPAQUE_SERVER_ID` | OPAQUE 伺服器識別符 | `api.message.sentry.red` |
| `NTAG424_KDF` | NFC 金鑰派生模式 | `HKDF` / `EV2` |
| `NTAG424_SALT` | HKDF salt | `sentry.red` |
| `NTAG424_INFO` | HKDF info | `ntag424-slot-0` |
| `NTAG424_KVER` | 金鑰版本 | `1` |
| `S3_ENDPOINT` | R2 / S3 相容端點 URL | `https://xxx.r2.cloudflarestorage.com` |
| `S3_REGION` | S3 區域 | `auto` |
| `S3_BUCKET` | 儲存桶名稱 | `message-media` |
| `SIGNED_PUT_TTL` | 上傳簽章 URL 有效期 (秒) | `900` |
| `SIGNED_GET_TTL` | 下載簽章 URL 有效期 (秒) | `900` |

### Worker Secrets (`wrangler secret put`)

| 變數 | 說明 |
|------|------|
| `OPAQUE_OPRF_SEED` | OPRF 種子 (32 bytes hex) |
| `OPAQUE_AKE_PRIV_B64` | OPAQUE AKE 私鑰 (base64) |
| `OPAQUE_AKE_PUB_B64` | OPAQUE AKE 公鑰 (base64) |
| `NTAG424_KM` | NFC 主金鑰 (16 bytes hex) |
| `NTAG424_KM_OLD` | NFC 舊主金鑰（fallback） |
| `DATA_API_HMAC` | API HMAC 驗證密鑰 |
| `ACCOUNT_HMAC_KEY` | 帳號 HMAC 密鑰 |
| `INVITE_TOKEN_KEY` | 邀請 Token 密鑰 |
| `PORTAL_HMAC_SECRET` | Portal HMAC 密鑰 |
| `S3_ACCESS_KEY` | R2/S3 存取金鑰 |
| `S3_SECRET_KEY` | R2/S3 秘密金鑰 |
| `WS_TOKEN_SECRET` | WebSocket JWT 簽章金鑰 (>= 32 字元) |

### D1 Database Binding

| Binding | 用途 |
|---------|------|
| `DB` | D1 SQLite 資料庫（message_db） |

### KV Namespace Binding

| Binding | 用途 | TTL |
|---------|------|-----|
| `AUTH_KV` | SDM exchange session、OPAQUE login expected、debug counter、Presence | 120s–300s |

```bash
# 建立 KV namespace
wrangler kv namespace create AUTH_KV
wrangler kv namespace create AUTH_KV --env uat
# 將產出的 id 填入 wrangler.toml
```

### Durable Objects Binding

| Binding | Class | 用途 |
|---------|-------|------|
| `ACCOUNT_WS` | `AccountWebSocket` | Per-account WebSocket 連線管理 |

### WebRTC 通話（Worker Secrets）

| 變數 | 說明 |
|------|------|
| `CLOUDFLARE_TURN_TOKEN_ID` | Cloudflare TURN token ID |
| `CLOUDFLARE_TURN_TOKEN_KEY` | Cloudflare TURN token 密鑰 |

---

## 技術棧

### Worker 依賴

| 套件 | 用途 |
|------|------|
| @cloudflare/opaque-ts | OPAQUE PAKE 協定 (P-256) |
| node:crypto (nodejs_compat) | AES-CMAC / HKDF-SHA256 / HMAC / JWT 驗證 |

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
| GitHub Actions | CI/CD（雙階段自動部署） |

### Infrastructure

| 服務 | 用途 |
|------|------|
| Cloudflare Workers | 統一後端 API + WebSocket（Durable Objects） |
| Cloudflare D1 | SQLite 資料庫 |
| Cloudflare KV | 短期 auth session + Presence 儲存 |
| Cloudflare R2 | 媒體物件儲存 |
| Cloudflare Pages | 前端部署（esbuild bundle + Pages Functions） |
| Cloudflare TURN | WebRTC 通話 relay（動態憑證） |
| Cloudflare Durable Objects | Per-account 有狀態 WebSocket 管理 |

---

## 授權

AGPL-3.0-only

本專案選擇 AGPL-3.0 授權，確保所有衍生作品同樣保持開源，讓社群能持續審閱與驗證安全性。
