// Form thêm / sửa môn học. Mỗi môn có nhiều buổi/tuần, mỗi buổi chọn theo giờ hoặc theo tiết.

import { esc, openSheet, toast, remindField, readRemind } from './dom.js';
import * as db from '../db.js';
import { WEEKDAY_LONG, weekdayOf, todayKey, minutesOf } from '../time.js';
import { COURSE_COLORS, sessionLabel, courseDateRange } from '../schedule.js';
import { rememberSkip } from '../gcal-import.js';
import { fmtDate } from '../time.js';

export function openCourseForm(ctx, course = null) {
  const { periods } = ctx.data.settings;
  const isNew = !course;
  const fromGoogle = course?.source === 'gcal'; // lịch nhập từ Google: chỉ sửa màu, GV, nhắc việc
  const ro = fromGoogle ? 'readonly' : '';
  const c = course || {
    name: '', room: '', teacher: '', weekFrom: 1, weekTo: 15,
    color: COURSE_COLORS[ctx.data.courses.length % COURSE_COLORS.length],
    sessions: [{ weekday: weekdayOf(todayKey()), mode: 'period', periodFrom: 1, periodTo: 3, start: '07:00', end: '09:00' }],
    remind: [15],
  };

  // "Từ tiết" hiện giờ bắt đầu, "Đến tiết" hiện giờ kết thúc để vừa ô trên iPhone.
  const periodOptions = (sel, edge) => periods.map((p, i) =>
    `<option value="${i + 1}" ${sel === i + 1 ? 'selected' : ''}>Tiết ${i + 1} · ${p[edge]}</option>`).join('');

  const sessionHTML = (s) => `
    <div class="session" data-mode="${s.mode || 'time'}">
      <div class="session-top">
        <select name="weekday" aria-label="Thứ">
          ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${s.weekday === d ? 'selected' : ''}>${WEEKDAY_LONG[d]}</option>`).join('')}
        </select>
        <div class="seg-mini" role="group" aria-label="Cách nhập giờ">
          <button type="button" data-set="time">Theo giờ</button>
          <button type="button" data-set="period">Theo tiết</button>
        </div>
        <button type="button" class="icon-btn remove-session" aria-label="Xóa buổi này">✕</button>
      </div>
      <div class="pair only-time">
        <label>Bắt đầu<input type="time" name="start" value="${esc(s.start || '07:00')}"></label>
        <label>Kết thúc<input type="time" name="end" value="${esc(s.end || '09:00')}"></label>
      </div>
      <div class="pair only-period">
        <label>Từ tiết<select name="periodFrom">${periodOptions(s.periodFrom || 1, 'start')}</select></label>
        <label>Đến tiết<select name="periodTo">${periodOptions(s.periodTo || 3, 'end')}</select></label>
      </div>
    </div>`;

  const sheet = openSheet({
    title: isNew ? 'Thêm môn học' : 'Sửa môn học',
    body: `
      <form class="form" novalidate>
        ${fromGoogle ? googleNotice(c) : ''}
        <label class="field">Tên môn<input name="name" required autocomplete="off" value="${esc(c.name)}" placeholder="vd: Giải tích 1" ${ro}></label>
        <div class="pair">
          <label class="field">Phòng<input name="room" autocomplete="off" value="${esc(c.room)}" placeholder="B1-203" ${ro}></label>
          <label class="field">Giảng viên<input name="teacher" autocomplete="off" value="${esc(c.teacher)}"></label>
        </div>

        <fieldset class="field">
          <legend>Màu</legend>
          <div class="swatches">
            ${COURSE_COLORS.map((col) => `<label class="swatch-pick" style="--c:${col}">
              <input type="radio" name="color" value="${col}" ${col === c.color ? 'checked' : ''}><span></span></label>`).join('')}
          </div>
        </fieldset>

        ${fromGoogle ? `
        <fieldset class="field">
          <legend>Lịch học</legend>
          <ul class="ro-sessions">${c.sessions.map((s) => `<li>${esc(sessionLabel(s, periods))}${s.room && s.room !== c.room ? ` · ${esc(s.room)}` : ''}</li>`).join('')}</ul>
        </fieldset>` : `
        <fieldset class="field">
          <legend>Lịch học hằng tuần</legend>
          <div class="sessions-edit">${c.sessions.map(sessionHTML).join('')}</div>
          <button type="button" class="btn btn-ghost add-session">+ Thêm buổi</button>
        </fieldset>`}

        <fieldset class="field" ${fromGoogle ? 'hidden' : ''}>
          <legend>Khoảng tuần học</legend>
          <div class="pair">
            <label>Từ tuần<input type="number" name="weekFrom" inputmode="numeric" min="1" max="60" value="${c.weekFrom}"></label>
            <label>Đến tuần<input type="number" name="weekTo" inputmode="numeric" min="1" max="60" value="${c.weekTo}"></label>
          </div>
        </fieldset>

        ${remindField(c.remind || [])}

        <p class="form-error" hidden></p>
        <button type="submit" class="btn btn-primary btn-block">${isNew ? 'Thêm môn học' : 'Lưu thay đổi'}</button>
        ${isNew ? '' : '<button type="button" class="btn btn-danger btn-block delete">Xóa môn học</button>'}
      </form>`,
  });

  const form = sheet.body.querySelector('form');
  const list = form.querySelector('.sessions-edit');
  const errEl = form.querySelector('.form-error');

  form.querySelector('.add-session')?.addEventListener('click', () => {
    const last = readSessions(list).at(-1);
    list.insertAdjacentHTML('beforeend', sessionHTML(last ? { ...last, weekday: (last.weekday % 7) + 1 } : { weekday: 1, mode: 'period' }));
  });
  list?.addEventListener('click', (e) => {
    const set = e.target.closest('[data-set]');
    if (set) set.closest('.session').dataset.mode = set.dataset.set;
    if (e.target.closest('.remove-session')) {
      if (list.children.length > 1) e.target.closest('.session').remove();
      else toast('Môn học cần ít nhất một buổi');
    }
  });

  form.querySelector('.delete')?.addEventListener('click', async () => {
    const linked = ctx.data.deadlines.filter((d) => d.courseId === c.id).length;
    const msg = `Xóa môn "${c.name}"?` + (linked ? `\n${linked} deadline liên quan sẽ được giữ lại nhưng bỏ liên kết môn.` : '');
    if (!confirm(msg)) return;
    await db.remove('courses', c.id);
    if (fromGoogle) await rememberSkip(c.gcalUids || []); // không thêm lại ở lần nhập sau
    for (const d of ctx.data.deadlines.filter((x) => x.courseId === c.id)) await db.put('deadlines', { ...d, courseId: null });
    sheet.close();
    toast('Đã xóa môn học');
    ctx.reload();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const next = {
      ...c,
      id: c.id || db.uid(),
      name: fd.get('name').trim(),
      room: fd.get('room').trim(),
      teacher: fd.get('teacher').trim(),
      color: fd.get('color') || COURSE_COLORS[0],
      weekFrom: parseInt(fd.get('weekFrom'), 10),
      weekTo: parseInt(fd.get('weekTo'), 10),
      sessions: fromGoogle ? c.sessions : readSessions(list),
      remind: readRemind(fd),
    };
    const err = validate(next, periods);
    if (err) {
      errEl.textContent = err;
      errEl.hidden = false;
      errEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    delete next.sample; // môn đã sửa không còn là dữ liệu mẫu
    await db.put('courses', next);
    sheet.close();
    toast(isNew ? 'Đã thêm môn học' : 'Đã lưu');
    ctx.reload();
  });
}

function googleNotice(c) {
  const r = courseDateRange(c);
  const range = r ? ` · ${fmtDate(r.from)}${r.to ? `–${fmtDate(r.to)}` : ''}` : '';
  return `<p class="notice">Nhập từ Google Calendar${esc(range)}. Muốn đổi giờ, phòng hay ngày học, hãy sửa trên Google
    rồi nhập lại. Ở đây bạn có thể đặt màu, giảng viên và nhắc việc.</p>`;
}

function readSessions(list) {
  return [...list.querySelectorAll('.session')].map((el) => {
    const v = (n) => el.querySelector(`[name="${n}"]`).value;
    const mode = el.dataset.mode;
    const s = { weekday: +v('weekday'), mode };
    if (mode === 'period') Object.assign(s, { periodFrom: +v('periodFrom'), periodTo: +v('periodTo') });
    else Object.assign(s, { start: v('start'), end: v('end') });
    return s;
  });
}

function validate(c, periods) {
  if (!c.name) return 'Vui lòng nhập tên môn.';
  if (!(c.weekFrom >= 1) || !(c.weekTo >= 1)) return 'Khoảng tuần không hợp lệ.';
  if (c.weekTo < c.weekFrom) return '"Đến tuần" phải lớn hơn hoặc bằng "Từ tuần".';
  for (const s of c.sessions) {
    const day = WEEKDAY_LONG[s.weekday];
    if (s.mode === 'period') {
      if (s.periodTo < s.periodFrom) return `${day}: tiết kết thúc phải sau tiết bắt đầu.`;
      if (!periods[s.periodTo - 1]) return `${day}: tiết không tồn tại trong bảng giờ.`;
    } else {
      if (!s.start || !s.end) return `${day}: vui lòng nhập đủ giờ bắt đầu và kết thúc.`;
      if (minutesOf(s.end) <= minutesOf(s.start)) return `${day}: giờ kết thúc phải sau giờ bắt đầu.`;
    }
  }
  return null;
}
