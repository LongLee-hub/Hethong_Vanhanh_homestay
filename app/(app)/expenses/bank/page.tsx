// Sao kê ngân hàng: tải file Excel lên, phân loại từng khoản tiền ra và ghi nhận thành chi phí (chờ chủ đầu tư duyệt).
import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { categories, visibleProperties } from "@/lib/queries";
import { listStatements, statementTransactions } from "@/lib/services/bank-statements";
import { pendingExpenses } from "@/lib/services/expenses";
import { vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { uploadStatementAction } from "../actions";
import { ExpenseTabs } from "../shared";
import { StatementReview } from "./review";

export default async function Bank({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "importStatement")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const [statements, props, cats, pending] = await Promise.all([listStatements(db, user), visibleProperties(db, user), categories(db), pendingExpenses(db, user)]);
  const st = statements.find((s) => s.id === sp.st) ?? null;
  const txns = await statementTransactions(db, user, st?.id ?? null);
  const unclassified = statements.reduce((s, x) => s + x.newCount, 0);
  const noCodes = props.filter((p) => !p.bankCodes.length);
  return (
    <>
      <div className="topbar">
        <h1>Sao kê ngân hàng</h1>
        <ExpenseTabs current="bank" pending={pending.length} bank />
        <p className="sub">Tải sao kê Excel, chọn cơ sở – loại – tháng cho từng khoản tiền ra rồi ghi nhận. Khoản ghi nhận được đánh dấu đã chi và gửi chủ đầu tư duyệt như kê khai tay.</p>
      </div>

      {sp.added !== undefined && (
        <div className="banner info"><span>Đã đọc file: <b>{sp.added}</b> giao dịch mới{Number(sp.dup) > 0 ? `, ${sp.dup} giao dịch đã có từ lần tải trước (bỏ qua)` : ""}.</span></div>
      )}
      {sp.warn && <div className="banner bad"><span>{sp.warn}</span></div>}
      {noCodes.length > 0 && can(user, "admin") && (
        <div className="banner"><span>Chưa đặt mã trên sao kê cho: {noCodes.map((p) => p.name).join(", ")}. Đặt ở <Link href="/properties">Cơ sở &amp; phòng</Link> → sửa thông tin để app tự gợi ý cơ sở (vd &quot;vp&quot;, &quot;pkb&quot;).</span></div>
      )}

      <div className="grid g2">
        <section className="panel">
          <header><div><h2>Tải sao kê</h2><p>File Excel (.xlsx) xuất từ MB Bank. Tải chồng kỳ không sao: giao dịch trùng số bút toán tự bỏ qua.</p></div></header>
          <ActionForm action={uploadStatementAction} submit="Đọc sao kê">
            <label className="field full"><span>File sao kê</span><input type="file" name="file" id="statement-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></label>
          </ActionForm>
        </section>
        <section className="panel">
          <header><h2>Các lần tải</h2></header>
          <div className="chips">
            <Link className="chip" aria-pressed={!st} href="/expenses/bank">Tất cả chưa phân loại ({unclassified})</Link>
          </div>
          <div className="tbl-wrap" style={{ marginTop: 12 }}><table>
            <thead><tr><th>Kỳ</th><th>Tài khoản</th><th className="n">Chưa phân loại</th><th className="n">Đã ghi nhận</th></tr></thead>
            <tbody>
              {statements.map((s) => (
                <tr key={s.id}>
                  <td><Link href={`/expenses/bank?st=${s.id}`} aria-current={s.id === st?.id ? "page" : undefined}>{s.fromDate ? D.formatDateVN(s.fromDate) : "?"} – {s.toDate ? D.formatDateVN(s.toDate) : "?"}</Link><div className="hint">{s.fileName}</div></td>
                  <td>{s.bank} {s.accountNo}<div className="hint">{s.accountName}</div></td>
                  <td className="n">{s.newCount || "—"}</td><td className="n">{s.recorded || "—"}</td>
                </tr>
              ))}
              {!statements.length && <tr><td colSpan={4} className="muted small">Chưa tải sao kê nào.</td></tr>}
            </tbody>
          </table></div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <header>
          <div>
            <h2>{st ? `Sao kê ${st.fromDate ? D.formatDateVN(st.fromDate) : ""} – ${st.toDate ? D.formatDateVN(st.toDate) : ""}` : "Khoản tiền ra chưa phân loại"}</h2>
            {st && <p>Đầu kỳ {st.openingBalance != null ? vnd(st.openingBalance) : "—"} · cuối kỳ {st.closingBalance != null ? vnd(st.closingBalance) : "—"}</p>}
          </div>
        </header>
        <StatementReview
          txns={txns.map((t) => ({
            id: t.id, ref: t.ref, bookedOn: t.bookedOn, debit: t.debit, credit: t.credit, counterparty: t.counterparty, content: t.content, status: t.status, note: t.note,
            suggestion: t.suggestion ? { propertyId: t.suggestion.propertyId, categoryId: t.suggestion.categoryId ?? null, month: t.suggestion.month, description: t.suggestion.description, hints: t.suggestion.hints, confident: t.suggestion.confident } : null,
            expense: t.expense,
          }))}
          props={props.map((p) => ({ id: p.id, name: p.name }))}
          cats={cats.map((c) => ({ id: c.id, name: c.name }))}
          allowCommon={can(user, "declareCommon")}
        />
      </section>
    </>
  );
}
