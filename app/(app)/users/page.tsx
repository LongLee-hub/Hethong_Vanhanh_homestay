import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { investors, properties } from "@/lib/db/schema";
import { can, type Role } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { ActionForm } from "@/components/ActionForm";
import { investorsWithoutAccount, listUsers, STAFF_ROLES } from "@/lib/services/users";
import { resetPasswordAction, setUserActiveAction, setUserPropertiesAction, updateUserAction } from "./actions";
import { CreateUser } from "./create-user";
import { PropertyChecks, ROLE_INFO, type PropOpt } from "./shared";

const FILTERS: Role[] = ["ADMIN", "INVESTOR", "MANAGER", "ACCOUNTANT", "HOUSEKEEPER"];

export default async function Users({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "admin")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const [all, freeInvestors, propRows] = await Promise.all([
    listUsers(db, user),
    investorsWithoutAccount(db, user),
    db.select({ id: properties.id, name: properties.name, investor: investors.name, active: properties.active })
      .from(properties).innerJoin(investors, eq(investors.id, properties.investorId)).orderBy(asc(properties.name)),
  ]);
  const props: PropOpt[] = propRows;
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const role = FILTERS.includes(sp.role as Role) ? (sp.role as Role) : null;
  const list = role ? all.filter((u) => u.role === role) : all;
  const count = (r: Role) => all.filter((u) => u.role === r && u.active).length;

  return (
    <>
      <div className="topbar">
        <h1>Tài khoản</h1>
        <p className="sub">Tạo tài khoản đăng nhập cho từng vị trí và giao cơ sở cho nhân viên.</p>
        <div className="chips" style={{ width: "100%" }}>
          <Link className="chip" aria-pressed={!role} href="/users">Tất cả ({all.length})</Link>
          {FILTERS.map((r) => <Link key={r} className="chip" aria-pressed={r === role} href={`/users?role=${r}`}>{ROLE_INFO[r].label}</Link>)}
        </div>
      </div>

      <div className="cards">
        <div className="stat"><span className="lbl">Đang hoạt động</span><span className="v">{all.filter((u) => u.active).length}</span><span className="s">{all.filter((u) => !u.active).length} tài khoản đã khóa</span></div>
        <div className="stat"><span className="lbl">Nhân viên</span><span className="v">{STAFF_ROLES.reduce((s, r) => s + count(r), 0)}</span><span className="s">{count("MANAGER")} quản lý · {count("ACCOUNTANT")} kế toán · {count("HOUSEKEEPER")} buồng phòng</span></div>
        <div className="stat"><span className="lbl">Nhà đầu tư</span><span className="v">{count("INVESTOR")}</span><span className="s">{freeInvestors.length ? `${freeInvestors.length} chủ đầu tư chưa có tài khoản` : "Mọi chủ đầu tư đã có tài khoản"}</span></div>
      </div>

      <details className="panel fold" open={!all.some((u) => u.role !== "ADMIN")}>
        <summary><h2>Tạo tài khoản</h2><span className="small muted">Quản lý, kế toán, buồng phòng, nhà đầu tư hoặc admin</span></summary>
        <CreateUser props={props} freeInvestors={freeInvestors} />
      </details>

      <section className="panel">
        <header><h2>{role ? ROLE_INFO[role].label : "Tất cả tài khoản"} ({list.length})</h2></header>
        <ul className="room-list">
          {list.map((u) => {
            const staff = STAFF_ROLES.includes(u.role);
            const scope = u.role === "ADMIN" ? "Toàn hệ thống"
              : u.role === "INVESTOR" ? (u.investor ? `Chủ đầu tư ${u.investor.name}` : "Chưa gắn chủ đầu tư")
              : u.propertyIds.length ? u.propertyIds.map((id) => propName[id]).filter(Boolean).join(", ") : "Chưa giao cơ sở";
            return (
              <li key={u.id}>
                <details>
                  <summary className="room-row">
                    <b>{u.name}</b>
                    <span className="small muted">{[u.phone, u.email].filter(Boolean).join(" · ")}</span>
                    <span className="small muted">{scope}</span>
                    <span className="spacer" />
                    <span className="pill">{ROLE_INFO[u.role].label}</span>
                    {u.active ? <span className="pill ok">Đang hoạt động</span> : <span className="pill bad">Đã khóa</span>}
                    <span className="chev" aria-hidden>›</span>
                  </summary>
                  <div className="room-actions">
                    <ActionForm action={updateUserAction} submit="Lưu thông tin" okText="Đã lưu">
                      <input type="hidden" name="userId" value={u.id} />
                      <label className="field full"><span>Họ tên</span><input type="text" name="name" id={`name-${u.id}`} defaultValue={u.name} required /></label>
                      <label className="field"><span>Số điện thoại</span><input type="tel" name="phone" id={`phone-${u.id}`} defaultValue={u.phone ?? ""} /></label>
                      <label className="field"><span>Email</span><input type="email" name="email" id={`email-${u.id}`} defaultValue={u.email ?? ""} /></label>
                    </ActionForm>
                    {staff && (
                      <ActionForm action={setUserPropertiesAction} submit="Lưu cơ sở được giao" okText="Đã lưu">
                        <input type="hidden" name="userId" value={u.id} />
                        <div className="field full"><span>Cơ sở được giao</span><PropertyChecks props={props} idPrefix={u.id} checked={u.propertyIds} /></div>
                      </ActionForm>
                    )}
                    <ActionForm action={resetPasswordAction} submit="Đặt lại mật khẩu" okText="Đã đặt mật khẩu mới" className="row">
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="text" name="password" id={`pw-${u.id}`} minLength={8} required placeholder="Mật khẩu mới, ít nhất 8 ký tự" aria-label="Mật khẩu mới" autoComplete="new-password" />
                    </ActionForm>
                    {u.id !== user.id && (
                      <ActionForm action={setUserActiveAction} submit={u.active ? "Khóa tài khoản" : "Mở khóa tài khoản"} okText="Đã cập nhật" className={`row danger-zone ${u.active ? "" : "safe"}`}>
                        <input type="hidden" name="userId" value={u.id} /><input type="hidden" name="active" value={u.active ? "0" : "1"} />
                      </ActionForm>
                    )}
                    <p className="hint">Tạo ngày {u.createdAt.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}. Khóa tài khoản sẽ đăng xuất người dùng ngay; dữ liệu họ đã nhập vẫn giữ nguyên.</p>
                  </div>
                </details>
              </li>
            );
          })}
          {!list.length && <li className="room-row muted small">Chưa có tài khoản nào ở vị trí này.</li>}
        </ul>
      </section>
    </>
  );
}
