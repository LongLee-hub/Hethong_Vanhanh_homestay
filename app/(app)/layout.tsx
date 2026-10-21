import Link from "next/link";
import { can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { NavLinks } from "@/components/NavLinks";
import { MobileNav } from "@/components/MobileNav";

const ROLE_LABEL = { ADMIN: "Admin LOCI", INVESTOR: "Nhà đầu tư", MANAGER: "Quản lý cơ sở", ACCOUNTANT: "Kế toán", HOUSEKEEPER: "Buồng phòng" };

// 4 mục đặt trên thanh tab dưới của điện thoại, theo việc mỗi vai trò mở nhiều nhất; còn lại nằm trong "Thêm".
const MOBILE_PRIMARY = {
  ADMIN: ["/", "/bookings", "/expenses", "/settlements"],
  ACCOUNTANT: ["/", "/bookings", "/expenses", "/settlements"],
  INVESTOR: ["/", "/bookings", "/settlements", "/reports"],
  MANAGER: ["/", "/bookings", "/tasks", "/attendance"],
  HOUSEKEEPER: ["/tasks", "/attendance", "/bookings"],
};

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = [
    ["/", "Tổng quan", user.role !== "HOUSEKEEPER"],
    ["/properties", "Cơ sở & phòng", can(user, "viewFinance")],
    ["/bookings", "Đặt phòng", can(user, "viewBookings")],
    ["/expenses", "Chi phí", can(user, "viewFinance")],
    ["/settlements", "Quyết toán", can(user, "viewFee")],
    ["/payouts", "Payout Airbnb", can(user, "viewFee")],
    ["/reports", "Báo cáo NĐT", can(user, "viewFee")],
    ["/tasks", "Công việc", can(user, "workTask")],
    ["/attendance", "Chấm công", can(user, "clock") || can(user, "viewAllAttendance")],
    ["/dayladau", "Kết nối Dayladau", can(user, "admin")],
    ["/users", "Tài khoản", can(user, "admin")],
  ].filter((x) => x[2]).map(([href, label]) => [href, label]) as [string, string][];
  return (
    <div className="app">
      <header className="topnav">
        <div className="topnav-in">
          <Link className="brand" href="/"><b>LOCI</b><span>Homestay Manager</span></Link>
          <nav className="tabs"><NavLinks items={nav} /></nav>
          <div className="who">
            <span className="name"><b>{user.name}</b><span className="lbl">{ROLE_LABEL[user.role]}</span></span>
            <form action="/api/auth/logout" method="post"><button className="btn sm">Đăng xuất</button></form>
          </div>
        </div>
      </header>
      <main className="main">{children}</main>
      <MobileNav items={nav} primary={MOBILE_PRIMARY[user.role]} user={{ name: user.name, role: ROLE_LABEL[user.role] }} />
    </div>
  );
}
