// Danh sách deadline với bộ lọc: chưa xong / quá hạn / đã xong.

import { esc } from './dom.js';
import { deadlineRow } from './today.js';
import { isOverdue } from '../schedule.js';

const FILTERS = [
  { id: 'open', label: 'Chưa xong' },
  { id: 'overdue', label: 'Quá hạn' },
  { id: 'done', label: 'Đã xong' },
];

let filter = 'open';

export function renderDeadlines(root, ctx) {
  const { data } = ctx;
  const now = Date.now();
  const all = data.deadlines;
  const count = {
    open: all.filter((d) => !d.done).length,
    overdue: all.filter((d) => isOverdue(d, now)).length,
    done: all.filter((d) => d.done).length,
  };
  const list = all
    .filter((d) => filter === 'done' ? d.done : filter === 'overdue' ? isOverdue(d, now) : !d.done)
    .sort((a, b) => filter === 'done' ? (b.doneAt || 0) - (a.doneAt || 0) : a.due - b.due || b.priority - a.priority);

  root.innerHTML = `
    <header class="page-head"><h1>Deadline</h1></header>
    <div class="segmented" role="tablist">
      ${FILTERS.map((f) => `<button type="button" role="tab" data-f="${f.id}" aria-selected="${filter === f.id}"
        class="${f.id === 'overdue' && count.overdue ? 'has-alert' : ''}">${f.label} <span class="count">${count[f.id]}</span></button>`).join('')}
    </div>
    <section class="section">
      ${list.length ? `<ul class="list card-group">${list.map((d) => deadlineRow(d, data, now)).join('')}</ul>`
        : `<div class="empty">${esc(filter === 'done' ? 'Chưa có việc nào hoàn thành.' : filter === 'overdue' ? 'Không có việc quá hạn. Tốt lắm!' : 'Không còn việc nào. Nhấn + để thêm deadline.')}</div>`}
    </section>`;

  root.querySelectorAll('[data-f]').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.f;
    renderDeadlines(root, ctx);
  }));
  root.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('.check')) return;
    ctx.openItem('deadline', el.dataset.open);
  }));
  root.querySelectorAll('.check').forEach((el) => el.addEventListener('click', (e) => {
    e.stopPropagation();
    ctx.toggleDeadline(el.dataset.id);
  }));
}
