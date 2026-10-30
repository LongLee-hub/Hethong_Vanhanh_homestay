import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { monthParam } from "@/lib/queries";
import { MonthNav } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { CRITERIA, CRITERION_LABEL, monthlyReviewSummary, type ReviewItem } from "@/lib/services/reviews";
import { LOW_REVIEW_SCORE } from "@/lib/dayladau/reviews";
import { syncReviewsAction } from "./actions";
import css from "./reviews.module.css";

/** Điểm kiểu Việt Nam: 4,86. */
const sc = (n: number | null) => (n === null ? "–" : n.toFixed(2).replace(".", ","));
/** Tiêu chí dưới mức này tô đỏ: khách Airbnb coi dưới 4,7 là có vấn đề. */
const WEAK = 4.7;

function Delta({ now, before }: { now: number | null; before: number | null }) {
  if (now === null || before === null) return null;
  const d = Math.round((now - before) * 100) / 100;
  if (d === 0) return <span className="muted">bằng tháng trước</span>;
  return <span className={d > 0 ? "pos" : "neg"}>{d > 0 ? "+" : "−"}{sc(Math.abs(d))} so với tháng trước</span>;
}

function ReviewCard({ r }: { r: ReviewItem }) {
  return (
    <article className={`${css.review} ${r.low ? css.low : ""}`}>
      <header className={css.reviewHead}>
        <span className={css.score} aria-label={`${r.overall ?? "chưa chấm"} sao`}>{r.overall === null ? "–" : `${sc(r.overall)}★`}</span>
        <div className={css.who}>
          <b>{r.guestName ?? "Khách không rõ tên"}</b>
          <span className="small muted">{r.propertyName}{r.roomName ? `, phòng ${r.roomName}` : r.listingName ? `, ${r.listingName}` : ""}. Trả phòng {D.formatDateVN(r.reviewDate)}</span>
        </div>
      </header>
      {r.content ? <p className={css.text}>{r.content}</p> : <p className={`${css.text} muted`}>Khách chỉ chấm điểm, không viết nhận xét.</p>}
      <div className={css.sub}>
        {CRITERIA.slice(1).map((c) => {
          const v = r.scores[c as keyof typeof r.scores];
          return v === null ? null : <span key={c} className={v < LOW_REVIEW_SCORE ? "neg" : undefined}>{CRITERION_LABEL[c]} {sc(v)}</span>;
        })}
      </div>
    </article>
  );
}

export default async function Reviews({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const db = getDb();
  const month = monthParam(sp.month);
  const s = await monthlyReviewSummary(db, user, month);
  const isAdmin = can(user, "admin");
  const monthLow = D.formatMonthVN(month).toLowerCase();
  const low = s.items.filter((r) => r.low);
  const showProp = sp.p && s.byProperty.some((p) => p.propertyId === sp.p) ? sp.p : null;
  const listed = showProp ? s.items.filter((r) => r.propertyId === showProp) : s.items;

  return (
    <>
      <div className="topbar">
        <h1>Đánh giá khách</h1>
        <MonthNav month={month} path="/reviews" />
        <p className="sub">
          Đánh giá lấy từ Dayladau mỗi sáng lúc 6:00 và tính vào tháng khách trả phòng.{" "}
          {s.inProgress ? `Số liệu ${monthLow} tính đến hết ngày ${D.formatDateVN(s.asOf)}, còn cập nhật đến cuối tháng.` : `Đã hết ${monthLow}, đánh giá viết muộn vẫn được cộng thêm khi về.`}
        </p>
        {isAdmin && (
          <ActionForm action={syncReviewsAction} submit="Lấy đánh giá mới" submitClass="btn sm" className={css.syncForm} />
        )}
      </div>

      {s.total.count === 0 ? (
        <div className="panel empty">
          <p>Chưa có đánh giá nào cho {monthLow}.</p>
          {isAdmin && <p className="small muted">Nếu cơ sở đã có đánh giá trên Dayladau, bấm Lấy đánh giá mới. Đánh giá của listing chưa gắn phòng sẽ bị bỏ qua, gắn listing ở trang <Link href="/dayladau">Kết nối Dayladau</Link>.</p>}
        </div>
      ) : (
        <>
          <section className="hero">
            <div>
              <div className="row">
                <span className="cap">Điểm trung bình {monthLow}</span>
                {s.inProgress ? <span className="pill fc">Đang chạy</span> : <span className="pill ok">Đã hết tháng</span>}
              </div>
              <div className={`big ${css.bigScore}`}>{sc(s.total.avg.overall)}<span className={css.of}>/5</span></div>
              <p className="note">
                {s.total.count} đánh giá, {s.total.fiveStar} đánh giá 5★
                {s.total.low ? <>, <b className="neg">{s.total.low} đánh giá dưới {LOW_REVIEW_SCORE}★</b></> : null}.{" "}
                <Delta now={s.total.avg.overall} before={s.prevTotal.avg.overall} />
              </p>
            </div>
            <div className={css.bars} role="list" aria-label="Điểm từng tiêu chí">
              {CRITERIA.slice(1).map((c) => {
                const v = s.total.avg[c];
                return (
                  <div key={c} role="listitem" className={css.bar}>
                    <div className="kv"><span>{CRITERION_LABEL[c]}</span><b className={v !== null && v < WEAK ? "neg" : undefined}>{sc(v)}</b></div>
                    <div className="progress"><i style={{ width: `${v ? (v / 5) * 100 : 0}%`, background: v !== null && v < WEAK ? "var(--neg)" : undefined }} /></div>
                  </div>
                );
              })}
            </div>
          </section>

          {low.length > 0 && (
            <section className="panel" style={{ marginBottom: 24 }}>
              <header><div><h2>Cần xử lý</h2><p>Đánh giá dưới {LOW_REVIEW_SCORE}★ trong {monthLow}. Admin nhận tin Lark ngay khi đánh giá thấp về.</p></div></header>
              <div className={css.list}>{low.map((r) => <ReviewCard key={r.id} r={r} />)}</div>
            </section>
          )}

          <section className="panel" style={{ marginBottom: 24 }}>
            <header><div><h2>Theo cơ sở</h2><p>Điểm trung bình từng tiêu chí. Ô đỏ là tiêu chí dưới {sc(WEAK)}.</p></div></header>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cơ sở</th><th className="n">Số đánh giá</th>
                    {CRITERIA.map((c) => <th key={c} className="n">{CRITERION_LABEL[c]}</th>)}
                    <th className="n">Dưới {LOW_REVIEW_SCORE}★</th>
                  </tr>
                </thead>
                <tbody>
                  {s.byProperty.map((p) => (
                    <tr key={p.propertyId}>
                      <td>
                        <Link href={`/reviews?month=${month}&p=${p.propertyId}#danh-sach`}>{p.name}</Link>
                        {p.prevOverall !== null && <div className="small"><Delta now={p.stats.avg.overall} before={p.prevOverall} /></div>}
                      </td>
                      <td className="n">{p.stats.count}</td>
                      {CRITERIA.map((c) => {
                        const v = p.stats.avg[c];
                        return <td key={c} className={`n ${v !== null && v < WEAK ? "neg" : ""}`}>{c === "overall" ? <b>{sc(v)}</b> : sc(v)}</td>;
                      })}
                      <td className={`n ${p.stats.low ? "neg" : ""}`}>{p.stats.low || "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" id="danh-sach">
            <header>
              <div><h2>Tất cả đánh giá</h2><p>Mới nhất trước.</p></div>
              {s.byProperty.length > 1 && (
                <div className="chips">
                  <Link className="chip" aria-pressed={!showProp} href={`/reviews?month=${month}#danh-sach`}>Tất cả</Link>
                  {s.byProperty.filter((p) => p.stats.count).map((p) => (
                    <Link key={p.propertyId} className="chip" aria-pressed={showProp === p.propertyId} href={`/reviews?month=${month}&p=${p.propertyId}#danh-sach`}>{p.name}</Link>
                  ))}
                </div>
              )}
            </header>
            <div className={css.list}>{listed.map((r) => <ReviewCard key={r.id} r={r} />)}</div>
          </section>
        </>
      )}
    </>
  );
}
