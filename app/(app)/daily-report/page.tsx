import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { NoAccess } from "@/components/NoAccess";
import { ActionForm } from "@/components/ActionForm";
import { AutoRefresh } from "@/components/AutoRefresh";
import { requireUser } from "@/lib/server";
import { photoHref } from "@/lib/storage";
import { staffForProperties, visibleProperties } from "@/lib/queries";
import {
  canViewCleaningReport, cleaningDailyReport, cleaningWeeklyReport, dayVN, hmVN, ISSUE_CATEGORY, weekStart,
} from "@/lib/services/cleaning";
import { assignIssueAction, resolveIssueAction } from "../don-dep/actions";

const DOW = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
const dow = (d: string) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()];
const TONE_PILL = { bad: "bad", warn: "warn", info: "", ok: "ok", doing: "fc" } as const;

export default async function DailyReport({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!canViewCleaningReport(user)) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const today = D.todayVN();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(sp.d ?? "") && sp.d <= today ? sp.d : today;
  const week = sp.view === "week";
  const props = await visibleProperties(db, user);
  const pid = props.some((p) => p.id === sp.p) ? sp.p : undefined;
  const q = (o: Record<string, string | undefined>) => {
    const s = new URLSearchParams(Object.entries({ view: week ? "week" : undefined, d: date === today ? undefined : date, p: pid, ...o }).filter(([, v]) => v) as [string, string][]).toString();
    return `/daily-report${s ? `?${s}` : ""}`;
  };
  const step = week ? 7 : 1;
  const prev = D.addDays(date, -step);
  const next = D.addDays(date, step);

  const head = (
    <>
      {date === today && !week && <AutoRefresh seconds={120} />}
      <div className="topbar">
        <div>
          <h1>Daily report dọn phòng</h1>
          <p className="small muted">
            {week ? `Tuần ${D.formatDateVN(weekStart(date))} – ${D.formatDateVN(D.addDays(weekStart(date), 6))}` : `${dow(date)} ${D.formatDateVN(date)}${date === today ? `, cập nhật ${hmVN(new Date())}` : ""}`}
          </p>
        </div>
        <div className="seg" role="group" aria-label="Chế độ xem">
          <Link className="seg-link" aria-pressed={!week} href={q({ view: undefined })}>Ngày</Link>
          <Link className="seg-link" aria-pressed={week} href={q({ view: "week" })}>Tuần</Link>
        </div>
        <div className="month-step">
          <Link className="btn" href={q({ d: prev })} aria-label={week ? "Tuần trước" : "Ngày trước"}>‹</Link>
          <Link className="step-label" href={q({ d: undefined })} aria-current={date === today ? "page" : undefined}>{week ? "Tuần này" : "Hôm nay"}</Link>
          {next <= today || (week && weekStart(next) <= today)
            ? <Link className="btn" href={q({ d: next > today ? today : next })} aria-label={week ? "Tuần sau" : "Ngày sau"}>›</Link>
            : <span className="btn" aria-disabled="true">›</span>}
        </div>
      </div>
      {!week && props.length > 1 && (
        <nav className="chips clean-props" aria-label="Lọc cơ sở">
          <Link className="chip" aria-pressed={!pid} href={q({ p: undefined })}>Tất cả</Link>
          {props.map((p) => <Link key={p.id} className="chip" aria-pressed={p.id === pid} href={q({ p: p.id })}>{p.name}</Link>)}
        </nav>
      )}
    </>
  );

  if (week) {
    const w = await cleaningWeeklyReport(db, user, date);
    const flag = { ok: "ok", bad: "bad", warn: "warn", info: "", none: "", future: "" } as const;
    return (
      <>
        {head}
        <div className="cards">
          <div className="stat"><span className="lbl">Phòng đã dọn</span><span className="v">{w.totals.done}/{w.totals.total}</span><span className="s">tính tới hôm nay</span></div>
          <div className="stat"><span className="lbl">Xong trước giờ khách đến</span><span className="v">{w.totals.done ? Math.round((w.totals.onTime / w.totals.done) * 100) : 0}%</span><span className="s">{w.totals.done - w.totals.onTime} lần dọn trễ</span></div>
          <div className="stat"><span className="lbl">Xong nhưng thiếu ảnh</span><span className={`v ${w.totals.missingPhotos ? "neg" : ""}`}>{w.totals.missingPhotos}</span><span className="s">phòng</span></div>
          <div className="stat"><span className="lbl">Sự cố mới / đã đóng</span><span className="v">{w.totals.issuesNew} / {w.totals.issuesClosed}</span><span className="s">trong tuần</span></div>
          <div className="stat"><span className="lbl">Ca hỗ trợ</span><span className="v">{w.totals.supportShifts}</span><span className="s">lượt sang cơ sở khác</span></div>
        </div>

        <section className="panel" style={{ marginBottom: 16 }}>
          <header><div><h2>Phòng xong / cần dọn theo ngày</h2><p>Đỏ: có phòng xong sau giờ khách đến hoặc bỏ dở. Cam: có phòng xong nhưng thiếu ảnh.</p></div></header>
          <div className="tbl-wrap"><table className="clean-week">
            <thead><tr><th>Cơ sở</th>{w.days.map((d) => <th key={d} className="n">{dow(d)} {d.slice(8)}</th>)}</tr></thead>
            <tbody>
              {w.grid.map((g) => (
                <tr key={g.propertyId}>
                  <td><b>{g.name}</b></td>
                  {g.cells.map((c) => (
                    <td key={c.date} className="n">
                      {c.total ? <Link className={`pill ${flag[c.flag]}`} href={`/daily-report?d=${c.date}&p=${g.propertyId}`}>{c.done}/{c.total}</Link> : <span className="muted">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
              {!w.grid.length && <tr><td colSpan={8} className="muted">Chưa có cơ sở nào.</td></tr>}
            </tbody>
          </table></div>
        </section>

        <section className="panel">
          <header><h2>Theo nhân viên</h2></header>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Nhân viên</th><th>Ca chính</th><th>Ca hỗ trợ</th><th className="n">Số ca</th><th className="n">Phòng đã dọn</th><th className="n">Đủ ảnh</th><th className="n">Bị cảnh báo</th></tr></thead>
            <tbody>
              {w.staff.map((s) => (
                <tr key={s.userId}>
                  <td><b>{s.name}</b></td>
                  <td>{s.main}</td>
                  <td className="muted">{s.support}</td>
                  <td className="n">{s.shifts}</td>
                  <td className="n">{s.rooms}</td>
                  <td className={`n ${s.photoPct !== null && s.photoPct < 90 ? "neg" : ""}`}>{s.photoPct === null ? "—" : `${s.photoPct}%`}</td>
                  <td className="n"><span className={`pill ${s.warnings >= 3 ? "bad" : s.warnings ? "warn" : "ok"}`}>{s.warnings ? `${s.warnings} lần` : "0"}</span></td>
                </tr>
              ))}
              {!w.staff.length && <tr><td colSpan={7} className="muted">Tuần này chưa có ca nào.</td></tr>}
            </tbody>
          </table></div>
          <p className="small muted">Bị cảnh báo: phòng người đó bấm xong sau giờ khách đến, xong thiếu ảnh, hoặc được giao mà bỏ dở.</p>
        </section>
      </>
    );
  }

  const r = await cleaningDailyReport(db, user, date, { propertyId: pid });
  const staff = [...new Map((await staffForProperties(db, props.map((p) => p.id))).map((s) => [s.id, s])).values()];

  return (
    <>
      {head}
      <div className="cards">
        <div className="stat"><span className="lbl">Phòng cần dọn</span><span className="v">{r.totals.total}</span><span className="s">theo lịch trả phòng</span></div>
        <div className="stat"><span className="lbl">Đã xong, đủ ảnh</span><span className="v pos">{r.totals.doneWithPhotos}</span><span className="s">{r.totals.missingPhotos ? `${r.totals.missingPhotos} phòng xong thiếu ảnh` : "không phòng nào thiếu ảnh"}</span></div>
        <div className="stat"><span className="lbl">Chưa xong</span><span className={`v ${r.totals.urgent ? "neg" : ""}`}>{r.totals.open}</span><span className="s">{r.totals.urgent ? `${r.totals.urgent} phòng khách sắp đến` : "không phòng nào gấp"}</span></div>
        <div className="stat"><span className="lbl">Nhân sự chưa hoàn thành</span><span className={`v ${r.totals.notFinished ? "neg" : ""}`}>{r.totals.notFinished}</span><span className="s">cơ sở hết ca còn phòng</span></div>
        <div className="stat"><span className="lbl">Sự cố đang mở</span><span className={`v ${r.totals.issuesStale ? "neg" : ""}`}>{r.totals.issuesOpen}</span><span className="s">{r.totals.issuesStale ? `${r.totals.issuesStale} sự cố quá 24 giờ` : "chưa có sự cố để lâu"}</span></div>
      </div>

      <div className="grid g2 clean-report-top">
        <section className="panel">
          <header><h2>Cảnh báo cần xử lý</h2><span className={`pill ${r.alerts.some((a) => a.tone === "bad") ? "bad" : ""}`}>{r.alerts.length} mục</span></header>
          {r.alerts.length ? (
            <ul className="clean-alerts">
              {r.alerts.map((a, i) => (
                <li key={i} data-tone={a.tone}>
                  <span className="dot" aria-hidden="true" />
                  <span><b>{a.title}</b><span className="small">{a.detail}</span></span>
                  {a.href && <Link className="btn sm" href={a.href}>Xem phòng</Link>}
                </li>
              ))}
            </ul>
          ) : <div className="empty">Không có cảnh báo nào.</div>}
        </section>

        <section className="panel">
          <header><h2>Sự cố cơ sở vật chất</h2><span className="pill warn">{r.issues.length} đang mở</span></header>
          {r.issues.length ? (
            <ul className="clean-issues">
              {r.issues.map((i) => (
                <li key={i.id} data-age={i.ageDays >= 3 ? "old" : i.ageDays >= 1 ? "stale" : undefined}>
                  <div className="row">
                    <b>{ISSUE_CATEGORY[i.category] ?? i.category}{i.roomName ? ` ${i.roomName}` : ""} · {i.propertyName}</b>
                    <span className="spacer" />
                    <span className={`pill ${i.ageDays >= 3 ? "bad" : i.ageDays >= 1 ? "warn" : ""}`}>{i.ageDays ? `Mở ${i.ageDays} ngày` : "Mới"}</span>
                  </div>
                  <p className="small">{i.description}</p>
                  <p className="small muted">
                    {i.reportedBy} báo {hmVN(i.reportedAt)} {D.formatDateVN(dayVN(i.reportedAt))}
                    {i.photoUrl && <> · <a href={photoHref(i.photoUrl)} target="_blank" rel="noreferrer">Xem ảnh</a></>}
                  </p>
                  <div className="clean-issue-actions">
                    <ActionForm action={assignIssueAction} submit="Giao" okText="Đã giao" className="row" submitClass="btn sm">
                      <input type="hidden" name="issueId" value={i.id} />
                      <select name="assigneeId" defaultValue={i.assigneeId ?? ""} aria-label="Người xử lý">
                        <option value="">Chưa giao ai</option>
                        {staff.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </ActionForm>
                    <ActionForm action={resolveIssueAction} submit="Đóng sự cố" okText="Đã đóng" className="row" submitClass="btn sm">
                      <input type="hidden" name="issueId" value={i.id} />
                      <input type="text" name="note" placeholder="Đã xử lý thế nào" aria-label="Ghi chú xử lý" />
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          ) : <div className="empty">Không có sự cố nào đang mở.</div>}
          <p className="small muted">Sự cố mở quá 24 giờ được nhắc lại mỗi ngày cho tới khi đóng.</p>
        </section>
      </div>

      <section className="panel" style={{ marginBlock: 16 }}>
        <header><h2>Theo cơ sở</h2></header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Cơ sở</th><th>Ca chính</th><th>Ca hỗ trợ</th><th className="n">Đã xong</th><th className="n">Thiếu ảnh</th><th>Trạng thái</th></tr></thead>
          <tbody>
            {r.rows.map((p) => (
              <tr key={p.propertyId}>
                <td><Link href={`/don-dep?p=${p.propertyId}`}><b>{p.name}</b></Link></td>
                <td>{p.main.join(", ") || <span className="muted">Chưa ai vào ca</span>}</td>
                <td className="muted">{p.support.join(", ") || "—"}</td>
                <td className="n">
                  <span className="clean-mini"><span className="progress"><i style={{ width: `${p.total ? Math.round((p.done / p.total) * 100) : 0}%` }} /></span>{p.done}/{p.total}</span>
                </td>
                <td className={`n ${p.missingPhotos ? "neg" : ""}`}>{p.missingPhotos}</td>
                <td><span className={`pill ${TONE_PILL[p.status.tone]}`}>{p.status.label}</span></td>
              </tr>
            ))}
            {!r.rows.length && <tr><td colSpan={6} className="muted">Chưa có cơ sở nào.</td></tr>}
          </tbody>
        </table></div>
      </section>

      <section className="panel">
        <header><div><h2>Ảnh kiểm tra phòng</h2><p>Ô viền đỏ đứt: mục bắt buộc ảnh nhưng chưa có ảnh.</p></div></header>
        {r.photoCards.length ? (
          <div className="clean-photos">
            {r.photoCards.map((c) => {
              const have = c.photos.filter((p) => p.url).length;
              return (
                <article key={c.taskId} data-missing={c.missing || undefined}>
                  <header>
                    <span><span><Link href={`/don-dep/${c.taskId}`}><b>{c.roomName}</b></Link> · {c.propertyName}</span><span className="small muted">{c.by}{c.completedAt ? `, xong ${hmVN(c.completedAt)}` : c.done ? "" : ", đang dọn"}</span></span>
                    <span className={`pill ${c.missing ? "bad" : c.done ? "ok" : "fc"}`}>{have}/{c.photos.length || 0} ảnh</span>
                  </header>
                  <div className="clean-slots">
                    {c.photos.map((p, i) => p.url ? (
                      <a key={i} href={photoHref(p.url)} target="_blank" rel="noreferrer" title={p.item}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={photoHref(p.url)} alt={p.item} loading="lazy" />
                      </a>
                    ) : <span key={i} className="clean-slot-missing">Thiếu ảnh: {p.item.toLowerCase()}</span>)}
                    {!c.photos.length && <span className="small muted">Việc cũ, không có checklist ảnh.</span>}
                  </div>
                </article>
              );
            })}
          </div>
        ) : <div className="empty">Chưa có phòng nào chụp ảnh trong ngày.</div>}
      </section>
    </>
  );
}
