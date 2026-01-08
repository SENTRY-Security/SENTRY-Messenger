# Messages Flow 重構驗收盤點與 Code Review 報告（重做版）

1. 審查範圍與方法
- 目的：依現有 repo 狀態驗收 messages-flow 重構成果，確認 A-route/B-route/Facade/UI boundary 是否符合規格。
- 背景（必述）：
  - 本專案 message flow 已重構為 messages-flow，並強制分離 A-route(replay) 與 B-route(live decrypt)。
  - A-route：vault-only 解密；不得推進 DR；不得 vaultPut；不得直接觸發 B-route；只能產生 missing-key 訊號。
  - B-route：live decrypt；可推進 DR；可 vaultPut incoming；可 append timeline；restore/catch-up/gap queue 屬 B-route 職責。
  - UI/lifecycle/WS 只能透過 facade 進入 message flow。
  - legacy 檔案存在不等於 runtime 仍使用。
- 方法：只讀取證（git/rg/sed/ls/cat），不修改程式碼、不跑測試、不啟服務。
- 證據指令（只讀）：
  - `git rev-parse --abbrev-ref HEAD`
  - `git status --porcelain`
  - `git log -10 --oneline --decorate`
  - `ls -R docs | rg "messages-flow"`
  - `rg -n "messages-flow" web/src/app/features`
  - `rg -n "runLiveWsIncomingMvp|createLiveStateAccess|ensureLiveReady|decryptIncoming|persistAndAppend" web/src/app/features/messages-flow`
  - `rg -n "listSecureAndDecrypt|syncOfflineDecryptNow|triggerServerCatchup|restore-coordinator|gap" web/src/app/features`
  - `rg -n "runLiveWsIncomingMvp|listSecureAndDecrypt|syncOfflineDecryptNow|vaultPut|restorePipeline|gap|commitEvent" web/src/app/ui`
- 明確聲明：本文件僅描述現況與可靜態證明之結果，不含未來計畫。

2. Repo 狀態
- Branch：`rewrite-message-pipeline-live-skeleton`。
  - 證據：`git rev-parse --abbrev-ref HEAD` → `rewrite-message-pipeline-live-skeleton`。
- 最近 10 commits（hash + subject）：
  - `e50574d (HEAD -> rewrite-message-pipeline-live-skeleton) refactor(messages-flow): replace legacy facade file with messages-flow facade`
  - `fa52ef0 refactor(messages-flow): introduce messages-flow facade alias and update imports`
  - `ce09311 refactor(messages-flow): remove remaining LEGACY_DISABLED paths in facade`
  - `e15b91a refactor(messages-flow): wire facade entries to messages-flow after legacy retirement`
  - `88648fe refactor(messages-flow): retire legacy pipeline calls from facade`
  - `2c24486 feat(restore): add bounded Stage4 convergence waiter (manual)`
  - `094e255 chore(restore): normalize Stage4 progress schema for observability`
  - `e5ce0cd feat(restore): add Stage4 progress probe for catch-up observability`
  - `0b79d06 feat(restore): implement Stage3 DR holder batch hydrate`
  - `a79c62c feat(restore): implement Stage2 remote contact-secrets hydrate`
  - 證據：`git log -10 --oneline --decorate`。
- Git status：存在未追蹤檔案 `docs/messages-flow-refactor-audit.md`。
  - 證據：`git status --porcelain` → `?? docs/messages-flow-refactor-audit.md`。

3. 架構規格來源
- 實際讀取的規格/文件：
  - `docs/messages-flow-architecture.md`
  - `docs/messages-flow-spec.md`
- 證據：`ls -R docs | rg "messages-flow"` → 顯示上述檔案存在。
- 如需引用其他規格：本次未讀取 `docs/messages-flow-invariants.md`（未使用於判定）。

4. A-route 驗收（嚴格）
A-route 定義依 `docs/messages-flow-architecture.md`（A 路徑=replay，僅 vault，缺 key 只標記 vault_missing）。

4.1 A-route 不會 DR decrypt
- Layer 1（存在）：A-route 相關檔案存在：`web/src/app/features/messages-flow/scroll-fetch.js`、`web/src/app/features/messages-flow/vault-replay.js`。
  - 證據：`rg -n "messages-flow" web/src/app/features`。
- Layer 2（引用）：`scroll-fetch.js` 只引用 `listSecureMessagesForReplay`、`decryptReplayBatch`；`vault-replay.js` 以 AES-GCM 解密。
  - 證據：`web/src/app/features/messages-flow/scroll-fetch.js` 的 `decryptReplayBatch` 呼叫；`web/src/app/features/messages-flow/vault-replay.js` 內使用 `crypto.subtle.decrypt`。
- Layer 3（runtime 可達）：UI → facade → scroll fetch → vault replay 的呼叫鏈。
  - 證據鏈：
    - `web/src/app/ui/mobile/messages-pane.js` 內多處 `legacyFacade.onScrollFetchMore(...)`。
    - `web/src/app/features/messages-flow-facade.js` 的 `onScrollFetchMore()` 呼叫 `messagesFlowScrollFetch(...)`。
    - `web/src/app/features/messages-flow/scroll-fetch.js` 呼叫 `decryptReplayBatch(...)`。
  - 判定：PASS（A-route 走 AES-GCM vault-only，未見 DR decrypt 呼叫）。

4.2 A-route 不會 vaultPut
- Layer 1（存在）：A-route 實作位於 `scroll-fetch.js`/`vault-replay.js`。
- Layer 2（引用）：A-route 檔案中未出現 `vaultPut` 相關呼叫。
  - 證據：`rg -n "vaultPut" web/src/app/features/messages-flow/vault-replay.js web/src/app/features/messages-flow/scroll-fetch.js` → 無輸出。
- Layer 3（runtime 可達）：A-route 呼叫鏈如 4.1；該鏈內未出現 vaultPut。
  - 判定：PASS。

4.3 A-route 不會 enqueue B-route
- Layer 1（存在）：A-route 與 B-route 檔案分離（A-route 無 `live/` 依賴）。
- Layer 2（引用）：`scroll-fetch.js` / `vault-replay.js` 未 import `live/*` 或 `gap-queue`。
  - 證據：檔案內 import 清單（`scroll-fetch.js`, `vault-replay.js`）。
- Layer 3（runtime 可達）：A-route 呼叫鏈未包含 `consumeLiveJob` 或 `commitBRouteCounter`。
  - 判定：PASS。

4.4 missing-key 訊號僅標記，不觸發 live
- Layer 1（存在）：missing-key 標記存在於 A-route 解密結果。
  - 證據：`web/src/app/features/messages-flow/vault-replay.js` 將 `reason: 'vault_missing'` 放入 errors。
- Layer 2（引用）：`buildDecryptError(...)` 使用在 replay errors 中（`normalize.js`）。
- Layer 3（runtime 可達）：目前未找到 A-route errors 直接觸發 live 的呼叫鏈。
  - 證據：`web/src/app/features/messages-flow/reconcile/decision.js` 對 `replay_vault_missing` 回 `NO_OP`，但未見 A-route 明確呼叫該 eventType。
  - 判定：PARTIAL（可確認 missing-key 標記存在，未證明其在 runtime 觸發 live）。

5. B-route 驗收（嚴格）
B-route 定義依 `docs/messages-flow-architecture.md`（live decrypt，list→decrypt→persist，預設關閉）。

5.1 B-route 入口位置
- Layer 1（存在）：B-route 檔案存在：`web/src/app/features/messages-flow/live/*`。
- Layer 2（引用）：facade 引用 `consumeLiveJob`、`createLiveJobFromWsEvent`。
  - 證據：`web/src/app/features/messages-flow-facade.js` import 清單。
- Layer 3（runtime 可達）：
  - WS 入口鏈：`web/src/app/ui/app-mobile.js` → `legacyFacade.onWsIncomingMessageNew(...)` → `web/src/app/features/messages-flow-facade.js` 的 `onWsIncomingMessageNew()` → `consumeLiveJob(...)`。
  - 但因 `USE_MESSAGES_FLOW_LIVE = false`，實際執行會回落 `runLegacyHandler()`（見 5.3）。
  - 判定：入口可靜態追溯，但 live path runtime 目前被 flag 阻斷。

5.2 ready → fetch → decrypt → vaultPut → append 的閉環位置
- Layer 1（存在）：`runLiveWsIncomingMvp`、`createLiveStateAccess`、`ensureLiveReady`、`decryptIncomingSingle`、`persistAndAppendSingle` 存在。
  - 證據：`rg -n "runLiveWsIncomingMvp|createLiveStateAccess|ensureLiveReady|decryptIncoming|persistAndAppend" web/src/app/features/messages-flow`。
- Layer 2（引用）：`runLiveWsIncomingMvp()` 內按序呼叫 `ensureLiveReady` → fetch → `decryptIncomingSingle` → `persistAndAppendSingle`。
  - 證據：`web/src/app/features/messages-flow/live/coordinator.js`（函式內呼叫序）。
- Layer 3（runtime 可達）：僅當 `USE_MESSAGES_FLOW_LIVE = true` 且 decision 為 `TRIGGER_LIVE_MVP` 才會執行。
  - 證據：`web/src/app/features/messages-flow-facade.js` 的 `decideNextAction` + `consumeLiveJob` 判斷。
  - 判定：閉環實作存在，但 runtime 預設關閉（見 5.3）。

5.3 disabled by default（flag）
- Layer 1（存在）：`USE_MESSAGES_FLOW_LIVE`、`USE_MESSAGES_FLOW_B_ROUTE_COMMIT` flag 定義存在。
  - 證據：`web/src/app/features/messages-flow-facade.js`、`web/src/app/features/messages-flow/policy.js`。
- Layer 2（引用）：WS incoming 時依 `USE_MESSAGES_FLOW_LIVE` 決定是否 run live 或回落 legacy handler。
  - 證據：`web/src/app/features/messages-flow-facade.js` `onWsIncomingMessageNew()`。
- Layer 3（runtime 可達）：預設為 `false`，因此 live path 不會被執行。
  - 判定：PASS（確定為 disabled by default）。

6. Facade 與 UI boundary 驗收（嚴格）

6.1 UI 直接呼叫 pipeline 核心流程
- Layer 1（存在）：UI 檔案存在於 `web/src/app/ui`。
- Layer 2（引用）：以指定指令搜尋 UI 中 pipeline 關鍵符號。
  - 證據：`rg -n "runLiveWsIncomingMvp|listSecureAndDecrypt|syncOfflineDecryptNow|vaultPut|restorePipeline|gap|commitEvent" web/src/app/ui`。
  - 觀察：輸出僅包含 `messages-pane.js` 的 `listSecureAndDecrypt` log 字串與多處 CSS `gap`，無 `runLiveWsIncomingMvp`/`syncOfflineDecryptNow`/`vaultPut`/`commitEvent`/`restorePipeline` 直接呼叫證據。
- Layer 3（runtime 可達）：未建立 UI 直接呼叫 pipeline 核心函式的 call chain。
  - 判定：PASS（未見 UI 直接呼叫核心流程）。

6.2 UI import legacy 模組分類
- 說明：允許存在 legacy module import，但需分類為 allowlist/blocklist；存在 ≠ 會執行 pipeline。
- 允許的 UI imports allowlist（非 pipeline 核心入口，僅 state/transport/receipt 維護用途）：
  - `web/src/app/ui/app-mobile.js` → `setMessagesWsSender`（設定 wsSend 依賴）
    - 證據：`web/src/app/ui/app-mobile.js` import；`web/src/app/features/messages.js` 的 `setMessagesWsSender()` 只設定 `deps.wsSend`。
  - `web/src/app/ui/app-mobile.js` → `resetAllProcessedMessages`, `resetReceiptStore`
    - 證據：`web/src/app/features/messages.js` 該函式只清空快取/receipt store，不含 decrypt 流程。
  - `web/src/app/ui/mobile/messages-pane.js` → `resetProcessedMessages`, `recordMessageRead`, `recordMessageDelivered`, `clearConversationTombstone`, `clearConversationHistory`, `getConversationClearAfter`, `getVaultAckCounter`, `recordVaultAckCounter`
    - 證據：`web/src/app/ui/mobile/messages-pane.js` import 清單；`web/src/app/features/messages.js` 內相關方法為 state/receipt/vault ack 管理。
- 禁止的 imports blocklist（pipeline 核心入口）：
  - `listSecureAndDecrypt`, `syncOfflineDecryptNow`, `triggerServerCatchup`（規格範例禁止 UI 直接呼叫）。
  - 證據：`rg -n "listSecureAndDecrypt|syncOfflineDecryptNow|triggerServerCatchup" web/src/app/features`（核心入口存在於 `web/src/app/features/messages.js`）；`rg -n "listSecureAndDecrypt\(" web/src/app/ui` → 無輸出（UI 未 import/呼叫）。
- 判定：PARTIAL（UI 未直接呼叫核心入口，但仍 import legacy module；需以 allowlist/blocklist 持續約束）。

6.3 Facade 唯一入口與 runtime call chain
- Layer 1（存在）：facade 檔案 `web/src/app/features/messages-flow-facade.js` 存在。
- Layer 2（引用）：UI import facade。
  - 證據：`web/src/app/ui/app-mobile.js`、`web/src/app/ui/mobile/messages-pane.js`、`web/src/app/ui/app-ui.js` 皆 import `legacyFacade`。
- Layer 3（runtime 可達）：
  - app lifecycle → facade：`app-mobile.js` 呼叫 `legacyFacade.onLoginResume/onVisibilityResume`。
  - WS → facade → flow：`app-mobile.js` → `legacyFacade.onWsIncomingMessageNew()` → `messages-flow-facade.js` → `decideNextAction` → `consumeLiveJob`（受 flag 阻斷）。
  - scroll replay → facade → A-route：`messages-pane.js` → `legacyFacade.onScrollFetchMore()` → `messages-flow-facade.js` → `messagesFlowScrollFetch()` → `scroll-fetch.js` → `vault-replay.js`。
- 判定：PARTIAL（facade 入口存在且被 UI 呼叫，但 UI 仍直接 import legacy 模組做非核心行為）。

7. Restore pipeline 驗收（嚴格）
- Layer 1（存在）：Stage0–Stage5 定義存在。
  - 證據：`web/src/app/features/restore-coordinator.js` 內 `STAGES = ['Stage0','Stage1','Stage2','Stage3','Stage4','Stage5']`。
- Layer 2（引用）：各 Stage 有明確 I/O 與 reasonCode。
  - 證據（摘要）：
    - Stage0：檢查 MK/account token/deviceId，reasonCode `MISSING_CREDENTIALS`。
    - Stage1：`restoreContactSecrets()`，reasonCode `LOCAL_RESTORE_FAILED`。
    - Stage2：`hydrateContactSecretsFromBackup()`，reasonCode `SKIPPED_NO_BACKUP` / `REMOTE_HYDRATE_FAILED`。
    - Stage3：`hydrateDrStatesFromContactSecrets()`，reasonCode `DR_HYDRATE_FAILED` / `SKIPPED_NO_CONTACT_SECRETS`。
    - Stage4：`fetchSecureMaxCounter()` + `restoreGapQueue.enqueue()`，reasonCode `MISSING_DEVICE_ID` / `MAX_COUNTER_UNKNOWN` / `LOCAL_COUNTER_UNKNOWN`。
    - Stage5：`restorePipelineDoneTrace`。
- Layer 3（runtime 可達）：
  - `web/src/app/features/messages-flow-facade.js` 的 `onLoginResume()` / `onVisibilityResume()` 呼叫 `startRestorePipeline()`。
  - `web/src/app/ui/app-mobile.js` 呼叫上述 facade 入口。
- 收斂/convergence：
  - `waitForStage4Convergence()` 判定 `CONVERGED` / `TIMEOUT`。
  - 證據：`web/src/app/features/restore-coordinator.js`。
- 判定：PASS（階段完整、reasonCode 明確、具 convergence）。

8. Commit-driven side effects 驗收（嚴格）
- 規格原文要點（<=25 字）：
  - `"Presentation：placeholder 規劃 + 解密後訊息套用 hook"`（出自 `docs/messages-flow-architecture.md`）。
- 補充說明：在 `docs/messages-flow-spec.md`/`docs/messages-flow-architecture.md` 未找到 `commitEvent` 或「副作用必須由 commitEvent 驅動」明確規範；此點僅能就現況做現象描述，不能視為違規。
  - 證據：`rg -n "commit|commitEvent" docs/messages-flow-architecture.md` → 無輸出。

- 現況判斷（基於 code evidence）：
  - `web/src/app/features/messages-flow/notify.js` 的 `createCommitNotifier()` 使用 commitEvent 驅動 unread/notification。
  - `web/src/app/features/messages-flow/presentation.js` 的 `handleCommitEvent()` 用於 gap placeholder resolve/reveal。
  - `web/src/app/features/messages-flow/live/state-live.js` 的 `persistAndAppendBatch()` 直接呼叫 `appendTimelineBatch()`（不依賴 commitEvent）。
- 判定：UNKNOWN（規格未明示 commitEvent 規範；僅能記錄現象）。

9. 仍殘留 legacy 的地方（可達風險）
- 入口仍可導向 legacy pipeline：未找到可靜態證明的 runtime call chain 進入 `listSecureAndDecrypt/syncOfflineDecryptNow/triggerServerCatchup`。
  - 證據：`rg -n "listSecureAndDecrypt" web/src` 只有 `web/src/app/features/messages.js` 內部與 UI log 字串；UI 未直接呼叫。
- 可選清理（非 runtime 風險）：
  - `web/src/app/features/messages.js` 存在完整 legacy pipeline，但未被 UI 直接呼叫；可列為後續清理對象。

10. 結論
- 結論：PARTIAL。
- 支撐證據：
  - Facade 入口路徑清晰且 UI 透過 facade 進入 A-route/B-route（第 6 節）。
  - B-route live 預設關閉，WS incoming 仍回落 legacy handler（第 5 節）。
  - UI 未直接呼叫 pipeline 核心流程，但仍存在 legacy module import（第 6 節）。
- 判斷：仍需完成 boundary/flags（例如 live flag 啟用前的安全性確認與 UI 依賴整理）後，才適合進入正式 Debug。
