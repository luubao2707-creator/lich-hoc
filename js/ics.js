// Đọc file iCalendar (.ics) – định dạng Google Calendar xuất ra – và file .zip chứa nhiều .ics.
// Kết quả là danh sách "ứng viên" (chuỗi lặp hoặc sự kiện một lần) đã đổi sang giờ Việt Nam.

import { dateKey, timeOf, addDays, weekdayOf, todayKey, diffDays } from './time.js';

const BKK_OFFSET = 7 * 3600e3;
const PAST_DAYS = 14;     // bỏ sự kiện một lần / chuỗi đã kết thúc quá 14 ngày
const MAX_SCAN_DAYS = 3660;

// ---------- Giải nén .zip (Google xuất "Lịch Google.zip") ----------

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Trả về [{ name, text }] cho mọi file .ics trong zip. */
async function unzipIcs(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  // Tìm "End of central directory" ở cuối file.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('File .zip bị hỏng.');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.ics$/i.test(name)) continue;
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + size);
    if (method === 0) out.push({ name, text: dec.decode(raw) });
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Trình duyệt chưa hỗ trợ giải nén .zip – hãy giải nén rồi chọn file .ics.');
      out.push({ name, text: dec.decode(await inflateRaw(raw)) });
    }
  }
  if (!out.length) throw new Error('Trong file .zip không có file .ics nào.');
  return out;
}

/** Đọc các File người dùng chọn (.ics hoặc .zip) → [{ name, text }]. */
export async function readCalendarFiles(files) {
  const out = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (head[0] === 0x50 && head[1] === 0x4b) out.push(...await unzipIcs(buf));
    else out.push({ name: f.name, text: new TextDecoder().decode(buf) });
  }
  return out;
}

// ---------- Phân tích cú pháp iCalendar ----------

function unescapeText(v) {
  return v.replace(/\\([nN,;\\])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Trả về { calName, events: [{ PROP: { value, params } | [..] }] } */
export function parseIcs(text) {
  const lines = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let calName = '';
  let cur = null;
  let depth = 0; // lồng VALARM… bên trong VEVENT
  for (const line of lines) {
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') { cur = {}; depth = 0; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (cur && line.startsWith('BEGIN:')) { depth++; continue; }
    if (cur && line.startsWith('END:')) { depth--; continue; }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    if (!cur) { if (name === 'X-WR-CALNAME') calName = unescapeText(value); continue; }
    if (depth > 0) continue;
    const params = {};
    for (const pp of paramParts) {
      const eq = pp.indexOf('=');
      if (eq > 0) params[pp.slice(0, eq).toUpperCase()] = pp.slice(eq + 1).replace(/^"|"$/g, '');
    }
    const prop = { value, params };
    const key = name.toUpperCase();
    if (key === 'EXDATE') (cur.EXDATE ||= []).push(prop);
    else cur[key] = prop;
  }
  return { calName, events };
}

// ---------- Ngày giờ & múi giờ ----------

function tzOffsetMs(tz, utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const g = (t) => +parts.find((p) => p.type === t).value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs;
}

/** "20260831T082500" theo múi giờ tz → epoch ms. */
function wallToEpoch(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  if (!tz) return guess - BKK_OFFSET; // giờ "thả nổi" → coi là giờ Việt Nam
  try {
    const first = guess - tzOffsetMs(tz, guess);
    return guess - tzOffsetMs(tz, first);
  } catch {
    return guess - BKK_OFFSET; // TZID lạ → coi như UTC+7
  }
}

/** Một giá trị DTSTART/DTEND/EXDATE → { allDay, key, time, ms } theo giờ Việt Nam. */
function parseDateValue(raw, params = {}) {
  const v = raw.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || params.VALUE === 'DATE') {
    return { allDay: true, key: `${y}-${mo}-${d}`, time: null, ms: Date.UTC(+y, +mo - 1, +d) - BKK_OFFSET };
  }
  const ms = z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) : wallToEpoch(+y, +mo, +d, +h, +mi, +(s || 0), params.TZID);
  return { allDay: false, key: dateKey(ms), time: timeOf(ms), ms };
}

function parseDuration(v) {
  const m = v?.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms = ((+w || 0) * 7 * 86400 + (+d || 0) * 86400 + (+h || 0) * 3600 + (+mi || 0) * 60 + (+s || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

const ICS_DAYS = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

function parseRrule(v) {
  const r = Object.fromEntries(v.split(';').map((kv) => kv.split('=')));
  return r;
}

// ---------- Lọc nhanh ----------

/**
 * Bỏ các VEVENT chắc chắn đã qua trước khi phân tích kỹ (file Google chứa cả lịch sử nhiều năm;
 * máy chủ Cloudflare gói miễn phí chỉ có ~10 ms CPU mỗi lần chạy).
 * Chỉ dùng thao tác chuỗi nhanh; trường hợp không chắc thì giữ lại.
 */
function prefilter(text, cutoffKey, skipped) {
  const cutoff = cutoffKey.replace(/-/g, '');
  const parts = text.split('BEGIN:VEVENT');
  const kept = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const start = /\nDTSTART[^:\n]*:(\d{8})/.exec(chunk)?.[1];
    let old = false;
    if (chunk.includes('\nRRULE:')) {
      const until = /UNTIL=(\d{8})/.exec(chunk)?.[1];
      old = !!until && until < cutoff && !/COUNT=/.test(chunk);
    } else if (start && start < cutoff) {
      const recId = /\nRECURRENCE-ID[^:\n]*:(\d{8})/.exec(chunk)?.[1];
      old = !recId || recId < cutoff;
    }
    if (old) skipped.past++;
    else kept.push(chunk);
  }
  return kept.join('BEGIN:VEVENT');
}

// ---------- Dựng danh sách ứng viên ----------

/**
 * Từ nhiều file đã đọc → { candidates, skipped: { allDay, past, unsupported, cancelled } }.
 * candidate = { uid, calendar, title, location, start, end, kind: 'series'|'once', rec?, date? }
 */
export function buildCandidates(files, today = todayKey()) {
  const skipped = { allDay: 0, past: 0, unsupported: 0, cancelled: 0 };
  const candidates = [];
  const cutoff = addDays(today, -PAST_DAYS);

  for (const file of files) {
    const { calName, events } = parseIcs(prefilter(file.text.replace(/\r\n?/g, '\n'), cutoff, skipped));
    const calendar = calName || file.name.replace(/\.ics$/i, '').replace(/^.*\//, '');
    const masters = new Map();
    const overrides = [];
    const singles = [];

    for (const ev of events) {
      const uid = ev.UID?.value;
      const dt = ev.DTSTART && parseDateValue(ev.DTSTART.value, ev.DTSTART.params);
      if (!uid || !dt) continue;
      if (ev['RECURRENCE-ID']) { overrides.push({ ev, uid, dt }); continue; }
      if (ev.STATUS?.value === 'CANCELLED') { skipped.cancelled++; continue; }
      if (dt.allDay) { skipped.allDay++; continue; }
      (ev.RRULE ? masters.set(uid, { ev, dt }) : singles.push({ ev, uid, dt }));
    }

    const timesOf = (ev, dt) => {
      let endMs = ev.DTEND ? parseDateValue(ev.DTEND.value, ev.DTEND.params)?.ms : null;
      if (endMs == null) endMs = dt.ms + (parseDuration(ev.DURATION?.value) ?? 3600e3);
      // Sự kiện kéo qua nửa đêm: cắt ở 23:59 của ngày bắt đầu.
      const end = dateKey(endMs) !== dt.key || endMs <= dt.ms ? '23:59' : timeOf(endMs);
      return { start: dt.time, end };
    };
    const text = (ev, k) => (ev[k] ? unescapeText(ev[k].value).trim() : '');

    // Chuỗi lặp
    const series = new Map();
    for (const [uid, { ev, dt }] of masters) {
      const r = parseRrule(ev.RRULE.value);
      if (r.FREQ !== 'WEEKLY' && r.FREQ !== 'DAILY') { skipped.unsupported++; continue; }
      const interval = Math.max(1, parseInt(r.INTERVAL, 10) || 1);
      let byday = r.BYDAY ? r.BYDAY.split(',').map((d) => ICS_DAYS[d.slice(-2)]).filter(Boolean) : [weekdayOf(dt.key)];
      let freq = r.FREQ;
      if (freq === 'DAILY' && interval === 1) { freq = 'WEEKLY'; byday = [1, 2, 3, 4, 5, 6, 7]; }
      const rec = {
        freq, interval, byday: [...new Set(byday)].sort(), wkst: r.WKST === 'SU' ? 7 : 1,
        start: dt.key, until: null, exdates: [], extra: [],
      };
      if (r.UNTIL) rec.until = parseDateValue(r.UNTIL)?.key ?? null;
      for (const ex of ev.EXDATE || []) {
        for (const one of ex.value.split(',')) {
          const p = parseDateValue(one, ex.params);
          if (p) rec.exdates.push(p.key);
        }
      }
      series.set(uid, { uid, calendar, title: text(ev, 'SUMMARY') || '(Không tên)', location: text(ev, 'LOCATION'),
        ...timesOf(ev, dt), kind: 'series', rec, count: parseInt(r.COUNT, 10) || 0 });
    }

    // Buổi bị dời / hủy (RECURRENCE-ID)
    for (const { ev, uid, dt } of overrides) {
      const s = series.get(uid);
      const orig = parseDateValue(ev['RECURRENCE-ID'].value, ev['RECURRENCE-ID'].params);
      if (!s || !orig) { // không có chuỗi gốc → coi như sự kiện một lần
        if (ev.STATUS?.value !== 'CANCELLED' && !dt.allDay) singles.push({ ev, uid: `${uid}/${orig?.key || dt.key}`, dt });
        continue;
      }
      s.rec.exdates.push(orig.key);
      if (ev.STATUS?.value !== 'CANCELLED' && !dt.allDay) {
        const t = timesOf(ev, dt);
        const sameAsUsual = dt.key === orig.key && t.start === s.start && t.end === s.end && text(ev, 'LOCATION') === s.location;
        if (sameAsUsual) s.rec.exdates.pop(); // chỉ sửa ghi chú… → giữ nguyên buổi gốc
        else s.rec.extra.push({ date: dt.key, start: t.start, end: t.end, location: text(ev, 'LOCATION') });
      }
    }

    for (const s of series.values()) {
      if (s.count) s.rec.until = untilFromCount(s.rec, s.count);
      delete s.count;
      s.rec.exdates = [...new Set(s.rec.exdates)].sort();
      s.rec.extra = s.rec.extra.filter((x) => x.date >= cutoff);
      const lastDay = s.rec.extra.reduce((m, x) => (x.date > m ? x.date : m), s.rec.until || '9999-12-31');
      if (lastDay < cutoff) { skipped.past++; continue; }
      candidates.push(s);
    }

    for (const { ev, uid, dt } of singles) {
      if (dt.key < cutoff) { skipped.past++; continue; }
      candidates.push({ uid, calendar, title: text(ev, 'SUMMARY') || '(Không tên)', location: text(ev, 'LOCATION'),
        ...timesOf(ev, dt), kind: 'once', date: dt.key });
    }
  }
  return { candidates, skipped };
}

/** COUNT=n → ngày của lần lặp thứ n (EXDATE không làm giảm số lần theo chuẩn iCalendar). */
function untilFromCount(rec, count) {
  const probe = { ...rec, until: null, exdates: [] };
  let n = 0;
  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const key = addDays(rec.start, i);
    if (occursRaw(probe, key) && ++n === count) return key;
  }
  return null;
}

function occursRaw(rec, key) {
  if (rec.freq === 'DAILY') return diffDays(key, rec.start) % rec.interval === 0;
  if (!rec.byday.includes(weekdayOf(key))) return false;
  const ws = (k) => (rec.wkst === 7 ? addDays(k, -(weekdayOf(k) % 7)) : addDays(k, 1 - weekdayOf(k)));
  return (diffDays(ws(key), ws(rec.start)) / 7) % rec.interval === 0;
}
