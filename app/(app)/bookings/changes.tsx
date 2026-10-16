// Tab "Đơn đã cập nhật": dòng thời gian đơn mới, đơn đổi thông tin, đơn hủy — từ đồng bộ Dayladau hoặc người sửa tay.
import Link from "next/link";
import { desc } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { syncRuns } from "@/lib/db/schema";
import { can, type SessionUser } from "@/lib/auth/access";
import { visibleProperties } from "@/lib/queries";
import { bookingChanges, type BookingChange, type ChangeKind } from "@/lib/services/booking-changes";
import { vnd } from "@/components/MonthNav";

const SHOW = 300;
const PERIODS = [["1", "24 giờ qua"], ["7", "7 ngày"], ["30", "30 ngày"]] as const;
const KIND: Record<ChangeKind, [string, string]> = {
  NEW: ["Đơn mới", "ok"],
  CHANGED: ["Đổi thông tin", "warn"],
  CANCELLED: ["Đã hủy", "bad"],
  RESTORED: ["Khôi phục", "fc"],
  IMPORTED: ["Nhập đơn cũ", ""],
};
const STATUS: Record<string, string> = { CONFIRMED: "Đã xác nhận", CANCELLED: "Đã hủy" };
const RENTAL: Record<string, string> = { hour: "Theo giờ" };

const vnTime = (d: Date) => d.toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });
const vnDay = (d: Date) => D.todayVN(d);

function dayHeading(day: string, today: string) {
  if (day === today) return "Hôm nay";
  if (day === D.addDays(today, -1)) return "Hôm qua";
  return D.formatDateVN(day);
}

export async function BookingChanges({ user, sp }: { user: SessionUser; sp: Record<string, string> }) {
  const db = getDb();
  const days = PERIODS.some(([d]) => d === sp.days) ? Number(sp.days) : 7;
  const kind = (Object.keys(KIND) as ChangeKind[]).find((k) => k === sp.kind) ?? null;
  const since = new Date(Date.now() - days * 86_400_000);
  const [all, props, lastRun] = await Promise.all([
    bookingChanges(db, user, since),
    visibleProperties(db, user),
    can(user, "admin") ? db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(1) : Promise.resolve([]),
  ]);
  const roomName = Object.fromEntries(props.flatMap((p) => p.rooms.map((r) => [r.id, `${p.name} · ${r.name}`])));
  // Mặc định bỏ đơn cũ mới nhập: lần nhập lịch sử có thể thêm hàng nghìn đơn cùng lúc
  const list = kind ? all.filter((c) => c.kind === kind) : all.filter((c) => c.kind !== "IMPORTED");
  const count = (k: ChangeKind) => all.filter((c) => c.kind === k).length;
  const today = D.todayVN();

  const fmt = (key: string, v: string | number | null) => {
    if (v === null || v === "") return "—";
    if (key === "checkIn" || key === "checkOut") return D.formatDateVN(String(v));
    if (key === "roomId") return roomName[String(v)] ?? "Phòng khác";
    if (key === "status") return STATUS[String(v)] ?? String(v);
    if (key === "rentalType") return RENTAL[String(v)] ?? String(v);
    return vnd(Number(v));
  };
  const href = (q: { days?: number; kind?: string | null }) => {
    const p = new URLSearchParams({ src: "changes", days: String(q.days ?? days) });
    const k = q.kind === undefined ? kind : q.kind;
    if (k) p.set("kind", k);
    return `/bookings?${p}`;
  };

  // Gom theo ngày (giờ Việt Nam), giữ thứ tự mới nhất trước
  const groups: [string, BookingChange[]][] = [];
  for (const c of list.slice(0, SHOW)) {
    const d = vnDay(c.changedAt);
    if (groups.at(-1)?.[0] !== d) groups.push([d, []]);
    groups.at(-1)![1].push(c);
  }
  const run = lastRun[0];

  return (
    <>
      <div className="chips">
        {PERIODS.map(([d, label]) => <Link key={d} className="chip" aria-pressed={Number(d) === days} href={href({ days: Number(d) })}>{label}</Link>)}
      </div>

      <div className="cards">
        <div className="stat"><span className="lbl">Đơn mới</span><span className="v">{count("NEW")}</span><span className="s">{count("IMPORTED") ? `Không tính ${count("IMPORTED")} đơn cũ mới nhập` : `Trong ${PERIODS.find(([d]) => Number(d) === days)![1].toLowerCase()}`}</span></div>
        <div className="stat"><span className="lbl">Đổi thông tin</span><span className="v">{count("CHANGED")}</span><span className="s">Ngày ở, phòng hoặc số tiền</span></div>
        <div className="stat"><span className="lbl">Đã hủy</span><span className="v">{count("CANCELLED")}</span><span className="s">{count("RESTORED") ? `${count("RESTORED")} đơn được khôi phục` : "Doanh thu các đêm đã được bỏ"}</span></div>
      </div>

      {run && (
        <p className="hint" style={{ margin: "0 0 16px" }}>
          Lần đồng bộ gần nhất: {vnTime(run.startedAt)} {dayHeading(vnDay(run.startedAt), today).toLowerCase()}
          {run.finishedAt ? ` · ${run.created} đơn mới, ${run.updated} đơn cập nhật` : " · đang chạy"}. Xem chi tiết ở <Link href="/dayladau">Kết nối Dayladau</Link>.
        </p>
      )}

      <section className="panel">
        <header>
          <div className="chips">
            <Link className="chip" aria-pressed={!kind} href={href({ kind: null })}>Tất cả ({all.length - count("IMPORTED")})</Link>
            {(Object.keys(KIND) as ChangeKind[]).filter((k) => (k !== "RESTORED" && k !== "IMPORTED") || count(k)).map((k) => (
              <Link key={k} className="chip" aria-pressed={k === kind} href={href({ kind: k })}>{KIND[k][0]} ({count(k)})</Link>
            ))}
          </div>
        </header>

        {!list.length && <div className="empty">Không có đơn nào được cập nhật trong khoảng này.</div>}
        {groups.map(([day, items]) => (
          <div key={day}>
            <h3 className="sub-title">{dayHeading(day, today)}</h3>
            <ul className="room-list change-list">
              {items.map((c) => (
                <li key={c.id} className="change">
                  <div className="room-row">
                    <span className="num muted small change-time">{vnTime(c.changedAt)}</span>
                    <span className={`pill ${KIND[c.kind][1]}`}>{KIND[c.kind][0]}</span>
                    <b>{c.booking.guestName ?? "Khách"}</b>
                    <span className="small muted">{c.booking.externalId ?? "Đơn ngoài OTA"}</span>
                    <span className="spacer" />
                    <span className="small">{roomName[c.booking.roomId]}</span>
                    <span className="small muted num">{D.formatDateVN(c.booking.checkIn)} – {D.formatDateVN(c.booking.checkOut)}</span>
                    {c.booking.netAmount !== null && c.kind !== "CANCELLED" && <b className="num small">{vnd(c.booking.netAmount)}</b>}
                  </div>
                  {(c.fields.length > 0 || c.reason || c.booking.source === "MANUAL") && (
                    <div className="change-detail">
                      {c.fields.map((f) => (
                        <span key={f.key} className="small">{f.label}: <s className="muted">{fmt(f.key, f.before)}</s> → <b>{fmt(f.key, f.after)}</b></span>
                      ))}
                      {c.reason && <span className="small muted">Lý do: {c.reason}</span>}
                      <span className="small muted">Bởi {c.by}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {list.length > SHOW && <p className="hint">Đang hiện {SHOW} trên {list.length} thay đổi gần nhất. Chọn khoảng thời gian ngắn hơn hoặc lọc theo loại để xem các thay đổi cũ hơn.</p>}
      </section>
    </>
  );
}
