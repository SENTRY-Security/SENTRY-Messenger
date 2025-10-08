// /app/ui/app-ui.js
// App page binder: Health, Media Encrypt&Upload (E2EE → R2 PUT), Sign‑Get & Preview, Download & Decrypt.
// Uses core modules (http/log/store). Does not depend on window globals from app.js.

import { log, setLogSink } from '../core/log.js';
import {
  getUidHex, getMkRaw,
  setMkRaw, setUidHex,
  setAccountToken, setAccountDigest, setUidDigest,
  clearSecrets, resetAll
} from '../core/store.js';
import { encryptAndPut, signGet, downloadAndDecrypt } from '../features/media.js';
import { listSecureAndDecrypt } from '../features/messages.js';
import { ensureDrSession, sendDrText } from '../features/dr-session.js';
import { getSimStoragePrefix, getSimStorageKey } from '../../libs/ntag424-sim.js';

// ---- UI elements ----
const $ = (sel) => document.querySelector(sel);
const out = $('#out'); setLogSink(out);

const SIM_STORAGE_PREFIX = (() => {
  try { return getSimStoragePrefix(); } catch { return 'ntag424-sim:'; }
})();
const SIM_STORAGE_KEY = (() => {
  try { return getSimStorageKey(); } catch { return null; }
})();

function isSimStorageKey(key) {
  if (!key) return false;
  if (SIM_STORAGE_KEY && key === SIM_STORAGE_KEY) return true;
  if (SIM_STORAGE_PREFIX && key.startsWith(SIM_STORAGE_PREFIX)) return true;
  return false;
}

// Restore MK/UID from sessionStorage handoff (login → app)
(function restoreMkAndUidFromSession() {
  try {
    const mkb64 = sessionStorage.getItem('mk_b64');
    const uid = sessionStorage.getItem('uid_hex');
    const accountToken = sessionStorage.getItem('account_token');
    const accountDigest = sessionStorage.getItem('account_digest');
    const uidDigest = sessionStorage.getItem('uid_digest');
    if (uid) setUidHex(uid);
    if (accountToken) setAccountToken(accountToken);
    if (accountDigest) setAccountDigest(accountDigest);
    if (uidDigest) setUidDigest(uidDigest);
    if (mkb64 && !getMkRaw()) {
      setMkRaw(b64u8(mkb64));
    }
    // one-time handoff; clear after restore
    sessionStorage.removeItem('mk_b64');
    sessionStorage.removeItem('uid_hex');
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
    sessionStorage.removeItem('uid_digest');
  } catch (e) {
    log({ restoreError: String(e?.message || e) });
  }
})();

// If still not unlocked after restoration, redirect back to Login
(function ensureUnlockedOrRedirect(){
  try {
    if (!getMkRaw()) {
      log('Not unlocked: redirecting to /pages/login.html …');
      setTimeout(() => location.replace('/pages/login.html'), 200);
    }
  } catch (e) {
    log({ redirectGuardError: String(e?.message || e) });
  }
})();

const convEl = $('#convId'); const fileEl = $('#file'); const lastKeyEl = $('#lastKey');

// ---- (Dev) Messages: List & Decrypt ----
(function injectMessagesSection() {
  try {
    const grid = document.querySelector('.grid') || document.body;
    const sec = document.createElement('section');
    sec.className = 'card full';
    sec.innerHTML = `
      <h2>(Dev) 訊息列表</h2>
      <div class="row">
        <button id="btnLoadMsgs">載入最近 20 則</button>
        <span class="muted">需要輸入對方 UID（用於 DR 會話解密）</span>
      </div>
      <ul id="msgList" style="list-style: none; padding-left: 0; margin: 8px 0;"></ul>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;" />
      <h3>(Dev) DR 文字訊息</h3>
      <div class="row">
        <label>Peer UID</label>
        <input id="peerUidHex" placeholder="對方 UID（14 hex）" style="min-width:220px" />
        <button id="btnInitDr">初始化會話</button>
      </div>
      <div class="row">
        <label>Text</label>
        <input id="drText" placeholder="要傳送的文字" style="flex:1;min-width:240px" />
        <button id="btnSendText" class="primary">Send</button>
      </div>
    `;
    // 插入到 Log 區塊前（若找不到，就附加在末尾）
    const logCard = out?.closest('.card');
    if (grid && logCard && grid.contains(logCard)) {
      grid.insertBefore(sec, logCard);
    } else {
      grid.appendChild(sec);
    }
    const btn = sec.querySelector('#btnLoadMsgs');
    if (btn) btn.onclick = onLoadMessages;
    const btnInit = sec.querySelector('#btnInitDr');
    if (btnInit) btnInit.onclick = onInitDr;
    const btnSend = sec.querySelector('#btnSendText');
    if (btnSend) btnSend.onclick = onSendText;
  } catch (e) {
    log({ injectMessagesUIError: String(e?.message || e) });
  }
})();

// ---- Health ----
const btnHealth = $('#btnHealth');
if (btnHealth) btnHealth.onclick = async () => {
  const r = await fetch('/api/health'); const t = await r.text();
  log({ status: r.status, data: safeJSON(t) });
};

// ---- Logout ----
const btnLogout = $('#btnLogout');
if (btnLogout) btnLogout.onclick = onLogout;
function onLogout() {
  try {
    // clear ephemeral handoff storage
    sessionStorage.removeItem('mk_b64');
    sessionStorage.removeItem('uid_hex');
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
    sessionStorage.removeItem('uid_digest');
  } catch {}
  try {
    // clear local envelope cache (env_v1:*), 保留模擬資料
    const del = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || isSimStorageKey(k)) continue;
      if (k.startsWith('env_v1:')) del.push(k);
    }
    for (const k of del) {
      try { localStorage.removeItem(k); } catch {}
    }
  } catch {}
  try {
    // clear all in-memory state (MK, DR sessions, UID, etc.)
    resetAll();
  } catch { try { clearSecrets(); } catch {} }
  // navigate back to login
  try { location.replace('/pages/login.html'); } catch { location.href = '/pages/login.html'; }
}

// ---- Encrypt & Upload ----
const btnEncryptUpload = $('#btnEncryptUpload');
if (btnEncryptUpload) btnEncryptUpload.onclick = onEncryptUpload;

async function onEncryptUpload() {
  try {
    if (!getMkRaw()) return log('Not unlocked: please login (MK not ready).');
    if (!getUidHex()) return log('Run SDM Exchange / Login first.');

    const convId = (convEl?.value || 'conv_demo').trim() || 'conv_demo';
    const f = fileEl?.files?.[0];
    if (!f) return log('Choose a file first.');
    log({ file: { name: f.name, type: f.type || 'application/octet-stream', size: f.size } });

    const res = await encryptAndPut({ convId, file: f });
    lastKeyEl.value = res.objectKey || '';
    log({ put: { key: lastKeyEl.value, size: res.size } });
    log({ messageIndexed: res.message });
  } catch (e) {
    log({ encryptUploadError: String(e?.message || e) });
  }
}

// ---- Sign-Get & Preview ----
const btnSignGet = $('#btnSignGet');
if (btnSignGet) btnSignGet.onclick = onSignGet;
async function onSignGet() {
  const key = lastKeyEl?.value?.trim();
  if (!key) return log('No object key. Upload first.');
  try {
    const data = await signGet({ key });
    log({ download: data });
    const res = await fetch(data.download?.url);
    const buf = await res.arrayBuffer();
    const first = new Uint8Array(buf.slice(0, 32));
    log({ previewHex: hex(first) });
  } catch (e) {
    log({ previewError: String(e?.message || e) });
  }
}

// ---- Download & Decrypt ----
const btnDownload = $('#btnDownload');
if (btnDownload) btnDownload.onclick = onDownloadDecrypt;
async function onDownloadDecrypt() {
  try {
    if (!getMkRaw()) return log('Not unlocked: MK not ready.');
    const key = lastKeyEl?.value?.trim();
    if (!key) return log('No object key. Upload first.');
    // If UI has meta cached use it; otherwise the feature will consult local cache
    const metaRaw = localStorage.getItem('env_v1:' + key);
    const envelope = metaRaw ? JSON.parse(metaRaw) : null;
    const outObj = await downloadAndDecrypt({ key, envelope });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(outObj.blob);
    a.download = outObj.name;
    document.body.appendChild(a);
    a.click();
    URL.revokeObjectURL(a.href);
    a.remove();
    log({ downloaded: { bytes: outObj.bytes, name: outObj.name, type: outObj.contentType } });
  } catch (e) {
    log({ decryptError: String(e?.message || e) });
  }
}

// ---- Messages loading & rendering ----
async function onLoadMessages() {
  try {
    const conversationId = prompt('輸入 conversationId（base64url）:');
    const tokenB64 = prompt('輸入 conversation token（base64url）:');
    const peer = prompt('輸入對方 UID HEX（14 hex）：');
    if (!conversationId || !tokenB64 || !peer) return;
    const peerUidHex = String(peer).replace(/[^0-9a-f]/gi, '').toUpperCase();
    const { items, nextCursorTs, errors } = await listSecureAndDecrypt({ conversationId, tokenB64, peerUidHex, limit: 20 });
    renderMessages(items);
    if (errors && errors.length) log({ decryptErrors: errors });
    if (nextCursorTs) log({ nextCursorTs });
  } catch (e) {
    log({ loadMessagesError: String(e?.message || e) });
  }
}

function renderMessages(items) {
  const ul = document.querySelector('#msgList');
  if (!ul) return;
  ul.innerHTML = '';
  for (const it of items) {
    const li = document.createElement('li');
    li.style.padding = '6px 0';
    const ts = it.ts ? new Date(it.ts * 1000).toLocaleString() : '';
    if (it.text) {
      li.textContent = `[${ts}] ${it.text}`;
    } else {
      li.textContent = `[${ts}] [cipher ${it.type || ''}]`;
    }
    ul.appendChild(li);
  }
  if (!items || !items.length) {
    const li = document.createElement('li');
    li.textContent = '（沒有訊息）';
    ul.appendChild(li);
  }
}

// ---- helpers ----
function safeJSON(text){ try{ return JSON.parse(text); }catch{ return text; } }
async function safeParse(r){ const t=await r.text(); try{ return JSON.parse(t);}catch{return t;} }
function hex(u8){ return Array.from(u8).map(b=>b.toString(16).padStart(2,'0')).join(''); }
function b64u8(b64s){ const bin=atob(String(b64s||'')); const u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i); return u8; }

// ---- DR helpers (UI) ----
function getPeerFromInput(){
  const el = document.querySelector('#peerUidHex');
  const v = (el?.value || '').replace(/[^0-9a-f]/gi,'').toUpperCase();
  return v;
}
async function onInitDr(){
  try {
    if (!getMkRaw()) return log('Not unlocked: MK not ready.');
    const peer = getPeerFromInput(); if (!peer) return log('請輸入對方 UID（14 hex）');
    await ensureDrSession({ peerUidHex: peer });
    log({ drSession: 'initialized', peer });
  } catch (e) {
    log({ drInitError: String(e?.message || e) });
  }
}
async function onSendText(){
  try {
    if (!getMkRaw()) return log('Not unlocked: MK not ready.');
    const peer = getPeerFromInput(); if (!peer) return log('請輸入對方 UID（14 hex）');
    const textEl = document.querySelector('#drText');
    const text = (textEl?.value || '').toString();
    if (!text) return log('請輸入要傳送的文字');
    const convId = (convEl?.value || '').trim() || `dm-${getUidHex()}-to-${peer}`;
    const res = await sendDrText({ peerUidHex: peer, text, convId });
    log({ drSend: true, msg: res.msg, convId: res.convId });
    if (textEl) textEl.value = '';
  } catch (e) {
    log({ drSendError: String(e?.message || e) });
  }
}
