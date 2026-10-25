// Chỉ tiêu tháng: chỉ Admin lưu được, tháng đã khóa sổ thì giữ nguyên, NĐT chỉ thấy chỉ tiêu cơ sở của mình.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import { previousMonthTargets, saveTargets, targetsForMonth } from "../lib/services/targets";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const acc: SessionUser = { id: "u-acc", name: "Kế toán", role: "ACCOUNTANT" };

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
    { id: acc.id, name: acc.name, role: "ACCOUNTANT", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([{ id: "inv-a", name: "NĐT A", userId: invA.id }, { id: "inv-b", name: "NĐT B" }]);
  await db.insert(s.properties).values([
    { id: "X", investorId: "inv-a", name: "Vạn Phúc" },
    { id: "Y", investorId: "inv-a", name: "Phan Kế Bính" },
    { id: "Z", investorId: "inv-b", name: "Nguyễn Tư Giản" },
  ]);
  // NĐT B đã khóa sổ tháng 9
  await db.insert(s.settlements).values({ investorId: "inv-b", month: "2026-09", status: "LOCKED" });
});

describe("chỉ tiêu tháng", () => {
  it("chỉ Admin được lưu", async () => {
    await expect(saveTargets(db, acc, "2026-10", [{ propertyId: "X", revenue: 1, occupancyPct: 1, adr: 1 }])).rejects.toMatchObject({ status: 403 });
    await expect(saveTargets(db, invA, "2026-10", [{ propertyId: "X", revenue: 1, occupancyPct: 1, adr: 1 }])).rejects.toMatchObject({ status: 403 });
  });

  it("lưu rồi sửa lại cùng tháng thì ghi đè, không tạo dòng trùng", async () => {
    await saveTargets(db, admin, "2026-10", [
      { propertyId: "X", revenue: 180_000_000, occupancyPct: 88, adr: 450_000 },
      { propertyId: "Z", revenue: 160_000_000, occupancyPct: 86, adr: 455_000 },
    ]);
    await saveTargets(db, admin, "2026-10", [{ propertyId: "X", revenue: 190_000_000, occupancyPct: 87.5, adr: 460_000 }]);
    const t = await targetsForMonth(db, admin, "2026-10");
    expect(t).toEqual({
      X: { revenue: 190_000_000, occupancyPct: 87.5, adr: 460_000 },
      Z: { revenue: 160_000_000, occupancyPct: 86, adr: 455_000 },
    });
  });

  it("NĐT chỉ thấy chỉ tiêu cơ sở của mình", async () => {
    expect(Object.keys(await targetsForMonth(db, invA, "2026-10"))).toEqual(["X"]);
  });

  it("để trống cả 3 ô thì xóa chỉ tiêu cơ sở đó", async () => {
    await saveTargets(db, admin, "2026-10", [{ propertyId: "Z", revenue: 0, occupancyPct: 0, adr: 0 }]);
    expect(Object.keys(await targetsForMonth(db, admin, "2026-10"))).toEqual(["X"]);
  });

  it("tháng đã khóa sổ thì bỏ qua và báo tên cơ sở", async () => {
    const r = await saveTargets(db, admin, "2026-09", [
      { propertyId: "Z", revenue: 100_000_000, occupancyPct: 80, adr: 400_000 },
      { propertyId: "Y", revenue: 200_000_000, occupancyPct: 85, adr: 470_000 },
    ]);
    expect(r).toEqual({ saved: 1, skippedLocked: ["Nguyễn Tư Giản"] });
    expect(Object.keys(await targetsForMonth(db, admin, "2026-09"))).toEqual(["Y"]);
  });

  it("chép từ tháng trước lấy đúng số tháng trước", async () => {
    expect(await previousMonthTargets(db, admin, "2026-10")).toEqual({ Y: { revenue: 200_000_000, occupancyPct: 85, adr: 470_000 } });
  });

  it("chặn số không hợp lệ", async () => {
    await expect(saveTargets(db, admin, "2026-10", [{ propertyId: "X", revenue: 1, occupancyPct: 120, adr: 1 }])).rejects.toMatchObject({ status: 400 });
  });
});
