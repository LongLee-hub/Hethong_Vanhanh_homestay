import Link from "next/link";
import { asc, inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { properties } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { cleaningCalendar, myShiftsToday, STATE_LABEL, weekStart, workablePropertyIds, type CalendarEvent } from "@/lib/services/cleaning";
import { CleanNav } from "../nav";

const DOW = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const dow = (d: string) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()];
const STATE: Record<CalendarEvent["state"], [string, string]> = {
  done: [STATE_LABEL.done, "ok"], urgent: [STATE_LABEL.urgent, "bad"], doing: [STATE_LABEL.doing, "fc"], todo: [STATE_LABEL.todo, ""], missed: ["Quá giờ", "warn"],
  upcoming: ["Sắp tới", ""], none: ["Chưa có việc dọn", "warn"],
};

export default async function CleaningCalendar({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "workTask")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const today = D.todayVN();
  const [workable, shifts] = await Promise.all([workablePropertyIds(db, user, today), myShiftsToday(db, user, today)]);
  const props = workable.length ? await db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, workable)).orderBy(asc(properties.name)) : [];
  if (!props.length) return <NoAccess />;
  const pid = props.some((p) => p.id === sp.p) ? sp.p : (shifts[0]?.propertyId ?? props[0].id);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.d ?? "") ? sp.d : today;
  const from = weekStart(day);
  const days = D.eachDay(from, D.addDays(from, 6));
  const events = await cleaningCalendar(db, user, pid, from);
  const link = (d: string) => `/don-dep/lich?p=${pid}&d=${d}`;

  return (
    <>
      <div className="topbar">
        <div><h1>Lịch dọn phòng</h1><p className="small muted">{props.find((p) => p.id === pid)?.name}: tuần {D.formatDateVN(from)} – {D.formatDateVN(D.addDays(from, 6))}</p></div>
        <div className="month-step">
          <Link className="btn" href={link(D.addDays(from, -7))} aria-label="Tuần trước">‹</Link>
          <Link className="step-label" href={link(today)}>Tuần này</Link>
          <Link className="btn" href={link(D.addDays(from, 7))} aria-label="Tuần sau">›</Link>
        </div>
      </div>
      <CleanNav current="calendar" p={pid} />
      {props.length > 1 && (
        <nav className="chips clean-props" aria-label="Chọn cơ sở">
          {props.map((p) => <Link key={p.id} className="chip" aria-pressed={p.id === pid} href={`/don-dep/lich?p=${p.id}&d=${day}`}>{p.name}</Link>)}
        </nav>
      )}
      <nav className="clean-days" aria-label="Ngày trong tuần">
        {days.map((d) => {
          const n = events.filter((e) => e.date === d && e.kind === "OUT").length;
          return (
            <a key={d} href={`#d-${d}`} data-today={d === today || undefined}>
              <span>{d === today ? "Nay" : dow(d)}</span><b>{d.slice(8)}</b><span className="small">{n ? `${n} dọn` : "—"}</span>
            </a>
          );
        })}
      </nav>
      {days.map((d) => {
        const list = events.filter((e) => e.date === d);
        return (
          <section key={d} id={`d-${d}`} className="clean-day">
            <h2 className="clean-h">{dow(d)} {D.formatDateVN(d)}{d === today ? " (hôm nay)" : ""}</h2>
            {list.length ? (
              <ul className="clean-events">
                {list.map((e, i) => {
                  const [label, tone] = STATE[e.state];
                  const body = (
                    <>
                      <span className="clean-time num">{e.time}</span>
                      <span className="clean-room-main"><b>{e.roomName}</b><span className="small muted">{e.kind === "OUT" ? "Trả phòng, cần dọn" : "Khách đến"}{e.guestName ? ` · ${e.guestName}` : ""}</span></span>
                      <span className={`pill ${tone}`}>{label}</span>
                    </>
                  );
                  return <li key={i}>{e.taskId ? <Link href={`/don-dep/${e.taskId}`}>{body}</Link> : <div>{body}</div>}</li>;
                })}
              </ul>
            ) : <p className="small muted">Không có trả phòng hay khách đến.</p>}
          </section>
        );
      })}
    </>
  );
}
