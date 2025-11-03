let dataTablesReady = false;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    const isInternalConv = (value) => {
      const conv = String(value || '');
      return conv.startsWith('contacts-')
        || conv.startsWith('profile-')
        || conv.startsWith('settings-')
        || conv.startsWith('drive-')
        || conv.startsWith('avatar-');
    };

    // HMAC 驗證
    if (!await verifyHMAC(req, env)) {
      return new Response('unauthorized', { status: 401 });
    }

    await ensureDataTables(env);

    // 新增訊息索引
    if (req.method === 'POST' && url.pathname === '/d1/messages') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      if (body && (body.conversation_id || body.conversationId) && (body.payload_envelope || body.payloadEnvelope || body.payload)) {
        const conversationId = normalizeConversationId(body.conversation_id ?? body.conversationId);
        if (!conversationId) {
          return json({ error: 'BadRequest', message: 'invalid conversation_id' }, { status: 400 });
        }

        const envelope = normalizeSecureEnvelope(body.payload_envelope ?? body.payloadEnvelope ?? body.payload);
        if (!envelope) {
          return json({ error: 'BadRequest', message: 'invalid payload_envelope' }, { status: 400 });
        }

        const messageId = typeof body.id === 'string' && body.id.trim().length
          ? body.id.trim()
          : crypto.randomUUID();
        const createdAt = Number(body.created_at || body.ts || 0);
        const ts = Number.isFinite(createdAt) && createdAt > 0
          ? createdAt
          : Math.floor(Date.now() / 1000);

        await env.DB.prepare(`
          DELETE FROM messages
           WHERE conv_id NOT LIKE 'contacts-%'
             AND conv_id NOT LIKE 'profile-%'
             AND conv_id NOT LIKE 'settings-%'
             AND conv_id NOT LIKE 'drive-%'
        `).run();

        await env.DB.prepare(`
          INSERT INTO messages_secure (id, conversation_id, payload_json, created_at)
          VALUES (?1, ?2, ?3, ?4)
        `).bind(
          messageId,
          conversationId,
          JSON.stringify(envelope),
          ts
        ).run();

        return json({ ok: true, id: messageId, created_at: ts });
      }

      const {
        msgId, convId, senderId, type, aead,
        headerJson, objKey, sizeBytes, ts
      } = body || {};

      if (!msgId || !convId || !senderId || !type || !aead || !ts || !isInternalConv(convId)) {
        return json({ error: 'BadRequest', message: 'secure payload required' }, { status: 400 });
      }

      await env.DB.prepare(
        `INSERT OR IGNORE INTO conversations(id) VALUES (?1)`
      ).bind(convId).run();

      await env.DB.prepare(`
        INSERT INTO messages
          (id, conv_id, sender_id, type, aead, header_json, obj_key, size_bytes, ts)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      `).bind(
        msgId, convId, senderId, type, aead, headerJson ?? null,
        objKey ?? null, sizeBytes ?? null, ts
      ).run();

      if (type === 'media') {
        let headerObj = null;
        try {
          headerObj = headerJson ? JSON.parse(headerJson) : (headerJson === null ? null : {});
        } catch {
          headerObj = null;
        }
        const headerObjKey = headerObj && typeof headerObj === 'object' ? headerObj.obj : null;
        const headerSize = headerObj && typeof headerObj === 'object' ? headerObj.size : null;
        const recordedKey = typeof headerObjKey === 'string' && headerObjKey.trim().length ? headerObjKey.trim() : (typeof objKey === 'string' ? objKey : null);
        const recordedSize = (() => {
          const fromHeader = Number(headerSize);
          if (Number.isFinite(fromHeader) && fromHeader >= 0) return fromHeader;
          const fromBody = Number(sizeBytes);
          if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody;
          return null;
        })();
        if (recordedKey) {
          try {
            await env.DB.prepare(`
              INSERT INTO media_objects (obj_key, conv_id, size_bytes, created_at)
              VALUES (?1, ?2, ?3, ?4)
              ON CONFLICT(obj_key) DO UPDATE SET
                conv_id=excluded.conv_id,
                size_bytes=excluded.size_bytes,
                created_at=excluded.created_at
            `).bind(
              recordedKey,
              convId,
              Number.isFinite(recordedSize) ? recordedSize : null,
              ts
            ).run();
          } catch (err) {
            console.warn('media_objects upsert failed', err?.message || err);
          }
        }
      }

      return json({ ok: true, msgId });
    }

    // 查詢訊息（游標=ts）
    if (req.method === 'GET' && url.pathname === '/d1/messages') {
      const secureConversation = url.searchParams.get('conversationId') || url.searchParams.get('conversation_id');
      const cursorTs = Number(url.searchParams.get('cursorTs') || url.searchParams.get('cursor_ts') || 0);
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);

      if (secureConversation) {
        const conversationId = normalizeConversationId(secureConversation);
        if (!conversationId) {
          return json({ error: 'BadRequest', message: 'invalid conversation_id' }, { status: 400 });
        }
        let stmt;
        if (cursorTs) {
          stmt = env.DB.prepare(`
            SELECT id, conversation_id, payload_json, created_at
              FROM messages_secure
             WHERE conversation_id=?1 AND created_at < ?2
             ORDER BY created_at DESC
             LIMIT ?3
          `).bind(conversationId, cursorTs, limit);
        } else {
          stmt = env.DB.prepare(`
            SELECT id, conversation_id, payload_json, created_at
              FROM messages_secure
             WHERE conversation_id=?1
             ORDER BY created_at DESC
             LIMIT ?2
          `).bind(conversationId, limit);
        }
        const { results } = await stmt.all();
        const items = results.map((row) => ({
          id: row.id,
          conversation_id: row.conversation_id,
          payload_envelope: safeJSON(row.payload_json),
          created_at: row.created_at
        }));
        return json({
          items,
          nextCursorTs: results.at(-1)?.created_at ?? null
        });
      }

      const convId = url.searchParams.get('convId');
      if (convId && isInternalConv(convId)) {
        let stmt;
        if (cursorTs) {
          stmt = env.DB.prepare(
            `SELECT * FROM messages
             WHERE conv_id=?1 AND ts < ?2
             ORDER BY ts DESC
             LIMIT ?3`
          ).bind(convId, cursorTs, limit);
        } else {
          stmt = env.DB.prepare(
            `SELECT * FROM messages
             WHERE conv_id=?1
             ORDER BY ts DESC
             LIMIT ?2`
          ).bind(convId, limit);
        }
        const { results } = await stmt.all();
        return json({ items: results, nextCursorTs: results.at(-1)?.ts ?? null });
      }

      return json({ error: 'BadRequest', message: 'conversation_id required' }, { status: 400 });
    }

    // 建立好友邀請
    if (req.method === 'POST' && url.pathname === '/d1/friends/invite') {
      await ensureFriendInviteTable(env);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const inviteId = String(body?.inviteId || '').trim();
      const ownerUid = normalizeUid(body?.ownerUid || body?.owner_uid);
      const secret = String(body?.secret || '').trim();
      const expiresAt = Number(body?.expiresAt || 0);
      const accountTokenRaw = body?.accountToken || body?.account_token || null;
      const accountDigestRaw = body?.accountDigest || body?.account_digest || null;
      const accountToken = typeof accountTokenRaw === 'string' && accountTokenRaw.length ? accountTokenRaw : null;
      const accountDigest = typeof accountDigestRaw === 'string' && accountDigestRaw.length ? String(accountDigestRaw).replace(/[^0-9A-Fa-f]/g, '').toUpperCase() : null;

      if (!inviteId || !ownerUid || !secret || !Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
        return json({ error: 'BadRequest', message: 'invalid invite payload' }, { status: 400 });
      }

      let ownerAccount;
      try {
        ownerAccount = await resolveAccount(env, { uidHex: ownerUid, accountToken, accountDigest }, { allowCreate: !!(accountToken || accountDigest), preferredAccountToken: accountToken, preferredAccountDigest: accountDigest });
      } catch (err) {
        return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }

      if (!ownerAccount) {
        return json({ error: 'AccountNotFound' }, { status: 404 });
      }

      let ownerBundle = normalizeOwnerPrekeyBundle(body?.prekeyBundle || body?.prekey_bundle);
      if (!ownerBundle) {
        ownerBundle = await allocateOwnerPrekeyBundle(env, ownerAccount.account_digest);
        if (!ownerBundle) {
          return json({ error: 'PrekeyUnavailable', message: 'owner prekey bundle unavailable' }, { status: 409 });
        }
      }
      const prekeyBundle = ownerBundle ? JSON.stringify(ownerBundle) : null;
      const channelSeed = body?.channelSeed ? String(body.channelSeed) : null;

      const existingInvite = await env.DB.prepare(
        `SELECT invite_id FROM friend_invites WHERE invite_id=?1`
      ).bind(inviteId).all();

      if (existingInvite?.results?.length) {
        await env.DB.prepare(
          `UPDATE friend_invites
              SET owner_account_digest=?2,
                  owner_uid=?3,
                  secret=?4,
                  expires_at=?5,
                  prekey_bundle=?6,
                  channel_seed=?7,
                  used_at=NULL
            WHERE invite_id=?1`
        ).bind(inviteId, ownerAccount.account_digest, ownerUid, secret, expiresAt, prekeyBundle, channelSeed).run();
      } else {
        await env.DB.prepare(
          `INSERT INTO friend_invites(
              invite_id, owner_account_digest, owner_uid, secret, expires_at,
              prekey_bundle, channel_seed, used_at,
              owner_contact_json, owner_contact_ts,
              guest_account_digest, guest_uid, guest_contact_json, guest_contact_ts, guest_bundle_json, created_at
           )
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL,
                   NULL, NULL,
                   NULL, NULL, NULL, NULL, NULL, strftime('%s','now'))`
        ).bind(inviteId, ownerAccount.account_digest, ownerUid, secret, expiresAt, prekeyBundle, channelSeed).run();
      }

      return json({
        ok: true,
        inviteId,
        expires_at: expiresAt,
        owner_uid: ownerUid,
        owner_account_digest: ownerAccount.account_digest,
        prekey_bundle: ownerBundle
      });
    }

    if (req.method === 'POST' && url.pathname === '/d1/friends/invite/contact') {
      await ensureFriendInviteTable(env);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      const inviteId = String(body?.inviteId || '').trim();
      const secret = String(body?.secret || '').trim();
      const envelope = normalizeEnvelope(body?.envelope);

      if (!inviteId || !secret || !envelope) {
        return json({ error: 'BadRequest', message: 'inviteId, secret and envelope required' }, { status: 400 });
      }

      const sel = await env.DB.prepare(
        `SELECT invite_id, secret, expires_at FROM friend_invites WHERE invite_id=?1`
      ).bind(inviteId).all();
      const row = sel?.results?.[0];
      if (!row) return json({ error: 'NotFound' }, { status: 404 });
      if (row.secret !== secret) return json({ error: 'Forbidden', message: 'secret mismatch' }, { status: 403 });
      const now = Math.floor(Date.now() / 1000);
      if (Number(row.expires_at || 0) < now) return json({ error: 'Expired' }, { status: 410 });

      await env.DB.prepare(
        `UPDATE friend_invites
           SET owner_contact_json=?2,
               owner_contact_ts=?3
         WHERE invite_id=?1`
      ).bind(inviteId, JSON.stringify(envelope), now).run();

      return json({ ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/d1/friends/contact/share') {
      await ensureFriendInviteTable(env);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      const inviteId = String(body?.inviteId || '').trim();
      const secret = String(body?.secret || '').trim();
      const myUid = normalizeUid(body?.myUid || body?.my_uid);
      const accountDigest = normalizeUid(body?.accountDigest || body?.account_digest);
      const peerUidBody = normalizeUid(body?.peerUid || body?.peer_uid);
      const envelope = normalizeEnvelope(body?.envelope);
      if (!inviteId || !secret || !envelope || (!myUid && !accountDigest)) {
        return json({ error: 'BadRequest', message: 'inviteId, secret, sender identity and envelope required' }, { status: 400 });
      }

      const rows = await env.DB.prepare(
        `SELECT invite_id, owner_account_digest, owner_uid, guest_account_digest, guest_uid, secret
         FROM friend_invites
         WHERE invite_id=?1`
      ).bind(inviteId).all();
      const row = rows?.results?.[0];
      if (!row) {
        const fallbackSender = normalizeUid(myUid);
        const fallbackTarget = normalizeUid(peerUidBody);
        if (fallbackSender && fallbackTarget) {
          const ts = Math.floor(Date.now() / 1000);
          await insertContactMessage(env, { convUid: fallbackTarget, peerUid: fallbackSender, envelope, ts });
          return json({ ok: true, targetUid: fallbackTarget, ts, fallback: 'invite_missing' });
        }
        return json({ error: 'NotFound' }, { status: 404 });
      }
      if (row.secret !== secret) return json({ error: 'Forbidden', message: 'secret mismatch' }, { status: 403 });

      const ownerDigest = normalizeUid(row.owner_account_digest);
      const guestDigest = normalizeUid(row.guest_account_digest);
      let ownerUid = normalizeUid(row.owner_uid);
      let guestUid = normalizeUid(row.guest_uid);

      let myUidDigest = null;
      if (myUid) {
        try {
          myUidDigest = await hashUidToDigest(env, myUid);
        } catch (err) {
          console.warn('contact_share_hash_self_failed', err?.message || err);
        }
      }

      let peerUidDigest = null;
      if (peerUidBody) {
        try {
          peerUidDigest = await hashUidToDigest(env, peerUidBody);
        } catch (err) {
          console.warn('contact_share_hash_peer_failed', err?.message || err);
        }
      }

      const fetchUidByDigest = async (digest) => {
        const normalizedDigest = normalizeUid(digest);
        if (!normalizedDigest) return null;
        try {
          const account = await resolveAccount(env, { accountDigest: normalizedDigest });
          const rawUid = account?.uid_plain || account?.uid_hex || account?.uid;
          return normalizeUid(rawUid);
        } catch (err) {
          console.warn('contact_share_resolve_account_failed', err?.message || err);
          return null;
        }
      };

      const updateInviteUid = async (role, value) => {
        const normalized = normalizeUid(value);
        if (!normalized) return null;
        if (role === 'owner') {
          if (ownerUid === normalized) return normalized;
          ownerUid = normalized;
          try {
            await env.DB.prepare(
              `UPDATE friend_invites SET owner_uid=?2 WHERE invite_id=?1 AND (owner_uid IS NULL OR owner_uid='')`
            ).bind(inviteId, ownerUid).run();
          } catch (err) {
            console.warn('contact_share_owner_uid_update_failed', err?.message || err);
          }
          return ownerUid;
        }
        if (guestUid === normalized) return normalized;
        guestUid = normalized;
        try {
          await env.DB.prepare(
            `UPDATE friend_invites SET guest_uid=?2 WHERE invite_id=?1 AND (guest_uid IS NULL OR guest_uid='')`
          ).bind(inviteId, guestUid).run();
        } catch (err) {
          console.warn('contact_share_guest_uid_update_failed', err?.message || err);
        }
        return guestUid;
      };

      let senderRole = null;

      const ensureOwnerUid = async () => {
        if (ownerUid) return ownerUid;
        if (senderRole === 'owner' && myUid) {
          if (!ownerDigest || (myUidDigest && ownerDigest && myUidDigest === ownerDigest) || (accountDigest && ownerDigest && accountDigest === ownerDigest)) {
            return updateInviteUid('owner', myUid);
          }
        }
        if (peerUidBody && peerUidDigest && ownerDigest && peerUidDigest === ownerDigest) {
          return updateInviteUid('owner', peerUidBody);
        }
        const resolved = await fetchUidByDigest(ownerDigest);
        if (resolved) return updateInviteUid('owner', resolved);
        return ownerUid;
      };

      const ensureGuestUid = async () => {
        if (guestUid) return guestUid;
        if (senderRole === 'guest' && myUid) {
          if (!guestDigest || (myUidDigest && guestDigest && myUidDigest === guestDigest) || (accountDigest && guestDigest && accountDigest === guestDigest)) {
            return updateInviteUid('guest', myUid);
          }
        }
        if (peerUidBody && peerUidDigest && guestDigest && peerUidDigest === guestDigest) {
          return updateInviteUid('guest', peerUidBody);
        }
        const resolved = await fetchUidByDigest(guestDigest);
        if (resolved) return updateInviteUid('guest', resolved);
        return guestUid;
      };

      if (!ownerUid) {
        const resolved = await fetchUidByDigest(ownerDigest);
        if (resolved) ownerUid = await updateInviteUid('owner', resolved);
      }
      if (!guestUid) {
        const resolved = await fetchUidByDigest(guestDigest);
        if (resolved) guestUid = await updateInviteUid('guest', resolved);
      }

      if (myUid && ownerUid && myUid === ownerUid) senderRole = 'owner';
      else if (myUid && guestUid && myUid === guestUid) senderRole = 'guest';

      if (!senderRole && accountDigest) {
        if (ownerDigest && accountDigest === ownerDigest) {
          senderRole = 'owner';
          if (!ownerUid && myUid) {
            ownerUid = await updateInviteUid('owner', myUid);
          }
        } else if (guestDigest && accountDigest === guestDigest) {
          senderRole = 'guest';
          if (!guestUid && myUid) {
            guestUid = await updateInviteUid('guest', myUid);
          }
        }
      }

      if (!senderRole && myUidDigest) {
        if (ownerDigest && myUidDigest === ownerDigest) {
          senderRole = 'owner';
          if (!ownerUid && myUid) {
            ownerUid = await updateInviteUid('owner', myUid);
          }
        } else if (guestDigest && myUidDigest === guestDigest) {
          senderRole = 'guest';
          if (!guestUid && myUid) {
            guestUid = await updateInviteUid('guest', myUid);
          }
        }
      }

      if (!senderRole && peerUidDigest) {
        if (ownerDigest && peerUidDigest === ownerDigest) {
          senderRole = 'guest';
          if (!guestUid && peerUidBody) {
            guestUid = await updateInviteUid('guest', peerUidBody);
          }
        } else if (guestDigest && peerUidDigest === guestDigest) {
          senderRole = 'owner';
          if (!ownerUid && peerUidBody) {
            ownerUid = await updateInviteUid('owner', peerUidBody);
          }
        }
      }

      if (!senderRole && myUid) {
        try {
          const account = await resolveAccount(env, { uidHex: myUid });
          const acctDigest = normalizeUid(account?.account_digest);
          if (acctDigest && ownerDigest && acctDigest === ownerDigest) {
            senderRole = 'owner';
            if (!ownerUid) {
              ownerUid = await updateInviteUid('owner', myUid);
            }
          } else if (acctDigest && guestDigest && acctDigest === guestDigest) {
            senderRole = 'guest';
            if (!guestUid) {
              guestUid = await updateInviteUid('guest', myUid);
            }
          }
        } catch (err) {
          console.warn('contact_share_resolve_self_failed', err?.message || err);
        }
      }

      if (!senderRole && peerUidBody) {
        const normalizedPeer = normalizeUid(peerUidBody);
        if (normalizedPeer && ownerUid && normalizedPeer === ownerUid) {
          senderRole = 'guest';
          if (!guestUid && myUid) {
            guestUid = await updateInviteUid('guest', myUid);
          }
        } else if (normalizedPeer && guestUid && normalizedPeer === guestUid) {
          senderRole = 'owner';
          if (!ownerUid && myUid) {
            ownerUid = await updateInviteUid('owner', myUid);
          }
        }
      }

      if (!senderRole) {
        return json({ error: 'Forbidden', message: 'sender not part of invite' }, { status: 403 });
      }

      const resolvedOwnerUid = await ensureOwnerUid();
      const resolvedGuestUid = await ensureGuestUid();

      const senderUid = senderRole === 'owner' ? resolvedOwnerUid : resolvedGuestUid;
      let targetUid = senderRole === 'owner' ? resolvedGuestUid : resolvedOwnerUid;

      if (!senderUid) {
        return json({ error: 'Conflict', message: 'sender uid unresolved' }, { status: 409 });
      }

      if (!targetUid && peerUidBody) {
        const expectedDigest = senderRole === 'owner' ? guestDigest : ownerDigest;
        if (!expectedDigest) {
          targetUid = peerUidBody;
        } else if (peerUidDigest && peerUidDigest === expectedDigest) {
          targetUid = peerUidBody;
        }
      }

      if (!targetUid) {
        const fallbackDigest = senderRole === 'owner' ? guestDigest : ownerDigest;
        const fetched = await fetchUidByDigest(fallbackDigest);
        if (fetched) {
          if (senderRole === 'owner') {
            await updateInviteUid('guest', fetched);
          } else {
            await updateInviteUid('owner', fetched);
          }
          targetUid = fetched;
        }
      }

      if (!targetUid) {
        return json({ error: 'Conflict', message: 'friendship not established' }, { status: 409 });
      }

      const ts = Math.floor(Date.now() / 1000);
      await insertContactMessage(env, { convUid: targetUid, peerUid: senderUid, envelope, ts });

      return json({ ok: true, targetUid, ts });
    }

    if (req.method === 'POST' && url.pathname === '/d1/friends/contact-delete') {
      await ensureFriendInviteTable(env);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      const ownerUid = normalizeUid(body?.ownerUid || body?.owner_uid);
      const peerUid = normalizeUid(body?.peerUid || body?.peer_uid);
      if (!ownerUid || !peerUid) {
        return json({ error: 'BadRequest', message: 'ownerUid & peerUid required' }, { status: 400 });
      }

      const ownerDigests = new Set();
      const peerDigests = new Set();
      const ownerDigestBody = normalizeUid(body?.ownerAccountDigest || body?.owner_account_digest);
      const peerDigestBody = normalizeUid(body?.peerAccountDigest || body?.peer_account_digest);
      if (ownerDigestBody) {
        ownerDigests.add(ownerDigestBody);
      }
      if (peerDigestBody) {
        peerDigests.add(peerDigestBody);
      }

      try {
        const rel = await env.DB.prepare(
          `SELECT owner_uid, guest_uid, owner_account_digest, guest_account_digest
             FROM friend_invites
            WHERE (owner_uid=?1 AND guest_uid=?2)
               OR (owner_uid=?2 AND guest_uid=?1)`
        ).bind(ownerUid, peerUid).all();
        for (const row of rel?.results || []) {
          const ownerRowUid = normalizeUid(row.owner_uid);
          const guestRowUid = normalizeUid(row.guest_uid);
          if (ownerRowUid === ownerUid && guestRowUid === peerUid) {
            const ownerDigest = normalizeUid(row.owner_account_digest);
            if (ownerDigest) ownerDigests.add(ownerDigest);
            const peerDigest = normalizeUid(row.guest_account_digest);
            if (peerDigest) peerDigests.add(peerDigest);
          } else if (ownerRowUid === peerUid && guestRowUid === ownerUid) {
            const peerDigest = normalizeUid(row.owner_account_digest);
            if (peerDigest) peerDigests.add(peerDigest);
            const ownerDigest = normalizeUid(row.guest_account_digest);
            if (ownerDigest) ownerDigests.add(ownerDigest);
          }
        }
      } catch {
        // ignore lookup failures; proceed with provided identifiers
      }

      try {
        const ownerAccount = await resolveAccount(env, { uidHex: ownerUid });
        const digest = normalizeUid(ownerAccount?.account_digest);
        if (digest) ownerDigests.add(digest);
      } catch {
        // ignore missing account; allow deletion to continue
      }

      try {
        const peerAccount = await resolveAccount(env, { uidHex: peerUid });
        const digest = normalizeUid(peerAccount?.account_digest);
        if (digest) peerDigests.add(digest);
      } catch {
        // ignore missing account; allow deletion to continue
      }

      try {
        const ownerDerived = await hashUidToDigest(env, ownerUid);
        const norm = normalizeUid(ownerDerived);
        if (norm) ownerDigests.add(norm);
      } catch {
        // ignore hashing failures
      }

      try {
        const peerDerived = await hashUidToDigest(env, peerUid);
        const norm = normalizeUid(peerDerived);
        if (norm) peerDigests.add(norm);
      } catch {
        // ignore hashing failures
      }

      const results = [];
      const now = Math.floor(Date.now() / 1000);

      const targets = new Map();
      const addTarget = (convId, targetUid) => {
        if (!convId || !targetUid) return;
        const key = `${convId}::${targetUid}`;
        if (!targets.has(key)) targets.set(key, { convId, targetUid });
      };

      addTarget(`contacts-${ownerUid}`, peerUid);
      if (ownerDigestBody) addTarget(`contacts-${ownerDigestBody}`, peerUid);
      for (const digest of ownerDigests) addTarget(`contacts-${digest}`, peerUid);

      if (peerUid !== ownerUid) {
        addTarget(`contacts-${peerUid}`, ownerUid);
        if (peerDigestBody) addTarget(`contacts-${peerDigestBody}`, ownerUid);
        for (const digest of peerDigests) addTarget(`contacts-${digest}`, ownerUid);
      }

      const targetList = Array.from(targets.values());
      for (const entry of targetList) {
        const removed = await deleteContactByPeer(env, entry.convId, entry.targetUid);
        results.push({ convId: entry.convId, removed });
      }

      return json({ ok: true, ts: now, results });
    }

    if (req.method === 'POST' && url.pathname === '/d1/friends/accept') {
      await ensureFriendInviteTable(env);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const inviteId = String(body?.inviteId || '').trim();
      const secret = String(body?.secret || '').trim();
      const guestUid = normalizeUid(body?.guestUid || body?.myUid);
      const guestContact = normalizeEnvelope(body?.guestContact || body?.guest_contact);
      const guestBundle = normalizeGuestBundle(body?.guestBundle || body?.guest_bundle);
      if (!inviteId || !secret) {
        return json({ error: 'BadRequest', message: 'inviteId & secret required' }, { status: 400 });
      }

      const rows = await env.DB.prepare(
        `SELECT invite_id, owner_account_digest, owner_uid, secret, expires_at, used_at, prekey_bundle, channel_seed,
                owner_contact_json, owner_contact_ts, guest_account_digest, guest_uid, guest_contact_json, guest_contact_ts, guest_bundle_json
         FROM friend_invites WHERE invite_id=?1`
      ).bind(inviteId).all();
      const row = rows?.results?.[0];
      if (!row) return json({ error: 'NotFound' }, { status: 404 });
      if (row.secret !== secret) return json({ error: 'Forbidden', message: 'secret mismatch' }, { status: 403 });
      const now = Math.floor(Date.now() / 1000);
      if (row.expires_at < now) return json({ error: 'Expired' }, { status: 410 });
      if (row.used_at) return json({ error: 'AlreadyUsed' }, { status: 409 });

      let guestAccount = null;
      if (guestUid) {
        try {
          guestAccount = await resolveAccount(env, { uidHex: guestUid });
        } catch (err) {
          return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
        }
        if (!guestAccount) {
          return json({ error: 'AccountNotFound' }, { status: 404 });
        }
      }

      await env.DB.prepare(
        `UPDATE friend_invites
            SET used_at=?2,
                guest_account_digest=?3,
                guest_uid=?4,
                guest_contact_json=COALESCE(?5, guest_contact_json),
                guest_contact_ts=CASE WHEN ?5 IS NOT NULL THEN ?2 ELSE guest_contact_ts END,
                guest_bundle_json=COALESCE(?6, guest_bundle_json)
          WHERE invite_id=?1`
      ).bind(
        inviteId,
        now,
        guestAccount ? guestAccount.account_digest : null,
        guestUid || null,
        guestContact ? JSON.stringify(guestContact) : null,
        guestBundle ? JSON.stringify(guestBundle) : null
      ).run();

      let bundle = null;
      try { bundle = row.prekey_bundle ? JSON.parse(row.prekey_bundle) : null; } catch { bundle = null; }

      let ownerContact = null;
      if (row.owner_contact_json) {
        try { ownerContact = JSON.parse(row.owner_contact_json); } catch { ownerContact = null; }
      }

      let guestContactStored = !!row.guest_contact_json;
      if (guestContact && !guestContactStored) guestContactStored = true;

      const guestEnvelope = guestContact || (row.guest_contact_json ? safeParseEnvelope(row.guest_contact_json) : null);
      const ownerEnvelope = ownerContact ? normalizeEnvelope(ownerContact) : null;

      if (guestEnvelope && row.owner_uid && guestUid) {
        await insertContactMessage(env, {
          convUid: row.owner_uid,
          peerUid: guestUid,
          envelope: guestEnvelope,
          ts: now
        });
      }

      if (ownerEnvelope && guestUid) {
        await insertContactMessage(env, {
          convUid: guestUid,
          peerUid: row.owner_uid,
          envelope: ownerEnvelope,
          ts: now
        });
      }

      return json({
        ok: true,
        owner_uid: row.owner_uid,
        owner_account_digest: row.owner_account_digest,
        guest_account_digest: guestAccount ? guestAccount.account_digest : row.guest_account_digest || null,
        expires_at: row.expires_at,
        owner_prekey_bundle: bundle,
        channel_seed: row.channel_seed,
        owner_contact: ownerContact,
        owner_contact_ts: row.owner_contact_ts || null,
        guest_contact_stored: guestContactStored
      });
    }

    // 刪除整個 secure conversation（雙邊隱匿訊息）
    if (req.method === 'POST' && url.pathname === '/d1/messages/secure/delete-conversation') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
      if (!conversationId) {
        return json({ error: 'BadRequest', message: 'conversationId required' }, { status: 400 });
      }

      try {
        await resolveAccount(env, {
          accountToken: body.accountToken,
          accountDigest: body.accountDigest,
          uidHex: body.uidHex
        });
      } catch (err) {
        console.warn('secure_delete_conversation_resolve_failed', err?.message || err);
      }

      await ensureDataTables(env);

      let deletedSecure = 0;
      let deletedGeneral = 0;
      try {
        const resSecure = await env.DB.prepare(
          `DELETE FROM messages_secure WHERE conversation_id=?1`
        ).bind(conversationId).run();
        deletedSecure = resSecure?.meta?.changes || 0;
      } catch (err) {
        console.warn('delete secure conversation failed', err?.message || err);
      }

      try {
        const resGeneral = await env.DB.prepare(
          `DELETE FROM messages WHERE conv_id=?1`
        ).bind(conversationId).run();
        deletedGeneral = resGeneral?.meta?.changes || 0;
      } catch (err) {
        console.warn('delete general conversation failed', err?.message || err);
      }

      try {
        await env.DB.prepare(
          `DELETE FROM conversations WHERE id=?1`
        ).bind(conversationId).run();
      } catch (err) {
        console.warn('delete conversations row failed', err?.message || err);
      }

      return json({ ok: true, deleted_secure: deletedSecure, deleted_general: deletedGeneral, conversation_id: conversationId });
    }

    // 批次刪除訊息（依 obj_key）
    if (req.method === 'POST' && url.pathname === '/d1/messages/delete') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const ids = Array.isArray(body?.ids)
        ? Array.from(new Set(body.ids.map((k) => String(k || '').trim()).filter(Boolean)))
        : [];
      if (!ids.length) {
        return json({ error: 'BadRequest', message: 'ids required' }, { status: 400 });
      }

      const results = [];
      for (const id of ids) {
        let secureCount = 0;
        try {
          const resSecure = await env.DB.prepare(
            `DELETE FROM messages_secure WHERE id=?1`
          ).bind(id).run();
          secureCount = resSecure?.meta?.changes || 0;
        } catch (err) {
          console.warn('delete messages_secure failed', err);
        }

        let generalCount = 0;
        let mediaCount = 0;
        try {
          const row = await env.DB.prepare(
            `SELECT obj_key FROM messages WHERE id=?1`
          ).bind(id).all();
          const objKey = row?.results?.[0]?.obj_key || null;
          const resGeneral = await env.DB.prepare(
            `DELETE FROM messages WHERE id=?1`
          ).bind(id).run();
          generalCount = resGeneral?.meta?.changes || 0;
          if (objKey) {
            const resMedia = await env.DB.prepare(
              `DELETE FROM media_objects WHERE obj_key=?1`
            ).bind(objKey).run();
            mediaCount = resMedia?.meta?.changes || 0;
          }
        } catch (err) {
          console.warn('delete messages/media failed', err);
        }

        results.push({ id, secure: secureCount, general: generalCount, media: mediaCount });
      }

      return json({ ok: true, results });
    }

    if (req.method === 'POST' && url.pathname === '/d1/media/usage') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const convIdRaw = body?.convId ?? body?.conversationId;
      if (!convIdRaw || typeof convIdRaw !== 'string') {
        return json({ error: 'BadRequest', message: 'convId required' }, { status: 400 });
      }
      const convId = normalizeConversationId(convIdRaw);
      if (!convId) {
        return json({ error: 'BadRequest', message: 'invalid convId' }, { status: 400 });
      }
      const prefixRaw = typeof body?.prefix === 'string' ? body.prefix.trim() : '';
      let prefix = prefixRaw || convId;
      prefix = prefix.replace(/[\u0000-\u001F\u007F]/gu, '');
      if (!prefix.startsWith(convId)) {
        prefix = convId;
      }
      const ensureSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const rangeStart = ensureSlash;
      // 將上界設為 prefix + U+FFFF，確保涵蓋所有以 prefix 開頭的 obj_key
      const rangeEnd = `${ensureSlash}\uFFFF`;
      let totalBytes = 0;
      let objectCount = 0;
      try {
        const stmt = await env.DB.prepare(`
          SELECT
            COALESCE(SUM(COALESCE(size_bytes, 0)), 0) AS total_bytes,
            COUNT(*) AS object_count
          FROM media_objects
          WHERE conv_id=?1
            AND obj_key >= ?2
            AND obj_key < ?3
        `).bind(convId, rangeStart, rangeEnd).all();
        const row = stmt?.results?.[0] || null;
        totalBytes = Number(row?.total_bytes ?? 0);
        objectCount = Number(row?.object_count ?? 0);
      } catch (err) {
        console.warn('media usage query failed', err?.message || err);
        return json({ error: 'UsageQueryFailed', message: err?.message || 'media usage query failed' }, { status: 500 });
      }
      return json({
        ok: true,
        convId,
        prefix,
        totalBytes,
        objectCount
      });
    }

    if (req.method === 'POST' && url.pathname === '/d1/accounts/verify') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const uidHex = normalizeUid(body?.uidHex || body?.uid_hex || body?.uid);
      if (!uidHex) {
        return json({ error: 'BadRequest', message: 'uidHex required' }, { status: 400 });
      }
      const accountTokenRaw = body?.accountToken || body?.account_token;
      const accountDigestRaw = body?.accountDigest || body?.account_digest;
      const accountToken = typeof accountTokenRaw === 'string' && accountTokenRaw.trim().length ? accountTokenRaw.trim() : null;
      const accountDigest = typeof accountDigestRaw === 'string' && accountDigestRaw.trim().length ? accountDigestRaw.trim() : null;
      if (!accountToken && !accountDigest) {
        return json({ error: 'BadRequest', message: 'accountToken or accountDigest required' }, { status: 400 });
      }
      try {
        const account = await resolveAccount(env, { uidHex, accountToken, accountDigest }, { allowCreate: false, preferredAccountToken: accountToken || null, preferredAccountDigest: accountDigest || null });
        if (!account) {
          return json({ error: 'NotFound' }, { status: 404 });
        }
        if (accountToken && account.account_token !== accountToken) {
          return json({ error: 'Forbidden', message: 'account token mismatch' }, { status: 403 });
        }
        const normalizedUid = normalizeUid(account.uid_plain || uidHex);
        if (normalizedUid !== uidHex) {
          return json({ error: 'Forbidden', message: 'uid mismatch' }, { status: 403 });
        }
        return json({
          ok: true,
          uid_hex: normalizedUid,
          account_digest: account.account_digest
        });
      } catch (err) {
        return json({ error: 'VerifyFailed', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }
    }

    // 交換：建立 / 更新 account、檢查 counter、回傳 MK 包裝資訊
    if (req.method === 'POST' && url.pathname === '/d1/tags/exchange') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const uidHex = normalizeUid(body.uidHex || body.uid);
      if (!uidHex) {
        return json({ error: 'BadRequest', message: 'uidHex required (7-byte UID hex)' }, { status: 400 });
      }
      const ctrNum = Number(body.ctr ?? body.counter ?? body.sdmcounter ?? 0);
      if (!Number.isFinite(ctrNum) || ctrNum < 0) {
        return json({ error: 'BadRequest', message: 'ctr must be a non-negative number' }, { status: 400 });
      }

      let account;
      try {
        account = await resolveAccount(env, { uidHex }, { allowCreate: true });
      } catch (err) {
        return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }

      if (!account) {
        return json({ error: 'AccountCreateFailed' }, { status: 500 });
      }

      if (!account.newlyCreated && !(ctrNum > account.last_ctr)) {
        return json({ error: 'Replay', message: 'counter must be strictly increasing', lastCtr: account.last_ctr }, { status: 409 });
      }

      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare(
        `UPDATE accounts
            SET last_ctr=?2,
                uid_plain=COALESCE(uid_plain, ?3),
                updated_at=?4
          WHERE account_digest=?1`
      ).bind(account.account_digest, ctrNum, uidHex, now).run();

      const hasMK = !!account.wrapped_mk_json;
      let wrapped;
      if (hasMK) {
        try {
          wrapped = JSON.parse(account.wrapped_mk_json);
        } catch {
          wrapped = null;
        }
      }

      return json({
        hasMK,
        wrapped_mk: wrapped || undefined,
        account_token: account.account_token,
        account_digest: account.account_digest,
        uid_digest: account.uid_digest,
        newly_created: account.newlyCreated
      });
    }

    // 首次設定：儲存 wrapped_mk
    if (req.method === 'POST' && url.pathname === '/d1/tags/store-mk') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      if (!body.wrapped_mk || typeof body.wrapped_mk !== 'object') {
        return json({ error: 'BadRequest', message: 'wrapped_mk object required' }, { status: 400 });
      }

      let account;
      try {
        account = await resolveAccount(env, {
          accountToken: body.accountToken,
          accountDigest: body.accountDigest,
          uidHex: body.uidHex
        });
      } catch (err) {
        return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }

      if (!account) {
        return json({ error: 'AccountNotFound' }, { status: 404 });
      }

      await env.DB.prepare(
        `UPDATE accounts
            SET wrapped_mk_json=?2,
                updated_at=?3
          WHERE account_digest=?1`
      ).bind(account.account_digest, JSON.stringify(body.wrapped_mk), Math.floor(Date.now() / 1000)).run();

      return new Response(null, { status: 204 });
    }

    // 發佈使用者的 Prekey Bundle（IK/SPK 以及一批 OPKs）
    if (req.method === 'POST' && url.pathname === '/d1/prekeys/publish') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      const b = body.bundle || {};
      const { ik_pub, spk_pub, spk_sig } = b;
      const hasUserBundle = !!(ik_pub && spk_pub && spk_sig);

      let account;
      try {
        account = await resolveAccount(env, {
          accountToken: body.accountToken,
          accountDigest: body.accountDigest,
          uidHex: body.uidHex
        });
      } catch (err) {
        return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }

      if (!account) {
        return json({ error: 'AccountNotFound' }, { status: 404 });
      }

      const acctDigest = account.account_digest;
      let existingUserRow = null;
      try {
        const existing = await env.DB.prepare(
          `SELECT ik_pub FROM prekey_users WHERE account_digest=?1`
        ).bind(acctDigest).all();
        existingUserRow = existing?.results && existing.results.length > 0 ? existing.results[0] : null;
      } catch (err) {
        console.warn('prekey_users lookup failed', err?.message || err);
        return json({ error: 'PrekeyLookupFailed', message: err?.message || 'failed to lookup prekey user' }, { status: 500 });
      }

      // 如果帶了 IK/SPK/SPK_SIG ⇒ upsert prekey_users；否則允許只帶 OPKs（補貨）
      if (hasUserBundle) {
        // upsert prekey_users
        const upd = await env.DB.prepare(
          `UPDATE prekey_users
             SET ik_pub=?2, spk_pub=?3, spk_sig=?4, updated_at=strftime('%s','now')
           WHERE account_digest=?1`
        ).bind(acctDigest, String(ik_pub), String(spk_pub), String(spk_sig)).run();

        if (!upd || (upd.meta && upd.meta.changes === 0)) {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO prekey_users
               (account_digest, ik_pub, spk_pub, spk_sig)
             VALUES (?1, ?2, ?3, ?4)`
          ).bind(acctDigest, String(ik_pub), String(spk_pub), String(spk_sig)).run();
        }
        existingUserRow = { ik_pub: String(ik_pub) };
      }

      // 批次寫入 OPKs（INSERT OR IGNORE）
      const opks = Array.isArray(b.opks) ? b.opks : [];
      if (!hasUserBundle && opks.length === 0) {
        return json({ error: 'BadRequest', message: 'bundle requires either ik/spk/spk_sig or at least one opk' }, { status: 400 });
      }
      if (!hasUserBundle && !existingUserRow) {
        return json({ error: 'PrekeyUnavailable', message: 'owner bundle missing; publish with IK/SPK first' }, { status: 409 });
      }
      for (const it of opks) {
        if (!it) continue;
        const id = Number(it.id);
        const pub = it.pub != null ? String(it.pub) : null;
        if (!Number.isFinite(id) || !pub) continue;
        await env.DB.prepare(
          `INSERT OR IGNORE INTO prekey_opk (account_digest, opk_id, opk_pub)
           VALUES (?1, ?2, ?3)`
        ).bind(acctDigest, id, pub).run();
      }

      return new Response(null, { status: 204 });
    }

    // 取對端的 Prekey Bundle（並消耗一支 OPK，如有）
    if (req.method === 'POST' && url.pathname === '/d1/prekeys/bundle') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      let account;
      try {
        account = await resolveAccount(env, {
          accountToken: body.accountToken,
          accountDigest: body.accountDigest,
          uidHex: body.peer_uidHex || body.peerUid || body.uidHex
        });
      } catch (err) {
        return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }

      if (!account) {
        return json({ error: 'NotFound', message: 'prekey user not found' }, { status: 404 });
      }

      // 讀 prekey_users
      const u = await env.DB.prepare(
        `SELECT ik_pub, spk_pub, spk_sig FROM prekey_users WHERE account_digest=?1`
      ).bind(account.account_digest).all();

      if (!u.results || u.results.length === 0) {
        return json({ error: 'NotFound', message: 'prekey user not found' }, { status: 404 });
      }
      const user = u.results[0];

      // 取一支未使用的 OPK
      const opkSel = await env.DB.prepare(
        `SELECT opk_id, opk_pub FROM prekey_opk
          WHERE account_digest=?1 AND used=0
          ORDER BY opk_id ASC LIMIT 1`
      ).bind(account.account_digest).all();

      let opk = null;
      if (opkSel.results && opkSel.results.length > 0) {
        const row = opkSel.results[0];
        // 標記為已使用
        await env.DB.prepare(
          `UPDATE prekey_opk SET used=1 WHERE account_digest=?1 AND opk_id=?2`
        ).bind(account.account_digest, row.opk_id).run();
        opk = { id: row.opk_id, pub: row.opk_pub };
      }

      return json({
        ik_pub: user.ik_pub,
        spk_pub: user.spk_pub,
        spk_sig: user.spk_sig,
        opk
      });
    }

    // 儲存裝置私鑰密文備份（wrapped_device_keys）
    if (req.method === 'POST' && url.pathname === '/d1/devkeys/store') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      if (!body.wrapped_dev || typeof body.wrapped_dev !== 'object') {
        return json({ error: 'BadRequest', message: 'wrapped_dev object required' }, { status: 400 });
      }

      let account;
      try {
        account = await resolveAccount(env, {
          accountToken: body.accountToken,
          accountDigest: body.accountDigest,
          uidHex: body.uidHex
        });
      } catch (err) {
        return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }

      if (!account) {
        return json({ error: 'AccountNotFound' }, { status: 404 });
      }

      // UPSERT device_backup
      // Try update; if no row, insert
      const upd = await env.DB.prepare(
        `UPDATE device_backup
           SET wrapped_dev_json=?2, updated_at=strftime('%s','now')
         WHERE account_digest=?1`
      ).bind(account.account_digest, JSON.stringify(body.wrapped_dev)).run();

      if (!upd || (upd.meta && upd.meta.changes === 0)) {
        await env.DB.prepare(
          `INSERT INTO device_backup (account_digest, wrapped_dev_json)
           VALUES (?1, ?2)`
        ).bind(account.account_digest, JSON.stringify(body.wrapped_dev)).run();
      }

      return new Response(null, { status: 204 });
    }

    // 讀取裝置私鑰密文備份（wrapped_device_keys）
    if (req.method === 'POST' && url.pathname === '/d1/devkeys/fetch') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }

      let account;
      try {
        account = await resolveAccount(env, {
          accountToken: body.accountToken,
          accountDigest: body.accountDigest,
          uidHex: body.uidHex
        });
      } catch (err) {
        return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
      }

      if (!account) {
        return json({ error: 'NotFound' }, { status: 404 });
      }

      const sel = await env.DB.prepare(
        `SELECT wrapped_dev_json FROM device_backup WHERE account_digest=?1`
      ).bind(account.account_digest).all();

      if (!sel.results || sel.results.length === 0) {
        return json({ error: 'NotFound' }, { status: 404 });
      }
      const wrapped = JSON.parse(sel.results[0].wrapped_dev_json);
      return json({ wrapped_dev: wrapped });
    }

    // OPAQUE: store registration record
    if (req.method === 'POST' && url.pathname === '/d1/opaque/store') {
      let body; try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }
      const acct = String(body?.accountDigest || body?.account_digest || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
      const record_b64 = typeof body?.record_b64 === 'string' ? body.record_b64.trim() : '';
      const client_identity = typeof body?.client_identity === 'string' ? body.client_identity : null;
      if (!acct || acct.length !== 64 || !record_b64) {
        return json({ error: 'BadRequest', message: 'accountDigest(64 hex) and record_b64 required' }, { status: 400 });
      }
      await env.DB.prepare(
        `INSERT INTO opaque_records (account_digest, record_b64, client_identity)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(account_digest) DO UPDATE SET record_b64=excluded.record_b64, client_identity=excluded.client_identity, updated_at=strftime('%s','now')`
      ).bind(acct, record_b64, client_identity).run();
      return new Response(null, { status: 204 });
    }

    // OPAQUE: fetch registration record
    if (req.method === 'POST' && url.pathname === '/d1/opaque/fetch') {
      let body; try { body = await req.json(); } catch { return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 }); }
      const acct = String(body?.accountDigest || body?.account_digest || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
      if (!acct || acct.length !== 64) {
        return json({ error: 'BadRequest', message: 'accountDigest(64 hex) required' }, { status: 400 });
      }
      const rs = await env.DB.prepare(`SELECT record_b64, client_identity FROM opaque_records WHERE account_digest=?1`).bind(acct).all();
      const row = rs?.results?.[0];
      if (!row) return json({ error: 'NotFound' }, { status: 404 });
      return json({ account_digest: acct, record_b64: row.record_b64, client_identity: row.client_identity || null });
    }

    return new Response('not_found', { status: 404 });
  }
};

function json(obj, init) {
  return new Response(JSON.stringify(obj), {
    ...(init || {}),
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

let friendInviteTableReady = false;
async function ensureFriendInviteTable(env) {
  if (friendInviteTableReady) return;
  await ensureDataTables(env);
  friendInviteTableReady = true;
}

function normalizeEnvelope(input) {
  if (!input || typeof input !== 'object') return null;
  const iv = typeof input.iv === 'string' ? input.iv.trim() : '';
  const ct = typeof input.ct === 'string' ? input.ct.trim() : '';
  if (!iv || !ct) return null;
  if (iv.length < 8 || ct.length < 8) return null;
  return { iv, ct };
}

function safeParseEnvelope(json) {
  try {
    const obj = typeof json === 'string' ? JSON.parse(json) : json;
    return normalizeEnvelope(obj);
  } catch {
    return null;
  }
}

function safeJSON(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

function normalizeConversationId(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
  return token;
}

function normalizeSecureEnvelope(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const v = Number(obj.v ?? 1);
  const iv = String(obj.iv_b64 || obj.ivB64 || '').trim();
  const payload = String(obj.payload_b64 || obj.payloadB64 || obj.payload || '').trim();
  if (!iv || !payload) return null;
  return { v, iv_b64: iv, payload_b64: payload };
}

function normalizeUid(uid) {
  const cleaned = String(uid || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return cleaned.length >= 14 ? cleaned : null;
}

function bytesToHex(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 1) {
    out += u8[i].toString(16).padStart(2, '0');
  }
  return out.toUpperCase();
}

function hexToBytes(hex) {
  const cleaned = String(hex || '').replace(/[^0-9A-Fa-f]/g, '');
  if (cleaned.length % 2 === 1) throw new Error('hexToBytes: invalid length');
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return out;
}

function bytesToBase64Url(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) {
    bin += String.fromCharCode(u8[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function deleteContactByPeer(env, convId, targetUid) {
  if (!convId || !targetUid) return 0;
  const stmt = env.DB.prepare(`
    DELETE FROM messages
     WHERE conv_id=?1
       AND json_extract(header_json,'$.contact') = 1
       AND UPPER(json_extract(header_json,'$.peerUid')) = ?2
  `).bind(convId, targetUid.toUpperCase());
  const res = await stmt.run();
  return res?.meta?.changes || 0;
}

async function insertContactMessage(env, { convUid, peerUid, envelope, ts }) {
  await ensureDataTables(env);
  const normalized = normalizeEnvelope(envelope);
  if (!normalized) return;
  const convId = `contacts-${String(convUid).toUpperCase()}`;
  const msgId = crypto.randomUUID();
  const header = {
    contact: 1,
    v: 1,
    peerUid: String(peerUid || '').toUpperCase(),
    ts,
    envelope: normalized
  };
  const headerJson = JSON.stringify(header);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO conversations(id) VALUES (?1)`
  ).bind(convId).run();
  await env.DB.prepare(`
    INSERT INTO messages
      (id, conv_id, sender_id, type, aead, header_json, obj_key, size_bytes, ts)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7)
  `).bind(
    msgId,
    convId,
    'contacts-system',
    'text',
    'aes-256-gcm',
    headerJson,
    ts
  ).run();
}

function normalizeOwnerPrekeyBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const ik = String(bundle.ik_pub || bundle.ik || '').trim();
  const spk = String(bundle.spk_pub || bundle.spk || '').trim();
  const sig = String(bundle.spk_sig || '').trim();
  if (!ik || !spk || !sig) return null;
  let opk = null;
  if (bundle.opk && typeof bundle.opk === 'object') {
    const idNum = Number(bundle.opk.id ?? bundle.opk.opk_id);
    const pub = String(bundle.opk.pub || bundle.opk.opk_pub || '').trim();
    if (pub) {
      opk = { id: Number.isFinite(idNum) ? idNum : null, pub };
    }
  }
  return opk ? { ik_pub: ik, spk_pub: spk, spk_sig: sig, opk } : { ik_pub: ik, spk_pub: spk, spk_sig: sig, opk: null };
}

const textEncoder = new TextEncoder();
let accountKeyHexCache = null;
let accountKeyCryptoCache = null;

async function getAccountHmacCryptoKey(env) {
  const keyHex = String(env.ACCOUNT_HMAC_KEY || '').trim();
  if (!/^[0-9A-Fa-f]{64}$/.test(keyHex)) {
    throw new Error('ACCOUNT_HMAC_KEY missing or invalid (expect 64 hex chars)');
  }
  if (accountKeyHexCache === keyHex && accountKeyCryptoCache) return accountKeyCryptoCache;
  const key = await crypto.subtle.importKey(
    'raw', hexToBytes(keyHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  accountKeyHexCache = keyHex;
  accountKeyCryptoCache = key;
  return key;
}

async function hashUidToDigest(env, uidHex) {
  const normalized = normalizeUid(uidHex);
  if (!normalized) {
    throw new Error('hashUidToDigest: invalid uid');
  }
  const key = await getAccountHmacCryptoKey(env);
  const mac = await crypto.subtle.sign('HMAC', key, textEncoder.encode(normalized));
  return bytesToHex(new Uint8Array(mac));
}

function accountTokenLength(env) {
  const n = Number.parseInt(env.ACCOUNT_TOKEN_BYTES || '32', 10);
  if (Number.isFinite(n) && n > 0 && n <= 64) return n;
  return 32;
}

function generateAccountToken(env) {
  const raw = new Uint8Array(accountTokenLength(env));
  crypto.getRandomValues(raw);
  return bytesToBase64Url(raw);
}

async function digestAccountToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(String(token || '')));
  return bytesToHex(new Uint8Array(digest));
}

async function resolveAccount(env, { uidHex, accountToken, accountDigest } = {}, { allowCreate = false, preferredAccountToken = null, preferredAccountDigest = null } = {}) {
  const db = env.DB;
  const normalizedUid = uidHex ? normalizeUid(uidHex) : null;
  let uidDigest = null;

  if (normalizedUid) {
    uidDigest = await hashUidToDigest(env, normalizedUid);
  }

  let lookupDigest = null;

  if (accountDigest) {
    lookupDigest = accountDigest;
  } else if (accountToken) {
    lookupDigest = await digestAccountToken(accountToken);
  } else if (uidDigest) {
    const rows = await db.prepare(
      `SELECT account_digest FROM accounts WHERE uid_digest=?1`
    ).bind(uidDigest).all();
    lookupDigest = rows?.results?.[0]?.account_digest || null;
  }

  if (lookupDigest) {
    const rows = await db.prepare(
      `SELECT account_digest, account_token, uid_digest, uid_plain, last_ctr, wrapped_mk_json
         FROM accounts
        WHERE account_digest=?1`
    ).bind(lookupDigest).all();
    const row = rows?.results?.[0];
    if (row) {
      if (accountToken && row.account_token !== accountToken) {
        return null;
      }
      return {
        account_digest: row.account_digest,
        account_token: row.account_token,
        uid_digest: row.uid_digest,
        uid_plain: row.uid_plain,
        last_ctr: Number(row.last_ctr || 0),
        wrapped_mk_json: row.wrapped_mk_json,
        newlyCreated: false
      };
    }
  }

  if (!allowCreate) {
    return null;
  }

  if (!normalizedUid) {
    throw new Error('resolveAccount: uidHex required to create account');
  }

  uidDigest = uidDigest || await hashUidToDigest(env, normalizedUid);
  let token = preferredAccountToken || accountToken || null;
  if (token) token = String(token);
  let acctDigest = preferredAccountDigest || accountDigest || null;
  if (acctDigest) {
    acctDigest = String(acctDigest).replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    if (!acctDigest) acctDigest = null;
  }
  if (token && !acctDigest) {
    acctDigest = await digestAccountToken(token);
  }
  if (!token) {
    token = generateAccountToken(env);
  }
  if (!acctDigest) {
    acctDigest = await digestAccountToken(token);
  }
  const now = Math.floor(Date.now() / 1000);

  try {
    await db.prepare(
      `INSERT INTO accounts (account_digest, account_token, uid_digest, uid_plain, last_ctr, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)`
    ).bind(acctDigest, token, uidDigest, normalizedUid, now).run();
    return {
      account_digest: acctDigest,
      account_token: token,
      uid_digest: uidDigest,
      uid_plain: normalizedUid,
      last_ctr: 0,
      wrapped_mk_json: null,
      newlyCreated: true
    };
  } catch (err) {
    const msg = String(err?.message || '');
    if (msg.includes('UNIQUE constraint failed')) {
      const rows = await db.prepare(
        `SELECT account_digest, account_token, uid_digest, uid_plain, last_ctr, wrapped_mk_json
           FROM accounts
          WHERE uid_digest=?1`
      ).bind(uidDigest).all();
      const row = rows?.results?.[0];
      if (row) {
        return {
          account_digest: row.account_digest,
          account_token: row.account_token,
          uid_digest: row.uid_digest,
          uid_plain: row.uid_plain,
          last_ctr: Number(row.last_ctr || 0),
          wrapped_mk_json: row.wrapped_mk_json,
          newlyCreated: false
        };
      }
    }
    throw err;
  }
}

async function ensureDataTables(env) {
  if (dataTablesReady) return;
  const dropLegacy = [
    'DROP TABLE IF EXISTS tags',
    'DROP TABLE IF EXISTS prekey_users',
    'DROP TABLE IF EXISTS prekey_opk',
    'DROP TABLE IF EXISTS device_backup',
    'DROP TABLE IF EXISTS friend_invites'
  ];

  for (const sql of dropLegacy) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      console.warn('ensureDataTables drop failed', sql, err?.message || err);
    }
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conv_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('text','media')),
        aead TEXT NOT NULL,
        header_json TEXT,
        obj_key TEXT,
        size_bytes INTEGER,
        ts INTEGER NOT NULL,
        FOREIGN KEY (conv_id) REFERENCES conversations(id) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON messages (conv_id, ts)`,
    `CREATE TABLE IF NOT EXISTS media_objects (
        obj_key TEXT PRIMARY KEY,
        conv_id TEXT NOT NULL,
        size_bytes INTEGER,
        created_at INTEGER NOT NULL
      )`,
    `CREATE INDEX IF NOT EXISTS idx_media_conv ON media_objects (conv_id)`,
    `CREATE TABLE IF NOT EXISTS messages_secure (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_secure_conv_created ON messages_secure (conversation_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS opaque_records (
        account_digest TEXT PRIMARY KEY,
        record_b64     TEXT NOT NULL,
        client_identity TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS accounts (
        account_digest TEXT PRIMARY KEY,
        account_token TEXT NOT NULL,
        uid_digest TEXT NOT NULL UNIQUE,
        uid_plain TEXT,
        last_ctr INTEGER NOT NULL DEFAULT 0,
        wrapped_mk_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE TABLE IF NOT EXISTS prekey_users (
        account_digest TEXT PRIMARY KEY,
        ik_pub      TEXT NOT NULL,
        spk_pub     TEXT NOT NULL,
        spk_sig     TEXT NOT NULL,
        device_id   TEXT,
        created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS prekey_opk (
        account_digest TEXT NOT NULL,
        opk_id     INTEGER NOT NULL,
        opk_pub    TEXT NOT NULL,
        used       INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (account_digest, opk_id),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_prekey_opk_unused ON prekey_opk (account_digest, used, opk_id)`,
    `CREATE TABLE IF NOT EXISTS device_backup (
        account_digest   TEXT PRIMARY KEY,
        wrapped_dev_json TEXT NOT NULL,
        created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE TABLE IF NOT EXISTS friend_invites (
        invite_id TEXT PRIMARY KEY,
        owner_account_digest TEXT NOT NULL,
        owner_uid TEXT,
        secret TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        prekey_bundle TEXT,
        channel_seed TEXT,
        owner_contact_json TEXT,
        owner_contact_ts INTEGER,
        guest_account_digest TEXT,
        guest_uid TEXT,
        guest_contact_json TEXT,
        guest_contact_ts INTEGER,
        guest_bundle_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (owner_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_account_digest)`
  ];

  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      console.error('ensureDataTables failed', sql.slice(0, 60), err);
      throw err;
    }
  }

  // Optional triggers: attempt creation but ignore "already exists" errors
  const triggers = [
    `CREATE TRIGGER trg_prekey_users_updated
       AFTER UPDATE ON prekey_users
       FOR EACH ROW
       BEGIN
         UPDATE prekey_users SET updated_at = strftime('%s','now') WHERE account_digest = OLD.account_digest;
       END;`,
    `CREATE TRIGGER trg_device_backup_updated
       AFTER UPDATE ON device_backup
       FOR EACH ROW
       BEGIN
         UPDATE device_backup SET updated_at = strftime('%s','now') WHERE account_digest = OLD.account_digest;
       END;`
  ];

  for (const sql of triggers) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('already exists')) continue;
      console.error('ensureDataTables trigger failed', err);
      // Continue without trigger to avoid breaking auth flow
    }
  }

  dataTablesReady = true;
}

function normalizeGuestBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return null;
  const ek = String(bundle.ek_pub || bundle.ek || bundle.ephemeral_pub || '').trim();
  if (!ek) return null;
  const ik = bundle.ik_pub || bundle.ik || bundle.identity_pub ? String(bundle.ik_pub || bundle.ik || bundle.identity_pub || '').trim() : null;
  const spk = bundle.spk_pub ? String(bundle.spk_pub || '').trim() : null;
  const opkId = bundle.opk_id ?? bundle.opkId ?? bundle.opk?.id;
  const out = { ek_pub: ek };
  if (ik) out.ik_pub = ik;
  if (spk) out.spk_pub = spk;
  if (opkId != null && opkId !== '') {
    const num = Number(opkId);
    if (Number.isFinite(num)) out.opk_id = num;
  }
  return out;
}

async function allocateOwnerPrekeyBundle(env, ownerAccountDigest) {
  if (!ownerAccountDigest) return null;
  const userRows = await env.DB.prepare(
    `SELECT ik_pub, spk_pub, spk_sig FROM prekey_users WHERE account_digest=?1`
  ).bind(ownerAccountDigest).all();
  const user = userRows?.results?.[0];
  if (!user) return null;
  let opk = null;
  const opkRows = await env.DB.prepare(
    `SELECT opk_id, opk_pub FROM prekey_opk WHERE account_digest=?1 AND used=0 ORDER BY opk_id ASC LIMIT 1`
  ).bind(ownerAccountDigest).all();
  if (opkRows?.results?.length) {
    const row = opkRows.results[0];
    await env.DB.prepare(
      `UPDATE prekey_opk SET used=1 WHERE account_digest=?1 AND opk_id=?2`
    ).bind(ownerAccountDigest, row.opk_id).run();
    opk = { id: Number(row.opk_id), pub: String(row.opk_pub || '') };
  }
  return {
    ik_pub: String(user.ik_pub || ''),
    spk_pub: String(user.spk_pub || ''),
    spk_sig: String(user.spk_sig || ''),
    opk
  };
}

async function verifyHMAC(req, env) {
  const sig = req.headers.get('x-auth') || '';
  const url = new URL(req.url);
  const body = req.method === 'GET' ? '' : await req.clone().text();
  const msg = url.pathname + url.search + '|' + body;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.HMAC_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(mac)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return timingSafeEqual(sig, b64);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function decryptInviteContact(secret, envelope) {
  const normalized = normalizeEnvelope(envelope);
  if (!normalized || !secret) return null;
  try {
    const key = await deriveInviteContactKey(secret, ['decrypt']);
    const iv = b64ToBytes(normalized.iv);
    const ct = b64ToBytes(normalized.ct);
    if (!iv || !ct) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(new Uint8Array(plain)));
  } catch (err) {
    console.warn('invite_contact_decrypt_failed', err?.message || err);
    return null;
  }
}

async function deriveInviteContactKey(secret, usages) {
  const raw = b64UrlToBytes(secret);
  if (!raw) throw new Error('invalid secret');
  const baseKey = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array(16);
  const info = new TextEncoder().encode('contact-share');
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info }, baseKey, { name: 'AES-GCM', length: 256 }, false, usages);
}

function b64ToBytes(str) {
  if (!str) return null;
  try {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function b64UrlToBytes(str) {
  if (!str) return null;
  const padded = str.length % 4 ? str + '==='.slice(str.length % 4) : str;
  return b64ToBytes(padded.replace(/-/g, '+').replace(/_/g, '/'));
}
