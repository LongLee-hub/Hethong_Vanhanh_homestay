import { inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { users } from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { attendanceForMonth } from "@/lib/services/tasks";
import { monthParam, visibleProperties } from "@/lib/queries";
import { MonthNav } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { clockAction } from "../actions";

const hm = (d: Date | null) => (d ? new Date(d.getTime() + 7 * 3600_000).toISOString().slice(11, 16) : "—");

export default async function Attendance({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "clock") && !can(user, "viewAllAttendance")) return <NoAccess />;
  const month = monthParam((await searchParams).month);
  const db = getDb();
  const props = await visibleProperties(db, user);
  const rows = await attendanceForMonth(db, user, month);
  const ids = [...new Set(rows.map((r) => r.userId))];
  const names = Object.fromEntries((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  const today = rows.find((r) => r.userId === user.id && r.date === D.todayVN());
  return (
    <>
      <div className="topbar"><h1>Chấm công</h1><MonthNav month={month} path="/attendance" /></div>
      {can(user, "clock") && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <header><h2>{user.name} · {D.formatDateVN(D.todayVN())}</h2>{today ? <span className="pill fc">Vào ca {hm(today.checkInAt)}</span> : <span className="pill">Chưa vào ca</span>}</header>
          {!today ? (
            <ActionForm action={clockAction} submit="Vào ca" okText="Đã vào ca">
              <input type="hidden" name="action" value="in" />
              <label className="field full"><span>Cơ sở</span><select name="propertyId" id="propertyId">{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            </ActionForm>
          ) : !today.checkOutAt ? (
            <ActionForm action={clockAction} submit="Ra ca" okText="Đã ra ca" className="row"><input type="hidden" name="action" value="out" /></ActionForm>
          ) : <p className="small">Đã ra ca lúc {hm(today.checkOutAt)}.</p>}
        </section>
      )}
      <section className="panel">
        <header><h2>Ngày công {D.formatMonthVN(month).toLowerCase()}</h2></header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Ngày</th><th>Nhân viên</th><th>Cơ sở</th><th>Vào</th><th>Ra</th></tr></thead>
          <tbody>{rows.sort((a, b) => b.date.localeCompare(a.date)).map((r) => <tr key={r.id}><td className="num">{D.formatDateVN(r.date)}</td><td>{names[r.userId] ?? "—"}</td><td>{props.find((p) => p.id === r.propertyId)?.name}</td><td className="num">{hm(r.checkInAt)}</td><td className="num">{hm(r.checkOutAt)}</td></tr>)}</tbody>
        </table></div>
      </section>
    </>
  );
}
