// Thời khóa biểu tuần: dạng lưới (7 cột) hoặc danh sách theo ngày; vuốt ngang để đổi tuần.

import { esc } from './dom.js';
import {
  todayKey, mondayOf, addDays, weekNumber, weekdayOf, fmtDate, timeOf,
  WEEKDAY_SHORT, WEEKDAY_LONG,
} from '../time.js';
import { itemsForDate } from '../schedule.js';

const HOUR_H = 52;            // chiều cao 1 giờ trong lưới (px)
const DEFAULT_RANGE = [7, 18]; // khung giờ mặc định
const MODE_KEY = 'lichhoc:week-mode';

let weekStart = null; // 'YYYY-MM-DD' của Thứ Hai đang xem
let mode = readMode();

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
}
function saveMode(m) {
  mode = m;
  try { localStorage.setItem(MODE_KEY, m); } catch { /* chế độ riêng tư */ }
}

/** Mở tuần chứa ngày key (dùng khi bấm vào một ngày từ nơi khác). */
export function showWeekOf(key) { weekStart = mondayOf(key); }

const minsInDay = (ms, key) => Math.round((ms - Date.parse(`${key}T00:00:00+07:00`)) / 60000);

/** Xếp các mục chồng giờ thành cột cạnh nhau. Trả về [{ it, col, cols }]. */
function layoutDay(items) {
  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const colEnds = [];
    for (const c of cluster) {
      let i = colEnds.findIndex((end) => end <= c.it.startMs);
      if (i < 0) { i = colEnds.length; colEnds.push(0); }
      colEnds[i] = c.it.endMs;
      c.col = i;
    }
    for (const c of cluster) c.cols = colEnds.length;
    out.push(...cluster);
    cluster = [];
  };
  for (const it of items) {
    if (it.startMs >= clusterEnd && cluster.length) flush();
    cluster.push({ it });
    clusterEnd = Math.max(clusterEnd, it.endMs);
  }
  if (cluster.length) flush();
  return out;
}

export function renderWeek(root, ctx, slide = '') {
  const { data } = ctx;
  const today = todayKey();
  if (!weekStart) weekStart = mondayOf(today);
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(weekStart, i));
  const week = weekNumber(weekStart, data.settings.semesterStart);
  const isThisWeek = weekStart === mondayOf(today);

  const perDay = days.map((key) => {
    const all = itemsForDate(key, data);
    return {
      key,
      timed: all.filter((i) => i.kind !== 'deadline'),
      deadlines: all.filter((i) => i.kind === 'deadline'),
    };
  });
  const sameYear = days[0].slice(0, 4) === days[6].slice(0, 4);
  const range = `${fmtDate(days[0], { year: !sameYear })} – ${fmtDate(days[6])}`;

  root.innerHTML = `
    <header class="page-head wk-top">
      <div class="wk-title">
        <p class="eyebrow">${esc(range)}</p>
        <h1>${week >= 1 ? `Tuần ${week}` : 'Ngoài học kỳ'}</h1>
      </div>
      ${isThisWeek ? '' : '<button type="button" class="btn-text wk-today">Tuần này</button>'}
    </header>

    <div class="wk-bar">
      <button type="button" class="icon-btn wk-nav" data-step="-1" aria-label="Tuần trước">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      <div class="segmented" role="tablist">
        <button type="button" role="tab" data-mode="grid" aria-selected="${mode === 'grid'}">Lưới</button>
        <button type="button" role="tab" data-mode="list" aria-selected="${mode === 'list'}">Danh sách</button>
      </div>
      <button type="button" class="icon-btn wk-nav" data-step="1" aria-label="Tuần sau">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>
    </div>

    <div class="wk-body ${slide}">
      ${mode === 'grid' ? gridHTML(perDay, today) : listHTML(perDay, today)}
    </div>
    <p class="hint wk-hint">Vuốt ngang để đổi tuần${mode === 'grid' ? ' · chạm ô trống để thêm sự kiện' : ''}</p>`;

  const go = (step) => {
    weekStart = addDays(weekStart, step * 7);
    renderWeek(root, ctx, step > 0 ? 'slide-next' : 'slide-prev');
  };
  root.querySelectorAll('.wk-nav').forEach((b) => b.addEventListener('click', () => go(+b.dataset.step)));
  root.querySelector('.wk-today')?.addEventListener('click', () => {
    const step = weekStart < mondayOf(today) ? 1 : -1;
    weekStart = mondayOf(today);
    renderWeek(root, ctx, step > 0 ? 'slide-next' : 'slide-prev');
  });
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    saveMode(b.dataset.mode);
    renderWeek(root, ctx);
  }));

  const body = root.querySelector('.wk-body');
  body.addEventListener('click', (e) => {
    const item = e.target.closest('[data-open]');
    if (item) { ctx.openItem(item.dataset.kind, item.dataset.open); return; }
    const head = e.target.closest('[data-day-head]');
    if (head) { // chạm tiêu đề ngày trong lưới → xem dạng danh sách
      saveMode('list');
      renderWeek(root, ctx);
      root.querySelector(`[data-day="${head.dataset.dayHead}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const col = e.target.closest('.wk-col');
    if (col) { // chạm ô trống → thêm sự kiện vào đúng ngày, giờ tròn tại chỗ chạm
      const rect = col.getBoundingClientRect();
      const hour = +col.dataset.fromHour + Math.floor((e.clientY - rect.top) / HOUR_H);
      ctx.openEventForm(null, { date: col.dataset.day, start: `${String(Math.min(hour, 23)).padStart(2, '0')}:00` });
    }
  });
  attachSwipe(body, go);

  // Lưới: cuộn tới giờ hiện tại (tuần này) hoặc buổi sớm nhất.
  if (mode === 'grid') {
    const scroller = root.querySelector('.wk-scroll');
    const target = root.querySelector('.now-line') || root.querySelector('.wk-item');
    if (scroller && target) scroller.scrollTop = Math.max(0, target.offsetTop - HOUR_H);
  }
}

function hourRange(perDay) {
  let [from, to] = DEFAULT_RANGE;
  for (const d of perDay) {
    for (const it of d.timed) {
      from = Math.min(from, Math.floor(minsInDay(it.startMs, d.key) / 60));
      to = Math.max(to, Math.ceil(minsInDay(it.endMs, d.key) / 60));
    }
  }
  return [Math.max(0, from), Math.min(24, to)];
}

function gridHTML(perDay, today) {
  const [from, to] = hourRange(perDay);
  const hours = to - from;
  const now = Date.now();

  const head = perDay.map((d) => {
    const open = d.deadlines.filter((x) => !x.ref.done).length;
    return `<button type="button" class="wk-dayhead ${d.key === today ? 'today' : ''}" data-day-head="${d.key}"
      aria-label="${WEEKDAY_LONG[weekdayOf(d.key)]} ${fmtDate(d.key)}${open ? `, ${open} deadline` : ''}">
      <span>${WEEKDAY_SHORT[weekdayOf(d.key)]}</span><strong>${+d.key.slice(8)}</strong>
      ${open ? `<em class="dl-dot" title="${open} deadline">${open}</em>` : ''}
    </button>`;
  }).join('');

  const gutter = Array.from({ length: hours }, (_, i) =>
    `<span style="top:${i * HOUR_H}px">${String(from + i).padStart(2, '0')}</span>`).join('');

  const cols = perDay.map((d) => {
    const blocks = layoutDay(d.timed).map(({ it, col, cols }) => {
      const top = (minsInDay(it.startMs, d.key) - from * 60) / 60 * HOUR_H;
      const h = Math.max(((it.endMs - it.startMs) / 3600e3) * HOUR_H - 2, 20);
      const past = it.endMs <= now ? 'past' : '';
      const refId = it.kind === 'course' ? it.ref.id : it.id;
      return `<button type="button" class="wk-item ${past}" data-kind="${it.kind}" data-open="${esc(refId)}"
        style="--c:${esc(it.color)};top:${top}px;height:${h}px;left:calc(${(col / cols) * 100}% + 1px);width:calc(${100 / cols}% - 2px)"
        aria-label="${esc(`${it.title}, ${timeOf(it.startMs)}–${timeOf(it.endMs)}`)}">
        <strong>${esc(it.title)}</strong>
        ${it.kind === 'course' && it.ref.room ? `<small>${esc(it.ref.room)}</small>` : ''}
        ${it.kind === 'event' && it.ref.type === 'exam' ? '<small>Thi</small>' : ''}
      </button>`;
    }).join('');
    let nowLine = '';
    if (d.key === today) {
      const m = minsInDay(now, d.key);
      if (m >= from * 60 && m <= to * 60) nowLine = `<div class="now-line" style="top:${(m - from * 60) / 60 * HOUR_H}px"></div>`;
    }
    return `<div class="wk-col ${d.key === today ? 'today' : ''}" data-day="${d.key}" data-from-hour="${from}">${blocks}${nowLine}</div>`;
  }).join('');

  return `
    <div class="wk-grid-wrap">
      <div class="wk-head"><span></span>${head}</div>
      <div class="wk-scroll">
        <div class="wk-grid" style="--hour-h:${HOUR_H}px;height:${hours * HOUR_H}px">
          <div class="wk-gutter">${gutter}</div>${cols}
        </div>
      </div>
    </div>`;
}

function listHTML(perDay, today) {
  const now = Date.now();
  return perDay.map((d) => {
    const items = [...d.timed, ...d.deadlines].sort((a, b) => a.startMs - b.startMs);
    const wd = weekdayOf(d.key);
    return `
      <section class="wk-day ${d.key === today ? 'today' : ''}" data-day="${d.key}">
        <h2>${WEEKDAY_LONG[wd]} <span class="muted">${fmtDate(d.key, { year: false })}</span>
          ${d.key === today ? '<span class="today-tag">Hôm nay</span>' : ''}</h2>
        ${items.length ? `<ul class="list card-group">${items.map((it) => {
          const dl = it.kind === 'deadline';
          const state = dl && it.ref.done ? 'done' : dl && it.startMs < now ? 'overdue' : !dl && it.endMs <= now ? 'past' : '';
          return `
            <li class="row wk-row ${state}" data-kind="${it.kind}" data-open="${esc(it.kind === 'course' ? it.ref.id : it.id)}">
              <span class="wk-time">${timeOf(it.startMs)}${dl ? '' : `<small>${timeOf(it.endMs)}</small>`}</span>
              <span class="wk-bar-c" style="background:${esc(it.color)}"></span>
              <div class="dl-main">
                <div class="dl-title">${dl ? '<span class="kind-tag" style="--c:' + esc(it.color) + '">Deadline</span>' : ''}${esc(it.title)}</div>
                ${it.sub ? `<div class="dl-meta">${esc(it.sub)}</div>` : ''}
              </div>
            </li>`;
        }).join('')}</ul>` : '<p class="wk-empty muted">Trống</p>'}
      </section>`;
  }).join('');
}

/** Vuốt ngang để đổi tuần; bỏ qua khi người dùng đang cuộn dọc. */
function attachSwipe(el, go) {
  let x0 = null, y0 = 0, t0 = 0;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { x0 = null; return; }
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - t0 < 800) {
      go(dx < 0 ? 1 : -1);
    }
  }, { passive: true });
}

