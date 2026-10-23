// Màn xem trước khi nhập từ Google Calendar: chọn loại cho từng chuỗi lịch / sự kiện.

import { esc, openSheet, toast } from './dom.js';
import { readCalendarFiles, buildCandidates } from '../ics.js';
import { CHOICES, guessChoice, splitTitle, suggestSemesterStart, commitImport } from '../gcal-import.js';
import { describeRec } from '../schedule.js';
import { fmtDate, weekdayOf, WEEKDAY_SHORT } from '../time.js';
import { hasSampleData } from '../sample.js';

/** Xem lại phân loại từ nội dung iCal (máy chủ đọc từ link bí mật). */
export async function importCalendarText(ctx, text) {
  let parsed;
  try {
    parsed = buildCandidates([{ name: 'Google Calendar', text }]);
  } catch (err) {
    alert('Không đọc được lịch: ' + err.message);
    return;
  }
  openPreview(ctx, parsed, await hasSampleData());
}

/** Gọi khi người dùng chọn file (.ics / .zip). */
export async function importCalendarFiles(ctx, fileList) {
  let parsed;
  try {
    const files = await readCalendarFiles([...fileList]);
    parsed = buildCandidates(files);
  } catch (err) {
    console.error(err);
    alert('Không đọc được file lịch: ' + err.message);
    return;
  }
  if (!parsed.candidates.length) {
    alert('Không tìm thấy lịch nào để nhập (các sự kiện cả ngày hoặc đã qua đều được bỏ qua).');
    return;
  }
  openPreview(ctx, parsed, await hasSampleData());
}

function openPreview(ctx, { candidates, skipped }, sample) {
  const saved = ctx.data.settings.gcalMap || {};
  const choices = Object.fromEntries(candidates.map((c) => [c.uid, saved[c.uid] || guessChoice(c)]));

  const series = candidates.filter((c) => c.kind === 'series')
    .sort((a, b) => (choices[a.uid] === 'course' ? 0 : 1) - (choices[b.uid] === 'course' ? 0 : 1) || a.title.localeCompare(b.title, 'vi'));
  const once = candidates.filter((c) => c.kind === 'once')
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  const calendars = [...new Set(candidates.map((c) => c.calendar))];

  const skippedText = [
    skipped.allDay && `${skipped.allDay} sự kiện cả ngày`,
    skipped.past && `${skipped.past} mục đã qua`,
    skipped.unsupported && `${skipped.unsupported} mục lặp theo tháng/năm`,
  ].filter(Boolean).join(', ');

  const row = (c) => {
    const meta = c.kind === 'series'
      ? `${describeRec(c.rec)} · ${c.start}–${c.end}`
      : `${WEEKDAY_SHORT[weekdayOf(c.date)]}, ${fmtDate(c.date)} · ${c.start}–${c.end}`;
    return `
      <li class="imp-row">
        <div class="imp-main">
          <div class="dl-title">${esc(c.title)}</div>
          <div class="dl-meta">${esc(meta)}${c.location ? ` · ${esc(c.location)}` : ''}</div>
        </div>
        <select data-uid="${esc(c.uid)}" aria-label="Loại cho ${esc(c.title)}">
          ${Object.entries(CHOICES).map(([k, v]) => `<option value="${k}" ${choices[c.uid] === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select>
      </li>`;
  };

  const sheet = openSheet({
    title: 'Nhập từ Google Calendar',
    body: `
      <div class="form">
        <p class="hint">Lịch: <strong>${esc(calendars.join(', '))}</strong>. Đọc được ${series.length} lịch lặp và
          ${once.length} sự kiện một lần.${skippedText ? ` Bỏ qua ${esc(skippedText)}.` : ''}</p>
        <p class="hint">Chọn loại cho từng mục. Các buổi <strong>LT / BT / TN</strong> cùng tên sẽ gộp thành một môn.
          Lựa chọn được ghi nhớ cho lần nhập sau.</p>

        ${series.length ? `<h3 class="imp-h">Lặp lại</h3><ul class="list card-group imp-list">${series.map(row).join('')}</ul>` : ''}
        ${once.length ? `
          <div class="imp-h-row"><h3 class="imp-h">Một lần (sắp tới)</h3>
            <button type="button" class="btn-text skip-once">Bỏ qua tất cả</button></div>
          <ul class="list card-group imp-list">${once.map(row).join('')}</ul>` : ''}

        <div class="card-group pad">
          <label class="toggle"><input type="checkbox" name="setSemester"><span class="sem-text"></span></label>
          ${sample ? '<label class="toggle"><input type="checkbox" name="clearSample" checked><span>Xóa dữ liệu mẫu</span></label>' : ''}
        </div>

        <p class="hint summary"></p>
        <button type="button" class="btn btn-primary btn-block do-import">Nhập</button>
      </div>`,
  });

  const body = sheet.body;
  const semBox = body.querySelector('[name="setSemester"]');
  const semText = body.querySelector('.sem-text');
  const summary = body.querySelector('.summary');
  const btn = body.querySelector('.do-import');

  const refresh = () => {
    const courseNames = new Set(candidates.filter((c) => choices[c.uid] === 'course')
      .map((c) => `${c.calendar}|${splitTitle(c.title).base.toLowerCase()}`));
    const events = candidates.filter((c) => !['course', 'skip'].includes(choices[c.uid])).length;
    summary.textContent = `Sẽ nhập ${courseNames.size} môn học và ${events} sự kiện.`;
    btn.textContent = `Nhập ${courseNames.size + events} mục`;
    btn.disabled = courseNames.size + events === 0;

    const sem = suggestSemesterStart(candidates, choices);
    semBox.closest('.toggle').hidden = !sem || sem === ctx.data.settings.semesterStart;
    semBox.dataset.value = sem || '';
    if (sem) semText.textContent = `Đặt tuần 1 bắt đầu từ ${fmtDate(sem)} (buổi học sớm nhất)`;
    if (!semBox.dataset.touched) semBox.checked = !!sem;
  };
  semBox.addEventListener('change', () => { semBox.dataset.touched = '1'; });

  body.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-uid]');
    if (sel) { choices[sel.dataset.uid] = sel.value; refresh(); }
  });
  body.querySelector('.skip-once')?.addEventListener('click', () => {
    for (const c of once) choices[c.uid] = 'skip';
    body.querySelectorAll('select[data-uid]').forEach((s) => { s.value = choices[s.dataset.uid]; });
    refresh();
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Đang nhập…';
    try {
      const res = await commitImport(candidates, choices, {
        clearSample: !!body.querySelector('[name="clearSample"]')?.checked,
        semesterStart: semBox.checked && !semBox.closest('.toggle').hidden ? semBox.dataset.value : null,
      });
      sheet.close();
      toast(`Đã nhập ${res.courses} môn, ${res.events} sự kiện${res.removed ? `, xóa ${res.removed} mục cũ` : ''}`);
      ctx.reload();
    } catch (err) {
      console.error(err);
      alert('Nhập không thành công: ' + err.message);
      btn.disabled = false;
      refresh();
    }
  });

  refresh();
}
