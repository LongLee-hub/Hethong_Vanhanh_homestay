// Các câu truy vấn gộp lô dùng cho đồng bộ: kết quả phải giống cách làm từng câu trước đây.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import { backfillRoomOpenedOn } from "../lib/dayladau/sync";

let db: DB;
beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  const s = schema;
  await db.insert(s.investors).values({ id: "inv", name: "NĐT" });
  await db.insert(s.properties).values([{ id: "X", investorId: "inv", name: "X" }, { id: "Z", investorId: "inv", name: "Z" }]);
  await db.insert(s.rooms).values([
    { id: "X1", propertyId: "X", name: "1", openedOn: "2026-10-01" },
    { id: "X2", propertyId: "X", name: "2", openedOn: "2026-01-01" },
    { id: "Z1", propertyId: "Z", name: "3", openedOn: "2026-10-01" },
  ]);
  const b = (id: string, propertyId: string, roomId: string, checkIn: string, status: "CONFIRMED" | "CANCELLED" = "CONFIRMED") => ({
    id, source: "DAYLADAU" as const, externalId: id, propertyId, roomId, channel: "Airbnb", checkIn, checkOut: "2026-10-30", grossAmount: 1, netAmount: 1, status,
  });
  await db.insert(s.bookings).values([
    b("a", "X", "X1", "2026-08-05"), b("b", "X", "X1", "2026-09-01"), b("c", "X", "X1", "2026-07-01", "CANCELLED"),
    b("d", "X", "X2", "2026-03-01"), b("e", "Z", "Z1", "2026-02-01"),
  ]);
});

describe("backfillRoomOpenedOn", () => {
  it("kéo ngày mở bán về đơn xác nhận sớm nhất, chỉ cho cơ sở được chọn và chỉ khi sớm hơn", async () => {
    expect(await backfillRoomOpenedOn(db, ["X"])).toBe(1);
    const opened = Object.fromEntries((await db.select().from(schema.rooms)).map((r) => [r.id, String(r.openedOn).slice(0, 10)]));
    expect(opened).toEqual({ X1: "2026-08-05", X2: "2026-01-01", Z1: "2026-10-01" });
    expect(await backfillRoomOpenedOn(db, ["X"])).toBe(0);
    expect(await backfillRoomOpenedOn(db, [])).toBe(0);
    const [z] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, "Z1"));
    expect(String(z.openedOn).slice(0, 10)).toBe("2026-10-01");
  });
});
