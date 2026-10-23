-- Cơ sở dữ liệu D1 của máy chủ Lịch Học.
-- Chạy: npx wrangler d1 execute lichhoc --remote --file schema.sql

-- Dữ liệu app: mỗi bản ghi (môn học, deadline, sự kiện, cài đặt) là một dòng JSON.
-- rev tăng dần theo mỗi lần ghi để thiết bị chỉ tải phần thay đổi.
CREATE TABLE IF NOT EXISTS docs (
  store   TEXT    NOT NULL,           -- courses | deadlines | events | settings
  id      TEXT    NOT NULL,
  data    TEXT,                       -- JSON, NULL nếu đã xóa
  updated INTEGER NOT NULL,           -- thời điểm sửa (epoch ms, do thiết bị đặt)
  deleted INTEGER NOT NULL DEFAULT 0,
  rev     INTEGER NOT NULL,
  PRIMARY KEY (store, id)
);
CREATE INDEX IF NOT EXISTS docs_rev ON docs (rev);

-- Giá trị lẻ: bộ đếm rev, khóa VAPID, trạng thái đọc lịch Google…
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('rev', '0');

-- Đăng ký nhận thông báo đẩy của từng thiết bị.
CREATE TABLE IF NOT EXISTS subs (
  endpoint TEXT PRIMARY KEY,
  data     TEXT    NOT NULL,          -- PushSubscription JSON
  device   TEXT,
  created  INTEGER NOT NULL
);

-- Lời nhắc đã gửi (tránh gửi trùng).
CREATE TABLE IF NOT EXISTS fired (
  key TEXT PRIMARY KEY,
  at  INTEGER NOT NULL
);
