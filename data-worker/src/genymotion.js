// data-worker/src/genymotion.js
// Genymotion Cloud SaaS API client for SENTRY App-as-a-Service.
//
// Manages virtual Android instances: start, stop, save state, get streaming info.
// Each SENTRY user gets a dedicated Genymotion instance with pre-installed apps.

const API_BASE = 'https://api.geny.io';

// ── Whitelisted apps ─────────────────────────────────────────────
// Maps app slug → Android package name + display metadata.
// Only these apps can be launched via the SENTRY frontend.
export const APP_CATALOG = {
  whatsapp:  { package: 'com.whatsapp',             label: 'WhatsApp',  icon: 'whatsapp' },
  telegram:  { package: 'org.telegram.messenger',   label: 'Telegram',  icon: 'telegram' },
  signal:    { package: 'org.thoughtcrime.securesms', label: 'Signal',  icon: 'signal' },
  line:      { package: 'jp.naver.line.android',     label: 'LINE',     icon: 'line' },
  wechat:    { package: 'com.tencent.mm',            label: 'WeChat',   icon: 'wechat' },
  instagram: { package: 'com.instagram.android',     label: 'Instagram', icon: 'instagram' },
  facebook:  { package: 'com.facebook.katana',       label: 'Facebook', icon: 'facebook' },
  messenger: { package: 'com.facebook.orca',         label: 'Messenger', icon: 'messenger' },
};

// ── Low-level API helpers ────────────────────────────────────────

async function genyFetch(apiKey, path, { method = 'GET', body = null } = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'X-Auth-Token': apiKey,
    'Accept': 'application/json',
  };
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GenyError(`Genymotion API ${method} ${path} → ${res.status}`, res.status, text);
  }
  return res.json();
}

class GenyError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'GenyError';
    this.status = status;
    this.body = body;
  }
}

// ── Public API ───────────────────────────────────────────────────

/** List available recipes (device templates). */
export async function listRecipes(apiKey, { search, page = 1, pageSize = 25 } = {}) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (search) params.set('search', search);
  return genyFetch(apiKey, `/v3/recipes/?${params}`);
}

/** Start a disposable instance from a recipe. */
export async function startInstance(apiKey, recipeUuid, { name = 'sentry-user' } = {}) {
  return genyFetch(apiKey, `/v1/recipes/${recipeUuid}/start-disposable`, {
    method: 'POST',
    body: { instance_name: name, rename_on_conflict: true },
  });
}

/** Get instance details (status, WebRTC URL, etc). */
export async function getInstance(apiKey, instanceUuid) {
  return genyFetch(apiKey, `/v1/instances/${instanceUuid}`);
}

/** List all running instances. */
export async function listInstances(apiKey, { page = 1, pageSize = 50 } = {}) {
  const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  return genyFetch(apiKey, `/v2/instances?${params}`);
}

/** Stop and destroy a disposable instance. */
export async function stopInstance(apiKey, instanceUuid) {
  return genyFetch(apiKey, `/v1/instances/${instanceUuid}/stop`, { method: 'POST' });
}

/** Save instance state as a new recipe (snapshot). */
export async function saveInstance(apiKey, instanceUuid, { recipeName, osImageName }) {
  return genyFetch(apiKey, `/v1/instances/${instanceUuid}/save`, {
    method: 'POST',
    body: {
      action: 'SAVE',
      new_recipe_name: recipeName,
      new_os_image_name: osImageName,
    },
  });
}

/** Get ADB tunnel credentials for an instance. */
export async function getAdbTunnel(apiKey, instanceUuid) {
  return genyFetch(apiKey, `/v1/instances/${instanceUuid}/adb-tunnel`, { method: 'POST' });
}

/**
 * Wait for an instance to reach "ONLINE" state (polling).
 * @param {number} timeoutMs - max wait time (default 90s)
 * @param {number} intervalMs - poll interval (default 3s)
 */
export async function waitForInstance(apiKey, instanceUuid, { timeoutMs = 90_000, intervalMs = 3_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const data = await getInstance(apiKey, instanceUuid);
    const state = data?.instance?.state || data?.state;
    if (state === 'ONLINE') return data;
    if (state === 'ERROR' || state === 'DELETED') {
      throw new GenyError(`Instance entered ${state} state`, 500, JSON.stringify(data));
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new GenyError('Instance startup timed out', 504, '');
}

/**
 * Extract the WebRTC streaming URL from instance data.
 * Returns { wsUrl, token } for the Device Web Player SDK.
 */
export function extractStreamInfo(instanceData) {
  const instance = instanceData?.instance || instanceData;
  // Genymotion SaaS returns webrtc_url in the instance details
  const wsUrl = instance?.webrtc_url || instance?.adb?.url?.replace(/^http/, 'ws') || null;
  return {
    instanceUuid: instance?.uuid,
    state: instance?.state,
    wsUrl,
    // The web player needs the instance address for WebSocket connection
    instanceAddress: instance?.address || instance?.ip,
  };
}
