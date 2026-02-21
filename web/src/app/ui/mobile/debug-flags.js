// Centralized debug switches (front-end + local diagnostics)
// __DEBUG_MODE__ is replaced at build time by esbuild `define` (see build.mjs).
// Controlled via DEBUG_MODE env var: true → dev builds, false → production.
// eslint-disable-next-line no-undef
const _dm = __DEBUG_MODE__;

export const DEBUG = {
  replay: _dm,
  forensics: false,
  drVerbose: _dm,
  profileCounter: false,
  drCounter: false,
  contactsA1: false,
  ws: false,
  contactCoreVerbose: false,
  fetchNoise: false,
  uiNoise: false,
  queueNoise: false,
  avatarBug: false,
  conversationReset: _dm,
  identityTrace: false
};

export const DEBUG_CONTACT_PROFILE = DEBUG.profileCounter;

export function hasNicknameValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
}

export function hasAvatarValue(value) {
  return value !== null && value !== undefined;
}

export function logProfileDebug(stage, fields = {}) {
  if (!DEBUG_CONTACT_PROFILE) return;
  try {
    const peerKeyRaw = fields.peerKey || null;
    const peerAccountDigest =
      fields.peerAccountDigest
      || fields.peerDigest
      || (peerKeyRaw && peerKeyRaw.includes('::') ? peerKeyRaw.split('::')[0] : null)
      || null;
    const peerDeviceId =
      fields.peerDeviceId
      || (peerKeyRaw && peerKeyRaw.includes('::') ? peerKeyRaw.split('::')[1] : null)
      || null;
    const peerKey = peerKeyRaw || (peerAccountDigest && peerDeviceId ? `${peerAccountDigest}::${peerDeviceId}` : null);
    const nicknamePresent = fields.nicknamePresent !== undefined
      ? !!fields.nicknamePresent
      : hasNicknameValue(fields.nickname);
    const avatarPresent = fields.avatarPresent !== undefined
      ? !!fields.avatarPresent
      : hasAvatarValue(fields.avatar);
    const payload = {
      stage,
      peerAccountDigest,
      peerDeviceId,
      peerKey,
      nicknamePresent,
      avatarPresent,
      sourceTag: fields.sourceTag || null
    };
    if (fields.note) payload.note = fields.note;
    if (fields.prevPeerKey) payload.prevPeerKey = fields.prevPeerKey;
    if (fields.inputPeerKey) payload.inputPeerKey = fields.inputPeerKey;
    if (fields.conversationId) payload.conversationId = fields.conversationId;
    console.log('[contact-profile][debug]', payload);
  } catch {
    // Ignore logging errors
  }
}
