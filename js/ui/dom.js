// Tiện ích giao diện dùng chung: escape HTML, bottom sheet, toast, lời nhắc trong app.

import { REMIND_OPTIONS } from '../notify.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * Mở bottom sheet. Trả về { el, body, close }.
 * `body` là HTML nội dung; nút đóng và chạm nền tối sẽ đóng sheet.
 */
export function openSheet({ title, body, onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `
    <div class="sheet-backdrop"></div>
    <section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <header class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="btn-text sheet-close">Đóng</button>
      </header>
      <div class="sheet-body">${body}</div>
    </section>`;
  document.body.appendChild(wrap);
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => wrap.classList.add('show'));

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    wrap.classList.remove('show');
    setTimeout(() => {
      wrap.remove();
      if (!document.querySelector('.sheet-wrap')) document.body.classList.remove('sheet-open');
    }, 250);
    onClose?.();
  };
  wrap.querySelector('.sheet-backdrop').addEventListener('click', close);
  wrap.querySelector('.sheet-close').addEventListener('click', close);
  return { el: wrap, body: wrap.querySelector('.sheet-body'), close };
}

/** Menu chọn hành động (action sheet). actions: [{ label, sub?, onClick }] */
export function openActionSheet(title, actions) {
  const sheet = openSheet({
    title,
    body: `<div class="action-list">${actions.map((a, i) => `
      <button type="button" class="action" data-i="${i}">
        <span class="action-dot" style="background:${a.color || 'var(--accent)'}"></span>
        <span><strong>${esc(a.label)}</strong>${a.sub ? `<small>${esc(a.sub)}</small>` : ''}</span>
      </button>`).join('')}</div>`,
  });
  sheet.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.action');
    if (!btn) return;
    sheet.close();
    actions[+btn.dataset.i].onClick();
  });
}

let toastTimer;
/** Thông báo ngắn ở đáy màn hình, có thể kèm nút hành động (vd: Hoàn tác). */
export function toast(msg, action) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) {
    el.querySelector('button').onclick = () => { el.classList.remove('show'); action.onClick(); };
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 4500 : 2200);
}

/** Ô chọn "Nhắc trước" (chọn nhiều). Đọc lại bằng readRemind(formData). */
export function remindField(selected = []) {
  return `
    <fieldset class="field">
      <legend>Nhắc trước</legend>
      <div class="chips">
        ${REMIND_OPTIONS.map((o) => `<label class="chip-pick"><input type="checkbox" name="remind" value="${o.min}"
          ${selected.includes(o.min) ? 'checked' : ''}><span>${o.label}</span></label>`).join('')}
      </div>
    </fieldset>`;
}
export const readRemind = (fd) => fd.getAll('remind').map(Number).sort((a, b) => a - b);

export const BELL = '<svg class="bell" viewBox="0 0 24 24" aria-label="Có nhắc việc"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0"/></svg>';

/** Lời nhắc hiện ngay trong app (khi chưa có quyền thông báo hệ thống). Chạm để đóng. */
export function inAppAlert({ title, body }) {
  const box = document.getElementById('alerts');
  const el = document.createElement('div');
  el.className = 'alert';
  el.setAttribute('role', 'alert');
  el.innerHTML = `${BELL}<div><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`;
  const close = () => { el.classList.add('hide'); setTimeout(() => el.remove(), 250); };
  el.addEventListener('click', close);
  box.appendChild(el);
  navigator.vibrate?.(200);
  setTimeout(close, 15_000);
}
