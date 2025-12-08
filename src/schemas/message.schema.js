import { z } from 'zod';

const AccountDigestRegex = /^[0-9A-F]{64}$/;

// Legacy placeholder schema (non-DR media/text)
export const CreateMessageSchema = z.object({
  convId: z.string().min(1),
  type: z.enum(['text', 'media']).default('text'),
  ciphertext_b64: z.string().min(1),
  aead: z.enum(['xchacha20poly1305', 'aes-256-gcm']).default('xchacha20poly1305'),
  header: z.record(z.any()).optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
});

export const CreateSecureMessageSchema = z.object({
  conversation_id: z.string().min(8),
  header_json: z.string().min(2).optional(),
  header: z.record(z.any()).optional(),
  ciphertext_b64: z.string().min(8),
  counter: z.number().int(),
  sender_device_id: z.string().min(1),
  receiver_device_id: z.string().min(1).optional(),
  receiver_account_digest: z.string().regex(AccountDigestRegex).optional(),
  id: z.string().min(8).optional(),
  created_at: z.number().int().optional(),
  accountToken: z.string().min(8).optional(),
  accountDigest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.accountToken && !value.accountDigest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'accountToken or accountDigest required' });
  }
  if (!value.header_json && !value.header) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'header required' });
  }
});
