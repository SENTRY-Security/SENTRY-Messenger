# DR B-Route Audit

## Executive Summary
The repo contains an explicit B-route flow: `syncOfflineDecryptNow` calls `listSecureAndDecrypt` with `mutateState: true` and `allowReplay: false`, which decrypts with live DR state and then persists a DR snapshot and vault-puts the message key on success (web/src/app/features/messages.js:3942, web/src/app/features/messages.js:3973, web/src/app/features/messages.js:1913, web/src/app/features/messages.js:2000).  
DR state is persisted only into the contact-secrets snapshot in browser storage and optionally into a remote contact-secrets backup encrypted with the master key; there is no other DR-state store in this codebase (web/src/app/features/dr-session.js:1003, web/src/app/core/contact-secrets.js:1263, web/src/app/features/contact-backup.js:125, data-worker/src/worker.js:2309).  
When local/session storage are cleared (secure logout clears both), B-route depends on remote backup plus MK availability; otherwise `ensureDrReceiverState` cannot hydrate and `listSecureAndDecrypt` fails with DR_STATE_UNAVAILABLE (web/src/app/ui/app-mobile.js:942, web/src/app/ui/app-mobile.js:1102, web/src/app/features/contact-backup.js:154, web/src/app/features/messages.js:2725, web/src/app/features/dr-session.js:3123).  
A-route replay is strictly vault-only and explicitly blocks DR decrypt in history replay; missing vault keys hard-fail with no DR fallback (web/src/app/features/messages.js:2587, web/src/app/features/messages.js:2632, web/src/app/features/messages.js:2674).  
Proactive DR state hydration after backup is currently a no-op (`hydrateDrSnapshotsAfterBackup`) and `hydrateDrStatesFromContactSecrets` returns 0, so the only restore path is on-demand in `ensureDrReceiverState` (web/src/app/ui/app-mobile.js:2544, web/src/app/features/dr-session.js:1127, web/src/app/features/dr-session.js:3123).

## System Map
- DR state is created in-memory by `drState` and then updated by DR send/receive flows (web/src/app/core/store.js:438, web/src/app/features/dr-session.js:1322).  
- Snapshots are generated via `snapshotDrState` and persisted into contact secrets via `persistDrSnapshot` (web/src/app/features/dr-session.js:796, web/src/app/features/dr-session.js:1003).  
- Contact secrets are serialized to JSON and stored in localStorage/sessionStorage; a remote backup encrypts that snapshot with MK and stores it in D1 (`contact_secret_backups`) (web/src/app/core/contact-secrets.js:1263, web/src/app/core/contact-secrets.js:1538, web/src/app/features/contact-backup.js:125, data-worker/src/worker.js:2370).  
- Post-login, `runPostLoginContactHydrate` restores local secrets and optionally hydrates remote backup, then triggers `syncOfflineDecryptNow` (web/src/app/ui/app-mobile.js:2548, web/src/app/ui/app-mobile.js:3668).  
- Offline catch-up selects targets with conversationId/token/peerDeviceId, fetches ciphertexts via `listSecureMessages`, then decrypts via `listSecureAndDecrypt` (live DR path) (web/src/app/features/messages.js:3721, web/src/app/features/messages.js:1525, web/src/app/features/messages.js:3973).  
- History replay uses MessageKeyVault to decrypt; DR path is blocked during replay (web/src/app/features/messages.js:2587, web/src/app/features/messages.js:2674).

## DR State Lifecycle
**Create**
- `drState(peer)` creates a new holder with rk/ckS/ckR counters, ratchet keys, and metadata in the in-memory map (web/src/app/core/store.js:438).  
- Initiator-side DR state can be created via X3DH in `ensureDrSession`, which writes into `store.drState(peer)` and persists a snapshot (web/src/app/features/dr-session.js:1322, web/src/app/features/dr-session.js:1337).  
- Receiver-side DR state is hydrated from contact-secrets snapshots in `ensureDrReceiverState` (web/src/app/features/dr-session.js:3123, web/src/app/features/dr-session.js:3258).

**Update**
- Snapshots include rk/ckS/ckR, counters, ratchet keys, role, selfDeviceId, and updatedAt (web/src/app/features/dr-session.js:796).  
- `persistDrSnapshot` writes snapshots into contact secrets and keeps conversation info aligned (web/src/app/features/dr-session.js:1003, web/src/app/features/dr-session.js:1043).  
- Successful decrypts persist the DR snapshot after processing each message (web/src/app/features/messages.js:2000).

**Clear**
- `clearDrState` deletes per-peer DR state from the in-memory map; `clearSecrets`/`resetAll` clear all DR sessions (web/src/app/core/store.js:492, web/src/app/core/store.js:542).  
- DR state is cleared on conversation mismatch or repeated decrypt failure in message handling (web/src/app/features/messages.js:2695, web/src/app/features/messages.js:2725).  
- Contact deletion clears DR state and contact secrets (web/src/app/ui/mobile/contacts-view.js:327).  
- Secure logout clears browser storage and then calls `resetAll`/`clearSecrets` (web/src/app/ui/app-mobile.js:942, web/src/app/ui/app-mobile.js:1105).

## Backup Mechanisms
1) **Contact secrets snapshot (localStorage/sessionStorage)**  
   - **Fields**: per-device drState (rk/ckS/ckR, Ns/Nr/PN, NsTotal/NrTotal, ratchet keys, pendingSendRatchet, role, selfDeviceId, updatedAt), plus conversation token/id/drInit and peerDeviceId (web/src/app/core/contact-secrets.js:789, web/src/app/core/contact-secrets.js:1458).  
   - **Location**: localStorage and sessionStorage keys `contactSecrets-v2*` (web/src/app/core/contact-secrets.js:15, web/src/app/core/contact-secrets.js:1263).  
   - **Encoding**: JSON payload written directly to storage (web/src/app/core/contact-secrets.js:1538, web/src/app/core/contact-secrets.js:1272).  

2) **Remote contact-secrets backup (D1)**  
   - **Fields**: encrypted payload + metadata (version, checksum, snapshotVersion, updatedAt, deviceId, deviceLabel, withDrState) stored in `contact_secret_backups` (web/src/app/features/contact-backup.js:172, data-worker/src/worker.js:2370).  
   - **Location**: D1 table `contact_secret_backups` via `/d1/contact-secrets/backup` (data-worker/src/worker.js:2309).  
   - **Encryption/packing**: AES-256-GCM envelope with MK; info tag `contact-secrets/backup/v1` (web/src/app/features/contact-backup.js:125).  
   - **Gating**: backup is skipped when entries exist but `withDrState === 0` unless forced (web/src/app/features/contact-backup.js:154).  

3) **Message Key Vault (A-route replay)**  
   - **Fields**: conversationId/messageId/senderDeviceId/targetDeviceId/direction/msgType/headerCounter plus wrapped message key (web/src/app/features/message-key-vault.js:160, src/controllers/message-key-vault.controller.js:20).  
   - **Location**: server-side D1 `message_key_vault` via `/message-key-vault/put|get` (src/controllers/message-key-vault.controller.js:61).  
   - **Encryption/packing**: message keys wrapped client-side with MK (`wrapWithMK_JSON`, info tag `message-key/v1`) (web/src/app/features/message-key-vault.js:1, web/src/app/features/message-key-vault.js:210).

## Restore/Hydrate Mechanisms
- **Local restore**: `restoreContactSecrets` loads the latest snapshot from local/session storage into the in-memory map (web/src/app/core/contact-secrets.js:978, web/src/app/core/contact-secrets.js:427).  
- **Remote restore**: `hydrateContactSecretsFromBackup` fetches and decrypts the remote backup with MK, then imports it into the contact-secrets map (web/src/app/features/contact-backup.js:203, web/src/app/features/contact-backup.js:258).  
- **Post-login trigger**: `runPostLoginContactHydrate` calls local restore, optional remote hydrate, then kicks off `syncOfflineDecryptNow` (web/src/app/ui/app-mobile.js:2548, web/src/app/ui/app-mobile.js:3668).  
- **On-demand DR hydrate**: `ensureDrReceiverState` restores DR state from contact-secrets snapshots (web/src/app/features/dr-session.js:3123, web/src/app/features/dr-session.js:3258).  
- **No bulk DR hydrate**: `hydrateDrSnapshotsAfterBackup` is empty and `hydrateDrStatesFromContactSecrets` returns 0 (web/src/app/ui/app-mobile.js:2544, web/src/app/features/dr-session.js:1127).  
- **Replay restore**: history replay decrypts using MessageKeyVault only; missing vault keys hard-fail (web/src/app/features/messages.js:2587, web/src/app/features/messages.js:2632).  
- **Offline catch-up triggers**: login, ws reconnect, pull-to-refresh, and enter-conversation all call `syncOfflineDecryptNow` (web/src/app/ui/app-mobile.js:3668, web/src/app/ui/app-mobile.js:3994, web/src/app/ui/mobile/messages-pane.js:1987, web/src/app/ui/mobile/messages-pane.js:4535, web/src/app/ui/mobile/contacts-view.js:436).

## B Route Feasibility Matrix
| Local cleared | Remote backup exists | DR snapshot exists | dr_init exists | Vault exists | B-route decrypt? | Evidence |
|---|---|---|---|---|---|---|
| No | N/A | Yes (local) | Any | Any | Yes | Local restore + on-demand hydrate + live decrypt (web/src/app/core/contact-secrets.js:978, web/src/app/features/dr-session.js:3123, web/src/app/features/messages.js:3973) |
| Yes | Yes | Yes (backup) | Any | Any | Yes (requires MK) | Remote hydrate + on-demand hydrate + live decrypt (web/src/app/features/contact-backup.js:203, web/src/app/features/dr-session.js:3123, web/src/app/features/messages.js:3973) |
| Yes | Yes | No | Yes | Any | No | No snapshot; history restore disabled; bootstrap disabled; DR_STATE_UNAVAILABLE (web/src/app/features/messages.js:2725, web/src/app/features/dr-session.js:754, web/src/app/ui/mobile/contacts-view.js:489) |
| Yes | No | No | Any | Yes | No (A-route only) | Replay is vault-only and blocks DR path (web/src/app/features/messages.js:2587, web/src/app/features/messages.js:2674) |
| Yes | Yes | Yes | Any | Any | No if MK missing | Remote hydrate is gated on MK (web/src/app/features/contact-backup.js:154, web/src/app/features/contact-backup.js:223) |

## Gaps & Root Causes
- **Single persistence path for DR state**: snapshots are written into contact-secrets only; if browser storage is cleared and no remote backup is available, DR state is lost (web/src/app/features/dr-session.js:1003, web/src/app/core/contact-secrets.js:1263).  
- **Remote backup depends on MK and `withDrState`**: backup/restore is skipped without MK and can be skipped when `withDrState === 0`, making recovery impossible after storage loss (web/src/app/features/contact-backup.js:154, web/src/app/features/contact-backup.js:223).  
- **No reconstruction fallback**: DR history restore is disabled, and DR bootstrap during hydrate is explicitly disabled, so missing snapshots cannot be rebuilt (web/src/app/features/dr-session.js:754, web/src/app/ui/mobile/contacts-view.js:489).  
- **Replay cannot switch to B-route**: history replay uses vault and blocks DR decrypt (`REPLAY_DR_PATH_BLOCKED`), so missing vault keys do not trigger B-route (web/src/app/features/messages.js:2587, web/src/app/features/messages.js:2674).  
- **Offline targets require conversation token/device context**: catch-up requires conversationId/token/peerDeviceId sourced from contact secrets or session state; if those are lost, no B-route targets are collected (web/src/app/features/messages.js:3721, web/src/app/ui/mobile/session-store.js:376).  
- **Potential logout flush issue**: `flushDrSnapshotsBeforeLogout` references `entry` without a local definition, which can throw and skip snapshot flush before storage clear (web/src/app/ui/app-mobile.js:1337).

## Recommendations
**Option 1: Minimal change (no new DB schema)**  
- **Data structures**: reuse existing contact-secrets snapshot format; add no new tables.  
- **Flow changes**:  
  - Implement `hydrateDrStatesFromContactSecrets` to pre-create DR holders from snapshots; call it from `hydrateDrSnapshotsAfterBackup` after remote backup import (web/src/app/features/dr-session.js:1127, web/src/app/ui/app-mobile.js:2544).  
  - In `syncOfflineDecryptNow`, call `ensureDrReceiverState` for each target before decrypt to guarantee DR state is loaded from contact secrets (web/src/app/features/messages.js:3942, web/src/app/features/dr-session.js:3123).  
  - Fix `flushDrSnapshotsBeforeLogout` to correctly derive `peerDeviceId` per peer and persist snapshots before clearing storage (web/src/app/ui/app-mobile.js:1321).  
- **Risks**: extra CPU at login/offline catch-up, potential performance regressions for large contact sets, and stricter error handling when snapshots are corrupt.  
- **Why it meets the requirement**: once remote contact-secrets backup is restored, DR state can be reconstructed into memory even after local/session storage is cleared, allowing B-route decrypt to proceed without relying on local storage (web/src/app/features/contact-backup.js:203, web/src/app/features/dr-session.js:3123, web/src/app/features/messages.js:3973).

**Option 2: Normalized solution (server-side DR snapshot backup)**  
- **Data structures**: add a new D1 table (e.g., `dr_state_backups`) keyed by account_digest + conversation_id + peer_device_id + self_device_id, storing an encrypted DR snapshot (rk/ckS/ckR/Ns/Nr/PN/NsTotal/NrTotal/ratchet pubs/role/selfDeviceId/updatedAt) and metadata (version/checksum/updatedAt).  
- **Flow changes**:  
  - Upload snapshots on each `persistDrSnapshot` (or on a debounce) using MK-wrapped payloads, similar to `contact_secret_backups` (web/src/app/features/dr-session.js:1003, web/src/app/features/contact-backup.js:125).  
  - On login and offline catch-up, fetch snapshots per conversation and hydrate via `restoreDrStateFromSnapshot` before decrypt (web/src/app/features/dr-session.js:873, web/src/app/features/messages.js:3942).  
  - Keep `MessageKeyVault` as A-route; B-route uses DR backup when local storage is cleared.  
- **Risks**: sensitive state now persists server-side (must be encrypted and access-controlled), added write amplification, and snapshot/version downgrade handling.  
- **Why it meets the requirement**: DR state is recoverable even when local/session storage are wiped, enabling offline decrypt on next login without relying on client storage.

## Appendix: Evidence Index
- web/src/app/core/store.js:438 - `drState` initializes per-peer DR holder fields.  
- web/src/app/core/store.js:492 - `clearDrState` removes a holder from the in-memory map.  
- web/src/app/core/store.js:542 - `clearSecrets` clears MK and DR sessions.  
- web/src/app/core/contact-secrets.js:15 - storage key constants for contact secrets.  
- web/src/app/core/contact-secrets.js:330 - localStorage access helper.  
- web/src/app/core/contact-secrets.js:339 - sessionStorage access helper.  
- web/src/app/core/contact-secrets.js:427 - `pullLatestSnapshot` reads local/session snapshots.  
- web/src/app/core/contact-secrets.js:978 - `restoreContactSecrets` loads snapshot into memory.  
- web/src/app/core/contact-secrets.js:1263 - `persistContactSecrets` writes JSON to storage.  
- web/src/app/core/contact-secrets.js:1538 - contact secrets payload is JSON stringified.  
- web/src/app/core/contact-secrets.js:1458 - contact secrets include drState and conversation fields.  
- web/src/app/core/contact-secrets.js:789 - drState snapshot field normalization.  
- web/src/app/features/dr-session.js:796 - `snapshotDrState` field list.  
- web/src/app/features/dr-session.js:873 - `restoreDrStateFromSnapshot`.  
- web/src/app/features/dr-session.js:1003 - `persistDrSnapshot` writes into contact secrets.  
- web/src/app/features/dr-session.js:1127 - `hydrateDrStatesFromContactSecrets` is a stub.  
- web/src/app/features/dr-session.js:754 - DR history restore disabled.  
- web/src/app/features/messages.js:1117 - `listSecureAndDecrypt` replay/mutate flags.  
- web/src/app/features/messages.js:1210 - MK missing hardblock for replay.  
- web/src/app/features/messages.js:2587 - replay decrypt uses MessageKeyVault.get.  
- web/src/app/features/messages.js:2674 - DR path blocked in history replay.  
- web/src/app/features/messages.js:2725 - DR_STATE_UNAVAILABLE error.  
- web/src/app/features/messages.js:2000 - persist DR snapshot after decrypt.  
- web/src/app/features/messages.js:3942 - `syncOfflineDecryptNow` entry.  
- web/src/app/features/messages.js:3721 - offline catch-up requires conversationId/token/peerDeviceId.  
- web/src/app/ui/mobile/session-store.js:279 - offline decrypt cursor stored in sessionStorage.  
- web/src/app/ui/mobile/session-store.js:376 - conversationId/token extracted from contact secrets for hydrate.  
- web/src/app/ui/app-mobile.js:2544 - `hydrateDrSnapshotsAfterBackup` no-op.  
- web/src/app/ui/app-mobile.js:2548 - post-login restore + remote hydrate.  
- web/src/app/ui/app-mobile.js:3668 - login triggers `syncOfflineDecryptNow`.  
- web/src/app/ui/app-mobile.js:3994 - ws reconnect triggers `syncOfflineDecryptNow`.  
- web/src/app/ui/mobile/messages-pane.js:1987 - pull-to-refresh triggers `syncOfflineDecryptNow`.  
- web/src/app/ui/mobile/messages-pane.js:4535 - enter conversation triggers `syncOfflineDecryptNow`.  
- web/src/app/ui/mobile/contacts-view.js:436 - contacts pull-to-refresh triggers `syncOfflineDecryptNow`.  
- web/src/app/ui/mobile/contacts-view.js:489 - DR bootstrap during hydrate disabled.  
- web/src/app/features/contact-backup.js:125 - backup encryption envelope uses AES-256-GCM with MK.  
- web/src/app/features/contact-backup.js:154 - backup gated by MK and withDrState.  
- web/src/app/features/contact-backup.js:203 - remote backup hydrate with MK.  
- data-worker/src/worker.js:2309 - D1 contact secret backup endpoint and schema.  
- data-worker/src/worker.js:2370 - contact secret backup insert statement.  
- data-worker/src/worker.js:2434 - backup payload returned to client.  
- web/src/app/features/message-key-vault.js:1 - MessageKeyVault wraps keys with MK.  
- web/src/app/features/message-key-vault.js:210 - `wrapWithMK_JSON` for vault put.  
- src/controllers/message-key-vault.controller.js:20 - vault payload schema fields.  
