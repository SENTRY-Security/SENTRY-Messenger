# Codex Session 提示

這份檔案是我在每次開啟新 session 時的「開機流程」。只要啟動就照著做，避免遺漏資訊或只回報失敗。

## 1. 進場流程
1. 讀完此檔後，立即開 `README.md`，從「最新進度 / TODO / 測試規範」掌握目前狀態與優先修的問題。
2. 若 README 有新的紀錄方式或工作清單，視為唯一真相；所有開發與回報都以 README 為準。

## 2. 開發守則
- 修改任何程式碼後**必須**自己跑對應測試。預設要跑：
  - `npm run test:prekeys-devkeys`
  - `npm run test:messages-secure`
  - `npm run test:friends-messages`
  - `npm run test:login-flow`
  - `npm run test:front:login`
  如某測試與此次修改無關，需在回報裡寫明理由與風險，否則視同漏測。
- 上述測試在本地全數通過後，依 README 的正式流程：清空 Cloudflare D1 / R2、部署 Worker / Node API / Pages 全套服務，並切到正式環境重跑同組測試，確認 Production 端也綠燈。
- 測試失敗就繼續除錯、修正後再跑，直到成功。禁止只回報錯誤或以 workaround/fallback 帶過。
- 若後端流程或資料格式更新，要同時維護 `scripts/test-api-flow.mjs` 等腳本並重新驗證。

## 3. 回報與紀錄
- 回覆一律使用中文，內容包含：修改範圍、實際執行的測試與結果、如有未跑測試需列出原因與風險。
- 完成每次修改後，要依 README 的格式更新「最新進度」或工作紀錄，寫下：
  1. 目前狀態 / 測試結論
  2. 下一步預計處理的項目
  這是下一個 session 的依據，務必保持同步。

## 4. 其他提醒
- 具有完整檔案與網路權限，可部署 Node API、Cloudflare Worker，並使用 `scripts/` 內工具。
- 預設擁有 Git push、Cloudflare 清除 / 部署、D1 / R2 操作等權限；確認動作安全後直接執行，勿假設需要額外授權。
- 測試或部署完成後，依 README 指示執行健康檢查（如 `curl` 檢查 API/Pages）。
- 若流程中斷或重啟 session，就再讀本檔 + README，照上述步驟重新接手。

> TL;DR：每一輪必做「讀 README → 按最新優先修 → 自己跑相關測試 → 成功後更新 README 紀錄 → 回報詳細結果」。任何少一步都視為未完成。*** End Patch***
