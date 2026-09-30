import Link from "next/link";
import { can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";

const ROLE_LABEL = { ADMIN: "Admin LOCI", INVESTOR: "Nhà đầu tư", MANAGER: "Quản lý cơ sở", ACCOUNTANT: "Kế toán", HOUSEKEEPER: "Buồng phòng" };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const nav = [
    ["/", "Tổng quan", user.role !== "HOUSEKEEPER"],
    ["/bookings", "Đặt phòng", can(user, "viewBookings")],
    ["/expenses", "Chi phí", can(user, "viewFinance")],
    ["/settlements", "Quyết toán", can(user, "viewFee")],
    ["/tasks", "Công việc", can(user, "workTask")],
    ["/attendance", "Chấm công", can(user, "clock") || can(user, "viewAllAttendance")],
    ["/dayladau", "Kết nối Dayladau", can(user, "admin")],
  ].filter((x) => x[2]) as [string, string, boolean][];
  const links = nav.map(([href, label]) => <Link key={href} className="nav-btn" href={href}>{label}</Link>);
  return (
    <div className="app">
      <aside className="rail">
        <div className="brand"><b>LOCI</b><span>Homestay Manager</span></div>
        {links}
        <div className="who">
          <span className="lbl">{ROLE_LABEL[user.role]}</span>
          <span>{user.name}</span>
          <form action="/api/auth/logout" method="post"><button className="btn sm">Đăng xuất</button></form>
        </div>
      </aside>
      <main className="main">{children}</main>
      <nav className="bottom-nav">{links}</nav>
    </div>
  );
}
