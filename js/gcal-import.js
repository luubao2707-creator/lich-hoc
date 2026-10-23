// Nhập lịch từ Google Calendar (file .ics) vào IndexedDB của app.
// Đồng bộ một chiều: nhập lại sẽ cập nhật đúng mục cũ (theo UID), giữ màu / nhắc việc /
// giảng viên người dùng đã đặt, và xóa những mục không còn trên Google.
// Phần tính toán nằm ở gcal-plan.js (dùng chung với máy chủ).

import * as db from './db.js';
import { clearSampleData } from './sample.js';
import { planImport } from './gcal-plan.js';

export { CHOICES, guessChoice, splitTitle, suggestSemesterStart, resolveChoices } from './gcal-plan.js';

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
  const plan = planImport(candidates, choices, data);

  for (const id of plan.removeCourseIds) await db.remove('courses', id);
  for (const id of plan.removeEventIds) await db.remove('events', id);
  for (const c of plan.courses) await db.put('courses', c);
  for (const e of plan.events) await db.put('events', e);
  await unlinkOrphanDeadlines();

  const settings = await db.getSettings();
  await db.saveSettings({ gcalMap: { ...(settings.gcalMap || {}), ...choices }, lastGcalImport: Date.now() });
  return { courses: plan.courses.length, events: plan.events.length, removed: plan.removeCourseIds.length + plan.removeEventIds.length };
}

async function unlinkOrphanDeadlines() {
  const courseIds = new Set((await db.getAll('courses')).map((c) => c.id));
  for (const d of await db.getAll('deadlines')) {
    if (d.courseId && !courseIds.has(d.courseId)) await db.put('deadlines', { ...d, courseId: null });
  }
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
  await unlinkOrphanDeadlines();
}
