const SIM_CHIPS_STORAGE_KEY = 'sentry_debug_sim_chips_v1';

function normalizeCounter(value) {
  const num = Number.isFinite(value) ? Number(value) : parseInt(value || '0', 10);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.floor(num);
}

function normalizeUidHex(value) {
  if (value === null || value === undefined) return '';
  const cleaned = String(value).replace(/[^0-9a-f]/gi, '').toUpperCase();
  return cleaned.length >= 14 ? cleaned.slice(0, 14) : '';
}

function normalizeChip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  if (!id) return null;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : id;
  const counter = normalizeCounter(raw.counter);
  const uidHex = normalizeUidHex(raw.uidHex || raw.uid);
  const sdmcounter = typeof raw.sdmcounter === 'string' ? raw.sdmcounter : undefined;
  const sdmmac = typeof raw.sdmmac === 'string' ? raw.sdmmac : undefined;
  const nonce = typeof raw.nonce === 'string' ? raw.nonce : undefined;
  return {
    id,
    label,
    counter,
    uidHex: uidHex || undefined,
    sdmcounter,
    sdmmac,
    nonce
  };
}

export function loadSimChips() {
  try {
    const raw = localStorage.getItem(SIM_CHIPS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeChip).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveSimChips(list) {
  try {
    const arr = Array.isArray(list) ? list.map(normalizeChip).filter(Boolean) : [];
    localStorage.setItem(SIM_CHIPS_STORAGE_KEY, JSON.stringify(arr));
  } catch {}
}

export function buildLoginUrlFromSimChip(chip, { baseOrigin } = {}) {
  const uidHex = chip?.uidHex;
  const sdmcounter = chip?.sdmcounter;
  const sdmmac = chip?.sdmmac;
  if (!uidHex || !sdmcounter || !sdmmac) {
    throw new Error('SDM 模擬資料不完整');
  }
  const nonce = chip?.nonce || `debug-${Date.now()}`;
  const params = new URLSearchParams({
    uid: uidHex,
    sdmcounter,
    sdmmac,
    nonce,
    e2e: '1'
  });
  const origin = baseOrigin
    || (typeof window !== 'undefined' && window.location ? window.location.origin : '');
  const prefix = origin ? `${origin}/pages/login` : '/pages/login';
  return `${prefix}?${params.toString()}`;
}

export function bumpChipCounter(chipId) {
  if (!chipId) return null;
  const list = loadSimChips();
  const idx = list.findIndex((chip) => chip.id === chipId);
  if (idx === -1) return null;
  const current = list[idx];
  const nextCounter = normalizeCounter(current.counter) + 1;
  const updated = { ...current, counter: nextCounter };
  list[idx] = updated;
  saveSimChips(list);
  return updated;
}
