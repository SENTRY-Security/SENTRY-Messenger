# 工程回歸與 Debug 紀錄（Sentry Messenger）

## 1) 問題背景
- 已發生兩類退化：a) contacts refresh 後暱稱 / 頭像被還原或丟失，b) 對話 re-enter 時訊息列表變空白。
- 這些案例並非資料缺失，而是狀態 attach / 時序處理錯誤導致的顯示退化。

## 2) 已確立的工程原則
- refresh / re-enter 不得改變語意，只能重建目前應有的狀態，不得引入額外清除或覆寫。
- UI clear 必須發生在「確認 attach 不可行」之後；在 attach 仍可行時不可先行清空。
- contacts refresh 禁止 clear-and-rebuild，必須採用 delta-commit（逐筆更新差異、保留既有狀態）。
- 不為了畫面「正常」而引入 fallback / retry；應修正根因而非遮掩。
- crypto / DR / OPAQUE 流程不可作為 UI 修補點，密碼學路徑與 UI 邏輯須解耦。

## 3) 基準修補點（對照用）
- contacts refresh delta-commit：以 commit 語意提交差異，確保僅對變動聯絡人寫入，避免 refresh 時覆寫暱稱 / 頭像。這解決的是「refresh 併發導致的聯絡人狀態退化」根因。
- messages re-enter attach cached timeline：re-enter 時優先將已 cache 的 timeline attach 回 UI，再按 commit 語意補齊，避免因 attach 順序錯誤導致訊息空白。這解決的是「re-enter attach 時序錯亂」根因。

## 4) 最小手動回歸測試清單
- [ ] P1：加好友後，聯絡人列表暱稱 / 頭像正確（驗證層：contacts refresh / delta-commit；失敗先懷疑 contacts 差異處理）。
- [ ] P2：聊天 → 離開 → re-enter，舊訊息仍在（驗證層：messages attach；失敗先懷疑 re-enter attach 順序）。
- [ ] P3：聯絡人 refresh 後暱稱 / 頭像仍正確（驗證層：contacts refresh 時序；失敗先懷疑 contacts delta-commit 是否被 clear-and-rebuild 取代）。
- [ ] P4：對話列表 refresh 後 re-enter，訊息仍在（驗證層：messages attach + refresh 時序；失敗先懷疑 attach 時序，其次 messages cache，有需要才檢查 contacts）。

## 5) Debug 決策流程（SOP）
- 若當前分支混入未驗證改動且現象無法穩定重現，先 reset 世界線至已知乾淨狀態（git restore/reset）後再重試。
- 發現可穩定重現的退化時，立即建立基準 commit（僅含問題重現所需最小變更），鎖定對照點再繼續調查。
- 若工作階段產生過多嘗試或上下文混亂，開啟全新 Codex session，重新同步重現步驟與基準 commit。
- 觀察 AI 回應：未引用行號 / 片段、未檢查觸發條件就下結論、回答速度異常快且缺少推導，即視為偷懶信號，需要求補充依據或重新驗證。

## 6) 未來注意事項（加分）
- AppClip 冷啟動 / reload 可能出現 timeline 尚未建立的情境，屬於初始化缺口，應獨立追蹤處理。
- 該情境不可與 re-enter attach 問題混為一談；初始化缺口須另立議題與驗證路徑。
