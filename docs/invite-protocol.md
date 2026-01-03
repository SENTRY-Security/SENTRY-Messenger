# Invite Protocol (Single Version)

This document defines the only invite protocol used by the system. There are no alternate formats.

## QR Payload (Base64URL-encoded JSON)

The QR code encodes a Base64URL string of this JSON object:

```
{
  "v": 3,
  "type": "invite_dropbox",
  "inviteId": "string",
  "expiresAt": 1700000000,
  "ownerAccountDigest": "64-hex uppercase",
  "ownerDeviceId": "string",
  "ownerPublicKeyB64": "base64",
  "prekeyBundle": {
    "ikPubB64": "base64",
    "spkPubB64": "base64",
    "signatureB64": "base64",
    "opkId": 1,
    "opkPubB64": "base64"
  }
}
```

Required fields: `v`, `type`, `inviteId`, `expiresAt`, `ownerAccountDigest`, `ownerDeviceId`, `ownerPublicKeyB64`, `prekeyBundle`.

Rules:
- `v` is a constant `3`; any other value is rejected.
- `type` must be `invite_dropbox`.
- `expiresAt` is a Unix timestamp in seconds; TTL is 5 minutes from creation.
- Clients must display a countdown derived from `expiresAt` and treat the QR as invalid when expired.

## Dropbox Ciphertext Envelope (Server-Blind)

Client-side sealed encryption must produce this envelope:

```
{
  "v": 1,
  "aead": "aes-256-gcm",
  "info": "contact-init/dropbox/v1",
  "sealed": {
    "eph_pub_b64": "base64",
    "iv_b64": "base64",
    "ct_b64": "base64"
  },
  "createdAt": 1700000000,
  "expiresAt": 1700000300
}
```

Required fields: all of the above. The server stores this blob as-is and cannot decrypt it.

## Contact-Init Payload (Sealed Inside Envelope)

The decrypted payload stored inside the envelope must follow this schema:

```
{
  "v": 1,
  "type": "contact-init",
  "guestAccountDigest": "64-hex uppercase",
  "guestDeviceId": "string",
  "conversationId": "string",
  "conversationTokenB64": "base64url",
  "guestBundle": {
    "ikPubB64": "base64",
    "spkPubB64": "base64",
    "signatureB64": "base64",
    "opkId": 1,
    "opkPubB64": "base64",
    "ekPubB64": "base64"
  },
  "guestProfile": {
    "nickname": "string",
    "avatar": { "...": "profile avatar object" },
    "updatedAt": 1700000000,
    "addedAt": 1700000000
  }
}
```

Required fields: `v`, `type`, `guestAccountDigest`, `guestDeviceId`, `conversationId`, `conversationTokenB64`, `guestBundle`, `guestProfile`.

Rules:
- `v` must be `1` and `type` must be `contact-init`.
- `guestProfile` must include at least `nickname` or `avatar`.
- No legacy/alias fields are accepted.

## API Payloads (Single Path)

### POST /api/v1/invites/create

Request JSON:
```
{ "accountToken": "string" }
```

Response JSON:
```
{
  "inviteId": "string",
  "expiresAt": 1700000300,
  "ownerAccountDigest": "64-hex uppercase",
  "ownerDeviceId": "string",
  "ownerPublicKeyB64": "base64",
  "prekeyBundle": { ... }
}
```

### POST /api/v1/invites/deliver

Request JSON:
```
{
  "accountToken": "string",
  "inviteId": "string",
  "ciphertextEnvelope": { ... }
}
```

Response JSON:
```
{ "ok": true }
```

### POST /api/v1/invites/consume

Request JSON:
```
{ "accountToken": "string", "inviteId": "string" }
```

Response JSON:
```
{
  "ok": true,
  "inviteId": "string",
  "expiresAt": 1700000300,
  "ownerDeviceId": "string",
  "ciphertextEnvelope": { ... }
}
```

### POST /api/v1/invites/status

Request JSON:
```
{ "accountToken": "string", "inviteId": "string" }
```

Response JSON:
```
{
  "inviteId": "string",
  "status": "CREATED|DELIVERED|CONSUMED|EXPIRED",
  "expiresAt": 1700000300,
  "createdAt": 1700000000,
  "deliveredAt": 1700000050,
  "consumedAt": 1700000100,
  "deliveredByDigest": "64-hex uppercase or null",
  "deliveredByDeviceId": "string or null",
  "ownerDigest": "64-hex uppercase or null",
  "ownerDeviceId": "string or null",
  "isExpired": false
}
```

## Server Rules

- Invite is single-use for deliver and single-use for consume.
- Expired invites return 410 Gone for deliver/consume.
- Deliver requires a valid `accountToken`; missing/invalid returns 401/403.
- WS is notify-only; recovery is HTTP consume/status.
