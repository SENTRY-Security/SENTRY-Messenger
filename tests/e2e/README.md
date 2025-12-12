# Friend Invite Flow (Playwright, WebKit iPhone 13)

這個測試用 Playwright（WebKit / iPhone 13 Pro profile）模擬完整流程：
1. SDM 交換（計算 CMAC → `/api/v1/auth/sdm/exchange`）取得 `accountToken/accountDigest`。
2. 產生 IK/SPK + OPK，呼叫 `/api/v1/keys/publish` 上傳。
3. Owner 建立好友邀請；Guest 模擬掃描接受。
4. 雙方呼叫 `/api/v1/friends/bootstrap-session` 確認關係建立。
5. 自動將 fixture 的 counter +1 回寫，方便下次重跑。

## 前置條件
- Node modules 已安裝（含 `@playwright/test`）。  
- `.env` 或環境變數提供 SDM 相關金鑰：
  - `SDM_FILE_READ_KEY`（或 `_HEX`）— 16B 檔案讀取金鑰，計算 CMAC 用。
  - `NTAG424_KM` / `NTAG424_KDF` / `NTAG424_SALT` / `NTAG424_INFO` / `NTAG424_KVER` — 若未設，請沿用 `.env` 的值。
- API 入口：`ORIGIN_API`（預設 `https://api.message.sentry.red`，可覆寫）。
- 測試帳號 fixture：
  - 建立 `tests/fixtures/accounts.local.json`（不進版控），格式同 `accounts.sample.json`：
    ```json
    {
      "owner": { "uidHex": "0463640A842090", "counter": "0000A0", "password": "owner-password", "deviceId": "device-owner-1" },
      "guest": { "uidHex": "04A1B2C3D4E5F6", "counter": "0000A0", "password": "guest-password", "deviceId": "device-guest-1" }
    }
    ```
- counter 必須「大於伺服端記錄的 last_ctr」（避免 Replay）。每次測試結束會自動將兩個帳號的 counter +1 回寫 fixture；若你手動清空 D1 或更換帳號，請同步調整 counter。

## 執行指令
```bash
ORIGIN_API=https://api.message.sentry.red \
SDM_FILE_READ_KEY=19850622199210011989112419900413 \
NTAG424_KM=19850622199210011989112419900413 \
NTAG424_KDF=HKDF \
NTAG424_SALT=sentry.red \
NTAG424_INFO=ntag424-slot-0 \
NTAG424_KVER=1 \
npx playwright test tests/e2e/friend-invite-flow.spec.mjs
```

## 預期輸出
- 成功：Playwright 顯示 1 test passed。
- 失敗常見原因：
  - `Replay lastCtr=...`：請把 fixture 的 counter 調到大於該值。
  - `ik_pub required`：確保 keys.routes 傳遞的 signedPrekey 帶有 `ik_pub`（已在程式調整）。
  - 其他 4xx/5xx：查看回傳 JSON 的 `details`。

## 相關檔案
- 測試腳本：`tests/e2e/friend-invite-flow.spec.mjs`
- Fixture 範例：`tests/fixtures/accounts.sample.json`
- 本說明：`tests/e2e/README.md`
