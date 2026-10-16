"use client";
// Tạo tài khoản: chọn vị trí trước, form hiện thêm phần gắn cơ sở (nhân viên) hoặc chủ đầu tư (NĐT).
import { useState } from "react";
import type { Role } from "@/lib/auth/access";
import { ActionForm } from "@/components/ActionForm";
import { createUserAction } from "./actions";
import { ROLE_INFO, PropertyChecks, type PropOpt } from "./shared";

const ORDER: Role[] = ["MANAGER", "ACCOUNTANT", "HOUSEKEEPER", "INVESTOR", "ADMIN"];

export function CreateUser({ props, freeInvestors }: { props: PropOpt[]; freeInvestors: { id: string; name: string }[] }) {
  const [role, setRole] = useState<Role>("MANAGER");
  const staff = role === "MANAGER" || role === "ACCOUNTANT" || role === "HOUSEKEEPER";
  return (
    <ActionForm action={createUserAction} submit="Tạo tài khoản" okText="Đã tạo tài khoản">
      <fieldset className="field full" style={{ border: 0, padding: 0, margin: 0 }}>
        <span>Vị trí</span>
        <ul className="listing-list role-list" role="radiogroup" aria-label="Vị trí">
          {ORDER.map((r) => (
            <li key={r}>
              <label className="listing" aria-checked={role === r}>
                <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
                <span className="listing-name"><b>{ROLE_INFO[r].label}</b><span className="small muted">{ROLE_INFO[r].desc}</span></span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <label className="field full"><span>Họ tên</span><input type="text" name="name" id="u-name" required autoComplete="off" /></label>
      <label className="field"><span>Số điện thoại</span><input type="tel" name="phone" id="u-phone" placeholder="0912345678" autoComplete="off" /></label>
      <label className="field"><span>Email</span><input type="email" name="email" id="u-email" placeholder="ten@loci.vn" autoComplete="off" /></label>
      <label className="field"><span>Mật khẩu ban đầu</span><input type="text" name="password" id="u-password" required minLength={8} autoComplete="new-password" placeholder="Ít nhất 8 ký tự" /></label>
      <p className="hint" style={{ alignSelf: "end", margin: 0 }}>Đăng nhập bằng số điện thoại hoặc email. Gửi mật khẩu cho người dùng và nhắc họ giữ kín.</p>

      {staff && (
        <div className="field full">
          <span>Cơ sở được giao</span>
          {props.length ? <PropertyChecks props={props} idPrefix="new" /> : <p className="hint" style={{ margin: 0 }}>Chưa có cơ sở nào. Tạo cơ sở ở trang Cơ sở &amp; phòng trước.</p>}
        </div>
      )}
      {role === "INVESTOR" && (
        <label className="field full"><span>Chủ đầu tư</span>
          <select name="investorId" id="u-investorId" defaultValue="">
            <option value="">Tạo chủ đầu tư mới theo họ tên</option>
            {freeInvestors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <span className="hint">NĐT chỉ xem số liệu các cơ sở thuộc chủ đầu tư này.</span>
        </label>
      )}
      {role === "ADMIN" && <div className="banner full">Admin xem và sửa được toàn bộ hệ thống, kể cả tạo tài khoản khác.</div>}
    </ActionForm>
  );
}
