# AGENTS.md

本文件定義在 **SENTRY Messenger / messages-flow 重構專案** 中，所有 AI Agent（包含 Codex、Copilot、ChatGPT CLI 等）**必須遵守的工作規範、邊界與協作方式**。  
目標是避免「邏輯漂移、越權修改、重複返工」，確保重構能**逐步、可驗證、可回溯**地完成。

---

## 1. 專案背景（必讀）

本專案正在對 **端對端加密即時通訊系統** 的「訊息處理流程（message flow）」進行**大規模重構**。

### 核心現實
- 系統尚未上線，**允許暫時不可用**。
- 目前重構目標是 **結構清晰、責任明確、可取證**，而不是功能完整。
- 加密協議（X3DH / Double Ratchet）與資料表 schema **已存在且不可破壞**。
- 重構期間 **不依賴測試自動化**，而是靠人工取證與 log 驗證。

---

## 2. Agent 的角色定位

### Agent 是什麼
- Agent 是「**被指揮的實作者**」，不是系統設計者。
- Agent **不負責猜需求、不負責補腦、不負責最佳化體驗**。

### Agent 不是什麼
- ❌ 不是架構決策者  
- ❌ 不是產品經理  
- ❌ 不是自由發揮的 refactor bot  

**任何不確定的地方，一律停下來，要求補充指令。**

---

## 3. 核心架構共識（不可違反）

### 3.1 A route / B route 定義（鐵律）

#### A route（Replay）
- 條件：
  - `allowReplay = true`
  - `mutateState = false`
- 允許：
  - `vaultGet`
  - AES-GCM 解密
- 禁止：
  - 推進 DR state
  - `vaultPut`
  - gap-fill
  - 觸發 B route
- 若缺 key：
  - **只能標記狀態（vault_missing / placeholder）**
  - 不得直接 enqueue B route

#### B route（Live）
- 條件：
  - `allowReplay = false`
  - `mutateState = true`
- 允許：
  - DR decrypt
  - `vaultPut incoming`
  - timeline append
- 責任：
  - WS incoming live decrypt
  - offline 補解（未來階段）

---

## 4. Facade 原則（最重要）

### 唯一入口原則
- **UI / app lifecycle / WS handler**
  - 只能呼叫 `messages-flow-legacy.js`（Facade）
- 嚴禁：
  - UI 直接 import `messages.js`
  - UI 直接呼叫 decrypt / vault / state / server API

### Facade 的責任
- 接收事件
- 組裝參數
- 記錄 log
- 決定「要不要呼叫 legacy / live」
- **不實作任何 decrypt、vault、API 細節**

---

## 5. 重構階段（所有 Agent 必須知道）

> 若本節階段描述與 docs/messages-flow-spec.md 或 README.md 衝突，以規格與 README 為準。

### Phase 1（已完成）
- legacy flow 全部集中到 facade
- A route scroll fetch 模組化
- UI 與 pipeline 完全解耦
- log allowlist + cap 建立

### Phase 2（進行中）
- B route live MVP（WS incoming 單筆）
- 無 gap-fill
- 無 by-counter
- disabled by default（flag 關閉）

### Phase 3（未開始，禁止提前做）
- gap-fill / skipped keys
- offline catchup
- replay → live 協調
- legacy pipeline 拆除

👉 **Agent 嚴禁跨 Phase 行動**

---

## 6. 嚴格禁止事項

Agent **不得做以下任何一項**：

- 新增 `setInterval` / 無限迴圈 / timer loop
- 修改 DB schema
- 修改加密演算法
- 打開 feature flag（如 `USE_MESSAGES_FLOW_LIVE = true`）
- 直接改動 UI 呼叫 decrypt / vault
- 將 A route 與 B route 混在同一函式
- 在沒有指令的情況下新增「補救邏輯」

---

## 7. Commit 與 Git 規範

### 一次只做一件事
- 一個 commit = 一個明確目標
- 不混合：
  - 架構調整 + 行為改變
  - A route + B route

### 必須提供的取證
每一輪完成後，Agent **必須貼出**：
1. `git status --porcelain`
2. `git diff --name-only`
3. `git diff --stat`
4. 至少一個 `rg` 驗證（證明沒有越權）

沒有以上輸出 = 視為未完成。

---

## 8. Log 規範

- 所有新 log：
  - 必須進 allowlist
  - 必須有 cap（通常 = 5）
- Log 只做「**取證**」
  - 不影響流程
  - 不做判斷

---

## 9. 指令格式與輸出要求

### 當使用者說：
- **「給我 Prompt」**
  - 必須輸出：
    - 純文字
    - 可直接複製
    - 不使用程式碼區塊
    - 不使用特殊 UI 標記

### 不確定怎麼做？
- 停下來
- 問清楚
- 不要猜

---

## 10. 最重要的一句話

> **這不是在「修 bug」，而是在「建立一個未來能承載複雜行為的結構」。**

任何 Agent 的行為，只要讓結構變模糊、責任不清、或需要之後再「解釋為什麼會這樣」，  
**就是失敗。**

請嚴格遵守本文件。