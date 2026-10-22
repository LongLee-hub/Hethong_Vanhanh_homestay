import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { categories, expensesForMonth, monthParam, visibleProperties } from "@/lib/queries";
import { commonCostBasis, isCommonFinalized } from "@/lib/services/settlement";
import { pendingExpenses } from "@/lib/services/expenses";
import { MonthNav, vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { finalizeCommonAction } from "../actions";
import { declareExpenseAction } from "./actions";
import { ApprovalPill, ExpenseFields, ExpenseTabs, Receipts } from "./shared";

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
  const [finalized, basis, pending] = await Promise.all([isCommonFinalized(db, month), commonCostBasis(db, month), pendingExpenses(db, user)]);
  const editable = can(user, "editExpense");
  const roomsByProp = D.activeRoomCountByProperty(props.flatMap((p) => p.rooms.map((r) => ({ ...r, propertyId: p.id }))), month);
  const sum = (rows: { amount: number }[]) => rows.reduce((s, e) => s + e.amount, 0);
  const approved = direct.filter((e) => e.approvalStatus === "APPROVED");
  const waiting = direct.filter((e) => e.approvalStatus === "PENDING");
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

      <section className="panel">
        <div className="tbl-wrap"><table>
          <thead><tr><th>Ngày</th><th>Cơ sở</th><th>Loại</th><th>Mô tả</th><th className="n">Số tiền</th><th>Trạng thái</th><th>Hóa đơn</th></tr></thead>
          <tbody>
            {direct.map((e) => (
              <tr key={e.id}>
                <td className="num">{D.formatDateVN(e.incurredOn)}</td><td>{name[e.propertyId!]}</td><td>{catName[e.categoryId]}</td>
                <td><Link href={`/expenses/${e.id}`}>{e.description}</Link>{e.bankTransactionId && <span className="hint"> · sao kê</span>}{e.approvalStatus === "REJECTED" && e.rejectReason && <div className="hint">Lý do: {e.rejectReason}</div>}</td>
                <td className="n"><b>{vnd(e.amount)}</b></td>
                <td><ApprovalPill status={e.approvalStatus} /></td>
                <td><Receipts urls={e.receiptUrls} /></td>
              </tr>
            ))}
            {!direct.length && <tr><td colSpan={7} className="muted small">Chưa có khoản chi nào trong tháng.</td></tr>}
            <tr className="total"><td colSpan={4}>Đã ghi nhận (đã duyệt)</td><td className="n">{vnd(sum(approved))}</td><td colSpan={2} /></tr>
            {waiting.length > 0 && <tr><td colSpan={4} className="muted">Đang chờ duyệt — chưa tính</td><td className="n muted">{vnd(sum(waiting))}</td><td colSpan={2} /></tr>}
          </tbody>
        </table></div>
      </section>

      <div className="grid g2" style={{ marginTop: 16 }}>
        {editable && (
          <section className="panel">
            <header><div><h2>Kê khai chi phí</h2><p>Gửi nhóm chat của chủ nhà để duyệt; chỉ ghi nhận sau khi chủ đầu tư duyệt và xác nhận đã chi.</p></div></header>
            <ActionForm action={declareExpenseAction} submit="Kê khai và gửi duyệt">
              <ExpenseFields props={props} cats={cats} allowCommon={can(user, "declareCommon")} idPrefix="new" value={{ propertyId: props[0]?.id ?? null, categoryId: cats[0]?.id ?? "", amount: 0, month, incurredOn: D.todayVN(), description: "" }} />
              <PhotoInput name="receipt" label="Ảnh hóa đơn" />
            </ActionForm>
          </section>
        )}
        <section className="panel">
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
      </div>
    </>
  );
}
