// Kê khai chi phí đã duyệt: các khoản đã được chủ đầu tư / Admin duyệt (đã ghi nhận vào lãi lỗ),
// theo tháng hạch toán và cơ sở. Gom theo cơ sở → loại chi phí, có tổng từng nhóm và tải Excel.
import Link from "next/link";
import { inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { categories, expensesForMonth, monthParam, visibleProperties } from "@/lib/queries";
import { pendingExpenses } from "@/lib/services/expenses";
import { MonthNav, vnd } from "@/components/MonthNav";
import { ExpenseTabs, Receipts } from "../shared";

const COMMON = "common";

export default async function ApprovedExpenses({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  const db = getDb();
  const [props, cats, { direct, common }, pending] = await Promise.all([
    visibleProperties(db, user), categories(db), expensesForMonth(db, user, month), pendingExpenses(db, user),
  ]);
  let prop = sp.prop ?? "";
  if (prop !== COMMON && !props.some((p) => p.id === prop)) prop = "";
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));

  const approved = [...direct, ...common].filter((e) => e.approvalStatus === "APPROVED");
  const rows = prop ? approved.filter((e) => (prop === COMMON ? e.propertyId === null : e.propertyId === prop)) : approved;
  const approverIds = [...new Set(rows.map((e) => e.approvedById).filter((v): v is string => !!v))];
  const approverName = Object.fromEntries(
    (approverIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, approverIds)) : []).map((u) => [u.id, u.name]),
  );

  const sum = (list: { amount: number }[]) => list.reduce((s, e) => s + e.amount, 0);
  // Nhóm theo cơ sở (theo tên), chi phí chung cuối cùng; trong nhóm gom theo loại
  const groupKeys = [
    ...props.filter((p) => rows.some((e) => e.propertyId === p.id)).map((p) => p.id),
    ...(rows.some((e) => e.propertyId === null) ? [COMMON] : []),
  ];
  const groups = groupKeys.map((key) => {
    const items = rows.filter((e) => (key === COMMON ? e.propertyId === null : e.propertyId === key));
    const catIds = [...new Set(items.map((e) => e.categoryId))].sort((a, b) => (catName[a] ?? "").localeCompare(catName[b] ?? "", "vi"));
    return {
      key, label: key === COMMON ? "Chi phí chung (Unix)" : propName[key] ?? "—", total: sum(items), count: items.length,
      byCat: catIds.map((c) => {
        const list = items.filter((e) => e.categoryId === c).sort((a, b) => a.incurredOn.localeCompare(b.incurredOn));
        return { id: c, name: catName[c] ?? "Khác", list, total: sum(list) };
      }),
    };
  });
  const total = sum(rows);
  const pendingHere = pending.filter((e) => e.month === month && (!prop || (prop === COMMON ? e.propertyId === null : e.propertyId === prop)));
  const qs = (extra: Record<string, string>) => new URLSearchParams({ month, ...(prop ? { prop } : {}), ...extra }).toString();
  const scope = prop === COMMON ? "chi phí chung (Unix)" : prop ? propName[prop] : "tất cả cơ sở";

  return (
    <>
      <div className="topbar">
        <h1>Chi phí đã duyệt</h1>
        <MonthNav month={month} path="/expenses/approved" extra={prop ? `&prop=${prop}` : ""} />
        <ExpenseTabs current="approved" pending={pending.length} bank={can(user, "importStatement")} month={month} />
        <p className="sub">Các khoản đã được duyệt và ghi nhận vào lãi lỗ, theo tháng hạch toán (tháng chi tiền), không theo ngày phát sinh.</p>
      </div>

      <div className="cards">
        <div className="stat"><span className="lbl">Tổng đã duyệt</span><span className="v">{vnd(total)}</span><span className="s">{D.formatMonthVN(month)} · {scope}</span></div>
        <div className="stat"><span className="lbl">Số khoản</span><span className="v">{rows.length}</span><span className="s">{groups.filter((g) => g.key !== COMMON).length} cơ sở có chi phí</span></div>
        <div className={`stat${pendingHere.length ? " fc" : ""}`}>
          <span className="lbl">Còn chờ duyệt</span><span className="v">{vnd(sum(pendingHere))}</span>
          <span className="s">{pendingHere.length ? <Link href={`/expenses/pending${prop ? `?prop=${prop}` : ""}`}>{pendingHere.length} khoản chưa tính vào lãi lỗ</Link> : "Không có khoản nào"}</span>
        </div>
      </div>

      <section className="panel">
        <form className="expense-filter" action="/expenses/approved" role="search" aria-label="Lọc chi phí đã duyệt">
          <input type="hidden" name="month" value={month} />
          <label className="field"><span>Cơ sở</span>
            <select name="prop" defaultValue={prop}>
              <option value="">Tất cả cơ sở</option>
              {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value={COMMON}>Chi phí chung (Unix)</option>
            </select>
          </label>
          <label className="field"><span>Tháng hạch toán</span><input type="month" name="month" defaultValue={month} /></label>
          <div className="row">
            <button className="btn primary">Xem</button>
            {prop && <Link className="btn" href={`/expenses/approved?month=${month}`}>Xóa lọc</Link>}
            <a className="btn" href={`/expenses/export?${qs({ approved: "1" })}`} download>Tải Excel</a>
          </div>
        </form>

        {!prop && groups.length > 1 && (
          <div className="tbl-wrap" style={{ marginBottom: 16 }}><table className="kpi-table">
            <thead><tr><th>Cơ sở</th><th className="n">Số khoản</th><th className="n">Tổng đã duyệt</th><th className="n">Tỷ trọng</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key}>
                  <td><Link href={`/expenses/approved?${new URLSearchParams({ month, prop: g.key })}`}>{g.label}</Link></td>
                  <td className="n">{g.count}</td><td className="n">{vnd(g.total)}</td>
                  <td className="n muted">{total ? `${Math.round((g.total / total) * 100)}%` : "—"}</td>
                </tr>
              ))}
              <tr className="total"><td>Tổng</td><td className="n">{rows.length}</td><td className="n">{vnd(total)}</td><td /></tr>
            </tbody>
          </table></div>
        )}

        <div className="tbl-wrap"><table className="kpi-table">
          <thead><tr><th>Ngày phát sinh</th><th>Mô tả</th><th className="n">Số tiền</th><th>Người duyệt</th><th>Hóa đơn</th></tr></thead>
          <tbody>
            {groups.map((g) => [
              <tr key={g.key} className="grp"><td colSpan={2}>{g.label}</td><td className="n">{vnd(g.total)}</td><td colSpan={2} className="muted small">{g.count} khoản</td></tr>,
              ...g.byCat.flatMap((c) => [
                <tr key={`${g.key}-${c.id}`} className="sub"><td colSpan={2}><b>{c.name}</b></td><td className="n"><b>{vnd(c.total)}</b></td><td colSpan={2} /></tr>,
                ...c.list.map((e) => (
                  <tr key={e.id} className="sub">
                    <td className="num">{D.formatDateVN(e.incurredOn)}</td>
                    <td><Link href={`/expenses/${e.id}`}>{e.description}</Link>{e.bankTransactionId && <span className="hint"> · sao kê</span>}</td>
                    <td className="n">{vnd(e.amount)}</td>
                    <td className="small">{e.approvedById ? approverName[e.approvedById] ?? "—" : "—"}{e.approvedAt && <div className="hint">{D.formatDateVN(D.todayVN(e.approvedAt))}</div>}</td>
                    <td><Receipts urls={e.receiptUrls} /></td>
                  </tr>
                )),
              ]),
            ])}
            {!rows.length && <tr><td colSpan={5} className="muted small">Chưa có khoản chi nào được duyệt cho {scope} trong {D.formatMonthVN(month).toLowerCase()}.</td></tr>}
            {rows.length > 0 && <tr className="total"><td colSpan={2}>Tổng đã duyệt {D.formatMonthVN(month).toLowerCase()}</td><td className="n">{vnd(total)}</td><td colSpan={2} /></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  );
}
