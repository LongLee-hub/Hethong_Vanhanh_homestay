import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { getSettlement, paybackForInvestor } from "@/lib/services/settlement";
import { visibleInvestors, visibleProperties, monthParam } from "@/lib/queries";
import { MonthNav, sign, vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { lockAction, unlockAction } from "../actions";

export default async function Settlements({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!can(user, "viewFee")) return <NoAccess />;
  const db = getDb();
  const month = monthParam(sp.month);
  const invs = await visibleInvestors(db, user);
  if (!invs.length) return <div className="empty">Không có nhà đầu tư nào trong phạm vi được xem.</div>;
  const invId = invs.some((i) => i.id === sp.inv) ? sp.inv : invs[0].id;
  const s = await getSettlement(db, user, invId, month);
  const pb = await paybackForInvestor(db, user, invId);
  const names = Object.fromEntries((await visibleProperties(db, user)).map((p) => [p.id, p.name]));
  const pct = (l: (typeof s.lines)[number]) => (l.availableNights ? Math.round((l.soldNights / l.availableNights) * 1000) / 10 : 0);
  return (
    <>
      <div className="topbar">
        <h1>Quyết toán</h1>
        <MonthNav month={month} path="/settlements" extra={`&inv=${invId}`} />
        <div className="chips">{invs.map((i) => <Link key={i.id} className="chip" aria-pressed={i.id === invId} href={`/settlements?month=${month}&inv=${i.id}`}>{i.name}</Link>)}</div>
      </div>
      {s.status === "LOCKED" ? <div className="banner info">Đã khóa sổ. Số liệu đọc từ bản đã chốt, không tính lại.</div> : s.commonProvisional ? <div className="banner">Chi phí chung đang tạm tính theo tháng trước.</div> : null}
      <div className="cards">
        <div className="stat"><span className="lbl">Doanh thu</span><span className="v">{vnd(s.totalRevenue)}</span></div>
        <div className="stat"><span className="lbl">Chi phí trực tiếp</span><span className="v">{vnd(s.totalDirectCost)}</span></div>
        <div className="stat"><span className="lbl">Chi phí chung</span><span className="v">{vnd(s.totalCommonCost)}</span></div>
        <div className="stat"><span className="lbl">Lợi nhuận</span><span className={`v ${sign(s.totalProfit)}`}>{vnd(s.totalProfit)}</span></div>
        <div className="stat"><span className="lbl">Phí quản lý</span><span className="v">{vnd(s.managementFee)}</span></div>
        <div className="stat"><span className="lbl">NĐT nhận</span><span className={`v ${sign(s.investorNet)}`}>{vnd(s.investorNet)}</span></div>
      </div>
      <section className="panel">
        <div className="tbl-wrap"><table>
          <thead><tr><th>Cơ sở</th><th className="n">Phòng</th><th className="n">Công suất</th><th className="n">DT đêm</th><th className="n">Điều chỉnh</th><th className="n">CP trực tiếp</th><th className="n">CP chung</th><th className="n">Lợi nhuận</th></tr></thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.propertyId}><td>{names[l.propertyId] ?? l.propertyId}</td><td className="n">{l.roomCount}</td><td className="n">{pct(l)}%</td><td className="n">{vnd(l.nightRevenue)}</td><td className="n">{l.adjustments ? vnd(l.adjustments) : "—"}</td><td className="n">{vnd(l.directCost)}</td><td className="n">{vnd(l.commonCostAlloc)}</td><td className={`n ${sign(l.profit)}`}><b>{vnd(l.profit)}</b></td></tr>
            ))}
            <tr className="total"><td colSpan={7}>Lợi nhuận tổng</td><td className="n">{vnd(s.totalProfit)}</td></tr>
            <tr><td colSpan={7}>Phí quản lý (chỉ tính khi lãi)</td><td className="n">− {vnd(s.managementFee)}</td></tr>
            <tr className="total"><td colSpan={7}>NĐT nhận</td><td className={`n ${sign(s.investorNet)}`}>{vnd(s.investorNet)}</td></tr>
          </tbody>
        </table></div>
      </section>
      {can(user, "lockSettlement") && (
        <section className="panel" style={{ marginTop: 16 }}>
          {s.status !== "LOCKED" ? (
            <ActionForm action={lockAction} submit={`Khóa sổ ${D.formatMonthVN(month).toLowerCase()}`} okText="Đã khóa sổ" className="row">
              <input type="hidden" name="investorId" value={invId} /><input type="hidden" name="month" value={month} />
            </ActionForm>
          ) : (
            <ActionForm action={unlockAction} submit="Mở khóa" okText="Đã mở khóa">
              <input type="hidden" name="investorId" value={invId} /><input type="hidden" name="month" value={month} />
              <label className="field full"><span>Lý do mở khóa (bắt buộc)</span><input type="text" name="reason" id="reason" /></label>
            </ActionForm>
          )}
        </section>
      )}
      <section className="panel" style={{ marginTop: 16 }}>
        <header><h2>Hoàn vốn</h2></header>
        <p className="small">Vốn {vnd(pb.investmentTotal)} · đã nhận {vnd(pb.received)} · còn lại {vnd(pb.remaining)} · {pb.monthsLeft === null ? "chưa xác định thời gian" : pb.monthsLeft === 0 ? "đã hoàn vốn" : `dự kiến ${pb.monthsLeft} tháng`}</p>
      </section>
    </>
  );
}
