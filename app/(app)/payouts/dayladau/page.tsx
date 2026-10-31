// Phiếu thanh toán Dayladau: tiền Dayladau chuyển cho host theo phiếu, đối chiếu từng đơn trong phiếu với đơn trong hệ thống.
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { monthParam, visibleProperties } from "@/lib/queries";
import Link from "next/link";
import { dayladauPayoutsForMonth, DL_PAYOUT_TOLERANCE, type DlAccountView, type DlPayoutLine, type DlPayoutView } from "@/lib/dayladau/payouts";
import { NoAccess } from "@/components/NoAccess";
import { MonthNav, vnd } from "@/components/MonthNav";
import { RunButton } from "../run-button";
import { ChannelTabs } from "../channel-tabs";
import { syncDayladauPayoutsAction } from "../actions";

export const maxDuration = 300;

const MATCH: Record<DlPayoutLine["matchStatus"], [string, string]> = {
  MATCHED: ["Khớp", "ok"],
  AMOUNT_DIFF: ["Lệch tiền", "warn"],
  NOT_FOUND: ["Chưa có trong hệ thống", "bad"],
};

const fmtTime = (d: Date) => d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
const stay = (a: string | null, b: string | null) => (a && b ? (a === b ? D.formatDateVN(a) : `${D.formatDateVN(a)} – ${D.formatDateVN(b)}`) : a ? D.formatDateVN(a) : "—");
const cancelled = (s: string | null) => !!s && /cancel/i.test(s);

function Recon({ lines }: { lines: DlPayoutLine[] }) {
  if (!lines.length) return null;
  const ok = lines.filter((l) => l.matchStatus === "MATCHED").length;
  // Thanh tỷ lệ thay cho một ô mỗi đơn: phiếu Dayladau có vài trăm đơn
  const w = (n: number) => `${(n / lines.length) * 100}%`;
  const diff = lines.filter((l) => l.matchStatus === "AMOUNT_DIFF").length;
  return (
    <span className="dl-recon" role="img" aria-label={`${ok}/${lines.length} đơn khớp`}>
      <i className="ok" style={{ width: w(ok) }} />
      <i className="warn" style={{ width: w(diff) }} />
      <i className="bad" style={{ width: w(lines.length - ok - diff) }} />
    </span>
  );
}

/** Lọc theo host ID: mỗi tài khoản Dayladau một chip, kèm tên để nhận ra nhanh. Chỉ hiện khi có từ 2 tài khoản. */
function HostFilter({ accounts, host, month }: { accounts: DlAccountView[]; host: string | undefined; month: string }) {
  if (accounts.length < 2) return null;
  const href = (h?: string) => `/payouts/dayladau?month=${month}${h ? `&host=${encodeURIComponent(h)}` : ""}`;
  return (
    <nav className="chips host-filter" aria-label="Lọc theo host ID">
      <Link className="chip" aria-pressed={!host} href={href()}>Tất cả host</Link>
      {accounts.map((a) => (
        <Link key={a.id} className="chip" aria-pressed={host === a.hostId} href={href(a.hostId)} title={`${a.investorName}, ${a.label}`}>
          <span className="num">{a.hostId}</span> <span className="muted">{a.label}</span>
        </Link>
      ))}
    </nav>
  );
}

function LineRow({ l, roomName, host }: { l: DlPayoutLine; roomName: Record<string, string>; host?: string }) {
  return (
    <tr>
      <td><b>{l.guestName ?? "Khách"}</b><div className="small muted">#{l.orderId}{l.source ? ` · ${l.source}` : ""}{host ? ` · host ${host}` : ""}</div></td>
      <td>{l.roomId ? roomName[l.roomId] ?? l.listingName : l.listingName ?? "—"}</td>
      <td className="num">{stay(l.checkIn, l.checkOut)}{cancelled(l.orderStatus) && <div className="small muted">Đã hủy, trả phí hủy</div>}</td>
      <td className="n muted">{vnd(l.grossAmount)}</td>
      <td className="n"><b>{vnd(l.amount)}</b>{l.amount > l.grossAmount && <div className="small muted">Dayladau bù giảm giá</div>}</td>
      <td>
        <span className={`pill ${MATCH[l.matchStatus][1]}`}>{MATCH[l.matchStatus][0]}</span>
        {l.bookingNet !== null && l.matchStatus !== "MATCHED" && <div className="small muted">Hệ thống {vnd(l.bookingNet)}</div>}
        {l.diffAmount ? <div className="small neg">Lệch {l.diffAmount > 0 ? "+" : ""}{vnd(l.diffAmount)}</div> : null}
      </td>
    </tr>
  );
}

function PayoutBlock({ p, roomName, multi, month }: { p: DlPayoutView; roomName: Record<string, string>; multi: boolean; month: string }) {
  const problems = p.lines.filter((l) => l.matchStatus !== "MATCHED");
  const matched = p.lines.filter((l) => l.matchStatus === "MATCHED");
  const totalGap = p.amount - p.itemsTotal;
  return (
    <tbody>
      <tr className="payout-head">
        <td colSpan={3}>
          <b>{D.formatDateVN(p.payoutDate)}</b>
          <div className="small muted">
            Phiếu #{p.externalId}, tạo lúc {fmtTime(p.createdAt)}{multi ? `, ${p.investorName} (${p.accountLabel}, host ${p.hostId})` : ""}
            {p.pictureUrl && <> · <a href={p.pictureUrl} target="_blank" rel="noreferrer">Ảnh chuyển khoản</a></>}
          </div>
          {p.status !== "confirmed" && <span className={`pill ${cancelled(p.status) ? "bad" : "warn"}`}>{cancelled(p.status) ? "Phiếu đã hủy" : `Trạng thái: ${p.status}`}</span>}
        </td>
        <td colSpan={2}>
          <span className="row"><Recon lines={p.lines} /><span className="small">{matched.length}/{p.lines.length} đơn khớp</span></span>
          {Math.abs(totalGap) > DL_PAYOUT_TOLERANCE && <div className="small neg">Tổng tiền các đơn {vnd(p.itemsTotal)}, lệch phiếu {vnd(totalGap)}</div>}
        </td>
        <td className="n"><b>{vnd(p.amount)}</b></td>
      </tr>
      {problems.map((l) => <LineRow key={l.id} l={l} roomName={roomName} />)}
      {matched.length > 0 && (
        <tr>
          <td colSpan={6} className="dl-more">
            <details>
              <summary>{problems.length ? `Xem ${matched.length} đơn khớp` : `Cả ${matched.length} đơn đều khớp. Xem danh sách`}</summary>
              <div className="tbl-wrap"><table>
                <tbody>{matched.map((l) => <LineRow key={l.id} l={l} roomName={roomName} />)}</tbody>
              </table></div>
            </details>
          </td>
        </tr>
      )}
      {!p.lines.length && <tr><td colSpan={6} className="small muted">Phiếu không có đơn nào. <a href={`/payouts/dayladau?month=${month}`}>Tải lại</a></td></tr>}
    </tbody>
  );
}

export default async function DayladauPayouts({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFee")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  const host = sp.host?.trim() || undefined;
  const db = getDb();
  let data;
  try {
    const [d, props] = await Promise.all([dayladauPayoutsForMonth(db, user, month, host), visibleProperties(db, user)]);
    data = { ...d, roomName: Object.fromEntries(props.flatMap((p) => p.rooms.map((r) => [r.id, `${p.name} · ${r.name}`]))) as Record<string, string> };
  } catch (e) {
    console.error("[payouts/dayladau] lỗi đọc dữ liệu", e);
    const err = e as Error & { cause?: Error };
    const msg = err.cause?.message ?? err.message ?? String(e);
    return (
      <>
        <div className="topbar"><h1>Thanh toán Dayladau</h1><ChannelTabs month={month} channel="dayladau" /></div>
        <div className="banner bad" role="alert">
          <div>
            <b>Không đọc được dữ liệu thanh toán Dayladau.</b>
            {can(user, "admin") && /column|relation|does not exist/i.test(msg)
              ? <div className="small">Cơ sở dữ liệu thiếu bảng mới: chạy <code>npm run db:migrate</code> trên máy chủ rồi tải lại trang.</div>
              : <div className="small">Báo Admin để kiểm tra.</div>}
          </div>
        </div>
      </>
    );
  }
  const { payouts, pending, accounts, roomName } = data;
  const picked = host ? accounts.find((a) => a.hostId === host) : undefined;
  // Đang lọc một host thì không cần nhắc lại tên tài khoản trên từng phiếu
  const multi = !picked && accounts.length > 1;
  const lines = payouts.filter((p) => !cancelled(p.status)).flatMap((p) => p.lines);
  const total = payouts.filter((p) => !cancelled(p.status)).reduce((s, p) => s + p.amount, 0);
  const matched = lines.filter((l) => l.matchStatus === "MATCHED").length;
  const diffs = lines.filter((l) => l.matchStatus === "AMOUNT_DIFF");
  const missing = lines.filter((l) => l.matchStatus === "NOT_FOUND");
  const pendingTotal = pending.reduce((s, l) => s + l.amount, 0);

  return (
    <>
      <div className="topbar">
        <h1>Thanh toán Dayladau</h1>
        <MonthNav month={month} path="/payouts/dayladau" extra={host ? `&host=${encodeURIComponent(host)}` : ""} />
        <p className="sub">Tiền Dayladau chuyển cho host theo phiếu (đơn đặt qua app, web, CTV của Dayladau), đối chiếu từng đơn với đơn trong hệ thống. Đơn Airbnb, Booking.com không nằm trong phiếu này.</p>
        <ChannelTabs month={month} channel="dayladau" />
      </div>

      <HostFilter accounts={accounts} host={host} month={month} />
      {host && !picked && <div className="banner" role="status">Không có tài khoản Dayladau nào có host ID {host}. <Link href={`/payouts/dayladau?month=${month}`}>Xem tất cả host</Link></div>}

      {accounts.length > 0 && (!host || picked) && (
        <div className="row" style={{ marginBottom: 16 }}>
          <RunButton run={syncDayladauPayoutsAction.bind(null, { month, accountId: picked?.id })} label={`Lấy phiếu ${D.formatMonthVN(month).toLowerCase()}${picked ? ` của host ${picked.hostId}` : ""}`} pendingLabel="Đang lấy từ Dayladau…" />
          <span className="small muted">Tự lấy lúc 15:00 hằng ngày (phiếu 45 ngày gần nhất).</span>
        </div>
      )}
      {!accounts.length && <div className="banner">Chưa có tài khoản Dayladau nào đang bật. Admin thêm ở trang Kết nối Dayladau.</div>}

      <div className="cards">
        <div className="stat"><span className="lbl">Dayladau đã chuyển</span><span className="v">{vnd(total)}</span><span className="s">{payouts.length} phiếu trong {D.formatMonthVN(month).toLowerCase()}{picked ? `, host ${picked.hostId}` : ""}</span></div>
        <div className="stat"><span className="lbl">Đơn khớp</span><span className="v">{matched}/{lines.length}</span><span className="s">Đúng đơn và đúng số tiền</span></div>
        <div className="stat"><span className="lbl">Lệch tiền</span><span className="v">{diffs.length}</span><span className="s">{diffs.length ? `Tổng lệch ${vnd(diffs.reduce((s, l) => s + (l.diffAmount ?? 0), 0))}` : "Tiền Dayladau trả khác thực nhận trong hệ thống"}</span></div>
        <div className="stat"><span className="lbl">Chưa có trong hệ thống</span><span className="v">{missing.length}</span><span className="s">{missing.length ? `${vnd(missing.reduce((s, l) => s + l.amount, 0))} chưa ghi doanh thu` : "Đơn được trả nhưng app chưa có"}</span></div>
      </div>

      <section className="panel">
        <header><div><h2>Đối chiếu theo phiếu</h2><p>Mỗi phiếu gộp các đơn đã trả phòng trong tuần. Đơn lệch hoặc chưa có trong hệ thống hiện trước; đơn khớp gói lại bên dưới. Số lệch = tiền Dayladau trả cho đơn − thực nhận đang ghi trong hệ thống.</p></div></header>
        <div className="tbl-wrap"><table className="payouts">
          <thead><tr><th>Khách</th><th>Phòng</th><th>Ngày ở</th><th className="n">Khách trả</th><th className="n">Dayladau trả</th><th>Đối chiếu</th></tr></thead>
          {payouts.map((p) => <PayoutBlock key={p.id} p={p} roomName={roomName} multi={multi} month={month} />)}
          {!payouts.length && <tbody><tr><td colSpan={6} className="muted small">{accounts.length ? "Chưa có phiếu nào trong tháng. Bấm Lấy phiếu để tải từ Dayladau." : "Chưa có tài khoản Dayladau."}</td></tr></tbody>}
        </table></div>
      </section>

      {pending.length > 0 && (
        <section className="panel" style={{ marginTop: 24 }}>
          <header><div><h2>Đơn chờ Dayladau trả</h2><p>{pending.length} đơn, {vnd(pendingTotal)}. Dayladau sẽ gộp vào phiếu kế tiếp, thường sáng thứ Hai.</p></div></header>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Khách</th><th>Phòng</th><th>Ngày ở</th><th className="n">Khách trả</th><th className="n">Dayladau sẽ trả</th><th>Đối chiếu</th></tr></thead>
            <tbody>{pending.map((l) => <LineRow key={l.id} l={l} roomName={roomName} host={multi ? l.hostId : undefined} />)}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
