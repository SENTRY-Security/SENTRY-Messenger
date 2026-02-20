# CLAUDE.md — AI Agent Context for SENTRY Messenger

This file provides essential context for AI agents (Claude Code, Copilot, Cursor, etc.) working on the SENTRY Messenger codebase. Read this file before making any changes.

## Project Overview

SENTRY Messenger is an end-to-end encrypted messaging system using Signal Protocol (X3DH + Double Ratchet). It is deployed as a three-tier hybrid architecture:

- **Frontend** (`web/`) — Vanilla JS SPA on Cloudflare Pages, all crypto in browser
- **Backend** (`src/`) — Node.js Express + WebSocket on VPS (PM2)
- **Data Worker** (`data-worker/`) — Cloudflare Workers with D1 (SQLite) + R2 storage

## Critical Architecture Constraints

> **These constraints are non-negotiable design decisions, not bugs to fix.**

### 1. Zero Local Storage — No Sensitive Data on Device

This system serves a niche user base whose core requirement is **zero data residency on the device**. Unlike Signal/WhatsApp which store message databases and keys locally, SENTRY Messenger:

- **Clears `localStorage` and `sessionStorage` BEFORE login AND BEFORE logout** (`clearAllBrowserStorage()` in `app-mobile.js`)
- **Clears IndexedDB on logout** (via `indexedDB.deleteDatabase`)
- **Stores all persistent state encrypted on the server**, not locally
- **Rehydrates state from server on every login** (6-stage restore pipeline)

**Implication for code changes:** Never assume localStorage contains data. Never write sensitive data to localStorage expecting it to survive across sessions. All cross-session persistence must go through server-side encrypted backup.

### 2. Single deviceId per Account

- One account has exactly one active `deviceId` at any time
- Logging in on a new device reuses the same `deviceId` and kicks the old session via `force-logout` WebSocket event
- No multi-device concurrent scenarios exist
- No need to handle cross-device DR state conflicts

**Implication for code changes:** You can ignore multi-device race conditions, cross-device counter collisions, and snapshot deviceId mismatch rejection logic.

### 3. Server-Side Encrypted State with Login Hydration

All persistent cryptographic state (DR sessions, contact secrets, message keys) follows this lifecycle:

```
in-memory state
    → snapshotDrState()  (serialize to JSON)
    → AES-256-GCM encrypt with HKDF(MK)
    → server storage (two paths):
        1. atomicSend backup payload (piggybacks on every message send)
        2. vaultPut drStateSnapshot (attached to every incoming message decrypt)

Login restore (6-stage pipeline in restore-coordinator.js):
    Stage 0: OPAQUE auth → session + MK derivation
    Stage 1: restoreContactSecrets() from localStorage → ALWAYS EMPTY
    Stage 2: hydrateContactSecretsFromBackup() → fetch from server + decrypt with MK
    Stage 3: hydrateDrStatesFromContactSecrets() → populate drSessMap (in-memory)
    Stage 4: probeMaxCounter() → detect gaps per conversation
    Stage 5/6: gap-queue drain → sequential fetch + DR decrypt + vault put
```

**Master Key (MK):** Derived from user password via Argon2id during OPAQUE auth. Never sent to server. Used to encrypt/decrypt all server-side backups via HKDF-SHA256 → AES-256-GCM. Exists only in memory during a session.

**Implication for code changes:** The "ground truth" for DR state is on the server (vault drStateSnapshot and contact-secrets backup), not in memory or localStorage. If you add new state that must survive across sessions, it must be included in `snapshotDrState()` and propagated through the backup pipeline.

### 4. Monotonic Receiver Architecture

**This is the most important architectural difference from standard Double Ratchet implementations.**

Standard E2EE apps: WS delivers message → DR decrypt (possibly out-of-order) → store skippedKeys → local DB.

SENTRY Messenger:
- **Sender:** `drEncryptText()` → `atomicSend(counter=NsTotal)` → server validates `counter > max_counter` (409 if not)
- **WS is notification-only:** `secure-message` event tells receiver "there's a new message" but does NOT carry the message content
- **Receiver fetches by counter in strict order:** Starting from `localMax + 1`, fetching each counter sequentially via `GET /messages/by-counter`
- **gap-queue.js** enforces `for (counter = start; counter <= target; counter++)` — strictly monotonic
- **coordinator.js** has `[STRICT SEQUENTIAL]` guard: before processing a live WS message, it fills ALL gaps first

**Invariant:** Receiver's DR chain counter `Nr` always equals `header.n - 1` for the next message to process.

**Direct consequences for code:**
- `skippedKeys` (DR protocol mechanism for out-of-order messages) is **always empty** under this architecture
- `snapshotDrState()` correctly does NOT serialize `skippedKeys` — this is by design, not a bug
- `pn` field (previous chain length) always equals `Nr` at ratchet time — use as consistency assertion
- If you see non-empty `skippedKeys`, it indicates a bug (likely CounterTooLow repair not rolling back DR state)
- **Do NOT add skippedKeys serialization/persistence** — it is unnecessary and adds complexity

### 5. Counter Domains — Two Separate Counter Systems

The codebase uses two distinct counter domains that must not be confused:

| Counter | Scope | Resets? | Used For |
|---------|-------|---------|----------|
| `Ns` / `Nr` | Per-chain (DR protocol) | Yes, resets to 0 on ratchet | Chain key derivation, header `n` field |
| `NsTotal` / `NrTotal` | Per-conversation (transport) | Never | Server API `counter`, gap detection, vault `headerCounter` |

- `NsTotal` is the transport counter used in `atomicSend` and validated by the server
- `NrTotal` is the transport counter used for gap detection and vault queries
- `Ns`/`Nr` are DR protocol counters that reset with each DH ratchet epoch
- **When ratchet is enabled:** `Ns` resets to 0 but `NsTotal` must continue monotonically

### 6. Atomic Send

Every message send is atomic — the server receives message + vault key + contact-secrets backup in a single request:

```javascript
atomicSend({
    message: { counter, header_json, ciphertext_b64 },
    vault: { wrapped_mk, headerCounter, dr_state_snapshot },
    backup: { contact_secrets_encrypted_with_MK }
})
```

This ensures server-side state consistency. The contact-secrets backup is **piggybacked on every message send**, which is why the server always has a recent DR state snapshot.

## Key Files

| File | Purpose |
|------|---------|
| `web/src/shared/crypto/dr.js` | Double Ratchet protocol (drRatchet, drEncryptText, drDecryptText) |
| `web/src/app/features/dr-session.js` | DR session management, transport counter bridge, snapshot/persist/hydrate |
| `web/src/app/features/messages-flow/gap-queue.js` | Sequential counter-based gap filling |
| `web/src/app/features/messages-flow/live/coordinator.js` | Live message coordinator with STRICT SEQUENTIAL guard |
| `web/src/app/features/messages-flow/live/state-live.js` | Live decrypt state machine (B route) |
| `web/src/app/features/restore-coordinator.js` | 6-stage login restore pipeline |
| `web/src/app/features/contact-backup.js` | Contact secrets backup/restore to server |
| `web/src/app/core/contact-secrets.js` | Contact secrets in-memory store + encryption |
| `web/src/app/features/message-key-vault.js` | Message Key Vault (server-side key storage) |
| `web/src/app/ui/app-mobile.js` | Login/logout lifecycle, clearAllBrowserStorage |
| `web/src/app/ui/mobile/ws-integration.js` | WebSocket integration, force-logout handling |
| `data-worker/src/worker.js` | Server-side counter validation, D1 queries |

## Known Issues / Intentional Disabled Features

### Forward Secrecy Ratchet (CRIT-01)

The DH ratchet rotation on the **receiving side** is currently **partially disabled** in `dr.js:323-330`:

```javascript
// [DEBUG] Disable recurring ratchet: Keep existing sending chain alive.
// st.ckS = null;
// [DEBUG] Disable sending side updates entirely
// st.PN = st.Ns;
// st.Ns = 0;
st.Nr = 0;
// st.myRatchetPriv = myNew.secretKey;
// st.myRatchetPub = myNew.publicKey;
```

The **sending side** ratchet in `drEncryptText:362-382` is functional. This means the system currently operates without full forward secrecy. See `SECURITY-AUDIT.md` (Appendix A, B, C) for the complete impact analysis and enablement plan.

**Do NOT simply uncomment these lines** — enabling requires synchronized changes across `dr.js`, `dr-session.js`, and counter management logic. See `SECURITY-AUDIT.md` Appendix C for the revised 6-item MVP.

### CounterTooLow Repair

When the server returns 409 CounterTooLow, the current repair logic (`dr-session.js:2164-2260`) overwrites `NsTotal` and re-encrypts, but does **not** rollback DR state. This means a chain key is consumed without producing a persisted message ("phantom"). This is the **only** scenario that could produce non-empty `skippedKeys` under the monotonic receiver architecture. The fix (DR state rollback before re-encrypt) is tracked as Phase 3.1 in the security audit.

## Development Rules

1. **Never assume localStorage has data** — it's always empty after login
2. **Never store sensitive data locally expecting persistence** — use server-side backup
3. **Messages are always received in order** — the receiver is strictly monotonic
4. **skippedKeys should always be empty** — if they're not, investigate the bug
5. **Two counter domains** — don't confuse `Ns`/`Nr` (per-chain, resets) with `NsTotal`/`NrTotal` (per-conversation, monotonic)
6. **DR state ground truth is on the server** — vault drStateSnapshot > in-memory > localStorage
7. **MK never leaves memory** — derived from password, used for all backup crypto, cleared on logout
8. **WS is notification-only for messages** — receiver fetches by counter, does not decrypt WS payload
9. **Atomic send guarantees consistency** — message + vault + backup always committed together
10. **Single deviceId** — no multi-device race conditions to handle
