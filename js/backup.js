// Sao lưu / khôi phục toàn bộ dữ liệu ra file JSON.

import * as db from './db.js';
import { todayKey, fmtDate, dateKey } from './time.js';
import { COURSE_COLORS, EVENT_TYPES } from './schedule.js';
import { VALID_REMIND, isIOS } from './notify.js';

const FORMAT = 'lichhoc-backup';
const FORMAT_VERSION = 1;

/**
 * Xuất dữ liệu đang có trong bộ nhớ. Hàm đồng bộ tới lúc gọi share/download
 * để không mất "user gesture" (Safari chặn share nếu đã chờ IndexedDB).
 * Trả về Promise<boolean>: false nếu người dùng hủy.
 */
export async function exportData(data) {
  const payload = {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: { semesterStart: data.settings.semesterStart, periods: data.settings.periods },
    courses: data.courses,
    deadlines: data.deadlines,
    events: data.events,
  };
  const name = `lichhoc-saoluu-${todayKey()}.json`;
  const file = new File([JSON.stringify(payload, null, 2)], name, { type: 'application/json' });

  let shared = false;
  // iPhone: dùng bảng Chia sẻ → "Lưu vào Tệp" (tải blob trong app ở MH chính không ổn định).
  if (isIOS() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Sao lưu Lịch Học' });
      shared = true;
    } catch (err) {
      if (err.name === 'AbortError') return false;
      // NotAllowedError…: rơi xuống cách tải file thông thường
    }
  }
  if (!shared) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  await db.saveSettings({ lastBackup: Date.now() });
  return true;
}

// ---------- Nhập ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#[0-9a-f]{6}$/i;

const str = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);
const remind = (v) => (Array.isArray(v) ? [...new Set(v.filter((m) => VALID_REMIND.includes(m)))] : []);
const id = (v) => (typeof v === 'string' && v && v.length <= 100 ? v : db.uid());
const sample = (x) => (x.sample === true ? { sample: true } : {});

function cleanSession(s) {
  const weekday = int(s?.weekday, 1, 7);
  if (!weekday) return null;
  if (s.mode === 'period') {
    const periodFrom = int(s.periodFrom, 1, 30);
    const periodTo = int(s.periodTo, 1, 30);
    return periodFrom && periodTo && periodTo >= periodFrom ? { weekday, mode: 'period', periodFrom, periodTo } : null;
  }
  return HHMM.test(s.start) && HHMM.test(s.end) && s.end > s.start ? { weekday, mode: 'time', start: s.start, end: s.end } : null;
}

function cleanCourse(c) {
  const name = str(c?.name, 200);
  const sessions = Array.isArray(c?.sessions) ? c.sessions.map(cleanSession).filter(Boolean) : [];
  if (!name || !sessions.length) return null;
  const weekFrom = int(c.weekFrom, 1, 60) ?? 1;
  const weekTo = Math.max(weekFrom, int(c.weekTo, 1, 60) ?? 15);
  return {
    id: id(c.id), name, room: str(c.room, 100), teacher: str(c.teacher, 100),
    color: HEX.test(c.color) ? c.color : COURSE_COLORS[0],
    weekFrom, weekTo, sessions, remind: remind(c.remind), ...sample(c),
  };
}

function cleanDeadline(d) {
  const title = str(d?.title, 300);
  if (!title || !Number.isFinite(d.due)) return null;
  const done = d.done === true;
  return {
    id: id(d.id), title, courseId: typeof d.courseId === 'string' ? d.courseId : null,
    due: d.due, priority: int(d.priority, 1, 3) ?? 2, note: str(d.note, 5000),
    done, doneAt: done && Number.isFinite(d.doneAt) ? d.doneAt : null,
    remind: remind(d.remind), ...sample(d),
  };
}

function cleanEvent(e) {
  const title = str(e?.title, 300);
  if (!title || !HHMM.test(e.start) || !HHMM.test(e.end) || e.end <= e.start) return null;
  const base = {
    id: id(e.id), title, type: EVENT_TYPES[e.type] ? e.type : 'personal',
    location: str(e.location, 200), start: e.start, end: e.end, remind: remind(e.remind), ...sample(e),
  };
  if (e.repeat === 'weekly') {
    const weekday = int(e.weekday, 1, 7);
    return weekday ? { ...base, repeat: 'weekly', weekday } : null;
  }
  return YMD.test(e.date) ? { ...base, repeat: 'once', date: e.date } : null;
}

/** Đọc và kiểm tra file sao lưu. Ném Error với thông báo tiếng Việt nếu không hợp lệ. */
export function parseBackup(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('File không phải JSON hợp lệ.'); }
  if (!raw || raw.format !== FORMAT) throw new Error('Đây không phải file sao lưu của Lịch Học.');
  if (raw.version > FORMAT_VERSION) throw new Error('File được tạo bởi phiên bản mới hơn, hãy cập nhật app.');

  const list = (arr, fn) => (Array.isArray(arr) ? arr.map(fn).filter(Boolean) : []);
  const courses = list(raw.courses, cleanCourse);
  const courseIds = new Set(courses.map((c) => c.id));
  const deadlines = list(raw.deadlines, cleanDeadline)
    .map((d) => (d.courseId && !courseIds.has(d.courseId) ? { ...d, courseId: null } : d));
  const events = list(raw.events, cleanEvent);

  const s = raw.settings || {};
  const periods = Array.isArray(s.periods)
    ? s.periods.filter((p) => HHMM.test(p?.start) && HHMM.test(p?.end) && p.end > p.start).map((p) => ({ start: p.start, end: p.end }))
    : [];
  const settings = {
    ...(YMD.test(s.semesterStart) ? { semesterStart: s.semesterStart } : {}),
    ...(periods.length ? { periods } : {}),
  };

  const total = (arr) => (Array.isArray(arr) ? arr.length : 0);
  const skipped = total(raw.courses) + total(raw.deadlines) + total(raw.events) - courses.length - deadlines.length - events.length;
  const exportedAt = Date.parse(raw.exportedAt);
  return {
    courses, deadlines, events, settings, skipped,
    exportedLabel: Number.isFinite(exportedAt) ? fmtDate(dateKey(exportedAt)) : 'không rõ ngày',
  };
}

/** Thay toàn bộ dữ liệu hiện tại bằng bản sao lưu đã kiểm tra. */
export function importData(parsed) {
  return db.replaceAll(parsed);
}
