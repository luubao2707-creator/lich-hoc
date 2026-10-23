// Lớp dữ liệu: IndexedDB, chạy hoàn toàn offline.
//
// Kho (object store):
//   courses   { id, name, room, teacher, color, weekFrom, weekTo,
//               sessions: [{ weekday 1-7, mode 'time'|'period', start, end, periodFrom, periodTo }] }
//   deadlines { id, title, courseId|null, due (epoch ms), priority 1|2|3, note, done, doneAt }
//   events    { id, title, type 'meeting'|'activity'|'personal'|'exam', location,
//               repeat 'once'|'weekly', date (once), weekday (weekly), start, end }
//   settings  { key: 'app', semesterStart, periods: [{ start, end }], seeded, lastBackup }
//             { key: 'notify', fired: { [reminderKey]: epoch ms } }  – lời nhắc đã gửi
// courses / deadlines / events đều có thêm remind: [15 | 60 | 1440] (số phút nhắc trước).
// Bản ghi mẫu có thêm cờ sample: true để xóa riêng.

import { todayKey, mondayOf } from './time.js';

const DB_NAME = 'lichhoc';
const DB_VERSION = 1;
export const STORES = ['courses', 'deadlines', 'events'];

export const DEFAULT_PERIODS = [
  { start: '07:00', end: '07:50' },
  { start: '07:50', end: '08:40' },
  { start: '08:50', end: '09:40' },
  { start: '09:40', end: '10:30' },
  { start: '10:40', end: '11:30' },
  { start: '13:00', end: '13:50' },
  { start: '13:50', end: '14:40' },
  { start: '14:50', end: '15:40' },
  { start: '15:40', end: '16:30' },
  { start: '16:40', end: '17:30' },
  { start: '18:00', end: '18:50' },
  { start: '18:50', end: '19:40' },
];

let dbPromise;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => run(store, 'readonly', (s) => s.get(id));
export const put = (store, obj) => run(store, 'readwrite', (s) => s.put(obj)).then(() => obj);
export const remove = (store, id) => run(store, 'readwrite', (s) => s.delete(id));

/** Xóa mọi bản ghi thỏa điều kiện. */
export function removeWhere(store, pred) {
  return run(store, 'readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (pred(cur.value)) cur.delete();
      cur.continue();
    };
  });
}

export function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ---------- Cài đặt ----------

function defaultSettings() {
  return { key: 'app', semesterStart: mondayOf(todayKey()), periods: DEFAULT_PERIODS, seeded: false };
}

export async function getSettings() {
  const saved = await get('settings', 'app');
  return { ...defaultSettings(), ...saved };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch, key: 'app' };
  await put('settings', next);
  return next;
}

/**
 * Thay toàn bộ môn học / deadline / sự kiện trong MỘT transaction:
 * nếu có lỗi giữa chừng thì không mất dữ liệu cũ.
 */
export async function replaceAll({ courses, deadlines, events, settings }) {
  const current = await getSettings();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...STORES, 'settings'], 'readwrite');
    const rows = { courses, deadlines, events };
    for (const s of STORES) {
      const store = tx.objectStore(s);
      store.clear();
      for (const r of rows[s]) store.put(r);
    }
    tx.objectStore('settings').put({ ...current, ...settings, key: 'app', seeded: true });
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

/** Nạp toàn bộ dữ liệu một lần (dữ liệu sinh viên nhỏ, đủ nhanh). */
export async function loadAll() {
  const [courses, deadlines, events, settings] = await Promise.all([
    getAll('courses'), getAll('deadlines'), getAll('events'), getSettings(),
  ]);
  courses.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return { courses, deadlines, events, settings };
}
