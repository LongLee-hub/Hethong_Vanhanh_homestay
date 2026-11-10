// Kê khai chi phí đã duyệt: các khoản đã được chủ đầu tư / Admin duyệt (đã ghi nhận vào lãi lỗ),
// theo tháng hạch toán và cơ sở. Gom theo cơ sở → loại chi phí, có tổng từng nhóm và tải Excel.
//
// Chi phí chung (Unix) chỉ tính cho cơ sở Unix (NĐT bật "Chịu chi phí chung"): mỗi cơ sở Unix nhận phần phân bổ
// = tổng chi phí chung đã duyệt của tháng ÷ số phòng Unix × số phòng của cơ sở — cùng cách quyết toán đang chia.
// Cơ sở không thuộc Unix không có dòng chi phí chung; người chỉ xem cơ sở ngoài Unix không thấy chi phí chung.
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
import { commonAllocation } from "@/lib/services/settlement";
import { MonthNav, vnd } from "@/components/MonthNav";
import { ExpenseTabs, Receipts } from "../shared";

const COMMON = "common";
type Row = Awaited<ReturnType<typeof expensesForMonth>>["direct"][number];

export default async function ApprovedExpenses({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  const db = getDb();
  const [props, cats, { direct, common }, pending, alloc] = await Promise.all([
    visibleProperties(db, user), categories(db), expensesForMonth(db, user, month), pendingExpenses(db, user), commonAllocation(db, month),
  ]);
  const unixProps = props.filter((p) => alloc.isUnix(p.id));
  const hasUnix = unixProps.length > 0;
  let prop = sp.prop ?? "";
  if (!(prop === COMMON ? hasUnix : props.some((p) => p.id === prop))) prop = "";
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
  const sum = (list: { amount: number }[]) => list.reduce((s, e) => s + e.amount, 0);
  const byCat = (items: Row[]) =>
    [...new Set(items.map((e) => e.categoryId))]
      .sort((a, b) => (catName[a] ?? "").localeCompare(catName[b] ?? "", "vi"))
      .map((c) => {
        const list = items.filter((e) => e.categoryId === c).sort((a, b) => a.incurredOn.localeCompare(b.incurredOn));
        return { id: c, name: catName[c] ?? "Khác", list, total: sum(list) };
      });

  const directOk = direct.filter((e) => e.approvalStatus === "APPROVED");
  const commonOk = hasUnix ? common.filter((e) => e.approvalStatus === "APPROVED").sort((a, b) => a.incurredOn.localeCompare(b.incurredOn)) : [];
  const allocNote = (propertyId: string) => `${vnd(alloc.total)} ÷ ${alloc.roomTotal} phòng Unix × ${alloc.rooms[propertyId] ?? 0} phòng`;

  // Mỗi cơ sở: chi phí trực tiếp đã duyệt + phần chi phí chung phân bổ (chỉ cơ sở Unix)
  const scopeProps = prop === COMMON ? [] : prop ? props.filter((p) => p.id === prop) : props;
  const groups = scopeProps
    .map((p) => {
      const items = directOk.filter((e) => e.propertyId === p.id);
      const share = alloc.isUnix(p.id) ? alloc.shareOf(p.id) : 0;
      return { id: p.id, label: p.name, items, cats: byCat(items), direct: sum(items), share, total: sum(items) + share };
    })
    .filter((g) => g.items.length || g.share);
  const commonView = prop === COMMON;
  const total = commonView ? alloc.total : groups.reduce((s, g) => s + g.total, 0);
  const count = commonView ? commonOk.length : groups.reduce((s, g) => s + g.items.length, 0);

  const shown = commonView ? commonOk : groups.flatMap((g) => g.items);
  const approverIds = [...new Set([...shown, ...commonOk].map((e) => e.approvedById).filter((v): v is string => !!v))];
  const approverName = Object.fromEntries(
    (approverIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, approverIds)) : []).map((u) => [u.id, u.name]),
  );
  const pendingHere = pending.filter((e) => e.month === month && (prop === COMMON ? e.propertyId === null : prop ? e.propertyId === prop : e.propertyId !== null || hasUnix));
  const scope = commonView ? "chi phí chung (Unix)" : prop ? propName[prop] : "tất cả cơ sở";
  const monthLower = D.formatMonthVN(month).toLowerCase();
  const exportHref = `/expenses/export?${new URLSearchParams({ month, approved: "1", ...(prop ? { prop } : {}) })}`;
  const approver = (e: Row) => (
    <td className="small">{e.approvedById ? approverName[e.approvedById] ?? "—" : "—"}{e.approvedAt && <div className="hint">{D.formatDateVN(D.todayVN(e.approvedAt))}</div>}</td>
  );
  const itemRow = (e: Row) => (
    <tr key={e.id} className="sub">
      <td className="num">{D.formatDateVN(e.incurredOn)}</td>
      <td><Link href={`/expenses/${e.id}`}>{e.description}</Link>{e.bankTransactionId && <span className="hint"> · sao kê</span>}</td>
      <td className="n">{vnd(e.amount)}</td>
      {approver(e)}
      <td><Receipts urls={e.receiptUrls} /></td>
    </tr>
  );
  const draftNote = !alloc.finalized && alloc.total > 0 && (
    <p className="small muted" style={{ margin: "8px 0 0" }}>Chi phí chung {monthLower} chưa hoàn tất kê khai, phần phân bổ có thể còn thay đổi.</p>
  );

  return (
    <>
      <div className="topbar">
        <h1>Chi phí đã duyệt</h1>
        <MonthNav month={month} path="/expenses/approved" extra={prop ? `&prop=${prop}` : ""} />
        <ExpenseTabs current="approved" pending={pending.length} bank={can(user, "importStatement")} month={month} />
        <p className="sub">
          Các khoản đã được duyệt và ghi nhận vào lãi lỗ, theo tháng hạch toán (tháng chi tiền).
          {hasUnix && " Chi phí chung chỉ phân bổ cho các cơ sở Unix, chia đều theo phòng."}
        </p>
      </div>

      <div className="cards">
        <div className="stat"><span className="lbl">Tổng đã duyệt</span><span className="v">{vnd(total)}</span><span className="s">{D.formatMonthVN(month)} · {scope}</span></div>
        {commonView ? (
          <div className="stat"><span className="lbl">Mỗi phòng Unix</span><span className="v">{vnd(Math.round(alloc.perRoom))}</span><span className="s">{vnd(alloc.total)} ÷ {alloc.roomTotal} phòng Unix</span></div>
        ) : (
          <div className="stat"><span className="lbl">Chi phí chung phân bổ</span><span className="v">{vnd(groups.reduce((s, g) => s + g.share, 0))}</span>
            <span className="s">{hasUnix ? `${groups.filter((g) => g.share).length} cơ sở Unix · ${count} khoản trực tiếp` : `Không có cơ sở Unix · ${count} khoản trực tiếp`}</span></div>
        )}
        <div className={`stat${pendingHere.length ? " fc" : ""}`}>
          <span className="lbl">Còn chờ duyệt</span><span className="v">{vnd(sum(pendingHere))}</span>
          <span className="s">{pendingHere.length ? <Link href={`/expenses/pending${prop ? `?prop=${prop}` : ""}`}>{pendingHere.length} khoản chưa tính vào lãi lỗ</Link> : "Không có khoản nào"}</span>
        </div>
      </div>

      <section className="panel">
        <form className="expense-filter" action="/expenses/approved" role="search" aria-label="Lọc chi phí đã duyệt">
          <label className="field"><span>Cơ sở</span>
            <select name="prop" defaultValue={prop}>
              <option value="">Tất cả cơ sở</option>
              {props.map((p) => <option key={p.id} value={p.id}>{p.name}{alloc.isUnix(p.id) ? " · Unix" : ""}</option>)}
              {hasUnix && <option value={COMMON}>Chi phí chung (Unix)</option>}
            </select>
          </label>
          <label className="field"><span>Tháng hạch toán</span><input type="month" name="month" defaultValue={month} /></label>
          <div className="row">
            <button className="btn primary">Xem</button>
            {prop && <Link className="btn" href={`/expenses/approved?month=${month}`}>Xóa lọc</Link>}
            <a className="btn" href={exportHref} download>Tải Excel</a>
          </div>
        </form>

        {commonView ? (
          <>
            <div className="tbl-wrap" style={{ marginBottom: 16 }}><table className="kpi-table">
              <thead><tr><th>Cơ sở Unix</th><th className="n">Số phòng</th><th className="n">Phần chi phí chung</th></tr></thead>
              <tbody>
                {unixProps.map((p) => <tr key={p.id}><td>{p.name}</td><td className="n">{alloc.rooms[p.id] ?? 0}</td><td className="n">{vnd(alloc.shareOf(p.id))}</td></tr>)}
                <tr className="total"><td>Toàn bộ Unix</td><td className="n">{alloc.roomTotal}</td><td className="n">{vnd(alloc.total)}</td></tr>
              </tbody>
            </table></div>
            <CommonItems rows={commonOk} catName={catName} itemRow={itemRow} total={alloc.total} monthLower={monthLower} />
            {draftNote}
          </>
        ) : (
          <>
            {!prop && groups.length > 1 && (
              <div className="tbl-wrap" style={{ marginBottom: 16 }}><table className="kpi-table">
                <thead><tr><th>Cơ sở</th><th className="n">Số khoản</th><th className="n">Chi phí trực tiếp</th><th className="n">Chi phí chung phân bổ</th><th className="n">Tổng</th></tr></thead>
                <tbody>
                  {groups.map((g) => (
                    <tr key={g.id}>
                      <td><Link href={`/expenses/approved?${new URLSearchParams({ month, prop: g.id })}`}>{g.label}</Link></td>
                      <td className="n">{g.items.length}</td><td className="n">{vnd(g.direct)}</td>
                      <td className="n">{alloc.isUnix(g.id) ? vnd(g.share) : <span className="muted">Không chịu</span>}</td>
                      <td className="n"><b>{vnd(g.total)}</b></td>
                    </tr>
                  ))}
                  <tr className="total"><td>Tổng</td><td className="n">{count}</td><td className="n">{vnd(groups.reduce((s, g) => s + g.direct, 0))}</td><td className="n">{vnd(groups.reduce((s, g) => s + g.share, 0))}</td><td className="n">{vnd(total)}</td></tr>
                </tbody>
              </table></div>
            )}

            <div className="tbl-wrap"><table className="kpi-table">
              <thead><tr><th>Ngày phát sinh</th><th>Mô tả</th><th className="n">Số tiền</th><th>Người duyệt</th><th>Hóa đơn</th></tr></thead>
              <tbody>
                {groups.map((g) => [
                  <tr key={g.id} className="grp"><td colSpan={2}>{g.label}</td><td className="n">{vnd(g.total)}</td><td colSpan={2} className="muted small">{g.items.length} khoản{g.share ? " + chi phí chung" : ""}</td></tr>,
                  ...g.cats.flatMap((c) => [
                    <tr key={`${g.id}-${c.id}`} className="sub"><td colSpan={2}><b>{c.name}</b></td><td className="n"><b>{vnd(c.total)}</b></td><td colSpan={2} /></tr>,
                    ...c.list.map(itemRow),
                  ]),
                  ...(g.share ? [
                    <tr key={`${g.id}-common`} className="sub">
                      <td colSpan={2}><b>Chi phí chung (Unix) phân bổ</b><div className="hint">{allocNote(g.id)}</div></td>
                      <td className="n"><b>{vnd(g.share)}</b></td><td colSpan={2} />
                    </tr>,
                  ] : []),
                ])}
                {!groups.length && <tr><td colSpan={5} className="muted small">Chưa có khoản chi nào được duyệt cho {scope} trong {monthLower}.</td></tr>}
                {groups.length > 0 && <tr className="total"><td colSpan={2}>Tổng đã duyệt {monthLower}</td><td className="n">{vnd(total)}</td><td colSpan={2} /></tr>}
              </tbody>
            </table></div>
            {groups.some((g) => g.share) && draftNote}
          </>
        )}
      </section>

      {!commonView && !prop && hasUnix && commonOk.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }}>
          <header><div><h2>Chi tiết chi phí chung (Unix) {monthLower}</h2><p>Đã phân bổ theo phòng vào các cơ sở Unix ở trên, không cộng thêm vào tổng.</p></div></header>
          <CommonItems rows={commonOk} catName={catName} itemRow={itemRow} total={alloc.total} monthLower={monthLower} />
        </section>
      )}
    </>
  );
}

function CommonItems({ rows, catName, itemRow, total, monthLower }: {
  rows: Row[]; catName: Record<string, string>; itemRow: (e: Row) => React.ReactNode; total: number; monthLower: string;
}) {
  const cats = [...new Set(rows.map((e) => e.categoryId))].sort((a, b) => (catName[a] ?? "").localeCompare(catName[b] ?? "", "vi"));
  return (
    <div className="tbl-wrap"><table className="kpi-table">
      <thead><tr><th>Ngày phát sinh</th><th>Mô tả</th><th className="n">Số tiền</th><th>Người duyệt</th><th>Hóa đơn</th></tr></thead>
      <tbody>
        {cats.flatMap((c) => {
          const list = rows.filter((e) => e.categoryId === c);
          return [
            <tr key={c} className="grp"><td colSpan={2}>{catName[c] ?? "Khác"}</td><td className="n">{D.formatVND(list.reduce((s, e) => s + e.amount, 0))}</td><td colSpan={2} /></tr>,
            ...list.map(itemRow),
          ];
        })}
        {!rows.length && <tr><td colSpan={5} className="muted small">Chưa có chi phí chung nào được duyệt trong {monthLower}.</td></tr>}
        {rows.length > 0 && <tr className="total"><td colSpan={2}>Tổng chi phí chung đã duyệt</td><td className="n">{D.formatVND(total)}</td><td colSpan={2} /></tr>}
      </tbody>
    </table></div>
  );
}
