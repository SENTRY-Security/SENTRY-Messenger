// Minimal IndexedDB helper for queue storage with in-memory fallback.

const DB_NAME = 'sentry-message-queue';
const DB_VERSION = 2;
export const OUTBOX_STORE = 'outbox';
export const INBOX_STORE = 'inbox';

let dbPromise = null;
let fallback = typeof indexedDB === 'undefined';
const memoryStores = {
  [OUTBOX_STORE]: new Map(),
  [INBOX_STORE]: new Map()
};

function getMemoryStore(name) {
  if (!memoryStores[name]) memoryStores[name] = new Map();
  return memoryStores[name];
}

const cloneValue = (value) => {
  if (typeof structuredClone === 'function') return structuredClone(value);
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

async function openDb() {
  if (fallback) return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
          const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'jobId' });
          store.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });
          store.createIndex('state', 'state', { unique: false });
          store.createIndex('conversationId', 'conversationId', { unique: false });
        }
        if (!db.objectStoreNames.contains(INBOX_STORE)) {
          const store = db.createObjectStore(INBOX_STORE, { keyPath: 'jobId' });
          store.createIndex('nextAttemptAt', 'nextAttemptAt', { unique: false });
          store.createIndex('state', 'state', { unique: false });
          store.createIndex('conversationId', 'conversationId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        fallback = true;
        resolve(null);
      };
      req.onblocked = () => resolve(req.result);
    } catch {
      fallback = true;
      resolve(null);
    }
  });
  return dbPromise;
}

export async function putOutboxRecord(job) {
  const payload = cloneValue(job);
  const db = await openDb();
  if (!db) {
    getMemoryStore(OUTBOX_STORE).set(payload.jobId, payload);
    return payload;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      tx.oncomplete = () => resolve(payload);
      tx.onerror = () => {
        fallback = true;
        getMemoryStore(OUTBOX_STORE).set(payload.jobId, payload);
        resolve(payload);
      };
      tx.objectStore(OUTBOX_STORE).put(payload);
    } catch {
      fallback = true;
      getMemoryStore(OUTBOX_STORE).set(payload.jobId, payload);
      resolve(payload);
    }
  });
}

export async function getOutboxRecord(jobId) {
  const db = await openDb();
  if (!db) return getMemoryStore(OUTBOX_STORE).get(jobId) || null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      tx.oncomplete = () => {};
      tx.onerror = () => resolve(getMemoryStore(OUTBOX_STORE).get(jobId) || null);
      const req = tx.objectStore(OUTBOX_STORE).get(jobId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(getMemoryStore(OUTBOX_STORE).get(jobId) || null);
    } catch {
      resolve(getMemoryStore(OUTBOX_STORE).get(jobId) || null);
    }
  });
}

export async function deleteOutboxRecord(jobId) {
  const db = await openDb();
  getMemoryStore(OUTBOX_STORE).delete(jobId);
  if (!db) return true;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(OUTBOX_STORE, 'readwrite');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.objectStore(OUTBOX_STORE).delete(jobId);
    } catch {
      resolve(false);
    }
  });
}

export async function listOutboxRecords() {
  const db = await openDb();
  if (!db) return Array.from(getMemoryStore(OUTBOX_STORE).values());
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(OUTBOX_STORE, 'readonly');
      tx.oncomplete = () => {};
      tx.onerror = () => resolve(Array.from(getMemoryStore(OUTBOX_STORE).values()));
      const req = tx.objectStore(OUTBOX_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve(Array.from(getMemoryStore(OUTBOX_STORE).values()));
    } catch {
      resolve(Array.from(getMemoryStore(OUTBOX_STORE).values()));
    }
  });
}

export async function putInboxRecord(job) {
  const payload = cloneValue(job);
  const db = await openDb();
  if (!db) {
    getMemoryStore(INBOX_STORE).set(payload.jobId, payload);
    return payload;
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(INBOX_STORE, 'readwrite');
      tx.oncomplete = () => resolve(payload);
      tx.onerror = () => {
        fallback = true;
        getMemoryStore(INBOX_STORE).set(payload.jobId, payload);
        resolve(payload);
      };
      tx.objectStore(INBOX_STORE).put(payload);
    } catch {
      fallback = true;
      getMemoryStore(INBOX_STORE).set(payload.jobId, payload);
      resolve(payload);
    }
  });
}

export async function getInboxRecord(jobId) {
  const db = await openDb();
  if (!db) return getMemoryStore(INBOX_STORE).get(jobId) || null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(INBOX_STORE, 'readonly');
      tx.oncomplete = () => {};
      tx.onerror = () => resolve(getMemoryStore(INBOX_STORE).get(jobId) || null);
      const req = tx.objectStore(INBOX_STORE).get(jobId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(getMemoryStore(INBOX_STORE).get(jobId) || null);
    } catch {
      resolve(getMemoryStore(INBOX_STORE).get(jobId) || null);
    }
  });
}

export async function deleteInboxRecord(jobId) {
  const db = await openDb();
  getMemoryStore(INBOX_STORE).delete(jobId);
  if (!db) return true;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(INBOX_STORE, 'readwrite');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.objectStore(INBOX_STORE).delete(jobId);
    } catch {
      resolve(false);
    }
  });
}

export async function listInboxRecords() {
  const db = await openDb();
  if (!db) return Array.from(getMemoryStore(INBOX_STORE).values());
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(INBOX_STORE, 'readonly');
      tx.oncomplete = () => {};
      tx.onerror = () => resolve(Array.from(getMemoryStore(INBOX_STORE).values()));
      const req = tx.objectStore(INBOX_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve(Array.from(getMemoryStore(INBOX_STORE).values()));
    } catch {
      resolve(Array.from(getMemoryStore(INBOX_STORE).values()));
    }
  });
}
