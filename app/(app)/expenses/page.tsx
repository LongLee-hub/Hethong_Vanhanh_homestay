import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { categories, expensesForMonth, monthParam, visibleProperties } from "@/lib/queries";
import { commonCostBasis, isCommonFinalized } from "@/lib/services/settlement";
import { photoHref } from "@/lib/storage";
import { MonthNav, vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { expenseAction, finalizeCommonAction, markPaidAction } from "../actions";

export default async function Expenses({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const month = monthParam((await searchParams).month);
  const db = getDb();
  const props = await visibleProperties(db, user);
  const name = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const cats = await categories(db);
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const { direct, common } = await expensesForMonth(db, user, month);
  const [finalized, basis] = await Promise.all([isCommonFinalized(db, month), commonCostBasis(db, month)]);
  const editable = can(user, "editExpense");
  const roomsByProp = D.activeRoomCountByProperty(props.flatMap((p) => p.rooms.map((r) => ({ ...r, propertyId: p.id }))), month);
  const commonTotal = common.reduce((s, e) => s + e.amount, 0);
  const myRooms = Object.values(roomsByProp).reduce((s, n) => s + n, 0);
  const mine = user.role === "INVESTOR";
  const receipts = (urls: string[]) =>
    urls.length ? (
      <span className="receipts">{urls.map((u, i) => <a key={u} href={photoHref(u)} target="_blank" rel="noopener">Ảnh{urls.length > 1 ? ` ${i + 1}` : ""}</a>)}</span>
    ) : (
      <span className="muted">—</span>
    );
  return (
    <>
      <div className="topbar"><h1>Chi phí</h1><MonthNav month={month} path="/expenses" /></div>
      <section className="panel">
        <form action={markPaidAction}>
          <div className="tbl-wrap"><table>
            <thead><tr>{editable && <th />}<th>Ngày</th><th>Cơ sở</th><th>Loại</th><th>Mô tả</th><th className="n">Số tiền</th><th>Thanh toán</th><th>Hóa đơn</th></tr></thead>
            <tbody>
              {direct.map((e) => (
                <tr key={e.id}>
                  {editable && <td>{e.paymentStatus === "UNPAID" && <input type="checkbox" name="ids" value={e.id} id={`ex-${e.id}`} aria-label="Chọn" />}</td>}
                  <td className="num">{D.formatDateVN(e.incurredOn)}</td><td>{name[e.propertyId!]}</td><td>{catName[e.categoryId]}</td><td>{e.description}</td>
                  <td className="n"><b>{vnd(e.amount)}</b></td>
                  <td>{e.paymentStatus === "PAID" ? <span className="pill ok">Đã TT</span> : <span className="pill warn">Chưa TT</span>}</td>
                  <td>{receipts(e.receiptUrls)}</td>
                </tr>
              ))}
              <tr className="total"><td colSpan={editable ? 5 : 4}>Tổng chi phí trực tiếp</td><td className="n">{vnd(direct.reduce((s, e) => s + e.amount, 0))}</td><td colSpan={2} /></tr>
            </tbody>
          </table></div>
          {editable && <button className="btn sm" style={{ marginTop: 10 }}>Đánh dấu đã thanh toán</button>}
        </form>
      </section>

      <div className="grid g2" style={{ marginTop: 16 }}>
        {editable && (
          <section className="panel">
            <header><h2>Nhập chi phí</h2></header>
            <ActionForm action={expenseAction} submit="Lưu chi phí" okText="Đã lưu">
              <label className="field full"><span>Cơ sở</span>
                <select name="propertyId" id="propertyId">
                  {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  {can(user, "declareCommon") && <option value="__common">Chi phí chung (toàn hệ thống)</option>}
                </select>
              </label>
              <label className="field"><span>Loại</span><select name="categoryId" id="categoryId">{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              <label className="field"><span>Số tiền (VND)</span><input type="text" inputMode="numeric" name="amount" id="amount" required /></label>
              <label className="field"><span>Tháng hạch toán</span><input type="month" name="month" id="month" defaultValue={month} required /></label>
              <label className="field"><span>Ngày phát sinh</span><input type="date" name="incurredOn" id="incurredOn" defaultValue={D.todayVN()} required /></label>
              <label className="field full"><span>Mô tả</span><input type="text" name="description" id="description" required /></label>
              <label className="field"><span><input type="checkbox" name="paid" id="paid" /> NĐT đã thanh toán</span></label>
              <PhotoInput name="receipt" label="Ảnh hóa đơn" />
            </ActionForm>
          </section>
        )}
        <section className="panel">
          <header><div><h2>Chi phí chung {D.formatMonthVN(month).toLowerCase()}</h2><p>Chia đều theo phòng toàn hệ thống</p></div>{finalized ? <span className="pill ok">Đã hoàn tất kê khai</span> : <span className="pill fc">Đang kê khai</span>}</header>
          <div className="tbl-wrap"><table><tbody>
            {common.map((e) => <tr key={e.id}><td>{catName[e.categoryId]}</td><td>{e.description}</td><td className="n">{vnd(e.amount)}</td><td>{receipts(e.receiptUrls)}</td></tr>)}
            <tr className="total"><td colSpan={2}>Tổng</td><td className="n">{vnd(commonTotal)}</td><td /></tr>
          </tbody></table></div>
          <p className="small muted">
            {basis.provisional
              ? `Chưa kê khai xong nên đang tạm tính theo ${D.formatMonthVN(basis.basisMonth).toLowerCase()}: ${vnd(basis.total)} ÷ ${basis.rooms} phòng toàn hệ thống = ${vnd(Math.round(basis.perRoom))}/phòng.`
              : `${vnd(basis.total)} ÷ ${basis.rooms} phòng toàn hệ thống = ${vnd(Math.round(basis.perRoom))}/phòng.`}
            {" "}{mine ? "Bạn" : "Phạm vi bạn xem"} có {myRooms} phòng, phần được chia khoảng {vnd(Math.round(basis.perRoom * myRooms))}.
          </p>
          {can(user, "declareCommon") && (
            <form action={finalizeCommonAction}>
              <input type="hidden" name="month" value={month} /><input type="hidden" name="value" value={finalized ? "0" : "1"} />
              <button className="btn">{finalized ? "Mở lại kê khai" : "Hoàn tất kê khai"}</button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}
