# SENTRY Messenger — Messages Flow Spec (Authoritative)

> 本文件是 **唯一權威規格**。
> 任何實作、重構、Codex 修改、Prompt 內容，若與本文件衝突，一律以本文件為準。
> 不得以「既有程式碼/既有行為」推翻本規格；若現況不符合，應修正現況而非修正文檔。

---

## 0. 名詞與核心概念

### 0.1 Conversation / Peer / Device

- **Conversation**：對話（conversationId），所有訊息在同一 conversation 中以 **單調遞增 counter** 序列化。
- **Peer**：對端身分（peerAccountDigest + peerDeviceId）。
- **Device**：本機裝置（selfDeviceId）。目前系統假設 **單帳號單裝置**，即：
  - 對話 × 對方裝置 × 我方裝置 = N × 1 × 1
  - 每個 conversation 對每個 peer device 只會維護 **一份 DR 狀態（snapshot）**。

### 0.2 Counter / Header Counter

- **counter / header_counter / headerCounter**：指同一套語意：
  **per conversation 的單調遞增序列號**，用於訊息完整性與 DR 推進。
- **messages_secure.counter（server）** 與 **message_key_vault.header_counter（key vault）** 指向同一個 counter 語意（不是兩種不同 counter）。

> 注意：counter 是「序列」，不是時間。時間戳只用於 UI 排序與呈現，不用於一致性判斷。

### 0.3 A route vs B route（必須清楚，禁止混用）

本系統明確拆成兩條路：

#### A route = Replay (Vault-only)

- 目的：顯示歷史訊息（例如 scroll fetch、relogin 回放）。
- 條件：`mutateState=false && allowReplay=true`（或等價判斷 computedIsHistoryReplay=true）。
- **嚴格限制：**
  1. **不得使用 DR 解密**（不得推進/改寫 DR state、不得產生 skipped keys、不得清/建 DR holder）。
  2. **不得 vaultPut(incoming)**（因為沒有 live decrypt）。
  3. **只允許 vaultGet(message_key_vault) + AES-GCM 解密**。
  4. 任何 vault missing 只能「標記」與「handoff」，不得直接在 A route 啟動 B route 工作。

#### B route = Live decrypt / Catch-up (DR + vaultPut incoming)

- 目的：補齊離線、補齊 gap（跳號）、補齊 vault missing、讓訊息「可回放」。
- 條件：`mutateState=true && allowReplay=false`（live）。
- **允許與必做：**
  1. 可以/必須使用 DR（推進 state、使用 skipped keys）。
  2. 每次解密成功必須 **vaultPut(incoming key)**（讓 A route 日後可回放）。
  3. 解密成功後必須持久化 DR snapshot（本機 + 可選遠端）。
  4. 必須能在「本機 storage 清空」後透過 restore pipeline 恢復並完成 catch-up。

---

## 1. 伺服器與資料表（不可改語意）

### 1.1 messages_secure（server）

- 存放密文與 metadata，包含：
  - `conversation_id`
  - `id`（messageId / serverMessageId）
  - `counter`（單調遞增）
  - sender/receiver digest & deviceId
  - ciphertext / header（含 headerCounter）
- server 對 `/messages/secure`（或相應 endpoint）會以 counter 單調性保護：
  - 低於或等於 server 已見最大 counter → 可能 409 CounterTooLow

### 1.2 message_key_vault（server-side D1）

- 存放「被 MK 包裝後的 message key」：
  - `account_digest`（誰的 vault）
  - `direction`：outgoing/incoming
  - `conversation_id`
  - `message_id`（主要索引）
  - `header_counter`
  - `sender_device_id` / `target_device_id`
- **incoming direction 的 key** 只有在 receiver 端 live decrypt 成功後才會寫入（vaultPut incoming）。

---

## 2. UI 與 Flow 的責任分工（必須模組化）

### 2.1 UI 層（messages-pane / app-mobile）

- UI 層不可直接呼叫「訊息處理 pipeline」的核心（例如 listSecureAndDecrypt 等），只能呼叫 facade（legacy 或新 flow facade）。
- UI 的工作：
  - 顯示 timeline（已解密訊息）
  - 顯示 placeholder（解密中 / 補齊中）
  - 顯示網路狀態燈號、通知、未讀數
  - 觸發 entry events：login、ws message-new、enter conversation、scroll fetch、resume 等

### 2.2 Flow 層（messages-flow）

- Flow 層是唯一可以：
  - 拉密文（server api）
  - 解密（A/B 路線）
  - 推進 state（只限 B）
  - 寫入 vaultPut incoming（只限 B）
  - 產生/更新 placeholder（規則見下）
  - 管理 queue（counter gap queue / repair tasks）
- Flow 層必須是可被測試、可被替換的模組。

### 2.3 Legacy Facade（messages-flow-legacy）

- 目的：Phase 1 先「把入口集中」，避免 UI/APP 亂呼叫。
- 允許存在 legacy pipeline，但必須：
  - UI-only boundary：UI 不直接碰 pipeline
  - 所有 entry events 經由 facade
  - feature flags 控制逐步切換到 messages-flow 新實作

---

## 3. Placeholder 規格（非常重要）

### 3.1 Placeholder 的種類（必須分離）

- **Replay placeholders（A route）**
  - UI-only 狀態：不得寫入 timeline store（避免與 B route/gap placeholders 混用）
  - 只表示「正在回放 / vault 解密中 / vault 缺失」
  - 不推進 DR，不影響 state
- **Gap placeholders（B route）**
  - 與 counter gap 對齊，屬於「會被 B route 真正補齊」的 placeholder
  - 允許與 timeline 交錯呈現（依 timestamp/counter 排序規則見 3.3）

### 3.2 Placeholder 不得包含控制訊息

- 任何 CONTROL / STATE / contact-share / receipts 類型：
  - 不得生成 placeholder
  - 不得影響未讀數/音效
  - 不得被 UI 當成 user message 排序/呈現

### 3.3 Placeholder 排序規則

- 最終視圖排序必須一致：
  - 同側（incoming 或 outgoing）主要以 **counter** 排序
  - 左右側混排的整體視覺順序以 **timestamp（精確到毫秒）** 為主
  - 若 timestamp 相同，用 counter tie-break
- 如果收到了 counter 跳號（例如 local=8 收到 11）：
  - UI 必須在同側插入 9、10 的 gap placeholders（解密中），並依 timestamp/counter 正確插入位置（不是永遠在尾端）。
  - 解密成功後 placeholder 必須逐筆被替換成真實訊息內容（有 reveal 動畫）。

### 3.4 Placeholder 逐筆 reveal（視覺）

- B route 每解開一筆（例如補齊 counter 9）：
  - 立刻把該筆 placeholder 替換為真實內容
  - 套用 reveal 動畫（掃描/揭露效果，不是轉圈圈）
- 若某筆補齊重試失敗達上限：
  - placeholder 必須標記為「無法解密」（不可永久卡住）

### 3.5 Commit-driven Side Effects

- 定義（receiver side）：Commit = B route 成功 decrypt 後，至少完成：
  - vaultPut incoming key 成功
  - DR snapshot persist 成功
- 規範：
  1. Notifications / Unread / Sound MUST be commit-driven。
     - MUST NOT 由 WS notify / fetch / probe / replay 直接觸發。
  2. Placeholder reveal MUST be commit-driven。
     - A route replay placeholder MUST NOT 觸發 reveal。
  3. WS / fetch / probe MUST NOT 直接產生 user-visible side effects。
     - 只能 enqueue jobs / update progress / log。

---

## 4. Counter Gap 自動補齊（B route 核心能力）

### 4.1 問題模型

- 若 receiver 端收到 counter X，但本地已完成處理到 Y，且 `X > Y + 1`：
  - 表示缺少 `Y+1 ... X-1` 的密文或至少未被處理
- 在 DR 模型下：
  - 可以用 skipped keys 推導缺失段的解密 key
  - 但必須先拿到對應 counter 的密文來解密

### 4.2 Gap fill 的正確策略

- 所有「收到密文通知」或「發現 serverMaxCounter 落後」都應進入同一個 queue（counter-sorted queue）。
- queue 的處理必須 **嚴格序列化**（per conversation），避免並行推進同一個 state。
- 單一 conversation 的 B route worker 具備以下原子步驟：
  1. 取得當前 localProcessedCounter（最後成功處理到哪個 counter）
  2. 取得 targetCounter（來源可能是：incoming notify 的 counter / server max counter）
  3. 若 targetCounter <= localProcessedCounter：丟棄或記錄（已處理）
  4. 若 targetCounter > localProcessedCounter：
     - 先確保 UI 上存在 localProcessedCounter+1..targetCounter 的 placeholders（同側插入）
     - 從 counter=localProcessedCounter+1 依序做：
       - server api：`getSecureMessageByCounter(conversationId, counter)` 取得密文
       - 使用 DR skipped keys（從 state 推導）解密
       - 解密成功：
         - vaultPut incoming key（必要）
         - persist DR snapshot（必要）
         - placeholder -> 真實訊息 reveal
         - localProcessedCounter++
       - 解密失敗：按 retry policy 重試
  5. 完成後，掃描 queue 移除所有 `counter <= localProcessedCounter` 的任務

### 4.3 Retry policy（gap fill）

- 每個 counter 的補拉/解密：最多 3 次
- 間隔 2 秒
- 計時起點：在「request 發出後收到錯誤 / timeout / 無回應」才開始算下一次間隔

---

## 5. “max-counter” 探針與 WS 漏通知補救

### 5.1 為什麼要有 max-counter 探針

- WS 可能漏通知，receiver 不知道有新訊息
- 但 server（messages_secure）已經有最新 counter

### 5.2 探針策略（不靠 timer 的版本）

- 事件驅動觸發（不一定要定時）：
  - login 完成
  - ws_auth_ok / reconnect
  - enter_conversation
  - visibility resume / pageshow persisted
  - pull-to-refresh
- 每次觸發：
  - 呼叫 `fetchSecureMaxCounter(conversationId)` 得到 serverMaxCounter
  - 若 serverMaxCounter > localProcessedCounter：
    - enqueue 一個 targetCounter=serverMaxCounter 的任務到 gap queue
    - 由 B route worker 序列化處理

> 若將來你允許定時（timer），只能作為保底，不得取代 event-driven。

---

## 6. Outgoing（發送端）狀態語意（簡化）

### 6.1 單勾 / 雙勾定義（最新版語意）

- ✓（sent）：發送端已完成 server 端持久化（messages_secure 已寫入；等價於你原先定義的 202 持久化 ack 概念）
- ✓✓（delivered）：對端已完成 **live decrypt + vaultPut incoming key**（等價於「對端可回放」）

> delivered 的證據來源優先順序：
>
> 1) receiver 端 vaultPut ok 後 WS vault-ack 通知 sender（即時）
> 2) sender 端 outgoing-status reconcilation（延遲補救）

### 6.2 發送端勾勾顯示策略（最終目標）

- 僅「最新 outgoing」顯示 ✓ 或 ✓✓（其餘 older outgoing 可隱藏勾勾或全部視為已涵蓋）
- 一旦最新變成 ✓✓：
  - 代表「截至該 counter 之前的所有 outgoing 都已被對方接收並可解密」
  - 舊訊息不需再單獨顯示 ✓/✓✓
- 所有 UI 與狀態邏輯需與此語意一致

---

## 7. Backup & Restore（確保重登後可解離線訊息）

### 7.1 DR snapshot 的事實（重要）

- 「最新 snapshot」**不能保證**能解出所有舊訊息：
  - 若你漏掉某些 message（counter gaps）且 state 已推進，沒有補齊前面的 skipped keys 或沒有拿到密文，舊訊息可能無法在純 live decrypt 下倒回解
- 正確策略不是依賴「只有最後 snapshot」：
  - 而是：在 restore 後用 serverMaxCounter vs localProcessedCounter 做 catch-up，依序補齊 gaps，讓 state 自然推進並完成 vaultPut

### 7.2 事件驅動 snapshot 備份（必做）

觸發時機至少包含：

- 每次 live decrypt 成功（vaultPut incoming ok）
- 每次 gap fill 成功補齊一個 counter
- app 背景化 / visibility hidden 前（若允許）
- logout 前（必做；且必須修正 flush 不可 throw）

備份目標：

- 本機 contact-secrets persist（localStorage/sessionStorage）
- 若 MK 可用：觸發遠端 contact_secret_backups（不得被 withDrState gate 錯誤跳過）

### 7.3 Restore Pipeline（登入後進度可視）

必須提供一個可視化 pipeline（允許耗時），至少有：

- Stage0 credentials ready（MK/account token/deviceId）
- Stage1 local restore contact-secrets
- Stage2 remote hydrate contact-secrets（若可）
- Stage3 hydrate DR holders（批次；不得再是 stub）
- Stage4 B route catch-up（serverMaxCounter vs localProcessedCounter；補齊 gaps；逐筆 reveal）
- Stage5 done（解除解密中狀態）

> UX：必須顯示進度（count/percent 或至少“正在同步/正在解密/完成”），避免使用者覺得卡死。

---

## 8. API 與格式規範（不可亂猜）

### 8.1 digest-only

- server API 中所有 *AccountDigest* 欄位（如 receiverAccountDigest）必須是 64-hex digest-only，不接受 DIGEST::DEVICE。

### 8.2 必要的 server APIs（至少）

- `GET/POST /messages/secure?conversationId&limit&cursor...`：拉密文列表
- `GET/POST /messages/secure/max-counter`：取 server max counter
- `GET/POST /messages/secure/by-counter`（或等價）：依 conversationId + counter 取密文
- `POST /message-key-vault/put`：寫入 key（incoming/outgoing）
- `POST /message-key-vault/get`：讀取 key（A route replay 使用）

> 若沒有 by-counter API，必須新增；或以 list+filter 模擬，但不得低效到不可用。

---

## 9. 禁止事項（Hard Rules）

1. UI 不可直接呼叫 pipeline（listSecureAndDecrypt / catch-up / gap fill）
2. A route（replay）不可：
   - 使用 DR
   - 推進 state
   - vaultPut
   - 直接執行 gap fill
3. B route（live）不可：
   - 使用 vault-only 解密當作最終策略（vault 是結果，不是解法）
4. 控制訊息不可：
   - 進 placeholder
   - 影響未讀/音效
5. 任何「補送通知可解決漏訊」的假設，必須移除
6. 任何 retry/backoff/queue policy 必須集中在 policy 檔案（單一來源），禁止散落 hardcode
7. 所有新增加的 log key 必須 cap<=5 並 allowlist（replay/forensics）

---

## 10. Phase Plan（重構節奏）

### Phase 1（已做 / 進行中）

- 將入口事件集中到 legacy facade（UI-only boundary）
- 建立 messages-flow skeleton（不改 crypto/DR schema）

### Phase 2（下一步）

- 先替換「scroll fetch」：實作 messages-flow 的 A route scroll-fetch（vault-only）
- feature flag 控制切換
- 確認 placeholders/reveal 與 A route 的 UI-only placeholder 互不干擾

### Phase 3

- 實作 messages-flow 的 B route gap queue（按 counter 序列化）
- 加入 server max-counter 探針（事件驅動）
- 實作 by-counter 拉取與逐筆 reveal

### Phase 4

- Restore pipeline 進度 UI
- DR batch hydrate（實作 stub）
- 修正 logout flush 必定成功（不得 throw）

### Phase 5

- 清理 legacy flow（逐段刪除）
- 移除棄用 log/policy/flags
- 收斂成單一 messages-flow

---

## 11. 验收标准（不靠感觉）

1. 任何 conversation：若 serverMaxCounter = N，本地最终可处理到 N（B route 补齐）
2. replay（A route）对任意已补齐的訊息：vault-only 可解（无 DR）
3. placeholder：
   - gap placeholders 会逐笔 reveal，不永久卡住
   - replay placeholders 不会污染 gap placeholders
4. logout + 清空 storage + relogin：
   - Stage0~Stage5 可跑完（允许耗时）
   - 离线期间对方发的訊息可完整恢复
5. 无 “CounterTooLow” 由 client 并发/乱序引发（per-conv 序列化正确）

---

## 12. 备注（你现在的现实约束）

- 你可以接受「登入后 restore 很久」，但必须可视化进度。
- 你目前单账号单装置，因此 snapshot 管理复杂度较低（每对话一个 snapshot）。
- D1 schema 已足够，本轮重构优先不改 schema；除非真的缺 by-counter 查询能力。

---
