import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can, HttpError } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { ActionForm } from "@/components/ActionForm";
import { ItemPhotoButton } from "@/components/ItemPhotoButton";
import { requireUser } from "@/lib/server";
import { photoHref } from "@/lib/storage";
import { cleaningTask, dayVN, hmVN, STATE_LABEL } from "@/lib/services/cleaning";
import { completeCleaningAction, itemPhotoAction, toggleItemAction } from "../actions";

export default async function CleaningChecklist({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!can(user, "workTask")) return <NoAccess />;
  const { id } = await params;
  let data;
  try {
    data = await cleaningTask(getDb(), user, id);
  } catch (e) {
    if (e instanceof HttpError) return <div className="empty">{e.message}<Link className="btn" href="/don-dep">Về danh sách phòng</Link></div>;
    throw e;
  }
  const { task, propertyName, room, checklist, blocker } = data;
  const closed = task.status === "DONE" || task.status === "CANCELLED";
  const state = room?.state ?? (task.status === "DONE" ? "done" : "todo");
  const name = room?.roomName ?? task.title;
  const photoItems = checklist.filter((c) => c.needPhoto);

  return (
    <>
      <Link className="clean-back" href={`/don-dep?p=${task.propertyId}`}>← Phòng hôm nay</Link>
      <div className="topbar clean-head">
        <div className="clean-head-title">
          <h1>Phòng {name}</h1>
          <p className="small muted">
            {propertyName}, hạn dọn {hmVN(task.dueAt)} {D.formatDateVN(room?.checkoutOn ?? D.todayVN())}
            {room?.nextCheckInAt ? `. Khách đến ${hmVN(room.nextCheckInAt)}` : ". Hôm nay chưa có khách mới"}
          </p>
        </div>
        <span className={`pill ${state === "done" ? "ok" : state === "urgent" ? "bad" : state === "doing" ? "fc" : ""}`}>{STATE_LABEL[state]}</span>
      </div>

      {state === "urgent" && room?.minutesToCheckIn !== null && room && (
        <div className="banner bad" role="alert">
          <b>Dọn ngay.</b> {room.minutesToCheckIn! >= 0 ? `Khách đến sau ${room.minutesToCheckIn} phút.` : `Đã quá giờ khách đến ${-room.minutesToCheckIn!} phút.`}
        </div>
      )}

      <p className="small muted clean-hint">
        {photoItems.length
          ? `Tick từng việc. ${photoItems.length} việc có nút máy ảnh bắt buộc chụp ảnh; thiếu ảnh thì chưa hoàn thành được phòng. Chụp ảnh xong mục đó tự được tick.`
          : "Tick từng việc và tải ít nhất một ảnh nghiệm thu ở trang Công việc."}
      </p>

      <ol className="clean-check">
        {checklist.map((c, i) => (
          <li key={i} data-done={c.done} data-need={c.needPhoto && !c.photo ? "photo" : undefined}>
            <form action={toggleItemAction}>
              <input type="hidden" name="taskId" value={task.id} />
              <input type="hidden" name="index" value={i} />
              <input type="hidden" name="done" value={c.done ? "0" : "1"} />
              <button className="clean-tick" aria-pressed={c.done} disabled={closed} aria-label={`${c.done ? "Bỏ tick" : "Tick"}: ${c.item}`}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
              </button>
            </form>
            <span className="clean-item">
              {c.item}
              {c.needPhoto && <span className="small muted">{c.photo ? "Đã có ảnh" : "Bắt buộc chụp ảnh"}</span>}
            </span>
            {c.photo && (
              <a href={photoHref(c.photo)} target="_blank" rel="noreferrer" className="clean-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photoHref(c.photo)} alt={`Ảnh: ${c.item}`} loading="lazy" />
              </a>
            )}
            {c.needPhoto && !closed && <ItemPhotoButton action={itemPhotoAction} taskId={task.id} index={i} item={c.item} taken={!!c.photo} />}
          </li>
        ))}
      </ol>

      <Link className="btn clean-issue-link" href={`/don-dep/su-co?p=${task.propertyId}${task.roomId ? `&room=${task.roomId}` : ""}`}>
        Báo thiếu chìa khoá, thiếu đồ hoặc đồ hỏng trong phòng
      </Link>

      <div className="clean-finish">
        {task.status === "DONE" ? (
          <p className="pos"><b>Đã hoàn thành</b>{task.completedAt ? ` lúc ${hmVN(task.completedAt)} ${D.formatDateVN(dayVN(task.completedAt))}` : ""}.</p>
        ) : blocker ? (
          <button className="btn primary" disabled>{blocker}</button>
        ) : (
          <ActionForm action={completeCleaningAction} submit={`Hoàn thành phòng ${name}`} okText="Đã gửi lên Daily report" className="row">
            <input type="hidden" name="taskId" value={task.id} />
          </ActionForm>
        )}
      </div>
    </>
  );
}
