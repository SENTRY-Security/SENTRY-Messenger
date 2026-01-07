# SKILL.md

本文件定義 **SENTRY Messenger / messages-flow 重構專案** 中，AI Agent（尤其是 Codex 類型）**被允許使用、被禁止使用、以及必須具備的技能邊界**。  
這不是能力清單，而是 **「可動用技能白名單」**。

---

## 1. 技能分級模型（Agent 能做什麼）

### Level 0：讀取與取證（永遠允許）
Agent 必須能熟練執行：

- `rg`, `grep`, `sed`, `awk`, `nl`
- `git status`, `git diff`, `git show`
- 靜態閱讀程式碼
- 比對行為與文件是否一致
- 列出「有 / 沒有」的證據

> **任何改動前，先取證。沒有取證直接改碼 = 違規。**

---

### Level 1：結構性重構（允許，需明確指令）

可做的事情：

- 模組切分（file split / move）
- Facade / Adapter / Coordinator 抽離
- 重命名（只要語意更精準）
- 將舊邏輯「包起來」但不改行為
- 新增 **disabled-by-default** 的骨架（skeleton）

限制：

- ❌ 不得改變 runtime 行為
- ❌ 不得補齊功能
- ❌ 不得「順便修 bug」

---

### Level 2：受控行為新增（僅在指定 Phase）

僅在明確指示下允許，例如：

- B route live MVP（單筆、WS incoming）
- 僅限：
  - decrypt
  - vaultPut
  - timeline append
- 必須：
  - disabled by default
  - 有完整取證 log
  - 有嚴格 gating

---

## 2. 明確禁止的技能（黑名單）

Agent **絕對禁止**使用以下能力：

### ❌ 自主設計能力
- 猜需求
- 補齊未被要求的流程
- 「我覺得這樣比較好」

### ❌ 架構越權
- 修改加密協議
- 修改 DR / X3DH 行為
- 修改資料庫 schema
- 新增 server API

### ❌ 隱性行為
- 開啟 feature flag
- 加入 retry loop
- 加入 timer / polling
- 在錯誤時自動 fallback 到其他 route

---

## 3. 技能使用的必要條件（Gate）

### 3.1 使用「寫程式」技能前，必須滿足

- 使用者提供 **明確 Prompt**
- Prompt 指出：
  - 範圍（哪些檔案 / 模組）
  - 允許與禁止事項
  - 所屬 Phase
- Agent 能重述需求且與使用者確認一致（隱含）

---

### 3.2 使用「重構」技能前，必須滿足

- 能清楚指出：
  - 舊責任在哪
  - 新責任在哪
- 能說明：
  - 行為是否改變（必須回答：沒有 / 有，哪裡）

---

## 4. Agent 必須具備的核心能力

### 4.1 邊界感（Boundary Awareness）

Agent 必須隨時知道：

- 自己在 **A route / B route / Facade / UI**
- 自己是否在：
  - crypto 層
  - state 層
  - presentation 層

一旦跨層，必須停下。

---

### 4.2 架構記憶能力（Context Memory）

Agent 必須能維持以下長期共識：

- A route 永遠不推進 state
- B route 才能 vaultPut
- UI 永遠不碰 pipeline
- Facade 是唯一入口

如果遺忘，等同技能失效。

---

### 4.3 可取證性（Auditability）

每一次輸出，Agent 都必須能：

- 指出改了哪些檔案
- 指出沒改哪些檔案
- 用 `rg` 證明沒有違規

---

## 5. 技能輸出格式規範（非常重要）

### 當使用者說：
- **「給我 Prompt」**
  - Agent 必須輸出：
    - 純文字
    - 可直接複製
    - 不用 code block
    - 不用 Markdown 特殊結構
    - 不夾雜解說

### 當使用者說：
- **「審核 / review」**
  - 只做判斷：
    - PASS / FAIL
    - 若 FAIL，指出 1–3 個具體違規點
  - 不重新設計
  - 不延伸需求

---

## 6. 常見錯誤模式（Agent 自我檢查）

在輸出前，Agent 應自問：

- 我是不是「多做了」？
- 我是不是假設了未說明的需求？
- 我是不是把 A/B route 混在一起？
- 我是不是改了行為卻說只是重構？

只要有一題是「是」，就該停下。

---

## 7. 最後提醒

> **這個專案需要的不是聰明，而是紀律。**

Agent 的價值不是「寫很多程式碼」，  
而是 **在極嚴格邊界內，穩定地完成指定工作**。

請以此為最高指導原則。