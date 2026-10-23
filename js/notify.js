// Nhắc việc: tính thời điểm nhắc, xin quyền, hiện thông báo.
//
// Giới hạn quan trọng: web app không thể tự hẹn giờ thông báo khi đã bị đóng hẳn
// (iOS không hỗ trợ Notification Triggers; muốn vậy phải có máy chủ Web Push).
// Vì vậy bộ hẹn giờ ở đây chạy khi app đang mở / còn chạy nền, và khi mở lại app
// sẽ "nhắc bù" các lời nhắc bị lỡ trong vài giờ gần nhất nếu sự việc chưa diễn ra.
// Khi đã kết nối máy chủ và bật thông báo đẩy trên thiết bị này, máy chủ gửi lời nhắc
// (kể cả khi app tắt) nên bộ hẹn giờ trong app tự tắt để không nhắc trùng.

import * as db from './db.js';
import { dueReminders, message } from './reminders.js';

export { REMIND_OPTIONS, VALID_REMIND } from './reminders.js';

const CHECK_EVERY_MS = 20_000;
const CATCH_UP_MS = 6 * 3600e3; // nhắc bù lời nhắc bị lỡ trong 6 giờ qua
const KEEP_FIRED_MS = 3 * 864e5;
const MAX_AT_ONCE = 5;

export const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () =>
  navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/**
 * Trạng thái thông báo trên thiết bị:
 *  'granted' | 'default' | 'denied'  – theo quyền của trình duyệt
 *  'ios-install'  – iPhone mở bằng Safari, phải thêm vào Màn hình chính trước
 *  'insecure'     – đang mở qua http (không phải HTTPS / localhost)
 *  'unsupported'  – trình duyệt không hỗ trợ (vd iOS < 16.4)
 */
export function status() {
  if (!window.isSecureContext) return 'insecure';
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return isIOS() && !isStandalone() ? 'ios-install' : 'unsupported';
  }
  return Notification.permission;
}

export async function requestPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch { /* Safari cũ dùng callback, bỏ qua */ }
  }
  return status();
}

export const hasAnyReminder = (data) =>
  [...data.courses, ...data.deadlines, ...data.events].some((x) => x.remind?.length);

async function showSystem(title, options) {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((r) => setTimeout(() => r(null), 3000)),
  ]);
  if (reg) return reg.showNotification(title, options);
  new Notification(title, options); // không có SW (hiếm): dùng API cũ
}

// ---------- Bộ hẹn giờ ----------

let getData = () => null;
let onInApp = () => {};
let running = false;

/** Hiện một lời nhắc: thông báo hệ thống nếu có quyền, không thì nhắc trong app. */
async function deliver({ title, body, tag }) {
  if (status() === 'granted') {
    try {
      await showSystem(title, { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './#today' } });
      return;
    } catch (err) {
      console.warn('Không hiện được thông báo hệ thống', err);
    }
  }
  onInApp({ title, body });
}

export async function check() {
  const data = getData();
  if (running || !data) return;
  running = true;
  try {
    if ((await db.get('settings', 'server'))?.pushEnabled) return; // máy chủ lo việc nhắc
    const now = Date.now();
    const meta = (await db.get('settings', 'notify')) || { key: 'notify', fired: {} };
    const { due, list } = dueReminders(data, now, CATCH_UP_MS, (k) => !!meta.fired[k]);
    if (!due.length) return;

    for (const r of due) meta.fired[r.key] = now;
    for (const [k, t] of Object.entries(meta.fired)) if (now - t > KEEP_FIRED_MS) delete meta.fired[k];
    await db.put('settings', meta);

    for (const r of list.slice(0, MAX_AT_ONCE)) await deliver({ ...message(r, now), tag: r.key });
    if (list.length > MAX_AT_ONCE) {
      await deliver({ title: 'Lịch Học', body: `Còn ${list.length - MAX_AT_ONCE} lời nhắc khác, mở app để xem.`, tag: 'more' });
    }
  } finally {
    running = false;
  }
}

export function startScheduler(dataGetter, inAppHandler) {
  getData = dataGetter;
  onInApp = inAppHandler;
  setInterval(check, CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  check();
}

export function sendTest() {
  return deliver({ title: 'Lịch Học', body: 'Thông báo thử: nhắc việc đang hoạt động.', tag: 'test' });
}
