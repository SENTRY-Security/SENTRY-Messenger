# Codex 筆記（未來會話提示）

## 使用者需求摘要

- 目前專案尚未正式公開，僅在測試階段。Cloudflare D1 / R2 的測試資料允許自由覆寫或清空。
- 你擁有完整權限，可以部署 Node API、Cloudflare Worker，並執行原本撰寫的自動化測試腳本。
- 所有工作開始前請先閱讀並參照 `README.md`，了解架構、路由、測試腳本與 TODO 清單。
- 環境變數與密鑰（NTAG424、OPAQUE、HMAC、R2/S3 等）都已在 `.env` 檔中備妥，可直接使用。
- 回覆與說明請使用中文。
- 新的 session 一律先參考此檔案，再依 README 的 TODO / 指示展開工作，不須等待額外指令。
- 若執行的修改或測試結果失敗 / 不符預期，必須主動除錯、調整程式並重複驗證，切勿只回報錯誤。請將此流程視為固定要求。
- 結束一輪完整測試後，重新部署所有相關服務

## 常用專案資訊

- Node API：`src/server.js`、路由位於 `src/routes/`。
- Cloudflare Worker：`data-worker/`，`wrangler.toml` 及 migrations 已準備好。
- 測試腳本：
  - `npm run test:prekeys-devkeys`
  - `npm run test:messages-secure`
  - `npm run test:login-flow`
  - `npm run test:front:login`（Playwright E2E）
- 其他工具：Playwright E2E 測試、`scripts/` 內的實用腳本。

## 操作提醒

- 作業環境具備完全檔案存取與網路能力，不需要額外申請權限。
- 遇到流程中斷或需要重新建立會話，可直接參考此檔內容，避免重複詢問使用者。

## 建議工作流程

1. **新 session 啟動**：一律先完整閱讀 `Prompt.md`，接著打開 `README.md` 了解架構、TODO、測試與部署規範，再開始動工。
2. 進行需求時，必要時可查閱 `src/`、`data-worker/`、`web/` 目錄；避免改動使用者未授權檔案。
3. 完成功能或修復後，一律自行執行下列測試（視需求可追加），除非個別測試與修改內容無關才可跳過並於回報中說明原因：
   - `npm run test:prekeys-devkeys`
   - `npm run test:messages-secure`
   - `npm run test:login-flow`
   - `npm run test:friends-messages`
   - `npm run test:front:login`（Playwright：登入＋主畫面多項操作；需確認 API 已啟動）
4. 若需部署，依修改範圍選擇 `scripts/deploy-prod.sh`：
   - 後端/Node 變更：`bash ./scripts/deploy-prod.sh --skip-worker --skip-pages`
   - Worker / D1 變更：`bash ./scripts/deploy-prod.sh --apply-migrations --skip-pages`
   - 前端 Pages 變更：`bash ./scripts/deploy-prod.sh --skip-worker --skip-api`
   - 執行完成後使用腳本提示的 `curl` 指令檢查 API/Pages 健康狀態
5. 如果測試或部署失敗，先分析並修正程式碼與流程，直到全部通過再回報成果。
6. 撰寫回覆時，說明修改範圍、測試結果、部署情況與後續建議步驟；保持中文說明與簡潔格式。未執行的測試或部署需明確交代原因與風險。

> **備忘**：未來若 session 重新開啟，只要收到「閱讀 Prompt.md 並開始工作」指令，就依上述步驟自動執行：閱讀 → 開發 → 測試 → 視情況部署 → 回報。*** End Patch***
