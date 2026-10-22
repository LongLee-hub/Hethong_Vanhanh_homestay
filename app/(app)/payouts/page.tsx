import { inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { investors } from "@/lib/db/schema";
import { allowedInvestorIds, can, type SessionUser } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { monthParam, visibleProperties } from "@/lib/queries";
import Link from "next/link";
import { canManageGmail, listGmailAccounts, MISSING_AFTER_DAYS, PAYOUT_TOLERANCE_PCT, payoutRevenueByMonth, payoutsForMonth, type MonthlyPayoutRow, type PayoutBookingGroup, type PayoutView } from "@/lib/airbnb/payouts";
import { extractNickname, TAX_TYPES } from "@/lib/airbnb/payout-parser";
import { headers } from "next/headers";
import { googleReady, googleSetup, loadGoogleConfig } from "@/lib/gmail/config";
import { redirectUri } from "@/lib/gmail/oauth";
import { ActionForm } from "@/components/ActionForm";
import { NoAccess } from "@/components/NoAccess";
import { MonthNav, vnd } from "@/components/MonthNav";
import { deletePastedAction, disconnectGmailAction, reparsePayoutAction, saveGoogleSetupAction, syncGmailAction } from "./actions";
import { BackfillGmail, CopyField, PastePayout, usd } from "./setup";
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
  const gs = p.groups.filter((g) => g.confirmationCode);
  if (!gs.length) return null;
  return (
    <span className="recon" role="img" aria-label={`${gs.filter((g) => g.matchStatus === "MATCHED").length}/${gs.length} đơn khớp`}>
      {gs.map((g) => <i key={g.key} className={MATCH[g.matchStatus][1]} />)}
    </span>
  );
}

function Diff({ g }: { g: PayoutBookingGroup }) {
  if (!g.booking) return <span className={`pill ${MATCH.NOT_FOUND[1]}`}>{MATCH.NOT_FOUND[0]}</span>;
  return (
    <>
      <span className={`pill ${MATCH[g.matchStatus][1]}`}>{MATCH[g.matchStatus][0]}</span>
      <div className="small muted">Hệ thống {vnd(g.booking.netAmount)}</div>
      {g.diffAmount ? <div className={`small ${g.matchStatus === "AMOUNT_DIFF" ? "neg" : "muted"}`}>Lệch {g.diffAmount > 0 ? "+" : ""}{vnd(g.diffAmount)}</div> : null}
      {g.booking.status === "CANCELLED" && <div className="small muted">Đơn đã hủy, có phí hủy</div>}
    </>
  );
}

function PayoutRows({ p, roomName, multiInvestor }: { p: PayoutView; roomName: Record<string, string>; multiInvestor: boolean }) {
  const parse = PARSE[p.parseStatus];
  return (
    <tbody>
      <tr className="payout-head">
        <td colSpan={3}>
          <b>{D.formatDateVN(p.payoutDate)}</b>
          <div className="small muted">
            {multiInvestor ? `${p.investorName} · ` : ""}{p.email ?? "Dán tay"}
            {p.payoutCode ? ` · mã chi trả ${p.payoutCode}` : ""}
            {p.exchangeRate ? ` · tỷ giá ${Math.round(p.exchangeRate).toLocaleString("vi-VN")}` : ""}
          </div>
          {p.canManage && (p.parseStatus !== "OK" || !p.email) && (
            <div className="row" style={{ marginTop: 8 }}>
              {p.parseStatus !== "OK" && <RunButton run={reparsePayoutAction.bind(null, p.id)} label="Tách lại" pendingLabel="Đang tách…" />}
              {!p.email && <RunButton run={deletePastedAction.bind(null, p.id)} label="Xóa" pendingLabel="Đang xóa…" danger confirm="Xóa payout dán tay này?" />}
            </div>
          )}
        </td>
        <td>
          <span className="row"><Recon p={p} />{parse && <span className={`pill ${parse[1]}`}>{parse[0]}</span>}</span>
          {p.parseNote && <div className="small muted">{p.parseNote}</div>}
        </td>
        <td className="n">{p.totalUsd !== null ? usd(p.totalUsd) : ""}</td>
        <td className="n"><b>{vnd(p.amount)}</b></td>
        <td />
      </tr>
      {p.groups.map((g) => (
        <tr key={g.key}>
          <td><b>{g.booking?.guestName ?? g.guestName ?? "Khách"}</b><div className="small muted">{g.confirmationCode ?? "Không có mã"}</div></td>
          <td>{g.booking ? roomName[g.booking.roomId] ?? "—" : <span className="muted">{extractNickname(g.listingName) || "—"}</span>}</td>
          <td className="num">{dates(g.checkIn, g.checkOut)}</td>
          <td>
            <ul className="pay-lines">
              {g.lines.map((l) => <li key={l.id} className={l.lineType && TAX_TYPES.has(l.lineType) ? "tax" : undefined}><span>{l.lineType ?? "Khác"}</span><span className="num">{l.amount !== null ? vnd(l.amount) : usd(l.usdAmount)}</span></li>)}
            </ul>
          </td>
          <td className="n">{usd(g.usd)}</td>
          <td className="n"><b>{g.vnd !== null ? vnd(g.vnd) : "—"}</b>{g.taxVnd ? <div className="small muted">Trước thuế {vnd(g.preTaxVnd ?? 0)}</div> : null}</td>
          <td><Diff g={g} /></td>
        </tr>
      ))}
      {!p.groups.length && <tr><td colSpan={7} className="small muted">Không đọc được dòng giao dịch nào. {p.subject}</td></tr>}
    </tbody>
  );
}

function MonthlyRevenue({ rows, roomName, multiInvestor, month }: { rows: MonthlyPayoutRow[]; roomName: Record<string, string>; multiInvestor: boolean; month: string }) {
  const total = (k: "vnd" | "preTaxVnd" | "taxVnd") => rows.reduce((s, r) => s + r[k], 0);
  return (
    <>
      <div className="cards">
        <div className="stat"><span className="lbl">Thực nhận từ Airbnb</span><span className="v">{vnd(total("vnd"))}</span><span className="s">Phần đêm ở trong {D.formatMonthVN(month).toLowerCase()}, sau thuế</span></div>
        <div className="stat"><span className="lbl">Trước thuế</span><span className="v">{vnd(total("preTaxVnd"))}</span><span className="s">Tiền phòng và phí dọn</span></div>
        <div className="stat"><span className="lbl">Thuế Airbnb khấu trừ</span><span className="v">{vnd(-total("taxVnd"))}</span><span className="s">Thuế TNCN và VAT</span></div>
        <div className="stat"><span className="lbl">Đơn</span><span className="v">{rows.filter((r) => !r.noDates).length}</span><span className="s">{rows.filter((r) => r.nights !== null && r.nights !== r.totalNights).length} đơn trải sang tháng khác</span></div>
      </div>
      <section className="panel">
        <header><div><h2>Doanh thu theo tháng ở</h2><p>Gộp mọi email payout theo mã đặt phòng. Đơn trải nhiều tháng chia theo số đêm, phần cuối nhận phần dư. Dòng không có ngày ở tính vào tháng chuyển tiền.</p></div></header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Khách</th><th>Phòng</th><th>Đêm trong tháng</th><th>Ngày gửi tiền</th><th className="n">Trước thuế</th><th className="n">Thuế</th><th className="n">Thực nhận</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.nights !== null && r.nights !== r.totalNights ? "split" : undefined}>
                <td><b>{r.guestName ?? "Khách"}</b><div className="small muted">{r.confirmationCode ?? "Không có mã"}{multiInvestor ? ` · ${r.investorName}` : ""}</div></td>
                <td>{r.roomId ? roomName[r.roomId] ?? r.nickname : r.nickname || "—"}</td>
                <td className="num">
                  {r.noDates ? <span className="muted">Không có ngày ở</span> : dates(r.partCheckIn, r.partCheckOut)}
                  {r.nights !== null && r.nights !== r.totalNights && <div className="small muted">{r.nights}/{r.totalNights} đêm · cả kỳ {dates(r.checkIn, r.checkOut)}</div>}
                </td>
                <td className="num">{D.formatDateVN(r.lastPayoutDate)}</td>
                <td className="n">{vnd(r.preTaxVnd)}</td>
                <td className="n muted">{r.taxVnd ? vnd(r.taxVnd) : ""}</td>
                <td className="n"><b>{vnd(r.vnd)}</b></td>
              </tr>
            ))}
            {rows.length > 0 && <tr className="total"><td colSpan={4}>Tổng</td><td className="n">{vnd(total("preTaxVnd"))}</td><td className="n">{vnd(total("taxVnd"))}</td><td className="n">{vnd(total("vnd"))}</td></tr>}
            {!rows.length && <tr><td colSpan={7} className="muted small">Chưa có payout nào có đêm ở trong tháng.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  );
}

function ViewTabs({ month, view }: { month: string; view: "payout" | "month" }) {
  return (
    <div className="chips" style={{ width: "100%" }}>
      <Link className="chip" aria-pressed={view === "payout"} href={`/payouts?month=${month}`}>Theo lần chuyển tiền</Link>
      <Link className="chip" aria-pressed={view === "month"} href={`/payouts?month=${month}&view=month`}>Theo tháng ở</Link>
    </div>
  );
}

/** Đọc toàn bộ dữ liệu của trang; lỗi được bắt ở trang để báo cho Admin thay vì sập cả trang. */
async function loadPayoutPage(user: SessionUser, month: string, view: "payout" | "month") {
  const db = getDb();
  const [accounts, { payouts, missing }, monthly, props, invIds] = await Promise.all([
    listGmailAccounts(db, user),
    payoutsForMonth(db, user, month),
    view === "month" ? payoutRevenueByMonth(db, user, month) : Promise.resolve([]),
    visibleProperties(db, user),
    allowedInvestorIds(db, user),
  ]);
  const invs = invIds.length ? await db.select({ id: investors.id, name: investors.name }).from(investors).where(inArray(investors.id, invIds)).orderBy(investors.name) : [];
  const manageable = (await Promise.all(invs.map(async (i) => ((await canManageGmail(db, user, i.id)) ? i : null)))).filter((i) => i !== null);
  const roomName = Object.fromEntries(props.flatMap((p) => p.rooms.map((r) => [r.id, `${p.name} · ${r.name}`])));
  const multiInvestor = invs.length > 1;
  const cfg = await loadGoogleConfig(db);
  const configured = googleReady(cfg);
  const isAdmin = can(user, "admin");
  const setup = isAdmin ? await googleSetup(db, user) : null;
  const h = await headers();
  const reqOrigin = `${(h.get("x-forwarded-proto") ?? "http").split(",")[0]}://${(h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000").split(",")[0]}`;
  const callback = redirectUri(cfg, reqOrigin);
  return { accounts, payouts, missing, monthly, invs, manageable, roomName, multiInvestor, cfg, configured, isAdmin, setup, reqOrigin, callback };
}

export default async function Payouts({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFee")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  const view = sp.view === "month" ? "month" : "payout";
  const isAdmin = can(user, "admin");
  let data;
  try {
    data = await loadPayoutPage(user, month, view);
  } catch (e) {
    // Không để cả trang sập: báo đúng lỗi cho Admin (thường gặp: máy chủ chưa chạy npm run db:migrate)
    console.error("[payouts] lỗi đọc dữ liệu", e);
    // drizzle bọc lỗi thành "Failed query: <câu SQL>", nguyên nhân thật nằm ở cause
    const err = e as Error & { cause?: Error };
    const msg = err.cause?.message ?? err.message ?? String(e);
    return (
      <>
        <div className="topbar"><h1>Payout Airbnb</h1></div>
        {sp.gmail && <div className="banner bad" role="alert">{sp.gmail}</div>}
        <div className="banner bad" role="alert">
          <div>
            <b>Không đọc được dữ liệu payout.</b>
            {isAdmin
              ? <><div className="small" style={{ marginTop: 4, overflowWrap: "anywhere" }}>{msg.slice(0, 500)}</div>
                  {/column|relation|does not exist|không tồn tại/i.test(msg) && <div className="small" style={{ marginTop: 4 }}>Cơ sở dữ liệu thiếu bảng hoặc cột mới: chạy <code>npm run db:migrate</code> trên máy chủ rồi tải lại trang.</div>}</>
              : <div className="small">Báo Admin để kiểm tra.</div>}
          </div>
        </div>
        <a className="btn" href={`/payouts?month=${month}`}>Tải lại</a>
      </>
    );
  }
  const { accounts, payouts, missing, monthly, invs, manageable, roomName, multiInvestor, configured, setup, reqOrigin, callback } = data;

  const groups = payouts.flatMap((p) => p.groups).filter((g) => g.confirmationCode);
  const matched = groups.filter((g) => g.matchStatus === "MATCHED").length;
  const diffs = [...new Map(groups.filter((g) => g.matchStatus === "AMOUNT_DIFF" && g.booking).map((g) => [g.booking!.id, g])).values()];
  const total = payouts.filter((p) => p.currency === "VND").reduce((s, p) => s + p.amount, 0);

  return (
    <>
      <div className="topbar">
        <h1>Payout Airbnb</h1>
        <MonthNav month={month} path="/payouts" extra={view === "month" ? "&view=month" : ""} />
        <p className="sub">Tiền Airbnb đã chuyển, đọc từ email payout trong Gmail của nhà đầu tư, đối chiếu với từng đơn trong hệ thống.</p>
        <ViewTabs month={month} view={view} />
      </div>
      {sp.connected && <div className="banner info" role="status">{sp.connected}</div>}
      {sp.gmail && <div className="banner bad" role="alert">{sp.gmail}</div>}
      {!configured && !isAdmin && <div className="banner">Admin chưa cài đặt kết nối Google nên chưa kết nối được Gmail. Trong lúc chờ, có thể dán email payout ở cuối trang.</div>}
      {!configured && isAdmin && <div className="banner">Chưa kết nối được Gmail: hoàn tất mục <a href="#google-setup">Cài đặt kết nối Google</a> ở cuối trang.</div>}

      {view === "month" ? <MonthlyRevenue rows={monthly} roomName={roomName} multiInvestor={multiInvestor} month={month} /> : (
      <>
      <div className="cards">
        <div className="stat"><span className="lbl">Airbnb đã chuyển</span><span className="v">{vnd(total)}</span><span className="s">{payouts.length} lần chuyển trong {D.formatMonthVN(month).toLowerCase()}</span></div>
        <div className="stat"><span className="lbl">Đơn khớp</span><span className="v">{matched}/{groups.length}</span><span className="s">Đúng đơn và đúng số tiền</span></div>
        <div className="stat"><span className="lbl">Lệch tiền</span><span className="v">{diffs.length}</span><span className="s">{diffs.length ? `Tổng lệch ${vnd(diffs.reduce((s, g) => s + (g.diffAmount ?? 0), 0))}` : `Chênh tỷ giá dưới ${PAYOUT_TOLERANCE_PCT}% coi là khớp`}</span></div>
        <div className="stat"><span className="lbl">Chưa thấy payout</span><span className="v">{missing.length}</span><span className="s">Đơn Airbnb nhận phòng quá {MISSING_AFTER_DAYS} ngày</span></div>
      </div>

      <section className="panel">
        <header><div><h2>Đối soát theo lần chuyển tiền</h2><p>Mỗi email payout gộp nhiều đơn; mỗi đơn có dòng tiền phòng và các dòng thuế Airbnb khấu trừ. VNĐ từng dòng quy theo tỷ giá của chính email. Số lệch = tiền Airbnb đã chuyển cho đơn sau thuế (cộng mọi email) − thực nhận đang ghi trong hệ thống.</p></div></header>
        <div className="tbl-wrap"><table className="payouts">
          <thead><tr><th>Khách</th><th>Phòng</th><th>Ngày ở</th><th>Chi tiết</th><th className="n">USD</th><th className="n">VNĐ chuyển</th><th>Đối soát</th></tr></thead>
          {payouts.map((p) => <PayoutRows key={p.id} p={p} roomName={roomName} multiInvestor={multiInvestor} />)}
          {!payouts.length && <tbody><tr><td colSpan={7} className="muted small">{accounts.some((a) => a.active) ? "Chưa có email payout nào trong tháng." : "Kết nối Gmail ở bên dưới để đọc email payout."}</td></tr></tbody>}
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

      </>
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
                      <div className="row gmail-actions">
                        <RunButton run={syncGmailAction.bind(null, a.id)} label="Đọc thư ngay" pendingLabel="Đang đọc…" />
                        <BackfillGmail accountId={a.id} email={a.email} today={D.todayVN()} />
                        <RunButton run={disconnectGmailAction.bind(null, a.id)} label="Ngắt kết nối" pendingLabel="Đang ngắt…" danger confirm={`Ngắt kết nối ${a.email}? Các payout đã đọc vẫn được giữ.`} />
                      </div>
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

      {manageable.length > 0 && (
        <section className="panel" style={{ marginTop: 24 }}>
          <header><div><h2>Dán email payout</h2><p>Dùng khi chưa kết nối Gmail, hoặc để kiểm tra một email cụ thể. Bấm Xem trước để thấy app tách được gì, rồi Lưu để đối soát.</p></div></header>
          <PastePayout investors={manageable} today={D.todayVN()} />
        </section>
      )}

      {setup && (
        <section className="panel" id="google-setup" style={{ marginTop: 24 }}>
          <details open={!configured}>
            <summary className="setup-summary">
              <h2>Cài đặt kết nối Google</h2>
              {configured ? <span className="pill ok">Đã cài đặt</span> : <span className="pill warn">Chưa xong</span>}
            </summary>
            <p className="muted small">Làm một lần, chỉ Admin thấy mục này. Các bước 1–3 làm trên Google Cloud Console bằng tài khoản Google của LOCI.</p>
            <ol className="setup-steps">
              <li>
                <b>Bật Gmail API.</b> Tạo project mới (ví dụ "LOCI Homestay"), rồi bấm Enable ở trang{" "}
                <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noreferrer">Gmail API</a>.
              </li>
              <li>
                <b>Màn hình đồng ý.</b> Ở{" "}
                <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noreferrer">Google Auth Platform</a>{" "}
                chọn loại External, thêm quyền <code>gmail.readonly</code>. Ở mục Audience bấm Publish app để chuyển sang In production. Nếu để Testing, Google hủy quyền sau 7 ngày và nhà đầu tư phải kết nối lại.
              </li>
              <li>
                <b>Tạo OAuth client.</b> Ở{" "}
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Credentials</a>{" "}
                chọn Create credentials → OAuth client ID → Web application. Thêm Authorized redirect URI đúng như sau:
                <div style={{ marginTop: 8 }}><CopyField value={callback} label="Redirect URI" /></div>
                {!setup.appUrl && <div className="small muted" style={{ marginTop: 4 }}>Địa chỉ này lấy theo trang đang mở. Nếu app có tên miền chính thức khác, nhập ở ô Địa chỉ app bên dưới rồi copy lại.</div>}
              </li>
              <li>
                <b>Dán Client ID và Client Secret</b> Google vừa cấp vào đây rồi bấm Lưu.
                {setup.secretBroken && <div className="banner bad" style={{ marginTop: 8 }}>Không giải mã được Client Secret đã lưu (khóa mã hóa đã đổi). Nhập lại Client Secret.</div>}
                <ActionForm action={saveGoogleSetupAction} submit="Lưu cài đặt" okText="Đã lưu. Giờ có thể bấm Kết nối Gmail cho từng nhà đầu tư">
                  <label className="field full"><span>Client ID</span>
                    <input type="text" name="clientId" defaultValue={setup.clientId ?? ""} disabled={setup.fromEnv.clientId} required={!setup.fromEnv.clientId} placeholder="1234567890-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} />
                  </label>
                  <label className="field"><span>Client Secret{setup.hasSecret ? ` (đang lưu ${setup.secretHint}, để trống nếu giữ nguyên)` : ""}</span>
                    <input type="password" name="clientSecret" disabled={setup.fromEnv.clientSecret} required={!setup.hasSecret && !setup.fromEnv.clientSecret} placeholder="GOCSPX-…" autoComplete="new-password" />
                  </label>
                  <label className="field"><span>Địa chỉ app (không bắt buộc)</span>
                    <input type="text" inputMode="url" name="appUrl" defaultValue={setup.appUrl ?? ""} disabled={setup.fromEnv.appUrl} placeholder={reqOrigin} autoComplete="off" spellCheck={false} />
                  </label>
                  {(setup.fromEnv.clientId || setup.fromEnv.clientSecret || setup.fromEnv.appUrl) && <p className="full small muted" style={{ margin: 0 }}>Ô bị khóa đang lấy giá trị từ file .env trên máy chủ; sửa trong .env nếu cần đổi.</p>}
                </ActionForm>
              </li>
            </ol>
          </details>
        </section>
      )}
    </>
  );
}
