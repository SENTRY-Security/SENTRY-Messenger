import { z } from 'zod';

export const CreateMessageSchema = z.object({
  convId: z.string().min(1),
  type: z.enum(['text', 'media']).default('text'),
  // 注意：實際上你的 payload 會是 ciphertext；這裡先放 placeholder
  ciphertext_b64: z.string().min(1),
  // 例如：XChaCha20-Poly1305 / AES-GCM
  aead: z.enum(['xchacha20poly1305', 'aes-256-gcm']).default('xchacha20poly1305'),
  // AAD/標頭可選
  header: z.record(z.any()).optional()
});

export const CreateSecureMessageSchema = z.object({
  conversation_id: z.string().min(8),
  payload_envelope: z.object({
    v: z.number().int().min(1).default(1),
    iv_b64: z.string().min(8),
    payload_b64: z.string().min(8)
  }),
  id: z.string().min(8).optional(),
  created_at: z.number().int().optional()
});
