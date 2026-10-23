// Lớp dữ liệu: IndexedDB, chạy hoàn toàn offline.
//
// Kho (object store):
//   courses   { id, name, room, teacher, color, weekFrom, weekTo,
//               sessions: [{ weekday 1-7, mode 'time'|'period', start, end, periodFrom, periodTo, label?, room?, rec? }] }
//   deadlines { id, title, courseId|null, due (epoch ms), priority 1|2|3, note, done, doneAt }
//   events    { id, title, type 'meeting'|'activity'|'personal'|'exam', location,
//               repeat 'once'|'weekly'|'rec', date (once), weekday (weekly), rec (rec), start, end }
//   settings  { key: 'app', semesterStart, periods: [{ start, end }], gcalMap, seeded, lastBackup }
//             { key: 'notify', fired: { [reminderKey]: epoch ms } }  – lời nhắc đã gửi (riêng máy này)
//             { key: 'server', url, token, lastRev, pushEnabled… }  – kết nối máy chủ (riêng máy này)
//   outbox    { key: 'store/id', store, id, data | null, updated } – thay đổi chờ gửi lên máy chủ
// courses / deadlines / events có thêm remind: [15 | 60 | 1440] và updatedAt (epoch ms).
// Bản ghi mẫu có cờ sample: true – không bao giờ được đồng bộ lên máy chủ.

import { todayKey, mondayOf } from './time.js';

const DB_NAME = 'lichhoc';
const DB_VERSION = 2;
export const STORES = ['courses', 'deadlines', 'events'];
/** Các trường cài đặt dùng chung giữa các thiết bị (phần còn lại là riêng từng máy). */
export const SHARED_SETTINGS = ['semesterStart', 'periods', 'gcalMap', 'lastGcalImport'];

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
let outboxOn = false;
const listeners = new Set();

/** Bật / tắt ghi thay đổi vào hàng đợi (khi đã kết nối máy chủ). */
export function setOutbox(on) { outboxOn = on; }
/** Lắng nghe mỗi khi có thay đổi được xếp hàng (để kích hoạt đồng bộ). */
export function onLocalChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notifyChange = () => { for (const fn of listeners) fn(); };

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
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
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

/** Chạy fn(tx) trên nhiều kho trong một transaction. */
async function txn(stores, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    fn(tx);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// ---------- Hàng đợi đồng bộ ----------

const isSynced = (store, obj) =>
  (STORES.includes(store) && !obj.sample) || (store === 'settings' && obj.key === 'app');

function pickShared(settings) {
  return Object.fromEntries(SHARED_SETTINGS.filter((k) => k in settings).map((k) => [k, settings[k]]));
}

function entryFor(store, obj) {
  if (store === 'settings') return { key: 'settings/app', store, id: 'app', data: pickShared(obj), updated: obj.updatedAt };
  return { key: `${store}/${obj.id}`, store, id: obj.id, data: obj, updated: obj.updatedAt };
}
const tombstone = (store, id) => ({ key: `${store}/${id}`, store, id, data: null, updated: Date.now() });

// ---------- Đọc / ghi ----------

export const getAll = (store) => run(store, 'readonly', (s) => s.getAll());
export const get = (store, id) => run(store, 'readonly', (s) => s.get(id));

export async function put(store, obj) {
  const synced = isSynced(store, obj);
  const value = synced ? { ...obj, updatedAt: Date.now() } : obj;
  const queue = synced && outboxOn;
  await txn(queue ? [store, 'outbox'] : [store], (tx) => {
    tx.objectStore(store).put(value);
    if (queue) tx.objectStore('outbox').put(entryFor(store, value));
  });
  if (queue) notifyChange();
  return value;
}

export async function remove(store, id) {
  const queue = outboxOn && STORES.includes(store);
  await txn(queue ? [store, 'outbox'] : [store], (tx) => {
    tx.objectStore(store).delete(id);
    if (queue) tx.objectStore('outbox').put(tombstone(store, id));
  });
  if (queue) notifyChange();
}

/** Xóa mọi bản ghi thỏa điều kiện. */
export async function removeWhere(store, pred) {
  const queue = outboxOn && STORES.includes(store);
  await txn(queue ? [store, 'outbox'] : [store], (tx) => {
    const req = tx.objectStore(store).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (pred(cur.value)) {
        if (queue && !cur.value.sample) tx.objectStore('outbox').put(tombstone(store, cur.value.id));
        cur.delete();
      }
      cur.continue();
    };
  });
  if (queue) notifyChange();
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
  return put('settings', { ...(await getSettings()), ...patch, key: 'app' });
}

/**
 * Thay toàn bộ môn học / deadline / sự kiện trong MỘT transaction:
 * nếu có lỗi giữa chừng thì không mất dữ liệu cũ.
 */
export async function replaceAll({ courses, deadlines, events, settings }) {
  const current = await getSettings();
  const now = Date.now();
  const queue = outboxOn;
  await txn([...STORES, 'settings', ...(queue ? ['outbox'] : [])], (tx) => {
    const rows = { courses, deadlines, events };
    for (const s of STORES) {
      const store = tx.objectStore(s);
      const keep = new Set(rows[s].map((r) => r.id));
      const keysReq = store.getAllKeys();
      keysReq.onsuccess = () => {
        if (queue) for (const id of keysReq.result) if (!keep.has(id)) tx.objectStore('outbox').put(tombstone(s, id));
        store.clear();
        for (const r of rows[s]) {
          const value = { ...r, updatedAt: now };
          store.put(value);
          if (queue && !value.sample) tx.objectStore('outbox').put(entryFor(s, value));
        }
      };
    }
    const nextSettings = { ...current, ...settings, key: 'app', seeded: true, updatedAt: now };
    tx.objectStore('settings').put(nextSettings);
    if (queue) tx.objectStore('outbox').put(entryFor('settings', nextSettings));
  });
  if (queue) notifyChange();
}

/** Nạp toàn bộ dữ liệu một lần (dữ liệu sinh viên nhỏ, đủ nhanh). */
export async function loadAll() {
  const [courses, deadlines, events, settings] = await Promise.all([
    getAll('courses'), getAll('deadlines'), getAll('events'), getSettings(),
  ]);
  courses.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  return { courses, deadlines, events, settings };
}

// ---------- Dùng cho đồng bộ (sync.js) ----------

export const getOutbox = () => getAll('outbox');

/** Xóa các mục đã gửi thành công (bỏ qua mục bị sửa tiếp trong lúc đang gửi). */
export function ackOutbox(sent) {
  return txn(['outbox'], (tx) => {
    const ob = tx.objectStore('outbox');
    for (const s of sent) {
      const req = ob.get(s.key);
      req.onsuccess = () => { if (req.result && req.result.updated === s.updated) ob.delete(s.key); };
    }
  });
}

/** Xếp hàng toàn bộ dữ liệu (không phải mẫu) – dùng khi kết nối máy chủ lần đầu. */
export async function enqueueAll() {
  const data = await loadAll();
  const now = Date.now();
  await txn(['outbox'], (tx) => {
    const ob = tx.objectStore('outbox');
    for (const s of STORES) {
      for (const r of data[s]) if (!r.sample) ob.put(entryFor(s, { ...r, updatedAt: r.updatedAt || now }));
    }
    ob.put(entryFor('settings', { ...data.settings, updatedAt: data.settings.updatedAt || now }));
  });
}

export const wipeOutbox = () => txn(['outbox'], (tx) => tx.objectStore('outbox').clear());

/** Xóa sạch dữ liệu trên máy này (kể cả dữ liệu mẫu) – dùng khi chọn "lấy dữ liệu máy chủ". */
export function wipeLocal() {
  return txn([...STORES, 'outbox'], (tx) => {
    for (const s of [...STORES, 'outbox']) tx.objectStore(s).clear();
  });
}

/**
 * Ghi các thay đổi nhận từ máy chủ (không xếp hàng lại).
 * changes: [{ store, id, data, updated, deleted }]
 * Bỏ qua thay đổi cũ hơn bản đang chờ gửi trên máy này.
 */
export function applyRemote(changes) {
  return txn([...STORES, 'settings', 'outbox'], (tx) => {
    const pendingReq = tx.objectStore('outbox').getAll();
    pendingReq.onsuccess = () => {
      const pending = new Map(pendingReq.result.map((o) => [o.key, o]));
      for (const ch of changes) {
        const local = pending.get(`${ch.store}/${ch.id}`);
        if (local && local.updated > ch.updated) continue;
        if (ch.store === 'settings') {
          if (ch.id !== 'app' || ch.deleted || !ch.data) continue;
          const st = tx.objectStore('settings');
          const g = st.get('app');
          g.onsuccess = () => st.put({ ...defaultSettings(), ...g.result, ...pickShared(ch.data), key: 'app', seeded: true, updatedAt: ch.updated });
        } else if (STORES.includes(ch.store)) {
          if (ch.deleted || !ch.data) tx.objectStore(ch.store).delete(ch.id);
          else tx.objectStore(ch.store).put({ ...ch.data, id: ch.id });
        }
      }
    };
  });
}
