# Encrypted Voice / Video Call — 端對端加密媒體設計

> 對應 README「Encrypted Voice / Video Call Roadmap」第三項。本文件敘述語音/視訊通話的金鑰衍生、媒體加密機制、輪換與銷毀流程，並確保 Web（PWA）與未來 iOS App 共用同一套協議。

## 1. 設計原則

1. **沿用既有身份與密鑰體系**：以 X3DH / Double Ratchet 為基礎，避免額外註冊流程。
2. **支援 WebRTC E2EE**：優先採用 Insertable Streams（SFrame 兼容），必要時 fallback 至 SRTP + DTLS-SRTP。
3. **金鑰生命週期清楚**：Call master key 僅在通話期間存在，掛斷後立即銷毀。
4. **平台一致**：所有金鑰 payload 以 CBOR/JSON 描述，JS 與 Swift 可直接解析。

## 2. Key Ladder

```
X3DH session secrets (per contact)
    ↓ HKDF (context = "call-master-key" + callId + timestamp)
Call Master Key (CMK) — 64 bytes
    ↓ HKDF (context = "call-audio-tx" / "call-audio-rx" / "call-video-*")
Per-direction SRTP Keys (audioTx, audioRx, videoTx, videoRx)
```

- **CMK 派生**：由發起方計算並以 `callKeyEnvelope` 傳給對方（Double Ratchet secure message）。
- **方向性**：每個方向獨立 key/nonce，防止重放。
- **視訊共用**：若視訊未啟用，仍預留 `video*` key slot 供後續 upgrade。

## 3. Call Key Envelope

```jsonc
{
  "type": "call-key-envelope",
  "callId": "uuid",
  "epoch": 1,
  "cmkSalt": "base64",        // random 32 bytes
  "cmkProof": "base64",       // HMAC of callId + epoch with CMK
  "media": {
    "audio": { "enabled": true, "codec": "opus" },
    "video": { "enabled": false }
  }
}
```

- 透過既有 `friends/message` Secure 通道送達。
- 收到後以同樣 HKDF 流程得出 CMK，驗證 `cmkProof`。
- `epoch` 用於後續輪換（每 10 分鐘或切換模式時）。

## 4. WebRTC Insertable Streams

- **Web**：使用 `RTCRtpSender/Receiver.createEncodedStreams()`，將每個 RTP frame 在送出前使用 AES-GCM 128 以 per-direction key 加密。
- **iOS**：採用 WebRTC Native API + SFrame（或自訂 SRTP transform）；需映射相同 key/nonce 結構。
- **Nonce 計算**：`nonce = HKDF(CMK, "nonce-" + direction) + frameCounter (64-bit)`；frameCounter 每路各自遞增。
- **Fallback**：若客戶端不支援 insertable streams，回報 capability false，伺服器可拒絕或改用 DTLS-SRTP（但仍保護 DTLS 私鑰）。

## 5. 金鑰輪換與升級

- **觸發條件**：
  - 通話時長達 10 分鐘（可調）
  - 切換視訊/螢幕分享
  - 懷疑密鑰洩漏或遭到 downgrade
- **流程**：
  1. Initiator 產生新 `cmkSalt` 與 `epoch+1`。
  2. 透過 `call-media-update` 事件通知對方，並附 `call-key-envelope`。
  3. 雙方完成派生後切換到新 key，沿用 `switchAtFrame` 以避免亂序。
- **掛斷**：雙方在 `call-end` 後即刻：
  - 清除 CMK、派生 key、frame counter。
  - 釋放 Insertable Stream transformer / SRTP session。
  - 於記憶體填零（TypedArray.fill(0) / SecZeroMemory）。

## 6. 錄音/錄影防護

雖無法阻止裝置層錄音，但可：

- App 層禁止螢幕截圖（iOS `isScreenCaptured` 探測）。
- 通知對方當偵測到螢幕投影 / mirror（CallKit / ReplayKit callback）。
- 建議 UI 顯示「裝置正在錄影」提示。

## 7. API / 結構摘要

| 名稱 | 用途 |
| ---- | ---- |
| `CallKeyEnvelope` | 傳遞 CMK salt/proof 與媒體設定。 |
| `CallMediaCapability` | Client capabilities，供 capability negotiation。 |
| `CallMediaState` | 目前 key epoch、媒體狀態、下一次輪換時間。 |

上述結構放入 `web/src/shared/calls/schemas.js`（待建立），並同步 Swift 版 `CallSchema.swift`。

## 8. 實作待辦

1. 建立共用 schema / 型別檔案（TS + Swift）。
2. PWA 端導入 Insertable Streams pipeline + key 管理器。
3. iOS 端整合 WebRTC Native + SFrame，並提供與 JS 相同 API。
4. 「call-media-update」事件需更新 key epoch 並觸發 UI 提示。
5. 監控：記錄 key 派生 / 輪換事件與錯誤率。

---

**狀態**：設計完成。後續實作可直接遵循本文件與 `callKeyEnvelope` schema。
