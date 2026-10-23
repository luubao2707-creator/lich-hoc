# Máy chủ đồng bộ Lịch Học (Cloudflare Worker + D1)

Máy chủ riêng, chỉ một người dùng, chạy miễn phí trên Cloudflare:

- Đồng bộ dữ liệu app (môn học, deadline, sự kiện, cài đặt) giữa các thiết bị – bản sửa sau cùng thắng.
- Mỗi 5 phút tự đọc **link iCal bí mật** của Google Calendar và cập nhật môn học / sự kiện
  (dùng chung code với app: `js/ics.js`, `js/gcal-plan.js`).
- Mỗi phút gửi lời nhắc tới hạn bằng **Web Push** – nhận được cả khi app đã tắt
  (iPhone: iOS 16.4+, app phải được thêm vào Màn hình chính).

Không cần Google Cloud. Dữ liệu nằm trong tài khoản Cloudflare của bạn.

## Triển khai (một lần)

Cần Node.js. Mọi lệnh chạy trong thư mục `server/`.

```bash
cd server
npx wrangler@4 login                       # mở trình duyệt, đăng nhập Cloudflare
npx wrangler@4 d1 create lichhoc           # in ra database_id → dán vào wrangler.toml
npx wrangler@4 d1 execute lichhoc --remote --file schema.sql
npx wrangler@4 secret put APP_TOKEN        # tự đặt một mật khẩu dài (≥ 20 ký tự)
npx wrangler@4 secret put ICAL_URL         # dán "Địa chỉ bí mật ở định dạng iCal"
npx wrangler@4 deploy                      # in ra địa chỉ https://lichhoc-api.<tên>.workers.dev
```

Lấy link iCal bí mật: calendar.google.com (máy tính) → ⚙ Cài đặt → chọn lịch của bạn ở cột trái →
**Tích hợp lịch** → **Địa chỉ bí mật ở định dạng iCal**. Không chia sẻ link này.

Sau đó trong app: **Cài đặt → Máy chủ đồng bộ → Kết nối máy chủ**, nhập địa chỉ và APP_TOKEN.
Trên iPhone (app ở Màn hình chính): kết nối xong bấm **Bật nhắc việc qua máy chủ**.

## Cập nhật máy chủ

```bash
cd server && npx wrangler@4 deploy
```

## Chạy thử trên máy

```bash
cd server
printf 'APP_TOKEN=local-test-token\nICAL_URL=https://…\n' > .dev.vars   # file này đã được .gitignore
npx wrangler@4 d1 execute lichhoc --local --file schema.sql
npx wrangler@4 dev --local --test-scheduled --port 8787
# Kích hoạt cron: http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*
```

## Ghi chú

- Gói miễn phí của Workers giới hạn khoảng 10 ms CPU mỗi lần chạy. Máy chủ chỉ phân tích lịch khi nội dung
  thay đổi và lọc bỏ sự kiện cũ trước, nhưng nếu lịch rất lớn có thể thỉnh thoảng bị lỗi vượt CPU
  (xem: `npx wrangler@4 tail`). Khi đó lần đọc 5 phút sau sẽ thử lại.
- Thêm trang web được phép gọi API: sửa `ALLOWED_ORIGINS` trong `wrangler.toml` rồi deploy lại.
- Đổi mật khẩu: `npx wrangler@4 secret put APP_TOKEN`, rồi kết nối lại trên từng thiết bị.
