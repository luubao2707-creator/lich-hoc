// Đồng bộ với máy chủ riêng (Cloudflare Worker – thư mục server/).
//
// - Mọi thay đổi trên máy này được xếp vào outbox (db.js) và gửi lên khi có mạng.
// - Máy chủ trả về các thay đổi mới hơn (từ thiết bị khác, hoặc từ lịch Google mà máy chủ
//   tự đọc mỗi 5 phút). Bản sửa sau cùng thắng.
// - Thông báo đẩy (Web Push): máy chủ gửi lời nhắc kể cả khi app đã tắt.

import * as db from './db.js';

const AUTO_SYNC_MS = 60_000;
const DEBOUNCE_MS = 1500;

let onRemoteChange = () => {};
let syncing = null;
let debounceTimer;
const statusListeners = new Set();

export const getConfig = async () => (await db.get('settings', 'server')) || null;
async function saveConfig(patch) {
  const next = { ...(await getConfig()), ...patch, key: 'server' };
  await db.put('settings', next);
  return next;
}

export function onStatus(fn) { statusListeners.add(fn); return () => statusListeners.delete(fn); }
const emitStatus = async () => { const c = await getConfig(); for (const fn of statusListeners) fn(c); };

/** Gọi API máy chủ. */
async function api(cfg, path, { method = 'GET', body } = {}) {
  const res = await fetch(cfg.url.replace(/\/+$/, '') + path, {
    method,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw new Error('Mã truy cập không đúng.');
  if (!res.ok) throw new Error(`Máy chủ trả lỗi ${res.status}.`);
  return res.json();
}

// ---------- Kết nối ----------

/** Kiểm tra máy chủ trước khi kết nối: trả về { docs, ics } của máy chủ. */
export async function probe(url, token) {
  const cfg = { url: url.trim(), token: token.trim() };
  if (!/^https?:\/\//.test(cfg.url)) throw new Error('Địa chỉ máy chủ phải bắt đầu bằng https://');
  const info = await api(cfg, '/api/info');
  return { cfg, info };
}

/**
 * Kết nối máy chủ.
 * mode: 'merge' – gộp dữ liệu máy này với máy chủ; 'server' – bỏ dữ liệu máy này, lấy của máy chủ.
 */
export async function connect(cfg, mode) {
  if (mode === 'server') await db.wipeLocal();
  await saveConfig({ url: cfg.url, token: cfg.token, lastRev: 0, lastSync: null, lastError: null, pushEnabled: false });
  db.setOutbox(true);
  if (mode === 'merge') await db.enqueueAll();
  await syncNow();
}

export async function disconnect() {
  await unsubscribePush().catch(() => {});
  db.setOutbox(false);
  await db.put('settings', { key: 'server' });
  await db.wipeOutbox();
  await emitStatus();
}

// ---------- Đồng bộ ----------

/** Đồng bộ ngay (gộp các lần gọi trùng nhau). */
export function syncNow() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const cfg = await getConfig();
  if (!cfg?.url) return null;
  try {
    const outbox = await db.getOutbox();
    const res = await api(cfg, '/api/sync', {
      method: 'POST',
      body: { since: cfg.lastRev || 0, changes: outbox.map(({ store, id, data, updated }) => ({ store, id, data, updated })) },
    });
    await db.ackOutbox(outbox);
    if (res.changes?.length) await db.applyRemote(res.changes);
    await saveConfig({ lastRev: res.rev, lastSync: Date.now(), lastError: null, ics: res.ics || null });
    if (res.changes?.length) onRemoteChange();
    return res;
  } catch (err) {
    await saveConfig({ lastError: navigator.onLine === false ? 'Đang offline' : err.message });
    throw err;
  } finally {
    emitStatus();
  }
}

const quietSync = () => syncNow().catch(() => {});

/** Khởi động: bật outbox nếu đã kết nối, đồng bộ định kỳ và khi có thay đổi. */
export async function startSync(remoteChangeHandler) {
  onRemoteChange = remoteChangeHandler;
  const cfg = await getConfig();
  db.onLocalChange(() => { clearTimeout(debounceTimer); debounceTimer = setTimeout(quietSync, DEBOUNCE_MS); });
  setInterval(() => { if (!document.hidden) quietSync(); }, AUTO_SYNC_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) quietSync(); });
  window.addEventListener('online', quietSync);
  if (!cfg?.url) return;
  db.setOutbox(true);
  quietSync();
  refreshPushSubscription().catch(() => {});
}

// ---------- Lịch Google qua máy chủ ----------

/** Nội dung iCal mới nhất máy chủ đọc được (để xem lại phân loại). */
export async function fetchServerIcs() {
  const cfg = await getConfig();
  return api(cfg, '/api/ics');
}

/** Yêu cầu máy chủ đọc lại lịch Google ngay. */
export async function refreshServerIcs() {
  const cfg = await getConfig();
  const res = await api(cfg, '/api/ics/refresh', { method: 'POST' });
  await syncNow();
  return res;
}

// ---------- Thông báo đẩy ----------

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Bật nhận lời nhắc từ máy chủ trên thiết bị này. */
export async function subscribePush() {
  const cfg = await getConfig();
  if (!cfg?.url) throw new Error('Chưa kết nối máy chủ.');
  if (!pushSupported()) throw new Error('Thiết bị chưa hỗ trợ thông báo đẩy (iPhone cần iOS 16.4+ và mở app từ Màn hình chính).');
  if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') {
    throw new Error('Chưa được cấp quyền thông báo.');
  }
  const { publicKey } = await api(cfg, '/api/push/key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  await api(cfg, '/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceName() } });
  await saveConfig({ pushEnabled: true });
  emitStatus();
}

function sameKey(sub, publicKey) {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  const b = b64urlToBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function deviceName() {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Thiết bị';
}

export async function unsubscribePush() {
  const cfg = await getConfig();
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) {
    if (cfg?.url) await api(cfg, '/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  await saveConfig({ pushEnabled: false });
  emitStatus();
}

/** Gửi lại đăng ký mỗi lần mở app (đăng ký trên iOS có thể đổi / hết hạn). */
async function refreshPushSubscription() {
  const cfg = await getConfig();
  if (!cfg?.pushEnabled || !pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub || Notification.permission !== 'granted') { await saveConfig({ pushEnabled: false }); return; }
  await api(cfg, '/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON(), device: deviceName() } });
}

export async function sendTestPush() {
  const cfg = await getConfig();
  return api(cfg, '/api/push/test', { method: 'POST' });
}
