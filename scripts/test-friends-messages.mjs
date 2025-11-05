#!/usr/bin/env node
// Two-user lifecycle: register/login, create invite, accept, send secure messages, and verify decrypt.

import { setupFriendConversation } from './lib/friends-flow.mjs';

const ORIGIN_API = (process.env.ORIGIN_API || 'http://127.0.0.1:3000').replace(/\/$/, '');

async function main() {
  console.log('=== Friends & Messages E2E ===');
  const { userA, userB, conversation, bootstrapRecord } = await setupFriendConversation({
    origin: ORIGIN_API,
    messageFromA: 'hello from user A',
    messageFromB: 'reply from user B'
  });
  console.log('User A UID:', userA.uidHex, 'password:', userA.password);
  console.log('User B UID:', userB.uidHex, 'password:', userB.password);
  console.log('Conversation ID:', conversation.conversationId);
  if (bootstrapRecord) {
    console.log('Bootstrap role:', bootstrapRecord.role || '(unknown)');
  }
  console.log('\nALL OK');
}

main().catch((err) => {
  console.error('TEST FAILED:', err?.message || err);
  process.exit(1);
});
