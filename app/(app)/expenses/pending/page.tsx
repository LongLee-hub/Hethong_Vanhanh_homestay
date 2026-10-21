// Các khoản chi đang chờ duyệt. Chủ đầu tư / Admin chọn nhiều khoản để duyệt hoặc từ chối một lần;
// Kế toán xem để theo dõi và nhắc lại.
import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { categories, visibleProperties } from "@/lib/queries";
import { pendingExpenses } from "@/lib/services/expenses";
import { vnd } from "@/components/MonthNav";
import { ExpenseTabs, Receipts } from "../shared";
import { PendingActions } from "./pending-actions";

export default async function Pending() {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const db = getDb();
  const [rows, props, cats] = await Promise.all([pendingExpenses(db, user), visibleProperties(db, user), categories(db)]);
  const name = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  // NĐT không duyệt chi phí chung
  const approver = can(user, "approveExpense");
  const mayApprove = (propertyId: string | null) => approver && (propertyId !== null || user.role === "ADMIN");
  const mode = approver ? "approve" : can(user, "editExpense") ? "remind" : null;
  const total = rows.reduce((s, e) => s + e.amount, 0);
  return (
    <>
      <div className="topbar">
        <h1>Chờ duyệt</h1>
        <ExpenseTabs current="pending" pending={rows.length} bank={can(user, "importStatement")} />
        <p className="sub">
          {rows.length ? `${rows.length} khoản, tổng ${vnd(total)}. ` : ""}
          {approver ? "Duyệt nghĩa là đã chi tiền cho khoản đó; chi phí được ghi nhận vào tháng hạch toán." : "Các khoản kế toán đã kê khai, đang chờ chủ đầu tư duyệt."}
        </p>
      </div>
      <section className="panel">
        {rows.length ? (
          <form id="pending-form">
            <div className="tbl-wrap"><table>
              <thead><tr>{mode && <th />}<th>Ngày</th><th>Cơ sở</th><th>Loại</th><th>Mô tả</th><th>Tháng</th><th className="n">Số tiền</th><th>Hóa đơn</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    {mode && <td>{(mode === "remind" || mayApprove(e.propertyId)) && <input type="checkbox" name="ids" value={e.id} id={`p-${e.id}`} aria-label="Chọn" defaultChecked={mode === "approve"} />}</td>}
                    <td className="num">{D.formatDateVN(e.incurredOn)}</td>
                    <td>{e.propertyId ? name[e.propertyId] ?? "—" : "Chi phí chung"}</td>
                    <td>{catName[e.categoryId]}</td>
                    <td><Link href={`/expenses/${e.id}`}>{e.description}</Link>{e.bankTransactionId && <span className="hint"> · đã chi theo sao kê</span>}</td>
                    <td className="num">{e.month.slice(5)}/{e.month.slice(0, 4)}</td>
                    <td className="n"><b>{vnd(e.amount)}</b></td>
                    <td><Receipts urls={e.receiptUrls} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            {mode && <PendingActions mode={mode} />}
          </form>
        ) : (
          <p className="muted">Không có khoản nào đang chờ duyệt.</p>
        )}
      </section>
    </>
  );
}
