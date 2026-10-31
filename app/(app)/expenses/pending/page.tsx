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

export default async function Pending({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const [all, props, cats] = await Promise.all([pendingExpenses(db, user), visibleProperties(db, user), categories(db)]);
  const name = Object.fromEntries(props.map((p) => [p.id, p.name]));
  // Bộ lọc cơ sở: id cơ sở hoặc "common" = chi phí chung; chỉ liệt kê cơ sở đang có khoản chờ duyệt
  const countBy = (id: string | null) => all.filter((e) => e.propertyId === id).length;
  const propOpts = props.filter((p) => countBy(p.id) > 0);
  const commonCount = countBy(null);
  let prop = sp.prop ?? "";
  if (prop !== "common" && !props.some((p) => p.id === prop)) prop = "";
  const rows = prop ? all.filter((e) => (prop === "common" ? e.propertyId === null : e.propertyId === prop)) : all;
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
        <ExpenseTabs current="pending" pending={all.length} bank={can(user, "importStatement")} />
        <p className="sub">
          {rows.length ? `${rows.length} khoản${prop === "common" ? " chi phí chung" : prop ? ` của ${name[prop]}` : ""}, tổng ${vnd(total)}. ` : ""}
          {approver ? "Duyệt nghĩa là đã chi tiền cho khoản đó; chi phí được ghi nhận vào tháng hạch toán." : "Các khoản kế toán đã kê khai, đang chờ chủ đầu tư duyệt."}
        </p>
      </div>
      <section className="panel">
        {all.length > 0 && (
          <form className="expense-filter" action="/expenses/pending" role="search" aria-label="Lọc theo cơ sở">
            <label className="field"><span>Cơ sở</span>
              <select name="prop" defaultValue={prop}>
                <option value="">Tất cả cơ sở ({all.length})</option>
                {propOpts.map((p) => <option key={p.id} value={p.id}>{p.name} ({countBy(p.id)})</option>)}
                {commonCount > 0 && <option value="common">Chi phí chung (Unix) ({commonCount})</option>}
                {prop && prop !== "common" && !propOpts.some((p) => p.id === prop) && <option value={prop}>{name[prop]} (0)</option>}
              </select>
            </label>
            <div className="row">
              <button className="btn primary">Lọc</button>
              {prop && <Link className="btn" href="/expenses/pending">Xóa lọc</Link>}
            </div>
          </form>
        )}
        {rows.length ? (
          <form id="pending-form">
            <div className="tbl-wrap"><table>
              <thead><tr>{mode && <th />}<th>Ngày</th><th>Cơ sở</th><th>Loại</th><th>Mô tả</th><th>Tháng</th><th className="n">Số tiền</th><th>Hóa đơn</th></tr></thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    {mode && <td>{(mode === "remind" || mayApprove(e.propertyId)) && <input type="checkbox" name="ids" value={e.id} id={`p-${e.id}`} aria-label="Chọn" defaultChecked={mode === "approve"} />}</td>}
                    <td className="num">{D.formatDateVN(e.incurredOn)}</td>
                    <td>{e.propertyId ? name[e.propertyId] ?? "—" : "Chi phí chung (Unix)"}</td>
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
          <p className="muted">{prop ? "Cơ sở này không có khoản nào đang chờ duyệt." : "Không có khoản nào đang chờ duyệt."}</p>
        )}
      </section>
    </>
  );
}
