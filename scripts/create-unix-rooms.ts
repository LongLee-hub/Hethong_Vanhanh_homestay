// Một lần: tạo cơ sở + phòng Unixstay theo plan.json. Mỗi phòng gắn listing Dayladau đang dùng (listing chính)
// và các listing cũ của cùng phòng (listing phụ), để đơn cũ cũng về đúng phòng.
// Chạy lại được: cơ sở / phòng đã có (theo tên) thì không tạo lại, chỉ gắn thêm listing còn thiếu.
// npx tsx --env-file=.env scripts/create-unix-rooms.ts <plan.json>
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { getDb } from "../lib/db";
import { dayladauAccounts, properties, rooms, users } from "../lib/db/schema";
import { createProperty, createRoom, mapListingToRoom } from "../lib/dayladau/admin";
import { listingRef, roomsByListing } from "../lib/dayladau/room-listings";

const plan: { prop: string; name: string; listingKey: string; openedOn: string; others: { key: string }[] }[] = JSON.parse(readFileSync(process.argv[2], "utf8"));
const db = getDb();
const [admin] = await db.select().from(users).where(and(eq(users.role, "ADMIN"), eq(users.active, true))).limit(1);
const user = { id: admin.id, name: admin.name, role: admin.role };
const [acc] = await db.select().from(dayladauAccounts).where(eq(dayladauAccounts.label, "Unixstay"));
const propId = new Map((await db.select().from(properties).where(eq(properties.investorId, acc.investorId))).map((p) => [p.name, p.id]));
let createdProps = 0, createdRooms = 0, attached = 0;
for (const p of plan) {
  if (!propId.has(p.prop)) {
    const row = await createProperty(db, user, { investorId: acc.investorId, name: p.prop, dayladauAccountId: acc.id });
    propId.set(p.prop, row.id);
    createdProps++;
  }
  const pid = propId.get(p.prop)!;
  let [room] = await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.propertyId, pid), eq(rooms.name, p.name)));
  if (!room) {
    room = await createRoom(db, user, { propertyId: pid, name: p.name, openedOn: p.openedOn, listingKey: p.listingKey });
    createdRooms++;
  }
  const held = await roomsByListing(db, [acc.id]);
  for (const key of [p.listingKey, ...p.others.map((o) => o.key)]) {
    if (held.get(listingRef(acc.id, key))?.id === room.id) continue;
    await mapListingToRoom(db, user, acc.id, key, room.id);
    attached++;
  }
}
const all = await db.select({ prop: properties.name, key: rooms.dayladauRoomId }).from(rooms).innerJoin(properties, eq(properties.id, rooms.propertyId)).where(eq(properties.investorId, acc.investorId));
const byProperty = all.reduce((m, r) => ({ ...m, [r.prop]: (m[r.prop] ?? 0) + 1 }), {} as Record<string, number>);
const byListing = await roomsByListing(db, [acc.id]);
console.log({ createdProps, createdRooms, attached, listingsMapped: byListing.size, roomsNow: all.length, mappedNow: all.filter((r) => r.key).length, byProperty });
process.exit(0);
