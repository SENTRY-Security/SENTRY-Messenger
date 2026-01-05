# DR B 路線稽核（合併版）

## 0. 評估基準與證據方法
- 本文件為靜態分析，僅採程式碼可直接推導之證據，不依賴執行期 log/測試。
- 證據格式一律為「檔案路徑:起-迄行」。
- 敘述分為兩類：
  - 【程式碼可推導的確定事實】：可由分支條件、return/throw 點、資料依賴直接推導。
  - 【執行期不可由程式碼直接證明】：無法 100% 靜態證明者，一律補上「必要條件/上界/下界」並明確標示。

## 1. Success Criteria（嚴格）與不可能條件
### 1.1 Success Criteria（嚴格）
1) **重新登入後（即使清空 localStorage/sessionStorage）仍可完整解出離線訊息**
- 【執行期不可由程式碼直接證明】
- 必要條件（程式碼可推導）：
  - 需產生可用 catch-up targets，且每筆 target 必備 `conversationId + tokenB64 + peerAccountDigest + peerDeviceId`，否則不會納入 targets、plannedCount 可能為 0（web/src/app/features/messages.js:3726-3736, web/src/app/features/messages.js:3951-3964）。
  - live 解密前必須通過 `ensureSecureConversationReady` 與 `ensureReceiverStateReady`，否則會提前返回「安全對話建立中」或丟出 `DR_STATE_UNAVAILABLE`（web/src/app/features/messages.js:1704-1744, web/src/app/features/messages.js:1688-1694）。
  - DR state 必須能從 contact-secrets 快照 hydrate（否則 `ensureReceiverStateReady` 會因 `hasUsableDrState` 失敗而 throw），而遠端備份 hydrate 需要 MK；若 MK 缺失，遠端 hydrate 直接返回失敗（web/src/app/features/dr-session.js:3123-3338, web/src/app/features/contact-backup.js:223-225）。

2) **A route 缺 key 的訊息必須最終可補齊**
- 【程式碼可推導的確定事實】
  - replay 僅能從 vault 取得 message key，若缺 key 直接 throw「不可回放：缺少訊息密鑰」，且 replay 明確阻擋 DR 路徑（web/src/app/features/messages.js:2592-2641, web/src/app/features/messages.js:2657-2679）。
  - 唯一能補齊 vault 的來源為 live 解密成功後的 `vaultPutMessageKey`（incoming），並在成功時累加 `vaultPutIncomingOk`（web/src/app/features/messages.js:1918-1995）。
- 因此：**缺 key 的 replay 必須由 B route live 解密補 key，否則無法達成**（上述兩點直接推導）。

3) **能繼續收發**
- 【執行期不可由程式碼直接證明】
- 必要條件（程式碼可推導）：
  - 裝置 ID 必須可用，否則 `ensureDeviceId()` 會 throw 並中斷後續流程（web/src/app/core/store.js:326-348）。
  - `ensureSecureConversationReady` 必須返回 READY（非 PENDING），且 DR state 可用，否則 live 解密路徑直接停止（web/src/app/features/messages.js:1704-1744, web/src/app/features/messages.js:1688-1694）。
  - live 解密成功後會持久化 DR snapshot（web/src/app/features/messages.js:2005-2007），提供後續狀態延續的必要條件。

### 1.2 不可能條件（程式碼可推導）
1) **無 MK 時，遠端備份與 replay 皆必然失敗**
- `hydrateContactSecretsFromBackup` 在 MK 缺失時直接返回 ok=false（web/src/app/features/contact-backup.js:223-225）。
- `listSecureAndDecrypt` 在 replay 條件下若 MK 不存在會直接 throw `MK_MISSING_HARDBLOCK`（web/src/app/features/messages.js:1210-1233）。
- 結論：**在 MK 不可用時，所有依賴遠端備份或 replay 的解密流程必然失敗**（程式碼直接推導）。

2) **replay 缺 vault key 時必然無法解密，且無 DR fallback**
- 缺 key 直接 throw「不可回放：缺少訊息密鑰」（web/src/app/features/messages.js:2592-2641）。
- replay 分支明確阻擋 DR 路徑（web/src/app/features/messages.js:2657-2679）。
- 結論：**缺 vault key 時 A route 必然無解**（程式碼直接推導）。

3) **DR state 不可用時，B route 必然失敗**
- `ensureReceiverStateReady` 在 `hasUsableDrState` 為 false 時丟出 `DR_STATE_UNAVAILABLE`（web/src/app/features/messages.js:1688-1694）。
- `ensureDrReceiverState` 對快照驗證失敗、角色/裝置 gate 失敗會 return false 或 throw，最終可能落到「缺少安全會話狀態」的 throw（web/src/app/features/dr-session.js:3154-3338, web/src/app/features/dr-session.js:3697-3727）。

4) **缺必要 target 欄位 → plannedCount=0 → B route 不會執行**
- target 必須同時具備 `conversationId/tokenB64/peerAccountDigest/peerDeviceId`，否則不被加入（web/src/app/features/messages.js:3726-3736）。
- `plannedCount = targets.length`，且 reasonCode 會標記 NO_TARGETS（web/src/app/features/messages.js:3951-3964）。

5) **缺 peer identity（digest + deviceId）時必然失敗**
- `listSecureAndDecrypt` 若 peer identity 無法補齊，直接 throw（web/src/app/features/messages.js:1311-1350）。

## 2. 現況系統地圖（A route / B route / backup / vault）
### 2.1 DR state 與 contact-secrets
- DR state holder 由 `drState()` 建於記憶體 map（web/src/app/core/store.js:437-466）。
- `snapshotDrState` 產出快照（rk/ckS/ckR、counter、ratchet keys、role、selfDeviceId、updatedAt）（web/src/app/features/dr-session.js:796-849）。
- `persistDrSnapshot` 寫入 contact-secrets（以本機 deviceId 為鍵），並帶入對話欄位（web/src/app/features/dr-session.js:1003-1054）。
- contact-secrets 快照包含 conversation token/id/drInit 與 per-device drState（web/src/app/core/contact-secrets.js:1448-1486）。
- contact-secrets 寫入 localStorage + sessionStorage（key base 為 `contactSecrets-v2*`），並會 dispatch `contactSecrets:persisted`（web/src/app/core/contact-secrets.js:15-23, web/src/app/core/contact-secrets.js:1263-1359）。

### 2.2 遠端備份（contact_secret_backups）
- contact-secrets 備份以 MK 加密（AES-256-GCM，info tag `contact-secrets/backup/v1`）（web/src/app/features/contact-backup.js:125-135）。
- 備份若 entries > 0 且 withDrState=0 且非強制，直接跳過（web/src/app/features/contact-backup.js:154-166）。
- 備份寫入 D1 `contact_secret_backups`（包含 snapshot_version/entries/bytes/checksum/deviceId/deviceLabel 等欄位）（data-worker/src/worker.js:2369-2385）。
- hydrate 成功後會 dispatch `contactSecrets:restored` 事件（web/src/app/features/contact-backup.js:292-294）。

### 2.3 A route（replay）
- `computedIsHistoryReplay` 條件為 `allowReplay=true && mutateState=false`（web/src/app/features/messages.js:1117-1138）。
- replay 只從 vault 取 message key，缺 key 直接 throw，且阻擋 DR 路徑（web/src/app/features/messages.js:2592-2641, web/src/app/features/messages.js:2657-2679）。

### 2.4 B route（live DR 解密）
- `syncOfflineDecryptNow` 取得 targets 後以 `listSecureAndDecrypt` live 模式解密（`mutateState: true`、`allowReplay: false`）（web/src/app/features/messages.js:3947-3993）。
- live 解密成功後 `vaultPutMessageKey` 並持久化 DR snapshot（web/src/app/features/messages.js:1918-2007）。
- 登入後會自動觸發 `syncOfflineDecryptNow({ source: 'login' })`（web/src/app/ui/app-mobile.js:3651-3669）。

### 2.5 登入後還原流程
- sessionStorage handoff 還原 MK/account token（web/src/app/ui/app-mobile.js:1394-1432）。
- `runPostLoginContactHydrate` 先 restore 本機 contact-secrets，再（若 MK 可用）remote hydrate（web/src/app/ui/app-mobile.js:2548-2564）。
- `hydrateDrSnapshotsAfterBackup` 目前為 no-op；`hydrateDrStatesFromContactSecrets` 回傳 0（web/src/app/ui/app-mobile.js:2544-2546, web/src/app/features/dr-session.js:1127-1129）。

## 3. 失敗模式（Failure Modes）
### 3.1 catch-up targets 組不出 → plannedCount=0
- 【程式碼可推導的確定事實】
- 缺任一必要欄位（conversationId/tokenB64/peerAccountDigest/peerDeviceId）即不加入 targets（web/src/app/features/messages.js:3726-3736）。
- `plannedCount = targets.length`，NO_TARGETS 為必然結果（web/src/app/features/messages.js:3951-3964）。

### 3.2 live 預檢失敗 → DR_STATE_UNAVAILABLE / PENDING
- `ensureSecureConversationReady` 若返回 PENDING，直接返回「安全對話建立中」（web/src/app/features/messages.js:1704-1743）。
- `ensureReceiverStateReady` 若 `hasUsableDrState` 為 false，throw `DR_STATE_UNAVAILABLE`（web/src/app/features/messages.js:1688-1694）。

### 3.3 ensureDrReceiverState 的 return false / throw gate
- 【程式碼可推導的確定事實】
  - snapshot 驗證 pending → return false（web/src/app/features/dr-session.js:3154-3163）。
  - snapshot 驗證失敗 → throw「狀態損壞，需要重新同步/重新邀請」（web/src/app/features/dr-session.js:3164-3166）。
  - stateKey 與 secretKey 不一致 → return false（ROLE_GATING）（web/src/app/features/dr-session.js:3239-3242）。
  - selfDeviceId 不一致 → return false（web/src/app/features/dr-session.js:3243-3255）。
  - hydrate 解碼/欄位不足 → throw（web/src/app/features/dr-session.js:3271-3304）。
  - role mismatch/owner 缺 responder state → return false（web/src/app/features/dr-session.js:3307-3338）。
  - conversation mismatch 且已有 send chain → throw（web/src/app/features/dr-session.js:3462-3466）。
  - guest bundle 缺失 → throw（web/src/app/features/dr-session.js:3697-3722）。
  - 最終無可用狀態 → throw「缺少安全會話狀態」（web/src/app/features/dr-session.js:3727-3727）。

### 3.4 replay vault-only 硬阻擋
- MK 缺失 → `MK_MISSING_HARDBLOCK`（web/src/app/features/messages.js:1210-1233）。
- vault 缺 key → throw「不可回放：缺少訊息密鑰」（web/src/app/features/messages.js:2592-2641）。
- replay 明確阻擋 DR 解密 → `REPLAY_DR_PATH_BLOCKED`（web/src/app/features/messages.js:2657-2679）。

### 3.5 備份不含 drState / MK 缺失
- entries > 0 但 withDrState=0 且非強制 → 備份直接跳過（web/src/app/features/contact-backup.js:154-166）。
- MK 缺失 → 遠端 hydrate 直接返回失敗（web/src/app/features/contact-backup.js:223-225）。

### 3.6 登出時 flush 可能失敗（entry 未定義）
- `flushDrSnapshotsBeforeLogout` 迴圈內使用 `entry?.conversation?.peerDeviceId`，但 `entry` 未定義，必然 throw（web/src/app/ui/app-mobile.js:1321-1341）。
- secure logout 仍會清空 local/session storage（web/src/app/ui/app-mobile.js:963-1104, web/src/app/ui/app-mobile.js:904-943）。

### 3.7 peer identity 缺失 → listSecureAndDecrypt throw
- peerAccountDigest + peerDeviceId 無法補齊即 throw（web/src/app/features/messages.js:1311-1350）。

## 4. 為何「清空 local/session」下目前不穩
- secureLogout 會先嘗試 flush/persist/backup，但 flush 內有未定義變數導致 throw，且流程仍持續清空 storage（web/src/app/ui/app-mobile.js:963-1104, web/src/app/ui/app-mobile.js:1321-1341）。
- 備份若 withDrState=0 會被跳過；遠端 hydrate 又必須依賴 MK（web/src/app/features/contact-backup.js:154-166, web/src/app/features/contact-backup.js:223-225）。
- 登入後沒有批次 DR hydrate（`hydrateDrSnapshotsAfterBackup` no-op、`hydrateDrStatesFromContactSecrets` return 0），因此 DR state 多數僅能 on-demand hydrate；若快照無法取得，`ensureReceiverStateReady` 會直接 throw `DR_STATE_UNAVAILABLE`（web/src/app/ui/app-mobile.js:2544-2546, web/src/app/features/dr-session.js:1127-1129, web/src/app/features/messages.js:1688-1694）。
- 清空後若無法組出 target（缺 conversation/token/peer/device），B route 直接 plannedCount=0，不會執行任何解密（web/src/app/features/messages.js:3726-3736, web/src/app/features/messages.js:3951-3964）。

## 5. 登入後 Restore Pipeline（規格草案）
> 只寫 spec，不改 code。每一階段均列出輸入/輸出/失敗退場/可重試策略；UI 需顯示進度與狀態。

### Stage 0：登入憑證與裝置就緒
- **輸入條件**：`restoreMkAndUidFromSession` 已嘗試還原 MK/account token；`ensureDeviceId` 可取得 deviceId（web/src/app/ui/app-mobile.js:1394-1432, web/src/app/core/store.js:326-348）。
- **輸出條件**：`getMkRaw()` 可用、`getAccountToken()` 可用、`ensureDeviceId()` 不 throw（同上）。
- **失敗退場**：顯示「登入憑證不足」，停止 Stage 1-5。
- **可重試策略**：重新登入/重新授權取得 MK。
- **進度數據來源**：直接讀取 `getMkRaw()/getAccountToken()/ensureDeviceId()` 回傳狀態（同上）。

### Stage 1：本機 contact-secrets restore
- **輸入條件**：Stage 0 成功。
- **輸出條件**：`restoreContactSecrets()` 回傳 Map（可用 size 判定是否有資料）（web/src/app/core/contact-secrets.js:978-987）。
- **失敗退場**：Map 為空則標記 `localMissing=true`，仍進入 Stage 2。
- **可重試策略**：可重試 `restoreContactSecrets()`；不依賴 log。
- **進度數據來源**：`restoreContactSecrets()` 回傳值（同上）。

### Stage 2：遠端 contact-secrets hydrate（允許耗時）
- **輸入條件**：MK 可用（web/src/app/features/contact-backup.js:223-225）。
- **輸出條件**：`hydrateContactSecretsFromBackup()` 回傳 ok=true，並 dispatch `contactSecrets:restored`（web/src/app/features/contact-backup.js:203-305, web/src/app/features/contact-backup.js:292-294）。
- **失敗退場**：MK 缺失或備份損壞 → UI 顯示「備份不可用」。
- **可重試策略**：允許使用者點擊「重試同步」再次呼叫 `hydrateContactSecretsFromBackup()`。
- **進度數據來源**：`hydrateContactSecretsFromBackup()` 回傳物件 + `contactSecrets:restored` 事件（同上）。

### Stage 3：DR holder 批次 hydrate（補齊缺口）
- **輸入條件**：Stage 1/2 已完成（contact-secrets map 可用）。
- **輸出條件**：批次還原成功的 DR holder 數量可回報（建議由 `hydrateDrStatesFromContactSecrets()` 回傳統計；目前為 no-op）（web/src/app/features/dr-session.js:1127-1129, web/src/app/features/dr-session.js:873-1001）。
- **失敗退場**：單筆快照 restore 失敗可記為 skip/error，不阻斷整體。
- **可重試策略**：可針對失敗 peer 重新呼叫 `ensureDrReceiverState()`（web/src/app/features/dr-session.js:3123-3338）。
- **進度數據來源**：
  - 現況：僅能透過 `ensureDrReceiverState()` 成功/失敗結果推估（同上）。
  - 若需更精準 UI 進度，**建議新增** batch 回傳統計（不更動現行 code）。

### Stage 4：離線訊息 catch-up（B route）
- **輸入條件**：Stage 3 已完成或部分完成；targets 可組成（web/src/app/features/messages.js:3726-3736）。
- **輸出條件**：`syncOfflineDecryptNow()` 回傳 planned/attempted/success/fail，並在每個 conversation dispatch `b-route-result`（web/src/app/features/messages.js:3947-4154, web/src/app/features/messages.js:3922-3925）。
- **失敗退場**：`DR_STATE_UNAVAILABLE` 或 secure pending → 記錄為失敗並可重試（web/src/app/features/messages.js:1688-1694, web/src/app/features/messages.js:1704-1743）。
- **可重試策略**：使用者按「重試同步」再次呼叫 `syncOfflineDecryptNow()`；或 UI 依需求延後重試。
- **進度數據來源**：`syncOfflineDecryptNow()` 回傳物件 + `b-route-result` 事件（同上）。

### Stage 5：完成（解除 UI「解密中」）
- **輸入條件**：Stage 4 已完成，且 `syncOfflineDecryptNow` 已 flush pending vault puts（web/src/app/features/messages.js:4143-4154）。
- **輸出條件**：UI 顯示「完成」。
- **失敗退場**：若仍有 failCount 或 pending，維持「解密中」並提供重試。
- **進度數據來源**：`syncOfflineDecryptNow()` 回傳結果 + `b-route-result` 事件（web/src/app/features/messages.js:3922-3925, web/src/app/features/messages.js:4143-4154）。

### UI/UX 要求（與階段對應）
- 「同步安全資料」：Stage 1-2。
- 「建立解密狀態」：Stage 3。
- 「解密離線訊息」：Stage 4。
- 「完成」：Stage 5。
- 允許耗時，但必須顯示進度（數據來源如上）；如需新增觀測點，僅以「建議新增」記錄，不改 code。

## 6. 重構方案比較（方案 1/2/3）
> 僅規格比較，不改 code。

### 方案 1：最小改動（不新增 D1 schema）
- **改動面**：
  - `web/src/app/features/dr-session.js`：實作 `hydrateDrStatesFromContactSecrets()`（目前 return 0）。
  - `web/src/app/ui/app-mobile.js`：Stage 3 接入；修正 `flushDrSnapshotsBeforeLogout` 的未定義變數。
  - `web/src/app/features/messages.js`：在 B route 對每個 target 明確呼叫 `ensureDrReceiverState()` 或將其納入 Stage 3。
- **D1 schema**：不新增。
- **風險**：
  - 安全性：中（仍依賴 MK/備份）。
  - 一致性：中（快照損壞需處理，角色 gate 更嚴格）。
  - 性能：中（批次 hydrate 會增加 CPU/記憶體）。
  - 可回滾：高（可用 feature flag 回到 on-demand）。
- **為何能滿足 Success Criteria**：
  - 本機或遠端備份只要含 drState，即可在登入後批次還原到記憶體（web/src/app/features/dr-session.js:873-1001, web/src/app/features/dr-session.js:1127-1129, web/src/app/features/contact-backup.js:203-305），滿足 B route 必要條件。
  - live 解密成功會 `vaultPutMessageKey` 補齊 replay 缺 key（web/src/app/features/messages.js:1918-1995）。

### 方案 2：伺服端 DR snapshot 備份（新增 D1 schema）
- **改動面**：
  - `web/src/app/features/dr-session.js`：persist 時上傳加密 DR snapshot。
  - `data-worker/src/worker.js`：新增 DR snapshot API 與 D1 表。
  - `web/src/app/ui/app-mobile.js`：登入後額外拉取 DR snapshot。
- **D1 schema（草案）**：
  - 表名：`dr_state_backups`
  - key：`account_digest + conversation_id + peer_device_id + self_device_id`
  - 欄位：`payload_json`（MK 加密）、`version`、`snapshot_version`、`checksum`、`updated_at`、`created_at`。
- **風險**：
  - 安全性：高（DR state 上雲，需嚴格加密與權限）。
  - 一致性：中（需處理版本/降級）。
  - 性能：中（寫入頻率增加）。
  - 可回滾：中（需保留舊路徑）。
- **為何能滿足 Success Criteria**：
  - 清空 local/session 後仍可從伺服端還原 DR state，再走 B route live 解密補 vault key（符合 SC1/SC2 的必要條件）。

### 方案 3：完整 restore coordinator + replay 缺 key → B route 補齊
- **改動面**：
  - `web/src/app/features/messages.js`：replay 缺 key 時改為 enqueue 交由 B route 補解密。
  - `web/src/app/ui/app-mobile.js`：新增 restore coordinator 與 UI 進度面板。
  - `data-worker/src/worker.js`：若需跨登入保留佇列，新增 server-side queue。
- **D1 schema（草案）**：
  - 表名：`replay_missing_keys`
  - key：`account_digest + conversation_id + message_id + sender_device_id + target_device_id`
  - 欄位：`status`、`retry_count`、`updated_at`、`created_at`。
- **風險**：
  - 安全性：中（僅存 metadata 仍需保護）。
  - 一致性：中高（避免重複補解密）。
  - 性能：中（背景補解密與佇列輪詢）。
  - 可回滾：中（需 feature flag 控制）。
- **為何能滿足 Success Criteria**：
  - replay 缺 key 不再硬失敗，而是被導回 B route live 解密補 key（與 `vaultPutMessageKey` 路徑相容），達成 SC2；restore coordinator 可確保 Stage 0-5 順序滿足 SC1（依賴既有 B route + contact-secrets/DR state 依賴）。

## 7. 必要的後續驗收點（僅程式碼層面可驗證）
- `hydrateDrSnapshotsAfterBackup` 不再為 no-op，且 `hydrateDrStatesFromContactSecrets()` 需回報非 0 的 restore/skip/error 計數（web/src/app/ui/app-mobile.js:2544-2546, web/src/app/features/dr-session.js:1127-1129）。
- B route 觸發前必須完成 DR state 可用性保障（例如 Stage 3 或 per-target `ensureDrReceiverState`）；驗證點位於 `syncOfflineDecryptNow` 呼叫鏈（web/src/app/features/messages.js:3947-3993）。
- replay 缺 key 是否能被送入 B route 補解密：檢查 replay 分支（web/src/app/features/messages.js:2592-2641）。
- `flushDrSnapshotsBeforeLogout` 不可再引用未定義變數；需明確取得 peerDeviceId（web/src/app/ui/app-mobile.js:1321-1341）。
- `triggerContactSecretsBackup` 的 withDrState gate 與 contact-secrets 序列化一致（`withDrState` 需能反映 drState 存在）（web/src/app/features/contact-backup.js:154-166, web/src/app/core/contact-secrets.js:1492-1538）。

## 8. 證據索引
- web/src/app/features/messages.js:1117-1138（replay 判定與參數）
- web/src/app/features/messages.js:1210-1233（MK 缺失硬阻擋）
- web/src/app/features/messages.js:1311-1350（peer identity 缺失直接 throw）
- web/src/app/features/messages.js:1688-1694（DR_STATE_UNAVAILABLE throw）
- web/src/app/features/messages.js:1704-1744（ensureSecureConversationReady + live 預檢）
- web/src/app/features/messages.js:1918-2007（vaultPut incoming + persistDrSnapshot）
- web/src/app/features/messages.js:2592-2641（replay vault 缺 key 直接失敗）
- web/src/app/features/messages.js:2657-2679（REPLAY_DR_PATH_BLOCKED）
- web/src/app/features/messages.js:3726-3837（collectOfflineCatchupTargets 必備欄位與來源）
- web/src/app/features/messages.js:3922-3925（b-route-result 事件）
- web/src/app/features/messages.js:3947-3993（syncOfflineDecryptNow live 呼叫）
- web/src/app/features/messages.js:3951-3964（plannedCount / NO_TARGETS）
- web/src/app/features/messages.js:4143-4154（flushPendingVaultPutsNow + return 結果）
- web/src/app/features/dr-session.js:796-849（snapshotDrState 欄位）
- web/src/app/features/dr-session.js:873-1001（restoreDrStateFromSnapshot）
- web/src/app/features/dr-session.js:1003-1054（persistDrSnapshot 寫入 contact-secrets）
- web/src/app/features/dr-session.js:1127-1129（hydrateDrStatesFromContactSecrets 為 stub）
- web/src/app/features/dr-session.js:3123-3338（ensureDrReceiverState gate/return/throw）
- web/src/app/features/dr-session.js:3462-3466（conversation mismatch throw）
- web/src/app/features/dr-session.js:3697-3727（guest bundle 缺失/最終 throw）
- web/src/app/core/contact-secrets.js:15-23（contactSecrets storage key）
- web/src/app/core/contact-secrets.js:978-987（restoreContactSecrets）
- web/src/app/core/contact-secrets.js:1263-1359（persistContactSecrets + contactSecrets:persisted）
- web/src/app/core/contact-secrets.js:1448-1486（contact-secrets 包含 conversation/drInit/drState）
- web/src/app/core/contact-secrets.js:1492-1538（serializeContactSecretsMap + withDrState）
- web/src/app/features/contact-backup.js:125-135（MK 加密備份）
- web/src/app/features/contact-backup.js:154-166（withDrState gate）
- web/src/app/features/contact-backup.js:203-305（hydrateContactSecretsFromBackup + restored event）
- web/src/app/features/contact-backup.js:223-225（MK 缺失直接返回）
- web/src/app/ui/app-mobile.js:904-943（清空 local/session storage）
- web/src/app/ui/app-mobile.js:963-1104（secureLogout 流程）
- web/src/app/ui/app-mobile.js:1321-1341（flushDrSnapshotsBeforeLogout entry 未定義）
- web/src/app/ui/app-mobile.js:1394-1432（restoreMkAndUidFromSession）
- web/src/app/ui/app-mobile.js:2544-2546（hydrateDrSnapshotsAfterBackup no-op）
- web/src/app/ui/app-mobile.js:2548-2584（runPostLoginContactHydrate）
- web/src/app/ui/app-mobile.js:3651-3669（登入後觸發 syncOfflineDecryptNow）
- web/src/app/core/store.js:326-348（ensureDeviceId）
- web/src/app/core/store.js:437-466（drState 記憶體 holder）
- data-worker/src/worker.js:2369-2385（contact_secret_backups 寫入欄位）
- data-worker/src/worker.js:2435-2451（contact_secret_backups 讀取 withDrState）
