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
  const mine = user.role === "INVESTOR";
  const who = mine ? "Bạn nhận" : "Nhà đầu tư nhận";
  const locked = s.status === "LOCKED";
  const pbPct = pb.investmentTotal ? Math.min(100, Math.max(0, Math.round((pb.received / pb.investmentTotal) * 100))) : 0;
  return (
    <>
      <div className="topbar">
        <h1>Quyết toán</h1>
        <MonthNav month={month} path="/settlements" extra={`&inv=${invId}`} />
        {invs.length > 1 && <div className="chips" style={{ width: "100%" }}>{invs.map((i) => <Link key={i.id} className="chip" aria-pressed={i.id === invId} href={`/settlements?month=${month}&inv=${i.id}`}>{i.name}</Link>)}</div>}
      </div>
      {!locked && s.commonProvisional && <div className="banner">Chi phí chung đang tạm tính theo tháng trước, sẽ được cập nhật khi kê khai xong.</div>}
      <section className="hero">
        <div>
          <div className="row"><span className="cap">{who} {D.formatMonthVN(month).toLowerCase()}</span>{locked ? <span className="pill ok">Đã khóa sổ</span> : <span className="pill fc">Tạm tính</span>}</div>
          <div className={`big ${sign(s.investorNet) === "neg" ? "neg" : ""}`}>{vnd(s.investorNet)}</div>
          <p className="note">{locked ? "Số liệu đã chốt, không thay đổi nữa." : "Số liệu tính đến lúc này và còn có thể thay đổi cho đến khi khóa sổ."}</p>
        </div>
        <dl className="calc">
          <div><dt>Doanh thu</dt><dd>{vnd(s.totalRevenue)}</dd></div>
          <div><dt>Chi phí của cơ sở</dt><dd>− {vnd(s.totalDirectCost)}</dd></div>
          <div><dt>Chi phí chung được chia</dt><dd>− {vnd(s.totalCommonCost)}</dd></div>
          <div><dt>Lợi nhuận</dt><dd className={sign(s.totalProfit)}>{vnd(s.totalProfit)}</dd></div>
          <div><dt>Phí quản lý LOCI (chỉ tính khi có lãi)</dt><dd>− {vnd(s.managementFee)}</dd></div>
          <div className="sum"><dt>{who}</dt><dd className={sign(s.investorNet)}>{vnd(s.investorNet)}</dd></div>
        </dl>
      </section>
      <section className="panel">
        <header><div><h2>Chi tiết từng cơ sở</h2><p>Lợi nhuận = doanh thu + điều chỉnh − chi phí của cơ sở − chi phí chung</p></div></header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Cơ sở</th><th className="n">Số phòng</th><th className="n">Tỷ lệ kín phòng</th><th className="n">Doanh thu</th><th className="n">Điều chỉnh</th><th className="n">Chi phí cơ sở</th><th className="n">Chi phí chung</th><th className="n">Lợi nhuận</th></tr></thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.propertyId}><td><b>{names[l.propertyId] ?? l.propertyId}</b></td><td className="n">{l.roomCount}</td><td className="n">{pct(l)}%</td><td className="n">{vnd(l.nightRevenue)}</td><td className="n">{l.adjustments ? vnd(l.adjustments) : "—"}</td><td className="n">{vnd(l.directCost)}</td><td className="n">{vnd(l.commonCostAlloc)}</td><td className={`n ${sign(l.profit)}`}><b>{vnd(l.profit)}</b></td></tr>
            ))}
            <tr className="total"><td colSpan={7}>Tổng lợi nhuận</td><td className={`n ${sign(s.totalProfit)}`}>{vnd(s.totalProfit)}</td></tr>
          </tbody>
        </table></div>
      </section>
      {can(user, "lockSettlement") && (
        <section className="panel" style={{ marginTop: 24 }}>
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
      <section className="panel" style={{ marginTop: 24 }}>
        <header><div><h2>Hoàn vốn</h2><p>Tính trên các tháng đã khóa sổ</p></div><span className="pill ok">{pbPct}%</span></header>
        <div className="stack" style={{ gap: 8 }}>
          <div className="progress"><i style={{ width: `${pbPct}%` }} /></div>
          <div className="kv"><span>Vốn đầu tư</span><b>{vnd(pb.investmentTotal)}</b></div>
          <div className="kv"><span>Đã nhận về</span><b>{vnd(pb.received)}</b></div>
          <div className="kv"><span>Còn lại</span><b>{vnd(Math.max(0, pb.remaining))}</b></div>
          <div className="small muted">{pb.monthsLeft === null ? "Chưa đủ dữ liệu để ước tính thời gian hoàn vốn" : pb.monthsLeft === 0 ? "Đã hoàn vốn" : `Dự kiến còn khoảng ${pb.monthsLeft} tháng nữa`}</div>
        </div>
      </section>
    </>
  );
}
