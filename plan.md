# 方向 C：Invite CONFIRMED 狀態 + Startup Reconciler

## 概要

在 invite 生命週期加入 `CONFIRMED` 狀態，讓 client 在完整處理完 consume 後回報確認。
兩個補救觸發點：(1) 啟動時 Stage6 自動 reconcile  (2) 聯絡人清單下拉刷新時觸發 reconcile。

狀態流：`CREATED → DELIVERED → CONSUMED → CONFIRMED`

---

## 改動清單

### 1. Data Worker — `data-worker/src/worker.js`

#### 1a. 新增欄位驗證常數（~line 306 區塊）

```js
const INVITE_CONFIRM_ALIAS_FIELDS = new Set([
  'invite_id', 'account_token', 'account_digest', 'device_id'
]);
const INVITE_CONFIRM_ALLOWED_FIELDS = new Set([
  'inviteId', 'accountToken', 'accountDigest', 'deviceId'
]);
const INVITE_UNCONFIRMED_ALIAS_FIELDS = new Set([
  'account_token', 'account_digest'
]);
const INVITE_UNCONFIRMED_ALLOWED_FIELDS = new Set([
  'accountToken', 'accountDigest'
]);
```

#### 1b. 新增 `POST /d1/invites/confirm`（插在 `/d1/invites/status` 之前，~line 1698）

- 驗證 inviteId (min 8) + accountToken
- resolveAccount
- SELECT status, owner_account_digest WHERE invite_id=?
- 403 if owner mismatch
- 若 status 已是 'CONFIRMED' → 回 { ok: true }（冪等）
- 若 status 不是 'CONSUMED' → 400 錯誤
- UPDATE status='CONFIRMED', updated_at=now WHERE invite_id=? AND status='CONSUMED'
- 回傳 { ok: true, invite_id }

#### 1c. 新增 `POST /d1/invites/unconfirmed`（插在 confirm 之後）

- 驗證 accountToken
- resolveAccount
- SELECT invite_id, owner_device_id, expires_at FROM invite_dropbox
  WHERE owner_account_digest=? AND status='CONSUMED' AND expires_at > now
- 回傳 { ok: true, invites: [{ invite_id, owner_device_id, expires_at }, ...] }

#### 1d. 更新過期排除邏輯

`markInviteExpired` 的呼叫處（status endpoint line ~1755）：
將 `status !== 'CONSUMED'` 改為 `status !== 'CONSUMED' && status !== 'CONFIRMED'`

---

### 2. Express API Gateway — `src/controllers/invites.controller.js`

#### 2a. 新增 Zod schemas

```js
const InviteConfirmSchema = z.object({
  invite_id: z.string().min(8),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).strict();

const InviteUnconfirmedSchema = z.object({
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).strict();
```

#### 2b. 新增欄位驗證常數

```js
const INVITE_CONFIRM_ALIAS_FIELDS = new Set(['inviteId', 'accountToken', 'accountDigest']);
const INVITE_CONFIRM_ALLOWED_FIELDS = new Set(['invite_id', 'account_token', 'account_digest']);
const INVITE_UNCONFIRMED_ALIAS_FIELDS = new Set(['inviteId', 'accountToken', 'accountDigest']);
const INVITE_UNCONFIRMED_ALLOWED_FIELDS = new Set(['invite_id', 'account_token', 'account_digest']);
```

#### 2c. 新增 `confirmInviteDropbox` handler

- 驗 x-device-id header
- rejectInviteSchemaMismatch
- Zod parse
- resolveAccountAuth
- HMAC sign → proxy POST to `${DATA_API}/d1/invites/confirm`
- 回傳 upstream 結果

#### 2d. 新增 `unconfirmedInvitesDropbox` handler

- 驗 x-device-id header
- rejectInviteSchemaMismatch
- Zod parse
- resolveAccountAuth
- HMAC sign → proxy POST to `${DATA_API}/d1/invites/unconfirmed`
- 回傳 { invites: [...] }

### 3. Express Routes — `src/routes/v1/invites.routes.js`

新增兩行：
```js
r.post('/invites/confirm', confirmInviteDropbox);
r.post('/invites/unconfirmed', unconfirmedInvitesDropbox);
```

---

### 4. Client API — `web/src/app/api/invites.js`

#### 4a. `invitesConfirm({ inviteId })`

```js
export async function invitesConfirm({ inviteId } = {}) {
  if (!inviteId) throw new Error('inviteId required');
  const payload = withAccountToken({ invite_id: inviteId });
  const { r, data } = await fetchJSON('/api/v1/invites/confirm', payload, withDeviceHeaders());
  if (!r.ok) throw buildError(r.status, data, 'invite confirm failed');
  return data;
}
```

#### 4b. `invitesUnconfirmed()`

```js
export async function invitesUnconfirmed() {
  const payload = withAccountToken({});
  const { r, data } = await fetchJSON('/api/v1/invites/unconfirmed', payload, withDeviceHeaders());
  if (!r.ok) throw buildError(r.status, data, 'invite unconfirmed query failed');
  return data;
}
```

---

### 5. Consume 完成後 Confirm — `web/src/app/ui/mobile/controllers/share-controller.js`

在 `handleContactInitEvent` 函數末尾（line ~2247，`triggerContactSecretsBackup` 之後、`return` 之前）插入：

```js
if (inviteId) {
  invitesConfirm({ inviteId }).catch(err =>
    console.warn('[share-controller] invite confirm failed', err)
  );
}
```

需要在檔案頂部 import `invitesConfirm`。

---

### 6. Startup Reconciler Stage6 — `web/src/app/features/restore-coordinator.js`

#### 6a. 在 `startRestorePipeline` 的 Stage5 之後、`return { ok: true }` 之前，新增 Stage6

```
setStage('Stage6');
try {
  const result = await reconcileUnconfirmedInvites();
  recordStageResult('Stage6', {
    ok: true,
    progress: {
      total: result.total,
      alreadyReady: result.alreadyReady,
      replayed: result.replayed,
      failed: result.failed
    }
  });
} catch (err) {
  recordStageResult('Stage6', {
    ok: false,
    reasonCode: 'RECONCILE_FAILED'
  });
  // Stage6 失敗不 block pipeline
}
```

#### 6b. `reconcileUnconfirmedInvites()` 實作

```
async function reconcileUnconfirmedInvites() {
  const res = await invitesUnconfirmed();
  const invites = res?.invites || [];
  let alreadyReady = 0, replayed = 0, failed = 0;

  for (const inv of invites) {
    const inviteId = inv.invite_id;
    try {
      // 嘗試查現有 contactCore — 但我們不知道 peerAccountDigest
      // 所以走 re-consume 路線：consume 是冪等的，重新拿 envelope
      const consumeRes = await invitesConsume({ inviteId });
      const envelope = consumeRes?.ciphertext_envelope;
      if (!envelope) { failed++; continue; }

      const devicePriv = await ensureDevicePrivLoaded();
      const payload = await openInviteEnvelope({
        ownerPrivateKeyB64: devicePriv.spk_priv_b64,
        envelope
      });
      const normalized = normalizeContactInitPayload(payload);
      const peerDigest = normalized.guestAccountDigest;

      // 檢查是否已有完整 contactCore
      const existing = findContactCoreByAccountDigest(peerDigest);
      const readyEntry = existing.find(e => e.entry?.isReady);

      if (readyEntry) {
        // 已完成，只是漏了 confirm
        await invitesConfirm({ inviteId });
        alreadyReady++;
      } else {
        // 需要重跑完整處理
        const msg = {
          guestAccountDigest: normalized.guestAccountDigest,
          guestDeviceId: normalized.guestDeviceId,
          guestBundle: normalized.guestBundle,
          guestProfile: normalized.guestProfile
        };
        await handleContactInitEvent(msg, { inviteId });
        await invitesConfirm({ inviteId });
        replayed++;
      }
    } catch (err) {
      failed++;
      logCapped('reconcileInviteFailed', { inviteId, error: err?.message }, 5);
    }
  }
  return { total: invites.length, alreadyReady, replayed, failed };
}
```

#### 6c. 更新 STAGES 常數

```js
const STAGES = ['Stage0', 'Stage1', 'Stage2', 'Stage3', 'Stage4', 'Stage5', 'Stage6'];
```

#### 6d. 新增 imports

在 restore-coordinator.js 頂部加入：
```js
import { invitesConsume, invitesConfirm, invitesUnconfirmed } from '../api/invites.js';
```

`openInviteEnvelope`、`normalizeContactInitPayload`、`findContactCoreByAccountDigest`、
`handleContactInitEvent`、`ensureDevicePrivLoaded` 等函數需要從各自模組 import，
或將 reconcile 邏輯放在 share-controller 中 export 給 restore-coordinator 呼叫。

---

### 7. 下拉刷新觸發 Reconcile — `web/src/app/ui/mobile/controllers/conversation-list-controller.js`

#### 7a. 在 `handleConversationRefresh()` 中新增 reconcile 呼叫

現有邏輯（line ~644）：
```js
async handleConversationRefresh() {
    if (this.conversationsRefreshing) return;
    this.conversationsRefreshing = true;
    this.updateConversationPull(CONV_PULL_THRESHOLD);
    try {
        this.deps.syncConversationThreadsFromContacts?.();
        await this.deps.refreshConversationPreviews?.({ force: true });
        this.renderConversationList();
    } catch (err) { ... }
}
```

改為：
```js
async handleConversationRefresh() {
    if (this.conversationsRefreshing) return;
    this.conversationsRefreshing = true;
    this.updateConversationPull(CONV_PULL_THRESHOLD);
    try {
        // 同時觸發 unconfirmed invite reconcile（fire-and-forget）
        this.deps.reconcileUnconfirmedInvites?.()
            .then(result => {
                if (result && (result.replayed > 0 || result.alreadyReady > 0)) {
                    // 有補救成功的 invite，重新 sync + render
                    this.deps.syncConversationThreadsFromContacts?.();
                    this.renderConversationList();
                }
            })
            .catch(err => this.log?.({ reconcileOnRefreshError: err?.message }));

        this.deps.syncConversationThreadsFromContacts?.();
        await this.deps.refreshConversationPreviews?.({ force: true });
        this.renderConversationList();
    } catch (err) { ... }
}
```

#### 7b. 傳入 deps

在建立 ConversationListController 的地方（`messages-pane.js` 或 `app-mobile.js`），
將 `reconcileUnconfirmedInvites` 作為 dep 傳入：

```js
reconcileUnconfirmedInvites: () => reconcileUnconfirmedInvites()
```

#### 7c. `reconcileUnconfirmedInvites` 提取為共用模組

由於 Stage6 和下拉刷新都要用，將 `reconcileUnconfirmedInvites()` 從 restore-coordinator
提取到 `web/src/app/features/invite-reconciler.js` 作為獨立模組：

```js
// web/src/app/features/invite-reconciler.js
import { invitesConsume, invitesConfirm, invitesUnconfirmed } from '../api/invites.js';
// ... 其他需要的 imports

let _reconciling = false; // 防止並發

export async function reconcileUnconfirmedInvites() {
    if (_reconciling) return { total: 0, alreadyReady: 0, replayed: 0, failed: 0, skipped: true };
    _reconciling = true;
    try {
        const res = await invitesUnconfirmed();
        const invites = res?.invites || [];
        let alreadyReady = 0, replayed = 0, failed = 0;

        for (const inv of invites) {
            // ... 同 6b 的邏輯
        }
        return { total: invites.length, alreadyReady, replayed, failed };
    } finally {
        _reconciling = false;
    }
}
```

restore-coordinator.js 和 conversation-list-controller.js 都 import 這個共用函數。

---

## 注意事項

- `POST /d1/invites/confirm` 是冪等的：已 CONFIRMED 直接回 ok
- `POST /d1/invites/consume` 也是冪等的：已 CONSUMED 直接回 envelope
- Stage6 失敗不 block pipeline（非 fatal）
- confirm 在 share-controller 是 fire-and-forget，不影響使用者體驗
- 不需要 D1 migration（CONFIRMED 只是 status 欄位的新字串值，updated_at 已存在）
- reconcile 有兩個觸發點：(1) 啟動 Stage6  (2) 下拉刷新聯絡人清單
- `_reconciling` mutex 防止兩個觸發點並發執行（例如啟動時 Stage6 還在跑，用戶就下拉了）
- 下拉刷新中 reconcile 是 fire-and-forget，不 block 主刷新流程
