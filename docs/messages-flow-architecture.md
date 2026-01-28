# 訊息流程架構

## 1. 目標
- 提供穩定的門面層（facade）作為訊息流程事件入口。
- 將路由（A/B）與 crypto/state/presentation 分離，讓 legacy 可逐步替換。
- 保持 UI 事件接線簡單，避免直接呼叫 pipeline 內部實作。

## 2. A 路徑 / B 路徑 定義與邊界
- A 路徑 = replay（僅 vault）
  - 條件：mutateState=false 且 allowReplay=true。
  - 只允許 vaultGet + AES-GCM 解密。
  - 不推進 DR、不做 gap-fill、不觸發 live decrypt。
  - 若發現缺 key，只能產生 missing-key 訊號/狀態（例如在結果 errors 或 placeholder 狀態中標記 vault_missing）。
  - 不得直接 enqueue B 路徑 job 或呼叫 live decrypt；是否進入 B 路徑由 Reconcile/Coordinator 決定。
- B 路徑 = live decrypt。
  - 條件：mutateState=true 且 allowReplay=false。
  - 可以推進 DR state 並 vaultPut incoming keys。
  - 本 MVP 僅 WS incoming 的 list → decrypt → persist，明確不含 gap-fill / by-counter / max-counter / offline catchup。

## 3. 模組分工（Facade/Queue/Server/State/Crypto/Presentation/Reconcile）
- Facade：將 UI/WS 事件轉為 job 的入口，不做 decrypt/vault/API。
- Queue：in-memory job queue + dedupe；不使用 timer loop。
- Server API：封裝既有 secure-message 端點。
- State：contact-secrets 與 message_key_vault 的單一存取層。
- Crypto：DR readiness/decrypt/skip-key derivation（不變更 schema）。
- Presentation：placeholder 規劃 + 解密後訊息套用 hook。
- Reconcile：依 counter 與 incoming 狀態規劃 catchup job。
- 目前結構（Phase 1）：
  - A 路徑（replay-only）模組位於 `web/src/app/features/messages-flow/`：server-api.js, vault-replay.js, normalize.js, scroll-fetch.js。
  - 共用骨架位於 `web/src/app/features/messages-flow/`：index.js, queue.js, state.js, crypto.js, presentation.js, reconcile.js。
- B 路徑（live）骨架（Phase 2）：
  - Coordinator：`web/src/app/features/messages-flow/live/coordinator.js`（單一入口，僅負責編排）。
  - Server API：`web/src/app/features/messages-flow/live/server-api-live.js`（secure message list）。
  - State：`web/src/app/features/messages-flow/live/state-live.js`（DR receiver state + vault put）。
  - Adapters：`web/src/app/features/messages-flow/live/adapters/`（legacy 橋接 messages.js/dr-session/message-key-vault/api）。
  - Adapters 介面（鎖定）：
    - ensureSecureConversationReady
    - ensureDrReceiverState
    - drState
    - drDecryptText
    - persistDrSnapshot
    - vaultPutIncomingKey
    - appendTimelineBatch
    - getAccountDigest
    - getDeviceId
  - Live MVP scope：僅 list → decrypt → persist；不含 gap-fill / by-counter / max-counter / offline catchup。
- Live wiring 備註：
  - B 路徑 live 已完成接線，但預設關閉（`USE_MESSAGES_FLOW_LIVE=false`）。
  - flag 關閉時行為維持 legacy-only。

## 4. 入口事件（login/ws/enter/resume/scroll）如何轉 job
- login：onLoginResume -> enqueue login_resume job。
- ws：onWsIncomingMessageNew -> enqueue ws_incoming_message_new job。
- enter：onEnterConversation -> enqueue enter_conversation job。
- resume：onVisibilityResume -> enqueue visibility_resume job。
- scroll：onScrollFetchMore -> enqueue scroll_fetch_more job。
- Job 只描述發生了什麼事件，不包含處理策略。
- A/B 路徑是處理策略，由 Coordinator/Reconcile 依狀態選擇。
- 同一個 job 在不同時刻可能走不同路徑；不得把路徑寫進 job 名稱（禁止 xxx_live / xxx_replay 這類拆分）。

## 5. 禁止事項（UI 不直呼 pipeline、無 timer loop、A 路徑 不觸發 B 路徑）
- Facade 是唯一允許被 UI / app lifecycle / WS handlers 呼叫的入口。
- pipeline 內部模組（A/B 路徑、queue、server-api、crypto、state 等）不得被 UI/WS 直接 import 或呼叫。
- 不新增 setInterval / 迴圈式 setTimeout。
- A 路徑不得直接觸發 B 路徑，不得直接 enqueue B 路徑 job 或呼叫 live decrypt；是否進入 B 路徑由 Reconcile/Coordinator 決定。

## 6. 後續替換計畫（Phase 3：逐段替換順序）
- 以新 facade + queue + reconcile 取代 WS incoming handling。
- 以 server-api/state/crypto adapters 取代 replay（A 路徑）list path。
- 以新的 crypto/state adapters 取代 live decrypt（B 路徑）。
- 以 presentation adapter wiring 取代 placeholder planning。
- 完成 parity 後移除 legacy facade 與 legacy pipeline 入口呼叫。
