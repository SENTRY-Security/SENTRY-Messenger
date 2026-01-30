# SENTRY Messenger

**端對端加密即時通訊系統** — 採用 Signal Protocol (X3DH + Double Ratchet) 實現高安全性的訊息傳遞。

---

## 架構概覽

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SENTRY Messenger                              │
├─────────────────┬──────────────────────┬────────────────────────────────┤
│   Frontend      │    Backend (Node.js) │    Data Layer (Cloudflare)     │
│   (web/)        │    (src/)            │    (data-worker/)              │
├─────────────────┼──────────────────────┼────────────────────────────────┤
│ Cloudflare      │ Express + WebSocket  │ Cloudflare Workers + D1        │
│ Pages (SPA)     │ Linode VPS (PM2)     │ Cloudflare R2 (媒體儲存)       │
└─────────────────┴──────────────────────┴────────────────────────────────┘
```

### 三層 Hybrid 部署架構

1. **Frontend (web/)** — 純靜態 SPA，部署至 Cloudflare Pages
2. **Backend (src/)** — Node.js Express API + WebSocket，部署於 VPS (PM2)
3. **Data Worker (data-worker/)** — Cloudflare Workers，存取 D1 資料庫與 R2 儲存

---

## 核心功能

### 🔐 密碼學協定

| 功能 | 技術 |
|------|------|
| 金鑰交換 | X3DH (Extended Triple Diffie-Hellman) |
| 訊息加密 | Double Ratchet + AEAD (XChaCha20-Poly1305 / AES-256-GCM) |
| 身份驗證 | Ed25519 簽章 + OPAQUE PAKE |
| NFC 標籤認證 | NTAG 424 DNA SDM (CMAC/HKDF/EV2) |
| 金鑰派生 | HKDF-SHA256 / Argon2id |

### 📱 通訊功能

- **端對端加密訊息** — 文字、媒體、檔案
- **語音/視訊通話** — WebRTC + TURN relay
- **聯絡人邀請** — 加密 Dropbox 機制
- **群組對話** — 多人加密聊天室
- **已讀回條** — 訊息狀態追蹤
- **通知推送** — WebSocket 即時推播

### 🛡️ 安全特性

- **零知識架構** — 伺服器無法解密訊息內容
- **前向保密** — 每則訊息使用獨立金鑰
- **抗重放攻擊** — Counter 單調遞增驗證
- **無 Fallback 政策** — 嚴格密碼協定，拒絕任何降級/重試

---

## 專案結構

```
SENTRY Messenger/
├── src/                      # Node.js Backend
│   ├── server.js             # HTTP + WebSocket 啟動
│   ├── app.js                # Express 應用設定
│   ├── routes/               # API 路由
│   │   ├── v1/               # v1 API 端點
│   │   ├── auth.routes.js    # SDM/OPAQUE 認證
│   │   ├── keys.routes.js    # 預金鑰管理
│   │   └── ...
│   ├── controllers/          # 業務邏輯
│   ├── services/             # 外部服務整合
│   │   ├── s3.js             # R2 物件儲存
│   │   ├── call-worker.js    # Worker 呼叫封裝
│   │   └── subscription-local.js  # 訂閱/憑證
│   ├── ws/                   # WebSocket 管理
│   │   └── index.js          # 連線、通話信令、Presence
│   ├── lib/                  # 密碼學工具
│   │   ├── ntag424-kdf.js    # NFC 金鑰派生
│   │   └── ntag424-verify.js # SDM CMAC 驗證
│   ├── utils/                # 共用工具
│   ├── middlewares/          # Express 中介軟體
│   └── schemas/              # Zod 驗證 Schema
│
├── data-worker/              # Cloudflare Worker
│   ├── src/worker.js         # D1/R2 資料層邏輯
│   ├── migrations/           # D1 資料庫遷移
│   └── wrangler.toml         # Wrangler 設定
│
├── web/                      # Frontend SPA
│   ├── src/
│   │   ├── index.html        # 入口頁 (導向 login)
│   │   ├── app/              # 應用程式模組
│   │   ├── pages/            # 頁面
│   │   ├── shared/           # 共用元件/設定
│   │   └── libs/             # 前端函式庫
│   └── package.json
│
├── scripts/                  # 部署與測試腳本
│   ├── deploy-hybrid.sh      # 一鍵 Hybrid 部署
│   ├── deploy-prod.sh        # 正式環境部署
│   └── ...
│
├── tests/                    # 測試
│   └── e2e/                  # Playwright E2E 測試
│
├── docs/                     # 文件
└── package.json              # 專案設定
```

---

## 環境變數

### 必要設定

| 變數 | 說明 |
|------|------|
| `PORT` | HTTP 監聽埠 (預設 3000) |
| `NODE_ENV` | 環境 (development/production) |
| `WS_TOKEN_SECRET` | WebSocket JWT 簽章金鑰 (≥32 字元) |
| `DATA_API_URL` | Cloudflare Worker URL |
| `DATA_API_HMAC` | Worker 通訊 HMAC 密鑰 |
| `S3_ENDPOINT` | R2/S3 相容端點 |
| `S3_BUCKET` | 儲存桶名稱 |
| `S3_ACCESS_KEY` | S3 存取金鑰 |
| `S3_SECRET_KEY` | S3 秘密金鑰 |

### NFC 認證 (NTAG 424 DNA)

| 變數 | 說明 |
|------|------|
| `NTAG424_KM` | 主金鑰 (32 hex chars) |
| `NTAG424_KDF` | 派生模式 (HKDF/EV2) |
| `NTAG424_SALT` | HKDF salt (預設: 網域名) |

### OPAQUE PAKE

| 變數 | 說明 |
|------|------|
| `OPAQUE_OPRF_SEED` | OPRF 種子 (64 hex chars) |
| `OPAQUE_AKE_PRIV_B64` | AKE 私鑰 (base64) |
| `OPAQUE_AKE_PUB_B64` | AKE 公鑰 (base64) |
| `OPAQUE_SERVER_ID` | 伺服器識別符 |

### 通話 (WebRTC TURN)

| 變數 | 說明 |
|------|------|
| `TURN_SHARED_SECRET` | TURN 憑證簽章密鑰 |
| `TURN_STUN_URIS` | STUN 伺服器列表 (逗號分隔) |
| `TURN_RELAY_URIS` | TURN relay 伺服器列表 |

---

## 快速開始

### 前置需求

- Node.js ≥ 18
- Cloudflare 帳號 (Workers + D1 + R2 + Pages)
- 已設定遠端主機 SSH (`~/.ssh/config` 中的 `Message` host)

### 本地開發

```bash
# 安裝依賴
npm install

# 複製環境設定
cp .env.example .env
# 編輯 .env 填入必要變數

# 啟動開發伺服器
npm run dev
```

### 部署

```bash
# 一鍵 Hybrid 部署 (Worker + Pages + Backend)
./scripts/deploy-hybrid.sh
```

部署流程：
1. **Cloudflare Worker** — `wrangler deploy` 部署 data-worker
2. **Cloudflare Pages** — `wrangler pages deploy` 部署 web/src
3. **Backend** — git push → SSH 到遠端 → git pull → npm install → pm2 reload

---

## API 端點概覽

### 認證 (`/api/v1/auth/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/auth/sdm/exchange` | POST | NFC 標籤認證 |
| `/auth/sdm/debug-kit` | POST | 測試用 SDM 套件產生 |
| `/auth/opaque/register-init` | POST | OPAQUE 註冊初始化 |
| `/auth/opaque/register-finish` | POST | OPAQUE 註冊完成 |
| `/auth/opaque/login-init` | POST | OPAQUE 登入初始化 |
| `/auth/opaque/login-finish` | POST | OPAQUE 登入完成 |
| `/mk/store` | POST | 儲存 wrapped MK (首次設定) |
| `/mk/update` | POST | 更新 wrapped MK (變更密碼) |

### 金鑰管理 (`/api/v1/keys/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/keys/publish` | POST | 發布預金鑰 (SPK + OPK) |
| `/keys/bundle` | POST | 取得對方預金鑰包 |
| `/devkeys/store` | POST | 儲存裝置金鑰 |
| `/devkeys/fetch` | POST | 取得裝置金鑰 |

### 訊息 (`/api/v1/messages/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/messages/secure` | POST | 發送加密訊息 |
| `/messages/atomic-send` | POST | 原子發送 (訊息 + vault) |
| `/messages/secure` | GET | 取得加密訊息列表 |
| `/messages/secure/max-counter` | GET | 取得最大 counter |
| `/messages/send-state` | POST | 取得發送狀態 |
| `/messages/delete` | POST | 刪除訊息 |
| `/messages/secure/delete-conversation` | POST | 刪除整個對話 |

### 媒體 (`/api/v1/media/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/media/sign-put` | POST | 取得上傳簽章 URL |
| `/media/sign-get` | POST | 取得下載簽章 URL |

### 通話 (`/api/v1/calls/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/calls/invite` | POST | 發起通話邀請 |
| `/calls/cancel` | POST | 取消通話 |
| `/calls/ack` | POST | 確認通話事件 |
| `/calls/turn-credentials` | POST | 取得 TURN 憑證 |
| `/calls/network-config` | GET | 取得網路設定 |

### 其他

| 端點 | 方法 | 說明 |
|------|------|------|
| `/invites/create` | POST | 建立邀請連結 |
| `/invites/deliver` | POST | 投遞邀請內容 |
| `/invites/consume` | POST | 消費邀請 |
| `/groups/create` | POST | 建立群組 |
| `/groups/members/add` | POST | 新增群組成員 |
| `/contacts/uplink` | POST | 上傳聯絡人 |
| `/contacts/downlink` | POST | 下載聯絡人 |
| `/subscription/redeem` | POST | 兌換訂閱憑證 |
| `/ws/token` | POST | 取得 WebSocket 認證 token |

---

## WebSocket 訊息類型

### 連線與認證

| 類型 | 說明 |
|------|------|
| `hello` | 伺服器歡迎訊息 |
| `auth` | 認證請求/回應 |

### 訊息通知

| 類型 | 說明 |
|------|------|
| `secure-message` | 新加密訊息通知 |
| `vault-ack` | 金鑰保險庫確認 |
| `contacts-reload` | 聯絡人更新通知 |
| `contact-removed` | 聯絡人刪除通知 |
| `conversation-deleted` | 對話刪除通知 |

### 通話信令

| 類型 | 說明 |
|------|------|
| `call-invite` | 通話邀請 |
| `call-ringing` | 響鈴中 |
| `call-accept` | 接聽 |
| `call-reject` | 拒接 |
| `call-cancel` | 取消 |
| `call-end` | 結束 |
| `call-offer` | SDP Offer |
| `call-answer` | SDP Answer |
| `call-ice-candidate` | ICE 候選 |

### Presence

| 類型 | 說明 |
|------|------|
| `presence-subscribe` | 訂閱上線狀態 |
| `presence-update` | 上線狀態變更 |

---

## 測試

```bash
# 登入流程測試
npm run test:login-flow

# 預金鑰測試
npm run test:prekeys-devkeys

# 安全訊息測試
npm run test:messages-secure

# 通話加密測試
npm run test:calls-encryption

# Playwright E2E 測試
npm run test:front:login
```

---

## 安全設計原則

### 嚴格密碼協定 — 無 Fallback 政策

本專案遵循**嚴格密碼協定**，禁止任何 fallback、retry、rollback、resync、auto-repair 邏輯：

1. **解密失敗** → 直接失敗，不嘗試備用金鑰
2. **Counter 不一致** → 直接拒絕，不自動對齊
3. **不允許協定降級** — 不使用舊版本/舊金鑰重試
4. **不允許模糊錯誤處理** — 無 try-catch fallback
5. **對話重置必須顯式** — 不隱式重建 state

---

## 授權

AGPL-3.0-only

---

## 相關連結

- 官網：https://sentry.red
- 專案版本：0.1.9
