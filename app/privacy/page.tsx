import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";

export const metadata: Metadata = { title: "Chính sách quyền riêng tư · baocaodau.com", description: "Cách baocaodau.com thu thập, dùng và bảo vệ dữ liệu, gồm dữ liệu Gmail" };

// Trang công khai cho màn hình đồng ý Google OAuth. Nội dung phải khớp đúng cách app dùng gmail.readonly (lib/airbnb/payouts.ts).
const CONTACT = process.env.LEGAL_CONTACT_EMAIL;
const UPDATED = "22/10/2026";

export default function PrivacyPage() {
  return (
    <main className="legal panel">
      <Link href="/login" aria-label="baocaodau.com" className="legal-logo"><Logo size={40} tld /></Link>
      <h1>Chính sách quyền riêng tư</h1>
      <p className="meta">Cập nhật lần cuối: {UPDATED}</p>

      <p>baocaodau.com (“ứng dụng”) là hệ thống nội bộ để vận hành chuỗi homestay LOCI: quản lý đơn đặt phòng, công việc dọn phòng, chi phí và quyết toán cho nhà đầu tư. Ứng dụng chỉ dành cho nhân viên, đối tác và nhà đầu tư được LOCI cấp tài khoản.</p>

      <h2>1. Dữ liệu chúng tôi thu thập</h2>
      <ul>
        <li><b>Thông tin tài khoản:</b> họ tên, số điện thoại, email, vai trò và mật khẩu (lưu dạng băm, không lưu bản gốc).</li>
        <li><b>Dữ liệu vận hành:</b> đơn đặt phòng, doanh thu, chi phí, chứng từ và báo cáo do người dùng nhập hoặc nhập từ kênh bán phòng.</li>
        <li><b>Dữ liệu Gmail (chỉ khi nhà đầu tư chủ động kết nối):</b> xem mục 2.</li>
        <li><b>Dữ liệu kỹ thuật:</b> cookie phiên đăng nhập để giữ trạng thái đăng nhập. Chúng tôi không dùng cookie quảng cáo hay công cụ theo dõi của bên thứ ba.</li>
      </ul>

      <h2>2. Dữ liệu Google (Gmail)</h2>
      <p>Nhà đầu tư có thể kết nối tài khoản Google nhận email chi trả (payout) từ Airbnb. Ứng dụng xin các quyền sau:</p>
      <ul>
        <li><code>openid</code>, <code>email</code>: biết địa chỉ Gmail nào đã được kết nối.</li>
        <li><code>gmail.readonly</code>: <b>chỉ đọc</b> thư. Ứng dụng không gửi, sửa, xóa hay gắn nhãn thư nào.</li>
      </ul>
      <p>Ứng dụng chỉ tìm thư do <code>automated@airbnb.com</code> gửi có nội dung về khoản chi trả. Từ các thư đó, ứng dụng lưu ngày chi trả, số tiền, tỷ giá, mã khoản chi trả, mã đặt phòng, tiêu đề và nội dung văn bản của thư để đối soát với đơn đặt phòng và lập báo cáo doanh thu cho chính nhà đầu tư đó. Ứng dụng không đọc hay lưu các thư khác.</p>
      <p>Mã làm mới (refresh token) của Google được mã hóa AES-256-GCM trước khi lưu và không bao giờ gửi về trình duyệt.</p>
      <p>Việc baocaodau.com sử dụng và chuyển giao thông tin nhận được từ Google API tuân thủ <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Chính sách dữ liệu người dùng của Google API Services</a>, bao gồm các yêu cầu về Sử dụng giới hạn (Limited Use):</p>
      <blockquote>baocaodau.com’s use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy, including the Limited Use requirements.</blockquote>
      <ul>
        <li>Dữ liệu Gmail chỉ dùng cho chức năng đối soát payout Airbnb mà người dùng nhìn thấy trong ứng dụng.</li>
        <li>Không bán, không dùng cho quảng cáo, không dùng để huấn luyện mô hình AI/học máy tổng quát.</li>
        <li>Không chuyển cho bên thứ ba, trừ khi cần để vận hành chức năng trên, để tuân thủ pháp luật, hoặc khi người dùng đồng ý rõ ràng.</li>
        <li>Không ai đọc thư của người dùng, trừ khi người dùng cho phép, để xử lý sự cố bảo mật, hoặc khi pháp luật yêu cầu.</li>
      </ul>

      <h2>3. Ai được xem dữ liệu</h2>
      <p>Mỗi người chỉ xem được dữ liệu đúng với vai trò của mình. Dữ liệu payout của một nhà đầu tư chỉ hiển thị cho nhà đầu tư đó và quản trị viên LOCI phụ trách quyết toán.</p>

      <h2>4. Lưu trữ và bảo mật</h2>
      <p>Dữ liệu được lưu trên máy chủ và cơ sở dữ liệu do LOCI quản lý, truyền qua HTTPS. Dữ liệu được giữ trong thời gian tài khoản còn hoạt động và theo thời hạn lưu chứng từ kế toán mà pháp luật yêu cầu.</p>

      <h2>5. Thu hồi quyền và xóa dữ liệu</h2>
      <ul>
        <li>Bạn có thể thu hồi quyền truy cập Gmail bất cứ lúc nào tại <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">myaccount.google.com/permissions</a>. Sau khi thu hồi, ứng dụng không đọc thêm thư nào.</li>
        <li>Bạn có thể yêu cầu xóa mã kết nối Google và dữ liệu payout đã lưu bằng cách liên hệ quản trị viên LOCI{CONTACT ? <> qua <a href={`mailto:${CONTACT}`}>{CONTACT}</a></> : null}. Chúng tôi xử lý yêu cầu trong vòng 30 ngày.</li>
      </ul>

      <h2>6. Thay đổi chính sách</h2>
      <p>Khi chính sách thay đổi, chúng tôi cập nhật trang này và ngày “Cập nhật lần cuối” ở trên.</p>

      <h2>7. Liên hệ</h2>
      <p>Mọi câu hỏi về quyền riêng tư, vui lòng liên hệ quản trị viên LOCI{CONTACT ? <> qua <a href={`mailto:${CONTACT}`}>{CONTACT}</a></> : null}.</p>

      <footer><Link href="/terms">Điều khoản sử dụng</Link><Link href="/login">Đăng nhập</Link></footer>
    </main>
  );
}
