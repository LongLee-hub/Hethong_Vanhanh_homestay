// Mẫu checklist dọn phòng: mặc định cho mọi cơ sở, checklist riêng theo cơ sở, thêm/sửa/xoá/đổi thứ tự, ảnh mẫu,
// cập nhật phòng chưa bắt đầu dọn, phân quyền.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import { createTask, CLEANING_CHECKLIST, type ChecklistItem } from "../lib/services/tasks";
import { toggleChecklistItem } from "../lib/services/cleaning";
import { canViewPhoto } from "../lib/services/photos";
import {
  addStep, createOwnTemplate, deleteOwnTemplate, effectiveTemplate, moveStep, removeStep, updateStep,
} from "../lib/services/checklists";

let db: DB;
const admin: SessionUser = { id: "a", name: "Admin", role: "ADMIN" };
const mgr: SessionUser = { id: "m", name: "Quản lý", role: "MANAGER" };
const hk: SessionUser = { id: "h", name: "Hương", role: "HOUSEKEEPER" };
const due = new Date("2026-11-22T12:00:00+07:00");
const results = async (taskId: string) =>
  (await db.select().from(schema.checklistResults).where(eq(schema.checklistResults.taskId, taskId)))[0].results as ChecklistItem[];

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  await db.insert(schema.users).values([
    { id: admin.id, name: admin.name, role: "ADMIN", passwordHash: "x" },
    { id: mgr.id, name: mgr.name, role: "MANAGER", passwordHash: "x" },
    { id: hk.id, name: hk.name, role: "HOUSEKEEPER", passwordHash: "x" },
  ]);
  await db.insert(schema.investors).values({ id: "inv", name: "NĐT" });
  await db.insert(schema.properties).values([{ id: "KT", investorId: "inv", name: "Khương Trung" }, { id: "LT", investorId: "inv", name: "Lạc Trung" }]);
  await db.insert(schema.userPropertyAccess).values([{ userId: mgr.id, propertyId: "KT" }, { userId: hk.id, propertyId: "KT" }]);
});

describe("Mẫu checklist dọn phòng", () => {
  it("chưa lưu gì thì dùng checklist có sẵn", async () => {
    const t = await effectiveTemplate(db, "KT");
    expect(t.own).toBe(false);
    expect(t.steps.map((s) => s.item)).toEqual(CLEANING_CHECKLIST.map((c) => c.item));
  });

  it("chỉ Admin sửa checklist mặc định; buồng phòng không sửa được", async () => {
    await expect(addStep(db, mgr, null, { item: "X", needPhoto: false })).rejects.toThrow(/Chỉ Admin/);
    await expect(addStep(db, hk, "KT", { item: "X", needPhoto: false })).rejects.toMatchObject({ status: 403 });
  });

  it("Admin thêm mục có ảnh mẫu: việc mới và phòng chưa dọn nhận mục mới, phòng đang dọn giữ nguyên", async () => {
    const before = await createTask(db, admin, { propertyId: "KT", type: "CLEANING", title: "Dọn P1", dueAt: due });
    const doing = await createTask(db, admin, { propertyId: "KT", type: "CLEANING", title: "Dọn P2", dueAt: due });
    await toggleChecklistItem(db, admin, doing.id, 0, true);
    const n = await addStep(db, admin, null, { item: "  Gấp khăn  hình thiên nga ", needPhoto: true, hint: "Đặt giữa giường", sample: "loci-photos/checklist-samples/x.jpg" });
    expect(n).toBe(1);
    const last = (await results(before.id)).at(-1)!;
    expect(last).toMatchObject({ item: "Gấp khăn hình thiên nga", needPhoto: true, hint: "Đặt giữa giường", sample: "loci-photos/checklist-samples/x.jpg", done: false });
    expect((await results(doing.id)).length).toBe(CLEANING_CHECKLIST.length);
    const fresh = await createTask(db, admin, { propertyId: "LT", type: "CLEANING", title: "Dọn L1", dueAt: due });
    expect((await results(fresh.id)).length).toBe(CLEANING_CHECKLIST.length + 1);
  });

  it("sửa, đổi thứ tự, xoá ảnh mẫu, xoá mục", async () => {
    const steps = (await effectiveTemplate(db, null)).steps;
    const swan = steps.at(-1)!;
    await updateStep(db, admin, null, swan.id, { item: "Gấp khăn", needPhoto: false, hint: "", sample: undefined });
    let t = await effectiveTemplate(db, null);
    expect(t.steps.at(-1)).toMatchObject({ item: "Gấp khăn", needPhoto: false, hint: null, sample: "loci-photos/checklist-samples/x.jpg" });
    await updateStep(db, admin, null, swan.id, { item: "Gấp khăn", needPhoto: false, sample: null });
    await moveStep(db, admin, null, swan.id, -1);
    t = await effectiveTemplate(db, null);
    expect(t.steps.at(-2)).toMatchObject({ id: swan.id, sample: null });
    await removeStep(db, admin, null, swan.id);
    expect((await effectiveTemplate(db, null)).steps.length).toBe(CLEANING_CHECKLIST.length);
    await expect(updateStep(db, admin, null, swan.id, { item: "A", needPhoto: false })).rejects.toMatchObject({ status: 404 });
    await expect(addStep(db, admin, null, { item: "   ", needPhoto: false })).rejects.toThrow(/Nhập tên việc/);
  });

  it("Quản lý tạo checklist riêng cho cơ sở mình, sửa không ảnh hưởng cơ sở khác, bỏ thì về mặc định", async () => {
    await expect(createOwnTemplate(db, mgr, "LT")).rejects.toMatchObject({ status: 404 });
    await expect(addStep(db, mgr, "KT", { item: "X", needPhoto: false })).rejects.toThrow(/Tạo checklist riêng/);
    await createOwnTemplate(db, mgr, "KT");
    await addStep(db, mgr, "KT", { item: "Tưới cây ban công", needPhoto: false });
    expect((await effectiveTemplate(db, "KT")).steps.at(-1)!.item).toBe("Tưới cây ban công");
    expect((await effectiveTemplate(db, "LT")).steps.some((s) => s.item === "Tưới cây ban công")).toBe(false);
    const kt = await createTask(db, admin, { propertyId: "KT", type: "CLEANING", title: "Dọn P3", dueAt: due });
    expect((await results(kt.id)).at(-1)!.item).toBe("Tưới cây ban công");
    await deleteOwnTemplate(db, mgr, "KT");
    expect((await effectiveTemplate(db, "KT")).own).toBe(false);
    expect((await results(kt.id)).some((c) => c.item === "Tưới cây ban công")).toBe(false);
  });

  it("buồng phòng xem được ảnh mẫu", async () => {
    expect(await canViewPhoto(db, hk, "loci-photos/checklist-samples/2026-11-21/a.jpg")).toBe(true);
    expect(await canViewPhoto(db, { id: "i", name: "NĐT", role: "INVESTOR" }, "loci-photos/checklist-samples/2026-11-21/a.jpg")).toBe(false);
  });
});
