# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in SENTRY Messenger, please report it responsibly.

**Email:** security@sentry.red

Please include:
- A description of the vulnerability
- Steps to reproduce the issue
- Affected components (client, worker, crypto, etc.)
- Any potential impact assessment

We will acknowledge receipt within 48 hours and aim to provide an initial assessment within 5 business days.

## Scope

The following components are in scope for security reports:

| Component | Path | Description |
|-----------|------|-------------|
| Cryptography (client) | `web/src/shared/crypto/` | X3DH, Double Ratchet, AEAD, key generation |
| Cryptography (app) | `web/src/app/crypto/` | KDF, invite dropbox, app-level crypto wrappers |
| Worker API | `data-worker/src/worker.js` | All REST API endpoints, authentication, authorization |
| WebSocket relay | `data-worker/src/account-ws.js` | Message routing, presence, buffering |
| Message pipeline | `web/src/app/features/messages-flow/` | Message encryption, decryption, state management |
| Call E2EE | `web/src/app/features/calls/` | InsertableStreams encryption, key rotation |
| Media encryption | `web/src/app/features/chunked-upload.js` | Per-chunk AES-256-GCM encryption |
| Auth flow | `web/src/app/features/login-flow.js` | OPAQUE, SDM, master key handling |
| Ephemeral chat | `web/src/app/ui/ephemeral-ui.js` | One-time link, guest E2EE |

## Out of Scope

- Denial of service attacks against Cloudflare infrastructure
- Social engineering attacks
- Physical access to user devices
- Issues in third-party dependencies (report upstream)
- Issues requiring root/admin access to the server

## Security Documentation

Detailed security documentation is available in [`docs/security/`](docs/security/):

- [Threat Model](docs/security/threat-model.md)
- [Security Architecture](docs/security/security-architecture.md)
- [Trust Boundaries](docs/security/trust-boundaries.md)
- [Data Classification](docs/security/data-classification.md)
- [Key Management](docs/security/key-management.md)
- [Protocol Overview](docs/security/protocol-overview.md)
- [Message Lifecycle](docs/security/message-lifecycle.md)
- [Media & Attachment Security](docs/security/media-and-attachment-security.md)
- [Metadata Exposure](docs/security/metadata-exposure.md)
- [Security Assumptions & Out of Scope](docs/security/security-assumptions-and-out-of-scope.md)
- [Known Limitations](docs/security/known-limitations.md)
- [Audit Readiness](docs/security/audit-readiness.md)
- [Security Review Checklist](docs/security/security-review-checklist.md)

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✓ Current |

## License

This project is licensed under AGPL-3.0-only. Security fixes are distributed through the same channel as regular releases.
