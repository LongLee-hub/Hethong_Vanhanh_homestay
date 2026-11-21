import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { properties, users } from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { attendanceForMonth } from "@/lib/services/tasks";
import { SHIFT_LABEL, type Shift } from "@/lib/services/payroll";
import { monthParam, visibleProperties } from "@/lib/queries";
import { photoHref } from "@/lib/storage";
import { MonthNav } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { CameraStamp } from "@/components/CameraStamp";
import { clockAction } from "../actions";

const hm = (d: Date | null) => (d ? new Date(d.getTime() + 7 * 3600_000).toISOString().slice(11, 16) : "—");
/** Ảnh và vị trí của một lần chụp chấm công (vào ca hoặc kết thúc ca). */
function Proof({ photo, lat, lng, acc }: { photo: string | null; lat: number | null; lng: number | null; acc: number | null }) {
  if (!photo && (lat === null || lng === null)) return <span className="muted">—</span>;
  return (
    <span style={{ display: "inline-flex", gap: 10, flexWrap: "wrap" }}>
      {photo ? <a href={photoHref(photo)} target="_blank" rel="noreferrer">Xem ảnh</a> : <span className="muted">Không ảnh</span>}
      {lat !== null && lng !== null
        ? <a href={`https://www.google.com/maps?q=${lat},${lng}`} target="_blank" rel="noreferrer">Bản đồ{acc ? ` (±${acc} m)` : ""}</a>
        : <span className="muted">Không vị trí</span>}
    </span>
  );
}

const SHIFTS: Shift[] = ["MORNING", "EVENING", "OVERTIME"];
const SHIFT_HINT: Record<Shift, string> = { MORNING: "Tính 1 công sáng", EVENING: "Tính 1 công tối", OVERTIME: "Tính theo lần" };

export default async function Attendance({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "clock") && !can(user, "viewAllAttendance")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  const db = getDb();
  const props = await visibleProperties(db, user);
  const rows = await attendanceForMonth(db, user, month);
  const ids = [...new Set(rows.map((r) => r.userId))];
  const names = Object.fromEntries((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  const today = D.todayVN();
  // Buồng phòng vào ca hỗ trợ được ở cơ sở khác đang hoạt động (sang dọn giúp)
  const others = user.role === "HOUSEKEEPER"
    ? await db.select({ id: properties.id, name: properties.name, address: properties.address }).from(properties)
      .where(and(eq(properties.active, true), props.length ? notInArray(properties.id, props.map((p) => p.id)) : undefined)).orderBy(asc(properties.name))
    : [];
  const mineToday = rows.filter((r) => r.userId === user.id && r.date === today).sort((a, b) => a.checkInAt.getTime() - b.checkInAt.getTime());
  const open = mineToday.find((r) => !r.checkOutAt);
  const freeShifts = SHIFTS.filter((s) => !mineToday.some((r) => r.shift === s));
  const mine = rows.filter((r) => r.userId === user.id);
  const count = (s: Shift) => mine.filter((r) => r.shift === s).length;
  const filterUser = sp.u && ids.includes(sp.u) ? sp.u : null;
  const listed = (filterUser ? rows.filter((r) => r.userId === filterUser) : rows).sort((a, b) => b.date.localeCompare(a.date) || b.checkInAt.getTime() - a.checkInAt.getTime());

  return (
    <>
      <div className="topbar"><h1>Chấm công</h1><MonthNav month={month} path="/attendance" /></div>

      {can(user, "clock") && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <header>
            <div>
              <h2>{user.name}, {D.formatDateVN(today)}</h2>
              <p>{mineToday.length ? mineToday.map((r) => `${SHIFT_LABEL[r.shift]}${r.support ? " (hỗ trợ)" : ""} vào ${hm(r.checkInAt)}${r.checkOutAt ? `, ra ${hm(r.checkOutAt)}` : ""}`).join(". ") : "Hôm nay chưa vào ca nào."}</p>
            </div>
            {open ? <span className="pill fc">Đang trong {SHIFT_LABEL[open.shift].toLowerCase()}</span> : <span className="pill">Chưa vào ca</span>}
          </header>

          {open ? (
            <ActionForm action={clockAction} submit={`Kết thúc ${SHIFT_LABEL[open.shift].toLowerCase()}`} okText="Đã kết thúc ca">
              <input type="hidden" name="action" value="out" />
              <input type="hidden" name="attendanceId" value={open.id} />
              <CameraStamp
                mode="out"
                userName={user.name}
                properties={[...props, ...others].filter((p) => p.id === open.propertyId).map((p) => ({ id: p.id, name: open.support ? `${p.name} (hỗ trợ)` : p.name, address: p.address }))}
                shifts={[{ value: open.shift, label: SHIFT_LABEL[open.shift] }]}
              />
            </ActionForm>
          ) : !props.length && !others.length ? (
            <p className="small muted">Bạn chưa được giao cơ sở nào. Nhờ admin giao cơ sở ở trang Tài khoản.</p>
          ) : freeShifts.length ? (
            <ActionForm action={clockAction} submit="Vào ca" okText="Đã vào ca">
              <input type="hidden" name="action" value="in" />
              {user.role === "HOUSEKEEPER" && (
                <fieldset className="full clean-cats">
                  <legend>Loại ca</legend>
                  <label className="chip"><input type="radio" name="kind" value="MAIN" defaultChecked className="sr-only" />Ca chính: cơ sở mình phụ trách</label>
                  <label className="chip"><input type="radio" name="kind" value="SUPPORT" className="sr-only" />Ca hỗ trợ: sang dọn giúp</label>
                </fieldset>
              )}
              <CameraStamp
                userName={user.name}
                properties={[
                  ...props.map((p) => ({ id: p.id, name: p.name, address: p.address })),
                  ...others.map((p) => ({ id: p.id, name: `${p.name} (hỗ trợ)`, address: p.address })),
                ]}
                shifts={freeShifts.map((s) => ({ value: s, label: SHIFT_LABEL[s], hint: SHIFT_HINT[s] }))}
              />
            </ActionForm>
          ) : <p className="small">Hôm nay đã chấm đủ các ca.</p>}
        </section>
      )}

      {can(user, "clock") && !can(user, "viewAllAttendance") && (
        <div className="cards">
          <div className="stat"><span className="lbl">Ca sáng</span><span className="v">{count("MORNING")}</span><span className="s">{D.formatMonthVN(month)}</span></div>
          <div className="stat"><span className="lbl">Ca tối</span><span className="v">{count("EVENING")}</span><span className="s">{D.formatMonthVN(month)}</span></div>
          <div className="stat"><span className="lbl">Tăng ca</span><span className="v">{count("OVERTIME")}</span><span className="s">lần</span></div>
        </div>
      )}

      <section className="panel">
        <header>
          <h2>Ngày công {D.formatMonthVN(month).toLowerCase()}</h2>
          {can(user, "viewAllAttendance") && ids.length > 1 && (
            <div className="chips">
              <a className="chip" aria-pressed={!filterUser} href={`/attendance?month=${month}`}>Tất cả</a>
              {ids.map((id) => <a key={id} className="chip" aria-pressed={filterUser === id} href={`/attendance?month=${month}&u=${id}`}>{names[id]}</a>)}
            </div>
          )}
        </header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Ngày</th><th>Nhân viên</th><th>Cơ sở</th><th>Ca</th><th>Vào</th><th>Ảnh / vị trí vào</th><th>Kết thúc</th><th>Ảnh / vị trí kết thúc</th></tr></thead>
          <tbody>
            {listed.map((r) => (
              <tr key={r.id}>
                <td className="num">{D.formatDateVN(r.date)}</td>
                <td>{names[r.userId] ?? "—"}</td>
                <td>{props.find((p) => p.id === r.propertyId)?.name ?? others.find((p) => p.id === r.propertyId)?.name}</td>
                <td>{SHIFT_LABEL[r.shift]}{r.support ? <span className="pill warn" style={{ marginLeft: 6 }}>Hỗ trợ</span> : null}</td>
                <td className="num">{hm(r.checkInAt)}</td>
                <td><Proof photo={r.photoUrl} lat={r.lat} lng={r.lng} acc={r.accuracyM} /></td>
                <td className="num">{r.checkOutAt ? hm(r.checkOutAt) : <span className="pill warn">Chưa kết thúc</span>}</td>
                <td>{r.checkOutAt ? <Proof photo={r.checkOutPhotoUrl} lat={r.checkOutLat} lng={r.checkOutLng} acc={r.checkOutAccuracyM} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
            {!listed.length && <tr><td colSpan={8} className="muted">Chưa có ngày công nào trong tháng.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  );
}
