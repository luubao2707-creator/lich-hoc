// Form thêm / sửa sự kiện ngoài môn học: Họp, Hoạt động, Cá nhân, Thi.

import { esc, openSheet, toast, remindField, readRemind } from './dom.js';
import * as db from '../db.js';
import { WEEKDAY_LONG, weekdayOf, todayKey, minutesOf, fmtDate } from '../time.js';
import { EVENT_TYPES, describeRec } from '../schedule.js';
import { rememberSkip } from '../gcal-import.js';

/** Giờ tròn kế tiếp, vd 09:37 → 10:00 (tối đa 22:00). */
function nextHour() {
  const h = Math.min(new Date(Date.now() + 7 * 3600e3).getUTCHours() + 1, 22);
  return `${String(h).padStart(2, '0')}:00`;
}

function plusMinutes(hhmm, n) {
  const t = Math.min(minutesOf(hhmm) + n, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * preset (khi thêm mới): { date: 'YYYY-MM-DD', start: 'HH:mm', type }
 */
export function openEventForm(ctx, event = null, preset = {}) {
  const isNew = !event;
  const fromGoogle = event?.source === 'gcal'; // nhập từ Google: chỉ đổi loại và nhắc việc
  const date = preset.date || todayKey();
  const start = preset.start || nextHour();
  const e = event || {
    title: '', type: preset.type || 'meeting', location: '', repeat: 'once',
    date, weekday: weekdayOf(date), start, end: plusMinutes(start, 60), remind: [15],
  };

  const sheet = openSheet({
    title: isNew ? 'Thêm sự kiện' : 'Sửa sự kiện',
    body: `
      <form class="form" novalidate data-repeat="${e.repeat}" ${fromGoogle ? 'data-google' : ''}>
        ${fromGoogle ? `<p class="notice">Nhập từ Google Calendar: <strong>${esc(e.title)}</strong><br>
          ${esc(e.repeat === 'rec' ? describeRec(e.rec) : fmtDate(e.date))} · ${esc(e.start)}–${esc(e.end)}${e.location ? ` · ${esc(e.location)}` : ''}<br>
          Muốn đổi giờ hay ngày, hãy sửa trên Google rồi nhập lại. Ở đây bạn có thể đổi loại và nhắc việc.</p>` : ''}
        <fieldset class="field">
          <legend>Loại</legend>
          <div class="type-pick">
            ${Object.entries(EVENT_TYPES).map(([k, t]) => `<label style="--c:${t.color}">
              <input type="radio" name="type" value="${k}" ${e.type === k ? 'checked' : ''}><span>${t.label}</span></label>`).join('')}
          </div>
        </fieldset>

        <div class="manual-only">
        <label class="field">Tên sự kiện<input name="title" required autocomplete="off" value="${esc(e.title)}" placeholder="vd: Họp nhóm đồ án"></label>
        <label class="field">Địa điểm<input name="location" autocomplete="off" value="${esc(e.location)}" placeholder="Phòng, link họp…"></label>

        <fieldset class="field">
          <legend>Lặp lại</legend>
          <div class="segmented repeat-pick">
            <label><input type="radio" name="repeat" value="once" ${e.repeat !== 'weekly' ? 'checked' : ''}><span>Một lần</span></label>
            <label><input type="radio" name="repeat" value="weekly" ${e.repeat === 'weekly' ? 'checked' : ''}><span>Hằng tuần</span></label>
          </div>
        </fieldset>

        <label class="field only-once">Ngày<input type="date" name="date" value="${esc(e.date || date)}"></label>
        <label class="field only-weekly">Thứ
          <select name="weekday">
            ${[1, 2, 3, 4, 5, 6, 7].map((d) => `<option value="${d}" ${(e.weekday || weekdayOf(date)) === d ? 'selected' : ''}>${WEEKDAY_LONG[d]}</option>`).join('')}
          </select>
        </label>

        <div class="pair">
          <label class="field">Bắt đầu<input type="time" name="start" value="${esc(e.start)}"></label>
          <label class="field">Kết thúc<input type="time" name="end" value="${esc(e.end)}"></label>
        </div>

        </div>

        ${remindField(e.remind || [])}

        <p class="form-error" hidden></p>
        <button type="submit" class="btn btn-primary btn-block">${isNew ? 'Thêm sự kiện' : 'Lưu thay đổi'}</button>
        ${isNew ? '' : '<button type="button" class="btn btn-danger btn-block delete">Xóa sự kiện</button>'}
      </form>`,
  });

  const form = sheet.body.querySelector('form');
  const errEl = form.querySelector('.form-error');

  // Hiện ô "Ngày" hoặc "Thứ" theo kiểu lặp; đổi ngày thì đồng bộ luôn thứ.
  form.addEventListener('change', (ev) => {
    if (ev.target.name === 'repeat') form.dataset.repeat = ev.target.value;
    if (ev.target.name === 'date' && ev.target.value) form.weekday.value = weekdayOf(ev.target.value);
    if (ev.target.name === 'start' && ev.target.value && form.end.value <= ev.target.value) {
      form.end.value = plusMinutes(ev.target.value, 60);
    }
  });

  form.querySelector('.delete')?.addEventListener('click', async () => {
    const what = fromGoogle ? 'nhập từ Google, lần nhập sau sẽ bỏ qua' : e.repeat === 'weekly' ? `sự kiện lặp hằng ${WEEKDAY_LONG[e.weekday]}` : `sự kiện ngày ${fmtDate(e.date)}`;
    if (!confirm(`Xóa "${e.title}" (${what})?`)) return;
    await db.remove('events', e.id);
    if (fromGoogle) await rememberSkip([e.gcalUid]);
    sheet.close();
    toast('Đã xóa sự kiện');
    ctx.reload();
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    if (fromGoogle) {
      const type = EVENT_TYPES[fd.get('type')] ? fd.get('type') : e.type;
      await db.put('events', { ...e, type, remind: readRemind(fd) });
      sheet.close();
      toast('Đã lưu');
      ctx.reload();
      return;
    }
    const repeat = fd.get('repeat') === 'weekly' ? 'weekly' : 'once';
    const next = {
      ...e,
      id: e.id || db.uid(),
      title: fd.get('title').trim(),
      type: EVENT_TYPES[fd.get('type')] ? fd.get('type') : 'personal',
      location: fd.get('location').trim(),
      repeat,
      start: fd.get('start'),
      end: fd.get('end'),
      remind: readRemind(fd),
    };
    if (repeat === 'weekly') { next.weekday = +fd.get('weekday'); delete next.date; }
    else { next.date = fd.get('date'); delete next.weekday; }

    const err = !next.title ? 'Vui lòng nhập tên sự kiện.'
      : repeat === 'once' && !next.date ? 'Vui lòng chọn ngày.'
      : !next.start || !next.end ? 'Vui lòng nhập giờ bắt đầu và kết thúc.'
      : minutesOf(next.end) <= minutesOf(next.start) ? 'Giờ kết thúc phải sau giờ bắt đầu.'
      : null;
    if (err) {
      errEl.textContent = err;
      errEl.hidden = false;
      return;
    }
    delete next.sample;
    await db.put('events', next);
    sheet.close();
    toast(isNew ? 'Đã thêm sự kiện' : 'Đã lưu');
    ctx.reload();
  });
}
