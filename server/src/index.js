// Máy chủ đồng bộ Lịch Học – Cloudflare Worker + D1. Chỉ một người dùng (APP_TOKEN).
//
// API (đều cần header Authorization: Bearer <APP_TOKEN>):
//   GET    /api/info              trạng thái máy chủ
//   POST   /api/sync              { since, changes } → { rev, changes, ics }
//   GET    /api/ics               nội dung iCal mới nhất (để xem lại phân loại trong app)
//   POST   /api/ics/refresh       đọc lại lịch Google ngay
//   GET    /api/push/key          khóa công khai VAPID
//   POST   /api/push/subscribe    { subscription, device }
//   DELETE /api/push/subscribe    { endpoint }
//   POST   /api/push/test         gửi thông báo thử tới mọi thiết bị
// Cron mỗi phút: gửi lời nhắc tới hạn; mỗi 5 phút: đọc lịch Google (ICAL_URL).
//
// Logic lịch dùng chung với app (thư mục js/), nên kết quả giống hệt khi nhập trên điện thoại.

import { buildCandidates } from '../../js/ics.js';
import { planImport, resolveChoices, sameRecord } from '../../js/gcal-plan.js';
import { dueReminders, message } from '../../js/reminders.js';
import { mondayOf, todayKey } from '../../js/time.js';
import { DEFAULT_PERIODS } from '../../js/db.js';
import { getVapid, sendPush } from './webpush.js';

const STORES = ['courses', 'deadlines', 'events', 'settings'];
const ICS_EVERY_MS = 5 * 60e3;
const REMIND_WINDOW_MS = 6 * 3600e3;  // nhắc bù lời nhắc bị lỡ (như app), bảng fired chống gửi trùng
const MAX_PUSH_PER_RUN = 5;
const MAX_DOC_BYTES = 64 * 1024;
const MAX_CHANGES = 2000;

// ---------- Tiện ích ----------

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = {
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowed.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

async function sha256(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** So sánh mã truy cập theo thời gian không đổi (so hai giá trị băm). */
async function authorized(req, env) {
  if (!env.APP_TOKEN) return false;
  const m = /^Bearer (.+)$/.exec(req.headers.get('Authorization') || '');
  if (!m) return false;
  const [a, b] = await Promise.all([sha256(m[1]), sha256(env.APP_TOKEN)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function getMeta(env, key) {
  return (await env.DB.prepare('SELECT value FROM meta WHERE key = ?1').bind(key).first())?.value ?? null;
}
function setMetaStmt(env, key, value) {
  return env.DB.prepare('INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value == null ? null : String(value));
}
const setMeta = (env, key, value) => setMetaStmt(env, key, value).run();

// ---------- Dữ liệu ----------

/** Ghi nhiều bản ghi: items = [{ store, id, data | null, updated }]. Mỗi bản ghi nhận một rev mới. */
async function writeDocs(env, items) {
  if (!items.length) return;
  const row = await env.DB.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + ?1 WHERE key = 'rev' RETURNING value")
    .bind(items.length).first();
  let rev = Number(row.value) - items.length;
  const stmt = env.DB.prepare(`INSERT INTO docs (store, id, data, updated, deleted, rev) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT(store, id) DO UPDATE SET data = excluded.data, updated = excluded.updated, deleted = excluded.deleted, rev = excluded.rev`);
  await env.DB.batch(items.map((it) => stmt.bind(
    it.store, it.id, it.data == null ? null : JSON.stringify(it.data), it.updated, it.data == null ? 1 : 0, ++rev,
  )));
}

/** Toàn bộ dữ liệu hiện có, cùng dạng với db.loadAll() của app. */
async function loadData(env) {
  const { results } = await env.DB.prepare('SELECT store, id, data FROM docs WHERE deleted = 0').all();
  const data = { courses: [], deadlines: [], events: [], settings: null };
  for (const r of results) {
    const v = JSON.parse(r.data);
    if (r.store === 'settings') { if (r.id === 'app') data.settings = v; } else if (data[r.store]) data[r.store].push(v);
  }
  data.settings = { semesterStart: mondayOf(todayKey()), periods: DEFAULT_PERIODS, ...(data.settings || {}) };
  return data;
}

function validChange(ch) {
  return ch && STORES.includes(ch.store) && typeof ch.id === 'string' && ch.id.length > 0 && ch.id.length <= 200
    && Number.isFinite(ch.updated) && (ch.data === null || (typeof ch.data === 'object' && !Array.isArray(ch.data)))
    && (ch.store !== 'settings' || ch.id === 'app');
}

async function handleSync(req, env) {
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.changes) || body.changes.length > MAX_CHANGES) return json({ error: 'Yêu cầu không hợp lệ' }, 400);
  const since = Number(body.since) || 0;
  const changes = body.changes.filter(validChange)
    .filter((ch) => ch.data === null || JSON.stringify(ch.data).length <= MAX_DOC_BYTES);

  // Bản sửa sau cùng thắng: bỏ thay đổi cũ hơn bản đang có trên máy chủ.
  const { results: existing } = await env.DB.prepare('SELECT store, id, updated FROM docs').all();
  const known = new Map(existing.map((r) => [`${r.store}/${r.id}`, r.updated]));
  const toWrite = [];
  const stale = [];
  for (const ch of changes) {
    const cur = known.get(`${ch.store}/${ch.id}`);
    if (cur == null && ch.data === null) continue; // xóa thứ máy chủ chưa từng có (vd dữ liệu mẫu)
    if (cur == null || ch.updated >= cur) toWrite.push(ch);
    else stale.push(ch);
  }
  await writeDocs(env, toWrite.map((ch) => ({ ...ch, data: ch.data === null ? null : { ...ch.data, id: ch.store === 'settings' ? undefined : ch.id } })));

  const { results } = await env.DB.prepare('SELECT store, id, data, updated, deleted, rev FROM docs WHERE rev > ?1 ORDER BY rev').bind(since).all();
  const out = results.map(toChange);
  // Thiết bị gửi bản cũ hơn → trả bản mới của máy chủ để thiết bị cập nhật lại.
  for (const ch of stale) {
    if (out.some((o) => o.store === ch.store && o.id === ch.id)) continue;
    const r = await env.DB.prepare('SELECT store, id, data, updated, deleted, rev FROM docs WHERE store = ?1 AND id = ?2').bind(ch.store, ch.id).first();
    if (r) out.push(toChange(r));
  }
  return json({ rev: Number(await getMeta(env, 'rev')), changes: out, ics: await icsStatus(env) });
}

const toChange = (r) => ({ store: r.store, id: r.id, data: r.deleted ? null : JSON.parse(r.data), updated: r.updated, deleted: !!r.deleted });

// ---------- Lịch Google (link iCal bí mật) ----------

async function icsStatus(env) {
  const [checked, changed, count, error] = await Promise.all(
    ['ics_checked', 'ics_changed', 'ics_count', 'ics_error'].map((k) => getMeta(env, k)));
  return {
    configured: !!env.ICAL_URL,
    checked: checked ? Number(checked) : null,
    changed: changed ? Number(changed) : null,
    count: count ? Number(count) : null,
    error,
  };
}

async function fetchIcs(env) {
  const res = await fetch(env.ICAL_URL, { headers: { 'User-Agent': 'LichHoc/1.0 (+Cloudflare Worker)' } });
  if (!res.ok) throw new Error(`Google trả lỗi ${res.status} khi đọc lịch`);
  return res.text();
}

/** Đọc lịch Google và cập nhật môn học / sự kiện nếu có thay đổi. */
async function syncIcs(env, { force = false } = {}) {
  if (!env.ICAL_URL) return { error: 'Chưa cấu hình ICAL_URL' };
  const now = Date.now();
  try {
    const text = await fetchIcs(env);
    const hash = await sha256(text);
    if (!force && hash === await getMeta(env, 'ics_hash')) {
      await env.DB.batch([setMetaStmt(env, 'ics_checked', now), setMetaStmt(env, 'ics_error', null)]);
      return { unchanged: true };
    }

    const { candidates } = buildCandidates([{ name: 'Google Calendar', text }]);
    const data = await loadData(env);
    const plan = planImport(candidates, resolveChoices(candidates, data.settings.gcalMap || {}), data);

    const writes = [];
    const byId = (list) => new Map(list.map((x) => [x.id, x]));
    const oldCourses = byId(data.courses);
    const oldEvents = byId(data.events);
    for (const c of plan.courses) if (!sameRecord(oldCourses.get(c.id), c)) writes.push({ store: 'courses', id: c.id, data: { ...c, updatedAt: now }, updated: now });
    for (const e of plan.events) if (!sameRecord(oldEvents.get(e.id), e)) writes.push({ store: 'events', id: e.id, data: { ...e, updatedAt: now }, updated: now });
    for (const id of plan.removeCourseIds) writes.push({ store: 'courses', id, data: null, updated: now });
    for (const id of plan.removeEventIds) writes.push({ store: 'events', id, data: null, updated: now });

    // Deadline gắn với môn vừa bị xóa → bỏ liên kết.
    const removed = new Set(plan.removeCourseIds);
    for (const d of data.deadlines) {
      if (d.courseId && removed.has(d.courseId)) writes.push({ store: 'deadlines', id: d.id, data: { ...d, courseId: null, updatedAt: now }, updated: now });
    }

    await writeDocs(env, writes);
    await env.DB.batch([
      setMetaStmt(env, 'ics_hash', hash), setMetaStmt(env, 'ics_checked', now), setMetaStmt(env, 'ics_error', null),
      setMetaStmt(env, 'ics_count', candidates.length),
      ...(writes.length ? [setMetaStmt(env, 'ics_changed', now)] : []),
    ]);
    return { changed: writes.length, candidates: candidates.length };
  } catch (err) {
    await env.DB.batch([setMetaStmt(env, 'ics_checked', now), setMetaStmt(env, 'ics_error', err.message)]);
    return { error: err.message };
  }
}

// ---------- Thông báo đẩy ----------

async function allSubs(env) {
  const { results } = await env.DB.prepare('SELECT endpoint, data FROM subs').all();
  return results.map((r) => ({ endpoint: r.endpoint, sub: JSON.parse(r.data) }));
}

/** Gửi một thông báo tới mọi thiết bị; xóa đăng ký đã hết hạn. */
async function broadcast(env, msg) {
  const subs = await allSubs(env);
  if (!subs.length) return { sent: 0, failed: 0 };
  const vapid = await getVapid(env);
  let sent = 0, failed = 0;
  for (const { endpoint, sub } of subs) {
    let status = 0;
    try { status = await sendPush(env, sub, msg, vapid); } catch (err) { console.error('push', err); }
    if (status >= 200 && status < 300) sent++;
    else {
      failed++;
      if (status === 404 || status === 410) await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?1').bind(endpoint).run();
      else console.warn('push status', status, new URL(endpoint).host);
    }
  }
  return { sent, failed };
}

async function sendDueReminders(env, now) {
  if (!(await env.DB.prepare('SELECT 1 FROM subs LIMIT 1').first())) return;
  const data = await loadData(env);
  const { results } = await env.DB.prepare('SELECT key FROM fired WHERE at > ?1').bind(now - 3 * 864e5).all();
  const fired = new Set(results.map((r) => r.key));
  const { due, list } = dueReminders(data, now, REMIND_WINDOW_MS, (k) => fired.has(k));
  if (!due.length) return;

  const mark = env.DB.prepare('INSERT OR IGNORE INTO fired (key, at) VALUES (?1, ?2)');
  await env.DB.batch(due.map((r) => mark.bind(r.key, now)));
  for (const r of list.slice(0, MAX_PUSH_PER_RUN)) await broadcast(env, { ...message(r, now), tag: r.key, url: './#today' });
  if (list.length > MAX_PUSH_PER_RUN) {
    await broadcast(env, { title: 'Lịch Học', body: `Còn ${list.length - MAX_PUSH_PER_RUN} lời nhắc khác, mở app để xem.`, tag: 'more', url: './#today' });
  }
}

// ---------- Cron ----------

async function cron(env, now) {
  const checked = Number(await getMeta(env, 'ics_checked')) || 0;
  if (env.ICAL_URL && now - checked >= ICS_EVERY_MS - 20e3) await syncIcs(env);
  await sendDueReminders(env, now);
  // Dọn dẹp mỗi ngày lúc 03:00 (giờ VN = 20:00 UTC).
  const d = new Date(now);
  if (d.getUTCHours() === 20 && d.getUTCMinutes() === 0) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM fired WHERE at < ?1').bind(now - 7 * 864e5),
      env.DB.prepare('DELETE FROM docs WHERE deleted = 1 AND updated < ?1').bind(now - 180 * 864e5),
    ]);
  }
}

// ---------- Định tuyến ----------

async function route(req, env) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/api') return json({ name: 'Lịch Học API', ok: true });
  if (!(await authorized(req, env))) return json({ error: 'Không có quyền truy cập' }, 401);

  const m = req.method;
  if (path === '/api/info' && m === 'GET') {
    const docs = await env.DB.prepare('SELECT COUNT(*) AS n FROM docs WHERE deleted = 0').first();
    const subs = await env.DB.prepare('SELECT COUNT(*) AS n FROM subs').first();
    return json({ ok: true, docs: docs.n, subs: subs.n, rev: Number(await getMeta(env, 'rev')), ics: await icsStatus(env) });
  }
  if (path === '/api/sync' && m === 'POST') return handleSync(req, env);
  if (path === '/api/ics' && m === 'GET') {
    if (!env.ICAL_URL) return json({ error: 'Chưa cấu hình ICAL_URL' }, 400);
    return json({ text: await fetchIcs(env) });
  }
  if (path === '/api/ics/refresh' && m === 'POST') return json(await syncIcs(env, { force: true }));
  if (path === '/api/push/key' && m === 'GET') return json({ publicKey: (await getVapid(env)).publicKey });
  if (path === '/api/push/subscribe' && m === 'POST') {
    const { subscription, device } = await req.json().catch(() => ({}));
    if (!subscription?.endpoint || !/^https:\/\//.test(subscription.endpoint) || !subscription.keys?.p256dh || !subscription.keys?.auth) {
      return json({ error: 'Đăng ký không hợp lệ' }, 400);
    }
    await env.DB.prepare(`INSERT INTO subs (endpoint, data, device, created) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(endpoint) DO UPDATE SET data = excluded.data, device = excluded.device`)
      .bind(subscription.endpoint, JSON.stringify(subscription), String(device || '').slice(0, 40), Date.now()).run();
    return json({ ok: true });
  }
  if (path === '/api/push/subscribe' && m === 'DELETE') {
    const { endpoint } = await req.json().catch(() => ({}));
    if (endpoint) await env.DB.prepare('DELETE FROM subs WHERE endpoint = ?1').bind(endpoint).run();
    return json({ ok: true });
  }
  if (path === '/api/push/test' && m === 'POST') {
    return json(await broadcast(env, { title: 'Lịch Học', body: 'Thông báo thử từ máy chủ: nhắc việc đang hoạt động.', tag: 'test', url: './#settings' }));
  }
  return json({ error: 'Không tìm thấy' }, 404);
}

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env);
    } catch (err) {
      console.error(err);
      res = json({ error: 'Lỗi máy chủ' }, 500);
    }
    for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
    return res;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cron(env, event.scheduledTime || Date.now()));
  },
};
