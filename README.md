# SENTRY Messenger

**端對端加密即時通訊系統** — 採用 Signal Protocol (X3DH + Double Ratchet) 實現高安全性的訊息傳遞。

> 官網：https://sentry.red ・ 版本：0.1.9 ・ 授權：AGPL-3.0-only

---

## 目錄

- [架構概覽](#架構概覽)
- [核心功能](#核心功能)
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

### 通訊功能

- **端對端加密訊息** — 文字、媒體、檔案，伺服器無法解密
- **語音/視訊通話** — WebRTC + TURN relay，端對端加密信令
- **聯絡人邀請** — 加密 Invite Dropbox 機制（支援離線互加）
- **群組對話** — 多人加密聊天室，角色權限管理
- **已讀回條** — Commit-driven 訊息狀態追蹤（✓ sent / ✓✓ delivered）
- **即時推播** — WebSocket 即時訊息通知與通話信令
- **訊息重播** — Message Key Vault 支援歷史訊息回放
- **聯絡人備份** — 加密備份/還原聯絡人密鑰至伺服器
- **訂閱管理** — 訂閱碼兌換與配額管理

### 安全特性

- **零知識架構** — 伺服器僅儲存密文，無法解密任何訊息內容
- **前向保密 (Forward Secrecy)** — 每則訊息使用獨立金鑰，密鑰洩漏不影響歷史訊息
- **後向保密 (Break-in Recovery)** — Double Ratchet 自動修復，即使當前密鑰洩漏也會在新交換後恢復安全
- **抗重放攻擊** — Per-conversation Counter 單調遞增，伺服器端強制驗證
- **無 Fallback 政策** — 嚴格密碼協定，拒絕任何降級/重試/回滾
- **離線密鑰交換** — 透過 X3DH Prekey Bundle，對方離線時也能安全初始化

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
│   │   ├── index.js                  # 路由聚合器
│   │   ├── auth.routes.js            # SDM/OPAQUE 認證 + MK 存取
│   │   ├── keys.routes.js            # X3DH SPK/OPK 發布
│   │   ├── devkeys.routes.js         # 裝置金鑰備份/還原
│   │   ├── friends.routes.js         # 好友關係管理
│   │   ├── ws-token.routes.js        # WebSocket JWT 產生
│   │   └── v1/                       # v1 API 端點
│   │       ├── messages.routes.js    #   訊息 CRUD / 原子發送
│   │       ├── media.routes.js       #   媒體上傳/下載簽章
│   │       ├── calls.routes.js       #   通話邀請/信令/TURN
│   │       ├── contact-secrets.routes.js  # 聯絡人密鑰備份
│   │       ├── contacts.routes.js    #   聯絡人同步
│   │       ├── groups.routes.js      #   群組管理
│   │       ├── invites.routes.js     #   Invite Dropbox
│   │       ├── account.routes.js     #   帳號資訊
│   │       ├── message-key-vault.routes.js # 訊息金鑰保險庫
│   │       ├── subscription.routes.js #   訂閱管理
│   │       ├── admin.routes.js       #   管理員操作
│   │       └── debug.routes.js       #   除錯端點
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
│   ├── migrations/                   # D1 資料庫遷移
│   │   ├── 0001_consolidated.sql     # 主要 Schema（17 張表）
│   │   ├── 0002_fix_missing_tables.sql
│   │   └── 0003_restore_deletion_cursors.sql
│   └── wrangler.toml                 # Workers 設定 (D1 binding)
│
├── web/                              # ═══ Frontend SPA ═══
│   ├── build.mjs                     # esbuild 打包設定
│   ├── package.json                  # 前端依賴 (esbuild)
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
│       │   │   ├── messages.js       #   訊息 API
│       │   │   ├── auth.js           #   認證 API (SDM/OPAQUE/MK)
│       │   │   ├── prekeys.js        #   X3DH 預金鑰取得
│       │   │   ├── contact-secrets.js #  聯絡人密鑰備份 API
│       │   │   ├── calls.js          #   通話 API
│       │   │   ├── groups.js         #   群組 API
│       │   │   ├── invites.js        #   Invite Dropbox API
│       │   │   ├── friends.js        #   好友關係 API
│       │   │   ├── media.js          #   媒體簽章 API
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
│       │   │   ├── ed2curve.js       #   Ed25519 → X25519 轉換
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
│       │   │   ├── device-priv.js    #   裝置私鑰管理
│       │   │   ├── login-flow.js     #   認證流程編排
│       │   │   ├── opaque.js         #   OPAQUE 認證
│       │   │   ├── profile.js        #   使用者個人檔案
│       │   │   ├── settings.js       #   應用程式設定
│       │   │   ├── groups.js         #   群組管理
│       │   │   ├── media.js          #   媒體處理（上傳/下載）
│       │   │   ├── semantic.js       #   語意版本管理
│       │   │   ├── messages.js       #   訊息處理
│       │   │   ├── timeline-store.js #   Timeline 訊息儲存
│       │   │   ├── message-key-vault.js # Message Key Vault
│       │   │   ├── secure-conversation-manager.js # 對話安全管理
│       │   │   ├── secure-conversation-signals.js # 控制訊息
│       │   │   ├── restore-coordinator.js # 還原管線
│       │   │   ├── restore-policy.js #   還原策略
│       │   │   │
│       │   │   ├── messages-flow/    #   訊息流程管線（新架構）
│       │   │   │   ├── index.js      #     Facade 入口
│       │   │   │   ├── state.js      #     狀態機
│       │   │   │   ├── crypto.js     #     加解密操作
│       │   │   │   ├── policy.js     #     發送/同步策略
│       │   │   │   ├── queue.js      #     訊息佇列
│       │   │   │   ├── reconcile.js  #     伺服器/本地同步
│       │   │   │   ├── normalize.js  #     訊息正規化
│       │   │   │   ├── presentation.js #   UI 呈現邏輯
│       │   │   │   ├── vault-replay.js #   Vault 重播解密
│       │   │   │   ├── live/         #     即時訊息同步
│       │   │   │   │   ├── coordinator.js    # 同步協調器
│       │   │   │   │   ├── state-live.js     # Live 狀態管理
│       │   │   │   │   └── server-api-live.js # Live API 整合
│       │   │   │   └── messages/     #     訊息處理子管線
│       │   │   │       ├── decrypt.js        # 訊息解密
│       │   │   │       ├── counter.js        # Counter 管理
│       │   │   │       ├── gap.js            # Gap 偵測/填補
│       │   │   │       ├── pipeline.js       # 處理管線
│       │   │   │       ├── cache.js          # 訊息快取
│       │   │   │       ├── sync-server.js    # 伺服器同步
│       │   │   │       └── sync-offline.js   # 離線同步
│       │   │   │
│       │   │   ├── queue/            #   訊息佇列
│       │   │   │   ├── outbox.js     #     發送佇列
│       │   │   │   ├── inbox.js      #     接收處理
│       │   │   │   ├── receipts.js   #     已讀回條
│       │   │   │   ├── media.js      #     媒體 metadata
│       │   │   │   ├── send-policy.js #    發送重試策略
│       │   │   │   └── db.js         #     本地佇列 DB
│       │   │   │
│       │   │   ├── calls/            #   通話功能 (WebRTC)
│       │   │   │   ├── events.js     #     通話狀態事件
│       │   │   │   ├── signaling.js  #     通話信令
│       │   │   │   ├── key-manager.js #    Per-call 加密金鑰
│       │   │   │   ├── media-session.js #  媒體串流處理
│       │   │   │   ├── identity.js   #     參與者身份
│       │   │   │   ├── network-config.js # STUN/TURN 設定
│       │   │   │   ├── state.js      #     通話狀態機
│       │   │   │   └── call-log.js   #     通話紀錄
│       │   │   │
│       │   │   ├── soft-deletion/    #   訊息軟刪除
│       │   │   └── messages-support/ #   輔助儲存
│       │   │       ├── conversation-clear-store.js
│       │   │       ├── conversation-tombstone-store.js
│       │   │       ├── processed-messages-store.js
│       │   │       ├── receipt-store.js
│       │   │       └── vault-ack-store.js
│       │   │
│       │   ├── ui/                   # UI 層
│       │   │   ├── app-ui.js         #   主應用 UI
│       │   │   ├── app-mobile.js     #   Mobile 入口
│       │   │   ├── login-ui.js       #   登入畫面
│       │   │   ├── debug-page.js     #   除錯面板
│       │   │   │
│       │   │   └── mobile/           #   Mobile UI
│       │   │       ├── controllers/  #     MVC Controllers
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
│       │   │       └── modals/              # Modal 對話框
│       │   │           ├── password-modal.js
│       │   │           ├── settings-modal.js
│       │   │           └── subscription-modal.js
│       │   │
│       │   └── lib/                  # 前端工具函式庫
│       │       ├── identicon.js      #   身份頭像生成
│       │       ├── invite.js         #   邀請連結處理
│       │       ├── qr.js             #   QR Code 產生/掃描
│       │       └── vendor/           #   第三方函式庫
│       │
│       ├── shared/                   # 前後端共用程式碼
│       │   ├── crypto/
│       │   │   ├── dr.js             #   Double Ratchet (共用實作)
│       │   │   ├── aead.js           #   AEAD 加密
│       │   │   ├── nacl.js           #   NaCl 工具
│       │   │   ├── ed2curve.js       #   曲線轉換
│       │   │   └── prekeys.js        #   X3DH 預金鑰
│       │   ├── conversation/
│       │   │   └── context.js        #   對話 Context 衍生
│       │   ├── contacts/
│       │   │   └── contact-share.js  #   聯絡人加密共用
│       │   ├── calls/
│       │   │   ├── schemas.js        #   通話 Schema
│       │   │   └── network-config.json # STUN/TURN 設定
│       │   └── utils/
│       │       ├── base64.js         #   Base64 工具
│       │       └── u8-strict.js      #   Uint8Array 驗證
│       │
│       └── assets/                   # 靜態資源
│           ├── css/                  #   模組化樣式表
│           ├── audio/                #   UI 音效
│           └── images/               #   圖片資源
│
├── tests/                            # ═══ 測試 ═══
│   ├── e2e/                          # Playwright E2E 測試
│   │   ├── login-smoke.spec.mjs
│   │   ├── call-audio.spec.mjs
│   │   └── global-setup.mjs
│   ├── unit/                         # 單元測試
│   │   ├── contact-secrets.spec.mjs
│   │   ├── encoding.spec.mjs
│   │   ├── logging.spec.mjs
│   │   ├── semantic.spec.mjs
│   │   ├── snapshot-normalization.spec.mjs
│   │   └── timeline-precision.spec.mjs
│   ├── fixtures/                     # 測試資料
│   └── scripts/                      # 測試輔助腳本
│
├── scripts/                          # ═══ 部署與工具 ═══
│   ├── deploy-hybrid.sh              # 一鍵 Hybrid 部署
│   ├── deploy-prod.sh                # 正式環境部署
│   └── ...                           # 其他腳本
│
├── docs/                             # ═══ 文件 ═══
│   ├── messages-flow-architecture.md # 訊息流程架構
│   ├── messages-flow-spec.md         # 訊息流程權威規格
│   ├── messages-flow-invariants.md   # 不變量文件
│   └── topup-system-spec.md          # 儲值系統規格
│
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

D1 (SQLite) 共 17 張表，以下為核心表結構：

### 帳號與裝置

```sql
accounts              # 帳號表
├── account_digest    # PK — SHA256 帳號摘要
├── account_token     # API 認證 token
├── uid_digest        # UID hash (SDM 用)
├── last_ctr          # 最後 SDM counter (防重放)
└── wrapped_mk_json   # 加密的 Master Key (Argon2id + AES-GCM)

devices               # 裝置表
├── (account_digest, device_id)  # PK
├── label, status     # 裝置資訊
└── last_seen_at      # 最後上線

device_backup         # 裝置私鑰備份 (加密)
device_signed_prekeys # X3DH SPK (簽名預金鑰)
device_opks           # X3DH OPK (一次性預金鑰)
```

### 訊息與加密

```sql
conversations         # 對話表
├── id                # PK — 對話 ID
└── token_b64         # 對話 token

conversation_acl      # 對話參與者
├── (conversation_id, account_digest, device_id)  # PK
└── role              # 角色

messages_secure       # 加密訊息
├── id                # PK — 訊息 ID
├── conversation_id   # 對話 ID
├── sender/receiver   # 發送/接收方 digest + device_id
├── header_json       # X3DH/DR header
├── ciphertext_b64    # 加密內容
├── counter           # per-conversation 單調遞增
└── created_at        # 時間戳

message_key_vault     # 訊息金鑰保險庫 (E2EE 重播)
├── account_digest    # 帳號
├── conversation_id   # 對話
├── message_id        # 訊息 ID
├── direction         # outgoing / incoming
├── wrapped_mk_json   # MK 包裝後的 message key
├── header_counter    # 對應 counter
└── dr_state_snapshot # DR 狀態快照 (可選)

attachments           # 媒體附件
├── object_key        # PK — R2 物件路徑
├── envelope_json     # 加密信封
└── size_bytes        # 檔案大小
```

### 群組與聯絡人

```sql
groups                # 群組
├── group_id          # PK
├── conversation_id   # 關聯對話
└── name, avatar_json # 群組資訊

group_members         # 群組成員
├── (group_id, account_digest)  # PK
├── role              # owner / admin / member
└── status            # active / left / kicked / removed

contacts              # 聯絡人 (加密 metadata)
├── (owner_digest, peer_digest)  # PK
├── encrypted_blob    # 加密的聯絡人資料
└── is_blocked        # 封鎖狀態

invite_dropbox        # 離線邀請投遞箱
├── invite_id         # PK
├── owner_public_key_b64  # X3DH 公鑰
├── ciphertext_json   # 加密的初始化資料
└── status            # CREATED → DELIVERED → CONSUMED
```

### 通話

```sql
call_sessions         # 通話 Session
├── call_id           # PK
├── caller/callee     # 雙方資訊
├── status, mode      # 狀態與模式
└── metrics_json      # 通話品質指標

call_events           # 通話事件
├── event_id          # PK
├── call_id, type     # 關聯通話 + 事件類型
└── payload_json      # 事件資料
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
| `/mk/store` | POST | 儲存 wrapped MK（首次設定） |
| `/mk/update` | POST | 更新 wrapped MK（變更密碼） |

### 金鑰管理 (`/api/v1/keys/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/keys/publish` | POST | 發布預金鑰 (SPK + OPK 批量) |
| `/keys/bundle` | POST | 取得對方預金鑰包 (X3DH 用) |
| `/devkeys/store` | POST | 儲存裝置金鑰備份 |
| `/devkeys/fetch` | POST | 取得裝置金鑰備份 |

### 訊息 (`/api/v1/messages/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/messages/secure` | POST | 發送加密訊息 |
| `/messages/atomic-send` | POST | 原子發送（訊息 + vault key 一起寫入） |
| `/messages/secure` | GET | 取得加密訊息列表 |
| `/messages/secure/max-counter` | GET | 取得 conversation 最大 counter |
| `/messages/by-counter` | GET | 依 counter 取得特定訊息 |
| `/messages/send-state` | POST | 取得訊息發送狀態 |
| `/messages/outgoing-status` | POST | 批量取得 outgoing 狀態 |
| `/messages/delete` | POST | 刪除訊息 |
| `/messages/secure/delete-conversation` | POST | 刪除整個對話 |
| `/deletion/cursor` | POST | 設定軟刪除 cursor |

### 媒體 (`/api/v1/media/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/media/sign-put` | POST | 取得 R2 上傳 Presigned URL |
| `/media/sign-get` | POST | 取得 R2 下載 Presigned URL |

### 通話 (`/api/v1/calls/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/calls/invite` | POST | 發起通話邀請 |
| `/calls/cancel` | POST | 取消通話 |
| `/calls/ack` | POST | 確認通話事件 |
| `/calls/turn-credentials` | POST | 取得 TURN 憑證（動態，有時效） |
| `/calls/network-config` | GET | 取得 STUN/TURN 網路設定 |

### 聯絡人與邀請

| 端點 | 方法 | 說明 |
|------|------|------|
| `/contacts/uplink` | POST | 上傳聯絡人（加密） |
| `/contacts/downlink` | POST | 下載聯絡人 |
| `/contact-secrets/backup` | POST | 備份聯絡人密鑰 |
| `/contact-secrets/backup` | GET | 還原聯絡人密鑰 |
| `/invites/create` | POST | 建立 Invite Dropbox |
| `/invites/deliver` | POST | 投遞邀請（guest → owner） |
| `/invites/consume` | POST | 消費邀請（owner 取回） |
| `/invites/status` | POST | 查詢邀請狀態 |

### 群組 (`/api/v1/groups/`)

| 端點 | 方法 | 說明 |
|------|------|------|
| `/groups/create` | POST | 建立群組 |
| `/groups/members/add` | POST | 新增群組成員 |

### 其他

| 端點 | 方法 | 說明 |
|------|------|------|
| `/friends/bootstrap-session` | POST | 初始化好友關係 |
| `/subscription/redeem` | POST | 兌換訂閱碼 |
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
| `hello` | S→C | 伺服器歡迎訊息 |
| `auth` | C→S | JWT 認證請求 |
| `auth_ok` / `auth_fail` | S→C | 認證結果 |

#### 訊息通知

| 類型 | 方向 | 說明 |
|------|------|------|
| `secure-message` | S→C | 新加密訊息通知 |
| `vault-ack` | S→C | 金鑰保險庫寫入確認 |
| `contacts-reload` | S→C | 聯絡人列表更新通知 |
| `contact-removed` | S→C | 聯絡人刪除通知 |
| `conversation-deleted` | S→C | 對話刪除通知 |

#### 通話信令

| 類型 | 方向 | 說明 |
|------|------|------|
| `call-invite` | S↔C | 通話邀請 |
| `call-ringing` | S↔C | 響鈴中 |
| `call-accept` | S↔C | 接聽 |
| `call-reject` | S↔C | 拒接 |
| `call-cancel` | S↔C | 取消 |
| `call-end` | S↔C | 結束 |
| `call-offer` | S↔C | SDP Offer |
| `call-answer` | S↔C | SDP Answer |
| `call-ice-candidate` | S↔C | ICE 候選 |

#### Presence

| 類型 | 方向 | 說明 |
|------|------|------|
| `presence-subscribe` | C→S | 訂閱線上狀態 |
| `presence-update` | S→C | 線上狀態變更 |

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

# 複製環境設定
cp .env.example .env
# 編輯 .env 填入必要變數

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
npm run preview      # Wrangler Pages 本地預覽
```

---

## 部署

### 一鍵 Hybrid 部署

```bash
./scripts/deploy-hybrid.sh
```

部署流程：

1. **Cloudflare Worker** — `wrangler deploy` 部署 `data-worker/`
2. **Cloudflare Pages** — `wrangler pages deploy` 部署 `web/src`
3. **Backend** — git push → SSH 到遠端 → `git pull && npm install && pm2 reload`

### Worker D1 遷移

```bash
cd data-worker
wrangler d1 migrations apply message_db     # 套用資料庫遷移
wrangler deploy                              # 部署 Worker
```

### 手動部署

```bash
# Worker
cd data-worker && wrangler deploy

# Pages
cd web && wrangler pages deploy ./src

# Backend (VPS)
ssh Message "cd /path/to/app && git pull && npm install && pm2 reload all"
```

---

## 測試

```bash
# ─── 整合測試 ───
npm run test:login-flow          # 完整認證流程
npm run test:prekeys-devkeys     # X3DH 預金鑰管理
npm run test:messages-secure     # 安全訊息加解密
npm run test:friends-messages    # 好友訊息收發
npm run test:calls-encryption    # 通話加密

# ─── E2E 測試 (Playwright) ───
npm run test:front:login         # 登入 UI 煙霧測試
npm run test:front:call-audio    # 通話音訊測試

# ─── 單元測試 ───
node --test tests/unit/          # 全部單元測試
```

### 測試涵蓋範圍

| 類別 | 測試項目 |
|------|----------|
| 認證 | SDM 交換、OPAQUE 註冊/登入、MK 儲存 |
| 金鑰 | SPK/OPK 發布、Bundle 取得、裝置金鑰備份 |
| 訊息 | 加密發送、原子寫入、Counter 驗證、刪除 |
| 好友 | Session bootstrap、訊息收發 |
| 通話 | 加密信令、TURN 憑證 |
| 前端 | 登入流程、通話音訊、聯絡人加密、Timeline 精度 |

---

## 環境變數

### 核心設定

| 變數 | 說明 | 範例 |
|------|------|------|
| `PORT` | HTTP 監聽埠 | `3000` |
| `NODE_ENV` | 環境模式 | `development` / `production` |
| `WS_TOKEN_SECRET` | WebSocket JWT 簽章金鑰 (>= 32 字元) | `<random-string>` |
| `DATA_API_URL` | Cloudflare Worker URL | `https://message-data.xxx.workers.dev` |
| `DATA_API_HMAC` | Worker 通訊 HMAC 密鑰 | `<secret>` |
| `CORS_ORIGIN` | 允許的 CORS 來源 (逗號分隔) | `https://sentry.red,https://app.sentry.red` |

### S3/R2 儲存

| 變數 | 說明 |
|------|------|
| `S3_ENDPOINT` | R2 / S3 相容端點 URL |
| `S3_BUCKET` | 儲存桶名稱 |
| `S3_ACCESS_KEY` | S3 存取金鑰 |
| `S3_SECRET_KEY` | S3 秘密金鑰 |

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
| `TURN_SHARED_SECRET` | TURN 憑證簽章密鑰 | `<secret>` |
| `TURN_STUN_URIS` | STUN 伺服器列表 (逗號分隔) | `stun:stun.l.google.com:19302` |
| `TURN_RELAY_URIS` | TURN relay 伺服器列表 | `turn:relay.example.com` |

---

## 技術棧

### Backend 依賴

| 套件 | 用途 |
|------|------|
| express | HTTP API 框架 |
| ws | WebSocket 伺服器 |
| helmet | HTTP 安全標頭 |
| compression | 回應壓縮 |
| express-rate-limit | API 限速 |
| pino / pino-http | 結構化日誌 |
| jsonwebtoken | JWT 產生/驗證 |
| @cloudflare/opaque-ts | OPAQUE PAKE 協定 |
| @noble/curves, @noble/hashes | 密碼學原語 |
| tweetnacl | NaCl 加密函式庫 |
| @aws-sdk/client-s3 | R2 Presigned URL |
| zod | Schema 驗證 |
| nanoid | 安全亂數 ID |
| pm2 | 程序管理 |

### Frontend 工具

| 工具 | 用途 |
|------|------|
| esbuild | JS 打包/壓縮 |
| Vanilla JS | 無框架 SPA |
| Cloudflare Pages | 靜態部署 |

### Infrastructure

| 服務 | 用途 |
|------|------|
| Cloudflare Workers | 資料層 API |
| Cloudflare D1 | SQLite 資料庫 |
| Cloudflare R2 | 媒體物件儲存 |
| Cloudflare Pages | 前端靜態部署 |
| Linode VPS | Backend + WebSocket |
| PM2 | 程序管理 + 自動重啟 |

---

## 授權

AGPL-3.0-only
