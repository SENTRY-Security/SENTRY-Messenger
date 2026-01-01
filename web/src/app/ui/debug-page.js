import { sdmDebugKit } from '../api/auth.js';
import {
  loadSimChips,
  saveSimChips,
  buildLoginUrlFromSimChip,
  bumpChipCounter
} from '../features/sdm-sim.js';

const chipSelect = document.getElementById('chipSelect');
const chipMeta = document.getElementById('chipMeta');
const chipCount = document.getElementById('chipCount');
const chipEmpty = document.getElementById('chipEmpty');
const statusEl = document.getElementById('status');

const form = document.getElementById('chipForm');
const labelInput = document.getElementById('chipLabel');
const uidInput = document.getElementById('chipUid');
const counterInput = document.getElementById('chipCounter');

const simulateBtn = document.getElementById('btnSimulate');
const resetBtn = document.getElementById('btnResetCounter');
const deleteBtn = document.getElementById('btnDeleteChip');

const state = {
  chips: loadSimChips(),
  selectedId: null,
  busy: false
};

if (state.chips.length) {
  state.selectedId = state.chips[0].id;
}

function setStatus(message = '', tone = 'neutral') {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function getSelectedChip() {
  if (!state.selectedId) return null;
  return state.chips.find((chip) => chip.id === state.selectedId) || null;
}

function updateButtons() {
  const hasChip = !!getSelectedChip();
  if (simulateBtn) simulateBtn.disabled = !hasChip || state.busy;
  if (resetBtn) resetBtn.disabled = !hasChip || state.busy;
  if (deleteBtn) deleteBtn.disabled = !hasChip || state.busy;
}

function renderChipMeta(chip) {
  if (!chipMeta) return;
  chipMeta.innerHTML = '';
  if (!chip) {
    chipMeta.textContent = '尚無模擬晶片。';
    return;
  }
  const lines = [
    `UID: ${chip.uidHex || 'auto'}`,
    `Local counter: ${chip.counter ?? 0}`,
    `Last SDM counter: ${chip.sdmcounter || '-'}`,
    `Last SDM MAC: ${chip.sdmmac || '-'}`
  ];
  lines.forEach((line) => {
    const row = document.createElement('div');
    row.textContent = line;
    chipMeta.appendChild(row);
  });
}

function renderChipList() {
  if (!chipSelect) return;
  chipSelect.innerHTML = '';
  const count = state.chips.length;
  if (chipCount) chipCount.textContent = count ? `${count} chips` : '0 chips';
  if (!count) {
    chipSelect.disabled = true;
    if (chipEmpty) chipEmpty.classList.remove('hidden');
    renderChipMeta(null);
    updateButtons();
    return;
  }
  chipSelect.disabled = false;
  if (chipEmpty) chipEmpty.classList.add('hidden');
  if (!state.selectedId || !state.chips.find((c) => c.id === state.selectedId)) {
    state.selectedId = state.chips[0].id;
  }
  state.chips.forEach((chip) => {
    const option = document.createElement('option');
    option.value = chip.id;
    const uidLabel = chip.uidHex ? chip.uidHex : 'auto';
    option.textContent = `${chip.label} · ${uidLabel} · ctr ${chip.counter ?? 0}`;
    chipSelect.appendChild(option);
  });
  chipSelect.value = state.selectedId;
  renderChipMeta(getSelectedChip());
  updateButtons();
}

function sanitizeUid(value) {
  if (!value) return '';
  const cleaned = String(value).replace(/[^0-9a-f]/gi, '').toUpperCase();
  return cleaned.length >= 14 ? cleaned.slice(0, 14) : '';
}

function makeChipId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `chip-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function upsertChip(updated) {
  const next = state.chips.map((chip) => (chip.id === updated.id ? updated : chip));
  if (!next.find((chip) => chip.id === updated.id)) {
    next.push(updated);
  }
  state.chips = next;
  saveSimChips(next);
}

async function handleSimulate() {
  const chip = getSelectedChip();
  if (!chip || state.busy) return;
  state.busy = true;
  updateButtons();
  setStatus('正在產生 SDM 參數…');
  try {
    const payload = chip.uidHex ? { uidHex: chip.uidHex } : {};
    const { r, data } = await sdmDebugKit(payload);
    if (!r.ok) {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      setStatus(`debug-kit failed (${r.status}): ${text}`, 'error');
      return;
    }
    const kit = data || {};
    if (!kit.uidHex || !kit.sdmcounter || !kit.sdmmac) {
      throw new Error('後端回傳的 debug 資料不完整');
    }
    const updatedChip = {
      ...chip,
      uidHex: kit.uidHex,
      sdmcounter: kit.sdmcounter,
      sdmmac: kit.sdmmac,
      nonce: kit.nonce || chip.nonce
    };
    upsertChip(updatedChip);
    const url = buildLoginUrlFromSimChip(updatedChip, { baseOrigin: window.location.origin });
    window.open(url, '_blank', 'noopener,noreferrer');
    bumpChipCounter(updatedChip.id);
    state.chips = loadSimChips();
    state.selectedId = updatedChip.id;
    renderChipList();
    setStatus('已開啟登入分頁。', 'success');
  } catch (err) {
    setStatus(String(err?.message || err), 'error');
  } finally {
    state.busy = false;
    updateButtons();
  }
}

function handleResetCounter() {
  const chip = getSelectedChip();
  if (!chip || state.busy) return;
  const updatedChip = { ...chip, counter: 1 };
  upsertChip(updatedChip);
  state.selectedId = updatedChip.id;
  renderChipList();
  setStatus('Counter 已重置。', 'neutral');
}

function handleDeleteChip() {
  const chip = getSelectedChip();
  if (!chip || state.busy) return;
  const next = state.chips.filter((item) => item.id !== chip.id);
  state.chips = next;
  saveSimChips(next);
  state.selectedId = next[0]?.id || null;
  renderChipList();
  setStatus('Chip 已刪除。', 'neutral');
}

if (chipSelect) {
  chipSelect.addEventListener('change', () => {
    state.selectedId = chipSelect.value || null;
    renderChipMeta(getSelectedChip());
    updateButtons();
  });
}

if (form) {
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const label = (labelInput?.value || '').trim();
    const uidHex = sanitizeUid(uidInput?.value || '');
    const counterVal = counterInput?.value || '';
    const counter = Number.isFinite(Number(counterVal)) ? Math.max(0, parseInt(counterVal, 10)) : 1;
    if (uidInput?.value && !uidHex) {
      setStatus('UID 需為 14 個十六進位字元。', 'error');
      return;
    }
    const newChip = {
      id: makeChipId(),
      label: label || `Sim-${Date.now()}`,
      counter: Number.isFinite(counter) ? counter : 1,
      uidHex: uidHex || undefined
    };
    state.chips = [...state.chips, newChip];
    saveSimChips(state.chips);
    state.selectedId = newChip.id;
    if (labelInput) labelInput.value = '';
    if (uidInput) uidInput.value = '';
    if (counterInput) counterInput.value = '1';
    renderChipList();
    setStatus('已新增模擬晶片。', 'success');
  });
}

if (simulateBtn) simulateBtn.addEventListener('click', handleSimulate);
if (resetBtn) resetBtn.addEventListener('click', handleResetCounter);
if (deleteBtn) deleteBtn.addEventListener('click', handleDeleteChip);

renderChipList();
