# Encrypted Voice / Video Call — 測試與安全審查計畫

> 對應 README「Encrypted Voice / Video Call Roadmap」第七項。描述自動化測試、實機驗證與安全審查流程，涵蓋 PWA 與 iOS App。**目前舊版 mjs 測試已全數移除，本文件為待重建的目標規格，實作前需重新撰寫測試腳本與 CI。**

## 1. 測試金字塔

```
單元測試 (key ladder, signaling state machine)
  ↓
整合測試 (WebRTC stack, TURN, key rotation)
  ↓
端到端測試 (雙端自動化 / 實機)
```

## 2. 單元測試

- （待重建）`calls/key-manager.test.*`：驗證 key ladder、輪換與銷毀 API。
- （待重建）`calls/signaling-state.test.*`：模擬 invite/accept/cancel/timeout 循環。
- Swift 對應：使用 XCTest 驗證 `CallKeyManager` 與 `CallStateMachine`。

## 3. 整合測試

- **Web**：使用 `@web/test-runner` 或 Jest + `wrtc` 模擬 RTCPeerConnection，檢查 Insertable Streams、ICE fallback。
- **iOS**：在 Simulator 以 `XCTest` + WebRTC native stack 發起 loopback 通話。
- （待重建）`scripts/test-call-loopback.*`：
  - 啟動兩個 headless 客戶端
  - 從 TURN credentials API 取憑證
  - 檢查 `call_sessions` 更新、`call-events` 日誌

## 4. 端到端測試

### 4.1 自動化（Playwright）

- （待重建）`tests/e2e/calls.spec.*`：
  - 同時啟動兩個瀏覽器 context（caller/callee）
  - 使用 mock push 通知觸發來電
  - 驗證語音/視訊切換、掛斷、網路切換（模擬 `offline` → `online`）
  - 下載並檢查 QoS 報告（封包遺失 < 5%）

### 4.2 實機 / iOS

- 使用兩台 iPhone (或 iPhone + PWA)：
  - 測試 CallKit 來電、背景 Play、藍牙耳機、CarPlay。
  - 量測通話建立時間、畫質降階反應。
  - 記錄影片/截圖留存於 `artifacts/calls/`。

## 5. 安全審查

### 5.1 Threat Model

- 更新現有 threat model 文件，新增：
  - 通話信令窺探
  - TURN 憑證濫用
  - 中途人攻擊（重放、降級）
  - 裝置錄音/錄影

### 5.2 Secure Code Review

- 每個 PR 檢查：
  - 金鑰生命週期
  - 錯誤處理洩敏
  - 日誌是否含個資

### 5.3 第三方評估

- 與外部安全公司合作，範圍：
  - 信令服務滲透測試
  - TURN server 配置評估
  - WebRTC 端到端 E2EE 審查（SFrame/Insertable Streams）

### 5.4 Bug Bounty

- 將新功能納入漏洞回報計畫，提供特定測試帳號/環境。

## 6. 程式碼品質檢查

- ESLint / Prettier 針對新 `calls/*` 模組。
- SwiftLint 對 iOS 呼叫模組。
- TypeScript 型別加強：`strictNullChecks`。

## 7. 自動化報告

- （待重建）CI 任務 `npm run test:calls`：
  - 單元 + 整合測試
  - 匯出 coverage 報告
- Playwright 端到端在 GitHub Actions nightly 跑，失敗時附影片。

## 8. 待辦

1. 建立 `tests/e2e/calls.spec.mjs`、`tests/calls` 目錄。
2. 撰寫 `scripts/calls/run-loopback.sh` 供 QA 使用。
3. 更新 CI（GitHub Actions）加入 `calls` 測試 workflow。
4. 編寫 threat model 增補章節並提交安全審查。
5. 協調第三方安全檢測時間與範圍。

---

**狀態**：測試與安全審查規劃完成，後續可按清單落實。*** End Patch
