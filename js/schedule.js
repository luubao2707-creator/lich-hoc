// Logic lịch: tính các buổi học / sự kiện / deadline rơi vào một ngày.

import { weekdayOf, weekNumber, epochOf, dateKey, diffDays, addDays, mondayOf, fmtDate, WEEKDAY_SHORT } from './time.js';

export const COURSE_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

export const EVENT_TYPES = {
  meeting:  { label: 'Họp',       color: '#0ea5e9' },
  activity: { label: 'Hoạt động', color: '#22c55e' },
  personal: { label: 'Cá nhân',   color: '#a855f7' },
  exam:     { label: 'Thi',       color: '#dc2626' },
};

export const PRIORITIES = { 1: 'Thấp', 2: 'Trung bình', 3: 'Cao' };

// ---------- Lặp lại kiểu lịch (dùng cho dữ liệu nhập từ Google Calendar) ----------
//
// rec = {
//   freq: 'WEEKLY' | 'DAILY', interval: 1, byday: [1..7], wkst: 1 (Thứ Hai) | 7 (Chủ Nhật),
//   start: 'YYYY-MM-DD', until: 'YYYY-MM-DD' | null,
//   exdates: ['YYYY-MM-DD'],                       // buổi bị hủy hoặc bị dời
//   extra: [{ date, start, end, location }],       // buổi bị dời sang giờ / ngày khác
// }

function weekStartOf(key, wkst) {
  return wkst === 7 ? addDays(key, -(weekdayOf(key) % 7)) : mondayOf(key);
}

/** Ngày key có thuộc chuỗi lặp không (chưa tính extra). */
export function occursOn(rec, key) {
  if (key < rec.start || (rec.until && key > rec.until)) return false;
  if (rec.exdates?.includes(key)) return false;
  const interval = rec.interval || 1;
  if (rec.freq === 'DAILY') return diffDays(key, rec.start) % interval === 0;
  if (!rec.byday.includes(weekdayOf(key))) return false;
  const weeks = diffDays(weekStartOf(key, rec.wkst), weekStartOf(rec.start, rec.wkst)) / 7;
  return weeks % interval === 0;
}

/** "T2, T4" / "Hằng ngày" / "3 ngày/lần" */
function recDays(rec) {
  if (rec.freq === 'DAILY') return (rec.interval || 1) === 1 ? 'Hằng ngày' : `${rec.interval} ngày/lần`;
  if (rec.byday.length === 7 && (rec.interval || 1) === 1) return 'Hằng ngày';
  return rec.byday.map((d) => WEEKDAY_SHORT[d]).join(', ');
}

/** "T2, T4 · 2 tuần/lần · 31/08–13/12" */
export function describeRec(rec, { days = true } = {}) {
  const parts = [];
  if (days) {
    parts.push(recDays(rec));
  }
  if (rec.freq === 'WEEKLY' && rec.interval > 1) parts.push(`${rec.interval} tuần/lần`);
  const sameYear = !rec.until || rec.start.slice(0, 4) === rec.until.slice(0, 4);
  parts.push(rec.until ? `${fmtDate(rec.start, { year: !sameYear })}–${fmtDate(rec.until, { year: !sameYear })}` : `từ ${fmtDate(rec.start)}`);
  return parts.join(' · ');
}

// ---------- Buổi học ----------

/** Giờ bắt đầu/kết thúc thực tế của một buổi học (theo giờ hoặc theo tiết). */
export function sessionTimes(session, periods) {
  if (session.mode === 'period') {
    const from = periods[session.periodFrom - 1];
    const to = periods[session.periodTo - 1];
    if (!from || !to) return null;
    return { start: from.start, end: to.end };
  }
  return { start: session.start, end: session.end };
}

/** Mô tả ngắn: "T2 07:00–09:40 (tiết 1–3)" hoặc "LT · T2 08:25–11:45 · 2 tuần/lần" */
export function sessionLabel(session, periods) {
  const t = sessionTimes(session, periods);
  const time = t ? `${t.start}–${t.end}` : '??';
  if (session.rec) {
    const days = recDays(session.rec);
    const every = session.rec.freq === 'WEEKLY' && session.rec.interval > 1 ? ` · ${session.rec.interval} tuần/lần` : '';
    return `${session.label ? `${session.label} · ` : ''}${days} ${time}${every}`;
  }
  const base = `${WEEKDAY_SHORT[session.weekday]} ${time}`;
  return session.mode === 'period' ? `${base} (tiết ${session.periodFrom}–${session.periodTo})` : base;
}

/** Khoảng ngày của một môn nhập từ lịch: { from, to } hoặc null nếu môn nhập tay. */
export function courseDateRange(course) {
  const recs = course.sessions.map((s) => s.rec).filter(Boolean);
  if (!recs.length) return null;
  const from = recs.map((r) => r.start).sort()[0];
  const to = recs.some((r) => !r.until) ? null : recs.map((r) => r.until).sort().at(-1);
  return { from, to };
}

/**
 * Mọi mục của một ngày, đã sắp theo thời gian.
 * Mỗi mục: { kind, id, title, sub, color, startMs, endMs, ref }
 */
export function itemsForDate(key, data) {
  const { courses, events, deadlines, settings } = data;
  const wd = weekdayOf(key);
  const week = weekNumber(key, settings.semesterStart);
  const items = [];

  const courseItem = (c, id, start, end, room, label) => ({
    kind: 'course', id, title: label ? `${c.name} (${label})` : c.name, color: c.color,
    sub: [room || c.room, c.teacher].filter(Boolean).join(' · '),
    startMs: epochOf(key, start), endMs: epochOf(key, end), ref: c,
  });

  for (const c of courses) {
    c.sessions.forEach((s, i) => {
      if (s.rec) {
        if (occursOn(s.rec, key)) items.push(courseItem(c, `${c.id}#${i}`, s.start, s.end, s.room, s.label));
        for (const x of s.rec.extra || []) {
          if (x.date === key) items.push(courseItem(c, `${c.id}#${i}@${key}`, x.start, x.end, x.location || s.room, s.label));
        }
        return;
      }
      if (week < c.weekFrom || week > c.weekTo || s.weekday !== wd) return;
      const t = sessionTimes(s, settings.periods);
      if (t) items.push(courseItem(c, `${c.id}#${i}`, t.start, t.end, s.room, s.label));
    });
  }

  for (const e of events) {
    const type = EVENT_TYPES[e.type] || EVENT_TYPES.personal;
    const eventItem = (id, start, end, location) => ({
      kind: 'event', id, title: e.title, color: type.color,
      sub: [type.label, location].filter(Boolean).join(' · '),
      startMs: epochOf(key, start), endMs: epochOf(key, end), ref: e,
    });
    if (e.repeat === 'rec') {
      if (occursOn(e.rec, key)) items.push(eventItem(e.id, e.start, e.end, e.location));
      for (const x of e.rec.extra || []) {
        if (x.date === key) items.push(eventItem(`${e.id}@${key}`, x.start, x.end, x.location || e.location));
      }
      continue;
    }
    const hit = e.repeat === 'weekly' ? e.weekday === wd : e.date === key;
    if (hit) items.push(eventItem(e.id, e.start, e.end, e.location));
  }

  for (const d of deadlines) {
    if (dateKey(d.due) !== key) continue;
    const course = courses.find((c) => c.id === d.courseId);
    items.push({
      kind: 'deadline', id: d.id, title: d.title, color: course?.color || '#f97316',
      sub: course ? course.name : 'Deadline',
      startMs: d.due, endMs: d.due, ref: d,
    });
  }

  return items.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** Deadline chưa xong trong `days` ngày tới (kèm cả việc đã quá hạn), gấp nhất lên đầu. */
export function upcomingDeadlines(deadlines, now = Date.now(), days = 7) {
  const limit = now + days * 864e5;
  return deadlines
    .filter((d) => !d.done && d.due <= limit)
    .sort((a, b) => a.due - b.due || b.priority - a.priority);
}

export const isOverdue = (d, now = Date.now()) => !d.done && d.due < now;
