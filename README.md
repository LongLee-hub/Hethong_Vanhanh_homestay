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

## Triển khai server riêng (VPS)

App chạy trên VPS Ubuntu bằng PM2, Caddy đứng trước lo HTTPS. Cơ sở dữ liệu và ảnh vẫn ở Supabase như cũ. Lịch đồng bộ không cần `vercel.json`: `lib/scheduler.ts` tự chạy đồng bộ Dayladau + cảnh báo + sinh việc dọn phòng mỗi 30 phút (đổi bằng `AUTO_SYNC_MINUTES`).

**Chuẩn bị**

- VPS Ubuntu 22.04/24.04, tối thiểu 1 vCPU, **2GB RAM** (bước build Next.js cần ~1.5GB). Chọn vùng Singapore hoặc Việt Nam, gần Supabase để trang tải nhanh.
- Một tên miền (ví dụ `app.tenmien.vn`), tạo bản ghi **A** trỏ về IP của VPS.
- Repo GitHub đang để private thì cần cấp quyền đọc cho VPS (deploy key hoặc personal access token).

**Cài lần đầu** (SSH vào VPS bằng root):

```bash
curl -fsSLO https://raw.githubusercontent.com/LongLee-hub/Hethong_Vanhanh_homestay/main/deploy/setup-vps.sh
bash setup-vps.sh app.tenmien.vn
```

Script cài Node.js 22, PM2, Caddy, bật tường lửa (chỉ mở 22/80/443), tạo người dùng `loci` và tải mã nguồn về `/home/loci/app`.

Tạo file `.env` rồi chạy bản đầu tiên:

```bash
sudo -u loci cp /home/loci/app/.env.example /home/loci/app/.env
sudo -u loci nano /home/loci/app/.env     # điền giống biến môi trường trên Vercel
sudo -u loci bash /home/loci/app/deploy/deploy.sh
```

Mở `https://app.tenmien.vn` để kiểm tra. Lần đầu Caddy cần vài giây để xin chứng chỉ HTTPS.

**Cập nhật bản mới** (sau khi đẩy mã lên GitHub):

```bash
sudo -u loci bash /home/loci/app/deploy/deploy.sh
```

**Xem log / khởi động lại**

```bash
sudo -u loci pm2 logs loci        # có dòng [auto-sync] mỗi lần đồng bộ
sudo -u loci pm2 restart loci
```

Ghi chú:

- PM2 chỉ chạy **1 tiến trình** (`deploy/ecosystem.config.cjs`). Đừng đổi sang cluster mode, mỗi tiến trình sẽ tự đồng bộ riêng.
- `CRON_SECRET` vẫn cần nếu muốn gọi `/api/cron/sync` từ ngoài; nút "Đồng bộ ngay" của Admin không cần.
- Server chạy liên tục nên có thể dùng chuỗi kết nối *Session pooler* (cổng 5432) của Supabase thay cho *Transaction pooler* (6543).
- Khi đã chạy ổn trên VPS, xóa project trên Vercel để không chạy hai nơi cùng đồng bộ.

## Kết nối Dayladau

Mỗi nhà đầu tư có **host ID** và **access token** riêng (giống `HOST_ID` / `ACCESS_TOKEN` trong script Apps Script).

**Bản chính thức** — menu *Kết nối Dayladau* (chỉ Admin):

1. Thêm nhà đầu tư: tên, host ID, access token. Token mã hóa AES-256-GCM khi lưu, chỉ hiện 4 ký tự cuối.
2. Bấm **Kiểm tra kết nối**: gọi trang đầu (100 đơn), liệt kê các listing, trạng thái đơn và 5 đơn mẫu để đối chiếu "Amount host".
3. Gắn từng listing với một phòng (hoặc tạo phòng mới ngay tại đó).
4. Bấm **Đồng bộ ngay**, hoặc chờ job 06:00 hằng ngày.

**Bản chạy thử** — Quản trị → *Đồng bộ Dayladau*: trang trên claude.ai không được gọi thẳng ra Dayladau, nên app tạo link API theo host ID + token, anh mở link, copy nội dung dán lại, app map và nhập đơn theo đúng quy tắc trên. Token lưu trong vùng riêng của tài khoản người nhập.

## Payout Airbnb từ Gmail

Trang **Payout Airbnb** đọc email "Tổng số tiền đã chi trả" của Airbnb (từ automated@airbnb.com) trong Gmail của từng nhà đầu tư. Bộ tách viết theo Apps Script *Airbnb Payout Email Importer v2* LOCI đang dùng (`lib/airbnb/payout-parser.ts`):

- Đọc phần "Chi tiết": mỗi dòng giao dịch có khách, số tiền USD, loại (Tiền phòng, Thuế TNCN, Thuế VAT, Phí dọn dẹp), ngày ở, listing + Listing ID, mã đặt phòng.
- VNĐ từng dòng = USD × tỷ giá của chính email (tổng VNĐ ÷ tổng USD); phần dư làm tròn dồn vào dòng lớn nhất nên tổng khớp đúng số tiền email.
- Ngày d/M hay M/d đoán theo đúng quy tắc của script; chống trùng theo ID email và "Mã khoản chi trả".

Hai cách xem:

- **Theo lần chuyển tiền** — mỗi email một nhóm, các dòng gộp theo đơn. Đối soát cả đơn (cộng mọi email): tiền Airbnb đã chuyển sau thuế so với "thực nhận" trong hệ thống (Dayladau "Amount host" đã trừ hết thuế phí). **Khớp** khi lệch không quá 3% (chênh tỷ giá) hoặc 2.000 ₫; **Lệch tiền**; **Chưa thấy đơn** khi không khớp được theo mã đặt phòng hay tên khách + ngày nhận phòng. Kèm danh sách đơn Airbnb đã nhận phòng quá 3 ngày mà chưa có payout.
- **Theo tháng ở** — như sheet "Báo cáo tháng": gộp theo mã đặt phòng, đơn trải nhiều tháng chia theo số đêm, phần cuối nhận phần dư; tách trước thuế / thuế / thực nhận.

**Đọc email cũ:** lần kết nối đầu app tự đọc lùi 180 ngày; sau đó mỗi lần đồng bộ chỉ đọc email mới. Muốn ghi lại các đơn cũ hơn, bấm **Đọc email cũ** ở dòng Gmail: chọn 50 / 100 / 200 email payout gần nhất, hoặc một khoảng ngày (đọc được cả email trên 180 ngày). Mỗi lần tối đa 300 email; email đã có được bỏ qua nên bấm lại không ghi trùng, và không làm đổi mốc đọc hằng ngày.

Ai làm gì: Admin kết nối Gmail cho mọi NĐT; NĐT tự kết nối Gmail của mình; Kế toán chỉ xem. App chỉ xin quyền **đọc** Gmail (`gmail.readonly`), refresh token mã hóa AES-256-GCM như token Dayladau. Email được đọc mỗi lần đồng bộ (cùng lịch với Dayladau), hoặc bấm **Đọc thư ngay**.

**Cài đặt Google (một lần, ngay trên web):** chạy `npm run db:migrate` để tạo bảng mới, rồi Admin vào *Payout Airbnb* → *Cài đặt kết nối Google* ở cuối trang. Mục này hướng dẫn từng bước trên Google Cloud Console (bật Gmail API, chuyển app sang *In production*, tạo OAuth client), hiện sẵn redirect URI để copy, và có form dán Client ID / Client Secret. Secret được mã hóa khi lưu.

Nếu đặt `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL` trong `.env` thì các giá trị đó được ưu tiên và ô tương ứng trên web bị khóa.

> Lưu ý: khi app Google còn ở trạng thái *Testing*, refresh token hết hạn sau 7 ngày và hộp thư sẽ báo lỗi `invalid_grant`. Chuyển sang *In production* (dưới 100 người dùng thì không cần xác minh, người dùng sẽ thấy cảnh báo "app chưa xác minh" khi đồng ý).

**Dán email payout:** chưa kết nối Gmail vẫn đối soát được: mở email payout, copy toàn bộ nội dung dán vào mục *Dán email payout*, bấm *Xem trước* để thấy app tách được gì rồi *Lưu*. Email dán nhầm thì xóa được; email đọc từ Gmail thì không.

**TODO(CONFIRM):** mức chênh tỷ giá chấp nhận được (đang 3%). Email nào tách thiếu hiện nhãn "Tách được một phần"; sau khi sửa bộ tách, bấm **Tách lại** để xử lý lại từ nội dung đã lưu, không cần đọc lại Gmail.

## Chi phí: kê khai → chủ đầu tư duyệt → ghi nhận

- **Kế toán kê khai** (trang *Chi phí*) → khoản chi ở trạng thái **Chờ duyệt**, chưa tính vào lãi lỗ, quyết toán, báo cáo NĐT.
- App gửi tin vào **nhóm chat Lark có chủ nhà** kèm nút mở thẳng trang duyệt (`/expenses/<id>`; nhiều khoản thì `/expenses/pending`). Chưa đăng nhập thì đăng nhập xong quay lại đúng trang đó.
  Đặt webhook của nhóm ở *Kết nối Dayladau → Sửa thông tin NĐT → Nhóm chat duyệt chi phí* (trong nhóm Lark: Cài đặt → Bot → Custom Bot). Chưa đặt thì gửi nhóm Lark chung (`larkWebhookUrl`). Chi phí chung luôn gửi nhóm chung để Admin duyệt.
  Link dựng theo `APP_URL` (hoặc cài đặt `appUrl`) — trên VPS sau nginx cần đặt biến này.
- **Chủ đầu tư bấm "Duyệt & xác nhận đã chi"** → khoản chi chuyển *Đã duyệt + Đã chi* và được ghi nhận. Có thể **Từ chối** kèm lý do; kế toán sửa lại là tự gửi duyệt lại.
- Chi phí chung (toàn hệ thống) do **Admin** duyệt; Admin tự kê khai chi phí chung thì ghi nhận luôn. Không *Hoàn tất kê khai* được khi còn chi phí chung chưa duyệt.
- **Sửa / xóa:** Admin sửa xóa mọi khoản (khoản đã duyệt giữ nguyên trạng thái; đổi sang cơ sở khác thì phải duyệt lại). Kế toán chỉ sửa xóa khoản chưa duyệt. Tháng đã khóa sổ thì không ai sửa/duyệt được — mở khóa sổ trước.
- Chi phí nhập trước khi có bước duyệt được coi là đã duyệt (migration `0008`).

## Sao kê ngân hàng

Trang *Chi phí → Sao kê ngân hàng* (Admin, Kế toán): tải file Excel sao kê MB Bank → app đọc các giao dịch (chống trùng theo số bút toán, tải chồng kỳ không sao), đối chiếu với dòng *TỔNG TIỀN* của file.
Mỗi khoản **tiền ra** được gợi ý sẵn:

- **Cơ sở** theo mã viết tắt trong nội dung chuyển khoản (`khd-vp-…` → Vạn Phúc). Đặt mã ở *Cơ sở & phòng → Sửa thông tin → Mã trên sao kê*. `coso` = chi phí chung. Nội dung có hai mã thì để kế toán chọn. Hóa đơn điện nước không có mã thì học theo mã khách hàng đã ghi nhận lần trước.
- **Loại** theo từ khóa (lương, BHXH, điện/nước, internet/netflix, amenities/nước giặt, sửa chữa…), không có thì theo người nhận lần trước.
- **Tháng hạch toán** = tháng trả tiền (ngày hạch toán trên sao kê): lương t9 trả đầu tháng 10 → tháng 10. Kế toán vẫn sửa tay được trước khi ghi nhận.

Kế toán chỉnh, chọn dòng rồi **Ghi nhận & gửi duyệt**: mỗi dòng thành một khoản chi *Đã chi* nhưng vẫn *Chờ duyệt* như kê khai tay. Dòng không phải chi phí (chuyển nhầm, hoàn tiền) bấm *Không phải chi phí*. Xóa khoản chi thì dòng sao kê trở lại chưa phân loại.
Chỉ đọc file `.xlsx`; file `.xls` cũ mở bằng Excel lưu lại dạng `.xlsx`.

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
