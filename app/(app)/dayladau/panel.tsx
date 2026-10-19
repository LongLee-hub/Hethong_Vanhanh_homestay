"use client";
import { useState, useTransition } from "react";
import { ActionForm } from "@/components/ActionForm";
import type { ConnectionTest, InvestorConnection } from "@/lib/dayladau/admin";
import { DISMISSIBLE_ALERTS } from "@/lib/dayladau/alert-types";
import type { SyncSummary } from "@/lib/dayladau/sync";
import { createPropertyAction, createRoomForListingAction, dismissAlertAction, mapListingAction, saveConnectionAction, syncNowAction, testConnectionAction } from "./actions";
import s from "./dayladau.module.css";

type Prop = { id: string; name: string; investorId: string; rooms: { id: string; name: string; listingKey: string | null }[] };
type Run = { id: string; startedAt: string; finishedAt: string | null; created: number; updated: number; skipped: number; errors: { message: string }[] };
type Alert = { id: string; type: string; message: string; createdAt: string };

const vnd = (n: number) => n.toLocaleString("vi-VN") + " ₫";
const dt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const ALERT_LABEL: Record<string, [string, string]> = {
  SYNC_FAILED: ["Lỗi kết nối", "bad"],
  UNMAPPED_ROOM: ["Listing chưa gắn phòng", "warn"],
  BOOKING_MISSING: ["Đơn không còn trên Dayladau", "warn"],
  LOCKED_MONTH_CHANGED: ["Đổi vào tháng đã khóa", "fc"],
};
const ALERTS_SHOWN = 8;

export function DayladauPanel({ investors, properties, runs, bookingCount, alerts }: { investors: InvestorConnection[]; properties: Prop[]; runs: Run[]; bookingCount: Record<string, number>; alerts: Alert[] }) {
  const [editing, setEditing] = useState<string | "new" | null>(investors.length ? null : "new");
  const [allAlerts, setAllAlerts] = useState(false);
  const shown = allAlerts ? alerts : alerts.slice(0, ALERTS_SHOWN);
  return (
    <div className="stack">
      {alerts.length > 0 && (
        <section className="panel">
          <header><div><h2>Cần xử lý</h2><p>Cảnh báo do đồng bộ sinh ra. Listing chưa gắn phòng tự đóng khi gắn xong; các loại khác bấm Đã xem sau khi kiểm tra.</p></div><span className="pill bad">{alerts.length}</span></header>
          <div className={s.alerts}>
            {shown.map((a) => <AlertRow key={a.id} a={a} />)}
          </div>
          {alerts.length > ALERTS_SHOWN && <button className="btn sm" style={{ marginTop: 12 }} onClick={() => setAllAlerts(!allAlerts)}>{allAlerts ? "Thu gọn" : `Xem thêm ${alerts.length - ALERTS_SHOWN} cảnh báo`}</button>}
        </section>
      )}
      {investors.map((inv) =>
        editing === inv.id ? (
          <ConnectionForm key={inv.id} inv={inv} onDone={() => setEditing(null)} />
        ) : (
          <InvestorCard key={inv.id} inv={inv} props={properties.filter((p) => p.investorId === inv.id)} bookings={bookingCount[inv.id] ?? 0} onEdit={() => setEditing(inv.id)} />
        ),
      )}
      {editing === "new" ? <ConnectionForm onDone={() => setEditing(null)} /> : <div><button className="btn primary" onClick={() => setEditing("new")}>+ Thêm nhà đầu tư</button></div>}
      <section className="panel">
        <header><h2>Nhật ký đồng bộ</h2></header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Lúc</th><th className="n">Tạo mới</th><th className="n">Cập nhật</th><th className="n">Bỏ qua</th><th>Lỗi</th></tr></thead>
          <tbody>{runs.map((r) => <tr key={r.id}><td className="num">{dt(r.startedAt)}{!r.finishedAt && " (đang chạy)"}</td><td className="n">{r.created}</td><td className="n">{r.updated}</td><td className="n">{r.skipped}</td><td className="small">{r.errors.length ? r.errors.slice(0, 2).map((e) => e.message).join("; ") : "—"}</td></tr>)}
            {!runs.length && <tr><td colSpan={5} className="muted small">Chưa đồng bộ lần nào.</td></tr>}</tbody>
        </table></div>
      </section>
    </div>
  );
}

function AlertRow({ a }: { a: Alert }) {
  const [pending, start] = useTransition();
  const [err, setErr] = useState("");
  const [label, tone] = ALERT_LABEL[a.type] ?? [a.type, ""];
  return (
    <div className={s.alert}>
      <span className={`pill ${tone}`}>{label}</span>
      <p>{a.message}{err && <span className="err"> {err}</span>}</p>
      <time dateTime={a.createdAt}>{dt(a.createdAt)}</time>
      {DISMISSIBLE_ALERTS.includes(a.type) && (
        <button className="btn sm" disabled={pending} onClick={() => start(async () => { const r = await dismissAlertAction(a.id); if (!r?.ok) setErr(r?.error ?? ""); })}>{pending ? "Đang đóng…" : "Đã xem"}</button>
      )}
    </div>
  );
}

function ConnectionForm({ inv, onDone }: { inv?: InvestorConnection; onDone: () => void }) {
  return (
    <section className="panel">
      <header><h2>{inv ? `Sửa ${inv.name}` : "Thêm nhà đầu tư"}</h2><button className="btn sm" onClick={onDone}>Đóng</button></header>
      <ActionForm action={async (s, f) => { const r = await saveConnectionAction(s, f); if (r?.ok) onDone(); return r; }} submit="Lưu" >
        {inv && <input type="hidden" name="id" value={inv.id} />}
        <label className="field"><span>Tên nhà đầu tư</span><input type="text" name="name" id="dl-name" defaultValue={inv?.name} required /></label>
        <label className="field"><span>Host ID Dayladau</span><input type="text" name="hostId" id="dl-host" defaultValue={inv?.hostId ?? ""} required placeholder="vd: usc62mtlkh" autoComplete="off" /></label>
        <label className="field full"><span>Access token {inv?.hasToken && `(đang lưu ${inv.tokenHint} — để trống nếu không đổi)`}</span>
          <input type="password" name="token" id="dl-token" required={!inv?.hasToken} autoComplete="new-password" placeholder="Dán x_access_token của nhà đầu tư" />
        </label>
        <p className="hint full">Lấy host ID và access token trong tài khoản Dayladau của nhà đầu tư (giống 2 giá trị HOST_ID và ACCESS_TOKEN trong script Apps Script).</p>
      </ActionForm>
    </section>
  );
}

function InvestorCard({ inv, props, bookings, onEdit }: { inv: InvestorConnection; props: Prop[]; bookings: number; onEdit: () => void }) {
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [sync, setSync] = useState<{ ok: boolean; error?: string; summary?: SyncSummary } | null>(null);
  const [busy, setBusy] = useState<"test" | "sync" | "full" | null>(null);
  const [pending, start] = useTransition();
  const run = (kind: "test" | "sync" | "full", fn: () => Promise<void>) => { setBusy(kind); start(async () => { await fn(); setBusy(null); }); };
  const ready = !!(inv.hostId && inv.hasToken);
  const mapped = props.flatMap((p) => p.rooms).filter((r) => r.listingKey).length;
  const synced = bookings > 0 || !!sync?.summary?.created;
  // 4 bước kết nối; bước đang làm là bước đầu tiên chưa xong
  const steps: { label: string; note: string; done: boolean }[] = [
    { label: "Thông tin kết nối", note: ready ? "Đã có host ID và token" : "Thiếu host ID hoặc token", done: ready },
    { label: "Kiểm tra kết nối", note: test?.ok ? `Thấy ${test.listings.length} listing` : test ? "Chưa kết nối được" : mapped ? "Đã kết nối được" : "Chưa kiểm tra", done: !!test?.ok || mapped > 0 },
    { label: "Gắn listing với phòng", note: mapped ? `${mapped} phòng đã gắn` : "Chưa gắn phòng nào", done: mapped > 0 },
    { label: "Đồng bộ đơn", note: synced ? `${bookings + (sync?.summary?.created ?? 0)} đơn đã về` : "Chưa có đơn nào", done: synced },
  ];
  const now = steps.findIndex((x) => !x.done);
  const nextHint = [
    <>Bấm <b>Sửa</b> để điền host ID và access token.</>,
    <>Bấm <b>Kiểm tra kết nối</b> để xem danh sách listing trên Dayladau.</>,
    <>Chọn phòng cho từng listing ở bảng bên dưới rồi bấm <b>Lưu</b>. Đơn của listing chưa gắn sẽ bị bỏ qua.</>,
    <>Bấm <b>Đồng bộ ngay</b> để lấy đơn về, hoặc chờ lần tự đồng bộ kế tiếp. Lần đầu lấy toàn bộ đơn cũ, các lần sau chỉ lấy đơn mới nhất.</>,
  ][now];
  return (
    <section className="panel">
      <header>
        <div><h2>{inv.name}</h2><p>Host ID {inv.hostId ?? "—"} · token {inv.hasToken ? inv.tokenHint : "chưa có"} · {mapped} phòng đã gắn listing</p></div>
        <div className="row">
          {now === -1 ? <span className="pill ok">Đang đồng bộ</span> : <span className="pill warn">Chưa xong bước {now + 1}</span>}
          <button className="btn sm" onClick={onEdit}>Sửa</button>
          <button className="btn sm" disabled={!ready || pending} onClick={() => run("test", async () => setTest(await testConnectionAction(inv.id)))}>{busy === "test" ? "Đang kiểm tra…" : "Kiểm tra kết nối"}</button>
          <button className="btn sm primary" disabled={!ready || pending || !mapped} title={!mapped ? "Gắn listing với phòng trước" : ""} onClick={() => run("sync", async () => setSync(await syncNowAction(inv.id)))}>{busy === "sync" ? "Đang đồng bộ…" : "Đồng bộ ngay"}</button>
          {synced && <button className="btn sm" disabled={!ready || pending || !mapped} title="Lấy lại toàn bộ đơn trên Dayladau, kể cả đơn cũ. Dùng sau khi gắn thêm listing." onClick={() => run("full", async () => setSync(await syncNowAction(inv.id, true)))}>{busy === "full" ? "Đang lấy đơn cũ…" : "Lấy toàn bộ đơn cũ"}</button>}
        </div>
      </header>

      <ol className={s.steps} aria-label="Các bước kết nối">
        {steps.map((x, i) => (
          <li key={x.label} className={`${s.step} ${x.done ? s.done : ""} ${i === now ? s.now : ""}`} aria-current={i === now ? "step" : undefined}><b>{x.label}</b><span>{x.note}</span></li>
        ))}
      </ol>
      {nextHint && <p className={s.next}>Bước tiếp theo: {nextHint}</p>}

      {sync && (sync.summary ? (
        <>
          <div className={s.tiles}>
            <div className={`${s.tile} ${s.tNew}`}><b>{sync.summary.created}</b><span>Đơn mới</span><small>Đã ghi vào sổ, chia tiền theo đêm</small></div>
            <div className={`${s.tile} ${s.tChanged}`}><b>{sync.summary.updated}</b><span>Có thay đổi</span><small>Đổi ngày, đổi phòng, đổi tiền hoặc bị hủy</small></div>
            <div className={s.tile}><b>{sync.summary.unchanged}</b><span>Không đổi</span><small>Chỉ cập nhật giờ đồng bộ</small></div>
            <div className={`${s.tile} ${s.tSkipped}`}><b>{sync.summary.skipped}</b><span>Bỏ qua</span><small>Listing chưa gắn phòng hoặc đơn đọc lỗi</small></div>
          </div>
          {sync.summary.adjustments > 0 && <div className="banner">{sync.summary.adjustments} đơn thay đổi rơi vào tháng đã khóa sổ, phần chênh lệch đã ghi sang tháng kế tiếp.</div>}
          {sync.error && <div className="banner bad">Lỗi: {sync.error}</div>}
        </>
      ) : <div className="banner bad">{sync.error}</div>)}

      {test && !test.ok && <div className="banner bad">Không kết nối được: {test.error}</div>}
      {test?.ok && (
        <div className="stack">
          <div className="banner info">Kết nối thành công. Trang đầu có {test.ordersOnFirstPage} đơn.</div>
          {!props.length && <NewProperty investorId={inv.id} />}
          <div>
            <h3>Gắn listing Dayladau với phòng</h3>
            <p className="small muted">Đơn của listing chưa gắn phòng sẽ bị bỏ qua khi đồng bộ.</p>
            <div className="tbl-wrap"><table>
              <thead><tr><th>Listing trên Dayladau</th><th className="n">Đơn</th><th>Phòng trong hệ thống</th></tr></thead>
              <tbody>{test.listings.map((l) => <ListingRow key={l.key} investorId={inv.id} listing={l} props={props} />)}</tbody>
            </table></div>
          </div>
          <div className="grid g2">
            <div>
              <h3>Trạng thái đơn</h3>
              <p className="small muted">Kiểm tra cột "Ghi nhận là". Trạng thái nào sai báo em để sửa.</p>
              <table><tbody>{test.statuses.map((s) => <tr key={s.status}><td>{s.status || "(trống)"}</td><td className="n">{s.orders}</td><td>{s.treatedAs === "CANCELLED" ? <span className="pill bad">Hủy</span> : <span className="pill ok">Có doanh thu</span>}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h3>Đối chiếu tiền host</h3>
              <p className="small muted">So với số "Amount host" trong Google Sheet hiện tại.</p>
              <table><tbody>{test.samples.map((x) => <tr key={x.id}><td className="small">{x.id}<br />{x.listing}</td><td className="n small">Khách trả {vnd(x.totalBilled)}<br /><b>Host nhận {vnd(x.hostAmount)}</b></td></tr>)}</tbody></table>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ListingRow({ investorId, listing, props }: { investorId: string; listing: ConnectionTest["listings"][number]; props: Prop[] }) {
  const [roomId, setRoomId] = useState(listing.roomId ?? "");
  // Phòng đang gắn thực tế; kết quả "Kiểm tra kết nối" không tự làm mới sau khi lưu nên giữ ở đây
  const [savedRoomId, setSavedRoomId] = useState(listing.roomId ?? "");
  const [msg, setMsg] = useState<string>("");
  const [pending, start] = useTransition();
  const [newRoom, setNewRoom] = useState({ propertyId: props[0]?.id ?? "", name: listing.name });
  // Cơ sở có thể vừa được tạo sau lần render đầu (state còn rỗng): lấy cơ sở đang hiển thị trong ô chọn
  const propertyId = props.some((p) => p.id === newRoom.propertyId) ? newRoom.propertyId : props[0]?.id ?? "";
  return (
    <tr>
      <td><b>{listing.name}</b><div className="small muted">mã {listing.key}</div></td>
      <td className="n">{listing.orders}</td>
      <td>
        <div className="row">
          <select value={roomId} onChange={(e) => setRoomId(e.target.value)} aria-label={`Phòng cho ${listing.name}`} style={{ maxWidth: 260 }}>
            <option value="">— Chưa gắn —</option>
            {props.map((p) => <optgroup key={p.id} label={p.name}>{p.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}{r.listingKey && r.listingKey !== listing.key ? " (đang gắn listing khác)" : ""}</option>)}</optgroup>)}
            {props.length > 0 && <option value="__new">+ Tạo phòng mới…</option>}
          </select>
          {roomId !== "__new" && (
            <button className="btn sm" disabled={pending || roomId === savedRoomId} onClick={() => start(async () => { const r = await mapListingAction(investorId, listing.key, roomId || null); if (r?.ok) setSavedRoomId(roomId); setMsg(r?.ok ? "Đã lưu" : r?.error ?? ""); })}>Lưu</button>
          )}
          {msg && <span className={`small ${msg.startsWith("Đã") ? "pos" : "err"}`}>{msg}</span>}
        </div>
        {roomId === "__new" && (
          <div className="row" style={{ marginTop: 6 }}>
            <select value={propertyId} onChange={(e) => setNewRoom({ ...newRoom, propertyId: e.target.value })} aria-label="Cơ sở">{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <input type="text" value={newRoom.name} onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })} aria-label="Tên phòng" style={{ maxWidth: 180 }} />
            <button className="btn sm primary" disabled={pending} onClick={() => start(async () => { const r = await createRoomForListingAction({ ...newRoom, propertyId, listingKey: listing.key });
              // Chuyển ô chọn sang phòng vừa tạo để đóng khung tạo mới, tránh bấm tạo lần nữa
              if (r.ok && r.roomId) { setRoomId(r.roomId); setSavedRoomId(r.roomId); }
              setMsg(r.ok ? "Đã tạo phòng và gắn" : r.error ?? ""); })}>Tạo và gắn</button>
          </div>
        )}
      </td>
    </tr>
  );
}

function NewProperty({ investorId }: { investorId: string }) {
  return (
    <div className="panel" style={{ background: "var(--surface-2)" }}>
      <h3>Nhà đầu tư này chưa có cơ sở</h3>
      <p className="small muted">Tạo cơ sở trước, sau đó tạo phòng cho từng listing ở bảng bên dưới.</p>
      <ActionForm action={createPropertyAction} submit="Tạo cơ sở" okText="Đã tạo — bấm Kiểm tra kết nối lần nữa">
        <input type="hidden" name="investorId" value={investorId} />
        <label className="field"><span>Tên cơ sở</span><input type="text" name="name" id={`np-name-${investorId}`} required placeholder="vd: Vạn Phúc" /></label>
        <label className="field"><span>Vốn đầu tư (VND)</span><input type="text" inputMode="numeric" name="investmentAmount" id={`np-inv-${investorId}`} /></label>
        <label className="field"><span>Bắt đầu tính hoàn vốn</span><input type="month" name="investmentStartMonth" id={`np-start-${investorId}`} /></label>
      </ActionForm>
    </div>
  );
}
