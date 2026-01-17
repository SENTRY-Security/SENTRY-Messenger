// /app/ui/app-ui.js
// App page binder: Health, Media Encrypt&Upload (E2EE → R2 PUT), Sign‑Get & Preview, Download & Decrypt.
// Uses core modules (http/log/store). Does not depend on window globals from app.js.

import { log, setLogSink } from '../core/log.js';
import { resetAll, getAccountDigest, getMkRaw, setDeviceId, clearSecrets } from '../core/store.js';
import { triggerContactSecretsBackup } from '../features/contact-backup.js';
import { encryptAndPut, signGet, downloadAndDecrypt } from '../features/media.js';
import { messagesFlowFacade } from '../features/messages-flow-facade.js';
import { ensureDrSession, sendDrText } from '../features/dr-session.js';
import { getSimStoragePrefix, getSimStorageKey } from '../../libs/ntag424-sim.js';
import { unwrapDevicePrivWithMK } from '../crypto/prekeys.js';

// ---- UI elements ----
const $ = (sel) => document.querySelector(sel);
const out = $('#out'); setLogSink(out);

const SIM_STORAGE_PREFIX = (() => {
  try { return getSimStoragePrefix(); } catch { return 'ntag424-sim:'; }
})();
const SIM_STORAGE_KEY = (() => {
  try { return getSimStorageKey(); } catch { return null; }
})();

function summarizeMkForLog(mkRaw) {
  const summary = { mkLen: mkRaw instanceof Uint8Array ? mkRaw.length : 0, mkHash12: null };
  if (!(mkRaw instanceof Uint8Array) || typeof crypto === 'undefined' || !crypto.subtle?.digest) return Promise.resolve(summary);
  return crypto.subtle.digest('SHA-256', mkRaw).then((digest) => {
    const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    summary.mkHash12 = hex.slice(0, 12);
    return summary;
  }).catch(() => summary);
}

let mkSetTraceLogged = false;
async function emitMkSetTrace(sourceTag, mkRaw) {
  if (mkSetTraceLogged) return;
  mkSetTraceLogged = true;
  try {
    const { mkLen, mkHash12 } = await summarizeMkForLog(mkRaw);
    log({
      mkSetTrace: {
        sourceTag,
        mkLen,
        mkHash12,
        accountDigestSuffix4: (getAccountDigest() || '').slice(-4) || null,
        deviceIdSuffix4: null
      }
    });
  } catch { }
}

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
    const accountToken = sessionStorage.getItem('account_token');
    const accountDigest = sessionStorage.getItem('account_digest');
    const identityKey = accountDigest || null;
    if (identityKey) setAccountDigest(identityKey);
    if (accountToken) setAccountToken(accountToken);
    if (mkb64 && !getMkRaw()) {
      const mk = b64u8(mkb64);
      setMkRaw(mk);
      emitMkSetTrace('app-ui:handoff', mk);
    }
    // one-time handoff; clear after restore
    sessionStorage.removeItem('mk_b64');
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
  } catch (e) {
    log({ restoreError: String(e?.message || e) });
  }
})();

(function hydrateDevicePrivFromSession() {
  try {
    const serialized = sessionStorage.getItem('wrapped_dev');
    if (!serialized) return;
    sessionStorage.removeItem('wrapped_dev');
    const mk = getMkRaw();
    if (!mk) {
      log({ devicePrivRestoreSkipped: 'mk-missing' });
      return;
    }
    const parsed = JSON.parse(serialized);
    unwrapDevicePrivWithMK(parsed, mk)
      .then((priv) => {
        if (priv) {
          setDevicePriv(priv);
          log({ devicePrivRestored: true });
        }
      })
      .catch((err) => {
        log({ devicePrivRestoreError: err?.message || err });
      });
  } catch (err) {
    log({ devicePrivRestoreError: err?.message || err });
  }
})();
// If still not unlocked after restoration, redirect back to Login
(function ensureUnlockedOrRedirect() {
  try {
    if (!getMkRaw()) {
      log('Not unlocked: redirecting to /pages/logout.html …');
      setTimeout(() => location.replace('/pages/logout.html'), 200);
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
        <span class="muted">需要輸入對方帳號 digest（用於 DR 會話解密）</span>
      </div>
      <ul id="msgList" style="list-style: none; padding-left: 0; margin: 8px 0;"></ul>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:12px 0;" />
      <h3>(Dev) DR 文字訊息</h3>
      <div class="row">
        <label>Peer Account Digest</label>
        <input id="peerAccountDigest" placeholder="對方帳號 digest（hex）" style="min-width:220px" />
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
async function onLogout() {
  try {
    // Explicitly flush pending contact backups before we clear MK/Keys
    if (getMkRaw()) {
      const p = triggerContactSecretsBackup('secure-logout', { force: true });
      // Race to avoid hanging logout if network is dead (max 2s)
      const timeout = new Promise(r => setTimeout(r, 2000));
      await Promise.race([p, timeout]);
    }
  } catch (err) {
    log({ logoutBackupFlushError: err?.message || err });
  }
  try {
    // clear ephemeral handoff storage
    sessionStorage.removeItem('mk_b64');
    sessionStorage.removeItem('account_token');
    sessionStorage.removeItem('account_digest');
    sessionStorage.removeItem('wrapped_dev');
  } catch { }
  try {
    sessionStorage.clear?.();
  } catch (err) {
    log({ logoutSessionClearError: err?.message || err });
  }
  try {
    sessionStorage.setItem('app:lastLogoutReason', '已登出');
  } catch { }
  try {
    // clear local envelope cache (env_v1:*), 保留模擬資料
    const del = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || isSimStorageKey(k)) continue;
      if (k.startsWith('env_v1:')) del.push(k);
    }
    for (const k of del) {
      try { localStorage.removeItem(k); } catch { }
    }
  } catch { }
  try {
    // clear all in-memory state (MK, DR sessions, UID, etc.)
    resetAll();
  } catch { try { clearSecrets(); } catch { } }
  // navigate to logout page
  try { location.replace('/pages/logout.html'); } catch { location.href = '/pages/logout.html'; }
}

// ---- Encrypt & Upload ----
const btnEncryptUpload = $('#btnEncryptUpload');
if (btnEncryptUpload) btnEncryptUpload.onclick = onEncryptUpload;

async function onEncryptUpload() {
  try {
    if (!getMkRaw()) return log('Not unlocked: please login (MK not ready).');
    if (!getAccountDigest()) return log('請先完成 SDM Exchange / Login 取得帳號 digest。');

    const identity = getAccountDigest() || null;
    const convId = (convEl?.value || '').trim() || (identity ? `conv-${identity.slice(-8)}` : 'conv_demo');
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
    const peer = prompt('輸入對方帳號 digest（hex）：');
    if (!conversationId || !tokenB64 || !peer) return;
    const peerDigest = String(peer).replace(/[^0-9a-f]/gi, '').toUpperCase();
    const peerDeviceId = null;
    if (!peerDeviceId) {
      throw new Error('peerDeviceId missing: UI 不應以手動輸入方式取得，請從既有會話資料提供');
    }
    const { items, nextCursor, nextCursorTs, errors } = await messagesFlowFacade.onScrollFetchMore({
      conversationId,
      tokenB64,
      peerAccountDigest: peerDigest,
      peerDeviceId,
      options: {
        limit: 20,
        sendReadReceipt: true
      }
    });
    renderMessages(items);
    if (errors && errors.length) log({ decryptErrors: errors });
    if (nextCursor || nextCursorTs) log({ nextCursor: nextCursor || { ts: nextCursorTs, id: null } });
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
function safeJSON(text) { try { return JSON.parse(text); } catch { return text; } }
async function safeParse(r) { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } }
function hex(u8) { return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(''); }
function b64u8(b64s) { const bin = atob(String(b64s || '')); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }

// ---- DR helpers (UI) ----
function getPeerFromInput() {
  const el = document.querySelector('#peerAccountDigest');
  const v = (el?.value || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return v;
}
async function onInitDr() {
  try {
    if (!getMkRaw()) return log('Not unlocked: MK not ready.');
    const peer = getPeerFromInput(); if (!peer) return log('請輸入對方帳號 digest');
    await ensureDrSession({ peerAccountDigest: peer });
    log({ drSession: 'initialized', peer });
  } catch (e) {
    log({ drInitError: String(e?.message || e) });
  }
}
async function onSendText() {
  try {
    if (!getMkRaw()) return log('Not unlocked: MK not ready.');
    const peer = getPeerFromInput(); if (!peer) return log('請輸入對方帳號 digest');
    const deviceInput = document.querySelector('#peerDeviceId');
    const peerDeviceId = (deviceInput?.value || '').trim();
    if (!peerDeviceId) return log('請輸入對方裝置 ID');
    const textEl = document.querySelector('#drText');
    const text = (textEl?.value || '').toString();
    if (!text) return log('請輸入要傳送的文字');
    const identity = getAccountDigest() || null;
    const convId = (convEl?.value || '').trim() || (identity ? `dm-${identity}-to-${peer}` : 'dm-demo');
    const messageId = crypto.randomUUID();
    const res = await sendDrText({ peerAccountDigest: peer, peerDeviceId, text, convId, messageId });
    log({ drSend: true, msg: res.msg, convId: res.convId });
    if (textEl) textEl.value = '';
  } catch (e) {
    log({ drSendError: String(e?.message || e) });
  }
}
