import Link from "next/link";
import { asc, inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { properties, users } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { AutoRefresh } from "@/components/AutoRefresh";
import { requireUser } from "@/lib/server";
import { cleaningBoard, dayVN, hmVN, myShiftsToday, STATE_LABEL, workablePropertyIds, type BoardRoom } from "@/lib/services/cleaning";
import { myNotifications, vapidPublicKey } from "@/lib/services/notify";
import { PushToggle } from "@/components/PushToggle";
import { CleanNav } from "./nav";
import { markReadAction, testPushAction } from "./actions";

const PILL = { done: "ok", urgent: "bad", doing: "fc", todo: "", missed: "warn" } as const;

function guestLine(r: BoardRoom, today: string) {
  const parts = [r.checkoutOn < today ? `Tồn từ ${D.formatDateVN(r.checkoutOn)}` : r.checkoutAt ? `Khách trả ${hmVN(r.checkoutAt)}` : `Hạn ${hmVN(r.dueAt)}`];
  parts.push(r.nextCheckInAt ? `khách mới đến ${hmVN(r.nextCheckInAt)}` : "hôm nay chưa có khách mới");
  return parts.join(", ");
}

export default async function CleaningBoard({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "workTask")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const today = D.todayVN();
  const [shifts, workable] = await Promise.all([myShiftsToday(db, user, today), workablePropertyIds(db, user, today)]);
  const props = workable.length ? await db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, workable)).orderBy(asc(properties.name)) : [];
  if (!props.length) {
    return (
      <>
        <div className="topbar"><h1>Dọn phòng</h1></div>
        <div className="empty">Bạn chưa được giao cơ sở nào. Vào ca hỗ trợ ở trang Chấm công nếu hôm nay sang giúp cơ sở khác.<Link className="btn primary" href="/attendance">Chấm công</Link></div>
      </>
    );
  }
  const pid = props.some((p) => p.id === sp.p) ? sp.p : (shifts[0]?.propertyId ?? props[0].id);
  const prop = props.find((p) => p.id === pid)!;
  const board = await cleaningBoard(db, user, pid, today);
  const shift = shifts.find((s) => s.propertyId === pid);
  const ids = [...new Set(board.map((r) => r.assigneeId).filter(Boolean) as string[])];
  const names = new Map((ids.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  // Thông báo chưa xem; cảnh báo dọn ngay của cơ sở đang xem đã hiện thành mảng đỏ bên dưới nên không nhắc lại
  const inbox = (await myNotifications(db, user, { unreadOnly: true, limit: 10 })).filter((n) => !(n.urgent && n.propertyId === pid && n.key.endsWith(`:${today}`)));
  const urgent = board.filter((r) => r.state === "urgent");
  // Khách mới đã vào phòng hơn 2 giờ mà việc chưa xong: tách riêng, không trộn với phòng đang phải dọn
  const missed = board.filter((r) => r.state === "missed");
  const open = board.filter((r) => r.state !== "done" && r.state !== "missed");
  const done = board.filter((r) => r.state === "done");
  const pct = board.length ? Math.round((done.length / board.length) * 100) : 0;

  const row = (r: BoardRoom) => (
    <li key={r.taskId}>
      <Link href={`/don-dep/${r.taskId}`} className="clean-room" data-state={r.state}>
        <span className="clean-room-main">
          <b>{r.roomName}</b>
          <span className="small muted">{guestLine(r, today)}</span>
          <span className="small muted">
            {r.photoNeed ? `${r.photos}/${r.photoNeed} ảnh` : `${r.photos} ảnh`} · {r.ticks}/{r.total} việc
            {r.assigneeId && r.assigneeId !== user.id ? ` · giao ${names.get(r.assigneeId)}` : ""}
          </span>
        </span>
        <span className={`pill ${r.missingPhotos ? "warn" : PILL[r.state]}`}>{r.missingPhotos ? "Xong, thiếu ảnh" : STATE_LABEL[r.state]}</span>
      </Link>
    </li>
  );

  return (
    <>
      <AutoRefresh seconds={60} />
      <div className="topbar">
        <div>
          <h1>{prop.name}</h1>
          <p className="small muted clean-shift">
            {shift
              ? <>{shift.support ? <span className="pill warn">Ca hỗ trợ</span> : <span className="pill ok">Ca chính</span>} vào ca {hmVN(shift.checkInAt)}{shift.checkOutAt ? `, đã ra ca ${hmVN(shift.checkOutAt)}` : ""}</>
              : user.role === "HOUSEKEEPER" ? <>Hôm nay bạn chưa vào ca ở đây. <Link href="/attendance">Vào ca</Link></> : <>Xem với quyền quản lý</>}
          </p>
        </div>
      </div>
      <CleanNav current="board" p={pid} manage={can(user, "assignTask")} />
      <PushToggle publicKey={vapidPublicKey()} testAction={testPushAction} />

      {inbox.length > 0 && (
        <section className="inbox" aria-label="Thông báo chưa xem">
          <div className="row"><h2 className="clean-h" style={{ margin: 0 }}>Thông báo mới</h2><span className="spacer" />
            <form action={markReadAction}><button className="btn sm">Đánh dấu đã xem hết</button></form>
          </div>
          <ul>
            {inbox.map((n) => (
              <li key={n.id} data-urgent={n.urgent || undefined}>
                <a href={n.url ?? "/don-dep"}><b>{n.title}</b><span className="small">{n.body}</span><span className="small muted">{hmVN(n.createdAt)} {D.formatDateVN(dayVN(n.createdAt))}</span></a>
                <form action={markReadAction}><input type="hidden" name="id" value={n.id} /><button className="btn sm" aria-label={`Đã xem: ${n.title}`}>Đã xem</button></form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.length > 1 && (
        <nav className="chips clean-props" aria-label="Chọn cơ sở">
          {props.map((p) => <Link key={p.id} className="chip" aria-pressed={p.id === pid} href={`/don-dep?p=${p.id}`}>{p.name}</Link>)}
        </nav>
      )}

      <section className="clean-progress" aria-label="Tiến độ hôm nay">
        <div className="row"><span>Đã xong <b>{done.length}/{board.length}</b> phòng</span><span className="spacer" /><span className="small muted">{D.formatDateVN(today)}</span></div>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Phòng đã dọn xong"><i style={{ width: `${pct}%` }} /></div>
      </section>

      {urgent.map((r) => (
        <section key={r.taskId} className="clean-alert" role="alert">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01" /></svg>
          <div>
            <b>Dọn ngay {r.roomName}</b>
            <p>
              Khách đến {r.nextCheckInAt ? hmVN(r.nextCheckInAt) : ""}
              {r.minutesToCheckIn !== null && (r.minutesToCheckIn >= 0 ? `, còn ${r.minutesToCheckIn} phút.` : `, đã quá ${-r.minutesToCheckIn} phút.`)} Phòng mới làm {r.ticks}/{r.total} việc.
            </p>
            <Link className="btn danger-solid" href={`/don-dep/${r.taskId}`}>Mở checklist {r.roomName}</Link>
          </div>
        </section>
      ))}

      <h2 className="clean-h">Chưa xong <span className="muted small">xếp theo giờ khách đến</span></h2>
      {open.length ? <ul className="clean-list">{open.map(row)}</ul> : <div className="empty">{board.length ? "Đã dọn xong hết phòng hôm nay." : "Hôm nay không có phòng cần dọn."}</div>}

      {missed.length > 0 && (
        <>
          <h2 className="clean-h">Quá giờ <span className="muted small">khách mới đã vào phòng, chưa có checklist</span></h2>
          <ul className="clean-list">{missed.map(row)}</ul>
        </>
      )}

      {done.length > 0 && (
        <>
          <h2 className="clean-h">Đã xong</h2>
          <ul className="clean-list">{done.map(row)}</ul>
        </>
      )}
    </>
  );
}
