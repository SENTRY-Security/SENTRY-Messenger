# SENTRY-Messenger 群組功能缺項分析報告

> 審查日期：2026-03-08
> 分析範圍：Backend (Express)、Data Worker (D1)、Frontend (Vanilla JS SPA)

---

## 一、現有實作盤點

### 已完成

| 層級 | 功能 | 檔案 | 狀態 |
|------|------|------|------|
| DB Schema | `groups` 表 | `data-worker/migrations/0001_consolidated.sql:145` | 完成 |
| DB Schema | `group_members` 表（含 role/status/muted_until/last_read_ts） | `0001_consolidated.sql:160` | 完成 |
| DB Schema | `group_invites` 表（含 expires_at/used_at） | `0001_consolidated.sql:181` | 完成 |
| Data Worker | 建立群組（INSERT + 成員 upsert） | `data-worker/src/worker.js:4002` | 完成 |
| Data Worker | 新增成員 | `worker.js:4067` | 完成 |
| Data Worker | 移除成員（狀態更新） | `worker.js:4108` | 完成 |
| Data Worker | 查詢群組 + 成員列表 | `worker.js:4151` | 完成 |
| Data Worker | 帳號清除時連帶刪除群組資料 | `worker.js:4969-5136` | 完成 |
| Backend API | `POST /groups/create` | `src/routes/v1/groups.routes.js:12` | 完成 |
| Backend API | `POST /groups/members/add` | `groups.routes.js:13` | 完成 |
| Backend API | `POST /groups/members/remove` | `groups.routes.js:14` | 完成 |
| Backend API | `GET /groups/:groupId` | `groups.routes.js:15` | 完成 |
| Frontend API | createGroup / addGroupMembers / removeGroupMembers / getGroup | `web/src/app/api/groups.js` | 完成 |
| Frontend Feature | createGroupProcess（密鑰產生 + API 呼叫 + local draft） | `web/src/app/features/groups.js` | 完成 |
| Frontend Feature | LocalGroupStore（sessionStorage/localStorage 草稿） | `features/groups.js:41` | 完成 |
| Frontend UI | GroupBuilderController（建立群組 UI + 成員選擇） | `ui/mobile/controllers/group-builder-controller.js` | 完成 |
| i18n | 群組相關翻譯鍵（zh-Hant） | `web/src/locales/zh-Hant.json:956` | 完成 |

### 功能被禁用

```javascript
// web/src/app/ui/mobile/messages-pane.js:140
const GROUPS_ENABLED = false;

// web/src/app/ui/mobile/controllers/group-builder-controller.js:17
this.GROUPS_ENABLED = false; // Feature flag
```

**整個群組功能目前透過 feature flag 完全關閉，所有 UI 操作被 guard 擋住。**

---

## 二、缺項分析（按嚴重程度排序）

### P0 — 核心阻塞（無法正常使用群組）

#### 1. 群組加密協議未實作
- **現狀**：`createGroupProcess` 產生一個共享 secret 並透過 `deriveConversationContextFromSecret` 衍生 conversationId，但沒有實作群組專用的金鑰分發機制
- **缺項**：
  - 無 Sender Keys 或 Group Session 協議（Signal 的 Sender Key Distribution Message 模式）
  - 無法對每個成員加密分發群組密鑰
  - 成員加入/退出時無密鑰輪換（Key Rotation）機制
  - 群組密鑰僅存於 localStorage，無跨裝置同步
- **影響**：群組訊息無法端到端加密，與專案安全架構不符

#### 2. 群組訊息收發完全未實作
- **現狀**：沒有任何群組訊息的發送或接收邏輯
- **缺項**：
  - `messages-flow/` 下無群組訊息處理（hybrid-flow.js 僅處理 1-to-1 DM）
  - 無群組訊息的 Double Ratchet 或 Sender Key 加解密
  - 無群組訊息的 WebSocket 推送路由
  - 無群組聊天視窗 UI
- **影響**：建立群組後無法發送任何訊息

#### 3. WebSocket 無群組事件支援
- **現狀**：`src/ws/` 目錄中完全沒有 group 相關邏輯
- **缺項**：
  - 無群組訊息即時推送
  - 無群組成員變更通知
  - 無群組打字指示器（typing indicator）
  - 無群組 presence 狀態
- **影響**：即使訊息能存入 DB，也無法即時送達

#### 4. 群組對話未整合至對話列表
- **現狀**：`conversation.js` 中無任何 group 相關邏輯
- **缺項**：
  - 群組對話不會出現在 conversation list 中
  - 無法從對話列表點入群組聊天
  - timeline-store.js 未考慮群組對話
  - 無群組最後訊息預覽
- **影響**：使用者找不到已建立的群組

---

### P1 — 重要缺項（功能不完整）

#### 5. 群組邀請系統未實作
- **現狀**：`group_invites` 表已建立，但完全無對應 API 或前端邏輯
- **缺項**：
  - 無邀請連結/QR Code 產生 API
  - 無邀請接受/拒絕 API
  - 無邀請過期清理
  - 無前端邀請 UI
- **影響**：無法透過邀請機制加人

#### 6. 群組管理功能不完整
- **缺項**：
  - 無修改群組名稱/頭像 API（`PUT /groups/:groupId`）
  - 無群組描述欄位
  - 無群組公告功能
  - 無轉讓群主 API
  - 無群組解散/刪除 API
- **影響**：群組建立後無法修改任何設定

#### 7. 成員權限控管不足
- **現狀**：DB schema 有 `role` 欄位（owner/admin/member），但 API 層未實作權限檢查
- **缺項**：
  - `addGroupMembers` 未驗證操作者是否為 owner/admin
  - `removeGroupMembers` 未驗證操作者權限
  - 無角色變更 API（升降管理員）
  - 無成員操作的 ACL 控制（誰能發訊息、誰能邀人）
- **影響**：任何知道 groupId 的人都能加/移成員

#### 8. 群組成員靜音/已讀未整合
- **現狀**：DB 有 `muted_until` 和 `last_read_ts` 欄位，但無對應 API
- **缺項**：
  - 無靜音群組 API
  - 無更新已讀時間戳 API
  - 無群組未讀計數
  - 無群組通知設定 UI
- **影響**：無法控制群組通知

---

### P2 — 體驗缺項（功能可用但體驗差）

#### 9. 群組媒體分享未規劃
- **缺項**：
  - 無群組媒體加密策略（Sender Key 與 chunked-upload 的整合）
  - 無群組相簿/檔案瀏覽
  - 群組檔案的儲存配額計算邏輯未定義

#### 10. 群組搜尋功能缺失
- **缺項**：
  - 無群組內訊息搜尋
  - 無群組名稱搜尋（從對話列表）
  - 無成員搜尋

#### 11. 群組通話未規劃
- **現狀**：通話功能（`features/calls/`）僅支援 1-to-1
- **缺項**：
  - 無多人語音通話（SFU/MCU 架構）
  - 無多人視訊通話
  - 無群組通話的 E2EE 策略

#### 12. 前端離線/同步機制
- **缺項**：
  - 群組訊息的 gap detection & fill 未實作
  - 群組成員列表的離線快取
  - 群組設定的本地快取（目前僅有 draft 快取）

#### 13. 群組訊息的特殊功能
- **缺項**：
  - 無 @mention 功能
  - 無訊息引用/回覆（reply to specific message in group）
  - 無訊息置頂
  - 無群組投票

---

## 三、技術債與架構風險

### 1. LocalGroupStore 的局限性
- 使用 sessionStorage/localStorage 儲存群組資訊，包含 `secretB64Url` 和 `tokenB64` 等敏感資料
- 無加密保護，容易被 XSS 讀取
- 應改用 IndexedDB + Web Crypto API 加密存放

### 2. API 缺少權限中間件
- 現有的 groups controller 直接使用 `resolveAccountAuth` 驗證身份，但未檢查該使用者是否為群組成員/管理員
- 應建立 group-level authorization middleware

### 3. 群組 conversation_id 與一般對話的 namespace 衝突風險
- `createGroupProcess` 透過 `deriveConversationContextFromSecret` 產生 conversationId
- 需確保此 ID 不會與 1-to-1 對話衝突
- 建議加入 prefix 或 type 欄位區分

### 4. i18n 不完整
- 群組翻譯鍵僅存在於 `zh-Hant.json`
- 其他語言檔案（en/ja/ko/th/vi/zh-Hans）均缺少 `groups` section

---

## 四、建議實作優先順序

```
Phase 1 — 基礎通訊（解除 P0）
├── 設計群組加密協議（Sender Keys + Key Distribution）
├── 實作群組訊息收發（含 WebSocket 推送）
├── 整合群組至對話列表與 timeline
└── 開啟 GROUPS_ENABLED feature flag

Phase 2 — 管理與安全（解除 P1）
├── 實作群組邀請系統
├── 實作權限控管中間件
├── 群組設定修改 API
├── 成員靜音/已讀整合
└── 密鑰輪換機制

Phase 3 — 體驗優化（解除 P2）
├── 群組媒體分享
├── 群組搜尋
├── @mention 與訊息引用
├── 離線同步機制
└── i18n 補齊

Phase 4 — 進階功能
├── 群組語音/視訊通話
├── 群組公告/投票
└── 群組分析/統計
```

---

## 五、結論

群組功能目前處於 **早期骨架階段**：DB schema 完整、基本 CRUD API 可用、建立群組 UI 存在但被 feature flag 關閉。**核心的群組加密通訊、訊息收發、即時推送完全未實作**，是最大的缺口。建議優先處理 Phase 1 的 P0 項目，才能讓群組功能達到最低可用狀態。
