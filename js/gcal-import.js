// Nhập lịch từ Google Calendar (file .ics): đoán loại, gộp môn học, ghi vào IndexedDB.
// Đồng bộ một chiều: nhập lại sẽ cập nhật đúng mục cũ (theo UID), giữ màu / nhắc việc /
// giảng viên người dùng đã đặt, và xóa những mục không còn trên Google.

import * as db from './db.js';
import { weekNumber, weekdayOf, mondayOf } from './time.js';
import { COURSE_COLORS } from './schedule.js';
import { clearSampleData } from './sample.js';

export const CHOICES = {
  course: 'Môn học',
  meeting: 'Họp',
  activity: 'Hoạt động',
  personal: 'Cá nhân',
  exam: 'Thi',
  skip: 'Bỏ qua',
};

const LABEL_RE = /\s*\(([^()]{1,12})\)\s*$/;
const CLASS_LABEL = /^(LT|BT|TN|TH|TL|ĐA|DA|LAB|LT\s*\+\s*BT|BT\s*\+\s*LT|LT\s*\+\s*TH)$/i;
const ROOM_RE = /^[A-ZĐ]{1,3}\d{0,2}[-\s.]?\d{2,4}[A-Z]?$/i;

/** Tách "Triết học Mác-Lênin (LT)" → { base: 'Triết học Mác-Lênin', label: 'LT' } */
export function splitTitle(title) {
  const m = title.match(LABEL_RE);
  return m ? { base: title.slice(0, m.index).trim(), label: m[1].trim() } : { base: title.trim(), label: '' };
}

/** Có chứa từ (đúng ranh giới từ, kể cả chữ có dấu) không. */
function hasWord(text, words) {
  const t = ` ${text.toLowerCase().normalize('NFC')} `;
  return words.some((w) => new RegExp(`[\\s(\\-:,./]${w}[\\s)\\-:,./]`, 'u').test(t));
}

/** Đoán loại mặc định cho một ứng viên. */
export function guessChoice(c) {
  const { label } = splitTitle(c.title);
  if (hasWord(c.title, ['thi', 'kiểm tra', 'giữa kỳ', 'cuối kỳ', 'giữa kì', 'cuối kì', 'midterm', 'final', 'exam'])) return 'exam';
  if (c.kind === 'series' && ((label && CLASS_LABEL.test(label)) || ROOM_RE.test(c.location))) return 'course';
  if (hasWord(c.title, ['họp', 'meeting', 'hội thảo', 'seminar', 'phỏng vấn'])) return 'meeting';
  if (hasWord(c.title, ['clb', 'câu lạc bộ', 'tình nguyện', 'bóng đá', 'bóng rổ', 'cầu lông', 'gym', 'tập', 'chạy bộ', 'bơi', 'sự kiện'])) return 'activity';
  return 'personal';
}

/** Mã ngắn ổn định từ chuỗi (FNV-1a 32-bit). */
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

const recOf = (c) => (c.kind === 'series' ? c.rec
  : { freq: 'WEEKLY', interval: 1, byday: [weekdayOf(c.date)], wkst: 1, start: c.date, until: c.date, exdates: [], extra: [] });

function mostCommon(values) {
  const n = new Map();
  for (const v of values.filter(Boolean)) n.set(v, (n.get(v) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

/** Gợi ý ngày bắt đầu tuần 1: Thứ Hai của buổi học sớm nhất. */
export function suggestSemesterStart(candidates, choices) {
  const starts = candidates.filter((c) => choices[c.uid] === 'course').map((c) => recOf(c).start).sort();
  return starts.length ? mondayOf(starts[0]) : null;
}

/**
 * Ghi kết quả nhập.
 * choices: { [uid]: key của CHOICES }
 * opts: { clearSample: bool, semesterStart: 'YYYY-MM-DD' | null }
 * Trả về { courses, events, removed }.
 */
export async function commitImport(candidates, choices, opts = {}) {
  if (opts.clearSample) await clearSampleData();
  if (opts.semesterStart) await db.saveSettings({ semesterStart: opts.semesterStart });

  const data = await db.loadAll();
  const { semesterStart } = data.settings;
  const calendars = new Set(candidates.map((c) => c.calendar));
  const oldCourses = data.courses.filter((c) => c.source === 'gcal' && calendars.has(c.calendar));
  const oldEvents = data.events.filter((e) => e.source === 'gcal' && calendars.has(e.calendar));
  const oldById = new Map([...oldCourses, ...oldEvents].map((x) => [x.id, x]));

  // ----- Môn học: gộp LT / BT / TN cùng tên -----
  const groups = new Map();
  for (const c of candidates) {
    if (choices[c.uid] !== 'course') continue;
    const { base, label } = splitTitle(c.title);
    const key = `${c.calendar}|${base.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { base, calendar: c.calendar, items: [] });
    groups.get(key).items.push({ c, label });
  }

  const usedColors = new Set(data.courses.filter((c) => !oldById.has(c.id)).map((c) => c.color));
  let colorIdx = 0;
  const nextColor = () => {
    for (let i = 0; i < COURSE_COLORS.length; i++) {
      const col = COURSE_COLORS[(colorIdx + i) % COURSE_COLORS.length];
      if (!usedColors.has(col)) { colorIdx += i + 1; usedColors.add(col); return col; }
    }
    return COURSE_COLORS[colorIdx++ % COURSE_COLORS.length];
  };

  const newCourses = [];
  for (const [key, g] of groups) {
    const id = `gcal-${hash(key)}`;
    const old = oldById.get(id);
    const sessions = g.items
      .sort((a, b) => recOf(a.c).byday[0] - recOf(b.c).byday[0] || a.c.start.localeCompare(b.c.start))
      .map(({ c, label }) => {
        const rec = recOf(c);
        return { weekday: rec.byday[0], mode: 'time', start: c.start, end: c.end, label, room: c.location, rec, gcalUid: c.uid };
      });
    const starts = sessions.map((s) => s.rec.start).sort();
    const ends = sessions.map((s) => s.rec.until).filter(Boolean).sort();
    const weekFrom = Math.max(1, weekNumber(starts[0], semesterStart));
    const weekTo = Math.max(weekFrom, ends.length ? weekNumber(ends.at(-1), semesterStart) : weekFrom + 14);
    newCourses.push({
      id, name: g.base, room: mostCommon(sessions.map((s) => s.room)),
      teacher: old?.teacher || '', color: old?.color || nextColor(),
      weekFrom: Math.min(weekFrom, 60), weekTo: Math.min(weekTo, 60), sessions,
      remind: old?.remind ?? [15], source: 'gcal', calendar: g.calendar, gcalUids: sessions.map((s) => s.gcalUid),
    });
  }

  // ----- Sự kiện -----
  const newEvents = [];
  for (const c of candidates) {
    const choice = choices[c.uid];
    if (!choice || choice === 'course' || choice === 'skip') continue;
    const id = `gcal-${hash(`${c.calendar}|${c.uid}`)}`;
    const old = oldById.get(id);
    const base = {
      id, title: c.title, type: choice, location: c.location, start: c.start, end: c.end,
      remind: old?.remind ?? [15], source: 'gcal', calendar: c.calendar, gcalUid: c.uid,
    };
    newEvents.push(c.kind === 'series'
      ? { ...base, repeat: 'rec', rec: c.rec, weekday: c.rec.byday[0] }
      : { ...base, repeat: 'once', date: c.date });
  }

  // ----- Ghi & dọn mục không còn -----
  const keep = new Set([...newCourses, ...newEvents].map((x) => x.id));
  let removed = 0;
  for (const c of oldCourses) if (!keep.has(c.id)) { await db.remove('courses', c.id); removed++; }
  for (const e of oldEvents) if (!keep.has(e.id)) { await db.remove('events', e.id); removed++; }
  for (const c of newCourses) await db.put('courses', c);
  for (const e of newEvents) await db.put('events', e);

  const courseIds = new Set((await db.getAll('courses')).map((c) => c.id));
  for (const d of data.deadlines) {
    if (d.courseId && !courseIds.has(d.courseId)) await db.put('deadlines', { ...d, courseId: null });
  }

  const settings = await db.getSettings();
  await db.saveSettings({ gcalMap: { ...(settings.gcalMap || {}), ...choices }, lastGcalImport: Date.now() });
  return { courses: newCourses.length, events: newEvents.length, removed };
}

/** Khi xóa một mục đã nhập: ghi nhớ "Bỏ qua" để lần nhập sau không thêm lại. */
export async function rememberSkip(uids) {
  const settings = await db.getSettings();
  const map = { ...(settings.gcalMap || {}) };
  for (const u of uids) map[u] = 'skip';
  await db.saveSettings({ gcalMap: map });
}

/** Xóa toàn bộ dữ liệu đã nhập từ Google Calendar. */
export async function removeAllImported() {
  await db.removeWhere('courses', (c) => c.source === 'gcal');
  await db.removeWhere('events', (e) => e.source === 'gcal');
  const courseIds = new Set((await db.getAll('courses')).map((c) => c.id));
  for (const d of await db.getAll('deadlines')) {
    if (d.courseId && !courseIds.has(d.courseId)) await db.put('deadlines', { ...d, courseId: null });
  }
}
