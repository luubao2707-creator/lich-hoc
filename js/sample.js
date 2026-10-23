// Dữ liệu mẫu để xem thử. Tạo tương đối theo ngày hôm nay để màn hình
// "Hôm nay" luôn có nội dung. Mọi bản ghi đều có sample: true.

import * as db from './db.js';
import { todayKey, weekdayOf, addDays, mondayOf, epochOf } from './time.js';

export async function seedIfFirstRun() {
  const settings = await db.getSettings();
  if (settings.seeded) return false;

  const today = todayKey();
  const wd = weekdayOf(today);
  const shift = (n) => ((wd - 1 + n) % 7 + 7) % 7 + 1; // thứ cách hôm nay n ngày
  const sample = true;

  const ctdl = {
    id: db.uid(), sample, name: 'Cấu trúc dữ liệu & giải thuật', room: 'B1-203',
    teacher: 'TS. Nguyễn Văn An', color: '#3b82f6', weekFrom: 1, weekTo: 15, remind: [15],
    sessions: [
      { weekday: wd, mode: 'period', periodFrom: 1, periodTo: 3 },
      { weekday: shift(2), mode: 'period', periodFrom: 6, periodTo: 8 },
    ],
  };
  const mmt = {
    id: db.uid(), sample, name: 'Mạng máy tính', room: 'C2-105', teacher: 'ThS. Trần Thị Bình',
    color: '#10b981', weekFrom: 1, weekTo: 15, remind: [15, 60],
    sessions: [{ weekday: wd, mode: 'time', start: '13:00', end: '15:30' }],
  };
  const eng = {
    id: db.uid(), sample, name: 'Tiếng Anh chuyên ngành', room: 'A3-401', teacher: 'Ms. Linh',
    color: '#f59e0b', weekFrom: 3, weekTo: 12, remind: [],
    sessions: [{ weekday: shift(1), mode: 'period', periodFrom: 4, periodTo: 5 }],
  };
  const xstk = {
    id: db.uid(), sample, name: 'Xác suất thống kê', room: 'D5-302', teacher: 'PGS. Lê Minh',
    color: '#8b5cf6', weekFrom: 1, weekTo: 15, remind: [15],
    sessions: [{ weekday: shift(3), mode: 'time', start: '09:00', end: '11:30' }],
  };

  const events = [
    { id: db.uid(), sample, title: 'Họp nhóm đồ án', type: 'meeting', location: 'Thư viện tầng 3',
      repeat: 'once', date: today, start: '16:00', end: '17:00', remind: [15] },
    { id: db.uid(), sample, title: 'Chạy bộ', type: 'personal', location: 'Sân vận động',
      repeat: 'weekly', weekday: wd, start: '18:30', end: '19:15', remind: [] },
    { id: db.uid(), sample, title: 'CLB Guitar', type: 'activity', location: 'Nhà văn hóa SV',
      repeat: 'weekly', weekday: shift(1), start: '19:00', end: '21:00', remind: [60] },
    { id: db.uid(), sample, title: 'Thi giữa kỳ Mạng máy tính', type: 'exam', location: 'C2-105',
      repeat: 'once', date: addDays(today, 5), start: '07:30', end: '09:00', remind: [60, 1440] },
  ];

  const dl = (title, course, dayOffset, time, priority, extra = {}) => ({
    id: db.uid(), sample, title, courseId: course?.id ?? null,
    due: epochOf(addDays(today, dayOffset), time), priority, note: '', done: false, doneAt: null, remind: [60, 1440], ...extra,
  });
  const deadlines = [
    dl('Nộp báo cáo Lab 3', ctdl, 0, '23:59', 3, { note: 'Nộp file PDF lên LMS' }),
    dl('Bài tập chương 4', xstk, 1, '12:00', 2),
    dl('Slide thuyết trình nhóm', mmt, 3, '17:00', 3),
    dl('Viết essay 300 từ', eng, 6, '23:59', 1),
    dl('Quiz online tuần 7', mmt, -1, '22:00', 2),
    dl('Đăng ký học phần kỳ sau', null, 12, '17:00', 2),
    dl('Bài tập chương 3', xstk, -3, '12:00', 2, { done: true, doneAt: Date.now() }),
  ];

  for (const c of [ctdl, mmt, eng, xstk]) await db.put('courses', c);
  for (const e of events) await db.put('events', e);
  for (const d of deadlines) await db.put('deadlines', d);

  // Đặt học kỳ bắt đầu 7 tuần trước để hôm nay là tuần 8.
  await db.saveSettings({ seeded: true, semesterStart: addDays(mondayOf(today), -49) });
  return true;
}

export async function hasSampleData() {
  for (const s of db.STORES) {
    if ((await db.getAll(s)).some((x) => x.sample)) return true;
  }
  return false;
}

export async function clearSampleData() {
  for (const s of db.STORES) await db.removeWhere(s, (x) => x.sample);
  // Deadline thật có thể đang gắn với môn mẫu vừa xóa → bỏ liên kết.
  const courseIds = new Set((await db.getAll('courses')).map((c) => c.id));
  for (const d of await db.getAll('deadlines')) {
    if (d.courseId && !courseIds.has(d.courseId)) await db.put('deadlines', { ...d, courseId: null });
  }
}
