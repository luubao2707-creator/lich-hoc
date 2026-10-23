// Điểm khởi động: nạp dữ liệu, điều hướng tab, nút "+" và các thao tác chung.

import * as db from './db.js';
import { seedIfFirstRun } from './sample.js';
import { renderToday } from './ui/today.js';
import { renderWeek } from './ui/week.js';
import { renderCourses } from './ui/courses.js';
import { renderDeadlines } from './ui/deadlines.js';
import { renderSettings } from './ui/settings.js';
import { openCourseForm } from './ui/course-form.js';
import { openDeadlineForm } from './ui/deadline-form.js';
import { openEventForm } from './ui/event-form.js';
import { openActionSheet, toast, inAppAlert } from './ui/dom.js';
import * as notify from './notify.js';

const VIEWS = { today: renderToday, week: renderWeek, courses: renderCourses, deadlines: renderDeadlines, settings: renderSettings };
const view = document.getElementById('view');
const tabs = document.querySelectorAll('.tabbar [data-tab]');

const ctx = {
  data: null,
  tab: 'today',

  async reload() {
    ctx.data = await db.loadAll();
    render();
    notify.check(); // dữ liệu vừa đổi → xem có lời nhắc nào tới hạn
  },

  go(tab) {
    if (!VIEWS[tab]) return;
    ctx.tab = tab;
    history.replaceState(null, '', `#${tab}`);
    render();
    window.scrollTo(0, 0);
  },

  openCourseForm(course) { openCourseForm(ctx, course); },
  openDeadlineForm(d, preset) { openDeadlineForm(ctx, d, preset); },
  openEventForm(e, preset) { openEventForm(ctx, e, preset); },

  openItem(kind, id) {
    if (kind === 'course') return openCourseForm(ctx, ctx.data.courses.find((c) => c.id === id));
    if (kind === 'deadline') return openDeadlineForm(ctx, ctx.data.deadlines.find((d) => d.id === id));
    if (kind === 'event') return openEventForm(ctx, ctx.data.events.find((e) => e.id === id));
  },

  async toggleDeadline(id) {
    const d = ctx.data.deadlines.find((x) => x.id === id);
    if (!d) return;
    const done = !d.done;
    await db.put('deadlines', { ...d, done, doneAt: done ? Date.now() : null });
    await ctx.reload();
    if (done) {
      toast('Đã hoàn thành', {
        label: 'Hoàn tác',
        onClick: async () => { await db.put('deadlines', d); ctx.reload(); },
      });
    }
  },
};

function render() {
  tabs.forEach((t) => t.setAttribute('aria-current', t.dataset.tab === ctx.tab ? 'page' : 'false'));
  VIEWS[ctx.tab](view, ctx);
}

tabs.forEach((t) => t.addEventListener('click', () => ctx.go(t.dataset.tab)));

document.getElementById('fab').addEventListener('click', () => {
  openActionSheet('Thêm nhanh', [
    { label: 'Deadline / bài tập', sub: 'Hạn nộp, mức ưu tiên, ghi chú', color: '#f97316', onClick: () => ctx.openDeadlineForm() },
    { label: 'Sự kiện', sub: 'Họp, hoạt động, cá nhân, lịch thi', color: '#0ea5e9', onClick: () => ctx.openEventForm() },
    { label: 'Môn học', sub: 'Thêm vào thời khóa biểu tuần', color: '#3b82f6', onClick: () => ctx.openCourseForm() },
  ]);
});

// Cập nhật đếm ngược mỗi 30 giây và khi quay lại app (chỉ khi không có form đang mở).
function tick() {
  if (document.hidden || document.body.classList.contains('sheet-open')) return;
  if (ctx.tab === 'today' || ctx.tab === 'deadlines') render();
}
setInterval(tick, 30_000);
document.addEventListener('visibilitychange', tick);

async function start() {
  try {
    await seedIfFirstRun();
    navigator.storage?.persist?.().catch(() => {});
    const fromHash = location.hash.slice(1);
    if (VIEWS[fromHash]) ctx.tab = fromHash;
    await ctx.reload();
    notify.startScheduler(() => ctx.data, inAppAlert);
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="empty">Không mở được cơ sở dữ liệu trên trình duyệt này.<br><small>${String(err?.message || err).replace(/</g, '&lt;')}</small></div>`;
  }
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(console.warn));
}

start();
