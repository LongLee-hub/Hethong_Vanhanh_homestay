# LOCI Homestay Manager

Web app quản lý vận hành chuỗi homestay LOCI, xây theo tài liệu *"LOCI Homestay Manager – Đặc tả phát triển Web App"* (25/09/2026).

Gồm hai phần:

| Phần | Thư mục | Dùng để |
| --- | --- | --- |
| **Bản chạy thử** | `prototype/` → `dist/loci-homestay.html` | Duyệt nghiệp vụ ngay trên claude.ai, có dữ liệu mẫu, đổi vai trò để xem từng người thấy gì |
| **Bản chính thức** | `app/`, `lib/`, `drizzle/`, `jobs/` | Next.js + PostgreSQL, đăng nhập thật, phân quyền ở máy chủ, đồng bộ Dayladau hằng ngày |

Cả hai dùng chung một bộ công thức tính tiền: `lib/domain/`.

## Đã làm được

**Giai đoạn 1 – Nền tảng:** schema 23 bảng theo mục 4, migration SQL, đăng nhập bằng số điện thoại/email (phiên 30 ngày), 5 vai trò, hàm `allowedPropertyIds()` dùng ở mọi truy vấn.

**Giai đoạn 2 – Doanh thu và quyết toán:** phân bổ doanh thu theo đêm, đơn ngoài OTA (bắt buộc ảnh chuyển khoản, chặn trùng phòng), chi phí trực tiếp/chung, tạm tính chi phí chung, quyết toán 20% gộp theo NĐT, khóa/mở khóa sổ có lý do, điều chỉnh cho tháng đã khóa, hoàn vốn, dự kiến tháng hiện tại, job đồng bộ Dayladau.

**Giai đoạn 3–5 (một phần):** tổng quan theo vai trò, công việc + checklist + ảnh nghiệm thu + việc định kỳ + tự sinh việc dọn phòng, chấm công, cảnh báo công suất/quá hạn/đồng bộ lỗi gửi Lark.

**Chưa làm:** xuất PDF/Excel ở bản chính thức (bản chạy thử có CSV), lịch phòng dạng lưới và Kanban ở bản chính thức (đã có ở bản chạy thử — dùng làm mẫu giao diện), trang Quản trị (tạo NĐT/cơ sở/phòng/người dùng hiện làm qua SQL hoặc seed), báo cáo tuần/đặt phòng, nhập điểm đánh giá.

## Kiểm thử

```bash
npm test
```

41 test, gồm:

- **27 test công thức** (`tests/domain.test.ts`) — đủ checklist giai đoạn 2 của đặc tả: đơn 1 đêm, nhiều đêm, qua hai tháng, phần dư khi chia; đơn hủy, đổi ngày, đổi phòng; chi phí chung chia số phòng lẻ; NĐT một cơ sở lãi, hai cơ sở một lãi một lỗ, tổng lỗ; hoàn vốn khi trung bình 3 tháng âm; dự kiến ngày 1, giữa tháng, cuối tháng.
- **14 test tích hợp** (`tests/integration.test.ts`) chạy trên PostgreSQL nhúng với migration thật: NĐT A gọi thẳng API không đọc được số của NĐT B; khóa sổ chặn sửa chi phí; đồng bộ Dayladau giả lập tạo đơn, bỏ qua phòng chưa map, đơn đổi ngày lùi vào tháng đã khóa sinh đúng khoản điều chỉnh ở tháng kế tiếp; việc dọn phòng phải đủ checklist và ảnh mới hoàn thành.

## Chạy trên máy

Yêu cầu Node 20+ và một database PostgreSQL (khuyên dùng Supabase, gói miễn phí đủ cho 50 phòng).

```bash
npm install
cp .env.example .env          # điền các biến, xem chú thích trong file
npm run db:migrate            # tạo bảng
npm run db:seed               # tạo Admin (ADMIN_EMAIL / ADMIN_PASSWORD), loại chi phí, cài đặt mặc định
npm run dev                   # http://localhost:3000
```

## Triển khai (Vercel + Supabase)

1. Tạo project Supabase. Lấy connection string chế độ *Transaction pooler* làm `DATABASE_URL`. Tạo bucket Storage **private** tên `loci-photos`.
2. Đẩy mã nguồn lên GitHub, import vào Vercel, khai báo các biến trong `.env.example`.
3. `vercel.json` đã đặt 2 lịch: 06:00 giờ VN đồng bộ Dayladau + tính cảnh báo, 06:30 sinh việc dọn phòng.
4. Chạy `npm run db:migrate` và `npm run db:seed` một lần từ máy anh (trỏ `DATABASE_URL` vào Supabase).

## Kết nối Dayladau

Mỗi nhà đầu tư có **host ID** và **access token** riêng (giống `HOST_ID` / `ACCESS_TOKEN` trong script Apps Script).

**Bản chính thức** — menu *Kết nối Dayladau* (chỉ Admin):

1. Thêm nhà đầu tư: tên, host ID, access token. Token mã hóa AES-256-GCM khi lưu, chỉ hiện 4 ký tự cuối.
2. Bấm **Kiểm tra kết nối**: gọi trang đầu (100 đơn), liệt kê các listing, trạng thái đơn và 5 đơn mẫu để đối chiếu "Amount host".
3. Gắn từng listing với một phòng (hoặc tạo phòng mới ngay tại đó).
4. Bấm **Đồng bộ ngay**, hoặc chờ job 06:00 hằng ngày.

**Bản chạy thử** — Quản trị → *Đồng bộ Dayladau*: trang trên claude.ai không được gọi thẳng ra Dayladau, nên app tạo link API theo host ID + token, anh mở link, copy nội dung dán lại, app map và nhập đơn theo đúng quy tắc trên. Token lưu trong vùng riêng của tài khoản người nhập.

## Payout Airbnb từ Gmail

Trang **Payout Airbnb** đọc email "đã gửi khoản thanh toán" của Airbnb trong Gmail của từng nhà đầu tư, tách từng đơn trong email (mã HM…, ngày ở, số tiền) và đối soát với đơn trong hệ thống:

- **Khớp**: tìm thấy đơn và số tiền lệch không quá 2.000 ₫.
- **Lệch tiền**: tìm thấy đơn nhưng tiền Airbnb chuyển khác "thực nhận" đang ghi.
- **Chưa thấy đơn**: mã HM không có trong dữ liệu Dayladau và không khớp được theo tên khách + ngày nhận phòng.
- **Đơn chưa thấy payout**: đơn Airbnb đã nhận phòng quá 3 ngày mà chưa có trong email payout nào.

Ai làm gì: Admin kết nối Gmail cho mọi NĐT; NĐT tự kết nối Gmail của mình; Kế toán chỉ xem. App chỉ xin quyền **đọc** Gmail (`gmail.readonly`), refresh token mã hóa AES-256-GCM như token Dayladau. Email được đọc mỗi lần đồng bộ (cùng lịch với Dayladau), hoặc bấm **Đọc thư ngay**.

**Cài đặt Google (một lần):**

1. Google Cloud Console → tạo project → bật **Gmail API**.
2. *OAuth consent screen*: loại External, thêm scope `gmail.readonly`, thêm Gmail của các NĐT vào *Test users*.
3. *Credentials* → *OAuth client ID* loại Web application, redirect URI `https://<địa chỉ app>/api/gmail/callback`. Điền `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL` vào `.env`.
4. `npm run db:migrate` để tạo bảng mới.

> Lưu ý: khi app Google còn ở trạng thái *Testing*, refresh token hết hạn sau 7 ngày và hộp thư sẽ báo lỗi `invalid_grant`. Chuyển sang *In production* (không cần xác minh nếu dưới 100 người dùng, người dùng sẽ thấy cảnh báo "app chưa xác minh" khi đồng ý) để token không tự hết hạn.

**TODO(CONFIRM):** bộ tách email (`lib/airbnb/payout-parser.ts`) viết theo cấu trúc email payout phổ biến của Airbnb, cần đối chiếu với email thật. Email nào tách thiếu hiện nhãn "Tách được một phần"; sau khi sửa bộ tách, bấm **Tách lại** để xử lý lại từ nội dung đã lưu, không cần đọc lại Gmail.

## Việc cần anh xác nhận trước khi bật đồng bộ thật

Tất cả được đánh dấu `TODO(CONFIRM)` trong mã.

1. **Dayladau** — đã map theo script Apps Script (xem `lib/dayladau/mapping.md`). Cần xác nhận qua màn hình Kiểm tra kết nối: trạng thái nào là hủy, "Amount host" có khớp sheet, đơn thuê theo giờ ghi nhận thế nào.
2. **Tỷ lệ hoa hồng từng kênh** (chỉ dùng khi API không trả số tiền hoa hồng): đang để Airbnb 15%, Booking 15%, Agoda 18%.
3. **Phòng mở/đóng giữa tháng** chia chi phí chung cả tháng hay theo số ngày: đang tính cả tháng.
4. **Phí hủy** ghi vào đêm check-in: đang làm vậy.
5. **Hạn dọn phòng**: đang để 14:00 ngày check-out.

## Cấu trúc

```
lib/domain/        Công thức thuần (phân bổ đêm, chi phí chung, quyết toán, hoàn vốn, dự kiến, KPI)
lib/db/            Schema Drizzle; drizzle/ chứa migration SQL
lib/auth/          Phiên đăng nhập, allowedPropertyIds, bảng quyền theo vai trò
lib/services/      Ghi dữ liệu có kiểm tra quyền: đơn, chi phí, quyết toán, công việc, cảnh báo
lib/dayladau/      Client API, map trường, job đồng bộ
app/               Trang và route API (Next.js App Router)
jobs/              Chạy tay job đồng bộ / cảnh báo
prototype/         Mã nguồn bản chạy thử; npm run prototype:build → dist/loci-homestay.html
tests/             Vitest
```

Ghi chú kỹ thuật: đặc tả cho phép Prisma hoặc Drizzle; bản này dùng **Drizzle** vì thuần TypeScript, không cần tải engine riêng, và test được trên PostgreSQL nhúng. Tiền lưu `bigint` (VND), mọi phép tính dùng số nguyên, chỉ làm tròn khi hiển thị.
# Hethong_Vanhanh_homestay
