// Phần dùng chung cho trang Tài khoản (server) và form tạo tài khoản (client).
import type { Role } from "@/lib/auth/access";

export type PropOpt = { id: string; name: string; investor: string; active: boolean };

export const ROLE_INFO: Record<Role, { label: string; desc: string }> = {
  MANAGER: { label: "Quản lý cơ sở", desc: "Đặt phòng, giao việc, duyệt dọn phòng, xem chi phí ở các cơ sở được giao" },
  ACCOUNTANT: { label: "Kế toán", desc: "Nhập chi phí, đánh dấu đã trả, xem quyết toán và báo cáo NĐT ở các cơ sở được giao" },
  HOUSEKEEPER: { label: "Buồng phòng", desc: "Nhận việc dọn phòng, xem lịch đặt phòng (không thấy số tiền), chấm công" },
  INVESTOR: { label: "Nhà đầu tư", desc: "Xem doanh thu, chi phí, quyết toán các cơ sở mình sở hữu" },
  ADMIN: { label: "Admin LOCI", desc: "Toàn quyền: cơ sở, tài khoản, khóa sổ quyết toán, kết nối Dayladau" },
};

export function PropertyChecks({ props, idPrefix, checked = [] }: { props: PropOpt[]; idPrefix: string; checked?: string[] }) {
  return (
    <div className="check-grid">
      {props.map((p) => (
        <label key={p.id} className="check-item">
          <input type="checkbox" name="propertyIds" value={p.id} id={`${idPrefix}-p-${p.id}`} defaultChecked={checked.includes(p.id)} />
          <span className="listing-name"><b>{p.name}</b><span className="small muted">{p.investor}{p.active ? "" : " · Ngưng hoạt động"}</span></span>
        </label>
      ))}
    </div>
  );
}
