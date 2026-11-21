import Link from "next/link";
import { asc, eq, inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { properties, rooms } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { requireUser } from "@/lib/server";
import { photoHref } from "@/lib/storage";
import { dayVN, hmVN, ISSUE_CATEGORY, listIssues, myShiftsToday, workablePropertyIds } from "@/lib/services/cleaning";
import { reportIssueAction, resolveIssueAction } from "../actions";
import { CleanNav } from "../nav";

export default async function ReportIssue({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "workTask")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const today = D.todayVN();
  const [workable, shifts] = await Promise.all([workablePropertyIds(db, user, today), myShiftsToday(db, user, today)]);
  const props = workable.length ? await db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, workable)).orderBy(asc(properties.name)) : [];
  if (!props.length) return <NoAccess />;
  const pid = props.some((p) => p.id === sp.p) ? sp.p : (shifts[0]?.propertyId ?? props[0].id);
  const rs = await db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.propertyId, pid)).orderBy(asc(rooms.name));
  const issues = await listIssues(db, user, { propertyIds: [pid], since: new Date(Date.now() - 7 * 86400_000) });
  const open = issues.filter((i) => !i.resolvedAt).reverse();
  const closed = issues.filter((i) => i.resolvedAt).reverse();

  return (
    <>
      <div className="topbar"><div><h1>Báo sự cố</h1><p className="small muted">{props.find((p) => p.id === pid)?.name}: quản lý nhận được ngay khi bạn gửi.</p></div></div>
      <CleanNav current="issues" p={pid} manage={can(user, "assignTask")} />

      <section className="panel">
        <ActionForm action={reportIssueAction} submit="Gửi cho quản lý" okText="Đã gửi cho quản lý">
          <fieldset className="full clean-cats">
            <legend>Loại sự cố</legend>
            {Object.entries(ISSUE_CATEGORY).map(([k, v], i) => (
              <label key={k} className="chip"><input type="radio" name="category" value={k} defaultChecked={i === 0} className="sr-only" />{v}</label>
            ))}
          </fieldset>
          <label className="field">
            <span>Cơ sở</span>
            <select name="propertyId" id="propertyId" defaultValue={pid}>{props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          </label>
          <label className="field">
            <span>Phòng</span>
            <select name="roomId" id="roomId" defaultValue={rs.some((r) => r.id === sp.room) ? sp.room : ""}>
              <option value="">Khu chung / không rõ phòng</option>
              {rs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label className="field full">
            <span>Mô tả</span>
            <textarea name="description" id="description" required placeholder="VD: Mất 1 chìa khoá phòng, khách phải gọi lễ tân mở cửa" />
          </label>
          <PhotoInput name="photo" label="Ảnh sự cố (nên có)" camera />
        </ActionForm>
      </section>

      <h2 className="clean-h">Đang mở</h2>
      {open.length ? (
        <ul className="clean-issues">
          {open.map((i) => (
            <li key={i.id} data-age={i.ageDays >= 3 ? "old" : i.ageDays >= 1 ? "stale" : undefined}>
              <div className="row">
                <b>{ISSUE_CATEGORY[i.category] ?? i.category}{i.roomName ? ` · ${i.roomName}` : ""}</b>
                <span className="spacer" />
                <span className={`pill ${i.ageDays >= 3 ? "bad" : i.ageDays >= 1 ? "warn" : ""}`}>{i.ageDays ? `Mở ${i.ageDays} ngày` : "Mới"}</span>
              </div>
              <p>{i.description}</p>
              <p className="small muted">
                {i.reportedBy} báo {hmVN(i.reportedAt)} {D.formatDateVN(dayVN(i.reportedAt))}. {i.assignee ? `Đang giao ${i.assignee}.` : "Chưa giao ai xử lý."}
                {i.photoUrl && <> <a href={photoHref(i.photoUrl)} target="_blank" rel="noreferrer">Xem ảnh</a></>}
              </p>
              {(i.assigneeId === user.id || can(user, "assignTask")) && (
                <ActionForm action={resolveIssueAction} submit="Đã xử lý xong" okText="Đã đóng" className="row" submitClass="btn sm">
                  <input type="hidden" name="issueId" value={i.id} />
                  <input type="text" name="note" placeholder="Đã làm gì (không bắt buộc)" aria-label="Ghi chú xử lý" className="grow" />
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      ) : <div className="empty">Không có sự cố nào đang mở ở cơ sở này.</div>}

      {closed.length > 0 && (
        <>
          <h2 className="clean-h">Đã xử lý trong 7 ngày</h2>
          <ul className="clean-issues">
            {closed.map((i) => (
              <li key={i.id} data-closed>
                <div className="row"><b>{ISSUE_CATEGORY[i.category] ?? i.category}{i.roomName ? ` · ${i.roomName}` : ""}</b><span className="spacer" /><span className="pill ok">Đã xử lý</span></div>
                <p className="small">{i.description}{i.resolutionNote ? `. Xử lý: ${i.resolutionNote}` : ""}</p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="small muted"><Link href={`/don-dep?p=${pid}`}>Về danh sách phòng hôm nay</Link></p>
    </>
  );
}
