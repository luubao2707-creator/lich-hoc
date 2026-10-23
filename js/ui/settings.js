// Cài đặt: học kỳ, bảng giờ các tiết, nhắc việc, sao lưu, dữ liệu mẫu.

import { esc, toast } from './dom.js';
import * as db from '../db.js';
import * as notify from '../notify.js';
import { exportData, parseBackup, importData } from '../backup.js';
import { mondayOf, fmtDate, minutesOf, todayKey, weekNumber, dateKey, diffDays, timeOf } from '../time.js';
import { hasSampleData, clearSampleData } from '../sample.js';
import { importCalendarFiles } from './gcal-sheet.js';
import { removeAllImported } from '../gcal-import.js';

const NOTIFY_TEXT = {
  granted: 'Đã bật. Thông báo hiện khi app đang mở hoặc còn chạy nền.',
  default: 'Chưa bật. Nhấn nút bên dưới để cho phép.',
  denied: notify.isIOS() ? 'Đang bị chặn. Vào Cài đặt iPhone → Thông báo → Lịch Học để bật lại.'
    : 'Đang bị chặn. Bật lại quyền thông báo cho trang này trong cài đặt trình duyệt.',
  'ios-install': 'Trên iPhone, hãy thêm app vào Màn hình chính (Chia sẻ → Thêm vào MH chính) rồi mở từ icon để bật thông báo.',
  insecure: 'Cần mở app qua HTTPS để dùng thông báo. Hiện chỉ nhắc bên trong app.',
  unsupported: 'Thiết bị chưa hỗ trợ (iPhone cần iOS 16.4+ và mở từ Màn hình chính). Hiện chỉ nhắc bên trong app.',
};

function lastBackupText(ts) {
  if (!ts) return 'Chưa sao lưu lần nào.';
  const days = diffDays(todayKey(), dateKey(ts));
  const when = `${fmtDate(dateKey(ts))} ${timeOf(ts)}`;
  return days > 14 ? `Lần gần nhất: ${when} – đã ${days} ngày, nên sao lưu lại.` : `Lần gần nhất: ${when}.`;
}

export async function renderSettings(root, ctx) {
  const { settings } = ctx.data;
  const sample = await hasSampleData();
  const week = weekNumber(todayKey(), settings.semesterStart);
  const nState = notify.status();
  const imported = ctx.data.courses.filter((c) => c.source === 'gcal').length + ctx.data.events.filter((e) => e.source === 'gcal').length;
  const stale = !settings.lastBackup || diffDays(todayKey(), dateKey(settings.lastBackup)) > 14;

  const periodRow = (p, i) => `
    <li class="period-row">
      <span class="period-n">Tiết ${i + 1}</span>
      <input type="time" name="ps" value="${esc(p.start)}" aria-label="Tiết ${i + 1} bắt đầu">
      <span class="muted">–</span>
      <input type="time" name="pe" value="${esc(p.end)}" aria-label="Tiết ${i + 1} kết thúc">
    </li>`;

  root.innerHTML = `
    <header class="page-head"><h1>Cài đặt</h1></header>

    <section class="section">
      <h2 class="section-title">Học kỳ</h2>
      <div class="card-group pad">
        <label class="field">Ngày bắt đầu tuần 1
          <input type="date" name="semesterStart" value="${esc(settings.semesterStart)}">
        </label>
        <p class="hint">Tuần bắt đầu từ Thứ Hai (${esc(fmtDate(mondayOf(settings.semesterStart)))}). Hôm nay là
          <strong>${week >= 1 ? `tuần ${week}` : 'trước học kỳ'}</strong>.</p>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Nhắc việc</h2>
      <div class="card-group pad">
        <p class="status-line"><span class="dot ${nState === 'granted' ? 'on' : ''}"></span>${esc(NOTIFY_TEXT[nState])}</p>
        ${nState === 'default' ? '<button type="button" class="btn btn-primary btn-block notify-enable">Bật thông báo</button>' : ''}
        <button type="button" class="btn btn-ghost btn-block notify-test">Gửi thử một lời nhắc</button>
        <p class="hint">Chọn "Nhắc trước 15 phút / 1 giờ / 1 ngày" trong từng môn học hoặc deadline.
          Lưu ý: iOS không cho web app tự hẹn giờ khi app đã bị tắt hẳn, nên lời nhắc chạy khi app đang mở
          hoặc còn chạy nền. Lời nhắc bị lỡ sẽ được nhắc bù khi bạn mở lại app.</p>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Sao lưu</h2>
      <div class="card-group pad">
        <p class="hint ${stale ? 'warn-text' : ''}">${esc(lastBackupText(settings.lastBackup))}</p>
        <button type="button" class="btn btn-primary btn-block backup-export">Xuất dữ liệu ra file JSON</button>
        <label class="btn btn-ghost btn-block file-btn">Khôi phục từ file JSON
          <input type="file" class="backup-import visually-hidden" tabindex="-1">
        </label>
        <p class="hint">iOS có thể tự xóa dữ liệu web app khi máy thiếu bộ nhớ hoặc lâu không mở.
          Hãy lưu file sao lưu vào app Tệp / iCloud Drive định kỳ. Khôi phục sẽ <strong>thay thế</strong> toàn bộ dữ liệu hiện tại.</p>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Google Calendar</h2>
      <div class="card-group pad">
        <p class="hint">${settings.lastGcalImport
          ? `Lần nhập gần nhất: ${esc(fmtDate(dateKey(settings.lastGcalImport)))} ${esc(timeOf(settings.lastGcalImport))} · ${imported} mục đang có.`
          : 'Nhập lịch học và các lịch khác từ Google Calendar (đồng bộ một chiều, nhập lại để cập nhật).'}</p>
        <label class="btn btn-primary btn-block file-btn">Chọn file .ics / .zip
          <input type="file" class="gcal-import visually-hidden" tabindex="-1" multiple>
        </label>
        <details class="howto">
          <summary>Lấy file lịch thế nào?</summary>
          <ol>
            <li><strong>Trên máy tính:</strong> mở calendar.google.com → ⚙ Cài đặt → <em>Nhập và xuất</em> → <em>Xuất</em>.
              Google tải về một file .zip – chọn thẳng file đó ở đây (hoặc gửi sang điện thoại qua iCloud Drive / Zalo / AirDrop).</li>
            <li><strong>Trên iPhone:</strong> trong Cài đặt Google Calendar (bản web trên máy tính) → chọn lịch →
              <em>Địa chỉ bí mật ở định dạng iCal</em>, sao chép link và mở bằng Safari trên iPhone → Safari tải file
              <em>basic.ics</em> vào app Tệp → chọn file đó ở đây. Lần sau chỉ cần mở lại link đó để lấy bản mới.
              Đừng chia sẻ link bí mật này cho người khác.</li>
          </ol>
        </details>
        ${imported ? '<button type="button" class="btn btn-danger btn-block gcal-clear">Xóa dữ liệu đã nhập từ Google</button>' : ''}
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">Bảng giờ các tiết</h2>
      <form class="card-group pad periods-form">
        <ol class="periods">${settings.periods.map(periodRow).join('')}</ol>
        <div class="pair">
          <button type="button" class="btn btn-ghost add-period">+ Thêm tiết</button>
          <button type="button" class="btn btn-ghost remove-period">− Bớt tiết cuối</button>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Lưu bảng giờ</button>
      </form>
    </section>

    <section class="section">
      <h2 class="section-title">Dữ liệu mẫu</h2>
      <div class="card-group pad">
        ${sample
          ? `<p class="hint">Ứng dụng đang có dữ liệu mẫu để xem thử. Các mục bạn đã sửa sẽ được giữ lại.</p>
             <button type="button" class="btn btn-danger btn-block clear-sample">Xóa dữ liệu mẫu</button>`
          : `<p class="hint">Không còn dữ liệu mẫu.</p>`}
      </div>
    </section>

    <p class="footer-note muted">Lịch Học · giờ Việt Nam (UTC+7)</p>`;

  root.querySelector('[name="semesterStart"]').addEventListener('change', async (e) => {
    if (!e.target.value) return;
    await db.saveSettings({ semesterStart: mondayOf(e.target.value) });
    toast('Đã cập nhật học kỳ');
    ctx.reload();
  });

  // ----- Nhắc việc -----
  root.querySelector('.notify-enable')?.addEventListener('click', async () => {
    const s = await notify.requestPermission();
    toast(s === 'granted' ? 'Đã bật thông báo' : 'Chưa được cấp quyền thông báo');
    renderSettings(root, ctx);
  });
  root.querySelector('.notify-test').addEventListener('click', async () => {
    if (notify.status() === 'default') await notify.requestPermission();
    await notify.sendTest();
    if (notify.status() === 'granted') toast('Đã gửi thông báo thử');
  });

  // ----- Sao lưu -----
  root.querySelector('.backup-export').addEventListener('click', async () => {
    try {
      // Dùng dữ liệu trong bộ nhớ để gọi share ngay trong thao tác chạm (yêu cầu của Safari).
      if (await exportData(ctx.data)) {
        toast('Đã xuất file sao lưu');
        ctx.reload();
      }
    } catch (err) {
      console.error(err);
      toast('Không xuất được file: ' + err.message);
    }
  });
  root.querySelector('.backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = parseBackup(await file.text());
      const msg = `Khôi phục bản sao lưu ngày ${parsed.exportedLabel}?\n`
        + `${parsed.courses.length} môn học, ${parsed.deadlines.length} deadline, ${parsed.events.length} sự kiện.\n`
        + (parsed.skipped ? `(${parsed.skipped} mục lỗi sẽ bị bỏ qua)\n` : '')
        + '\nToàn bộ dữ liệu hiện tại sẽ bị THAY THẾ.';
      if (!confirm(msg)) return;
      await importData(parsed);
      toast('Đã khôi phục dữ liệu');
      ctx.reload();
    } catch (err) {
      console.error(err);
      alert('Không khôi phục được: ' + err.message);
    }
  });

  // ----- Google Calendar -----
  root.querySelector('.gcal-import').addEventListener('change', async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) await importCalendarFiles(ctx, files);
  });
  root.querySelector('.gcal-clear')?.addEventListener('click', async () => {
    if (!confirm(`Xóa ${imported} môn học / sự kiện đã nhập từ Google Calendar?
Deadline gắn với các môn này được giữ lại.`)) return;
    await removeAllImported();
    toast('Đã xóa dữ liệu đã nhập');
    ctx.reload();
  });

  // ----- Bảng giờ -----
  const form = root.querySelector('.periods-form');
  const ol = form.querySelector('.periods');
  form.querySelector('.add-period').addEventListener('click', () => {
    const rows = ol.querySelectorAll('.period-row');
    const lastEnd = rows.length ? rows[rows.length - 1].querySelector('[name="pe"]').value : '07:00';
    const start = addMin(lastEnd, 10);
    ol.insertAdjacentHTML('beforeend', periodRow({ start, end: addMin(start, 50) }, rows.length));
  });
  form.querySelector('.remove-period').addEventListener('click', () => {
    if (ol.children.length > 1) ol.lastElementChild.remove();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const periods = [...ol.querySelectorAll('.period-row')].map((r) => ({
      start: r.querySelector('[name="ps"]').value, end: r.querySelector('[name="pe"]').value,
    }));
    const bad = periods.findIndex((p) => !p.start || !p.end || minutesOf(p.end) <= minutesOf(p.start));
    if (bad >= 0) { toast(`Tiết ${bad + 1}: giờ kết thúc phải sau giờ bắt đầu`); return; }
    const usedMax = Math.max(0, ...ctx.data.courses.flatMap((c) => c.sessions.map((s) => s.mode === 'period' ? s.periodTo : 0)));
    if (usedMax > periods.length) { toast(`Có môn đang dùng tiết ${usedMax}, không thể bớt`); return; }
    await db.saveSettings({ periods });
    toast('Đã lưu bảng giờ');
    ctx.reload();
  });

  root.querySelector('.clear-sample')?.addEventListener('click', async () => {
    if (!confirm('Xóa toàn bộ môn học, sự kiện và deadline mẫu?')) return;
    await clearSampleData();
    toast('Đã xóa dữ liệu mẫu');
    ctx.reload();
  });
}

function addMin(hhmm, n) {
  const t = Math.min(minutesOf(hhmm) + n, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
