import { inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { investors } from "@/lib/db/schema";
import { allowedInvestorIds, can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { monthParam, visibleProperties } from "@/lib/queries";
import { canManageGmail, listGmailAccounts, MISSING_AFTER_DAYS, PAYOUT_TOLERANCE, payoutsForMonth, type PayoutView } from "@/lib/airbnb/payouts";
import { gmailConfigured } from "@/lib/gmail/oauth";
import { NoAccess } from "@/components/NoAccess";
import { MonthNav, vnd } from "@/components/MonthNav";
import { disconnectGmailAction, reparsePayoutAction, syncGmailAction } from "./actions";
import { RunButton } from "./run-button";

export const maxDuration = 300;

const MATCH: Record<string, [string, string]> = {
  MATCHED: ["Khớp", "ok"],
  AMOUNT_DIFF: ["Lệch tiền", "warn"],
  NOT_FOUND: ["Chưa thấy đơn", "bad"],
};
const PARSE: Record<string, [string, string] | null> = {
  OK: null,
  PARTIAL: ["Tách được một phần", "warn"],
  FAILED: ["Không tách được", "bad"],
};

const fmtTime = (d: Date | null) => (d ? d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }) : "chưa đọc");
const dates = (a: string | null, b: string | null) => (a && b ? `${D.formatDateVN(a)} – ${D.formatDateVN(b)}` : a ? D.formatDateVN(a) : "—");

/** Thanh đối soát của một payout: mỗi đoạn là một đơn, tô theo trạng thái khớp. */
function Recon({ p }: { p: PayoutView }) {
  if (!p.items.length) return null;
  return (
    <span className="recon" role="img" aria-label={`${p.items.filter((i) => i.matchStatus === "MATCHED").length}/${p.items.length} đơn khớp`}>
      {p.items.map((i) => <i key={i.id} className={MATCH[i.matchStatus][1]} />)}
    </span>
  );
}

function PayoutRows({ p, roomName, multiInvestor }: { p: PayoutView; roomName: Record<string, string>; multiInvestor: boolean }) {
  const parse = PARSE[p.parseStatus];
  const vndPayout = p.currency === "VND";
  // Email không ghi tiền từng đơn: so tổng payout với tổng thực nhận của các đơn đã khớp
  const noItemAmounts = p.items.length > 0 && p.items.every((i) => i.amount === null);
  const totalDiff = vndPayout && p.items.length && p.items.every((i) => i.booking) ? p.amount - p.matchedNet : null;
  return (
    <tbody>
      <tr className="payout-head">
        <td colSpan={2}>
          <b>{D.formatDateVN(p.payoutDate)}</b>
          <div className="small muted">{multiInvestor ? `${p.investorName} · ` : ""}{p.email}</div>
        </td>
        <td colSpan={2}>
          <span className="row"><Recon p={p} />{parse && <span className={`pill ${parse[1]}`}>{parse[0]}</span>}</span>
          {p.parseNote && <div className="small muted">{p.parseNote}</div>}
          {p.canManage && p.parseStatus !== "OK" && <div style={{ marginTop: 8 }}><RunButton run={reparsePayoutAction.bind(null, p.id)} label="Tách lại" pendingLabel="Đang tách…" /></div>}
        </td>
        <td className="n"><b>{vndPayout ? vnd(p.amount) : `${p.amount.toLocaleString("vi-VN")} ${p.currency}`}</b></td>
        <td className="n">
          {totalDiff !== null && (noItemAmounts || Math.abs(totalDiff) > PAYOUT_TOLERANCE)
            ? <span className={Math.abs(totalDiff) > PAYOUT_TOLERANCE ? "neg" : "pos"}>{totalDiff > 0 ? "+" : ""}{vnd(totalDiff)}</span>
            : null}
        </td>
      </tr>
      {p.items.map((i) => (
        <tr key={i.id}>
          <td><b>{i.booking?.guestName ?? i.guestName ?? "Khách"}</b><div className="small muted">{i.confirmationCode ?? "Không có mã"}</div></td>
          <td>{i.booking ? roomName[i.booking.roomId] ?? "—" : <span className="muted">—</span>}</td>
          <td className="num">{i.booking ? dates(i.booking.checkIn, i.booking.checkOut) : dates(i.checkIn, i.checkOut)}</td>
          <td><span className={`pill ${MATCH[i.matchStatus][1]}`}>{MATCH[i.matchStatus][0]}</span>{i.booking?.status === "CANCELLED" && <div className="small muted">Đơn đã hủy, có phí hủy</div>}</td>
          <td className="n">{i.amount !== null ? vnd(i.amount) : <span className="muted">—</span>}<div className="small muted">{i.booking ? `Hệ thống: ${vnd(i.booking.netAmount)}` : ""}</div></td>
          <td className="n">{i.diffAmount ? <span className={Math.abs(i.diffAmount) > PAYOUT_TOLERANCE ? "neg" : "muted"}>{i.diffAmount > 0 ? "+" : ""}{vnd(i.diffAmount)}</span> : ""}</td>
        </tr>
      ))}
      {!p.items.length && <tr><td colSpan={6} className="small muted">Email không có mã đặt phòng nào. {p.subject}</td></tr>}
    </tbody>
  );
}

export default async function Payouts({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFee")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  const db = getDb();
  const [accounts, { payouts, missing }, props, invIds] = await Promise.all([
    listGmailAccounts(db, user),
    payoutsForMonth(db, user, month),
    visibleProperties(db, user),
    allowedInvestorIds(db, user),
  ]);
  const invs = invIds.length ? await db.select({ id: investors.id, name: investors.name }).from(investors).where(inArray(investors.id, invIds)).orderBy(investors.name) : [];
  const manageable = (await Promise.all(invs.map(async (i) => ((await canManageGmail(db, user, i.id)) ? i : null)))).filter((i) => i !== null);
  const roomName = Object.fromEntries(props.flatMap((p) => p.rooms.map((r) => [r.id, `${p.name} · ${r.name}`])));
  const multiInvestor = invs.length > 1;
  const configured = gmailConfigured();

  const items = payouts.flatMap((p) => p.items);
  const matched = items.filter((i) => i.matchStatus === "MATCHED").length;
  const diffs = items.filter((i) => i.matchStatus === "AMOUNT_DIFF");
  const total = payouts.filter((p) => p.currency === "VND").reduce((s, p) => s + p.amount, 0);

  return (
    <>
      <div className="topbar">
        <h1>Payout Airbnb</h1>
        <MonthNav month={month} path="/payouts" />
        <p className="sub">Tiền Airbnb đã chuyển, đọc từ email payout trong Gmail của nhà đầu tư, đối chiếu với từng đơn trong hệ thống.</p>
      </div>
      {sp.connected && <div className="banner info" role="status">{sp.connected}</div>}
      {sp.gmail && <div className="banner bad" role="alert">{sp.gmail}</div>}
      {!configured && <div className="banner">Máy chủ chưa cấu hình đăng nhập Google (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET), chưa kết nối được Gmail. Xem hướng dẫn trong README.</div>}

      <div className="cards">
        <div className="stat"><span className="lbl">Airbnb đã chuyển</span><span className="v">{vnd(total)}</span><span className="s">{payouts.length} lần chuyển trong {D.formatMonthVN(month).toLowerCase()}</span></div>
        <div className="stat"><span className="lbl">Đơn khớp</span><span className="v">{matched}/{items.length}</span><span className="s">Đúng đơn và đúng số tiền</span></div>
        <div className="stat"><span className="lbl">Lệch tiền</span><span className="v">{diffs.length}</span><span className="s">{diffs.length ? `Tổng lệch ${vnd(diffs.reduce((s, i) => s + (i.diffAmount ?? 0), 0))}` : `Chênh dưới ${vnd(PAYOUT_TOLERANCE)} coi là khớp`}</span></div>
        <div className="stat"><span className="lbl">Chưa thấy payout</span><span className="v">{missing.length}</span><span className="s">Đơn Airbnb nhận phòng quá {MISSING_AFTER_DAYS} ngày</span></div>
      </div>

      <section className="panel">
        <header><div><h2>Đối soát theo lần chuyển tiền</h2><p>Mỗi email payout có thể gộp nhiều đơn. Số lệch = Airbnb chuyển − thực nhận đang ghi trong hệ thống.</p></div></header>
        <div className="tbl-wrap"><table className="payouts">
          <thead><tr><th>Khách</th><th>Phòng</th><th>Nhận – trả phòng</th><th>Đối soát</th><th className="n">Airbnb chuyển</th><th className="n">Lệch</th></tr></thead>
          {payouts.map((p) => <PayoutRows key={p.id} p={p} roomName={roomName} multiInvestor={multiInvestor} />)}
          {!payouts.length && <tbody><tr><td colSpan={6} className="muted small">{accounts.some((a) => a.active) ? "Chưa có email payout nào trong tháng." : "Kết nối Gmail ở bên dưới để đọc email payout."}</td></tr></tbody>}
        </table></div>
      </section>

      {missing.length > 0 && (
        <section className="panel" style={{ marginTop: 24 }}>
          <header><div><h2>Đơn Airbnb chưa thấy payout</h2><p>Airbnb thường chuyển tiền khoảng một ngày sau giờ nhận phòng. Đơn dưới đây đã quá {MISSING_AFTER_DAYS} ngày mà chưa có trong email payout nào.</p></div></header>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Khách</th><th>Phòng</th><th>Nhận – trả phòng</th><th className="n">Thực nhận</th></tr></thead>
            <tbody>
              {missing.map((m) => (
                <tr key={m.bookingId}>
                  <td><b>{m.guestName ?? "Khách"}</b><div className="small muted">{m.externalId ?? ""}{multiInvestor ? ` · ${m.investorName}` : ""}</div></td>
                  <td>{roomName[m.roomId] ?? "—"}</td>
                  <td className="num">{dates(m.checkIn, m.checkOut)}</td>
                  <td className="n">{vnd(m.netAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </section>
      )}

      <section className="panel" style={{ marginTop: 24 }}>
        <header><div><h2>Gmail nhận payout</h2><p>Mỗi nhà đầu tư kết nối Gmail đang nhận email của tài khoản Airbnb. App chỉ có quyền đọc thư, tự đọc email payout mới mỗi lần đồng bộ.</p></div></header>
        <ul className="gmail-list">
          {invs.map((inv) => {
            const accs = accounts.filter((a) => a.investorId === inv.id);
            const canConnect = configured && manageable.some((m) => m.id === inv.id);
            return (
              <li key={inv.id}>
                <div className="gmail-inv">
                  <b>{inv.name}</b>
                  {canConnect && <a className="btn sm" href={`/api/gmail/connect?investorId=${encodeURIComponent(inv.id)}`}>{accs.some((a) => a.active) ? "Thêm Gmail" : "Kết nối Gmail"}</a>}
                </div>
                {accs.map((a) => (
                  <div key={a.id} className="gmail-acc">
                    <div>
                      <span>{a.email}</span>{" "}
                      {!a.active ? <span className="pill">Đã ngắt</span> : a.lastSyncStatus === "FAILED" ? <span className="pill bad">Lỗi</span> : <span className="pill ok">Đang kết nối</span>}
                      <div className="small muted">Đọc lần cuối: {fmtTime(a.lastSyncedAt)}</div>
                      {a.active && a.lastSyncError && <div className="small neg">{a.lastSyncError}</div>}
                    </div>
                    {a.canManage && a.active && (
                      <span className="row">
                        <RunButton run={syncGmailAction.bind(null, a.id)} label="Đọc thư ngay" pendingLabel="Đang đọc…" />
                        <RunButton run={disconnectGmailAction.bind(null, a.id)} label="Ngắt kết nối" pendingLabel="Đang ngắt…" danger confirm={`Ngắt kết nối ${a.email}? Các payout đã đọc vẫn được giữ.`} />
                      </span>
                    )}
                  </div>
                ))}
                {!accs.length && <div className="small muted">Chưa kết nối Gmail.</div>}
              </li>
            );
          })}
          {!invs.length && <li className="small muted">Chưa có nhà đầu tư nào.</li>}
        </ul>
      </section>
    </>
  );
}
