import { z } from 'zod';

const AccountDigestRegex = /^[0-9A-F]{64}$/;

// Legacy placeholder schema (non-DR media/text)
export const CreateMessageSchema = z.object({
  conv_id: z.string().min(1),
  type: z.enum(['text', 'media']).default('text'),
  id: z.string().uuid(),
  ciphertext_b64: z.string().min(1),
  aead: z.enum(['xchacha20poly1305', 'aes-256-gcm']).default('xchacha20poly1305'),
  header_json: z.string().min(2).optional(),
  header: z.record(z.any()).optional(),
  counter: z.number().int(),
  receiver_account_digest: z.string().regex(AccountDigestRegex),
  receiver_device_id: z.string().min(1),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
  }
});

export const CreateSecureMessageSchema = z.object({
  conversation_id: z.string().min(8),
  id: z.string().uuid(),
  header_json: z.string().min(2).optional(),
  header: z.record(z.any()).optional(),
  ciphertext_b64: z.string().min(8),
  counter: z.number().int(),
  sender_device_id: z.string().min(1),
  receiver_device_id: z.string().min(1),
  receiver_account_digest: z.string().regex(AccountDigestRegex).optional(),
  created_at: z.number().int().optional(),
  account_token: z.string().min(8).optional(),
  account_digest: z.string().regex(AccountDigestRegex).optional()
}).superRefine((value, ctx) => {
  if (!value.account_token && !value.account_digest) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'account_token or account_digest required' });
  }
  if (!value.header_json && !value.header) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'header required' });
  }
});
