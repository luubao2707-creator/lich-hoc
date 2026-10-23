// Logic lịch: tính các buổi học / sự kiện / deadline rơi vào một ngày.

import { weekdayOf, weekNumber, epochOf, dateKey, WEEKDAY_SHORT } from './time.js';

export const COURSE_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

export const EVENT_TYPES = {
  meeting:  { label: 'Họp',       color: '#0ea5e9' },
  activity: { label: 'Hoạt động', color: '#22c55e' },
  personal: { label: 'Cá nhân',   color: '#a855f7' },
  exam:     { label: 'Thi',       color: '#dc2626' },
};

export const PRIORITIES = { 1: 'Thấp', 2: 'Trung bình', 3: 'Cao' };

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

/** Mô tả ngắn: "T2 07:00–09:40 (tiết 1–3)" */
export function sessionLabel(session, periods) {
  const t = sessionTimes(session, periods);
  const base = `${WEEKDAY_SHORT[session.weekday]} ${t ? `${t.start}–${t.end}` : '??'}`;
  return session.mode === 'period' ? `${base} (tiết ${session.periodFrom}–${session.periodTo})` : base;
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

  for (const c of courses) {
    if (week < c.weekFrom || week > c.weekTo) continue;
    c.sessions.forEach((s, i) => {
      if (s.weekday !== wd) return;
      const t = sessionTimes(s, settings.periods);
      if (!t) return;
      items.push({
        kind: 'course', id: `${c.id}#${i}`, title: c.name, color: c.color,
        sub: [c.room, c.teacher].filter(Boolean).join(' · '),
        startMs: epochOf(key, t.start), endMs: epochOf(key, t.end), ref: c,
      });
    });
  }

  for (const e of events) {
    const hit = e.repeat === 'weekly' ? e.weekday === wd : e.date === key;
    if (!hit) continue;
    const type = EVENT_TYPES[e.type] || EVENT_TYPES.personal;
    items.push({
      kind: 'event', id: e.id, title: e.title, color: type.color,
      sub: [type.label, e.location].filter(Boolean).join(' · '),
      startMs: epochOf(key, e.start), endMs: epochOf(key, e.end), ref: e,
    });
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
