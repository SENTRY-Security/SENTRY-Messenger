# 商業對話 — Policy 系統規格

> 版本：v1.0-draft | 日期：2026-03-16

---

## 一、設計原則

1. **Policy 全加密**：伺服器僅存放 encrypted blob，無法解讀 Policy 內容
2. **群主唯一控制**：僅 owner 可設定/修改 Policy
3. **客戶端執行**：Policy 規則由客戶端解密後本地執行
4. **建群即設**：建群時必須設定初始 Policy
5. **版本化**：Policy 結構有版本號，支持未來擴展

---

## 二、Policy 結構

### 2.1 明文結構（客戶端）

```javascript
const policySchema = {
  // 版本號（必填）
  v: 1,

  // === 成員管理 ===

  // 一般成員是否可邀請他人加入
  // true: 任何 active 成員都可以邀請
  // false: 僅 owner 可以邀請
  allow_member_invite: false,

  // === 好友功能 ===

  // 成員間是否可互加好友
  // true: 成員可透過群組通道發起好友請求
  // false: 禁止群內互加好友
  allow_member_friendship: true,

  // === 對話限制 ===

  // 最大成員數（含 owner）
  max_members: 50,

  // === 預留欄位（v2+） ===
  // allow_media: true,           // 是否允許傳媒體
  // allow_file: true,            // 是否允許傳檔案
  // message_ttl: null,           // 訊息自動銷毀時間（秒），null = 不自動銷毀
  // mute_all_members: false,     // 全體靜音（僅 owner 可發言）
};
```

### 2.2 預設 Policy

```javascript
const DEFAULT_POLICY = {
  v: 1,
  allow_member_invite: false,
  allow_member_friendship: true,
  max_members: 50
};
```

### 2.3 加密存放

```javascript
async function encryptPolicy(groupMetaKey, policy) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(policy));
  const aad = new TextEncoder().encode('sentry/biz-conv/policy/v1');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    groupMetaKey,
    plaintext
  );
  return {
    v: 1,
    iv_b64: bytesToB64Url(iv),
    ct_b64: bytesToB64Url(new Uint8Array(ciphertext))
  };
}

async function decryptPolicy(groupMetaKey, encryptedBlob) {
  const iv = b64UrlToBytes(encryptedBlob.iv_b64);
  const ct = b64UrlToBytes(encryptedBlob.ct_b64);
  const aad = new TextEncoder().encode('sentry/biz-conv/policy/v1');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    groupMetaKey,
    ct
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
```

---

## 三、Policy 執行矩陣

### 3.1 操作權限對照表

| 操作 | owner | member (allow_member_invite=true) | member (allow_member_invite=false) |
|------|-------|----------------------------------|-----------------------------------|
| 修改 Policy | Y | N | N |
| 修改 Meta（名稱等） | Y | N | N |
| 邀請成員 | Y | Y | N |
| 踢除成員 | Y | N | N |
| 轉移群主 | Y | N | N |
| 解散群組 | Y | N | N |
| 離開群組 | N（必須先轉移） | Y | Y |
| 發送訊息 | Y | Y | Y |
| 發起群內好友請求 | (依 policy) | (依 policy) | (依 policy) |

### 3.2 好友請求 Policy 執行

```javascript
function canSendFriendRequest(policy, senderRole) {
  if (!policy) return false;
  return policy.allow_member_friendship === true;
}
```

### 3.3 邀請 Policy 執行

```javascript
function canInviteMember(policy, inviterIsOwner) {
  if (inviterIsOwner) return true;
  return policy.allow_member_invite === true;
}
```

---

## 四、Policy 變更流程

### 4.1 群主修改 Policy

```
群主 (Alice)                                Server                    其他成員
────────────                                ──────                    ────────
  │ 解密當前 Policy                          │                          │
  │ 修改 Policy 欄位                         │                          │
  │ 加密新 Policy                            │                          │
  │                                          │                          │
  │── PUT /biz-conv/:id/policy ────────────▶│                          │
  │   { encrypted_policy_blob }              │── 更新 DB                │
  │                                          │── 建立 tombstone         │
  │◀── { ok: true } ───────────────────────│                          │
  │                                          │── WS: policy-updated ──▶│
  │                                          │                          │ GET /biz-conv/:id
  │                                          │                          │ 解密新 Policy
  │                                          │                          │ 更新本地 Policy
  │── 群組 tombstone: Policy 已更新 ────────▶│── WS 廣播 ─────────────▶│
```

### 4.2 Tombstone 結構

```javascript
// Policy 變更 tombstone 的加密 payload
const policyChangeTombstone = {
  v: 1,
  type: 'policy_changed',
  actor: 'Alice',
  changes: [
    { field: 'allow_member_invite', from: false, to: true },
    { field: 'max_members', from: 50, to: 100 }
  ],
  message: 'Alice 已更新群組設定',
  ts: Date.now()
};
```

---

## 五、Policy 驗證策略

### 5.1 伺服器端（最小驗證）

伺服器 **不解密** Policy，僅做以下檢查：
- 操作者是否為 owner（修改 Policy 時）
- encrypted_policy_blob 是否為有效 JSON string
- blob 大小限制（例如 < 4KB）

```javascript
// Worker 中的驗證
function validatePolicyBlob(blob) {
  if (typeof blob !== 'string') return false;
  try {
    const parsed = JSON.parse(blob);
    if (!parsed.v || !parsed.iv_b64 || !parsed.ct_b64) return false;
    // 大小限制
    if (blob.length > 4096) return false;
    return true;
  } catch {
    return false;
  }
}
```

### 5.2 客戶端（完整驗證）

客戶端解密 Policy 後做完整校驗：

```javascript
function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') return false;
  if (policy.v !== 1) return false;
  if (typeof policy.allow_member_invite !== 'boolean') return false;
  if (typeof policy.allow_member_friendship !== 'boolean') return false;
  if (typeof policy.max_members !== 'number' || policy.max_members < 2 || policy.max_members > 500) return false;
  return true;
}
```

---

## 六、Policy 版本遷移

### 6.1 向前相容

```javascript
function migratePolicy(policy) {
  if (!policy || !policy.v) return DEFAULT_POLICY;

  // v1 是當前版本，不需遷移
  if (policy.v === 1) return policy;

  // 未來 v2 → v1 的降級（如果需要）
  // if (policy.v === 2) { ... }

  // 不認識的版本，使用預設
  return DEFAULT_POLICY;
}
```

### 6.2 升級路徑

- v1 → v2：群主更新 Policy 時，客戶端自動填入新欄位的預設值
- 舊版客戶端看到 v2 Policy 時，忽略不認識的欄位

---

## 七、安全考量

### 7.1 惡意客戶端繞過

由於 Policy 在客戶端執行，惡意修改的客戶端可以：
- 在 `allow_member_invite = false` 時仍嘗試呼叫 invite API
- 在 `allow_member_friendship = false` 時仍發送好友請求

**緩解措施:**
- **邀請權限**：伺服器端可選擇性地實作 owner-only invite（當 owner 設定 `allow_member_invite = false` 時，在 invite API 中額外檢查 owner）
  - 但這需要伺服器能「知道」policy 內容，違反零信任原則
  - **決策**：接受此限制，由客戶端誠實執行。群主可以踢除違規成員。

### 7.2 Policy Hash Commitment（未來改進）

```
方案：群主在更新 Policy 時，同時上傳 Policy hash（明文 SHA-256）
伺服器可用此 hash 做 commitment 驗證，但不知道 Policy 內容

owner_account_digest + policy_hash → 伺服器記錄
其他成員解密 Policy 後，本地驗證 hash 一致

優點：可偵測 Policy 被竄改
缺點：增加複雜度，且 hash 仍可能洩漏 Policy 資訊（已知 Policy 空間有限）
```

**暫不實作**，留作未來 v2 改進。
