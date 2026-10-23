# Lịch Học – PWA thời khóa biểu & deadline

HTML/CSS/JS thuần (ES modules), không framework, không build. Dữ liệu lưu IndexedDB, chạy offline.

## Cấu trúc

```
index.html          khung trang + thẻ meta iOS
manifest.json       cấu hình PWA
sw.js               service worker (cache file tĩnh) – tăng VERSION khi sửa file
css/styles.css      giao diện, chế độ tối, safe-area
icons/              icon PWA + apple-touch-icon
js/app.js           khởi động, điều hướng tab, nút +
js/db.js            IndexedDB (courses, deadlines, events, settings)
js/time.js          múi giờ Asia/Bangkok, định dạng dd/mm/yyyy, tuần bắt đầu Thứ Hai
js/schedule.js      tính lịch trong ngày, deadline sắp đến hạn
js/sample.js        dữ liệu mẫu + xóa dữ liệu mẫu
js/notify.js        nhắc việc: tính giờ nhắc, xin quyền, hiện thông báo
js/backup.js        xuất / nhập JSON (kiểm tra dữ liệu khi nhập)
js/ics.js           đọc file .ics / .zip của Google Calendar (lặp, múi giờ, buổi hủy / dời)
js/gcal-import.js   đoán loại, gộp môn LT/BT/TN, ghi dữ liệu nhập từ Google
js/ui/*.js          các màn hình (today, week, courses, deadlines, settings) và form (course, deadline, event)
```

## Chạy trên máy

```
py -m http.server 8000
```
(macOS/Linux: `python3 -m http.server 8000`) rồi mở http://localhost:8000

## Mở trên iPhone

- Cùng Wi-Fi: mở `http://<IP-máy-tính>:8000` (xem IP bằng `ipconfig`). Xem được giao diện và dữ liệu,
  nhưng **không có service worker / offline** vì không phải HTTPS.
- Bản đầy đủ (offline, Thêm vào MH chính): cần HTTPS, ví dụ `cloudflared tunnel --url http://localhost:8000`
  hoặc đưa thư mục lên GitHub Pages / Netlify.

## Nhắc việc trên iPhone

- Cần iOS 16.4+, app phải được **Thêm vào MH chính** và mở từ icon, qua HTTPS.
- Web app không thể tự hẹn giờ khi đã bị tắt hẳn (cần máy chủ Web Push). Lời nhắc chạy khi app đang mở /
  còn chạy nền; mở lại app sẽ nhắc bù các lời nhắc bị lỡ trong 6 giờ gần nhất.
- Chưa có quyền thông báo → lời nhắc hiện dạng banner bên trong app.

## Nhập từ Google Calendar

Cài đặt → Google Calendar → chọn file `.ics` hoặc `.zip` (Google Calendar → Cài đặt → Nhập và xuất → Xuất).
Đồng bộ một chiều: nhập lại để cập nhật, app giữ màu / giảng viên / nhắc việc đã đặt và xóa mục không còn trên Google.
Hỗ trợ lặp hằng ngày / hằng tuần (kể cả N tuần/lần, UNTIL, COUNT), buổi bị hủy (EXDATE) và buổi bị dời (RECURRENCE-ID).
Chưa hỗ trợ sự kiện cả ngày và lặp theo tháng / năm.

## Máy chủ đồng bộ (tùy chọn)

Thư mục `server/` là một Cloudflare Worker miễn phí: đồng bộ dữ liệu giữa các thiết bị, tự đọc lịch Google
(link iCal bí mật) mỗi 5 phút, và gửi nhắc việc bằng Web Push kể cả khi app đã tắt.
Cách triển khai: xem [server/README.md](server/README.md). App vẫn chạy bình thường khi không có máy chủ.
