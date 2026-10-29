import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { alerts, bookings, properties, rooms, syncRuns } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { listConnections } from "@/lib/dayladau/admin";
import { feePct } from "@/lib/services/settings";
import { NoAccess } from "@/components/NoAccess";
import { DayladauPanel } from "./panel";

// Cảnh báo do đồng bộ sinh ra; SYNC_FAILED không tự đóng nên chỉ lấy vài ngày gần đây
const SYNC_ALERTS = ["UNMAPPED_ROOM", "BOOKING_MISSING", "LOCKED_MONTH_CHANGED"];
const FAILED_DAYS = 3;

/** Lịch tự đồng bộ đang chạy, khớp với lib/scheduler.ts và vercel.json. */
function scheduleText() {
  if (process.env.VERCEL) return "lúc 06:00 hằng ngày";
  const minutes = Number(process.env.AUTO_SYNC_MINUTES ?? 0);
  return minutes > 0 ? `${minutes} phút một lần` : "đang tắt, chỉ đồng bộ khi bấm nút";
}

export default async function DayladauPage() {
  const user = await requireUser();
  if (!can(user, "admin")) return <NoAccess />;
  const db = getDb();
  const [investors, defaultFeePct] = await Promise.all([listConnections(db, user), feePct(db)]);
  const props = await db.select().from(properties).orderBy(properties.name);
  const rs = props.length ? await db.select().from(rooms).where(inArray(rooms.propertyId, props.map((p) => p.id))).orderBy(rooms.name) : [];
  const runs = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(8);
  const synced = await db.select({ propertyId: bookings.propertyId }).from(bookings).where(eq(bookings.source, "DAYLADAU"));
  // Số đơn đã đồng bộ theo tài khoản Dayladau của cơ sở
  const accountOf = Object.fromEntries(props.map((p) => [p.id, p.dayladauAccountId]));
  const bookingCount: Record<string, number> = {};
  for (const b of synced) {
    const a = accountOf[b.propertyId];
    if (a) bookingCount[a] = (bookingCount[a] ?? 0) + 1;
  }
  const since = new Date(Date.now() - FAILED_DAYS * 86400_000);
  const openAlerts = await db
    .select({ id: alerts.id, type: alerts.type, message: alerts.message, createdAt: alerts.createdAt })
    .from(alerts)
    .where(and(isNull(alerts.resolvedAt), or(inArray(alerts.type, SYNC_ALERTS), and(eq(alerts.type, "SYNC_FAILED"), gte(alerts.createdAt, since)))))
    .orderBy(desc(alerts.createdAt));
  return (
    <>
      <div className="topbar"><h1>Kết nối Dayladau</h1></div>
      <div className="banner info">Một nhà đầu tư có thể có nhiều tài khoản Dayladau (host ID + access token); mỗi cơ sở lấy đơn từ đúng một tài khoản. Token được mã hóa khi lưu và không hiển thị lại. Hệ thống tự đồng bộ {scheduleText()}.</div>
      <DayladauPanel
        investors={investors.map((i) => ({ ...i, accounts: i.accounts.map((a) => ({ ...a, lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null })) }))}
        defaultFeePct={defaultFeePct}
        properties={props.map((p) => ({ id: p.id, name: p.name, investorId: p.investorId, accountId: p.dayladauAccountId, rooms: rs.filter((r) => r.propertyId === p.id).map((r) => ({ id: r.id, name: r.name, listingKey: r.dayladauRoomId })) }))}
        runs={runs.map((r) => ({ id: r.id, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, created: r.created, updated: r.updated, skipped: r.skipped, errors: (r.errors as { message: string }[] | null) ?? [] }))}
        bookingCount={bookingCount}
        alerts={openAlerts.map((a) => ({ id: a.id, type: a.type, message: a.message, createdAt: a.createdAt.toISOString() }))}
      />
    </>
  );
}
