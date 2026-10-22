import type { Metadata } from "next";
import Link from "next/link";
import { Logo } from "@/components/Logo";

export const metadata: Metadata = { title: "Điều khoản sử dụng · baocaodau.com", description: "Điều khoản sử dụng baocaodau.com" };

// Trang công khai cho màn hình đồng ý Google OAuth, đi cùng /privacy.
const CONTACT = process.env.LEGAL_CONTACT_EMAIL;
const UPDATED = "22/10/2026";

export default function TermsPage() {
  return (
    <main className="legal panel">
      <Link href="/login" aria-label="baocaodau.com" className="legal-logo"><Logo size={40} tld /></Link>
      <h1>Điều khoản sử dụng</h1>
      <p className="meta">Cập nhật lần cuối: {UPDATED}</p>

      <p>Khi đăng nhập và sử dụng baocaodau.com (“ứng dụng”), bạn đồng ý với các điều khoản dưới đây.</p>

      <h2>1. Đối tượng sử dụng</h2>
      <p>Ứng dụng là hệ thống nội bộ của chuỗi homestay LOCI, chỉ dành cho nhân viên, đối tác và nhà đầu tư được LOCI cấp tài khoản. Không có đăng ký công khai.</p>

      <h2>2. Tài khoản</h2>
      <ul>
        <li>Bạn chịu trách nhiệm giữ bí mật mật khẩu và mọi thao tác thực hiện bằng tài khoản của mình.</li>
        <li>Không chia sẻ tài khoản cho người khác. Báo ngay cho quản trị viên khi nghi tài khoản bị lộ.</li>
        <li>LOCI có thể khóa hoặc thu hồi tài khoản khi bạn không còn làm việc, hợp tác hay đầu tư cùng LOCI, hoặc khi vi phạm điều khoản này.</li>
      </ul>

      <h2>3. Sử dụng hợp lệ</h2>
      <ul>
        <li>Chỉ dùng ứng dụng cho công việc vận hành homestay LOCI.</li>
        <li>Nhập dữ liệu trung thực: đơn đặt phòng, chi phí, chứng từ và báo cáo phải đúng với thực tế.</li>
        <li>Không tìm cách truy cập dữ liệu ngoài quyền được cấp, không làm gián đoạn hay khai thác lỗ hổng của hệ thống.</li>
      </ul>

      <h2>4. Kết nối Google</h2>
      <p>Nhà đầu tư có thể tùy chọn kết nối Gmail để ứng dụng tự đọc email chi trả từ Airbnb (quyền chỉ đọc). Việc kết nối là tự nguyện, có thể thu hồi bất cứ lúc nào tại <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">myaccount.google.com/permissions</a>, và không kết nối thì vẫn có thể dán email payout thủ công. Cách dữ liệu Gmail được xử lý nêu tại <Link href="/privacy">Chính sách quyền riêng tư</Link>.</p>

      <h2>5. Số liệu và báo cáo</h2>
      <p>Số liệu doanh thu, chi phí và quyết toán trong ứng dụng được tính từ dữ liệu người dùng nhập và dữ liệu nhập từ kênh bán phòng. Các số tạm tính được đánh dấu riêng. Quyết toán chính thức là bản đã được các bên xác nhận theo hợp đồng giữa LOCI và nhà đầu tư.</p>

      <h2>6. Giới hạn trách nhiệm</h2>
      <p>LOCI nỗ lực để ứng dụng hoạt động ổn định và số liệu chính xác, nhưng không bảo đảm ứng dụng luôn không gián đoạn hay không có lỗi. LOCI không chịu trách nhiệm về thiệt hại phát sinh từ việc dùng sai mục đích hoặc từ dữ liệu sai do người dùng nhập.</p>

      <h2>7. Thay đổi điều khoản</h2>
      <p>LOCI có thể cập nhật điều khoản này. Bản mới có hiệu lực khi được đăng tại trang này. Tiếp tục sử dụng ứng dụng nghĩa là bạn đồng ý với bản cập nhật.</p>

      <h2>8. Liên hệ</h2>
      <p>Mọi câu hỏi về điều khoản, vui lòng liên hệ quản trị viên LOCI{CONTACT ? <> qua <a href={`mailto:${CONTACT}`}>{CONTACT}</a></> : null}.</p>

      <footer><Link href="/privacy">Chính sách quyền riêng tư</Link><Link href="/login">Đăng nhập</Link></footer>
    </main>
  );
}
