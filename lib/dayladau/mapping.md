# Map order Dayladau → Booking

Nguồn: script Apps Script `dayLaDauMoiv1` đang chạy của LOCI.

API: `GET https://api.dayladau.com/v1/hosts/{host_id}/orders?offset={n}&limit=100&x_access_token={token}` → `{ "orders": [...] }`.
Phân trang: tăng offset 100 đến khi trang trả ít hơn 100 đơn. Bỏ trùng theo `id`.

| Trường Booking | Trường order | Ghi chú |
| --- | --- | --- |
| externalId | `id` | Khóa upsert |
| phòng | `listing.id` (không có thì `listing.name`) → `rooms.dayladau_room_id`, duy nhất trong một tài khoản (`rooms.dayladau_account_id`) | Gắn ở màn hình Kết nối Dayladau; chưa gắn thì bỏ qua đơn và cảnh báo |
| guestName | `guest.fullname` | SĐT khách không lưu thành cột riêng |
| checkIn / checkOut | `reservation.start_time` / `end_time` | Đổi về ngày giờ Việt Nam. Thuê theo giờ trong ngày → 1 đêm tại ngày nhận phòng (TODO(CONFIRM)) |
| grossAmount | `total_billed` | Khách trả |
| netAmount | Σ `items[].amount × commission_rates[type=host].rate` | Giống cột "Amount host" trong sheet |
| commissionAmount | `total_billed − Amount host` | Không có `commission_rates` → dùng tỷ lệ cấu hình theo kênh |
| status | `status` | Chứa cancel/refund/reject/declin/expire/fail → hủy, doanh thu 0 (TODO(CONFIRM) qua màn hình Kiểm tra kết nối) |
| bookedAt | `created_at` | Nếu API không có trường này thì lead time để trống |
| rawPayload | toàn bộ order | Để tính lại khi đổi cách map |
