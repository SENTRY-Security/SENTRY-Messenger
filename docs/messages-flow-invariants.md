# Messages Flow 不變量（Invariants）

本文件定義 messages-flow 的不可違反行為不變量（Invariants）。
本文件不是權威規格；若與 docs/messages-flow-spec.md 衝突，一律以後者為準。
本文件目的為將最容易被重構或 AI 修改破壞的硬規則，以 MUST / MUST NOT / NEVER 形式固定。

## Layer 1：Implementation / Wiring Invariants（實作層）

### Flag-off 行為等價
- 當 USE_MESSAGES_FLOW_LIVE = false 時，legacy handler MUST 執行。
- 當 USE_MESSAGES_FLOW_LIVE = false 時，live path MUST NOT 可達。
- 當 USE_MESSAGES_FLOW_LIVE = false 時，liveMvpResultTrace MUST 在 legacy handler 後寫入一次。

### Decision 語義分離
- liveEnabled 與 hasLiveJob MUST NOT 互相推導。
- 當 USE_MESSAGES_FLOW_LIVE = false 時，decision.action MUST NOT 為 TRIGGER_LIVE_MVP。

### Live gating
- consumeLiveJob MUST 為唯一 live 執行入口。
- 當 USE_MESSAGES_FLOW_LIVE = false 時，consumeLiveJob MUST NOT 可達。

### 不可信輸入處理
- 不可信輸入 MUST NOT 展開（禁止 `{ ...ctx }` 或任何展開不可信物件）。
- LiveJob 建立 MUST 僅允許 explicit field picks。

### Logging / Observability
- 新增 log key MUST allowlist 且 MUST capped。
- 當 USE_MESSAGES_FLOW_LIVE = false 時，既有 trace 覆蓋 MUST NOT 減少。

## Layer 2：Protocol / Messages-Flow Invariants（系統級）

### A route 不變量（Replay）
- A route MUST NOT 使用 DR。
- A route MUST NOT 推進 state。
- A route MUST NOT vaultPut incoming。
- A route MUST NOT 直接觸發 B route。
- 缺 key MUST 只能標記狀態，MUST NOT 進行補救。

### B route 不變量（Live / Catch-up）
- B route MUST 使用 DR。
- 每次成功解密 MUST vaultPut incoming key。
- 每次成功解密 MUST persist DR snapshot。
- B route MUST 為唯一允許改變 state 的路徑。

### Counter 與 Gap Queue
- counter MUST 為 per conversation 的全域單調序列。
- counter MUST 為唯一的一致性與狀態推進權威。
- timestamp MUST 僅用於 UI 排序。
- timestamp MUST NOT 用於一致性、gap 判斷或狀態推進。
- B route MUST per conversation 序列化（single worker）。
- gap fill MUST 逐 counter 補齊，MUST NOT 跳號。
- localProcessedCounter MUST 僅在成功 commit 後前進。

### Placeholder 不變量
- replay placeholder 與 gap placeholder MUST 分離。
- control message MUST NOT 產生 placeholder。
- gap placeholder MUST 逐筆 reveal，MUST NOT 永久卡住。

### Side Effects Invariants
- Side effects（notification / unread / sound / placeholder reveal）MUST be commit-driven。
- Side effects MUST NOT be WS / fetch / probe-driven。
- Side effects MUST NOT be replay-driven。

### Restore / Catch-up
- snapshot MUST NOT 保證可解所有舊訊。
- restore 後 MUST 以 serverMaxCounter vs localProcessedCounter 做 catch-up。
- B route MUST 為 restore 的唯一補救手段。

### Policy 集中化
- retry / backoff / queue policy MUST 集中定義。
- bounded retry MUST 僅限 per-counter / per-job。
- bounded retry MUST NOT 以背景 poller 或全域 timer loop 實作。
- 禁止散落 hardcode：MUST NOT 在各處硬編碼 policy。
- 禁止無界 timer loop：NEVER 允許無界 timer loop（bounded retry 例外）。
