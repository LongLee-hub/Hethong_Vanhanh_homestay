import { desc, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { properties, rooms, syncRuns } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { listConnections } from "@/lib/dayladau/admin";
import { NoAccess } from "@/components/NoAccess";
import { DayladauPanel } from "./panel";

export default async function DayladauPage() {
  const user = await requireUser();
  if (!can(user, "admin")) return <NoAccess />;
  const db = getDb();
  const investors = await listConnections(db, user);
  const props = await db.select().from(properties).orderBy(properties.name);
  const rs = props.length ? await db.select().from(rooms).where(inArray(rooms.propertyId, props.map((p) => p.id))).orderBy(rooms.name) : [];
  const runs = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(8);
  return (
    <>
      <div className="topbar"><h1>Kết nối Dayladau</h1></div>
      <div className="banner info">Mỗi nhà đầu tư có một host ID và access token Dayladau riêng. Token được mã hóa khi lưu và không hiển thị lại. Hệ thống tự đồng bộ lúc 06:00 hằng ngày.</div>
      <DayladauPanel
        investors={investors}
        properties={props.map((p) => ({ id: p.id, name: p.name, investorId: p.investorId, rooms: rs.filter((r) => r.propertyId === p.id).map((r) => ({ id: r.id, name: r.name, listingKey: r.dayladauRoomId })) }))}
        runs={runs.map((r) => ({ id: r.id, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, created: r.created, updated: r.updated, skipped: r.skipped, errors: (r.errors as { message: string }[] | null) ?? [] }))}
      />
    </>
  );
}
