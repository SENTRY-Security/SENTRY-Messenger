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

    // Contact Secrets backup (encrypted payload only)
    if (req.method === 'POST' && url.pathname === '/d1/contact-secrets/backup') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
      if (!accountDigest) {
        return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
      }
      const payload = body?.payload;
      if (!payload || typeof payload !== 'object') {
        return json({ error: 'BadRequest', message: 'payload required' }, { status: 400 });
      }
      const snapshotVersion = Number.isFinite(Number(body?.snapshotVersion)) ? Number(body.snapshotVersion) : null;
      const entries = Number.isFinite(Number(body?.entries)) ? Number(body.entries) : null;
      const bytes = Number.isFinite(Number(body?.bytes)) ? Number(body.bytes) : null;
      const checksum = typeof body?.checksum === 'string' ? String(body.checksum).slice(0, 128) : null;
      const deviceLabel = typeof body?.deviceLabel === 'string' ? String(body.deviceLabel).slice(0, 120) : null;
      const deviceId = typeof body?.deviceId === 'string' ? String(body.deviceId).slice(0, 120) : null;
      const updatedAt = normalizeTimestampMs(body?.updatedAt || body?.updated_at) || Date.now();
      let version = Number.isFinite(Number(body?.version)) && Number(body.version) > 0
        ? Math.floor(Number(body.version))
        : null;

      const existingVersionRow = await env.DB.prepare(
        `SELECT MAX(version) as max_version FROM contact_secret_backups WHERE account_digest=?1`
      ).bind(accountDigest).all();
      const nextVersion = Number(existingVersionRow?.results?.[0]?.max_version || 0);
      if (!version || version <= nextVersion) {
        version = nextVersion + 1;
      }

      await env.DB.prepare(
        `INSERT INTO contact_secret_backups (
            account_digest, version, payload_json, snapshot_version, entries,
            checksum, bytes, updated_at, device_label, device_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, strftime('%s','now'))`
      ).bind(
        accountDigest,
        version,
        JSON.stringify(payload),
        snapshotVersion,
        entries,
        checksum,
        bytes,
        updatedAt,
        deviceLabel,
        deviceId
      ).run();

      await trimContactSecretBackups(env, accountDigest, 5);

      return json({
        ok: true,
        backup: {
          accountDigest,
          version,
          updatedAt,
          snapshotVersion,
          entries,
          bytes,
          checksum,
          deviceLabel,
          deviceId
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/d1/contact-secrets/backup') {
      const accountDigest = normalizeAccountDigest(
        url.searchParams.get('accountDigest')
        || url.searchParams.get('account_digest')
      );
      if (!accountDigest) {
        return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
      }
      const limitParam = Number(url.searchParams.get('limit') || 1);
      const limit = Math.min(Math.max(limitParam || 1, 1), 10);
      const versionParam = Number(url.searchParams.get('version') || 0);

      let stmt;
      if (Number.isFinite(versionParam) && versionParam > 0) {
        stmt = env.DB.prepare(
          `SELECT * FROM contact_secret_backups
            WHERE account_digest=?1 AND version=?2
            ORDER BY updated_at DESC
            LIMIT 1`
        ).bind(accountDigest, Math.floor(versionParam));
      } else {
        stmt = env.DB.prepare(
          `SELECT * FROM contact_secret_backups
            WHERE account_digest=?1
            ORDER BY updated_at DESC, id DESC
            LIMIT ?2`
        ).bind(accountDigest, limit);
      }
      const rows = await stmt.all();
      const backups = (rows?.results || []).map((row) => ({
        id: row.id,
        accountDigest: row.account_digest,
        version: row.version,
        snapshotVersion: row.snapshot_version,
        entries: row.entries,
        checksum: row.checksum,
        bytes: row.bytes,
        updatedAt: Number(row.updated_at) || null,
        deviceLabel: row.device_label || null,
        deviceId: row.device_id || null,
        createdAt: Number(row.created_at) || null,
        payload: safeJSON(row.payload_json)
      }));
      return json({ ok: true, backups });
    }

    if (req.method === 'POST' && url.pathname === '/d1/groups/create') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const groupId = normalizeGroupId(body?.groupId || body?.group_id);
      const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
      const creatorAccountDigest = normalizeAccountDigest(body?.creatorAccountDigest || body?.creator_account_digest);
      const creatorUid = normalizeUid(body?.creatorUid || body?.creator_uid);
      const name = normalizeGroupName(body?.name);
      const avatarJson = normalizeGroupAvatar(body?.avatar || body?.avatarJson || body?.avatar_json);
      const membersInput = Array.isArray(body?.members) ? body.members : [];
      if (!groupId || !conversationId || !creatorAccountDigest) {
        return json({ error: 'BadRequest', message: 'groupId, conversationId, creatorAccountDigest required' }, { status: 400 });
      }

      await ensureDataTables(env);
      const now = Math.floor(Date.now() / 1000);
      try {
        await env.DB.prepare(`
          INSERT INTO groups (group_id, conversation_id, creator_account_digest, creator_uid, name, avatar_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
          ON CONFLICT(group_id) DO UPDATE SET
            conversation_id=excluded.conversation_id,
            name=excluded.name,
            avatar_json=excluded.avatar_json,
            updated_at=strftime('%s','now')
        `).bind(groupId, conversationId, creatorAccountDigest, creatorUid, name, avatarJson, now).run();
      } catch (err) {
        console.warn('group_create_failed', err?.message || err);
        return json({ error: 'CreateFailed', message: err?.message || 'unable to create group' }, { status: 500 });
      }

      await upsertGroupMember(env, {
        groupId,
        accountDigest: creatorAccountDigest,
        uid: creatorUid,
        role: 'owner',
        status: 'active',
        inviterAccountDigest: creatorAccountDigest,
        inviterUid: creatorUid,
        joinedAt: now
      });
      await grantConversationAccess(env, { conversationId, accountDigest: creatorAccountDigest, fingerprint: body?.creatorFingerprint });

      const seenDigests = new Set([creatorAccountDigest]);
      for (const entry of membersInput) {
        const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
        if (!acct || seenDigests.has(acct)) continue;
        seenDigests.add(acct);
        const uid = normalizeUid(entry?.uid);
        const role = normalizeGroupRole(entry?.role);
        await upsertGroupMember(env, {
          groupId,
          accountDigest: acct,
          uid,
          role,
          status: 'active',
          inviterAccountDigest: creatorAccountDigest,
          inviterUid: creatorUid,
          joinedAt: now
        });
        await grantConversationAccess(env, { conversationId, accountDigest: acct });
      }

      const detail = await fetchGroupWithMembers(env, groupId);
      return json(detail ? { ok: true, ...detail } : { ok: true, groupId });
    }

    if (req.method === 'POST' && url.pathname === '/d1/groups/members/add') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const groupId = normalizeGroupId(body?.groupId || body?.group_id);
      const membersInput = Array.isArray(body?.members) ? body.members : [];
      if (!groupId || !membersInput.length) {
        return json({ error: 'BadRequest', message: 'groupId and members required' }, { status: 400 });
      }
      await ensureDataTables(env);
      const groupRow = await env.DB.prepare(`SELECT conversation_id FROM groups WHERE group_id=?1`).bind(groupId).all();
      const group = groupRow?.results?.[0] || null;
      if (!group) {
        return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
      }
      const conversationId = group.conversation_id;
      const now = Math.floor(Date.now() / 1000);
      let added = 0;
      for (const entry of membersInput) {
        const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
        if (!acct) continue;
        const uid = normalizeUid(entry?.uid);
        const role = normalizeGroupRole(entry?.role);
        const inviterAcct = normalizeAccountDigest(entry?.inviterAccountDigest || entry?.inviter_account_digest);
        const inviterUid = normalizeUid(entry?.inviterUid || entry?.inviter_uid);
        await upsertGroupMember(env, {
          groupId,
          accountDigest: acct,
          uid,
          role,
          status: 'active',
          inviterAccountDigest: inviterAcct,
          inviterUid,
          joinedAt: now
        });
        await grantConversationAccess(env, { conversationId, accountDigest: acct });
        added += 1;
      }
      const detail = await fetchGroupWithMembers(env, groupId);
      return json(detail ? { ok: true, added, ...detail } : { ok: true, added });
    }

    if (req.method === 'POST' && url.pathname === '/d1/groups/members/remove') {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const groupId = normalizeGroupId(body?.groupId || body?.group_id);
      const membersInput = Array.isArray(body?.members) ? body.members : [];
      const statusOverride = normalizeGroupStatus(body?.status);
      if (!groupId || !membersInput.length) {
        return json({ error: 'BadRequest', message: 'groupId and members required' }, { status: 400 });
      }
      await ensureDataTables(env);
      const groupRow = await env.DB.prepare(`SELECT conversation_id FROM groups WHERE group_id=?1`).bind(groupId).all();
      const group = groupRow?.results?.[0] || null;
      if (!group) {
        return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
      }
      const conversationId = group.conversation_id;
      const now = Math.floor(Date.now() / 1000);
      let removed = 0;
      for (const entry of membersInput) {
        const acct = normalizeAccountDigest(entry?.accountDigest || entry?.account_digest);
        if (!acct) continue;
        const status = statusOverride || normalizeGroupStatus(entry?.status) || 'removed';
        try {
          await env.DB.prepare(`
            UPDATE group_members
               SET status=?3,
                   updated_at=strftime('%s','now')
             WHERE group_id=?1 AND account_digest=?2
          `).bind(groupId, acct, status).run();
          removed += 1;
        } catch (err) {
          console.warn('group_member_remove_failed', err?.message || err);
        }
        await removeConversationAccess(env, { conversationId, accountDigest: acct });
      }
      const detail = await fetchGroupWithMembers(env, groupId);
      return json(detail ? { ok: true, removed, ...detail } : { ok: true, removed });
    }

    if (req.method === 'GET' && url.pathname === '/d1/groups/get') {
      const groupId = normalizeGroupId(
        url.searchParams.get('groupId')
        || url.searchParams.get('group_id')
      );
      if (!groupId) {
        return json({ error: 'BadRequest', message: 'groupId required' }, { status: 400 });
      }
      const detail = await fetchGroupWithMembers(env, groupId);
      if (!detail) {
        return json({ error: 'NotFound', message: 'group not found' }, { status: 404 });
      }
      return json({ ok: true, ...detail });
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

    if (req.method === 'POST' && url.pathname === '/d1/calls/session') {
      await cleanupCallTables(env);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const result = await upsertCallSession(env, body || {});
      if (!result.ok) {
        return json({ error: result.error || 'CallSessionUpsertFailed', message: result.message || 'unable to store call session' }, { status: result.status || 400 });
      }
      return json({ ok: true, session: result.session });
    }

    if (req.method === 'GET' && url.pathname === '/d1/calls/session') {
      await cleanupCallTables(env);
      const callId = normalizeCallId(url.searchParams.get('callId') || url.searchParams.get('call_id') || url.searchParams.get('id'));
      if (!callId) {
        return json({ error: 'BadRequest', message: 'callId required' }, { status: 400 });
      }
      const rows = await env.DB.prepare(
        `SELECT * FROM call_sessions WHERE call_id=?1`
      ).bind(callId).all();
      const row = rows?.results?.[0];
      if (!row) {
        return json({ error: 'NotFound', message: 'call session not found' }, { status: 404 });
      }
      return json({ ok: true, session: serializeCallSessionRow(row) });
    }

    if (req.method === 'POST' && url.pathname === '/d1/calls/events') {
      await cleanupCallTables(env);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: 'BadRequest', message: 'invalid json' }, { status: 400 });
      }
      const result = await insertCallEvent(env, body || {});
      if (!result.ok) {
        return json({ error: result.error || 'CallEventInsertFailed', message: result.message || 'unable to store call event' }, { status: result.status || 400 });
      }
      return json({ ok: true, event: result.event });
    }

    if (req.method === 'GET' && url.pathname === '/d1/calls/events') {
      await cleanupCallTables(env);
      const callId = normalizeCallId(url.searchParams.get('callId') || url.searchParams.get('call_id') || url.searchParams.get('id'));
      if (!callId) {
        return json({ error: 'BadRequest', message: 'callId required' }, { status: 400 });
      }
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 50), 1), 200);
      const rows = await env.DB.prepare(
        `SELECT event_id, call_id, type, payload_json, from_uid, to_uid, trace_id, created_at
           FROM call_events
          WHERE call_id=?1
          ORDER BY created_at DESC
          LIMIT ?2`
      ).bind(callId, limit).all();
      const events = (rows?.results || []).map((row) => ({
        eventId: row.event_id,
        callId: row.call_id,
        type: row.type,
        payload: safeJSON(row.payload_json),
        fromUid: row.from_uid || null,
        toUid: row.to_uid || null,
        traceId: row.trace_id || null,
        createdAt: Number(row.created_at) || null
      }));
      return json({ ok: true, events });
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
      const ownerUid = normalizeUid(body?.ownerUid || body?.owner_uid);
      const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);

      if (!inviteId || !secret || !envelope) {
        return json({ error: 'BadRequest', message: 'inviteId, secret and envelope required' }, { status: 400 });
      }

      const sel = await env.DB.prepare(
        `SELECT invite_id, secret, expires_at FROM friend_invites WHERE invite_id=?1`
      ).bind(inviteId).all();
      let row = sel?.results?.[0];
      if (!row && ownerUid && accountDigest) {
        let ownerAccount;
        try {
          ownerAccount = await resolveAccount(env, { uidHex: ownerUid, accountDigest }, { allowCreate: false, preferredAccountDigest: accountDigest });
        } catch (err) {
          return json({ error: 'ConfigError', message: err?.message || 'resolveAccount failed' }, { status: 500 });
        }
        if (!ownerAccount || ownerAccount.account_digest !== accountDigest) {
          return json({ error: 'Forbidden', message: 'owner account mismatch' }, { status: 403 });
        }
        const nowInsert = Math.floor(Date.now() / 1000);
        const fallbackTtl = Number.isFinite(body?.ttlSeconds) ? Number(body.ttlSeconds) : 600;
        const expiresAt = nowInsert + Math.min(Math.max(fallbackTtl, 60), 900);
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO friend_invites(
                invite_id, owner_account_digest, owner_uid, secret, expires_at,
                prekey_bundle, channel_seed, owner_contact_json, owner_contact_ts,
                guest_account_digest, guest_uid, guest_contact_json, guest_contact_ts, guest_bundle_json, used_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
          ).bind(inviteId, accountDigest, ownerUid, secret, expiresAt).run();
        } catch (err) {
          console.warn('invite_contact_fallback_insert_failed', err?.message || err);
        }
        const retry = await env.DB.prepare(
          `SELECT invite_id, secret, expires_at, owner_account_digest, owner_uid FROM friend_invites WHERE invite_id=?1`
        ).bind(inviteId).all();
        row = retry?.results?.[0] || null;
      }
      if (!row) return json({ error: 'NotFound', message: 'invite not found' }, { status: 404 });
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
      const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
      const peerUidBody = normalizeUid(body?.peerUid || body?.peer_uid);
      const conversationId = normalizeConversationId(body?.conversationId || body?.conversation_id);
      const conversationFingerprintRaw = typeof body?.conversationFingerprint === 'string' ? body.conversationFingerprint.trim() : '';
      const conversationFingerprint = conversationFingerprintRaw ? conversationFingerprintRaw : null;
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
        return json({ error: 'NotFound', message: 'invite not found' }, { status: 404 });
      }
      if (row.secret !== secret) return json({ error: 'Forbidden', message: 'secret mismatch' }, { status: 403 });

      const ownerDigest = normalizeAccountDigest(row.owner_account_digest);
      const guestDigest = normalizeAccountDigest(row.guest_account_digest);
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
        const normalizedDigest = normalizeAccountDigest(digest);
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
          const acctDigest = normalizeAccountDigest(account?.account_digest);
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

      if (conversationId) {
        let senderDigestResolved = senderRole === 'owner' ? ownerDigest : guestDigest;
        let targetDigestResolved = senderRole === 'owner' ? guestDigest : ownerDigest;
        if (!senderDigestResolved && senderUid) {
          try {
            senderDigestResolved = await hashUidToDigest(env, senderUid);
          } catch (err) {
            console.warn('conversation_acl_sender_digest_failed', err?.message || err);
          }
        }
        if (!targetDigestResolved && targetUid) {
          try {
            targetDigestResolved = await hashUidToDigest(env, targetUid);
          } catch (err) {
            console.warn('conversation_acl_target_digest_failed', err?.message || err);
          }
        }
        if (senderDigestResolved) {
          await grantConversationAccess(env, {
            conversationId,
            accountDigest: senderDigestResolved,
            fingerprint: conversationFingerprint
          });
        }
        if (targetDigestResolved) {
          await grantConversationAccess(env, {
            conversationId,
            accountDigest: targetDigestResolved,
            fingerprint: null
          });
        }
      }

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
      const ownerDigestBody = normalizeAccountDigest(body?.ownerAccountDigest || body?.owner_account_digest);
      const peerDigestBody = normalizeAccountDigest(body?.peerAccountDigest || body?.peer_account_digest);
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
            const ownerDigest = normalizeAccountDigest(row.owner_account_digest);
            if (ownerDigest) ownerDigests.add(ownerDigest);
            const peerDigest = normalizeAccountDigest(row.guest_account_digest);
            if (peerDigest) peerDigests.add(peerDigest);
          } else if (ownerRowUid === peerUid && guestRowUid === ownerUid) {
            const peerDigest = normalizeAccountDigest(row.owner_account_digest);
            if (peerDigest) peerDigests.add(peerDigest);
            const ownerDigest = normalizeAccountDigest(row.guest_account_digest);
            if (ownerDigest) ownerDigests.add(ownerDigest);
          }
        }
      } catch {
        // ignore lookup failures; proceed with provided identifiers
      }

      try {
        const ownerAccount = await resolveAccount(env, { uidHex: ownerUid });
        const digest = normalizeAccountDigest(ownerAccount?.account_digest);
        if (digest) ownerDigests.add(digest);
      } catch {
        // ignore missing account; allow deletion to continue
      }

      try {
        const peerAccount = await resolveAccount(env, { uidHex: peerUid });
        const digest = normalizeAccountDigest(peerAccount?.account_digest);
        if (digest) peerDigests.add(digest);
      } catch {
        // ignore missing account; allow deletion to continue
      }

      try {
        const ownerDerived = await hashUidToDigest(env, ownerUid);
        const norm = normalizeAccountDigest(ownerDerived);
        if (norm) ownerDigests.add(norm);
      } catch {
        // ignore hashing failures
      }

      try {
        const peerDerived = await hashUidToDigest(env, peerUid);
        const norm = normalizeAccountDigest(peerDerived);
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

    if (req.method === 'POST' && url.pathname === '/d1/conversations/authorize') {
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
      const accountDigest = normalizeAccountDigest(body?.accountDigest || body?.account_digest);
      if (!accountDigest) {
        return json({ error: 'BadRequest', message: 'accountDigest required' }, { status: 400 });
      }
      const fingerprint = typeof body?.fingerprint === 'string' ? body.fingerprint.trim() : null;
      await ensureDataTables(env);
      let row;
      try {
        const res = await env.DB.prepare(
          `SELECT fingerprint FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2`
        ).bind(conversationId, accountDigest).all();
        row = res?.results?.[0] || null;
      } catch (err) {
        console.warn('conversation_acl_query_failed', err?.message || err);
        return json({ error: 'ConversationLookupFailed', message: err?.message || 'lookup failed' }, { status: 500 });
      }
      if (!row) {
        if (!fingerprint) {
          return json({ error: 'Forbidden', message: 'conversation access not granted' }, { status: 403 });
        }
        await grantConversationAccess(env, { conversationId, accountDigest, fingerprint });
        return json({ ok: true, created: true });
      }
      const storedFp = typeof row.fingerprint === 'string' ? row.fingerprint.trim() : '';
      if (fingerprint && storedFp && fingerprint !== storedFp) {
        return json({ error: 'Forbidden', message: 'fingerprint mismatch' }, { status: 403 });
      }
      return json({ ok: true });
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

async function trimContactSecretBackups(env, accountDigest, limit = 5) {
  if (!accountDigest) return;
  const keep = Math.max(Number(limit) || 1, 1);
  await env.DB.prepare(
    `DELETE FROM contact_secret_backups
       WHERE account_digest=?1
         AND id NOT IN (
           SELECT id FROM contact_secret_backups
            WHERE account_digest=?1
            ORDER BY updated_at DESC, id DESC
            LIMIT ?2
         )`
  ).bind(accountDigest, keep).run();
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

function normalizeAccountDigest(value) {
  const cleaned = String(value || '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (cleaned.length !== 64) return null;
  return cleaned;
}

function normalizeGroupId(value) {
  const token = String(value || '').trim();
  if (!token) return null;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return null;
  return token;
}

function normalizeGroupName(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 120);
}

function normalizeGroupRole(value) {
  const role = String(value || '').toLowerCase();
  if (role === 'owner' || role === 'admin') return role;
  return 'member';
}

function normalizeGroupStatus(value) {
  const status = String(value || '').toLowerCase();
  if (['active', 'left', 'kicked', 'removed'].includes(status)) return status;
  return null;
}

function normalizeGroupAvatar(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return null; }
  }
  return null;
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

async function grantConversationAccess(env, { conversationId, accountDigest, fingerprint }) {
  if (!conversationId || !accountDigest) return;
  await ensureDataTables(env);
  const fp = fingerprint && String(fingerprint).trim() ? String(fingerprint).trim() : null;
  try {
    await env.DB.prepare(`
      INSERT INTO conversation_acl (conversation_id, account_digest, fingerprint)
      VALUES (?1, ?2, ?3)
      ON CONFLICT(conversation_id, account_digest) DO UPDATE SET
        fingerprint = CASE
          WHEN excluded.fingerprint IS NOT NULL AND excluded.fingerprint != '' THEN excluded.fingerprint
          ELSE conversation_acl.fingerprint
        END,
        updated_at = strftime('%s','now')
    `).bind(conversationId, accountDigest, fp).run();
  } catch (err) {
    console.warn('conversation_acl_upsert_failed', err?.message || err);
  }
}

async function removeConversationAccess(env, { conversationId, accountDigest }) {
  if (!conversationId || !accountDigest) return;
  await ensureDataTables(env);
  try {
    await env.DB.prepare(
      `DELETE FROM conversation_acl WHERE conversation_id=?1 AND account_digest=?2`
    ).bind(conversationId, accountDigest).run();
  } catch (err) {
    console.warn('conversation_acl_delete_failed', err?.message || err);
  }
}

async function upsertGroupMember(env, {
  groupId,
  accountDigest,
  uid,
  role = 'member',
  status = 'active',
  inviterAccountDigest = null,
  inviterUid = null,
  joinedAt = null
} = {}) {
  if (!groupId || !accountDigest) return false;
  const normalizedRole = normalizeGroupRole(role);
  const normalizedStatus = normalizeGroupStatus(status) || 'active';
  const joined = Number.isFinite(Number(joinedAt)) && Number(joinedAt) > 0
    ? Math.floor(Number(joinedAt))
    : Math.floor(Date.now() / 1000);
  try {
    await env.DB.prepare(`
      INSERT INTO group_members (
        group_id, account_digest, uid, role, status,
        inviter_account_digest, inviter_uid, joined_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(group_id, account_digest) DO UPDATE SET
        role=excluded.role,
        status=excluded.status,
        uid=COALESCE(excluded.uid, group_members.uid),
        inviter_account_digest=COALESCE(excluded.inviter_account_digest, group_members.inviter_account_digest),
        inviter_uid=COALESCE(excluded.inviter_uid, group_members.inviter_uid),
        joined_at=COALESCE(group_members.joined_at, excluded.joined_at),
        updated_at=strftime('%s','now')
    `).bind(
      groupId,
      accountDigest,
      uid || null,
      normalizedRole,
      normalizedStatus,
      inviterAccountDigest || null,
      inviterUid || null,
      joined
    ).run();
    return true;
  } catch (err) {
    console.warn('group_member_upsert_failed', err?.message || err);
    return false;
  }
}

async function fetchGroupWithMembers(env, groupId) {
  if (!groupId) return null;
  await ensureDataTables(env);
  const groupRows = await env.DB.prepare(
    `SELECT group_id, conversation_id, creator_account_digest, creator_uid, name, avatar_json, created_at, updated_at
       FROM groups WHERE group_id=?1`
  ).bind(groupId).all();
  const group = groupRows?.results?.[0] || null;
  if (!group) return null;
  const membersRes = await env.DB.prepare(
    `SELECT group_id, account_digest, uid, role, status, inviter_account_digest, inviter_uid,
            joined_at, muted_until, last_read_ts, created_at, updated_at
       FROM group_members
      WHERE group_id=?1`
  ).bind(groupId).all();
  const members = (membersRes?.results || []).map((row) => ({
    groupId: row.group_id,
    accountDigest: row.account_digest,
    uid: row.uid || null,
    role: row.role || 'member',
    status: row.status || 'active',
    inviterAccountDigest: row.inviter_account_digest || null,
    inviterUid: row.inviter_uid || null,
    joinedAt: Number(row.joined_at) || null,
    mutedUntil: Number(row.muted_until) || null,
    lastReadTs: Number(row.last_read_ts) || null,
    createdAt: Number(row.created_at) || null,
    updatedAt: Number(row.updated_at) || null
  }));
  return {
    group: {
      groupId: group.group_id,
      conversationId: group.conversation_id,
      creatorAccountDigest: group.creator_account_digest,
      creatorUid: group.creator_uid || null,
      name: group.name || null,
      avatar: safeJSON(group.avatar_json) || null,
      createdAt: Number(group.created_at) || null,
      updatedAt: Number(group.updated_at) || null
    },
    members
  };
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

const CallStatusSet = new Set(['dialing', 'ringing', 'connecting', 'connected', 'in_call', 'ended', 'failed', 'cancelled', 'timeout', 'pending']);
const CallModeSet = new Set(['voice', 'video']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CALL_SESSION_PURGE_GRACE_MS = 5 * 60 * 1000;
let lastCallCleanupAt = 0;

function normalizeCallId(value) {
  const token = String(value || '').trim();
  if (!token || !UUID_REGEX.test(token)) return null;
  return token.toLowerCase();
}

function normalizeCallStatus(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (CallStatusSet.has(token)) return token;
  return null;
}

function normalizeCallMode(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (CallModeSet.has(token)) return token;
  return null;
}

function normalizeCallEndReason(value) {
  if (!value) return null;
  const token = String(value).trim().toLowerCase();
  if (!token) return null;
  return token;
}

function normalizeTimestampMs(value) {
  if (value === null || value === undefined) return null;
  let num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (Math.abs(num) < 1e11) {
    num = Math.round(num * 1000);
  } else {
    num = Math.round(num);
  }
  return num;
}

function normalizePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

function resolveCapabilities(existingJson, incoming) {
  if (incoming === undefined) {
    return normalizePlainObject(safeJSON(existingJson));
  }
  if (incoming === null) return null;
  return normalizePlainObject(incoming) || null;
}

function resolveMergableJson(existingJson, incoming) {
  const base = normalizePlainObject(safeJSON(existingJson));
  if (incoming === undefined) {
    return base;
  }
  if (incoming === null) {
    return null;
  }
  const patch = normalizePlainObject(incoming);
  if (!patch) return base;
  const merged = { ...(base || {}) };
  for (const [key, val] of Object.entries(patch)) {
    merged[key] = val;
  }
  return merged;
}

function jsonStringOrNull(obj) {
  if (obj === null || obj === undefined) return null;
  try {
    return JSON.stringify(obj);
  } catch {
    return null;
  }
}

async function upsertCallSession(env, payload = {}) {
  await ensureDataTables(env);
  const callId = normalizeCallId(payload.callId || payload.call_id);
  if (!callId) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callId required' };
  }
  const rows = await env.DB.prepare(`SELECT * FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  const existing = rows?.results?.[0] || null;
  const callerUid = normalizeUid(payload.callerUid || payload.caller_uid) || existing?.caller_uid;
  if (!callerUid) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callerUid required' };
  }
  const calleeUid = normalizeUid(payload.calleeUid || payload.callee_uid) || existing?.callee_uid;
  if (!calleeUid) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'calleeUid required' };
  }
  const status = normalizeCallStatus(payload.status) || existing?.status || 'dialing';
  const mode = normalizeCallMode(payload.mode) || existing?.mode || 'voice';
  const callerDigest = normalizeAccountDigest(payload.callerAccountDigest || payload.caller_account_digest) || existing?.caller_account_digest || null;
  const calleeDigest = normalizeAccountDigest(payload.calleeAccountDigest || payload.callee_account_digest) || existing?.callee_account_digest || null;
  const now = Date.now();
  const createdAt = existing?.created_at ? Number(existing.created_at) : now;
  const updatedAt = normalizeTimestampMs(payload.updatedAt || payload.updated_at) || now;
  const expiresAt = normalizeTimestampMs(payload.expiresAt || payload.expires_at) || existing?.expires_at || (now + 90_000);
  const connectedAtInput = normalizeTimestampMs(payload.connectedAt || payload.connected_at);
  const connectedAt = connectedAtInput ?? (existing && Number.isFinite(existing.connected_at) ? Number(existing.connected_at) : null);
  const endedAtInput = normalizeTimestampMs(payload.endedAt || payload.ended_at);
  const endedAt = endedAtInput ?? (existing && Number.isFinite(existing.ended_at) ? Number(existing.ended_at) : null);
  const endReason = normalizeCallEndReason(payload.endReason || payload.end_reason) || existing?.end_reason || null;
  const capabilitiesObj = resolveCapabilities(existing?.capabilities_json, payload.capabilities);
  const metadataObj = resolveMergableJson(existing?.metadata_json, payload.metadata);
  const metricsObj = resolveMergableJson(existing?.metrics_json, payload.metrics);
  const lastEvent = payload.lastEvent || payload.last_event || existing?.last_event || null;

  await env.DB.prepare(`
    INSERT INTO call_sessions (
      call_id, caller_uid, callee_uid,
      caller_account_digest, callee_account_digest,
      status, mode,
      capabilities_json, metadata_json, metrics_json,
      created_at, updated_at, connected_at, ended_at, end_reason, expires_at, last_event
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
    ON CONFLICT(call_id) DO UPDATE SET
      caller_uid=excluded.caller_uid,
      callee_uid=excluded.callee_uid,
      caller_account_digest=excluded.caller_account_digest,
      callee_account_digest=excluded.callee_account_digest,
      status=excluded.status,
      mode=excluded.mode,
      capabilities_json=excluded.capabilities_json,
      metadata_json=excluded.metadata_json,
      metrics_json=excluded.metrics_json,
      updated_at=excluded.updated_at,
      connected_at=excluded.connected_at,
      ended_at=excluded.ended_at,
      end_reason=excluded.end_reason,
      expires_at=excluded.expires_at,
      last_event=excluded.last_event,
      created_at=call_sessions.created_at
  `).bind(
    callId,
    callerUid,
    calleeUid,
    callerDigest,
    calleeDigest,
    status,
    mode,
    jsonStringOrNull(capabilitiesObj),
    jsonStringOrNull(metadataObj),
    jsonStringOrNull(metricsObj),
    createdAt,
    updatedAt,
    connectedAt,
    endedAt,
    endReason,
    expiresAt,
    lastEvent
  ).run();

  const latest = await env.DB.prepare(`SELECT * FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  const row = latest?.results?.[0];
  if (!row) {
    return { ok: false, status: 500, error: 'UpsertFailed', message: 'call session missing after upsert' };
  }
  return { ok: true, session: serializeCallSessionRow(row) };
}

async function insertCallEvent(env, payload = {}) {
  await ensureDataTables(env);
  const callId = normalizeCallId(payload.callId || payload.call_id);
  if (!callId) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'callId required' };
  }
  const type = String(payload.type || '').trim();
  if (!type) {
    return { ok: false, status: 400, error: 'BadRequest', message: 'type required' };
  }
  const sessionRows = await env.DB.prepare(`SELECT call_id FROM call_sessions WHERE call_id=?1`).bind(callId).all();
  if (!sessionRows?.results?.length) {
    return { ok: false, status: 404, error: 'NotFound', message: 'call session not found' };
  }
  const eventId = String(payload.eventId || payload.event_id || crypto.randomUUID());
  const createdAt = normalizeTimestampMs(payload.createdAt || payload.created_at) || Date.now();
  const fromUid = normalizeUid(payload.fromUid || payload.from_uid);
  const toUid = normalizeUid(payload.toUid || payload.to_uid);
  const traceId = payload.traceId ? String(payload.traceId).trim() : null;
  const eventPayload = payload.payload === undefined ? null : payload.payload;
  const payloadJson = eventPayload === null ? null : jsonStringOrNull(eventPayload);
  await env.DB.prepare(`
    INSERT INTO call_events (event_id, call_id, type, payload_json, from_uid, to_uid, trace_id, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
  `).bind(
    eventId,
    callId,
    type,
    payloadJson,
    fromUid,
    toUid,
    traceId,
    createdAt
  ).run();
  await env.DB.prepare(
    `UPDATE call_sessions SET last_event=?2, updated_at=?3 WHERE call_id=?1`
  ).bind(callId, type, createdAt).run();
  return {
    ok: true,
    event: {
      eventId,
      callId,
      type,
      payload: eventPayload,
      fromUid: fromUid || null,
      toUid: toUid || null,
      traceId: traceId || null,
      createdAt
    }
  };
}

function serializeCallSessionRow(row) {
  if (!row) return null;
  return {
    callId: row.call_id,
    callerUid: row.caller_uid,
    calleeUid: row.callee_uid,
    callerAccountDigest: row.caller_account_digest || null,
    calleeAccountDigest: row.callee_account_digest || null,
    status: row.status,
    mode: row.mode,
    capabilities: normalizePlainObject(safeJSON(row.capabilities_json)),
    metadata: normalizePlainObject(safeJSON(row.metadata_json)),
    metrics: normalizePlainObject(safeJSON(row.metrics_json)),
    createdAt: Number(row.created_at) || null,
    updatedAt: Number(row.updated_at) || null,
    connectedAt: row.connected_at != null ? Number(row.connected_at) : null,
    endedAt: row.ended_at != null ? Number(row.ended_at) : null,
    endReason: row.end_reason || null,
    expiresAt: Number(row.expires_at) || null,
    lastEvent: row.last_event || null
  };
}

async function cleanupCallTables(env) {
  const now = Date.now();
  if (now - lastCallCleanupAt < 60_000) return;
  lastCallCleanupAt = now;
  await ensureDataTables(env);
  const eventExpiry = now - CALL_EVENT_TTL_MS;
  const sessionExpiry = now - CALL_SESSION_PURGE_GRACE_MS;
  try {
    await env.DB.prepare(`DELETE FROM call_events WHERE created_at < ?1`).bind(eventExpiry).run();
  } catch (err) {
    console.warn('call_events_cleanup_failed', err?.message || err);
  }
  try {
    await env.DB.prepare(
      `DELETE FROM call_sessions
        WHERE expires_at < ?1
          AND status IN ('ended','failed','cancelled','timeout')`
    ).bind(sessionExpiry).run();
  } catch (err) {
    console.warn('call_sessions_cleanup_failed', err?.message || err);
  }
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
    `CREATE TABLE IF NOT EXISTS conversation_acl (
        conversation_id TEXT NOT NULL,
        account_digest TEXT NOT NULL,
        fingerprint TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (conversation_id, account_digest),
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_acl_account ON conversation_acl (account_digest)`,
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
    `CREATE INDEX IF NOT EXISTS idx_friend_invites_owner ON friend_invites(owner_account_digest)`,
    `CREATE TABLE IF NOT EXISTS call_sessions (
        call_id TEXT PRIMARY KEY,
        caller_uid TEXT NOT NULL,
        callee_uid TEXT NOT NULL,
        caller_account_digest TEXT,
        callee_account_digest TEXT,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        capabilities_json TEXT,
        metadata_json TEXT,
        metrics_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        connected_at INTEGER,
        ended_at INTEGER,
        end_reason TEXT,
        expires_at INTEGER NOT NULL,
        last_event TEXT
      )`,
    `CREATE INDEX IF NOT EXISTS idx_call_sessions_status ON call_sessions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_call_sessions_expires ON call_sessions(expires_at)`,
    `CREATE TABLE IF NOT EXISTS call_events (
        event_id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        from_uid TEXT,
        to_uid TEXT,
        trace_id TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (call_id) REFERENCES call_sessions(call_id) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_call_events_call_created ON call_events(call_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS contact_secret_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_digest TEXT NOT NULL,
        version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        snapshot_version INTEGER,
        entries INTEGER,
        checksum TEXT,
        bytes INTEGER,
        updated_at INTEGER NOT NULL,
        device_label TEXT,
        device_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_secret_backups_account_version
        ON contact_secret_backups (account_digest, version)`,
    `CREATE INDEX IF NOT EXISTS idx_contact_secret_backups_account_updated
        ON contact_secret_backups (account_digest, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS groups (
        group_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        creator_account_digest TEXT NOT NULL,
        creator_uid TEXT,
        name TEXT,
        avatar_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (creator_account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_groups_conversation_id ON groups(conversation_id)`,
    `CREATE INDEX IF NOT EXISTS idx_groups_creator ON groups(creator_account_digest)`,
    `CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        account_digest TEXT NOT NULL,
        uid TEXT,
        role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','left','kicked','removed')),
        inviter_account_digest TEXT,
        inviter_uid TEXT,
        joined_at INTEGER,
        muted_until INTEGER,
        last_read_ts INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (group_id, account_digest),
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
        FOREIGN KEY (account_digest) REFERENCES accounts(account_digest) ON DELETE CASCADE
      )`,
    `CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_group_members_account ON group_members(account_digest)`,
    `CREATE INDEX IF NOT EXISTS idx_group_members_status ON group_members(group_id, status)`,
    `CREATE TABLE IF NOT EXISTS group_invites (
        invite_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL,
        issuer_account_digest TEXT,
        issuer_uid TEXT,
        secret TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        FOREIGN KEY (group_id) REFERENCES groups(group_id) ON DELETE CASCADE,
        FOREIGN KEY (issuer_account_digest) REFERENCES accounts(account_digest) ON DELETE SET NULL
      )`,
    `CREATE INDEX IF NOT EXISTS idx_group_invites_group ON group_invites(group_id)`,
    `CREATE INDEX IF NOT EXISTS idx_group_invites_expires ON group_invites(expires_at)`
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
       END;`,
    `CREATE TRIGGER trg_conversation_acl_updated
       AFTER UPDATE ON conversation_acl
       FOR EACH ROW
       BEGIN
         UPDATE conversation_acl SET updated_at = strftime('%s','now') WHERE conversation_id = OLD.conversation_id AND account_digest = OLD.account_digest;
       END;`,
    `CREATE TRIGGER trg_groups_updated
       AFTER UPDATE ON groups
       FOR EACH ROW
       BEGIN
         UPDATE groups SET updated_at = strftime('%s','now') WHERE group_id = OLD.group_id;
       END;`,
    `CREATE TRIGGER trg_group_members_updated
       AFTER UPDATE ON group_members
       FOR EACH ROW
       BEGIN
         UPDATE group_members SET updated_at = strftime('%s','now') WHERE group_id = OLD.group_id AND account_digest = OLD.account_digest;
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
  const sig = bundle.spk_sig || bundle.spkSig || bundle.signature ? String(bundle.spk_sig || bundle.spkSig || bundle.signature || '').trim() : null;
  const opkId = bundle.opk_id ?? bundle.opkId ?? bundle.opk?.id;
  const out = { ek_pub: ek };
  if (ik) out.ik_pub = ik;
  if (spk) out.spk_pub = spk;
  if (sig) out.spk_sig = sig;
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
