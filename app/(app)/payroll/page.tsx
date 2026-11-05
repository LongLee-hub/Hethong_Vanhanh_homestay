import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { investors, properties } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { monthParam } from "@/lib/queries";
import { MonthNav } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { LOW_PENALTY_BELOW, monthlyPayroll } from "@/lib/services/payroll";
import { PropertyChecks } from "../users/shared";
import { addAdjustmentAction, createHousekeeperAction, deleteAdjustmentAction, saveRatesAction, setPayAction } from "./actions";

const vnd = (n: number) => (n ? D.formatVND(n) : "–");
const signed = (n: number) => (n > 0 ? `+${D.formatVND(n)}` : n < 0 ? `−${D.formatVND(-n)}` : "–");
const grouped = (n: number) => (n ? n.toLocaleString("vi-VN") : "");

export default async function Payroll({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "admin")) return <NoAccess />;
  const month = monthParam((await searchParams).month);
  const db = getDb();
  const [p, props] = await Promise.all([
    monthlyPayroll(db, user, month),
    db.select({ id: properties.id, name: properties.name, investor: investors.name, active: properties.active })
      .from(properties).innerJoin(investors, eq(investors.id, properties.investorId)).orderBy(asc(properties.name)),
  ]);
  const { rates, rows } = p;
  const monthLow = D.formatMonthVN(month).toLowerCase();
  const sum = (k: "morningPay" | "eveningPay" | "overtimePay" | "bonus" | "penalty" | "adjustments" | "total") => rows.reduce((s, r) => s + r[k], 0);
  const noPay = rows.filter((r) => r.active && !r.morningMonthly && !r.eveningMonthly);

  return (
    <>
      <div className="topbar">
        <h1>Lương buồng phòng</h1>
        <MonthNav month={month} path="/payroll" />
        <p className="sub">
          Tính từ chấm công có ảnh và đánh giá khách của cơ sở được giao. Công chuẩn {monthLow} là {p.standardDays} ngày
          ({D.daysInMonth(month)} ngày trừ {rates.daysOff} ngày nghỉ).
        </p>
        {rows.length > 0 && <div className="row"><a className="btn sm" href={`/payroll/export?month=${month}`} download>Xuất Excel</a></div>}
      </div>

      <div className="cards">
        <div className="stat"><span className="lbl">Tổng lương {monthLow}</span><span className="v">{vnd(sum("total"))}</span><span className="s">{rows.length} nhân viên</span></div>
        <div className="stat"><span className="lbl">Công sáng và tối</span><span className="v">{vnd(sum("morningPay") + sum("eveningPay"))}</span><span className="s">{rows.reduce((s, r) => s + r.morningShifts + r.eveningShifts, 0)} ca đã chấm</span></div>
        <div className="stat"><span className="lbl">Thưởng trừ phạt đánh giá</span><span className="v">{signed(sum("bonus") - sum("penalty"))}</span><span className="s">{rows.reduce((s, r) => s + r.fiveStar, 0)} lượt 5★, {rows.reduce((s, r) => s + r.low, 0)} lượt dưới {LOW_PENALTY_BELOW}★ (tính theo người)</span></div>
      </div>

      {noPay.length > 0 && (
        <div className="banner" style={{ marginBottom: 16 }}>
          Chưa đặt lương ca cho {noPay.map((r) => r.name).join(", ")}. Đặt ở phần Nhân viên bên dưới, nếu không công ca sáng và tối tính 0 đồng.
        </div>
      )}

      <section className="panel" style={{ marginBottom: 24 }}>
        <header><div><h2>Bảng lương {monthLow}</h2><p>Đơn giá 1 công = lương tháng của ca ÷ {p.standardDays}. Đánh giá tính vào tháng khách trả phòng.</p></div></header>
        {rows.length === 0 ? <p className="muted">Chưa có nhân viên buồng phòng. Tạo tài khoản ở phần Nhân viên bên dưới.</p> : (
          <div className="tbl-wrap"><table>
            <thead>
              <tr>
                <th>Nhân viên</th>
                <th className="n">Ca sáng</th><th className="n">Ca tối</th>
                <th className="n">Tăng ca</th>
                <th className="n">Thưởng 5★</th><th className="n">Phạt dưới {LOW_PENALTY_BELOW}★</th>
                <th className="n">Cộng/trừ</th><th className="n">Thực lĩnh</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId}>
                  <td>
                    <Link href={`/attendance?month=${month}&u=${r.userId}`}><b>{r.name}</b></Link>{!r.active && <span className="pill bad" style={{ marginLeft: 6 }}>Đã nghỉ</span>}
                    <div className="small muted">{r.propertyNames.join(", ") || "Chưa giao cơ sở"}</div>
                  </td>
                  <td className="n">{vnd(r.morningPay)}<div className="small muted">{r.morningShifts} × {vnd(r.morningRate)}</div></td>
                  <td className="n">{vnd(r.eveningPay)}<div className="small muted">{r.eveningShifts} × {vnd(r.eveningRate)}</div></td>
                  <td className="n">{vnd(r.overtimePay)}<div className="small muted">{r.overtime} lần</div></td>
                  <td className="n pos">{vnd(r.bonus)}<div className="small muted">{r.fiveStar} lượt</div></td>
                  <td className={`n ${r.penalty ? "neg" : ""}`}>{r.penalty ? `−${D.formatVND(r.penalty)}` : "–"}<div className="small muted">{r.low} lượt</div></td>
                  <td className="n">{signed(r.adjustments)}</td>
                  <td className="n"><b>{vnd(r.total)}</b></td>
                </tr>
              ))}
              <tr className="total">
                <td>Tổng</td>
                <td className="n">{vnd(sum("morningPay"))}</td><td className="n">{vnd(sum("eveningPay"))}</td><td className="n">{vnd(sum("overtimePay"))}</td>
                <td className="n">{vnd(sum("bonus"))}</td><td className="n">{sum("penalty") ? `−${D.formatVND(sum("penalty"))}` : "–"}</td>
                <td className="n">{signed(sum("adjustments"))}</td><td className="n"><b>{vnd(sum("total"))}</b></td>
              </tr>
            </tbody>
          </table></div>
        )}
      </section>

      <section className="panel" style={{ marginBottom: 24 }}>
        <header><div><h2>Nhân viên</h2><p>Lương tháng theo ca và khoản cộng/trừ {monthLow}. Đổi cơ sở được giao, mật khẩu hoặc khóa tài khoản ở trang <Link href="/users?role=HOUSEKEEPER">Tài khoản</Link>.</p></div></header>
        <ul className="room-list">
          {rows.filter((r) => r.active).map((r) => (
            <li key={r.userId}>
              <details>
                <summary className="room-row">
                  <b>{r.name}</b>
                  <span className="small muted">{r.phone}</span>
                  <span className="small muted">Sáng {vnd(r.morningMonthly)}/tháng, tối {vnd(r.eveningMonthly)}/tháng</span>
                  <span className="spacer" />
                  <span className="chev" aria-hidden>›</span>
                </summary>
                <div className="room-actions">
                  <ActionForm action={setPayAction} submit="Lưu lương ca" okText="Đã lưu">
                    <input type="hidden" name="userId" value={r.userId} />
                    <label className="field"><span>Lương ca sáng (cả tháng)</span><input name="morningMonthly" id={`m-${r.userId}`} inputMode="numeric" defaultValue={grouped(r.morningMonthly)} placeholder="4.500.000" /></label>
                    <label className="field"><span>Lương ca tối (cả tháng)</span><input name="eveningMonthly" id={`e-${r.userId}`} inputMode="numeric" defaultValue={grouped(r.eveningMonthly)} placeholder="3.500.000" /></label>
                  </ActionForm>
                  {r.adjustmentItems.length > 0 && (
                    <ul className="change-list">
                      {r.adjustmentItems.map((a) => (
                        <li key={a.id} className="row">
                          <span className={a.amount < 0 ? "neg" : "pos"}>{signed(a.amount)}</span><span>{a.reason}</span><span className="spacer" />
                          <ActionForm action={deleteAdjustmentAction} submit="Xóa" submitClass="btn sm" className="row" confirmText="Xóa khoản cộng/trừ này?"><input type="hidden" name="id" value={a.id} /></ActionForm>
                        </li>
                      ))}
                    </ul>
                  )}
                  <ActionForm action={addAdjustmentAction} submit="Thêm khoản cộng/trừ" okText="Đã thêm">
                    <input type="hidden" name="userId" value={r.userId} /><input type="hidden" name="month" value={month} />
                    <label className="field"><span>Số tiền (ghi dấu − để trừ)</span><input name="amount" id={`a-${r.userId}`} inputMode="numeric" placeholder="-500.000" required /></label>
                    <label className="field"><span>Lý do</span><input name="reason" id={`r-${r.userId}`} placeholder="Ứng lương, phụ cấp xăng xe…" required /></label>
                  </ActionForm>
                </div>
              </details>
            </li>
          ))}
        </ul>

        <details className="fold" open={rows.length === 0} style={{ marginTop: 16 }}>
          <summary><h3>Tạo tài khoản buồng phòng</h3><span className="small muted">Nhân viên đăng nhập bằng số điện thoại để chấm công và xem đánh giá cơ sở được giao</span></summary>
          <ActionForm action={createHousekeeperAction} submit="Tạo tài khoản" okText="Đã tạo tài khoản">
            <label className="field full"><span>Họ tên</span><input name="name" id="hk-name" required autoComplete="off" /></label>
            <label className="field"><span>Số điện thoại</span><input type="tel" name="phone" id="hk-phone" placeholder="0912345678" required autoComplete="off" /></label>
            <label className="field"><span>Mật khẩu ban đầu</span><input name="password" id="hk-password" minLength={8} required autoComplete="new-password" placeholder="Ít nhất 8 ký tự" /></label>
            <label className="field"><span>Lương ca sáng (cả tháng)</span><input name="morningMonthly" id="hk-m" inputMode="numeric" placeholder="4.500.000" /></label>
            <label className="field"><span>Lương ca tối (cả tháng)</span><input name="eveningMonthly" id="hk-e" inputMode="numeric" placeholder="3.500.000" /></label>
            <div className="field full"><span>Cơ sở được giao</span><PropertyChecks props={props} idPrefix="hk" /><span className="hint">Nhân viên chỉ chấm công và xem đánh giá ở các cơ sở này. Thưởng, phạt đánh giá cũng tính theo các cơ sở này.</span></div>
          </ActionForm>
        </details>
      </section>

      <section className="panel">
        <header><div><h2>Cài đặt tính lương</h2><p>Áp dụng cho mọi nhân viên buồng phòng, tính lại ngay cho các tháng chưa trả.</p></div></header>
        <ActionForm action={saveRatesAction} submit="Lưu cài đặt" okText="Đã lưu">
          <label className="field"><span>Ngày nghỉ mỗi tháng</span><input type="number" name="daysOff" id="daysOff" min={0} max={27} defaultValue={rates.daysOff} /><span className="hint">Công chuẩn = số ngày trong tháng − số này</span></label>
          <label className="field"><span>Tăng ca (đồng/lần)</span><input name="overtimeRate" id="overtimeRate" inputMode="numeric" defaultValue={grouped(rates.overtimeRate)} /></label>
          <label className="field"><span>Thưởng mỗi đánh giá 5★</span><input name="fiveStarBonus" id="fiveStarBonus" inputMode="numeric" defaultValue={grouped(rates.fiveStarBonus)} /></label>
          <label className="field"><span>Phạt mỗi đánh giá dưới {LOW_PENALTY_BELOW}★</span><input name="lowReviewPenalty" id="lowReviewPenalty" inputMode="numeric" defaultValue={grouped(rates.lowReviewPenalty)} /></label>
        </ActionForm>
      </section>
    </>
  );
}
