export const CallIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeCallId(value) {
  if (!value) return null;
  const str = String(value).trim().toLowerCase();
  return CallIdRegex.test(str) ? str : null;
}
