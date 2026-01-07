SENTRY Message — 技術筆記

# **SENTRY Message — 技術筆記**

> 近期進度（重構中）：已導入 **messages-flow 架構**，把 UI / app lifecycle / WS 事件入口全部收斂到 **messages-flow-legacy** facade，並開始把 **A route（replay / vault-only）** 先模組化（scroll fetch → server-api / vault-replay / normalize / orchestrator）。同時建立 **B route（live decrypt）MVP skeleton**（目前預設關閉），目標是逐段替換 legacy message pipeline、把責任邊界做乾淨，並把「缺 key / 重登補解密」等問題改成可系統化處理。

---

## **目錄**

1. [簡介與快速開始](#%E7%B0%A1%E4%BB%8B%E8%88%87%E5%BF%AB%E9%80%9F%E9%96%8B%E5%A7%8B)
2. [架構概覽](#%E6%9E%B6%E6%A7%8B%E6%A6%82%E8%A6%BD)
   * [專案目錄](#%E5%B0%88%E6%A1%88%E7%9B%AE%E9%8C%84)
   * [系統元件](#%E7%B3%BB%E7%B5%B1%E5%85%83%E4%BB%B6)
   * [資料流摘要](#%E8%B3%87%E6%96%99%E6%B5%81%E6%91%98%E8%A6%81)
3. [訊息流程架構（重構版）](#%E8%A8%8A%E6%81%AF%E6%B5%81%E7%A8%8B%E6%9E%B6%E6%A7%8B%E9%87%8D%E6%A7%8B%E7%89%88)
   * [A route / B route 定義與邊界](#a-route--b-route-%E5%AE%9A%E7%BE%A9%E8%88%87%E9%82%8A%E7%95%8C)
   * [Facade 與模組分工](#facade-%E8%88%87%E6%A8%A1%E7%B5%84%E5%88%86%E5%B7%A5)
   * [目前重構進度](#%E7%9B%AE%E5%89%8D%E9%87%8D%E6%A7%8B%E9%80%B2%E5%BA%A6)
4. [關鍵流程](#%E9%97%9C%E9%8D%B5%E6%B5%81%E7%A8%8B)
   * [登入與主金鑰 (MK)](#%E7%99%BB%E5%85%A5%E8%88%87%E4%B8%BB%E9%87%91%E9%91%B0-mk)
   * [裝置金鑰與 Prekeys](#%E8%A3%9D%E7%BD%AE%E9%87%91%E9%91%B0%E8%88%87-prekeys)
   * [好友邀請與聯絡同步](#%E5%A5%BD%E5%8F%8B%E9%82%80%E8%AB%8B%E8%88%87%E8%81%AF%E7%B5%A1%E5%90%8C%E6%AD%A5)
   * [Double Ratchet 訊息傳遞（現況/目標）](#double-ratchet-%E8%A8%8A%E6%81%AF%E5%82%B3%E9%81%9E%E7%8F%BE%E6%B3%81%E7%9B%AE%E6%A8%99)
   * [媒體、設定與資料夾命名](#%E5%AA%92%E9%AB%94%E8%A8%AD%E5%AE%9A%E8%88%87%E8%B3%87%E6%96%99%E5%A4%BE%E5%91%BD%E5%90%8D)
5. [安全預設與環境配置](#%E5%AE%89%E5%85%A8%E9%A0%90%E8%A8%AD%E8%88%87%E7%92%B0%E5%A2%83%E9%85%8D%E7%BD%AE)
6. [營運與部署流程](#%E7%87%9F%E9%81%8B%E8%88%87%E9%83%A8%E7%BD%B2%E6%B5%81%E7%A8%8B)
   * [D1 Schema 盤點（只讀）](#d1-schema-%E7%9B%A4%E9%BB%9E%E5%8F%AA%E8%AE%80)
7. [測試與自動化](#%E6%B8%AC%E8%A9%A6%E8%88%87%E8%87%AA%E5%8B%95%E5%8C%96)
8. [最新進度與工作項目](#%E6%9C%80%E6%96%B0%E9%80%B2%E5%BA%A6%E8%88%87%E5%B7%A5%E4%BD%9C%E9%A0%85%E7%9B%AE)
9. [授權條款](#%E6%8E%88%E6%AC%8A%E6%A2%9D%E6%AC%BE)

---

## **簡介與快速開始**

* **目標**：驗證「晶片感應 → 零知識登入 → 端對端密訊＆媒體」的連貫體驗。實際設計：明文與 MK 僅在瀏覽器記憶體使用；伺服端保存密文（訊息/媒體）以及以 MK 包裝的密鑰備份（**wrapped\_mk**、**wrapped\_dev**、contactSecrets/DR 快照）以支援還原。
* **核心堆疊**：Node.js (Express + WebSocket) / Cloudflare Worker + D1 / Cloudflare R2 / 前端 ESM。

### **快速開始**

```
npm install
NODE_ENV=development node src/server.js            # 啟動 API
node scripts/serve-web.mjs                         # 啟動本機 Pages
```

**必要環境變數（摘要）：**DATA\_API\_URL**, **DATA\_API\_HMAC**, **WS\_TOKEN\_SECRET**, **S3\_\***, **NTAG424\_\***, **OPAQUE\_\***, **ACCOUNT\_TOKEN\_BYTES**, **SIGNED\_{PUT,GET}\_TTL**, **UPLOAD\_MAX\_BYTES**, **CALL\_SESSION\_TTL\_SECONDS**, **TURN\_SHARED\_SECRET**, **TURN\_STUN\_URIS**, **TURN\_RELAY\_URIS**, **TURN\_TTL\_SECONDS**。細節見**[安全預設](#%E5%AE%89%E5%85%A8%E9%A0%90%E8%A8%AD%E8%88%87%E7%92%B0%E5%A2%83%E9%85%8D%E7%BD%AE)![Attachment.tiff](file:///Attachment.tiff)。

開發流程政策文件：

* **AGENTS.md**：協作規範（輸出格式、禁止事項、commit 規則）
* **SKILL.md**：常用取證指令與工作習慣（rg/sed/git show 等）
* **Messages Flow Invariants**：docs/messages-flow-invariants.md

---

## **架構概覽**

### **專案目錄**

```
.
├─ package.json            # Node API
├─ src/                    # 伺服端程式碼
│  ├─ routes/              # REST (auth/media/friends/prekeys/...)
│  ├─ controllers/         # 業務邏輯
│  ├─ ws/                  # WebSocket presence/contact-share
│  └─ utils/               # HMAC、logger、S3/R2 包裝
├─ data-worker/            # Cloudflare Worker + D1 schema
└─ web/                    # 前端（Cloudflare Pages）
   ├─ src/app/             # ESM 模組（core/crypto/features/ui）
   └─ pages/               # login.html / app.html
```

### **系統元件**


| **元件**                            | **職責**                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **前端 (web)**                      | 管理登入流程、端到端加密、UI；敏感資料在瀏覽器記憶體處理。                                                     |
| **Node API (src)**                  | 驗證 SDM、代理 OPAQUE、媒體索引、devkeys/prekeys 管理、WebSocket presence。僅接觸密文與索引。                  |
| **Cloudflare Worker (data-worker)** | 以 HMAC 驗證 Node 請求，操作 D1：帳號、邀請、訊息索引、prekey 庫存等。                                         |
| **R2**                              | 儲存加密媒體／頭像，透過**/media/sign-put**產生 presigned URL。                                                |
| **SessionStorage / LocalStorage**   | 登入→App handoff 用途（**mk\_b64**、**account\_token**等）與**contactSecrets-\***快照；App 讀取後依策略清空。 |

### **資料流摘要**

1. Login 頁完成 SDM + OPAQUE 後解封 MK，短暫存在 sessionStorage。
2. App 頁接手 MK、wrapped\_dev、contactSecrets 等 snapshot，透過 WebSocket / REST 同步資料。
3. 加密/解密在前端記憶體執行；後端只儲存密文與索引。
4. 離線/重登時依賴 contactSecrets/DR snapshot 與 B route 補齊 vault keys（重構目標）。

---

## **訊息流程架構（重構版）**

> 權威文件：docs/messages-flow-architecture.md

### **A route / B route 定義與邊界**

* **A route = replay（vault-only）**
  * **條件：**mutateState=false** 且 **allowReplay=true
  * 只允許：**vaultGet** + AES-GCM 解密（不推進 DR、不 vaultPut）
  * 若缺 key：只能產生 missing-key 訊號/狀態（例如 **vault\_missing**），**不得直接啟動 live decrypt**
* **B route = live decrypt（DR）**
  * **條件：**mutateState=true** 且 **allowReplay=false
  * 允許：推進 DR state、**vaultPut(incoming)**、寫入 timeline（append）
  * 負責：補齊缺 key、離線 catch-up、counter gap 修補（完整版本尚在重構）

### **Facade 與模組分工**

* **Facade（唯一入口）**：web/src/app/features/messages-flow-legacy.js
  * UI / app lifecycle / WS handlers **只能呼叫 facade**
  * UI 不得直接 import pipeline（A/B modules、server-api、crypto、state）
* **A route 模組（已模組化）**：web/src/app/features/messages-flow/
  * **server-api.js**：replay list 的 HTTP/normalize
  * **vault-replay.js**：vaultGet + AES-GCM 解密（無 DR、無 vaultPut）
  * **normalize.js**：將 replay decrypt 結果轉 UI message objects（保留原錯誤語意）
  * **scroll-fetch.js**：orchestrator（list → decrypt → normalize），輸出 **{items, errors, nextCursor}**
* **B route 模組（MVP / 預設關閉）**：web/src/app/features/messages-flow/live/
  * **coordinator.js**：WS incoming 的最小編排（ready → fetch(by id) → decrypt → vaultPut → append）
  * **server-api-live.js**：live fetch（目前以 message id 精準取得為主）
  * **state-live.js**：ensure ready / decrypt / persist+append（append 只允許 vaultPut 成功項）
  * **adapters/**：橋接 legacy DR / vault / timeline（用 DI，避免 UI 直呼）

### **目前重構進度**

已完成（可讀、可控）：

* UI / app lifecycle / WS 入口集中到 legacy facade（UI 不直呼 pipeline）
* A route scroll fetch：已拆成 server-api / vault-replay / normalize / orchestrator
* B route live MVP：已建立且 default disabled（WS incoming 精準 by-id 解密、vaultPut 成功才 append）

尚未完成（下一階段）：

* B route 完整 catch-up（離線/重登、counter gap、缺 key 補齊）
* replay vault-missing 的「只發訊號」→ 交由 reconcile/coordinator 決策是否進入 B route
* restore pipeline：登入後批次 hydrate DR holders、穩定化 B route（避免 plannedCount=0）

---

## **關鍵流程**

### **登入與主金鑰 (MK)**

1. **SDM 感應**：**POST /api/v1/auth/sdm/exchange**，Node 端驗證 MAC，透過 Worker 建立帳號。
2. **OPAQUE**：前端 ensureOpaque()** 與 Node **/api/v1/auth/opaque/\***（代理 Worker **/d1/opaque/\***）互動，不暴露密碼。**
3. **MK 處理**：若無 MK → 產生並 wrapMKWithPasswordArgon2id** → **/api/v1/mk/store**；若已有 → 解封 **wrapped\_mk**。**
4. **交棒**：登入頁將 mk\_b64**、**account\_token**、**account\_digest**、**wrapped\_dev**、**contactSecrets-\*** 放至 storage；App 取用後依策略清空。**

### **裝置金鑰與 Prekeys**

1. **備份**：無備份時產生 IK/SPK + OPKs → /api/v1/keys/publish** → 以 MK 包裝後 **/api/v1/devkeys/store**。**
2. **補貨**：已備份則解包 **wrapped\_dev**，視需要補 OPKs（例如每次 20 支），再度包裝並存回。
3. **Worker**：/d1/prekeys/publish** upsert；**/d1/prekeys/bundle** 配發且消耗對方 OPK。**

### **好友邀請與聯絡同步**

（略，維持現行 invite dropbox 設計；若要重構會另開文件與分支）

### **Double Ratchet 訊息傳遞（現況/目標）**

* 現況：legacy pipeline 仍在（messages.js / dr-session.js），但入口已被 facade 包起來避免 UI 亂呼叫。
* 目標：逐段替換為 messages-flow 的 B route coordinator + state/crypto/server adapters，最後移除 legacy 入口呼叫點。

### **媒體、設定與資料夾命名**

* **媒體 / Drive**：前端 MK 加密 → /media/sign-put** → R2；接收端 **/media/sign-get** → 解密。**
* **設定**：settings-<acctDigest>** 以 MK 包裝 AES-GCM 儲存；App 啟動 **ensureSettings()**，更新即 **saveSettings()**。**
* **其餘 envelope**：Profile/聯絡人/訊息/媒體皆以 MK 衍生 AES-GCM；儲存層只保存密文。

---

## **安全預設與環境配置**

* **登出清理**：**secureLogout()** 先 flush/persist，再清除 storage（依策略）。
* **背景行為**：依 **autoLogoutOnBackground** 等設定，可能在背景觸發 logout。
* **環境變數**：略（同原文）；重構期間如新增/改動，需同步更新此段。

---

## **營運與部署流程**

### **一鍵部署**

```
bash ./scripts/deploy-prod.sh --apply-migrations
```

（略；同原文）

### **D1 Schema 盤點（只讀）**

（略；同原文）

---

## **測試與自動化**

目前以**手動測試**為主。重構期間刻意避免依賴「有大量歷史資料」來驗證（E2EE 下難造假資料），建議只做最小可觀測的閉環測試：

* WS incoming →（live MVP 開啟後）ready → fetch(by id) → decrypt → vaultPut(incoming) → append

---

## **最新進度與工作項目**

* messages-flow：B route 完整化（離線/重登補齊、counter gap、自動補 key）
* restore pipeline：登入後 DR holders batch hydrate，避免 plannedCount=0
* legacy cleanup：等 messages-flow parity 後移除 messages.js pipeline 的入口與多餘 fallback

---

## **授權條款**

本專案採用 [GNU Affero General Public License v3.0](LICENSE)![Attachment.tiff](file:///Attachment.tiff)（AGPL-3.0-only）。若部署於可供他人透過網路存取的服務，請公開對應來源碼與修改內容，以確保社群共享與使用者權益。
