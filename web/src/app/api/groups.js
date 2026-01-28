// /app/api/groups.js
// API wrappers for group management (create/add/remove/get) using accountDigest-only identities.

import { fetchWithTimeout, jsonReq } from '../core/http.js';
import { buildAccountPayload, normalizePeerIdentity } from '../core/store.js';

function normalizeMembers(list = []) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const entry of list) {
    const identity = normalizePeerIdentity(entry?.accountDigest || entry?.peerAccountDigest || entry);
    if (!identity.key) continue;
    out.push({ accountDigest: identity.accountDigest || null });
  }
  return out;
}

export async function createGroup({ groupId, conversationId, name, avatar, members = [] } = {}) {
  if (!groupId) throw new Error('groupId required');
  if (!conversationId) throw new Error('conversationId required');
  const normalizedMembers = normalizeMembers(members);
  const overrides = {
    groupId,
    conversationId,
    name,
    avatar,
    members: normalizedMembers
  };
  const payload = buildAccountPayload({ overrides });
  const r = await fetchWithTimeout('/api/v1/groups/create', jsonReq(payload), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function addGroupMembers({ groupId, members = [] } = {}) {
  if (!groupId) throw new Error('groupId required');
  if (!members.length) throw new Error('members required');
  const payload = buildAccountPayload({ overrides: { groupId, members: normalizeMembers(members) } });
  const r = await fetchWithTimeout('/api/v1/groups/members/add', jsonReq(payload), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function removeGroupMembers({ groupId, members = [], status } = {}) {
  if (!groupId) throw new Error('groupId required');
  if (!members.length) throw new Error('members required');
  const overrides = { groupId, members: normalizeMembers(members) };
  if (status) overrides.status = status;
  const payload = buildAccountPayload({ overrides });
  const r = await fetchWithTimeout('/api/v1/groups/members/remove', jsonReq(payload), 15000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}

export async function getGroup(groupId) {
  if (!groupId) throw new Error('groupId required');
  const url = `/api/v1/groups/${encodeURIComponent(groupId)}`;
  const r = await fetchWithTimeout(url, { method: 'GET' }, 10000);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { r, data };
}
