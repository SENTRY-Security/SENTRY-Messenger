# SENTRY-Messenger 安全稽核報告

**日期：** 2026-02-20
**範圍：** 完整程式碼審查 — 密碼學、身分驗證、伺服器、用戶端、金鑰管理、協定、相依套件
**分支：** `main`（稽核時之 commit）

---

## Remediation History

> 以下表格記錄各項修正的完成狀態。✅ = 已完成，⬜ = 待辦，~~ = 已移除（不需要）。

### Audit Findings 修正狀態

| 狀態 | Finding | 標題 | 修正日期 | 修正細節 |
|:----:|---------|------|:--------:|----------|
| ✅ | CRIT-01 | Double Ratchet Forward Secrecy Disabled | 2026-02-20 | Phase 0–1 完整啟用 DH ratchet。`dr.js:323-330` 取消註解 + 14 項 counter 管理重構。commit `7282392`, `787954e` |
| ⬜ | CRIT-02 | Debug Flags Hardcoded to `true` | — | 待將 `debug-flags.js` 所有 flag 設為 `false` |
| ⬜ | CRIT-03 | Unauthenticated OPAQUE Debug Endpoint | — | 待移除或加入 admin HMAC 認證 |
| ⬜ | CRIT-04 | Dependency Vulnerabilities (27 total) | — | 待 `npm audit fix` + AWS SDK 升級 |
| ✅ | HIGH-01 | AAD Omission Fallback in AES-GCM | 2026-02-20 | Phase 1.4：AAD 為 null 時改為 throw，不再 fallback。commit `787954e` |
| ⬜ | HIGH-02 | Plaintext Preview via WebSocket | — | 待移除 WS 通知中的 `preview` 欄位 |
| ⬜ | HIGH-03 | Message Key in Encrypted Packet Output | — | 待審計 `message_key_b64` 使用處 |
| ⬜ | HIGH-04 | Source Maps in Production Build | — | 待設 `sourcemap: false` |
| ⬜ | HIGH-05 | Missing CSP | — | 待加入 security headers |
| ⬜ | HIGH-06 | Unrestricted Media Upload Content-Type | — | 待加入 allowlist |
| ⬜ | HIGH-07 | IndexedDB Key Material Unprotected | — | 待評估 WebAuthn PRF |
| ⬜ | HIGH-08 | `elliptic` Library Used | — | 待遷移至 `@noble/curves` |
| ⬜ | MED-01 | CORS Allows Null Origin | — | — |
| ⬜ | MED-02 | Rate Limiting Disabled in Non-Prod | — | — |
| ⬜ | MED-03 | WebSocket Token Custom Implementation | — | — |
| ⬜ | MED-04 | NTAG424 KDF Hardcoded Salt | — | — |
| ⬜ | MED-05 | Remote Console Debug Endpoint | — | — |
| ⬜ | MED-06 | No SRI for CDN Imports | — | — |
| ⬜ | MED-07 | `trust proxy` Set to `loopback` | — | — |
| ⬜ | MED-08 | Skipped Message Keys Limit DoS | — | — |
| ⬜ | MED-09 | CI/CD Pipeline Disabled | — | — |
| ⬜ | MED-10 | `getStatus` Leaks Environment Info | — | — |
| ⬜ | MED-11 | No `.env.example` Template | — | — |

### Appendix B 工作項目修正狀態

| 狀態 | Phase | 項目 | 修正日期 | Commit | 細節 |
|:----:|:-----:|------|:--------:|--------|------|
| ✅ | 0 | 0.1 — NsTotal 管理權統一到 drEncryptText | 2026-02-20 | `7282392` | 移除 `drRatchet` 中 `NsTotal += Ns` 累加 |
| ✅ | 0 | 0.2 — NrTotal 管理權統一到呼叫端 | 2026-02-20 | `7282392` | 移除 `drRatchet` 中 `NrTotal += Nr` 累加 |
| ✅ | 0 | 0.3 — NsTotal 修正邏輯簡化 | 2026-02-20 | `7282392` | 三處條件式修正改為無條件 `state.NsTotal = transportCounter` |
| ✅ | 0 | 0.4 — NrTotal 單調遞增語義 | 2026-02-20 | `7282392` | chain reset 時 `Ns=0, PN=0, ckS=null` 強制下次 ratchet |
| ✅ | 0 | 0.5 — Phase 0 單元測試 | 2026-02-20 | `7282392` | `phase0-counter-semantics.spec.mjs` — 7 tests pass |
| ✅ | 1 | 1.1 — 啟用 drRatchet sending-side | 2026-02-20 | `787954e` | 取消註解 `ckS=null, PN=Ns, Ns=0, myRatchetPriv/Pub=myNew` |
| ~~ | 1 | ~~1.2 — 舊鏈訊息解密支援~~ | — | — | 已移除：單調接收架構不需要 |
| ✅ | 1 | 1.3 — 硬拒絕過大 pn gap | 2026-02-20 | `787954e` | `pn gap > SKIPPED_KEYS_PER_CHAIN_MAX` 改為 throw |
| ✅ | 1 | 1.4 — AAD 強制存在 | 2026-02-20 | `787954e` | `if (!aad) throw Error('AAD construction failed')` |
| ✅ | 1 | 1.5 — drDecryptText ratchet 後 ckS 維護 | 2026-02-20 | `787954e` | 驗證 working→st copy 正確傳播 `ckS=null` |
| ✅ | 1 | 1.6 — Phase 1 端對端測試 | 2026-02-20 | `787954e` | `phase1-forward-secrecy.spec.mjs` — 8 tests pass |
| ✅ | 1 | 1.7 — pn 一致性斷言 | 2026-02-20 | `787954e` | `if (pn !== working.Nr) console.error('CONSISTENCY VIOLATION')` |
| ~~ | 2 | ~~Phase 2 全部~~ | — | — | 已移除：skippedKeys 永遠為空，不需要序列化 |
| ✅ | 3 | 3.1 — CounterTooLow DR state rollback | 2026-02-21 | `af15b50` | re-encrypt 前先用 `preSnapshot` 回滾 DR state |
| ✅ | 3 | 3.2 — Media send CounterTooLow rollback | 2026-02-21 | `af15b50` | media 路徑同步加入 rollback 邏輯 |
| ✅ | 3 | 3.3 — seedTransportCounter chain reset | 2026-02-21 | `70de424` | `Ns=0, PN=0, ckS=null` 讓下次 encrypt 觸發 ratchet |
| ✅ | 3 | 3.4 — gap-queue 404 容錯 | 2026-02-21 | `70de424` | 404 回應跳過 counter，不 retry，不 block 後續訊息 |
| ✅ | 4 | 4.1 — Stage3 注水後立即 remote backup | 2026-02-21 | `70de424` | `triggerContactSecretsBackup('post-hydrate')` |
| ✅ | 4 | 4.2 — 注水時設定 pendingSendRatchet | 2026-02-21 | `70de424` | 強制下次送出時 ratchet，確保 forward secrecy |
| ✅ | 4 | 4.3 — 登出前強制推 remote backup | 2026-02-21 | `70de424` | `triggerContactSecretsBackup('secure-logout', { force: true })` |
| ✅ | 4 | 4.4 — force-logout state 保護 | 2026-02-21 | `70de424` | `keepalive: true` 確保頁面卸載時 fetch 完成 |
| ✅ | 4 | 4.5 — Stale state 偵測 | 2026-02-21 | `70de424` | vault vs backup `updatedAt` 比對，擇新覆蓋 |
| ✅ | 5 | 5.1 — Ratchet 中途被踢除的恢復邏輯 | 2026-02-21 | `54828ab` | 測試驗證：deterministic re-ratchet（同 myPriv + theirPub = 同 ckR） |
| ✅ | 5 | 5.2 — 送出 ratchet crash 恢復 | 2026-02-21 | `54828ab` | 測試驗證：`pendingSendRatchet + ckS=null` 恢復路徑 |
| ~~ | 5 | ~~5.3 — Vault put 失敗 skippedKeys 自癒~~ | — | — | 已移除：skippedKeys 為空 |
| ✅ | 5 | 5.4 — send-state HMAC 完整性驗證 | 2026-02-21 | `54828ab` | worker `signResponseBody()` + backend `timingSafeEqual` 驗簽 |
| ~~ | 5 | ~~5.5 — Snapshot size 監控~~ | — | — | 已移除：不新增 skippedKeys |
| ✅ | 6 | 6.1 — E2E: 基本 ratchet 旋轉 | 2026-02-21 | `54828ab` | 多方向切換 + ek_pub 旋轉驗證 |
| ✅ | 6 | 6.2 — E2E: 單調接收 skippedKeys 為空 | 2026-02-21 | `54828ab` | `onSkippedKeys` callback 從未觸發 + pn 一致性 |
| ✅ | 6 | 6.3 — E2E: 登出→登入→還原 | 2026-02-21 | `54828ab` | snapshot → 清除 → 還原 → 繼續雙向通訊 |
| ✅ | 6 | 6.4 — E2E: 被踢除→新裝置登入 | 2026-02-21 | `54828ab` | stale snapshot + gap-queue replay → 接收新訊息 |
| ✅ | 6 | 6.5 — E2E: CounterTooLow + ratchet | 2026-02-21 | `54828ab` | rollback + re-encrypt → 無 skippedKeys |
| ✅ | 6 | 6.6 — E2E: gap-queue 404 容錯 | 2026-02-21 | `54828ab` | phantom gap 下 DR chain 連續性不受影響 |
| ~~ | 6 | ~~6.7 — Snapshot v1→v2 遷移~~ | — | — | 已移除：不需要 v2 格式 |

**測試統計：** 45 tests pass（Phase 0: 7, Phase 1: 8, Phase 3: 7, Phase 5: 9, Phase 6: 14），zero regression。

---

## 執行摘要

SENTRY-Messenger 是一款端對端加密通訊應用程式，實作了 X3DH 金鑰協商、Double Ratchet (DR) 前向保密、OPAQUE 密碼認證金鑰交換，以及 AES-256-GCM AEAD 加密。本專案展現出明確的安全設計意圖，採用了明確的「無降級」密碼學策略與現代化的函式庫選擇。

然而，本次稽核共辨識出 **4 項 CRITICAL**、**8 項 HIGH** 及 **11 項 MEDIUM** 嚴重程度的發現。最迫切的問題包括：**Double Ratchet 中的前向保密被停用**、**debug 旗標在正式環境建置中被寫死為 true**、**未經身分驗證的 debug 端點暴露伺服器配置**，以及 **27 個相依套件漏洞，其中包含 1 個 CRITICAL CVE**。

**整體評級：MEDIUM** — 優良的架構被實作層級的問題所削弱，必須在正式環境強化前予以修復。

---

## 目錄

0. [修正紀錄](#remediation-history)
1. [CRITICAL 發現](#1-critical-findings)
2. [HIGH 嚴重程度發現](#2-high-severity-findings)
3. [MEDIUM 嚴重程度發現](#3-medium-severity-findings)
4. [LOW 嚴重程度 / 資訊性](#4-low-severity--informational)
5. [正面觀察](#5-positive-observations)
6. [相依套件漏洞摘要](#6-dependency-vulnerability-summary)
7. [依優先順序排列之建議](#7-recommendations-by-priority)

---

## 1. CRITICAL 發現

### CRIT-01: Double Ratchet 前向保密被停用

**檔案：** `web/src/shared/crypto/dr.js:323-330`
**嚴重程度：** CRITICAL
**CVSS 估計：** 9.1

`ratchetDH()` 中的發送端棘輪步驟被**以 `[DEBUG]` 註解標記停用**：

```javascript
// [DEBUG] Disable recurring ratchet: Keep existing sending chain alive.
// st.ckS = null;
// [DEBUG] Disable sending side updates entirely
// st.PN = st.Ns;
// st.Ns = 0;
// st.myRatchetPriv = myNew.secretKey;
// st.myRatchetPub = myNew.publicKey;
```

**影響：** DH 棘輪在發送端從未前進。一旦單一 chain key 被洩漏，即可揭露該方向上的**所有未來訊息**。前向保密 — Double Ratchet 協定的核心安全特性 — 實質上已被停用。私有棘輪金鑰從未輪換，因此一次性的金鑰洩漏將造成永久性影響。

**建議：** 取消第 324-330 行的註解 — 但**切勿單獨進行**。此變更會對整個以 counter 為基礎的訊息傳遞管線產生連鎖效應。請參閱 **Appendix A** 以取得完整的影響分析，涵蓋跨 6 個架構層及 12 個檔案中所辨識出的 14 個問題，均需同步更新。若僅取消這些行的註解而未進行配套變更，**將導致訊息傳遞中斷並造成永久性訊息遺失**。

---

### CRIT-02: Debug 旗標在正式環境中被寫死為 `true`

**檔案：** `web/src/app/ui/mobile/debug-flags.js:1-17`
**嚴重程度：** CRITICAL
**CVSS 估計：** 7.5

```javascript
export const DEBUG = {
  replay: true,           // ← enabled
  drVerbose: true,        // ← enabled — dumps DR state to console
  conversationReset: true // ← enabled
};
```

**影響：** 這些旗標被整個程式碼庫所匯入，包括 `dr.js`（第 25 行：`const drDebugLogsEnabled = DEBUG.drVerbose === true`）。當 `drVerbose` 為 true 時，Double Ratchet 會將 DH 輸出雜湊、chain key 種子雜湊、臨時金鑰前綴、message key 雜湊、IV 雜湊、密文雜湊、AAD 雜湊及 counter 值以 `console.warn` 輸出到主控台。此 metadata 足以讓擁有主控台存取權的進階攻擊者（例如透過 XSS 或瀏覽器擴充功能）進行密碼分析或確認訊息內容。

此外，`DEBUG.replay = true` 啟用了重播診斷程式碼路徑，而 `DEBUG.conversationReset = true` 啟用了重設追蹤 — 兩者皆會洩漏協定狀態。

**建議：** 將所有 DEBUG 旗標在正式環境建置中設為 `false`。實作建置階段的旗標或環境變數，以從正式環境套件中移除 debug 日誌（例如使用 esbuild 的 `define` 選項）。

---

### CRIT-03: 未經身分驗證的 OPAQUE Debug 端點

**檔案：** `src/routes/auth.routes.js:606-624`
**嚴重程度：** CRITICAL
**CVSS 估計：** 7.8

```javascript
r.get('/auth/opaque/debug', (req, res) => {
  const out = {
    hasSeed: /^[0-9A-Fa-f]{64}$/.test(seedHex),
    hasPriv: !!privB64,
    hasPub: !!pubB64,
    seedLen: seedHex.length,
    privLen: Buffer.from(privB64 || '', 'base64').length || 0,
    pubLen: Buffer.from(pubB64 || '', 'base64').length || 0,
    serverId: OPAQUE_SERVER_ID || null
  };
  return res.json(out);
});
```

**影響：** 此端點**無需任何身分驗證即可公開存取**。它揭露了：
- OPAQUE 密碼學材料（seed、私鑰、公鑰）是否已配置
- 所有金鑰材料的確切位元組長度
- OPAQUE 伺服器識別碼字串

此資訊能夠促成針對性攻擊：攻擊者可判斷使用的確切金鑰類型/曲線、確認伺服器正在執行 OPAQUE，並利用伺服器 ID 進行協定層級的攻擊。金鑰長度的揭露縮小了暴力破解的搜尋空間。

**建議：** 完全移除此端點，或透過管理員 HMAC 身分驗證（`verifyIncomingHmac`）加以保護。密碼學配置的 debug 內省功能絕不應公開存取。

---

### CRIT-04: 相依套件漏洞 — 共 27 個（1 個 CRITICAL、22 個 HIGH）

**來源：** `npm audit` 輸出
**嚴重程度：** CRITICAL（綜合評估）

| 套件 | 嚴重程度 | 問題 | 是否有修正 |
|------|----------|------|------------|
| fast-xml-parser (經由 @aws-sdk) | CRITICAL | RangeError DoS、Entity expansion 繞過、DOCTYPE 中的 Regex 注入 | 更新 AWS SDK |
| elliptic | HIGH | 具風險的 ECDLP 實作 (GHSA-848j-6mx2-7j84) | 遷移至 @noble/curves |
| systeminformation | HIGH | 透過未清理的輸入進行命令注入 | npm audit fix |
| pm2 | HIGH | 正規表達式 DoS | 無可用修正 |
| qs | HIGH | arrayLimit 繞過 (DoS) | npm audit fix |
| lodash | MODERATE | `_.unset`/`_.omit` 中的原型污染 | npm audit fix |

**建議：**
1. `npm install @aws-sdk/client-s3@latest @aws-sdk/s3-presigned-post@latest @aws-sdk/s3-request-presigner@latest`
2. `npm audit fix`
3. 將 `auth.routes.js` 中的 `elliptic` 使用遷移至 `@noble/curves`（已是現有相依套件）
4. 評估 pm2 替代方案，或以文件記錄方式接受風險

---

## 2. HIGH 嚴重程度發現

### HIGH-01: AES-GCM 加密中的 AAD 省略降級

**檔案：** `web/src/shared/crypto/dr.js:399-401`
**嚴重程度：** HIGH

```javascript
const aad = buildDrAad({ version, deviceId, counter: st.Ns });
const cipherParams = aad ? { name: 'AES-GCM', iv, additionalData: aad }
                         : { name: 'AES-GCM', iv };
```

**影響：** 若 `buildDrAad()` 回傳假值（null/undefined/空值），AES-GCM 將在**不包含額外驗證資料（AAD）**的情況下進行加密。AAD 的作用是將密文綁定至協定上下文（版本、裝置 ID、計數器）。若缺少 AAD，攻擊者可以：
- 在不同對話或裝置之間移植密文
- 以竄改過的標頭重放訊息
- 繞過計數器驗證

這直接違反了該檔案自身的安全策略：「不允許任何協定降級」。

**建議：** 當 AAD 為 null 或空值時應拋出錯誤，而非靜默降級。在協定綁定加密中，AAD 必須始終存在。

---

### HIGH-02: 明文訊息預覽透過 WebSocket 傳送

**檔案：** `src/controllers/messages.controller.js:288`
**嚴重程度：** HIGH

```javascript
mgr.notifySecureMessage({
  // ...
  preview: messageInput.preview || messageInput.text || '',
});
```

**影響：** 當新的安全訊息被儲存時，伺服器發送的 WebSocket 通知中包含了明文 `preview` 或 `text` 欄位。這意味著推播通知包含了**未加密的訊息內容**，因而：
- 在伺服器端以明文方式透過 WebSocket 傳輸
- 對任何伺服器端的日誌記錄或監控系統可見
- 使通知傳遞環節的端到端加密形同虛設

**建議：** 從 WebSocket 通知中完全移除 `preview` 欄位，或將其替換為靜態佔位文字（例如「新訊息」）。客戶端應在本地解密訊息後再顯示預覽。

---

### HIGH-03: 訊息金鑰被包含在加密封包輸出中

**檔案：** `web/src/shared/crypto/dr.js:436`
**嚴重程度：** HIGH

```javascript
return {
  aead: 'aes-256-gcm',
  header,
  iv_b64: b64(iv),
  ciphertext_b64: b64(new Uint8Array(ctBuf)),
  message_key_b64: mkB64   // ← message key returned alongside ciphertext
};
```

**影響：** `drEncryptText()` 函式在回傳物件中同時包含了訊息金鑰（`mk`）與密文。若任何程式碼路徑序列化或傳輸了完整的回傳物件（例如用於除錯、日誌記錄或網路傳輸），則用於加密訊息的對稱金鑰將與密文一同暴露，使加密完全失去意義。

**建議：** 審查所有呼叫 `drEncryptText()` 的程式碼，確保 `message_key_b64` 在傳輸前被移除。考慮將其從回傳值中完全刪除，若金鑰備份（vault）有需要，僅透過單獨的管道提供。

---

### HIGH-04: 正式環境建置啟用了 Source Maps

**檔案：** `web/build.mjs:52`
**嚴重程度：** HIGH

```javascript
sourcemap: true,
```

**影響：** 正式環境的 Source Maps 會暴露完整的原始程式碼，包括：
- 所有密碼學實作細節
- 認證邏輯
- 除錯旗標位置與繞過模式
- 內部 API 端點結構

這大幅降低了針對應用程式進行定向攻擊的門檻。

**建議：** 在正式環境建置中設定 `sourcemap: false`，或使用 `sourcemap: 'external'` 並僅從需要驗證或存取受限的端點提供 Source Maps。

---

### HIGH-05: 缺少 Content Security Policy (CSP)

**檔案：** `web/src/_headers`
**嚴重程度：** HIGH

`_headers` 檔案僅包含快取控制指令，未定義任何 CSP 標頭。雖然 `helmet()` 為 API 伺服器提供了預設值，但透過 Cloudflare Pages 提供的靜態網頁前端**沒有 CSP**。

**影響：** 缺少 CSP 會使應用程式容易受到以下攻擊：
- 載入外部腳本的 XSS 攻擊
- 透過行內腳本進行資料外洩
- 點擊劫持（clickjacking，因缺少 frame-ancestors 指令）

鑑於該應用程式在瀏覽器中處理密碼學金鑰，XSS 尤其危險——攻擊者可能提取棘輪狀態、訊息金鑰或身分金鑰。

**建議：** 在 `web/src/_headers` 中添加完整的 CSP 標頭：
```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.workers.dev; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
```

---

### HIGH-06: 媒體上傳的 Content-Type 未受限制

**檔案：** `src/routes/v1/media.routes.js:188-191`
**嚴重程度：** HIGH

```javascript
// 不限制 Content-Type，全部允許；若要限制可透過 env 重啟後再加入檢查。
const allowed = [];
```

**影響：** S3 預簽名 URL 的產生接受任何內容類型。攻擊者可以：
- 上傳可執行檔（.exe、.html、含有腳本的 .svg）
- 儲存在 S3/R2 網域上下文中可執行的惡意 HTML
- 若媒體 URL 曾在瀏覽器環境中被渲染，可進行儲存型 XSS 攻擊

**建議：** 實作內容類型白名單（例如 `image/jpeg`、`image/png`、`image/webp`、`video/mp4`、`audio/ogg`、`application/octet-stream`）。拒絕或清理非預期的類型。

---

### HIGH-07: IndexedDB 中的金鑰材料缺乏作業系統層級保護

**檔案：** `web/src/app/features/message-key-vault.js`、`web/src/shared/crypto/db.js`
**嚴重程度：** HIGH

所有密碼學金鑰材料（身分金鑰、棘輪狀態、預備金鑰、訊息金鑰）皆以 AES-GCM 包裝後儲存於 IndexedDB 中，使用由 `crypto.subtle` 衍生的金鑰進行包裝。然而：
- 包裝金鑰本身也儲存在 IndexedDB 中
- 未使用硬體支援的金鑰儲存機制（WebAuthn、平台金鑰鏈）
- 任何具有同源存取權限的腳本皆可讀取所有金鑰材料

**影響：** 一個 XSS 漏洞（參見 HIGH-05）將允許完全提取所有密碼學金鑰，使攻擊者能解密所有過去和未來的訊息。

**建議：** 考慮盡可能對包裝金鑰使用 Web Crypto API 的 `extractable: false` 選項。研究 WebAuthn PRF 擴充功能以實現硬體綁定的金鑰衍生。至少應確保健全的 CSP 以防止 XSS。

---

### HIGH-08: 已有 `@noble/curves` 可用，卻仍使用 `elliptic` 函式庫

**檔案：** `src/routes/auth.routes.js`
**嚴重程度：** HIGH

伺服器使用 `elliptic` 函式庫進行 P-256 運算，而 `@noble/curves`（一個現代、已通過審計、常數時間的實作）已作為依賴項安裝。

**影響：** `elliptic` 函式庫存在已知的漏洞公告（GHSA-848j-6mx2-7j84），且使用非常數時間的純量乘法，在伺服器環境中容易受到時序側通道攻擊。

**建議：** 將所有 `elliptic` 的使用替換為 `@noble/curves`：
```javascript
import { p256 } from '@noble/curves/p256';
```

---

## 3. MEDIUM 嚴重程度發現

### MED-01: CORS 允許 Null Origin

**檔案：** `src/app.js:28`

```javascript
if (!origin) return cb(null, true); // non-browser or same-origin
```

當 `origin` 為 `undefined`（非瀏覽器請求）時，CORS 允許該請求通過。這對伺服器對伺服器的呼叫而言是標準做法，但同時也允許來自 `null` origin 的請求（沙箱 iframe、file:// 協定、重新導向），可能被利用進行類似 CSRF 的攻擊。

---

### MED-02: 非正式環境中停用了速率限制

**檔案：** `src/app.js:50`

```javascript
const enableRateLimit = process.env.NODE_ENV === 'production' && process.env.DISABLE_RATE_LIMIT !== '1';
```

速率限制僅在正式環境中啟用。可從網路存取的測試環境或開發環境對暴力破解攻擊毫無防護。

---

### MED-03: WebSocket Token 使用自定義實作

**檔案：** `src/utils/ws-token.js`

使用了自定義的類 JWT token 實作，而非標準的 JWT 函式庫。雖然該實作包含了時序安全比較和正確的 HMAC-SHA256，但與經過實戰驗證的函式庫相比，自定義的加密 token 實作存在較高的隱微漏洞風險。

---

### MED-04: NTAG424 KDF 使用硬編碼的預設 Salt

**檔案：** `src/lib/ntag424-kdf.js`

未設定時，KDF 的 salt 預設為 `'sentry.red'`。硬編碼的 salt 會降低金鑰衍生對抗彩虹表攻擊的有效性。

---

### MED-05: 遠端主控台除錯端點將任意客戶端資料寫入磁碟

**檔案：** `src/routes/v1/debug.routes.js:88-104`

雖然預設為停用且需要帳號驗證，但啟用後 `/debug/console` 端點會透過 `fs.appendFile` 將客戶端提供的資料直接寫入檔案系統。`entries` 陣列接受任意的 `args: z.array(z.any())`，可被利用於：
- 磁碟耗盡攻擊
- 使用精心構造的酬載進行日誌注入

---

### MED-06: 外部 CDN 匯入缺少 Subresource Integrity (SRI)

**檔案：** `web/build.mjs:55-58`

```javascript
external: [
  'https://esm.sh/*',
  'https://cdn.jsdelivr.net/*',
  'tweetnacl'
],
```

載入外部 CDN 資源時未使用 SRI 雜湊值。若 CDN 遭到入侵，可能注入惡意程式碼。

---

### MED-07: `trust proxy` 設定為 `loopback`

**檔案：** `src/app.js:15`

```javascript
app.set('trust proxy', 'loopback');
```

若應用程式並非位於迴環介面上的反向代理之後，或攻擊者能直接連線至應用程式，則攻擊者可偽造 `X-Forwarded-For` 標頭以繞過基於 IP 的速率限制。

---

### MED-08: 跳過訊息金鑰的上限可能導致 DoS

**檔案：** `web/src/shared/crypto/dr.js:22`

```javascript
const SKIPPED_KEYS_PER_CHAIN_MAX = 100;
```

攻擊者可發送具有高計數器值的訊息，迫使接收者針對每條鏈衍生並儲存多達 100 個跳過的訊息金鑰，造成計算與記憶體開銷。

---

### MED-09: CI/CD 流水線已停用

**檔案：** `.github/workflows/e2e.yml.disabled`

CI/CD 工作流程已停用（檔案以 `.disabled` 後綴重新命名）。沒有自動化安全檢查（npm audit、SAST、程式碼檢查）在 Pull Request 或推送至主分支時執行。

---

### MED-10: `getStatus` 端點洩漏環境資訊

**檔案：** `src/controllers/messages.controller.js:31-36`

```javascript
export const getStatus = (req, res) => {
  res.json({
    name: process.env.SERVICE_NAME,
    version: process.env.SERVICE_VERSION,
    env: process.env.NODE_ENV
  });
};
```

向未經驗證的請求暴露服務名稱、版本和環境資訊，可被用於偵察。

---

### MED-11: 缺少 `.env.example` 範本

儲存庫中不存在 `.env.example` 檔案來記錄所需的環境變數。這增加了設定錯誤的風險（缺少 HMAC 密鑰、金鑰長度錯誤等）。

---

## 4. 低嚴重性 / 資訊性發現

| ID | 發現 | 檔案 |
|----|------|------|
| LOW-01 | `package-lock.json` 使用插入號範圍 (^)，允許次要版本漂移 | `package.json` |
| LOW-02 | 多重 HMAC secret 回退鏈可能造成混淆 | `src/controllers/messages.controller.js` |
| LOW-03 | `node-aes-cmac` (v0.1.1) 維護程度極低 | `package.json` |
| LOW-04 | 未配置 Dependabot 或 Renovate 進行自動化更新 | `.github/` |
| LOW-05 | 授權條款 (AGPL-3.0) 要求網路使用時公開原始碼——請確保合規 | `package.json` |
| LOW-06 | `packetHolderCache`（Map，最大 2000）除大小限制外無 TTL/驅逐機制 | `dr.js:23-24` |
| LOW-07 | 伺服器端匯入了客戶端的 debug-flags 模組 | `messages.controller.js:25` |

---

## 5. 正面觀察

本次稽核識別出若干良好的安全實踐：

- **明確的「無回退」加密策略**，記錄於關鍵檔案頂部（`dr.js`、`messages.controller.js`）
- **使用現代加密函式庫**：`@noble/curves`、`@noble/ed25519`、`@noble/hashes`、`tweetnacl`、`@cloudflare/opaque-ts`
- **一致使用時序安全比較**進行 HMAC 驗證（`crypto.timingSafeEqual`）
- **`WS_TOKEN_SECRET` 最小長度強制要求**（32 字元，於 `env.js` 啟動時驗證）
- **Zod schema 驗證**應用於所有 API 輸入，並使用嚴格型別
- **未將 secrets 提交至 git**：`.gitignore` 正確排除了 `.env*`，未發現硬編碼的憑證
- **SRI（子資源完整性）**在 `build.mjs` 中為打包資源計算雜湊值
- **建置清單包含 git commit/branch/dirty 狀態**，作為稽核軌跡
- **Helmet.js** 中介軟體在 API 伺服器上套用預設安全標頭
- **請求主體大小限制**（2MB）防止大型酬載攻擊
- **OPAQUE 協議**用於密碼認證——作為 PAKE 方案，顯著強於 bcrypt/scrypt
- **X3DH + Double Ratchet** 架構——E2E 加密的正確協議選擇（在 ratchet 正常運作時）
- **帳戶摘要正規化**，搭配嚴格的正規表示式驗證（`/^[0-9A-F]{64}$/`）

---

## 6. 相依套件漏洞摘要

```
漏洞總計：27
  Critical: 1  (fast-xml-parser 經由 AWS SDK)
  High:    22  (elliptic, systeminformation, pm2, qs 及傳遞性相依)
  Moderate: 1  (lodash 原型污染)
  Low:      3  (傳遞性相依中的次要問題)
```

執行 `npm audit` 可取得完整的機器可讀報告。

---

## 7. 依優先順序排列的建議

### 立即處理（下次發佈前）

| # | 行動 | 工作量 |
|---|------|--------|
| 1 | **啟用 ratchet 輪換**——需跨 12 個檔案進行同步變更（參見 Appendix A） | 高 |
| 2 | **將 `debug-flags.js` 中所有 DEBUG 旗標設為 `false`** | 低 |
| 3 | **移除或將 `/auth/opaque/debug` 端點限制**於管理員認證之後 | 低 |
| 4 | **執行 `npm audit fix`** 並更新 AWS SDK 套件 | 低 |
| 5 | **從 `drEncryptText()` 回傳值中移除 `message_key_b64`**（或在傳輸前剝離） | 低 |
| 6 | **從 WebSocket 通知中移除明文 `preview`** | 低 |
| 7 | **強制要求 AAD**——在 AAD 為 null 時拋出例外，而非省略 | 低 |

### 短期（兩週內）

| # | 行動 | 工作量 |
|---|------|--------|
| 8 | 將 `auth.routes.js` 中的 `elliptic` 遷移至 `@noble/curves` | 中 |
| 9 | 在 `web/src/_headers` 中加入 CSP 及安全標頭 | 中 |
| 10 | 為媒體上傳實作 content-type 白名單 | 中 |
| 11 | 在正式環境建置中停用 source maps（`sourcemap: false`） | 低 |
| 12 | 啟用包含 `npm audit` 和 SAST 步驟的 CI/CD 流水線 | 中 |
| 13 | 建立 `.env.example` 文件以記載所有必要的環境變數 | 低 |
| 14 | 移除或限制 `/api/v1/status` 端點 | 低 |

### 中期（一個月內）

| # | 行動 | 工作量 |
|---|------|--------|
| 15 | 為外部 CDN 匯入加入 SRI 雜湊值 | 中 |
| 16 | 實作建置時期 debug 程式碼剝離（esbuild `define`） | 中 |
| 17 | 配置 Dependabot 或 Renovate 進行自動化相依性更新 | 低 |
| 18 | 在 staging 環境加入速率限制 | 低 |
| 19 | 評估硬體支援的金鑰儲存方案（WebAuthn PRF） | 高 |
| 20 | 審查並在可行時降低 `SKIPPED_KEYS_PER_CHAIN_MAX` 的值 | 低 |

---

## 附錄 A：前向保密啟用——完整影響分析

**日期：** 2026-02-20
**背景：** CRIT-01 建議取消 `dr.js:323-330` 中棘輪旋轉的註解。本附錄分析了該變更在整個程式碼庫中的**完整影響範圍**，辨識出每個需要同步更新的模組。

> **嚴重警告：** 若僅取消第 323-330 行的註解而未進行以下描述的同步變更，**將導致訊息傳遞中斷**、造成 **counter 失去同步**，並可能導致**永久性訊息遺失**。

---

### A.1 架構概覽：雙 Counter 域

系統維護**兩個獨立的 counter 域**，必須保持同步：

```
┌──────────────────────────────────────────────────────────┐
│  DR Protocol Layer (per-chain counters)                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐               │
│  │ Ns (send)│  │ Nr (recv)│  │ PN (prev)│  ← per epoch  │
│  │ resets=0 │  │ resets=0 │  │ = old Ns │    on ratchet  │
│  └──────────┘  └──────────┘  └──────────┘               │
└──────────┬───────────────────────────────────────────────┘
           │ mapped via NsTotal / NrTotal
┌──────────▼───────────────────────────────────────────────┐
│  Transport Layer (monotonic counters)                    │
│  ┌──────────┐  ┌──────────┐                              │
│  │ NsTotal  │  │ NrTotal  │  ← never reset,             │
│  │ (global) │  │ (global) │    strictly increasing       │
│  └──────────┘  └──────────┘                              │
└──────────┬───────────────────────────────────────────────┘
           │ used as `counter` field in API
┌──────────▼───────────────────────────────────────────────┐
│  Server DB (D1/SQLite)                                   │
│  messages_secure.counter  ← monotonic per                │
│                              (conversation_id,           │
│                               sender_account_digest,     │
│                               sender_device_id)          │
│  Constraint: new counter > MAX(counter) else 409         │
└──────────────────────────────────────────────────────────┘
```

**目前狀態（ratchet 停用）：** Ns 從不重設，NsTotal ≈ Ns，因此兩個域保持同步。

**啟用 ratchet 後：** Ns 在每次 DH 棘輪步驟時重設為 0。NsTotal 必須吸收重設並繼續遞增。這就是 bug 產生的地方。

---

### A.2 第 1 層 — DR 協定（`web/src/shared/crypto/dr.js`）

#### A.2.1 `drRatchet()` (第 308-343 行) — 核心變更

**將被取消註解的程式碼：**
```javascript
st.ckS = null;                          // line 324: clear old sending chain
st.PN = st.Ns;                          // line 326: save previous chain length
st.Ns = 0;                              // line 327: reset sending counter
st.myRatchetPriv = myNew.secretKey;     // line 329: rotate DH keypair
st.myRatchetPub = myNew.publicKey;      // line 330: rotate DH keypair
```

**問題 1：NsTotal 重複計數**

第 309-314 行在取消註解的程式碼之前執行：
```javascript
const nsBase = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) : 0;
const nsPrev = Number.isFinite(st?.Ns) ? Number(st.Ns) : 0;
st.NsTotal = nsBase + nsPrev;  // line 313
```

但 `drEncryptText()` 在第 389 行也會遞增 NsTotal：
```javascript
st.NsTotal = Number.isFinite(st?.NsTotal) ? Number(st.NsTotal) + 1 : st.Ns;
```

**結果：** 當 `drRatchet` 從 `drDecryptText`（接收端）被呼叫時，NsTotal 獲得 `+= Ns`。然後當下一次 `drEncryptText` 觸發時，NsTotal 再次獲得 `+= 1`。若 ratchet 前 Ns 為 5：
- NsTotal 從 X 變為 X+5（在 drRatchet 中）
- 再從 X+5 變為 X+6（在 drEncryptText 中）
- 但正確值應僅從 X 變為 X+1（下一則訊息）
- **淨誤差：NsTotal 被膨脹了 (Ns - 1) = 4**

**所需修正：** `drRatchet` 不應累加 `NsTotal += Ns`。NsTotal 已由 `drEncryptText` 逐訊息維護。第 313 行的累加僅在 `drRatchet` 是追蹤總計數的*唯一*位置時才正確——但實際並非如此。

**問題 2：不對稱的棘輪行為**

`drRatchet()` 從 `drDecryptText()`（接收端棘輪）被呼叫，但**發送端棘輪**發生在 `drEncryptText()` 的第 362-382 行。兩條路徑都更新 `PN`、`Ns` 和 DH 金鑰，但它們是獨立進行的：

| 操作 | `drRatchet`（接收端） | `drEncryptText`（發送端） |
|------|----------------------|--------------------------|
| PN 更新 | `st.PN = st.Ns` ✓ | `st.PN = st.Ns` ✓ |
| Ns 重設 | `st.Ns = 0` ✓ | `st.Ns = 0` ✓ |
| ckS 清除 | `st.ckS = null` ✓ | 因 `!st.ckS` 而觸發 |
| DH 輪換 | `myNew = genX25519Keypair()` ✓ | `myNew = genX25519Keypair()` ✓ |
| NsTotal | `+= Ns`（錯誤） | `+= 1`（正確，逐訊息） |

**這代表接收端和發送端棘輪具有不同的 NsTotal 語義。**修正必須統一兩者。

#### A.2.2 `drEncryptText()` (第 345-438 行)

**問題 3：發送端棘輪時 NsTotal 被遞增兩次**

當 `!st.ckS` 且 `st.theirRatchetPub` 存在時（第 352、362 行），會發生發送端棘輪：
1. 第 370 行：`st.Ns = 0`
2. 第 388 行：`st.Ns += 1` → Ns 變為 1
3. 第 389 行：`st.NsTotal = NsTotal + 1`

對於發送端路徑而言，這是正確的。但如果接收端棘輪已經觸發了 `drRatchet()`，其中執行了 `NsTotal += Ns`，那麼第 389 行的 `+1` 會在已經膨脹的 NsTotal 上再次累加。

**所需修正：** 從 `drRatchet()` 中移除 `NsTotal += Ns`。讓 `drEncryptText` 成為 NsTotal 遞增的唯一擁有者。

#### A.2.3 `drDecryptText()` (第 440-994 行)

**問題 4：來自舊鏈的亂序訊息無法恢復**

在第 717 行執行棘輪後，`working.theirRatchetPub` 被更新為新金鑰。如果一條延遲的訊息攜帶舊的 `ek_pub_b64` 抵達：

1. 第 645-646 行：`sameReceiveChain` = false（舊金鑰 ≠ 新金鑰）
2. 第 649 行：跳過重放檢查（不在同一條鏈上）
3. 第 683 行：進入棘輪分支（金鑰不同）
4. 第 717 行：`drRatchet(working, theirPub)` — 使用舊金鑰與當前的 `myRatchetPriv` 進行 DH 運算
5. 由於 `myRatchetPriv` 在先前的棘輪中已被輪換，DH 輸出是錯誤的
6. 推導出的 `ckR` 是錯誤的 → 推導出的 `mk` 是錯誤的 → **AES-GCM 解密失敗**

**所需修正：** 在執行棘輪之前，檢查跳過金鑰映射中是否有舊鏈 ID。如果 `packet.header.ek_pub_b64` 匹配 `skippedKeys` 中的某條鏈，則使用已儲存的金鑰，而非執行棘輪。第 666-676 行的特殊情況處理（回應者、headerN===1、Nr===0）是不夠的——它只涵蓋了初始握手場景。

**問題 5：`pn` 標頭值未經驗證**

第 698 行：`if (prevChainId && working.ckR && Number.isFinite(pn) && pn > working.Nr)`

`pn` 值來自封包標頭（攻擊者可控制）。惡意的 `pn=999999` 會強制在第 707-713 行的 while 迴圈中推導多達 999999 個金鑰。第 700-703 行的警告僅記錄日誌——並不會中止操作。

**所需修正：** 當 `pn - working.Nr > SKIPPED_KEYS_PER_CHAIN_MAX` 時，應強制拒絕。

---

### A.3 第 2 層 — 傳輸計數器橋接 (`web/src/app/features/dr-session.js`)

#### A.3.1 `reserveTransportCounter()` (第 322-353 行)

```javascript
const before = requireTransportCounter(state, ...);  // reads state.NsTotal
const reserved = before + 1;
state.NsTotal = reserved;  // writes state.NsTotal
return reserved;
```

**問題 6：保留與加密之間的競爭條件**

流程如下：
1. `reserveTransportCounter()` → NsTotal = X+1，回傳 X+1
2. `drEncryptText()` → 內部執行 NsTotal += 1，使 NsTotal = X+2
3. 第 1898-1901 行的「修正」：
   ```javascript
   if (afterEncryptTotal === transportCounter + 1  // X+2 === X+2? 是
       || afterEncryptTotal < transportCounter) {
     state.NsTotal = transportCounter;  // 強制將 NsTotal 回設為 X+1
   }
   ```

目前這段邏輯能正常運作，因為 `drEncryptText` 總是恰好將 NsTotal 遞增 1，符合 `=== transportCounter + 1` 的條件，所以修正邏輯會觸發並將 NsTotal 重設為保留值。

**啟用棘輪後：** 如果在 `drEncryptText` 內部發生發送端棘輪，NsTotal 的變化量會超過 +1（由於問題 3 中 `drRatchet` 的 `NsTotal += Ns`）。修正條件 `afterEncryptTotal === transportCounter + 1` 變為 FALSE，而 `afterEncryptTotal < transportCounter` 也是 FALSE。**修正邏輯不會觸發**，導致 NsTotal 處於膨脹狀態。下一次 `reserveTransportCounter` 會回傳膨脹的值。伺服器端的計數器序列出現間隙（某些計數器值從未被發送）。接收端的 gap-queue 嘗試提取這些幽靈計數器並收到 404 回應。

**所需修正：** 修正邏輯需要：
- 加密後始終強制設定 `state.NsTotal = transportCounter`（最簡單的方案）
- 或者，如果 `drEncryptText` 不再修改 NsTotal，則完全移除此邏輯

#### A.3.2 `seedTransportCounterFromServer()` (第 355-451 行)

此函式向伺服器查詢現有訊息，並將 NsTotal 設為觀察到的最高計數器。它在 `state.baseKey.snapshot === true`（從快照還原）時執行。

**問題 7：缺乏鏈紀元感知**

種子邏輯掃描最多 50 條訊息並選取最大計數器。啟用棘輪後，同一對話可能包含跨越多個鏈紀元的訊息。最大計數器作為傳輸層的值是正確的，但該函式也未將 `Ns` 重設為與鏈紀元位置相匹配的值。

**影響：** 快照還原後，`Ns` 可能是過時的（來自舊紀元），而 NsTotal 是正確的（來自伺服器）。下一次 `drEncryptText` 使用過時的 `Ns` 來構建 AAD 計數器（`buildDrAad({ counter: st.Ns })`），這將與接收端預期的不匹配。

**所需修正：** 從伺服器種子化時，也應重設 `Ns = 0` 和 `PN = 0`，因為鏈紀元狀態已遺失。或者，在快照中儲存 `Ns` 和 `PN`，並在還原 NsTotal 時一併還原它們。

#### A.3.3 CounterTooLow 修復 (第 2164-2260 行)

```javascript
if (errorCode === COUNTER_TOO_LOW_CODE) {
  const sendState = await fetchAuthoritativeSendState({...});
  state.NsTotal = expectedCounter - 1;  // line 2177: FORCE OVERWRITE
  // ... re-encrypt with new counter ...
}
```

**問題 8：重新加密消耗了鏈金鑰但未更新接收端**

當 CounterTooLow 觸發時：
1. 第一次 `drEncryptText` 已消耗鏈金鑰 N 並遞增了 Ns
2. NsTotal 被覆寫為伺服器的 `expectedCounter - 1`
3. 第二次 `drEncryptText` 消耗鏈金鑰 N+1 並再次遞增 Ns
4. 訊息以伺服器預期的計數器發送

但鏈金鑰 N 被消耗用於一個**從未送達**的密文（409 回應表示伺服器已拒絕）。接收端永遠不會看到以鏈金鑰 N 加密的訊息，但發送端的鏈已經前進超過了它。

**啟用棘輪後：** 情況更加嚴重，因為：
- 如果重新加密觸發了發送端棘輪（因為接收端棘輪後 `ckS = null`），被浪費的鏈金鑰來自舊紀元，而新訊息來自新紀元
- 接收端預期在舊紀元鏈上收到下一條訊息，但收到的卻是新紀元鏈上帶有不同 `ek_pub_b64` 的訊息
- 接收端的 `pn` 檢查將出現間隙

**所需修正：** 在 CounterTooLow 時，第一個加密封包必須被丟棄，且 DR 狀態必須回滾到加密前的狀態後再重新加密。目前的程式碼並未回滾 DR 狀態——它只覆寫了 NsTotal。

#### A.3.4 `persistContactShareSequence()` (第 4500-4590 行)

```javascript
state.NrTotal = headerCounter;  // line 4525: DIRECT OVERWRITE
if ((state.Nr || 0) < headerCounter) state.Nr = headerCounter;  // line 4526
```

**問題 9：NrTotal 覆寫忽略了鏈紀元邊界**

此函式將 NrTotal 設為 headerCounter（來自接收訊息的 DR 標頭 `n` 欄位）。但啟用棘輪後，`header.n` 在每個紀元會重設為 1。當 NrTotal 先前為 50 時將其設為 1，會導致 NrTotal **倒退**，破壞傳輸層的單調性不變量。

**所需修正：** NrTotal 應為 `max(當前 NrTotal, NrTotal + 1)` — 單調遞增，永不遞減。標頭計數器 `n` 應僅用於鏈級別的追蹤。

---

### A.4 第3層 — 伺服器 API

#### A.4.1 `POST /messages/secure` — 計數器驗證

**檔案：** `data-worker/src/worker.js:2193-2203`

```javascript
const maxCounter = Number(maxRow?.max_counter ?? -1);
if (maxCounter >= 0 && msgCounter <= maxCounter) {
  return json({ error: 'CounterTooLow', maxCounter }, { status: 409 });
}
```

**啟用棘輪的影響：** 伺服器強制執行**嚴格單調性**（`counter > max_counter`）。這是正確的，無需更改。然而，客戶端必須確保 NsTotal 永遠不會產生重複或間隙——而這正是上述問題 6-8 可能導致的情況。

#### A.4.2 `GET /messages/by-counter` — 間隙填充

**檔案：** `data-worker/src/worker.js` 和 `web/src/app/features/messages-flow/gap-queue.js`

```javascript
// gap-queue.js: sequential counter fetch
for (let counter = startCounter; counter <= targetCounter; counter += 1) {
  const result = await fetchByCounter(conversationId, counter, ...);
}
```

**問題 10：假設計數器序列中不存在間隙**

間隙佇列會從 `startCounter` 到 `targetCounter` 逐一迭代每個整數。如果發送端的 NsTotal 發生跳躍（因問題 6 的膨脹所致），該範圍內的某些計數器值從未儲存在伺服器上。間隙佇列將會：
1. 擷取計數器 N → 404（不存在）
2. 重試最多 `GAP_QUEUE_RETRY_MAX` 次
3. 最終標記為 `unable_to_decrypt`
4. 移至計數器 N+1

這會導致不必要的網路流量、延遲，以及 UI 中出現誤判的「無法解密」錯誤。

**所需修正：** 間隙佇列應優雅地容忍 404——跳過缺失的計數器，而非將其作為錯誤重試。或者更好的做法是：確保發送端永遠不會產生計數器間隙。

#### A.4.3 `POST /messages/send-state` — 計數器恢復

**檔案：** `data-worker/src/worker.js:2383-2415`

```javascript
const expectedCounter = lastAcceptedCounter + 1;
```

**問題 11：`send-state` 回應未經驗證**

`expectedCounter` 值以純 JSON 數字回傳。沒有 HMAC 或簽章將其綁定至對話/裝置。中間人攻擊者（即使在 CDN 層）可以回傳偽造的低 `expectedCounter`，導致客戶端：
1. 設定 `NsTotal = (偽造的低值) - 1`
2. 使用已被使用過的計數器重新加密訊息
3. 伺服器接受它（如果中間人同時阻擋了原始訊息）
4. **計數器重用**：兩段不同的明文使用不同的鏈金鑰但相同的傳輸計數器進行加密

啟用棘輪後，這更加危險，因為跨鏈紀元的計數器重用可能導致接收端嘗試使用錯誤的鏈金鑰進行解密，從而永久損壞其棘輪狀態。

**所需修正：** 使用對話的 HMAC 密鑰對 `send-state` 回應進行簽章，或完全取消計數器恢復流程，改用伺服器分配計數器的模型。

---

### A.5 第4層 — 接收管線

#### A.5.1 `getLocalProcessedCounter()` (local-counter.js)

**優先順序：**
1. Vault `header_counter`（來自 `MessageKeyVault.getLatestState()`）
2. DR 狀態 `holder.NrTotal`（來自記憶體中的 `drSessMap`）
3. 預設值：0

**問題 12：Vault `header_counter` 使用 DR 層級的計數器，而非傳輸計數器**

Vault 儲存的 `headerCounter` 來自 `vaultCounter = transportCounter`（dr-session.js:1993）。目前這等於 NsTotal。但探測/間隙系統將此作為「本地已處理計數器」，與伺服器的 `max-counter` 進行比較。

啟用棘輪後，如果 NrTotal 被損壞（問題 9），本地已處理計數器就會變得不正確。探測將會：
- 認為存在間隙但實際上沒有（不必要的擷取）
- 認為不存在間隙但實際上有（遺漏的訊息）

**所需修正：** 確保 Vault 始終儲存**傳輸層計數器**（NsTotal/NrTotal），而非 DR 層計數器（Ns/Nr）。目前的程式碼正確地執行此操作（`vaultCounter = transportCounter`），但問題 9 的 NrTotal 覆寫可能破壞此不變量。

#### A.5.2 最大計數器探測 (probe.js)

```javascript
const serverMax = await fetchMaxCounter({...});
const localMax = await getLocalProcessedCounter({...});
if (serverMax > localMax) → enqueue gap tasks
```

假設 NrTotal 被正確維護，啟用棘輪**無直接問題**。但如果發送端產生計數器間隙（問題 10），探測將會針對幽靈計數器觸發間隙填充。

---

### A.6 層 5 — 發送佇列與發送策略

#### A.6.1 發送佇列計數器排序 (outbox.js:273-280)

```javascript
function compareCounterOrder(a, b) {
  const aCounter = getJobCounter(a);
  const bCounter = getJobCounter(b);
  return aCounter - bCounter;  // sort ascending
}
```

**問題 13：CounterTooLow 替換時基於計數器的排序會出錯**

當發生 CounterTooLow 替換時，原始任務的計數器為 N，替換任務的計數器為 M（其中 M > N，可能不連續）。若兩個任務同時存在於發送佇列中（例如原始任務尚未被移除），排序雖然正確，但過時的任務會先被發送並再次失敗，造成 409 錯誤的連鎖反應。

**所需修正：** 確保在插入替換任務之前，將過時的任務從發送佇列中移除。目前 `outbox.js:960` 處的程式碼確實有檢查 CounterTooLow 錯誤，但時序取決於事件循環的排程順序。

#### A.6.2 `getJobCounter()` (outbox.js:119-127)

```javascript
function getJobCounter(job) {
  const direct = normalizeCounter(job?.counter);
  if (Number.isFinite(direct)) return direct;
  const header = typeof job?.headerJson === 'string' ? JSON.parse(job.headerJson) : job?.header;
  const headerCounter = normalizeCounter(header?.counter);
  return headerCounter;
}
```

此處使用的是傳輸計數器，這是正確的。啟用棘輪時不需要變更。

---

### A.7 層 6 — 持久化與狀態恢復

#### A.7.1 `snapshotDrState()` (dr-session.js:843-908)

快照包含：
```javascript
{
  Ns, Nr, PN,        // chain-level counters
  NsTotal, NrTotal,  // transport-level counters
  myRatchetPriv_b64, myRatchetPub_b64,  // DH keypair
  theirRatchetPub_b64,                   // peer's DH public key
  ckS_b64, ckR_b64,                     // chain keys
  rk_b64,                               // root key
  pendingSendRatchet,
  role
}
```

**問題 14：棘輪運作時的快照時序會造成腦裂**

目前的流程：
```
preSnapshot  = snapshotDrState(state)     // line 1892
pkt          = drEncryptText(state, text)  // line 1896 — MAY RATCHET
state.NsTotal = transportCounter           // line 1900 — correction
postSnapshot = snapshotDrState(state)     // line 1902
persistDrSnapshot(state)                   // line 2003
```

啟用棘輪後，`drEncryptText` 可能會觸發發送端棘輪旋轉，進而輪換 DH 金鑰對。在 `preSnapshot` 與 `persistDrSnapshot` 之間，狀態已發生根本性變化（新金鑰、重置的計數器）。若應用程式在 `drEncryptText` 之後但在 `persistDrSnapshot` 之前崩潰：
- 訊息是以新金鑰發送的
- 持久化的狀態仍是舊金鑰
- 重啟後，狀態從舊快照恢復
- 下一則訊息使用舊金鑰 → 接收方得到錯誤的 DH → 解密失敗

第 2003 行的 `persistDrSnapshot` 旨在防止此問題，但它在網路發送嘗試開始之後才執行。若崩潰發生時網路呼叫正在進行中，狀態可能尚未被持久化。

**所需修正：** 在發起網路發送之前，先持久化加密後的快照。第 1997-2002 行的註解已說明此點（「MUST persist the post-encryption snapshot to local storage BEFORE attempting the network send」），且第 2003 行確實在實際的 `atomicSend` 之前進行持久化。這是正確的但較為脆弱——持久化必須在 `atomicSend` 呼叫之前成功完成。

#### A.7.2 `copyDrState()` (dr-session.js:1310-1380)

```javascript
target.NsTotal = Number.isFinite(source.NsTotal) ? source.NsTotal : numberOrDefault(target.NsTotal, 0);
```

**無問題** — 此處正確地原樣複製 NsTotal。然而，啟用棘輪後，`ckS` 可能為 `null`（被棘輪清除）。複製函式已處理此情況：
```javascript
target.ckS = source.ckS instanceof Uint8Array ? cloneU8(source.ckS) : null;
```
這是正確的。

#### A.7.3 保險庫金鑰儲存 (message-key-vault.js)

保險庫將 `headerCounter` 與每個訊息金鑰一同儲存。這是傳輸計數器。啟用棘輪後，保險庫仍可正確運作，因為它使用的是傳輸計數器（NsTotal），而非鏈計數器（Ns）。

**不需要變更**保險庫層本身，前提是上游正確維護 NsTotal。

---

### A.8 摘要：各檔案所需變更

| 檔案 | 行號 | 所需變更 | 優先級 |
|------|---------|----------------|----------|
| `shared/crypto/dr.js` | 313-314 | 移除 `drRatchet` 中的 `NsTotal += Ns` 累加 — 讓 `drEncryptText` 擁有 NsTotal 的控制權 | **嚴重** |
| `shared/crypto/dr.js` | 323-330 | 取消註解 ckS、PN、Ns、myRatchetPriv/Pub 的更新 | **嚴重** |
| `shared/crypto/dr.js` | 665-676 | 通用化舊鏈訊息處理，超越 responder/headerN===1/Nr===0 的特殊情況 | **高** |
| `shared/crypto/dr.js` | 698-704 | 硬拒絕大於 `SKIPPED_KEYS_PER_CHAIN_MAX` 的 `pn` 間隙 | **高** |
| `dr-session.js` | 1898-1901 | 簡化修正：一律使用 `state.NsTotal = transportCounter`（移除條件判斷） | **高** |
| `dr-session.js` | 2177 | 新增 CounterTooLow 時重新加密前的 DR 狀態回滾 | **高** |
| `dr-session.js` | 2992-2993 | 媒體發送路徑的相同修正 | **高** |
| `dr-session.js` | 4525-4526 | 變更 `NrTotal = headerCounter` 為 `NrTotal = max(NrTotal, NrTotal + 1)` | **高** |
| `dr-session.js` | 355-451 | `seedTransportCounterFromServer`：在種子設定時同時重設 Ns=0、PN=0 | **中** |
| `gap-queue.js` | fetch 迴圈 | 容錯 404（跳過）而非視為可重試的錯誤 | **中** |
| `data-worker/worker.js` | send-state | 簽署 `expectedCounter` 回應或移除計數器恢復機制 | **中** |
| `outbox.js` | 960 | 確保過時的 CounterTooLow 任務在替換入列前被清除 | **低** |

---

### A.9 建議實施順序

**階段一：DR 協定修正（必須原子操作）**
1. 修正 `drRatchet()`：移除 NsTotal 累加，取消註解 ratchet 相關行
2. 修正 `drEncryptText()`：確保 NsTotal 每則訊息僅遞增 +1
3. 在 `drDecryptText()` 中新增透過 skippedKeys 查詢的舊鏈訊息救援機制
4. 硬拒絕過大的 `pn` 間隙

**階段二：傳輸層同步**
5. 簡化 `sendDrPlaintext` 和 `sendDrMedia` 中的 NsTotal 修正
6. 修正 CounterTooLow 修復機制以包含 DR 狀態回滾
7. 修正 `persistContactShareSequence` 的 NrTotal 處理
8. 修正 `seedTransportCounterFromServer` 以重設鏈層級計數器

**階段三：伺服器與管線強化**
9. 使 gap-queue 具備 404 容錯能力
10. 簽署或移除 `send-state` 計數器恢復機制
11. 新增跨 epoch 訊息傳遞的整合測試
12. 新增跨 ratchet 邊界亂序訊息傳遞的整合測試

**階段四：驗證**
13. 端對端測試：發起方發送 N 則訊息，回應方回覆，ratchet 發生，驗證所有訊息均可解密
14. 端對端測試：模擬跨 ratchet 邊界的訊息重排序
15. 端對端測試：模擬 ratchet 期間的 CounterTooLow 恢復
16. 端對端測試：模擬 ratchet 期間的應用程式崩潰/復原

---

### A.10 計數器流程圖（修正後）

```
發送端                                    接收端
──────                                    ────────

1. reserveTransportCounter()
   NsTotal = NsTotal + 1
   transportCounter = NsTotal
       │
2. drEncryptText(state, text)
   ├─ if (!ckS && theirRatchetPub):
   │    發送端 RATCHET
   │    PN = Ns
   │    Ns = 0
   │    ckS = KDF(rk, DH(newKey, theirPub))
   │    輪換 myRatchetPriv/Pub
   │    [此處不動 NsTotal]
   │
   ├─ mk = KDF(ckS)
   │  ckS = next(ckS)
   │  Ns += 1
   │  NsTotal += 1                    (*)
   │
   ├─ header = { ek_pub: myPub, pn: PN, n: Ns }
   │  ciphertext = AES-GCM(mk, plaintext, AAD(Ns))
       │
3. state.NsTotal = transportCounter   // 修正：撤銷 (*)
       │
4. POST /messages/secure
   { counter: transportCounter,               GET /messages/by-counter
     header_json, ciphertext_b64 }  ────────► { counter: N }
                                                    │
                                              5. drDecryptText(state, packet)
                                                 ├─ if (ek_pub ≠ theirRatchetPub):
                                                 │    接收端 RATCHET
                                                 │    跳過舊鏈金鑰直到 pn
                                                 │    drRatchet(state, ek_pub)
                                                 │    ckR = KDF(rk, DH(myPriv, ek_pub))
                                                 │    ckS = null  ← 下次發送時觸發發送端 ratchet
                                                 │    PN = Ns     ← 儲存供下次發送 header 使用
                                                 │    Ns = 0
                                                 │    Nr = 0
                                                 │    輪換 myRatchetPriv/Pub
                                                 │    [不動 NsTotal]
                                                 │    [不動 NrTotal — dr.js 將此交由呼叫端處理]
                                                 │
                                                 ├─ mk = KDF(ckR, 跳至 header.n)
                                                 │  Nr = header.n
                                                 │  NrTotal += 1
                                                 │
                                                 └─ plaintext = AES-GCM-decrypt(mk, ct, AAD)
                                                        │
                                              6. vault.put(headerCounter: transportCounter)
                                                 persistDrSnapshot(state)
```

---

*Appendix A 結束*

---

## Appendix B: Forward Secrecy Enablement — Complete Work Items

**Date:** 2026-02-20
**System Constraints:**
- localStorage / sessionStorage 在登入前、登出前都會被清空
- 一個帳號同時只有一個 deviceId（跨裝置登入共用同一 deviceId，會踢除舊 session）
- 所有本地端持久化資料加密存在 server-side，登入時注水還原

---

### B.1 State Lifecycle 完整鏈路（現況）

```
登入
 │
 ├─ OPAQUE auth → 取得 MK (Master Key, 用來加解密所有 server-side 備份)
 │
 ├─ Stage1: restoreContactSecrets()
 │   └─ 從 localStorage 讀取 → 因為登入前已清空，永遠是空的
 │
 ├─ Stage2: hydrateContactSecretsFromBackup()
 │   ├─ fetchContactSecretsBackup({ limit: 1 }) → server 拉取
 │   ├─ decryptContactSecretPayload(payload, MK) → 用 MK 解密
 │   └─ importContactSecretsSnapshot(snapshot) → 填入 contactSecrets Map
 │       ╰─ 每個 contact entry 包含 drState snapshot (per deviceId)
 │
 ├─ Stage3: hydrateDrStatesFromContactSecrets()
 │   ├─ 遍歷 contactSecrets Map
 │   ├─ 取出 devices[selfDeviceId].drState
 │   └─ restoreDrStateFromSnapshot() → 寫入 drSessMap (in-memory)
 │       ╰─ 還原: rk, ckS, ckR, Ns, Nr, PN, NsTotal, NrTotal,
 │                myRatchetPriv, myRatchetPub, theirRatchetPub,
 │                pendingSendRatchet
 │       ╰─ skippedKeys → 始終為空 Map（✓ 正確：單調接收架構下不需要）
 │
 ├─ Stage4: probeMaxCounter → gap detection
 │   └─ 對每個 conversation 查 server max counter vs local counter
 │
 └─ Stage5: gap-queue drain
     └─ by-counter 逐一拉取缺失訊息 → drDecryptText → vault put

使用中（每次送出訊息）
 │
 ├─ reserveTransportCounter → NsTotal + 1
 ├─ drEncryptText → 消耗 chain key, 遞增 Ns
 ├─ atomicSend { message, vault, backup }
 │   ├─ message: { counter, header_json, ciphertext_b64 }
 │   ├─ vault: { wrapped_mk, headerCounter, dr_state (encrypted) }
 │   └─ backup: contact-secrets snapshot (encrypted with MK)
 └─ *** backup 是隨每次送出訊息 piggyback 上傳的 ***

使用中（每次收到訊息）— 單調接收架構
 │
 ├─ 以 localMax + 1 開始，逐一 fetch by counter（嚴格遞增）
 │   ╰─ coordinator.js [STRICT SEQUENTIAL] 保證 live 訊息也補齊 gap
 ├─ drDecryptText → 可能觸發 ratchet
 │   ╰─ 因為單調處理，Nr 始終 = pn → 不產生 skippedKeys（見 Appendix C）
 ├─ vault put (message key) → 存入 server, 附帶 drStateSnapshot
 └─ persistDrSnapshot → 寫入 localStorage (下次登出前會被清空)
     ╰─ 也寫入 contactSecrets Map (in-memory)
     ╰─ *** 不會觸發 remote backup ***

登出
 │
 ├─ flushDrSnapshotsBeforeLogout → persistDrSnapshot (寫到 localStorage)
 ├─ persistContactSecrets → 寫到 localStorage
 ├─ lockContactSecrets → 清除 in-memory Map
 ├─ *** 不推 remote backup (設計意圖: vault 已保存 keys) ***
 └─ localStorage 清空
```

**核心發現：**
1. Server-side DR state 的最新版本依賴：送出時 backup、收到時 vault put、登出時不推 backup
2. **接收端是單調架構**：由 gap-queue 和 coordinator 的 [STRICT SEQUENTIAL] 保證，接收端始終以 DR counter 遞增順序處理訊息 → skippedKeys 永遠為空（詳見 Appendix C）

---

### B.2 單 deviceId 約束下的簡化

因為系統限制一個帳號同時只有一個 deviceId：

**可以忽略的問題：**
- 多 device 同時 ratchet 的 race condition
- 跨 device counter 碰撞
- snapshot 的 selfDeviceId 匹配拒絕（只有一個 device）

**仍然存在的問題：**
- 舊 session 被踢除時，如果正在 ratchet 中途（DH 已旋轉但 snapshot 未 persist），server-side 的 snapshot 是過期的。但 drRatchet 的 ckR 推導是確定性的（同一 myPriv × theirPub = 同一 ckR），所以下次登入可以從 gap messages 重新推導（效能損失但不影響正確性）
- 新裝置登入後注水還原的 state 可能與 server 上已送出/收到的訊息不一致（透過 seedTransportCounterFromServer + pendingSendRatchet 自癒）

---

### B.3 完整工作細項列表

#### Phase 0: 前置準備（無功能變更，純重構）

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 0.1 | **將 NsTotal 的管理權統一到 drEncryptText** | `dr.js:309-314` | 移除 `drRatchet` 中 `NsTotal += Ns` 的累加邏輯。NsTotal 由 `drEncryptText:389` 單獨遞增，由 `dr-session.js` 的 `reserveTransportCounter` 和修正邏輯管控。drRatchet 只負責 chain-level state。 |
| 0.2 | **將 NrTotal 的管理權統一到呼叫端** | `dr.js:313-314` | 同上，移除 `drRatchet` 中 `NrTotal += Nr` 的累加。NrTotal 由 `drDecryptText:816` 遞增，或由 `dr-session.js:4525` 在 persistContactShareSequence 中更新。 |
| 0.3 | **簡化 NsTotal 修正邏輯** | `dr-session.js:1898-1901, 2198-2200, 2992-2993` | 將三處條件式修正改為無條件 `state.NsTotal = transportCounter`。消除 drEncryptText 內部遞增和外部 reserve 之間的語義衝突。 |
| 0.4 | **修正 persistContactShareSequence 的 NrTotal 語義** | `dr-session.js:4525-4526` | 改為 `NrTotal = Math.max(NrTotal, NrTotal + 1)`（單調遞增）。不能直接 `= headerCounter`，因為啟用 ratchet 後 header.n 會歸零。 |
| 0.5 | **為所有 Phase 0 變更新增單元測試** | `tests/` | 驗證 counter 語義在現有（ratchet 禁用）行為下不變。 |

#### Phase 1: DR 協定層啟用（核心密碼學變更）

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 1.1 | **啟用 drRatchet 的 sending-side 更新** | `dr.js:323-330` | 取消註解 `ckS = null`, `PN = st.Ns`, `Ns = 0`, `myRatchetPriv/Pub = myNew`。這是前向保密的核心開關。 |
| ~~1.2~~ | ~~**在 drDecryptText 中加入舊鏈訊息解密支援**~~ | | ~~移除：單調接收架構下不需要（見 Appendix C.4）~~ |
| 1.3 | **硬拒絕過大的 pn gap** | `dr.js:698-704` | 將 warn 改為 throw：`if (gap > SKIPPED_KEYS_PER_CHAIN_MAX) throw new Error('pn gap exceeds limit')`。防止 DoS。 |
| 1.4 | **AAD 必須強制存在** | `dr.js:399-401` | 移除 fallback：`if (!aad) throw new Error('AAD construction failed')`。 |
| 1.5 | **drDecryptText 中 ratchet 後正確維護 working.ckS** | `dr.js:717-722` | `drRatchet` 啟用後會設 `ckS = null`，確保 `working` copy 正確反映此狀態，且 commit 回 `st` 時不遺漏。（目前 line 882-894 已完整 copy working→st，但需驗證 ckS=null 的傳播。） |
| 1.6 | **為 Phase 1 撰寫端對端密碼學測試** | `tests/` | 測試案例：(a) 基本 ratchet 旋轉 (b) 多次連續 ratchet (c) pn gap 拒絕 (d) AAD 強制 (e) 單調接收下 skippedKeys 為空的驗證。 |
| 1.7 | **pn 一致性斷言** | `dr.js:697-698` | 在 ratchet 路徑中加入 `if (pn !== working.Nr) console.error('[dr] CONSISTENCY VIOLATION')`。單調架構下 pn 必定等於 Nr，不一致代表有 bug（見 Appendix C.5）。 |

#### ~~Phase 2: Snapshot 序列化擴展（持久化層）~~ — 已移除

> **移除原因：** 單調接收架構下 skippedKeys 永遠為空，不需要序列化。
> Snapshot 格式維持 v1 不變。詳見 Appendix C.3-C.4。
>
> 原 6 項工作（2.1-2.6）全部移除。

#### Phase 3: Transport 層同步（counter-based API 適配）

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 3.1 | **CounterTooLow 修復加入 DR state rollback** | `dr-session.js:2164-2260` | 在 re-encrypt 之前，先用 `preSnapshot` 回滾 DR state（`restoreDrStateFromSnapshot(preSnapshot, { force: true })`）。防止第一次加密浪費的 chain key 造成 sender/receiver chain 不同步。 |
| 3.2 | **同上修正 media send 路徑** | `dr-session.js:3226-3260` | Media send 有獨立的 CounterTooLow 修復路徑，需要同樣的 rollback 邏輯。 |
| 3.3 | **seedTransportCounterFromServer 加入 chain-level counter 重設** | `dr-session.js:424` | 當 NsTotal 從 server seed 時，同步設 `state.Ns = 0` 和 `state.PN = 0`。因為 snapshot restore 後 chain epoch 狀態未知，使用保守值（0）讓下次 encrypt 時觸發 ratchet。 |
| 3.4 | **gap-queue 404 容錯** | `messages-flow/gap-queue.js` | 收到 404 回應時，記錄為 `counter_not_found` 而非 retry。跳過該 counter 繼續處理下一個。（sender 的 counter 跳躍是合法的，例如 CounterTooLow 修復跳過了一個值。） |

#### Phase 4: 注水還原流程強化

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 4.1 | **Stage3 注水後立即觸發 remote backup** | `restore-coordinator.js:354-394` | `hydrateDrStatesFromContactSecrets` 完成後，立即呼叫 `triggerContactSecretsBackup('post-hydrate')`。確保剛注水的 state 立即同步回 server。否則如果注水後只收訊息（不送訊息），DR state 的 server-side 備份只有 vault put 附帶的 snapshot——如果 vault put 失敗，state 就丟失。 |
| 4.2 | **Stage3 注水時設定 pendingSendRatchet = true** | `dr-session.js:1084` | 注水還原後，因為 skippedKeys 可能不完整（v1 snapshot 或 truncated），設定 `pendingSendRatchet = true` 強制下次送出時 ratchet。這確保即使舊 chain key 遺失，新的 ratchet 會建立全新的 chain。 |
| 4.3 | **登出前強制推 remote backup** | `app-mobile.js:493-501` | 取消目前的「不推 remote backup」設計。呼叫 `triggerContactSecretsBackup('secure-logout', { force: true })`。理由：啟用 ratchet 後，DR state 包含旋轉中的 DH 金鑰和 chain keys，這些不在 vault 中。如果登出時不推 backup，下次登入後 vault 裡的 drStateSnapshot 可能是數個 ratchet epoch 之前的版本。 |
| 4.4 | **force-logout (踢除) 時的 state 保護** | `ws-integration.js:481` | 收到 `force-logout` WebSocket 事件時，在斷開連線前嘗試 `triggerContactSecretsBackup('force-logout', { force: true, keepalive: true })`。使用 `keepalive: true` 確保 fetch 在頁面卸載時仍能完成（navigator.sendBeacon fallback）。 |
| 4.5 | **被踢除後的 stale state 偵測** | `restore-coordinator.js` | Stage3 注水時，比對 vault 最新 drStateSnapshot 的 `updatedAt` 和 backup 的 `updatedAt`。如果 vault 更新，用 vault 的 snapshot 覆蓋 backup 的（vault 是 per-message 更新的，比 backup 更即時）。 |

#### Phase 5: 邊界條件和錯誤處理

| # | 工作項目 | 檔案 | 說明 |
|---|---------|------|------|
| 5.1 | **Ratchet 中途被踢除的恢復邏輯** | `dr-session.js` | 場景：drDecryptText 觸發了 ratchet（DH 旋轉、ckS=null），但 vault put 和 persist 還沒執行就被 force-logout 踢除。下次登入：(a) server 上的 snapshot 是 ratchet 前的版本 (b) 但 server 上已有對方用新 chain 加密的訊息。解法：gap-queue 拉取訊息 → drDecryptText 再次 ratchet（因為 ek_pub_b64 與 state 不同）→ drRatchet 的 ckR 推導是確定性的：`scalarMult(myPriv, theirPub)` → 因為 myPriv 未旋轉（snapshot 是 ratchet 前的），結果與第一次 ratchet 相同。✓ 而新的 myRatchetPub 是隨機生成但只用於後續送出（此時已重新 persist），所以不影響解密。 |
| 5.2 | **送出訊息在 ratchet 後 crash 的恢復** | `dr-session.js` | 場景：drEncryptText 觸發 send-side ratchet → atomicSend → server 接受 → 但 app crash 在 persist 之前。下次登入：NsTotal 在 server 上已遞增，但 client 的 snapshot 是 ratchet 前的。解法：`seedTransportCounterFromServer` (Phase 3.3) 會修正 NsTotal。但 DH 金鑰也需要旋轉——這次 ratchet 使用的 myNew keypair 已經丟失。必須生成新的 keypair 並重新 ratchet。解法是 Phase 4.2 的 `pendingSendRatchet = true`。 |
| ~~5.3~~ | ~~**Vault put 失敗後 skippedKeys 的自癒**~~ | | ~~移除：單調接收架構下 skippedKeys 為空（見 Appendix C.4）~~ |
| 5.4 | **send-state API 回應增加完整性驗證** | `data-worker/worker.js:2408-2414, dr-session.js:2177` | 為 `send-state` 回應加入 HMAC 簽章（使用 DATA_API_HMAC），client 端驗證後才接受 expectedCounter。防止 MITM 注入假值導致 counter 回退。 |
| ~~5.5~~ | ~~**Snapshot payload size 監控**~~ | | ~~移除：不新增 skippedKeys 後 snapshot 大小不變（見 Appendix C.4）~~ |

#### Phase 6: 整合測試

| # | 工作項目 | 說明 |
|---|---------|------|
| 6.1 | **E2E: 基本 ratchet 旋轉** | Alice→Bob 5 則 → Bob→Alice 3 則 → Alice→Bob 2 則。驗證所有訊息解密成功，ek_pub_b64 在每個方向切換時變化。 |
| 6.2 | **E2E: 單調接收下 skippedKeys 為空** | Alice→Bob 5 則（含 ratchet 邊界）。驗證 Bob 的 `onSkippedKeys` callback 從未被觸發（skippedKeysBuffer 始終為空）。同時驗證 pn 一致性斷言（Phase 1.7）不觸發。 |
| 6.3 | **E2E: 登出→登入→還原** | Alice→Bob 5 則 → Bob 登出 → Bob 登入 → 驗證 DR state 正確還原 → Bob 可以繼續對話（送出和接收）。 |
| 6.4 | **E2E: 被踢除→新裝置登入** | Alice→Bob 5 則 → Bob 被 force-logout → Bob 在新裝置登入（同 deviceId）→ 還原 → Alice→Bob 再送 3 則 → 驗證 Bob 能解密後 3 則（drRatchet 確定性再推導）。 |
| 6.5 | **E2E: CounterTooLow 修復後 ratchet 正確性** | 模擬 409 → DR state rollback → repair → 驗證 sender 和 receiver 的 chain state 一致，且無 skippedKeys 產生。 |
| 6.6 | **E2E: gap-queue 404 容錯** | 製造一個 counter gap（跳過 counter 5）→ gap-queue 應跳過 5，成功處理 4 和 6。 |
| ~~6.7~~ | ~~**E2E: Snapshot v1→v2 遷移**~~ | ~~移除：不需要 v2 格式（見 Appendix C.4）~~ |

---

### B.4 工作項目依賴關係

```
Phase 0 (前置重構)
  ├─ 0.1, 0.2, 0.3, 0.4 可並行
  └─ 0.5 等 0.1-0.4 完成

Phase 1 (DR 協定) ← 依賴 Phase 0
  ├─ 1.1 是核心開關，1.3-1.5, 1.7 與 1.1 配合
  └─ 1.6 等 1.1-1.5, 1.7 完成
  ╰─ (1.2 已移除 — 單調接收不需要)

Phase 2 — 已整體移除（單調接收架構下 skippedKeys 為空）

Phase 3 (Transport) ← 依賴 Phase 0
  ├─ 3.1, 3.2 可並行（★ 3.1 提升為 MVP 必要項）
  ├─ 3.3 獨立
  └─ 3.4 獨立

Phase 4 (注水還原) ← 依賴 Phase 0
  ├─ 4.1, 4.2 可並行
  ├─ 4.3, 4.4 可並行（降級為「建議但非 MVP 必須」）
  └─ 4.5 依賴 4.3

Phase 5 (邊界條件) ← 依賴 Phase 1
  ├─ 5.1, 5.2 依賴 Phase 1
  └─ 5.4 獨立
  ╰─ (5.3, 5.5 已移除)

Phase 6 (整合測試) ← 依賴所有 Phase
```

---

### B.5 風險矩陣（修訂版 — 反映單調接收架構）

| 風險 | 發生條件 | 後果 | 緩解措施 |
|------|---------|------|---------|
| Ratchet 中途被踢除 | force-logout + 未完成 persist | 下次登入 state 過期，需重新 ratchet（效能損失但不影響正確性） | Phase 4.4 (force-logout backup) + Phase 5.1 (drRatchet ckR 推導確定性) |
| ~~skippedKeys 丟失~~ | ~~vault put 失敗~~ | ~~不適用~~ | ~~單調接收架構下 skippedKeys 永遠為空（見 Appendix C.3）~~ |
| NsTotal 與 server counter 不同步 | drRatchet 累加 + 修正邏輯失效 | 409 CounterTooLow 循環 | Phase 0.1-0.3 (統一 NsTotal 管理權) |
| CounterTooLow 幻影 chain key | 409 repair 未 rollback DR state | 接收端出現 within-chain skippedKeys（違反單調架構不變量） | Phase 3.1 (DR state rollback before re-encrypt) — **MVP 必要項** |
| ~~Snapshot payload 過大~~ | ~~大量 skippedKeys~~ | ~~不適用~~ | ~~移除 skippedKeys 序列化後不存在此風險~~ |
| send-state MITM | 攻擊者注入假 expectedCounter | counter 回退 → 密文覆蓋 | Phase 5.4 (HMAC 簽章) |
| DH key rotation 後 crash | drEncryptText ratchet + atomicSend OK + persist fail | 下次登入 DH keypair 不一致 | Phase 3.3 (seed NsTotal) + Phase 4.2 (pendingSendRatchet) |

---

### B.6 最小可行變更集（MVP）— 修訂版

> **修訂依據：** 單調接收架構確認後，skippedKeys 相關工作項目移除，CounterTooLow DR state rollback 提升為必要項。詳見 Appendix C.6。

如果要以最小風險、最少程式碼啟用前向保密，最小變更集是：

| # | 工作項目 | 必要性 |
|---|---------|--------|
| 1 | **Phase 0.1-0.2** — NsTotal/NrTotal 管理權統一 | 必須：消除 ratchet 啟用後的 counter 雙重計算 |
| 2 | **Phase 0.3** — NsTotal 修正邏輯簡化 | 必須：消除語義衝突 |
| 3 | **Phase 0.4** — NrTotal 單調遞增 | 必須：防止 ratchet 後 header.n 歸零導致 NrTotal 倒退 |
| 4 | **Phase 1.1** — 啟用 drRatchet sending-side | 必須：前向保密核心開關 |
| 5 | **Phase 1.3** — 硬拒絕過大 pn gap | 必須：DoS 防護 |
| 6 | **Phase 3.1** — CounterTooLow DR state rollback | 必須：消除唯一可能的 skippedKeys 來源 |

共 **6 個工作項目**，涉及 **2 個檔案**（`dr.js`, `dr-session.js`）。

**與原 MVP 差異：**
- ~~Phase 2.1-2.2（skippedKeys 序列化）~~ — 移除：單調接收下不需要
- ~~Phase 4.3（登出前推 backup）~~ — 從 MVP 降級為「建議但非必須」。理由：即使登出後 state 過期，drRatchet 的 ckR 推導是確定性的（同一 myPriv × theirPub），下次登入透過 gap-queue 重新推導即可。效能損失但不影響正確性。
- **Phase 3.1 新增** — 從「Phase 3 加固」提升為 MVP 必要項。理由：這是消除 CounterTooLow 幻影 chain key 的關鍵，確保單調接收架構的不變量成立。

其餘 Phase 是「建議分批實施」的加固措施。

---

*End of Appendix B*

## Appendix C: 單調接收架構（Monotonic Receiver Architecture）— 對前向保密工作項目的簡化

**Date:** 2026-02-20
**依據：** 系統設計者確認：

> 發送端會先寫入加密訊息在伺服器端，且是 counter 單調推進的原子性發送。
> WS 只是通知接收端進行解密。雖然 WS 可能會因為網路因素導致接收端亂序跳號，
> 但接收端還是會以它自己實際的 DR counter 抓取伺服器儲存的未解密加密訊息單調推進再 vaultPut，
> 而不是直接進行推進並儲存 skipped keys。

---

### C.1 架構模型

```
Sender                         Server                        Receiver
  │                              │                              │
  ├─ drEncryptText (chain key #N)│                              │
  ├─ atomicSend(counter=T) ─────►│ store(counter=T, n=N)        │
  │                              │                              │
  ├─ drEncryptText (chain key #N+1)                             │
  ├─ atomicSend(counter=T+1) ───►│ store(counter=T+1, n=N+1)   │
  │                              │                              │
  │                              │◄── WS notify ───────────────►│ (可能亂序)
  │                              │                              │
  │                              │  ┌─ Receiver 不依賴 WS 順序 ─┐
  │                              │  │  以 localMax + 1 開始     │
  │                              │  │  逐一 fetch by counter    │
  │                              │  │  monotonic: T → T+1 → …  │
  │                              │  └──────────────────────────┘
  │                              │                              │
  │                              │◄── GET /by-counter?c=T ──────┤
  │                              ├── response(n=N) ────────────►│ drDecryptText
  │                              │                              │ Nr: 0→1 (=N)
  │                              │◄── GET /by-counter?c=T+1 ────┤
  │                              ├── response(n=N+1) ──────────►│ drDecryptText
  │                              │                              │ Nr: 1→2 (=N+1)
```

**關鍵不變量（Invariant）：** 接收端的 DR chain counter `Nr` 始終等於下一個待處理的 header counter `n - 1`。

---

### C.2 程式碼驗證

三處程式碼共同保證了單調接收：

#### 1. gap-queue.js:296-320 — Gap 填充嚴格遞增
```javascript
// 從 startCounter 到 targetCounter 逐一遞增處理
for (let counter = startCounter; counter <= targetCounter; counter += 1) {
    const result = await fetchWithRetry(conversationId, counter, ...);
    if (!result.ok) { failed = true; break; }
    // commitBRouteCounter → drDecryptText
    cursor = counter;
}
```

#### 2. coordinator.js:293-365 — Live 訊息前置 gap 填充
```javascript
// [STRICT SEQUENTIAL] Blocking Gap Fill
if (counter > localMax + 1) {
    // 先補齊 localMax+1 到 counter-1 的所有訊息
    for (let c = start; c <= end; c++) {
        const fetchRes = await depsGetMsgByCounter({ conversationId, counter: c });
        await stateAccess.commitIncomingSingle({ ..., counter: c });
    }
}
// 然後才處理當前 live 訊息
await stateAccess.commitIncomingSingle({ ..., counter });
```

#### 3. dr.js — 接收端 DR counter 推進
```javascript
// 解密後 Nr 遞增 (line 812)
working.Nr += 1;
// 且確保不低於 headerN (line 813-814)
if (headerN > working.Nr) working.Nr = headerN;
// NrTotal 也遞增 (line 816)
working.NrTotal = Number.isFinite(working.NrTotal) ? working.NrTotal + 1 : working.Nr;
```

---

### C.3 skippedKeys 在單調架構下的分析

DR 協定中有兩處產生 skippedKeys：

#### 場景 A: 跨 ratchet 舊鏈補 key（dr.js:698-716）

```javascript
// Ratchet 偵測: ek_pub_b64 與 state 不一致
if (prevChainId && working.ckR && pn > working.Nr) {
    // 補齊 Nr → pn 的 key
    while (nr < pn) { ... newSkippedKeys.push(...) }
}
```

**單調架構下：** 發送端在 ratchet 時設 `PN = Ns`（告訴接收端「我在舊鏈送了 Ns 則」）。接收端因為單調處理，在遇到 ratchet 訊息前已經處理完舊鏈所有訊息，所以 `Nr === PN`。條件 `pn > working.Nr` 永遠為 `false`。

**結論：** 跨 ratchet skippedKeys 永遠為空。

#### 場景 B: 同鏈內跳號（dr.js:758-765）

```javascript
// 如果 header.n 大於 Nr+1，補齊中間的 key
while (working.Nr + 1 < headerN) {
    ... newSkippedKeys.push(...)
}
```

**單調架構下：** 接收端逐一處理每個 transport counter，對應的 header.n 也是逐一遞增的。`Nr + 1 === headerN` 始終成立。

**唯一例外：CounterTooLow 修復幻影（Phantom）**

```
發送端:
  drEncryptText → chain key #N, Ns=N, header.n=N  (消耗一個 chain key)
  atomicSend(counter=T) → 409 CounterTooLow
  NsTotal = expectedCounter - 1  (修正 transport counter)
  drEncryptText → chain key #N+1, Ns=N+1, header.n=N+1  (再消耗一個)
  atomicSend(counter=expectedCounter) → 200 OK

接收端:
  fetch counter=expectedCounter → header.n=N+1
  但 Nr=N-1（上一次處理的是 n=N-1）
  while(Nr+1 < N+1) → true → 產生一個 skippedKey for n=N（幻影）
```

**解法：Phase 3.1（CounterTooLow DR state rollback）消除此幻影。** 回滾 DR state 後重新加密，header.n 不會跳號。

**結論：** 實施 Phase 3.1 後，同鏈內 skippedKeys 也永遠為空。

---

### C.4 對 Appendix B 工作項目的影響

以下工作項目因單調接收架構而可以 **移除或大幅簡化**：

| 原工作項目 | 原因 | 處置 |
|-----------|------|------|
| **Phase 1.2** — 舊鏈訊息解密支援 | 接收端不會遇到跨 ratchet 亂序訊息 | **移除** |
| **Phase 2（全部 6 項）** — skippedKeys 序列化 | skippedKeys 永遠為空，無需序列化 | **移除整個 Phase** |
| **Phase 5.3** — Vault put 失敗後 skippedKeys 自癒 | skippedKeys 不存在 | **移除** |
| **Phase 5.5** — Snapshot payload size 監控 | 移除 skippedKeys 後 snapshot 大小不變 | **移除** |
| **Phase 6.2** — 亂序跨 ratchet 測試 | 改為驗證「不產生 skippedKeys」的正確性測試 | **改寫** |
| **Phase 6.7** — Snapshot v1→v2 遷移 | 不需要 v2 格式 | **移除** |
| **B.5 風險矩陣** — skippedKeys 丟失風險 | 風險不存在 | **移除** |
| **B.5 風險矩陣** — Snapshot payload 過大 | 風險不存在 | **移除** |
| **B.5 風險矩陣** — V1→V2 遷移風險 | 不需要遷移 | **移除** |

以下工作項目 **保持不變但理由更清晰**：

| 工作項目 | 補充說明 |
|---------|---------|
| **Phase 3.1** — CounterTooLow DR state rollback | 重要性提升：這是消除「唯一可能產生 skippedKeys 的場景」的關鍵修復 |
| **Phase 4.3** — 登出前推 backup | 仍然需要：防止 DH key rotation 後 state 遺失（避免重新處理 gap messages） |
| **Phase 5.1** — Ratchet 中途被踢除 | 仍然需要分析，但風險降低：drRatchet 的 ckR 推導是確定性的（同一 myPriv × theirPub = 同一 ckR） |

---

### C.5 pn 欄位的新語義：一致性檢查

在單調接收架構下，`pn` 欄位（header 中的 previous chain length）從「告訴接收端補多少 skipped keys」變為「一致性檢查值」：

```javascript
// 啟用 ratchet 後，在 drDecryptText 中加入斷言：
if (ratchetPerformed && Number.isFinite(pn) && pn !== preRatchetNr) {
    console.error('[dr] CONSISTENCY VIOLATION: pn !== Nr at ratchet', {
        pn, nr: preRatchetNr, headerN, conversationIdPrefix8
    });
    // 根據嚴格程度，可以 throw 或 warn
}
```

如果 `pn !== Nr`，代表接收端漏處理了舊鏈上的某些訊息，這在單調架構下不應該發生，表示有 bug。

---

### C.6 修訂後的最小可行變更集（Revised MVP）

移除 skippedKeys 相關項目後，MVP 從 **8 項** 縮減為 **6 項**：

| # | 工作項目 | 檔案 | 必要性 |
|---|---------|------|--------|
| 1 | Phase 0.1-0.2 — NsTotal/NrTotal 管理權統一 | `dr.js:309-314` | 必須：消除 ratchet 啟用後的 counter 雙重計算 |
| 2 | Phase 0.3 — NsTotal 修正邏輯簡化 | `dr-session.js:1898,2198,2992` | 必須：消除語義衝突 |
| 3 | Phase 0.4 — NrTotal 單調遞增 | `dr-session.js:4525` | 必須：防止 ratchet 後 header.n 歸零導致 NrTotal 倒退 |
| 4 | Phase 1.1 — 啟用 drRatchet sending-side | `dr.js:323-330` | 必須：前向保密核心開關 |
| 5 | Phase 1.3 — 硬拒絕過大 pn gap | `dr.js:698-704` | 必須：DoS 防護 |
| 6 | Phase 3.1 — CounterTooLow DR state rollback | `dr-session.js:2164-2260` | 必須：消除唯一可能的 skippedKeys 來源 |

共 **6 項**，涉及 **2 個檔案**（`dr.js`, `dr-session.js`）。

**與原 MVP 差異：**
- 移除 Phase 2.1-2.2（skippedKeys 序列化）— 不需要
- 移除 Phase 4.3（登出前推 backup）— 從 MVP 降級為「建議但非必須」。理由：即使登出後 state 過期，drRatchet 的 ckR 推導是確定性的（同一 myPriv × theirPub），下次登入可以從 gap messages 重新推導。效能損失（重新處理 gap）但不影響正確性。
- 新增 Phase 3.1 — 從「Phase 3 加固」提升為 MVP 必要項。理由：這是消除幻影 skippedKeys 的關鍵。

---

### C.7 注意事項

1. **skippedKeys 程式碼不需要刪除**：`drDecryptText` 中的 skippedKeys 推導邏輯（dr.js:698-716, 758-765）應該保留作為防禦性程式碼。如果因為 bug 導致接收端不是嚴格單調的，skippedKeys 機制可以作為 safety net。但不需要投入工程資源去序列化和持久化它們。

2. **pn 一致性檢查應加入 Phase 1**：在 Phase 1 增加一項工作（1.7）：在 drDecryptText 的 ratchet 路徑中加入 `pn === Nr` 斷言。這是低成本的正確性保證。

3. **CounterTooLow 修復的 media 路徑**：Phase 3.2（media send）也需要同樣的 DR state rollback。此項從「加固」提升為 MVP 考量。

---

*End of Appendix C*

---

*End of Security Audit Report*
