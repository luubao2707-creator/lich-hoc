// Form thêm / sửa deadline.

import { esc, openSheet, toast, remindField, readRemind } from './dom.js';
import * as db from '../db.js';
import { todayKey, dateKey, timeOf, epochOf } from '../time.js';
import { PRIORITIES } from '../schedule.js';

export function openDeadlineForm(ctx, deadline = null, preset = {}) {
  const isNew = !deadline;
  const d = deadline || { title: '', courseId: preset.courseId ?? null, due: null, priority: 2, note: '', done: false, remind: [60, 1440] };
  const dueDate = d.due ? dateKey(d.due) : todayKey();
  const dueTime = d.due ? timeOf(d.due) : '23:59';

  const sheet = openSheet({
    title: isNew ? 'Thêm deadline' : 'Sửa deadline',
    body: `
      <form class="form" novalidate>
        <label class="field">Tên công việc<input name="title" required autocomplete="off" value="${esc(d.title)}" placeholder="vd: Nộp báo cáo Lab 3"></label>

        <label class="field">Môn liên quan
          <select name="courseId">
            <option value="">— Không gắn môn —</option>
            ${ctx.data.courses.map((c) => `<option value="${esc(c.id)}" ${c.id === d.courseId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
        </label>

        <div class="pair">
          <label class="field">Ngày hạn<input type="date" name="date" required value="${dueDate}"></label>
          <label class="field">Giờ<input type="time" name="time" required value="${dueTime}"></label>
        </div>

        <fieldset class="field">
          <legend>Mức ưu tiên</legend>
          <div class="segmented prio-pick">
            ${[1, 2, 3].map((p) => `<label class="p${p}"><input type="radio" name="priority" value="${p}" ${d.priority === p ? 'checked' : ''}><span>${PRIORITIES[p]}</span></label>`).join('')}
          </div>
        </fieldset>

        ${remindField(d.remind || [])}

        <label class="field">Ghi chú<textarea name="note" rows="3" placeholder="Link nộp bài, yêu cầu…">${esc(d.note)}</textarea></label>

        ${isNew ? '' : `<label class="toggle"><input type="checkbox" name="done" ${d.done ? 'checked' : ''}><span>Đã hoàn thành</span></label>`}

        <p class="form-error" hidden></p>
        <button type="submit" class="btn btn-primary btn-block">${isNew ? 'Thêm deadline' : 'Lưu thay đổi'}</button>
        ${isNew ? '' : '<button type="button" class="btn btn-danger btn-block delete">Xóa deadline</button>'}
      </form>`,
  });

  const form = sheet.body.querySelector('form');
  const errEl = form.querySelector('.form-error');

  form.querySelector('.delete')?.addEventListener('click', async () => {
    if (!confirm(`Xóa deadline "${d.title}"?`)) return;
    await db.remove('deadlines', d.id);
    sheet.close();
    toast('Đã xóa deadline');
    ctx.reload();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const title = fd.get('title').trim();
    const date = fd.get('date');
    const time = fd.get('time') || '23:59';
    if (!title || !date) {
      errEl.textContent = !title ? 'Vui lòng nhập tên công việc.' : 'Vui lòng chọn ngày hạn.';
      errEl.hidden = false;
      return;
    }
    const done = isNew ? false : fd.get('done') === 'on';
    const next = {
      ...d,
      id: d.id || db.uid(),
      title,
      courseId: fd.get('courseId') || null,
      due: epochOf(date, time),
      priority: +fd.get('priority') || 2,
      remind: readRemind(fd),
      note: fd.get('note').trim(),
      done,
      doneAt: done ? (d.doneAt || Date.now()) : null,
    };
    delete next.sample;
    await db.put('deadlines', next);
    sheet.close();
    toast(isNew ? 'Đã thêm deadline' : 'Đã lưu');
    ctx.reload();
  });
}
