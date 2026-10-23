// Xếp lịch Google thành môn học / sự kiện của app (thuần, không phụ thuộc trình duyệt) –
// dùng chung cho app (nhập file) và máy chủ (tự đồng bộ link iCal).

import { weekNumber, weekdayOf, mondayOf } from './time.js';
import { COURSE_COLORS } from './schedule.js';

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

/** Lựa chọn cho từng ứng viên: đã lưu trước đó, nếu không thì đoán. */
export function resolveChoices(candidates, savedMap = {}) {
  return Object.fromEntries(candidates.map((c) => [c.uid, savedMap[c.uid] || guessChoice(c)]));
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
 * Tính kết quả nhập (không ghi gì).
 * data: { courses, events, settings } hiện có.
 * Trả về { courses, events, removeCourseIds, removeEventIds } – courses/events là bản ghi mới cần ghi.
 * Bản ghi cũ cùng id được giữ màu, giảng viên, nhắc việc, loại do người dùng đặt.
 */
export function planImport(candidates, choices, data) {
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
  for (const c of oldCourses) usedColors.add(c.color);
  let colorIdx = 0;
  const nextColor = () => {
    for (let i = 0; i < COURSE_COLORS.length; i++) {
      const col = COURSE_COLORS[(colorIdx + i) % COURSE_COLORS.length];
      if (!usedColors.has(col)) { colorIdx += i + 1; usedColors.add(col); return col; }
    }
    return COURSE_COLORS[colorIdx++ % COURSE_COLORS.length];
  };

  const courses = [];
  for (const [key, g] of groups) {
    const id = `gcal-${hash(key)}`;
    const old = oldById.get(id);
    const sessions = g.items
      .sort((a, b) => recOf(a.c).byday[0] - recOf(b.c).byday[0] || a.c.start.localeCompare(b.c.start) || a.c.uid.localeCompare(b.c.uid))
      .map(({ c, label }) => {
        const rec = recOf(c);
        return { weekday: rec.byday[0], mode: 'time', start: c.start, end: c.end, label, room: c.location, rec, gcalUid: c.uid };
      });
    const starts = sessions.map((s) => s.rec.start).sort();
    const ends = sessions.map((s) => s.rec.until).filter(Boolean).sort();
    const weekFrom = Math.max(1, weekNumber(starts[0], semesterStart));
    const weekTo = Math.max(weekFrom, ends.length ? weekNumber(ends.at(-1), semesterStart) : weekFrom + 14);
    courses.push({
      id, name: g.base, room: mostCommon(sessions.map((s) => s.room)),
      teacher: old?.teacher || '', color: old?.color || nextColor(),
      weekFrom: Math.min(weekFrom, 60), weekTo: Math.min(weekTo, 60), sessions,
      remind: old?.remind ?? [15], source: 'gcal', calendar: g.calendar, gcalUids: sessions.map((s) => s.gcalUid),
    });
  }

  // ----- Sự kiện -----
  const events = [];
  for (const c of candidates) {
    const choice = choices[c.uid];
    if (!choice || choice === 'course' || choice === 'skip') continue;
    const id = `gcal-${hash(`${c.calendar}|${c.uid}`)}`;
    const old = oldById.get(id);
    const base = {
      id, title: c.title, type: choice, location: c.location, start: c.start, end: c.end,
      remind: old?.remind ?? [15], source: 'gcal', calendar: c.calendar, gcalUid: c.uid,
    };
    events.push(c.kind === 'series'
      ? { ...base, repeat: 'rec', rec: c.rec, weekday: c.rec.byday[0] }
      : { ...base, repeat: 'once', date: c.date });
  }

  const keep = new Set([...courses, ...events].map((x) => x.id));
  return {
    courses, events,
    removeCourseIds: oldCourses.filter((c) => !keep.has(c.id)).map((c) => c.id),
    removeEventIds: oldEvents.filter((e) => !keep.has(e.id)).map((e) => e.id),
  };
}

/** So sánh hai bản ghi, bỏ qua dấu thời gian sửa đổi (để không ghi lại khi không có gì đổi). */
export function sameRecord(a, b) {
  if (!a || !b) return false;
  const strip = ({ updatedAt, ...rest }) => rest;
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
