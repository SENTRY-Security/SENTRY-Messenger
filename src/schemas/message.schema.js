import { z } from 'zod';

const UidHexRegex = /^[0-9A-Fa-f]{14,}$/;
const AccountDigestRegex = /^[0-9A-F]{64}$/;

export const CreateMessageSchema = z.object({
  convId: z.string().min(1),
  type: z.enum(['text', 'media']).default('text'),
  // 注意：實際上你的 payload 會是 ciphertext；這裡先放 placeholder
  ciphertext_b64: z.string().min(1),
  // 例如：XChaCha20-Poly1305 / AES-GCM
  aead: z.enum(['xchacha20poly1305', 'aes-256-gcm']).default('xchacha20poly1305'),
  // AAD/標頭可選
  header: z.record(z.any()).optional(),
  uidHex: z.string().regex(UidHexRegex, 'uidHex must be hex, >=7 bytes'),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationFingerprint: z.string().min(16).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

export const CreateSecureMessageSchema = z.object({
  conversation_id: z.string().min(8),
  payload_envelope: z.object({
    v: z.number().int().min(1).default(1),
    iv_b64: z.string().min(8),
    payload_b64: z.string().min(8)
  }),
  id: z.string().min(8).optional(),
  created_at: z.number().int().optional(),
  uidHex: z.string().regex(UidHexRegex, 'uidHex must be hex, >=7 bytes'),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional(),
  conversationFingerprint: z.string().min(16).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});
