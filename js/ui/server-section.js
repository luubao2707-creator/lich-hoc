// Cài đặt → Máy chủ đồng bộ: kết nối, trạng thái đồng bộ, thông báo đẩy, lịch Google qua máy chủ.

import { esc, openSheet, toast } from './dom.js';
import * as sync from '../sync.js';
import * as notify from '../notify.js';
import { fmtDate, dateKey, timeOf, todayKey } from '../time.js';

const when = (ts) => {
  if (!ts) return '—';
  return dateKey(ts) === todayKey() ? timeOf(ts) : `${fmtDate(dateKey(ts), { year: false })} ${timeOf(ts)}`;
};

/** HTML mục "Máy chủ đồng bộ" trong Cài đặt. */
export function serverSectionHTML(cfg) {
  if (!cfg?.url) {
    return `
      <section class="section">
        <h2 class="section-title">Máy chủ đồng bộ</h2>
        <div class="card-group pad">
          <p class="hint">Kết nối máy chủ riêng của bạn (Cloudflare) để: đồng bộ dữ liệu giữa các thiết bị,
            tự cập nhật lịch Google mỗi 5 phút, và nhận nhắc việc <strong>kể cả khi app đã tắt</strong>.
            Cách cài máy chủ: xem <em>server/README.md</em> trong mã nguồn.</p>
          <button type="button" class="btn btn-primary btn-block srv-connect">Kết nối máy chủ</button>
        </div>
      </section>`;
  }
  const ok = !cfg.lastError;
  const pushState = cfg.pushEnabled ? 'Đang bật trên thiết bị này.'
    : notify.status() === 'ios-install' ? 'Trên iPhone: hãy thêm app vào Màn hình chính và mở từ icon trước.'
    : sync.pushSupported() ? 'Chưa bật trên thiết bị này.' : 'Thiết bị chưa hỗ trợ thông báo đẩy.';
  return `
    <section class="section">
      <h2 class="section-title">Máy chủ đồng bộ</h2>
      <div class="card-group pad">
        <p class="status-line"><span class="dot ${ok ? 'on' : 'warn'}"></span>
          <span>${ok ? `Đã đồng bộ lúc ${esc(when(cfg.lastSync))}` : `Lỗi: ${esc(cfg.lastError)}`}<br>
          <small class="muted">${esc(cfg.url.replace(/^https?:\/\//, ''))}</small></span></p>
        <div class="pair">
          <button type="button" class="btn btn-ghost srv-sync">Đồng bộ ngay</button>
          <button type="button" class="btn btn-ghost srv-disconnect">Ngắt kết nối</button>
        </div>
      </div>
      <h3 class="imp-h srv-sub">Nhắc việc qua máy chủ</h3>
      <div class="card-group pad">
        <p class="hint">${esc(pushState)} Máy chủ gửi lời nhắc kể cả khi app đã tắt; khi đã bật, app không tự nhắc nữa để tránh trùng.</p>
        ${cfg.pushEnabled
          ? `<div class="pair">
               <button type="button" class="btn btn-ghost srv-push-test">Gửi thử</button>
               <button type="button" class="btn btn-ghost srv-push-off">Tắt</button>
             </div>`
          : `<button type="button" class="btn btn-primary btn-block srv-push-on" ${sync.pushSupported() ? '' : 'disabled'}>Bật nhắc việc qua máy chủ</button>`}
      </div>
    </section>`;
}

/** HTML trạng thái lịch Google do máy chủ tự đọc (chèn vào mục Google Calendar). */
export function serverIcsHTML(cfg) {
  if (!cfg?.url || !cfg.ics?.configured) return '';
  const ics = cfg.ics;
  return `
    <p class="status-line"><span class="dot ${ics.error ? 'warn' : 'on'}"></span>
      <span>Máy chủ tự đọc lịch Google mỗi 5 phút.<br>
      <small class="muted">${ics.error ? `Lỗi: ${esc(ics.error)}` : `Lần kiểm tra cuối: ${esc(when(ics.checked))}${ics.count != null ? ` · ${ics.count} mục` : ''}`}</small></span></p>
    <div class="pair">
      <button type="button" class="btn btn-ghost srv-ics-refresh">Đọc lại ngay</button>
      <button type="button" class="btn btn-ghost srv-ics-review">Xem lại phân loại</button>
    </div>`;
}

const hasOwnData = (data) => [...data.courses, ...data.deadlines, ...data.events].some((x) => !x.sample);

export function bindServerSection(root, ctx, rerender, reviewIcs) {
  const run = (sel, fn) => root.querySelector(sel)?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await fn(); } catch (err) { toast(err.message); } finally { btn.disabled = false; rerender(); }
  });

  root.querySelector('.srv-connect')?.addEventListener('click', () => openConnectSheet(ctx, rerender));
  run('.srv-sync', async () => { await sync.syncNow(); toast('Đã đồng bộ'); });
  run('.srv-disconnect', async () => {
    if (!confirm('Ngắt kết nối máy chủ trên thiết bị này?\nDữ liệu trên máy này vẫn được giữ, nhưng sẽ không đồng bộ nữa.')) return;
    await sync.disconnect();
    toast('Đã ngắt kết nối');
  });
  run('.srv-push-on', async () => { await sync.subscribePush(); toast('Đã bật nhắc việc qua máy chủ'); });
  run('.srv-push-off', async () => { await sync.unsubscribePush(); toast('Đã tắt nhắc việc qua máy chủ'); });
  run('.srv-push-test', async () => {
    const r = await sync.sendTestPush();
    toast(r.sent ? `Đã gửi tới ${r.sent} thiết bị` : 'Không gửi được – thử tắt rồi bật lại');
  });
  run('.srv-ics-refresh', async () => {
    const r = await sync.refreshServerIcs();
    toast(r.error ? `Lỗi: ${r.error}` : r.changed ? `Đã cập nhật ${r.changed} mục` : 'Lịch Google không có thay đổi');
    ctx.reload();
  });
  run('.srv-ics-review', async () => {
    const { text } = await sync.fetchServerIcs();
    await reviewIcs(text);
  });
}

function openConnectSheet(ctx, rerender) {
  const sheet = openSheet({
    title: 'Kết nối máy chủ',
    body: `
      <form class="form" novalidate>
        <label class="field">Địa chỉ máy chủ
          <input name="url" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
            placeholder="https://lichhoc-api.ten-ban.workers.dev">
        </label>
        <label class="field">Mã truy cập (APP_TOKEN)
          <input name="token" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false">
        </label>
        <p class="hint">Mã truy cập là mật khẩu bạn đặt khi cài máy chủ. App lưu nó trên thiết bị này để đồng bộ.</p>
        <p class="form-error" hidden></p>
        <div class="srv-choice" hidden></div>
        <button type="submit" class="btn btn-primary btn-block">Kiểm tra & kết nối</button>
      </form>`,
  });
  const form = sheet.body.querySelector('form');
  const errEl = form.querySelector('.form-error');
  const choice = form.querySelector('.srv-choice');
  const submit = form.querySelector('[type="submit"]');

  const finish = async (cfg, mode) => {
    submit.disabled = true;
    choice.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await sync.connect(cfg, mode);
      sheet.close();
      toast('Đã kết nối máy chủ');
      await ctx.reload();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
      submit.disabled = false;
    }
    rerender();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Đang kiểm tra…';
    try {
      const { cfg, info } = await sync.probe(form.url.value, form.token.value);
      const local = hasOwnData(ctx.data);
      if (!info.docs || !local) {
        // Máy chủ trống → gửi dữ liệu máy này lên; máy này chỉ có dữ liệu mẫu → lấy dữ liệu máy chủ.
        await finish(cfg, info.docs ? 'server' : 'merge');
        return;
      }
      choice.hidden = false;
      choice.innerHTML = `
        <p class="notice">Máy chủ đã có <strong>${Number(info.docs) || 0}</strong> mục dữ liệu, và máy này cũng có dữ liệu riêng. Chọn cách kết hợp:</p>
        <button type="button" class="btn btn-primary btn-block" data-mode="merge">Gộp dữ liệu hai bên</button>
        <button type="button" class="btn btn-ghost btn-block" data-mode="server">Dùng dữ liệu máy chủ (bỏ dữ liệu máy này)</button>`;
      submit.hidden = true;
      choice.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-mode]');
        if (!b) return;
        if (b.dataset.mode === 'server' && !confirm('Xóa dữ liệu trên máy này và thay bằng dữ liệu máy chủ?')) return;
        finish(cfg, b.dataset.mode);
      });
    } catch (err) {
      errEl.textContent = err.message === 'Failed to fetch' ? 'Không kết nối được máy chủ. Kiểm tra địa chỉ và mạng.' : err.message;
      errEl.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = 'Kiểm tra & kết nối';
    }
  });
}
