// Xử lý thời gian theo múi giờ Asia/Bangkok (UTC+7, không có giờ mùa hè).
// Vì offset cố định, ta tự tính thay vì phụ thuộc múi giờ của thiết bị:
// mọi "ngày" trong app là chuỗi 'YYYY-MM-DD' theo giờ Bangkok,
// mọi thời điểm cụ thể (hạn nộp...) lưu dưới dạng epoch ms.

const OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const WEEKDAY_LONG = ['', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy', 'Chủ Nhật'];
export const WEEKDAY_SHORT = ['', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

const pad = (n) => String(n).padStart(2, '0');

/** Date "giả" có các trường UTC trùng với giờ đồng hồ ở Bangkok. */
function wall(ms) { return new Date(ms + OFFSET_MS); }

function keyFromWall(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function keyToUTC(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** 'YYYY-MM-DD' của hôm nay (hoặc của thời điểm ms) theo giờ Bangkok. */
export function dateKey(ms = Date.now()) { return keyFromWall(wall(ms)); }
export const todayKey = () => dateKey();

/** 'HH:mm' của thời điểm ms theo giờ Bangkok. */
export function timeOf(ms) {
  const d = wall(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Epoch ms của ngày key + giờ 'HH:mm' (giờ Bangkok). */
export function epochOf(key, hhmm = '00:00') {
  const [h, mi] = hhmm.split(':').map(Number);
  return keyToUTC(key) + (h * 60 + mi) * 60000 - OFFSET_MS;
}

export function addDays(key, n) { return keyFromWall(new Date(keyToUTC(key) + n * DAY_MS)); }

export function diffDays(a, b) { return Math.round((keyToUTC(a) - keyToUTC(b)) / DAY_MS); }

/** 1 = Thứ Hai … 7 = Chủ Nhật */
export function weekdayOf(key) {
  const d = new Date(keyToUTC(key)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function mondayOf(key) { return addDays(key, 1 - weekdayOf(key)); }

/** Số thứ tự tuần học (tuần 1 bắt đầu từ semesterStart). Có thể ≤ 0 nếu chưa vào học kỳ. */
export function weekNumber(key, semesterStart) {
  return Math.floor(diffDays(mondayOf(key), mondayOf(semesterStart)) / 7) + 1;
}

export function minutesOf(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// ---------- Định dạng kiểu Việt Nam ----------

export function fmtDate(key, { year = true } = {}) {
  const [y, m, d] = key.split('-');
  return year ? `${d}/${m}/${y}` : `${d}/${m}`;
}

export function fmtDateLong(key) { return `${WEEKDAY_LONG[weekdayOf(key)]}, ${fmtDate(key)}`; }

/** Khoảng thời gian: "25 phút", "2 giờ 10 phút", "3 ngày 4 giờ". */
export function fmtDuration(ms) {
  let min = Math.max(1, Math.ceil(Math.abs(ms) / 60000));
  if (min < 60) return `${min} phút`;
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d > 0) return h ? `${d} ngày ${h} giờ` : `${d} ngày`;
  return m ? `${h} giờ ${m} phút` : `${h} giờ`;
}

/** Hạn nộp dễ đọc: "Hôm nay 23:59", "Ngày mai 12:00", "T7, 24/10 · 17:00". */
export function fmtDue(ms, now = Date.now()) {
  const key = dateKey(ms);
  const today = dateKey(now);
  const t = timeOf(ms);
  const dd = diffDays(key, today);
  if (dd === 0) return `Hôm nay ${t}`;
  if (dd === 1) return `Ngày mai ${t}`;
  if (dd === -1) return `Hôm qua ${t}`;
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return `${WEEKDAY_SHORT[weekdayOf(key)]}, ${fmtDate(key, { year: !sameYear })} · ${t}`;
}
