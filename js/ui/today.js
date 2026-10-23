// Màn hình "Hôm nay": lịch trong ngày + deadline sắp đến hạn.

import { esc, BELL } from './dom.js';
import { todayKey, fmtDateLong, weekNumber, timeOf, fmtDuration, fmtDue } from '../time.js';
import { itemsForDate, upcomingDeadlines, isOverdue, PRIORITIES } from '../schedule.js';
import * as notify from '../notify.js';

const SHARE_ICON = '<svg class="inline-ico" viewBox="0 0 24 24" aria-label="Chia sẻ"><path d="M12 15V3M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';

/** Nội dung banner theo trạng thái quyền thông báo. null = không cần banner. */
function notifyBanner(state) {
  switch (state) {
    case 'ios-install': return {
      title: 'Muốn nhận nhắc việc trên iPhone?',
      text: `Trước tiên hãy thêm app vào Màn hình chính: bấm nút Chia sẻ ${SHARE_ICON} ở thanh Safari → <strong>Thêm vào MH chính</strong>, rồi mở app từ icon mới. Trong lúc này, lời nhắc chỉ hiện bên trong app khi đang mở.` };
    case 'default': return {
      title: 'Bật thông báo nhắc việc',
      text: 'Cho phép thông báo để được nhắc trước giờ học và hạn nộp.', action: 'Bật thông báo' };
    case 'denied': return {
      title: 'Thông báo đang bị chặn',
      text: `${notify.isIOS() ? 'Vào <strong>Cài đặt iPhone → Thông báo → Lịch Học</strong> để bật lại.'
        : 'Bật lại quyền thông báo cho trang này trong cài đặt trình duyệt.'} Tạm thời lời nhắc chỉ hiện bên trong app.` };
    case 'insecure': return {
      title: 'Thông báo cần HTTPS',
      text: 'App đang mở qua địa chỉ http nên chỉ nhắc được bên trong app. Mở bằng địa chỉ https để bật thông báo.' };
    case 'unsupported': return {
      title: 'Thiết bị chưa hỗ trợ thông báo web',
      text: 'Trên iPhone cần iOS 16.4 trở lên và mở app từ Màn hình chính. Tạm thời lời nhắc chỉ hiện bên trong app.' };
    default: return null;
  }
}

const dismissKey = (state) => `lichhoc:banner-dismissed:${state}`;
function isDismissed(state) {
  try { return localStorage.getItem(dismissKey(state)) === '1'; } catch { return false; }
}

function bannerHTML(data) {
  const state = notify.status();
  const b = notifyBanner(state);
  if (!b || !notify.hasAnyReminder(data) || isDismissed(state)) return '';
  return `
    <aside class="banner" data-state="${state}">
      <div class="banner-body">
        <strong>${b.title}</strong>
        <p>${b.text}</p>
        ${b.action ? `<button type="button" class="btn btn-primary banner-action">${b.action}</button>` : ''}
      </div>
      <button type="button" class="icon-btn banner-close" aria-label="Ẩn hướng dẫn">✕</button>
    </aside>`;
}

export function renderToday(root, ctx) {
  const { data } = ctx;
  const now = Date.now();
  const key = todayKey();
  const week = weekNumber(key, data.settings.semesterStart);
  const items = itemsForDate(key, data);

  // Buổi đang diễn ra và buổi kế tiếp (chỉ tính môn học / sự kiện, không tính deadline).
  const timed = items.filter((i) => i.kind !== 'deadline');
  const ongoing = new Set(timed.filter((i) => i.startMs <= now && now < i.endMs).map((i) => i.id));
  const next = timed.find((i) => i.startMs > now);

  const upcoming = upcomingDeadlines(data.deadlines, now, 7);
  const later = data.deadlines.filter((d) => !d.done && d.due > now + 7 * 864e5).length;

  root.innerHTML = `
    <header class="page-head">
      <p class="eyebrow">${esc(fmtDateLong(key))}${week >= 1 ? ` · Tuần ${week}` : ''}</p>
      <h1>Hôm nay</h1>
    </header>
    ${bannerHTML(data)}

    <section class="section">
      ${items.length ? `<ol class="timeline">${items.map((it) => timelineItem(it, now, ongoing, next)).join('')}</ol>`
        : `<div class="empty">Hôm nay không có lịch nào.<br>Nhấn <strong>+</strong> để thêm môn học hoặc deadline.</div>`}
    </section>

    <section class="section">
      <div class="section-head">
        <h2>Sắp đến hạn</h2>
        <span class="muted">7 ngày tới</span>
      </div>
      ${upcoming.length ? `<ul class="list card-group">${upcoming.map((d) => deadlineRow(d, data, now)).join('')}</ul>`
        : `<div class="empty small">Không có deadline nào trong 7 ngày tới.</div>`}
      ${later ? `<button type="button" class="btn-text more" data-goto="deadlines">+ ${later} deadline sau 7 ngày →</button>` : ''}
    </section>`;

  root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.check')) return;
    ctx.openItem(el.dataset.kind, el.dataset.open);
  }));
  root.querySelectorAll('.check').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.toggleDeadline(el.dataset.id);
  }));
  root.querySelector('[data-goto]')?.addEventListener('click', () => ctx.go('deadlines'));

  root.querySelector('.banner-action')?.addEventListener('click', async () => {
    await notify.requestPermission();
    renderToday(root, ctx);
  });
  root.querySelector('.banner-close')?.addEventListener('click', (e) => {
    try { localStorage.setItem(dismissKey(e.target.closest('.banner').dataset.state), '1'); } catch { /* chế độ riêng tư */ }
    renderToday(root, ctx);
  });
}

function timelineItem(it, now, ongoing, next) {
  const isNow = ongoing.has(it.id);
  const isNext = next && next.id === it.id;
  let badge = '';
  let state = '';

  if (it.kind === 'deadline') {
    const d = it.ref;
    if (d.done) { state = 'done'; badge = '<span class="badge ok">Đã xong</span>'; }
    else if (d.due < now) { state = 'overdue'; badge = `<span class="badge danger">Quá hạn ${fmtDuration(now - d.due)}</span>`; }
    else badge = `<span class="badge warn">Hạn chót · còn ${fmtDuration(d.due - now)}</span>`;
  } else if (isNow) {
    state = 'now';
    badge = `<span class="badge live">Đang diễn ra · còn ${fmtDuration(it.endMs - now)}</span>`;
  } else if (isNext) {
    state = 'next';
    badge = `<span class="badge accent">Kế tiếp · còn ${fmtDuration(it.startMs - now)} nữa</span>`;
  } else if (it.endMs <= now) {
    state = 'past';
  }

  const time = it.kind === 'deadline'
    ? `<span>${timeOf(it.startMs)}</span>`
    : `<span>${timeOf(it.startMs)}</span><span class="muted">${timeOf(it.endMs)}</span>`;
  const icon = it.kind === 'deadline' ? '<span class="kind-tag">Deadline</span>' : '';
  const refId = it.kind === 'course' ? it.ref.id : it.id;

  return `
    <li class="tl-item ${state}" data-kind="${it.kind}" data-open="${esc(refId)}">
      <div class="tl-time">${time}</div>
      <div class="card tl-card" style="--c:${esc(it.color)}">
        ${it.kind === 'deadline' ? checkBtn(it.ref) : ''}
        <div class="tl-main">
          <div class="tl-title">${icon}${esc(it.title)}${it.ref.remind?.length ? BELL : ''}</div>
          ${it.sub ? `<div class="tl-sub">${esc(it.sub)}</div>` : ''}
          ${badge}
        </div>
      </div>
    </li>`;
}

export function checkBtn(d) {
  return `<button type="button" class="check ${d.done ? 'on' : ''}" data-id="${esc(d.id)}"
    aria-label="${d.done ? 'Bỏ đánh dấu hoàn thành' : 'Đánh dấu hoàn thành'}" aria-pressed="${d.done}">
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12.5l4 4 8-9"/></svg></button>`;
}

export function deadlineRow(d, data, now) {
  const course = data.courses.find((c) => c.id === d.courseId);
  const overdue = isOverdue(d, now);
  const left = d.due - now;
  const cls = d.done ? 'done' : overdue ? 'overdue' : left < 864e5 ? 'urgent' : '';
  const rel = d.done ? 'Đã xong' : overdue ? `Quá hạn ${fmtDuration(-left)}` : `còn ${fmtDuration(left)}`;

  return `
    <li class="row dl-row ${cls}" data-kind="deadline" data-open="${esc(d.id)}">
      ${checkBtn(d)}
      <div class="dl-main">
        <div class="dl-title">${esc(d.title)}${d.remind?.length && !d.done ? BELL : ''}</div>
        ${course ? `<div class="dl-meta"><span class="chip" style="--c:${esc(course.color)}">${esc(course.name)}</span></div>` : ''}
        <div class="dl-meta">
          <span>${esc(fmtDue(d.due, now))}</span>
          <span class="rel">${rel}</span>
        </div>
      </div>
      <span class="prio p${d.priority}" title="Ưu tiên ${PRIORITIES[d.priority]}">${PRIORITIES[d.priority]}</span>
    </li>`;
}
