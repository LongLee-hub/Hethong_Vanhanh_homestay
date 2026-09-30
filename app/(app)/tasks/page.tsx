import { inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { checklistResults } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { listTasks } from "@/lib/services/tasks";
import { staffForProperties, visibleProperties } from "@/lib/queries";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { checklistAction, createTaskAction, taskPhotoAction, taskStatusAction } from "../actions";

const TYPE = { CLEANING: "Dọn phòng", CHECKIN: "Check-in", CHECKOUT: "Check-out", MAINTENANCE: "Bảo trì", PURCHASE: "Mua sắm", BAD_REVIEW: "Xử lý đánh giá", INVENTORY: "Kiểm kho", RECURRING: "Định kỳ" };
const STATUS = { TODO: "Cần làm", IN_PROGRESS: "Đang làm", DONE: "Hoàn thành", CANCELLED: "Đã hủy" };
const fmt = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 16).replace("T", " ").split(" ").map((x, i) => (i ? x : D.formatDateVN(x))).join(" ");

export default async function Tasks() {
  const user = await requireUser();
  if (!can(user, "workTask")) return <NoAccess />;
  const db = getDb();
  const props = await visibleProperties(db, user);
  const name = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const since = new Date(Date.now() - 7 * 86400_000);
  const list = (await listTasks(db, user, { from: since })).filter((t) => t.status !== "CANCELLED");
  const cls = list.length ? await db.select().from(checklistResults).where(inArray(checklistResults.taskId, list.map((t) => t.id))) : [];
  const staff = await staffForProperties(db, props.map((p) => p.id));
  const now = new Date();
  return (
    <>
      <div className="topbar"><h1>Công việc</h1></div>
      <div className="stack">
        {list.map((t) => {
          const cl = cls.find((c) => c.taskId === t.id)?.results as { item: string; done: boolean }[] | undefined;
          const overdue = ["TODO", "IN_PROGRESS"].includes(t.status) && t.dueAt < now;
          return (
            <details key={t.id} className={`panel task ${overdue ? "overdue" : ""}`} open={t.status !== "DONE" && user.role === "HOUSEKEEPER"}>
              <summary className="row">
                <span className="pill">{TYPE[t.type]}</span>
                <b>{t.title}</b>
                <span className="small muted">{name[t.propertyId]} · hạn {fmt(t.dueAt)}</span>
                <span className="spacer" />
                <span className={`pill ${overdue ? "bad" : t.status === "DONE" ? "ok" : ""}`}>{overdue ? "Quá hạn" : STATUS[t.status]}</span>
              </summary>
              {t.description && <p className="small">{t.description}</p>}
              {cl && (
                <form action={checklistAction} className="stack" style={{ gap: 6 }}>
                  <input type="hidden" name="taskId" value={t.id} />
                  {cl.map((c, i) => (
                    <label key={i} className="check-item"><input type="hidden" name="item" value={c.item} /><input type="checkbox" name="done" value={c.item} defaultChecked={c.done} disabled={t.status === "DONE"} id={`cl-${t.id}-${i}`} /> {c.item}</label>
                  ))}
                  {t.status !== "DONE" && <button className="btn sm">Lưu checklist</button>}
                </form>
              )}
              <p className="small muted">{t.photoUrls.length} ảnh nghiệm thu</p>
              {t.status !== "DONE" && (
                <div className="grid g2">
                  <ActionForm action={taskPhotoAction} submit="Tải ảnh nghiệm thu" okText="Đã thêm ảnh"><input type="hidden" name="taskId" value={t.id} /><PhotoInput name="photo" label="Ảnh" required /></ActionForm>
                  <ActionForm action={taskStatusAction} submit={t.status === "TODO" ? "Bắt đầu" : "Hoàn thành"} className="row">
                    <input type="hidden" name="taskId" value={t.id} /><input type="hidden" name="status" value={t.status === "TODO" ? "IN_PROGRESS" : "DONE"} />
                  </ActionForm>
                </div>
              )}
            </details>
          );
        })}
        {!list.length && <div className="empty">Không có việc nào trong 7 ngày qua và sắp tới.</div>}
      </div>
      {can(user, "assignTask") && (
        <section className="panel" style={{ marginTop: 16 }}>
          <header><h2>Giao việc</h2></header>
          <ActionForm action={createTaskAction} submit="Giao việc" okText="Đã giao">
            <label className="field full"><span>Tên việc</span><input type="text" name="title" id="title" required /></label>
            <label className="field"><span>Loại</span><select name="type" id="type">{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="field"><span>Cơ sở</span><select name="propertyId" id="propertyId">{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="field"><span>Người làm</span><select name="assigneeId" id="assigneeId"><option value="">Chưa giao</option>{[...new Map(staff.map((s) => [s.id, s])).values()].map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label className="field"><span>Hạn chót</span><input type="datetime-local" name="dueAt" id="dueAt" defaultValue={`${D.todayVN()}T17:00`} required /></label>
            <label className="field"><span>Ưu tiên</span><select name="priority" id="priority" defaultValue="MEDIUM"><option value="LOW">Thấp</option><option value="MEDIUM">Vừa</option><option value="HIGH">Cao</option><option value="URGENT">Khẩn</option></select></label>
            <label className="field"><span>Lặp lại</span><select name="recurrenceRule" id="recurrenceRule"><option value="">Không</option>{[1, 5, 10, 15, 20, 25].map((d) => <option key={d} value={`monthly:${d}`}>Hằng tháng, ngày {d}</option>)}</select></label>
            <label className="field full"><span>Mô tả</span><textarea name="description" id="description" /></label>
          </ActionForm>
        </section>
      )}
    </>
  );
}
