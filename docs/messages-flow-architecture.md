# Messages Flow Architecture

## 1. 目標
- Provide a stable facade entry surface for message flow events.
- Separate routing (A/B) from crypto/state/presentation so legacy can be replaced step-by-step.
- Keep UI event wiring simple and avoid direct calls into pipeline internals.

## 2. A route / B route 定義與邊界
- A route = replay (vault-only).
  - Conditions: mutateState=false and allowReplay=true.
  - Only vaultGet + AES-GCM decrypt are allowed.
  - No DR advancement, no gap-fill, no live decrypt triggers.
  - May only hand off work to B route via jobs (no direct call).
- B route = live decrypt.
  - Conditions: mutateState=true and allowReplay=false.
  - Can advance DR state and vaultPut incoming keys.
  - Responsible for gap-fill, counter repair, and offline catchup.

## 3. 模組分工（Facade/Queue/Server/State/Crypto/Presentation/Reconcile）
- Facade: entry point that maps UI/WS events to jobs. No decrypt/vault/API.
- Queue: in-memory job queue with dedupe; no timer loops.
- Server API: wrap existing secure-message endpoints.
- State: single access layer for contact-secrets and message_key_vault.
- Crypto: DR readiness/decrypt/skip-key derivation (no schema changes).
- Presentation: placeholder planning + decrypted message application hooks.
- Reconcile: plan catchup jobs based on counters and incoming state.

## 4. 入口事件（login/ws/enter/resume/scroll）如何轉 job
- login: onLoginResume -> enqueue login_resume job.
- ws: onWsIncomingMessageNew -> enqueue ws_incoming_message_new job.
- enter: onEnterConversation -> enqueue enter_conversation job.
- resume: onVisibilityResume -> enqueue visibility_resume job.
- scroll: onScrollFetchMore -> enqueue scroll_fetch_more job.

## 5. 禁止事項（UI 不直呼 pipeline、無 timer loop、A route 不觸發 B route）
- UI must not call pipeline core functions directly; only call Facade.
- No new setInterval / looping setTimeout.
- A route must not trigger B route directly (handoff only via jobs).

## 6. 後續替換計畫（Phase 3：逐段替換順序）
- Replace WS incoming handling with new facade + queue + reconcile.
- Replace replay (A route) list path with server-api/state/crypto adapters.
- Replace live decrypt (B route) with new crypto/state adapters.
- Replace placeholder planning with presentation adapter wiring.
- Remove legacy facade and legacy pipeline entry calls after parity.
