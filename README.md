# 安全通訊服務 (Secure Chat Service)

## 系統架構總覽 (System Architecture Overview)

本文檔詳細說明 **端對端加密 (E2EE)** 訊息服務的架構，特別著重於對話工作階段管理 (Session Management)、狀態恢復 (State Restoration) 以及雙棘輪協定 (Double Ratchet, DR) 的整合機制。

### 核心設計原則
1.  **嚴格禁止非必要棘輪 (Strict No-Ratchet Policy)**：僅在初始握手或建立新工作階段時執行 Ratchet。一般的連續訊息處理應依賴 Chain Derivation (鏈推導)。
2.  **無狀態/臨時客戶端 (Stateless/Ephemeral Client)**：
    *   **登出即清除 (Logout = Wipe)**：使用者登出時，本地的所有資料 (IndexedDB/LocalStorage) 都會被清除。
    *   **冷啟動恢復 (Cold Restore)**：每次登入都被視為一次從伺服器狀態進行的全新還原。
3.  **單一裝置身分 (Single Device Identity)**：帳號與固定的 `deviceId` 綁定。
4.  **無降級回退 (No Fallback)**：若解密失敗，系統 **絕不** 回退至明文。

---

### Double Ratchet 狀態恢復機制 (DR State Restoration)

本系統採用 **"Logout = Wipe"** 策略，意味著登出即清除所有本地密鑰。
登入後的狀態恢復依賴以下三層機制：

#### 1. Hydration (基準恢復) - `batch-checkpoint`
*   **來源**：Server `contact_secret_backups` 表。
*   **性質**：**非即時 (Batched)**。
*   **行為**：前端定期 (e.g., 每發送 N 則) 或在特定事件下觸發備份。
*   **限制**：當用戶登入時，此備份可能落後於真實狀態 (Stale State)。
*   **代碼參考**：`contact-backup.js` -> `hydrateContactSecretsFromBackup()`

#### 2. Route A (自我修復 / Replay Healing) - `state-restore`
*   **來源**：Message Vault (Encrypted Headers + Piggybacked Snapshots)。
*   **性質**：**即時真實來源 (Source of Truth)**。
*   **行為**：
    *   **不執行 KDF 計算**：Route A 不負責計算下一個 Ratchet Step。
    *   **狀態跳躍 (State Jump)**：它從歷史訊息的 Header 中解出 `drStateSnapshot`，將本地狀態直接 **「恢復/跳躍」** 到該訊息當下的狀態。
*   **關鍵性**：在 Wipe 後的場景，這是唯一能將狀態從「舊的 Backup」拉回到「最新狀態」的機制。若未完成此步驟即發送訊息，將導致 **Chain Fork**。
*   **代碼參考**：`vault-replay.js` -> `importContactSecretsSnapshot(..., { replace: true })`

#### 3. Route B (即時推進 / Live Advance) - `state-advance`
*   **來源**：即時收到的 WebSocket / Push 訊息。
*   **性質**：**動態推進**。
*   **行為**：執行 Double Ratchet 演算法 (KDF)，計算出新的 Message Key 與 Chain Key，並推進 Ratchet。
*   **限制**：僅適用於在線 (Online) 期間收到的訊息。對於離線期間 (或 Wipe 後) 遺失的狀態，必須依賴 Route A 補齊。

---

### 原子性夾帶 (Atomic Piggyback)

為了確保 Route A 的有效性，我們實作了「原子性夾帶」：
*   **定義**：每一次 `vaultPut` (儲存訊息) 時，除了儲存 Message Key 之外，還 **加密夾帶 (Piggyback)** 了當前的 DR State Snapshot。
*   **目的**：保證「擁有此訊息的人，必定能還原發送此訊息當下的狀態」。這是實現 Stateless Client 的基石。

---

### 安全性不變量 (Security Invariants)

> [!IMPORTANT]
> **Healing-before-Sending (先修復，後發送)**
> 
> 系統強制規定：在 **Route A (History Replay)** 完成之前，**禁止用戶發送新訊息**。
> 
> *   **原因**：防止使用過期狀態 (Stale State) 進行加密，導致發送出重複的 Counter (Replay Attack) 或造成發送鏈分叉 (Chain Fork)。
> *   **UI 表現**：輸入框顯示「正在同步歷史訊息...」，直到 `loadActiveConversationMessages` 完成且 `updateComposerAvailability` 解鎖。
