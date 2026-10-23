// Xuất Excel đơn đặt phòng: đúng bộ lọc, đúng phạm vi cơ sở, buồng phòng không thấy tiền. Chạy trên PGlite với migration thật.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import ExcelJS from "exceljs";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";

let db: DB;
let me: SessionUser | null = null;
vi.mock("@/lib/db", () => ({ getDb: () => db }));
vi.mock("@/lib/server", () => ({ currentUser: async () => me }));

const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const hk: SessionUser = { id: "u-hk", name: "Buồng phòng", role: "HOUSEKEEPER" };

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  const s = schema;
  await db.insert(s.users).values([
    { id: admin.id, name: admin.name, role: "ADMIN", passwordHash: "x" },
    { id: invA.id, name: invA.name, role: "INVESTOR", passwordHash: "x" },
    { id: hk.id, name: hk.name, role: "HOUSEKEEPER", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([{ id: "inv-a", name: "NĐT A", userId: invA.id }, { id: "inv-b", name: "NĐT B" }]);
  await db.insert(s.properties).values([{ id: "X", investorId: "inv-a", name: "Vạn Phúc" }, { id: "Z", investorId: "inv-b", name: "Khương Trung" }]);
  await db.insert(s.rooms).values([{ id: "X1", propertyId: "X", name: "P101", openedOn: "2026-01-01" }, { id: "Z1", propertyId: "Z", name: "P201", openedOn: "2026-01-01" }]);
  await db.insert(s.userPropertyAccess).values({ userId: hk.id, propertyId: "X" });
  const b = (id: string, propertyId: string, roomId: string, guestName: string, checkIn: string, checkOut: string, net: number, status: "CONFIRMED" | "CANCELLED" = "CONFIRMED") => ({
    id, source: "DAYLADAU" as const, externalId: `HM${id}`, propertyId, roomId, channel: "Airbnb", guestName, checkIn, checkOut,
    grossAmount: net + 100_000, commissionAmount: 100_000, netAmount: net, status,
  });
  await db.insert(s.bookings).values([
    b("1", "X", "X1", "Nguyễn An", "2026-10-02", "2026-10-04", 1_000_000),
    b("2", "X", "X1", "Trần Bình", "2026-10-20", "2026-10-21", 500_000, "CANCELLED"),
    b("3", "Z", "Z1", "Lê Chi", "2026-10-05", "2026-10-06", 700_000),
    b("4", "X", "X1", "Phạm Dũng", "2026-11-03", "2026-11-05", 900_000),
  ]);
});

async function exportRows(query: string) {
  const { GET } = await import("../app/(app)/bookings/export/route");
  const res = await GET(new Request(`http://localhost/bookings/export?${query}`));
  if (res.status !== 200) return { status: res.status, rows: [] as unknown[][], headers: [] as unknown[] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await res.arrayBuffer()) as never);
  const ws = wb.worksheets[0];
  const all: unknown[][] = [];
  ws.eachRow((r) => all.push((r.values as unknown[]).slice(1)));
  return { status: 200, headers: all[2], rows: all.slice(3), disposition: res.headers.get("content-disposition") };
}

describe("Xuất Excel đơn đặt phòng", () => {
  it("chưa đăng nhập thì 401", async () => {
    me = null;
    expect((await exportRows("month=2026-10")).status).toBe(401);
  });

  it("theo tháng: đủ đơn trong tháng, có dòng tổng chỉ cộng đơn xác nhận", async () => {
    me = admin;
    const r = await exportRows("month=2026-10");
    expect(r.disposition).toContain("don-dat-phong_2026-10.xlsx");
    expect(r.headers).toContain("Thực nhận");
    const data = r.rows.filter((x) => String(x[0]).startsWith("HM"));
    expect(data.map((x) => x[0])).toEqual(["HM1", "HM3", "HM2"]); // theo ngày nhận phòng
    expect(data).toHaveLength(3);
    const total = r.rows.at(-1)!;
    expect(total[0]).toBe("Tổng đơn đã xác nhận");
    expect(total.at(-1)).toBe(1_700_000);
  });

  it("lọc cơ sở + khoảng ngày + tên khách không dấu", async () => {
    me = admin;
    const r = await exportRows("prop=X&from=2026-10-01&to=2026-11-30&q=dung");
    expect(r.rows.filter((x) => String(x[0]).startsWith("HM")).map((x) => x[0])).toEqual(["HM4"]);
  });

  it("NĐT chỉ thấy cơ sở của mình, kể cả khi truyền cơ sở khác", async () => {
    me = invA;
    const r = await exportRows("month=2026-10&prop=Z");
    const ids = r.rows.filter((x) => String(x[0]).startsWith("HM")).map((x) => x[0]);
    expect(ids).not.toContain("HM3");
    expect(ids).toEqual(expect.arrayContaining(["HM1", "HM2"]));
  });

  it("buồng phòng: không có cột tiền", async () => {
    me = hk;
    const r = await exportRows("month=2026-10");
    expect(r.status).toBe(200);
    expect(r.headers).not.toContain("Thực nhận");
    expect(r.rows.filter((x) => String(x[0]).startsWith("HM")).map((x) => x[0])).toEqual(["HM1", "HM2"]);
  });
});
