// Remembers folders (Chromium handles, via IndexedDB) and settings (localStorage)
// so a rescan next month is one click. Everything is optional: private windows
// or blocked storage just mean starting fresh.

const DB_NAME = 'most-used-sounds';
const STORE = 'kv';
const SETTINGS_KEY = 'most-used-sounds:settings';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadHandles() {
  try {
    return (await run('readonly', (s) => s.get('sources'))) ?? [];
  } catch {
    return [];
  }
}

export async function saveHandles(sources) {
  try {
    await run('readwrite', (s) => s.put(sources, 'sources'));
  } catch {
    // Storage unavailable — folders just won't be remembered.
  }
}

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
  } catch {
    return {};
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}
