import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { categories, expensesForMonth, expensesInRange, monthParam, visibleProperties } from "@/lib/queries";
import { fold } from "@/lib/bank/statement-parser";
import { commonCostBasis, isCommonFinalized } from "@/lib/services/settlement";
import { pendingExpenses } from "@/lib/services/expenses";
import { MonthNav, vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { finalizeCommonAction } from "../actions";
import { addCategoryAction, declareExpenseAction } from "./actions";
import { ApprovalPill, ExpenseFields, ExpenseTabs, Receipts } from "./shared";

export default async function Expenses({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  // Bộ lọc: loại, mô tả, khoảng ngày phát sinh (có khoảng ngày thì xem qua nhiều tháng)
  const isDay = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");
  const f = { cat: sp.cat ?? "", q: (sp.q ?? "").trim(), from: isDay(sp.from), to: isDay(sp.to) };
  const ranged = !!(f.from || f.to);
  const filtered = ranged || !!f.cat || !!f.q;
  const db = getDb();
  const props = await visibleProperties(db, user);
  const name = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const cats = await categories(db);
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const { direct, common } = await expensesForMonth(db, user, month);
  const ranges = ranged ? await expensesInRange(db, user, f.from || "2000-01-01", f.to || "2999-12-31") : null;
  const words = fold(f.q).split(" ").filter(Boolean);
  const match = (e: { categoryId: string; description: string }) =>
    (!f.cat || e.categoryId === f.cat) && words.every((w) => fold(e.description).includes(w));
  // Có lọc: bảng gồm cả chi phí chung để tìm được khoản BHXH, kế toán… trả chung
  const rows = filtered
    ? [...(ranges ? [...ranges.direct, ...ranges.common] : [...direct, ...common])].filter(match).sort((a, b) => a.incurredOn.localeCompare(b.incurredOn))
    : direct;
  const [finalized, basis, pending] = await Promise.all([isCommonFinalized(db, month), commonCostBasis(db, month), pendingExpenses(db, user)]);
  const editable = can(user, "editExpense");
  const roomsByProp = D.activeRoomCountByProperty(props.flatMap((p) => p.rooms.map((r) => ({ ...r, propertyId: p.id }))), month);
  const sum = (rows: { amount: number }[]) => rows.reduce((s, e) => s + e.amount, 0);
  const commonApproved = common.filter((e) => e.approvalStatus === "APPROVED");
  const myRooms = Object.values(roomsByProp).reduce((s, n) => s + n, 0);
  const mine = user.role === "INVESTOR";
  const toApprove = can(user, "approveExpense") ? pending.filter((e) => e.propertyId !== null || user.role === "ADMIN") : [];
  // Cơ sở đang hoạt động trong tháng còn thiếu loại chi phí bắt buộc; tháng tương lai chưa phát sinh nên không báo
  const missing = month <= D.monthOf(D.todayVN())
    ? D.missingExpenseCategories({ propertyIds: props.filter((p) => roomsByProp[p.id]).map((p) => p.id), expenses: [...direct, ...common], categoryName: catName })
    : [];
  return (
    <>
      <div className="topbar">
        <h1>Chi phí</h1>
        <MonthNav month={month} path="/expenses" />
        <ExpenseTabs current="list" pending={pending.length} bank={can(user, "importStatement")} month={month} />
      </div>

      {toApprove.length > 0 && (
        <div className="banner info">
          <span>Có <b>{toApprove.length}</b> khoản chi ({vnd(sum(toApprove))}) đang chờ {mine ? "anh/chị" : "bạn"} duyệt. Chi phí chỉ được tính vào lãi lỗ sau khi duyệt.</span>
          <Link className="btn sm" href="/expenses/pending">Xem và duyệt</Link>
        </div>
      )}

      {missing.length > 0 && (
        <div className="expense-missing neg" role="alert">
          {missing.map((m) => (
            <div key={m.propertyId}>Cảnh báo: <b>{name[m.propertyId]}</b> còn thiếu chi phí {D.formatMonthVN(month).toLowerCase()}: {m.missing.join(", ")}.</div>
          ))}
        </div>
      )}

      {editable && (
        <section className="panel">
          <header><div><h2>Kê khai chi phí</h2><p>Gửi nhóm chat của chủ nhà để duyệt; chỉ ghi nhận sau khi chủ đầu tư duyệt và xác nhận đã chi.</p></div></header>
          <ActionForm action={declareExpenseAction} submit="Kê khai và gửi duyệt">
            <ExpenseFields props={props} cats={cats} allowCommon={can(user, "declareCommon")} idPrefix="new" value={{ propertyId: props[0]?.id ?? null, categoryId: cats[0]?.id ?? "", amount: 0, month, incurredOn: D.todayVN(), description: "" }} />
            <PhotoInput name="receipt" label="Ảnh hóa đơn" />
          </ActionForm>
          <details className="fold" style={{ marginTop: 16 }}>
            <summary>Thêm loại chi phí</summary>
            <p className="small muted">Loại mới xuất hiện ngay trong ô Loại. Khoản chi thuộc loại này được tính vào quyết toán và báo cáo nhà đầu tư sau khi duyệt.</p>
            <ActionForm action={addCategoryAction} submit="Thêm loại" submitClass="btn" className="row">
              <input type="text" name="name" id="new-category" maxLength={60} required placeholder="Ví dụ: Sửa chữa, Marketing" aria-label="Tên loại chi phí" />
            </ActionForm>
          </details>
        </section>
      )}

      <section className="panel" style={{ marginTop: 16 }}>
        <form className="expense-filter" action="/expenses" role="search" aria-label="Lọc chi phí">
          {!ranged && <input type="hidden" name="month" value={month} />}
          <label className="field"><span>Loại</span>
            <select name="cat" defaultValue={f.cat}>
              <option value="">Tất cả loại</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label className="field grow"><span>Mô tả</span><input type="search" name="q" defaultValue={f.q} placeholder="vd: bhxh, điều hòa, Nguyen Chi Bac" /></label>
          <label className="field"><span>Từ ngày</span><input type="date" name="from" defaultValue={f.from} /></label>
          <label className="field"><span>Đến ngày</span><input type="date" name="to" defaultValue={f.to} /></label>
          <div className="row">
            <button className="btn primary">Lọc</button>
            {filtered && <Link className="btn" href={`/expenses?month=${month}`}>Xóa lọc</Link>}
          </div>
        </form>
        {filtered && (
          <p className="small muted" style={{ margin: "0 0 8px" }}>
            {rows.length} khoản{ranged ? ` phát sinh ${f.from ? `từ ${D.formatDateVN(f.from)} ` : ""}${f.to ? `đến ${D.formatDateVN(f.to)}` : ""}` : ` trong ${D.formatMonthVN(month).toLowerCase()}`}, gồm cả chi phí chung.
          </p>
        )}
        <div className="tbl-wrap"><table>
          <thead><tr><th>Ngày</th><th>Cơ sở</th><th>Loại</th><th>Mô tả</th><th className="n">Số tiền</th><th>Trạng thái</th><th>Hóa đơn</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="num">{D.formatDateVN(e.incurredOn)}{ranged && e.month !== e.incurredOn.slice(0, 7) && <div className="hint">tính T{Number(e.month.slice(5))}/{e.month.slice(0, 4)}</div>}</td>
                <td>{e.propertyId ? name[e.propertyId] : <span className="muted">Chi phí chung (Unix)</span>}</td><td>{catName[e.categoryId]}</td>
                <td><Link href={`/expenses/${e.id}`}>{e.description}</Link>{e.bankTransactionId && <span className="hint"> · sao kê</span>}{e.approvalStatus === "REJECTED" && e.rejectReason && <div className="hint">Lý do: {e.rejectReason}</div>}</td>
                <td className="n"><b>{vnd(e.amount)}</b></td>
                <td><ApprovalPill status={e.approvalStatus} /></td>
                <td><Receipts urls={e.receiptUrls} /></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} className="muted small">{filtered ? "Không có khoản chi nào khớp bộ lọc." : "Chưa có khoản chi nào trong tháng."}</td></tr>}
            <tr className="total"><td colSpan={4}>Đã ghi nhận (đã duyệt)</td><td className="n">{vnd(sum(rows.filter((e) => e.approvalStatus === "APPROVED")))}</td><td colSpan={2} /></tr>
            {rows.some((e) => e.approvalStatus === "PENDING") && <tr><td colSpan={4} className="muted">Đang chờ duyệt — chưa tính</td><td className="n muted">{vnd(sum(rows.filter((e) => e.approvalStatus === "PENDING")))}</td><td colSpan={2} /></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="panel" style={{ marginTop: 16 }}>
          <header><div><h2>Chi phí chung {D.formatMonthVN(month).toLowerCase()}</h2><p>Chia đều theo phòng toàn hệ thống · Admin duyệt</p></div>{finalized ? <span className="pill ok">Đã hoàn tất kê khai</span> : <span className="pill fc">Đang kê khai</span>}</header>
          <div className="tbl-wrap"><table><tbody>
            {common.map((e) => (
              <tr key={e.id}>
                <td>{catName[e.categoryId]}</td><td><Link href={`/expenses/${e.id}`}>{e.description}</Link></td>
                <td className="n">{vnd(e.amount)}</td><td>{e.approvalStatus !== "APPROVED" && <ApprovalPill status={e.approvalStatus} />}</td><td><Receipts urls={e.receiptUrls} /></td>
              </tr>
            ))}
            <tr className="total"><td colSpan={2}>Tổng đã duyệt</td><td className="n">{vnd(sum(commonApproved))}</td><td colSpan={2} /></tr>
          </tbody></table></div>
          <p className="small muted">
            {basis.provisional
              ? `Chưa kê khai xong nên đang tạm tính theo ${D.formatMonthVN(basis.basisMonth).toLowerCase()}: ${vnd(basis.total)} ÷ ${basis.rooms} phòng toàn hệ thống = ${vnd(Math.round(basis.perRoom))}/phòng.`
              : `${vnd(basis.total)} ÷ ${basis.rooms} phòng toàn hệ thống = ${vnd(Math.round(basis.perRoom))}/phòng.`}
            {" "}{mine ? "Bạn" : "Phạm vi bạn xem"} có {myRooms} phòng, phần được chia khoảng {vnd(Math.round(basis.perRoom * myRooms))}.
          </p>
          {can(user, "declareCommon") && (
            <ActionForm action={finalizeCommonAction} submit={finalized ? "Mở lại kê khai" : "Hoàn tất kê khai"} submitClass="btn" className="row">
              <input type="hidden" name="month" value={month} /><input type="hidden" name="value" value={finalized ? "0" : "1"} />
            </ActionForm>
          )}
      </section>
    </>
  );
}
