// Tính lời nhắc (thuần, không phụ thuộc trình duyệt) – dùng chung cho app và máy chủ.

import { itemsForDate } from './schedule.js';
import { dateKey, addDays, timeOf, fmtDue, fmtDuration } from './time.js';

export const REMIND_OPTIONS = [
  { min: 15, label: '15 phút' },
  { min: 60, label: '1 giờ' },
  { min: 1440, label: '1 ngày' },
];
export const VALID_REMIND = REMIND_OPTIONS.map((o) => o.min);

/** Mọi lời nhắc có thể xảy ra từ hôm nay đến 2 ngày tới (đủ cho "nhắc trước 1 ngày"). */
export function reminders(data, now = Date.now()) {
  const list = [];
  const today = dateKey(now);
  for (let i = 0; i <= 2; i++) {
    for (const it of itemsForDate(addDays(today, i), data)) {
      if (it.kind === 'deadline') continue; // deadline xử lý riêng bên dưới
      for (const min of it.ref.remind || []) {
        list.push({ key: `${it.kind}:${it.id}:${it.startMs}:${min}`, fireAt: it.startMs - min * 60000, item: it, min });
      }
    }
  }
  for (const d of data.deadlines) {
    if (d.done) continue;
    for (const min of d.remind || []) {
      list.push({
        key: `deadline:${d.id}:${d.due}:${min}`, fireAt: d.due - min * 60000, min,
        item: { kind: 'deadline', title: d.title, startMs: d.due, endMs: d.due, ref: d },
      });
    }
  }
  return list;
}

/**
 * Lời nhắc tới hạn trong khoảng (now - windowMs, now], chưa gửi (isFired), sự việc chưa diễn ra.
 * Trả về { due: [lời nhắc cần đánh dấu đã gửi], list: [mỗi sự việc một lời nhắc, sắp theo giờ] }.
 */
export function dueReminders(data, now, windowMs, isFired) {
  const due = reminders(data, now).filter((r) =>
    r.fireAt <= now && r.fireAt > now - windowMs && r.item.startMs > now && !isFired(r.key));
  // Mỗi sự việc chỉ nhắc một lần (lấy mốc gần nhất nếu bị lỡ nhiều mốc).
  const byItem = new Map();
  for (const r of [...due].sort((a, b) => a.fireAt - b.fireAt)) byItem.set(`${r.item.kind}:${r.item.ref.id}:${r.item.startMs}`, r);
  const list = [...byItem.values()].sort((a, b) => a.item.startMs - b.item.startMs);
  return { due, list };
}

/** Nội dung thông báo cho một lời nhắc. */
export function message(r, now) {
  const { item } = r;
  const left = fmtDuration(item.startMs - now);
  if (item.kind === 'deadline') {
    return { title: `Sắp đến hạn: ${item.title}`, body: `Hạn nộp ${fmtDue(item.startMs, now)} · còn ${left}` };
  }
  const where = item.sub ? ` · ${item.sub}` : '';
  return { title: `Sắp bắt đầu: ${item.title}`, body: `${timeOf(item.startMs)}–${timeOf(item.endMs)}${where} · còn ${left}` };
}
