"use client";
import { useState, useTransition } from "react";
import { ActionForm } from "@/components/ActionForm";
import type { ConnectionTest, InvestorConnection } from "@/lib/dayladau/admin";
import { DISMISSIBLE_ALERTS } from "@/lib/dayladau/alert-types";
import type { SyncSummary } from "@/lib/dayladau/sync";
import {
  createPropertyAction, createRoomForListingAction, dismissAlertAction, mapListingAction, saveAccountAction, saveInvestorAction, syncNowAction, testConnectionAction,
} from "./actions";
import s from "./dayladau.module.css";

type Prop = { id: string; name: string; investorId: string; accountId: string | null; rooms: { id: string; name: string; listingKey: string | null }[] };
type Run = { id: string; startedAt: string; finishedAt: string | null; created: number; updated: number; skipped: number; errors: { message: string }[] };
type Alert = { id: string; type: string; message: string; createdAt: string };
// Ngày giờ đã đổi sang chuỗi ISO ở trang server
type Investor = Omit<InvestorConnection, "accounts"> & { accounts: Account[] };
type Account = Omit<InvestorConnection["accounts"][number], "lastSyncedAt"> & { lastSyncedAt: string | null };

const vnd = (n: number) => n.toLocaleString("vi-VN") + " ₫";
const dt = (iso: string) => new Date(iso).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const dmy = (d: string) => d.split("-").reverse().join("/");

const ALERT_LABEL: Record<string, [string, string]> = {
  SYNC_FAILED: ["Lỗi kết nối", "bad"],
  UNMAPPED_ROOM: ["Listing chưa gắn phòng", "warn"],
  BOOKING_MISSING: ["Đơn không còn trên Dayladau", "warn"],
  LOCKED_MONTH_CHANGED: ["Đổi vào tháng đã khóa", "fc"],
};
const ALERTS_SHOWN = 8;

export function DayladauPanel({ investors, properties, runs, bookingCount, alerts, defaultFeePct }: {
  investors: Investor[];
  properties: Prop[];
  runs: Run[];
  bookingCount: Record<string, number>; // theo tài khoản Dayladau
  alerts: Alert[];
  defaultFeePct: number;
}) {
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
          <InvestorForm key={inv.id} inv={inv} defaultFeePct={defaultFeePct} onDone={() => setEditing(null)} />
        ) : (
          <InvestorCard key={inv.id} inv={inv} props={properties.filter((p) => p.investorId === inv.id)} bookingCount={bookingCount} defaultFeePct={defaultFeePct} onEdit={() => setEditing(inv.id)} />
        ),
      )}
      {editing === "new" ? <InvestorForm defaultFeePct={defaultFeePct} onDone={() => setEditing(null)} /> : <div><button className="btn primary" onClick={() => setEditing("new")}>+ Thêm nhà đầu tư</button></div>}
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

function InvestorForm({ inv, defaultFeePct, onDone }: { inv?: Investor; defaultFeePct: number; onDone: () => void }) {
  const f = (k: string) => `inv-${k}-${inv?.id ?? "new"}`;
  return (
    <section className="panel">
      <header><h2>{inv ? `Sửa ${inv.name}` : "Thêm nhà đầu tư"}</h2><button className="btn sm" onClick={onDone}>Đóng</button></header>
      <ActionForm action={async (st, fd) => { const r = await saveInvestorAction(st, fd); if (r?.ok) onDone(); return r; }} submit="Lưu">
        {inv && <input type="hidden" name="id" value={inv.id} />}
        <label className="field"><span>Tên nhà đầu tư</span><input type="text" name="name" id={f("name")} defaultValue={inv?.name} required /></label>
        <label className="field"><span>Số điện thoại</span><input type="text" inputMode="tel" name="phone" id={f("phone")} defaultValue={inv?.phone ?? ""} /></label>
        <label className="field"><span>Email</span><input type="text" inputMode="email" name="email" id={f("email")} defaultValue={inv?.email ?? ""} /></label>
        <label className="field"><span>MST / CCCD</span><input type="text" name="taxCode" id={f("taxCode")} defaultValue={inv?.taxCode ?? ""} /></label>
        <label className="field full"><span>Địa chỉ</span><input type="text" name="address" id={f("address")} defaultValue={inv?.address ?? ""} /></label>

        <h3 className="full sub-title">Tài khoản nhận tiền quyết toán</h3>
        <label className="field"><span>Ngân hàng</span><input type="text" name="bankName" id={f("bankName")} defaultValue={inv?.bankName ?? ""} placeholder="vd: Vietcombank" /></label>
        <label className="field"><span>Số tài khoản</span><input type="text" inputMode="numeric" name="bankAccountNo" id={f("bankAccountNo")} defaultValue={inv?.bankAccountNo ?? ""} /></label>
        <label className="field"><span>Chủ tài khoản</span><input type="text" name="bankAccountName" id={f("bankAccountName")} defaultValue={inv?.bankAccountName ?? ""} /></label>
        <label className="field"><span>Ngày chuyển tiền hằng tháng</span><input type="number" min={1} max={28} name="payoutDay" id={f("payoutDay")} defaultValue={inv?.payoutDay ?? ""} placeholder="1–28" /></label>

        <h3 className="full sub-title">Hợp đồng</h3>
        <label className="field"><span>Phí quản lý LOCI (%)</span><input type="number" min={0} max={100} step="0.01" name="managementFeePct" id={f("fee")} defaultValue={inv?.managementFeePct ?? ""} placeholder={`Để trống = mức chung ${defaultFeePct}%`} /></label>
        <label className="field"><span>Thuế GTGT (% doanh thu)</span><input type="number" min={0} max={100} step="0.01" name="vatPct" id={f("vat")} defaultValue={inv?.vatPct ?? ""} placeholder="Để trống = không áp dụng" /></label>
        <label className="field"><span>Thuế TNCN (% lợi nhuận sau phí)</span><input type="number" min={0} max={100} step="0.01" name="pitPct" id={f("pit")} defaultValue={inv?.pitPct ?? ""} placeholder="Để trống = không áp dụng" /></label>
        <label className="check-item full"><input type="checkbox" name="sharesCommonCost" value="1" id={f("shares")} defaultChecked={inv?.sharesCommonCost ?? false} /><span>Chịu chi phí chung (Unix): chi phí chung chia đều theo phòng các cơ sở của những NĐT được chọn</span></label>
        <p className="hint full">Chỉ điền cho CĐT đặc biệt (vd Uxistay: GTGT 8%, TNCN 17%). Quyết toán trừ GTGT trên doanh thu trước khi tính phí quản lý, rồi trừ TNCN trên phần lợi nhuận còn lại sau phí.</p>
        <label className="field"><span>Bắt đầu hợp đồng</span><input type="date" name="contractStartOn" id={f("cStart")} defaultValue={inv?.contractStartOn ?? ""} /></label>
        <label className="field"><span>Kết thúc hợp đồng</span><input type="date" name="contractEndOn" id={f("cEnd")} defaultValue={inv?.contractEndOn ?? ""} /></label>
        {inv && (
          <label className="field"><span>Trạng thái</span>
            <select name="active" id={f("active")} defaultValue={inv.active ? "1" : "0"}><option value="1">Đang hợp tác</option><option value="0">Ngưng hợp tác</option></select>
          </label>
        )}
        <label className="field full"><span>Link hợp đồng</span><input type="text" inputMode="url" name="contractUrl" id={f("cUrl")} defaultValue={inv?.contractUrl ?? ""} placeholder="https://…" /></label>
        <label className="field full"><span>Ghi chú</span><textarea name="note" id={f("note")} defaultValue={inv?.note ?? ""} /></label>

        <h3 className="full sub-title">Nhóm chat duyệt chi phí</h3>
        <label className="field full"><span>Webhook bot Lark của nhóm có chủ nhà</span><input type="text" inputMode="url" name="larkWebhookUrl" id={f("lark")} defaultValue={inv?.larkWebhookUrl ?? ""} placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/…" /></label>
        <p className="hint full">Trong nhóm chat Lark có chủ nhà: Cài đặt nhóm → Bot → Thêm bot → Custom Bot, copy webhook dán vào đây. Kế toán kê khai chi phí, nhóm sẽ nhận tin kèm nút mở trang duyệt. Để trống thì gửi nhóm Lark chung.</p>
        <p className="hint full">Tài khoản Dayladau (host ID, access token) thêm riêng cho từng cơ sở ở thẻ nhà đầu tư sau khi lưu.</p>
      </ActionForm>
    </section>
  );
}

function InvestorCard({ inv, props, bookingCount, defaultFeePct, onEdit }: { inv: Investor; props: Prop[]; bookingCount: Record<string, number>; defaultFeePct: number; onEdit: () => void }) {
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const noAccount = props.filter((p) => !p.accountId);
  const bank = [inv.bankName, inv.bankAccountNo, inv.bankAccountName].filter(Boolean).join(" · ");
  const contract = inv.contractStartOn || inv.contractEndOn ? `${inv.contractStartOn ? dmy(inv.contractStartOn) : "…"} – ${inv.contractEndOn ? dmy(inv.contractEndOn) : "…"}` : "—";
  return (
    <section className="panel">
      <header>
        <div>
          <div className="row"><h2>{inv.name}</h2>{!inv.active && <span className="pill bad">Ngưng hợp tác</span>}</div>
          <p>{props.length} cơ sở · {inv.accounts.length} tài khoản Dayladau{inv.hasAccount ? "" : " · chưa có tài khoản đăng nhập"}</p>
        </div>
        <button className="btn sm" onClick={onEdit}>Sửa thông tin</button>
      </header>

      <div className="facts">
        <div className="kv"><span>Liên hệ</span><b>{[inv.phone, inv.email].filter(Boolean).join(" · ") || "—"}</b></div>
        <div className="kv"><span>MST / CCCD</span><b>{inv.taxCode || "—"}</b></div>
        <div className="kv"><span>Phí quản lý</span><b>{inv.managementFeePct != null ? `${inv.managementFeePct}%` : `${defaultFeePct}% (mức chung)`}</b></div>
        {(inv.vatPct || inv.pitPct) ? <div className="kv"><span>Thuế CĐT</span><b>{[inv.vatPct ? `GTGT ${inv.vatPct}%` : "", inv.pitPct ? `TNCN ${inv.pitPct}%` : ""].filter(Boolean).join(" · ")}</b></div> : null}
        <div className="kv"><span>Hợp đồng</span><b>{contract}</b></div>
        <div className="kv"><span>Nhận tiền</span><b>{bank || "—"}</b></div>
        <div className="kv"><span>Ngày chuyển tiền</span><b>{inv.payoutDay ? `Ngày ${inv.payoutDay} hằng tháng` : "—"}</b></div>
      </div>

      <h3 className="sub-title">Tài khoản Dayladau</h3>
      {noAccount.length > 0 && inv.accounts.length > 0 && (
        <div className="banner">Cơ sở chưa chọn tài khoản Dayladau (chỉ nhập đơn tay): <b>{noAccount.map((p) => p.name).join(", ")}</b>. Bấm Sửa ở tài khoản tương ứng để chọn cơ sở.</div>
      )}
      <div className="stack">
        {inv.accounts.map((a) =>
          editing === a.id ? (
            <AccountForm key={a.id} investorId={inv.id} acc={a} props={props} accounts={inv.accounts} onDone={() => setEditing(null)} />
          ) : (
            <AccountCard key={a.id} acc={a} investorId={inv.id} props={props.filter((p) => p.accountId === a.id)} bookings={bookingCount[a.id] ?? 0} onEdit={() => setEditing(a.id)} />
          ),
        )}
        {editing === "new" ? (
          <AccountForm investorId={inv.id} props={props} accounts={inv.accounts} onDone={() => setEditing(null)} />
        ) : (
          <div><button className="btn sm" onClick={() => setEditing("new")}>+ Thêm tài khoản Dayladau</button></div>
        )}
      </div>
    </section>
  );
}

function AccountForm({ investorId, acc, props, accounts, onDone }: { investorId: string; acc?: Account; props: Prop[]; accounts: Account[]; onDone: () => void }) {
  const id = acc?.id ?? `new-${investorId}`;
  const labelOf = Object.fromEntries(accounts.map((a) => [a.id, a.label]));
  return (
    <div className={s.account}>
      <div className={s.accHead}><h3>{acc ? `Sửa ${acc.label}` : "Thêm tài khoản Dayladau"}</h3><button className="btn sm" onClick={onDone}>Đóng</button></div>
      <ActionForm action={async (st, fd) => { const r = await saveAccountAction(st, fd); if (r?.ok) onDone(); return r; }} submit="Lưu tài khoản">
        <input type="hidden" name="investorId" value={investorId} />
        {acc && <input type="hidden" name="id" value={acc.id} />}
        <label className="field"><span>Tên gợi nhớ</span><input type="text" name="label" id={`acc-label-${id}`} defaultValue={acc?.label} required placeholder="vd: TK Hội An" /></label>
        <label className="field"><span>Host ID Dayladau</span><input type="text" name="hostId" id={`acc-host-${id}`} defaultValue={acc?.hostId ?? ""} required placeholder="vd: usc62mtlkh" autoComplete="off" /></label>
        <label className="field full"><span>Access token {acc?.hasToken && `(đang lưu ${acc.tokenHint} — để trống nếu không đổi)`}</span>
          <input type="password" name="token" id={`acc-token-${id}`} required={!acc?.hasToken} autoComplete="new-password" placeholder="Dán x_access_token của tài khoản" />
        </label>
        <label className="check-item full"><input type="checkbox" name="active" value="1" id={`acc-active-${id}`} defaultChecked={acc?.active ?? true} /><span>Tự đồng bộ tài khoản này</span></label>
        <div className="field full">
          <span>Cơ sở lấy đơn từ tài khoản này</span>
          {props.length ? (
            <div className="check-grid">
              {props.map((p) => (
                <label key={p.id} className="check-item">
                  <input type="checkbox" name="propertyIds" value={p.id} id={`acc-${id}-p-${p.id}`} defaultChecked={!!acc && p.accountId === acc.id} />
                  <span className="listing-name"><b>{p.name}</b><span className="small muted">{p.accountId && p.accountId !== acc?.id ? `Đang dùng ${labelOf[p.accountId] ?? "tài khoản khác"} — chọn sẽ chuyển sang` : p.accountId ? "Đang dùng tài khoản này" : "Chưa có tài khoản"}</span></span>
                </label>
              ))}
            </div>
          ) : <span className="small muted">Nhà đầu tư chưa có cơ sở. Lưu tài khoản rồi bấm Kiểm tra kết nối để tạo cơ sở.</span>}
        </div>
        <p className="hint full">Lấy host ID và access token trong tài khoản Dayladau (giống HOST_ID và ACCESS_TOKEN trong script Apps Script). Mỗi cơ sở lấy đơn từ đúng một tài khoản; đổi tài khoản của cơ sở sẽ bỏ gắn listing ở các phòng của cơ sở đó.</p>
      </ActionForm>
    </div>
  );
}

function AccountCard({ acc, investorId, props, bookings, onEdit }: { acc: Account; investorId: string; props: Prop[]; bookings: number; onEdit: () => void }) {
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const [sync, setSync] = useState<{ ok: boolean; error?: string; summary?: SyncSummary } | null>(null);
  const [busy, setBusy] = useState<"test" | "sync" | "full" | null>(null);
  const [pending, start] = useTransition();
  const run = (kind: "test" | "sync" | "full", fn: () => Promise<void>) => { setBusy(kind); start(async () => { await fn(); setBusy(null); }); };
  const ready = acc.hasToken;
  const mapped = props.flatMap((p) => p.rooms).filter((r) => r.listingKey).length;
  const synced = bookings > 0 || !!sync?.summary?.created;
  // 4 bước kết nối; bước đang làm là bước đầu tiên chưa xong
  const steps: { label: string; note: string; done: boolean }[] = [
    { label: "Thông tin kết nối", note: ready ? "Đã có host ID và token" : "Thiếu access token", done: ready },
    { label: "Kiểm tra kết nối", note: test?.ok ? `Thấy ${test.listings.length} listing` : test ? "Chưa kết nối được" : mapped ? "Đã kết nối được" : "Chưa kiểm tra", done: !!test?.ok || mapped > 0 },
    { label: "Gắn listing với phòng", note: mapped ? `${mapped} phòng đã gắn` : "Chưa gắn phòng nào", done: mapped > 0 },
    { label: "Đồng bộ đơn", note: synced ? `${bookings + (sync?.summary?.created ?? 0)} đơn đã về` : "Chưa có đơn nào", done: synced },
  ];
  const now = steps.findIndex((x) => !x.done);
  const nextHint = [
    <>Bấm <b>Sửa</b> để nhập access token.</>,
    <>Bấm <b>Kiểm tra kết nối</b> để xem danh sách listing trên Dayladau.</>,
    <>Chọn phòng cho từng listing ở bảng bên dưới rồi bấm <b>Lưu</b>. Đơn của listing chưa gắn sẽ bị bỏ qua.</>,
    <>Bấm <b>Đồng bộ ngay</b> để lấy đơn về, hoặc chờ lần tự đồng bộ kế tiếp. Lần đầu lấy toàn bộ đơn cũ, các lần sau chỉ lấy đơn mới nhất.</>,
  ][now];
  const lastSync = acc.lastSyncedAt ? `Đồng bộ lần cuối ${dt(acc.lastSyncedAt)}${acc.lastSyncStatus === "FAILED" ? " (lỗi)" : ""}` : "Chưa đồng bộ";
  return (
    <div className={s.account}>
      <div className={s.accHead}>
        <div>
          <h3>{acc.label}</h3>
          <p className="small muted">Host ID {acc.hostId} · token {acc.hasToken ? acc.tokenHint : "chưa có"} · {props.length ? props.map((p) => p.name).join(", ") : "chưa gắn cơ sở nào"} · {lastSync}</p>
        </div>
        <div className="row">
          {!acc.active ? <span className="pill">Tạm dừng đồng bộ</span> : now === -1 ? <span className="pill ok">Đang đồng bộ</span> : <span className="pill warn">Chưa xong bước {now + 1}</span>}
          <button className="btn sm" onClick={onEdit}>Sửa</button>
          <button className="btn sm" disabled={!ready || pending} onClick={() => run("test", async () => setTest(await testConnectionAction(acc.id)))}>{busy === "test" ? "Đang kiểm tra…" : "Kiểm tra kết nối"}</button>
          <button className="btn sm primary" disabled={!ready || pending || !mapped || !acc.active} title={!acc.active ? "Tài khoản đang tạm dừng đồng bộ" : !mapped ? "Gắn listing với phòng trước" : ""} onClick={() => run("sync", async () => setSync(await syncNowAction(acc.id)))}>{busy === "sync" ? "Đang đồng bộ…" : "Đồng bộ ngay"}</button>
          {synced && <button className="btn sm" disabled={!ready || pending || !mapped || !acc.active} title="Lấy lại toàn bộ đơn trên Dayladau, kể cả đơn cũ. Dùng sau khi gắn thêm listing." onClick={() => run("full", async () => setSync(await syncNowAction(acc.id, true)))}>{busy === "full" ? "Đang lấy đơn cũ…" : "Lấy toàn bộ đơn cũ"}</button>}
        </div>
      </div>
      {acc.lastSyncStatus === "FAILED" && acc.lastSyncError && !sync && <div className="banner bad">Lần đồng bộ trước lỗi: {acc.lastSyncError}</div>}

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
          {!props.length && <NewProperty investorId={investorId} accountId={acc.id} />}
          <div>
            <h3>Gắn listing Dayladau với phòng</h3>
            <p className="small muted">Chỉ chọn được phòng thuộc cơ sở dùng tài khoản này. Đơn của listing chưa gắn phòng sẽ bị bỏ qua khi đồng bộ.</p>
            <div className="tbl-wrap"><table>
              <thead><tr><th>Listing trên Dayladau</th><th className="n">Đơn</th><th>Phòng trong hệ thống</th></tr></thead>
              <tbody>{test.listings.map((l) => <ListingRow key={l.key} accountId={acc.id} listing={l} props={props} />)}</tbody>
            </table></div>
          </div>
          <div className="grid g2">
            <div>
              <h3>Trạng thái đơn</h3>
              <p className="small muted">Kiểm tra cột "Ghi nhận là". Trạng thái nào sai báo em để sửa.</p>
              <table><tbody>{test.statuses.map((x) => <tr key={x.status}><td>{x.status || "(trống)"}</td><td className="n">{x.orders}</td><td>{x.treatedAs === "CANCELLED" ? <span className="pill bad">Hủy</span> : <span className="pill ok">Có doanh thu</span>}</td></tr>)}</tbody></table>
            </div>
            <div>
              <h3>Đối chiếu tiền host</h3>
              <p className="small muted">So với số "Amount host" trong Google Sheet hiện tại.</p>
              <table><tbody>{test.samples.map((x) => <tr key={x.id}><td className="small">{x.id}<br />{x.listing}</td><td className="n small">Khách trả {vnd(x.totalBilled)}<br /><b>Host nhận {vnd(x.hostAmount)}</b></td></tr>)}</tbody></table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ListingRow({ accountId, listing, props }: { accountId: string; listing: ConnectionTest["listings"][number]; props: Prop[] }) {
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
            {props.map((p) => <optgroup key={p.id} label={p.name}>{p.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}{r.listingKey && r.listingKey !== listing.key ? " (đã có listing, gắn thêm)" : ""}</option>)}</optgroup>)}
            {props.length > 0 && <option value="__new">+ Tạo phòng mới…</option>}
          </select>
          {roomId !== "__new" && (
            <button className="btn sm" disabled={pending || roomId === savedRoomId} onClick={() => start(async () => { const r = await mapListingAction(accountId, listing.key, roomId || null); if (r?.ok) setSavedRoomId(roomId); setMsg(r?.ok ? "Đã lưu" : r?.error ?? ""); })}>Lưu</button>
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

function NewProperty({ investorId, accountId }: { investorId: string; accountId: string }) {
  return (
    <div className="panel" style={{ background: "var(--surface-2)" }}>
      <h3>Tài khoản này chưa gắn cơ sở nào</h3>
      <p className="small muted">Tạo cơ sở dùng tài khoản này (hoặc bấm Sửa để chọn cơ sở có sẵn), sau đó tạo phòng cho từng listing ở bảng bên dưới.</p>
      <ActionForm action={createPropertyAction} submit="Tạo cơ sở" okText="Đã tạo — bấm Kiểm tra kết nối lần nữa">
        <input type="hidden" name="investorId" value={investorId} />
        <input type="hidden" name="dayladauAccountId" value={accountId} />
        <label className="field"><span>Tên cơ sở</span><input type="text" name="name" id={`np-name-${accountId}`} required placeholder="vd: Vạn Phúc" /></label>
        <label className="field"><span>Vốn đầu tư (VND)</span><input type="text" inputMode="numeric" name="investmentAmount" id={`np-inv-${accountId}`} /></label>
        <label className="field"><span>Bắt đầu tính hoàn vốn</span><input type="month" name="investmentStartMonth" id={`np-start-${accountId}`} /></label>
      </ActionForm>
    </div>
  );
}
