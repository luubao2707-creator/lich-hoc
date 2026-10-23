// Danh sách môn học (bản tối thiểu; lưới tuần sẽ thêm ở bản sau).

import { esc } from './dom.js';
import { sessionLabel } from '../schedule.js';

export function renderCourses(root, ctx) {
  const { courses, settings } = ctx.data;

  root.innerHTML = `
    <header class="page-head"><h1>Môn học</h1></header>
    <section class="section">
      ${courses.length ? `<ul class="list card-group">${courses.map((c) => `
        <li class="row course-row" data-open="${esc(c.id)}">
          <span class="swatch" style="background:${esc(c.color)}"></span>
          <div class="course-main">
            <div class="dl-title">${esc(c.name)}</div>
            <div class="dl-meta">${esc([c.room, c.teacher].filter(Boolean).join(' · '))}</div>
            <div class="sessions">${c.sessions.map((s) => `<span>${esc(sessionLabel(s, settings.periods))}</span>`).join('')}</div>
          </div>
          <span class="muted weeks">Tuần ${c.weekFrom}–${c.weekTo}</span>
        </li>`).join('')}</ul>`
        : `<div class="empty">Chưa có môn học nào.</div>`}
      <button type="button" class="btn btn-block add-course">+ Thêm môn học</button>
    </section>`;

  root.querySelectorAll('[data-open]').forEach((el) =>
    el.addEventListener('click', () => ctx.openItem('course', el.dataset.open)));
  root.querySelector('.add-course').addEventListener('click', () => ctx.openCourseForm());
}
