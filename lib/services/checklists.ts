// Mẫu checklist dọn phòng sửa được trên web: thêm, bớt, sửa, xoá mục, đổi thứ tự, ảnh mẫu cho từng mục.
// Một mẫu mặc định cho mọi cơ sở (Admin sửa); cơ sở nào cần khác thì tạo mẫu riêng (Admin hoặc Quản lý cơ sở đó sửa).
// Việc dọn mới lấy checklist từ mẫu lúc tạo. Sửa mẫu thì các phòng chưa bắt đầu dọn (chưa tick, chưa chụp mục nào)
// được đổi sang checklist mới; phòng đang dọn dở hoặc đã xong giữ nguyên để không mất ảnh, mất tick.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "../db";
import { checklistResults, checklistTemplates, properties, tasks } from "../db/schema";
import { assertPropertyAccess, badRequest, can, forbidden, notFound, requirePermission, type SessionUser } from "../auth/access";
import { CLEANING_CHECKLIST, type ChecklistItem } from "./tasks";

/** Một mục trong mẫu. hint: hướng dẫn ngắn hiện dưới tên việc; sample: ảnh mẫu (dạng "bucket/đường-dẫn"). */
export interface ChecklistStep {
  id: string;
  item: string;
  needPhoto: boolean;
  hint?: string | null;
  sample?: string | null;
}

export const MAX_STEPS = 40;
const TYPE = "CLEANING";
/** Thư mục chứa ảnh mẫu. Ảnh mẫu không có thông tin riêng tư nên ai làm việc dọn phòng cũng xem được. */
export const SAMPLE_FOLDER = "checklist-samples";

const newId = () => crypto.randomUUID().slice(0, 8);

/** Mẫu có sẵn trong code, dùng khi chưa ai lưu mẫu mặc định. */
export const builtinSteps = (): ChecklistStep[] =>
  CLEANING_CHECKLIST.map((c, i) => ({ id: `b${i + 1}`, item: c.item, needPhoto: !!c.needPhoto, hint: c.hint ?? null, sample: null }));

/** Checklist cho một việc dọn mới từ các mục của mẫu. */
export const stepsToChecklist = (steps: ChecklistStep[]): ChecklistItem[] =>
  steps.map((s) => ({ item: s.item, done: false, needPhoto: s.needPhoto, ...(s.hint ? { hint: s.hint } : {}), ...(s.sample ? { sample: s.sample } : {}) }));

async function row(db: DB, propertyId: string | null) {
  const [r] = await db.select().from(checklistTemplates)
    .where(and(eq(checklistTemplates.type, TYPE), propertyId ? eq(checklistTemplates.propertyId, propertyId) : isNull(checklistTemplates.propertyId)))
    .limit(1);
  return r ?? null;
}

export interface TemplateView {
  /** null = mẫu mặc định */
  propertyId: string | null;
  /** Cơ sở này có mẫu riêng (với mẫu mặc định: luôn true). */
  own: boolean;
  steps: ChecklistStep[];
  updatedAt: Date | null;
}

/** Mẫu đang áp dụng cho cơ sở (mẫu riêng nếu có, không thì mẫu mặc định). propertyId null = mẫu mặc định. */
export async function effectiveTemplate(db: DB, propertyId: string | null): Promise<TemplateView> {
  if (propertyId) {
    const own = await row(db, propertyId);
    if (own) return { propertyId, own: true, steps: own.steps as ChecklistStep[], updatedAt: own.updatedAt };
  }
  const def = await row(db, null);
  return { propertyId, own: !propertyId, steps: def ? (def.steps as ChecklistStep[]) : builtinSteps(), updatedAt: def?.updatedAt ?? null };
}

/** Checklist cho việc dọn mới tạo ở cơ sở này. */
export async function cleaningChecklistFor(db: DB, propertyId: string): Promise<ChecklistItem[]> {
  return stepsToChecklist((await effectiveTemplate(db, propertyId)).steps);
}

/** Ai được sửa: mẫu mặc định chỉ Admin; mẫu riêng của cơ sở: Admin hoặc Quản lý được giao cơ sở đó. */
export async function assertCanEdit(db: DB, user: SessionUser, propertyId: string | null) {
  requirePermission(user, "assignTask");
  if (!propertyId) {
    if (!can(user, "admin")) throw forbidden("Chỉ Admin sửa được checklist mặc định");
    return;
  }
  await assertPropertyAccess(db, user, propertyId);
}

export const canEditDefault = (user: SessionUser) => can(user, "admin");

function clean(steps: ChecklistStep[]): ChecklistStep[] {
  if (!steps.length) throw badRequest("Checklist cần ít nhất một mục");
  if (steps.length > MAX_STEPS) throw badRequest(`Checklist tối đa ${MAX_STEPS} mục`);
  return steps.map((s) => {
    const item = s.item.trim().replace(/\s+/g, " ").slice(0, 160);
    if (!item) throw badRequest("Nhập tên việc");
    const hint = s.hint?.trim().slice(0, 300) || null;
    return { id: s.id || newId(), item, needPhoto: !!s.needPhoto, hint, sample: s.sample || null };
  });
}

/** Lưu mẫu rồi đổi checklist cho các phòng chưa bắt đầu dọn. Trả số phòng được cập nhật. */
async function save(db: DB, user: SessionUser, propertyId: string | null, raw: ChecklistStep[]): Promise<number> {
  const steps = clean(raw);
  const ex = await row(db, propertyId);
  const values = { steps, updatedAt: new Date(), updatedById: user.id };
  if (ex) await db.update(checklistTemplates).set(values).where(eq(checklistTemplates.id, ex.id));
  else await db.insert(checklistTemplates).values({ name: propertyId ? "Checklist dọn phòng (riêng cơ sở)" : "Checklist dọn phòng mặc định", type: TYPE, propertyId, ...values });
  return refreshOpenTasks(db, propertyId);
}

/** Đổi checklist của các việc dọn chưa bắt đầu (TODO, chưa tick, chưa có ảnh) theo mẫu đang áp dụng. */
export async function refreshOpenTasks(db: DB, propertyId: string | null): Promise<number> {
  let propIds: string[];
  if (propertyId) propIds = [propertyId];
  else {
    // Mẫu mặc định chỉ áp dụng cho cơ sở chưa có mẫu riêng
    const own = new Set((await db.select({ p: checklistTemplates.propertyId }).from(checklistTemplates).where(eq(checklistTemplates.type, TYPE))).map((r) => r.p).filter(Boolean));
    propIds = (await db.select({ id: properties.id }).from(properties)).map((p) => p.id).filter((id) => !own.has(id));
  }
  if (!propIds.length) return 0;
  const open = await db.select({ id: tasks.id, propertyId: tasks.propertyId, photos: tasks.photoUrls }).from(tasks)
    .where(and(eq(tasks.type, TYPE), eq(tasks.status, "TODO"), inArray(tasks.propertyId, propIds)));
  if (!open.length) return 0;
  const cls = new Map((await db.select().from(checklistResults).where(inArray(checklistResults.taskId, open.map((t) => t.id)))).map((c) => [c.taskId, c.results as ChecklistItem[]]));
  const byProp = new Map<string, ChecklistItem[]>();
  let n = 0;
  for (const t of open) {
    const cur = cls.get(t.id) ?? [];
    if (t.photos.length || cur.some((c) => c.done || c.photo)) continue;
    if (!byProp.has(t.propertyId)) byProp.set(t.propertyId, await cleaningChecklistFor(db, t.propertyId));
    const results = byProp.get(t.propertyId)!;
    await db.insert(checklistResults).values({ taskId: t.id, results }).onConflictDoUpdate({ target: checklistResults.taskId, set: { results } });
    n++;
  }
  return n;
}

async function editable(db: DB, user: SessionUser, propertyId: string | null) {
  await assertCanEdit(db, user, propertyId);
  const t = await effectiveTemplate(db, propertyId);
  if (propertyId && !t.own) throw badRequest("Cơ sở này đang dùng checklist mặc định. Tạo checklist riêng trước khi sửa.");
  return t.steps.map((s) => ({ ...s }));
}

const find = (steps: ChecklistStep[], stepId: string) => {
  const i = steps.findIndex((s) => s.id === stepId);
  if (i < 0) throw notFound("Không tìm thấy mục này, tải lại trang");
  return i;
};

export async function addStep(db: DB, user: SessionUser, propertyId: string | null, s: { item: string; needPhoto: boolean; hint?: string | null; sample?: string | null }) {
  const steps = await editable(db, user, propertyId);
  steps.push({ id: newId(), item: s.item, needPhoto: s.needPhoto, hint: s.hint ?? null, sample: s.sample ?? null });
  return save(db, user, propertyId, steps);
}

/** Sửa tên, hướng dẫn, bắt buộc ảnh; sample: chuỗi = ảnh mới, null = xoá ảnh mẫu, undefined = giữ nguyên. */
export async function updateStep(db: DB, user: SessionUser, propertyId: string | null, stepId: string, s: { item: string; needPhoto: boolean; hint?: string | null; sample?: string | null }) {
  const steps = await editable(db, user, propertyId);
  const i = find(steps, stepId);
  steps[i] = { ...steps[i], item: s.item, needPhoto: s.needPhoto, hint: s.hint ?? null, ...(s.sample !== undefined ? { sample: s.sample } : {}) };
  return save(db, user, propertyId, steps);
}

export async function removeStep(db: DB, user: SessionUser, propertyId: string | null, stepId: string) {
  const steps = await editable(db, user, propertyId);
  steps.splice(find(steps, stepId), 1);
  return save(db, user, propertyId, steps);
}

export async function moveStep(db: DB, user: SessionUser, propertyId: string | null, stepId: string, dir: -1 | 1) {
  const steps = await editable(db, user, propertyId);
  const i = find(steps, stepId);
  const j = i + dir;
  if (j < 0 || j >= steps.length) return 0;
  [steps[i], steps[j]] = [steps[j], steps[i]];
  return save(db, user, propertyId, steps);
}

/** Tạo checklist riêng cho cơ sở, chép từ mẫu mặc định để sửa tiếp. */
export async function createOwnTemplate(db: DB, user: SessionUser, propertyId: string) {
  await assertCanEdit(db, user, propertyId);
  if (await row(db, propertyId)) throw badRequest("Cơ sở này đã có checklist riêng");
  const def = await effectiveTemplate(db, null);
  return save(db, user, propertyId, def.steps.map((s) => ({ ...s, id: newId() })));
}

/** Xoá checklist riêng, cơ sở quay về dùng mẫu mặc định. */
export async function deleteOwnTemplate(db: DB, user: SessionUser, propertyId: string) {
  await assertCanEdit(db, user, propertyId);
  const ex = await row(db, propertyId);
  if (!ex) return 0;
  await db.delete(checklistTemplates).where(eq(checklistTemplates.id, ex.id));
  return refreshOpenTasks(db, propertyId);
}

/** Cơ sở có checklist riêng (để hiện nhãn trong danh sách). */
export async function propertiesWithOwnTemplate(db: DB): Promise<Set<string>> {
  const rows = await db.select({ p: checklistTemplates.propertyId }).from(checklistTemplates).where(eq(checklistTemplates.type, TYPE));
  return new Set(rows.map((r) => r.p).filter((p): p is string => !!p));
}
