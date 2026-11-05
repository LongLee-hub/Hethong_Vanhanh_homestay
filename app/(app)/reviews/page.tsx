import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { monthParam } from "@/lib/queries";
import { MonthNav } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { CRITERIA, CRITERION_LABEL, monthlyReviewSummary, type ReviewItem, type ReviewStats } from "@/lib/services/reviews";
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

/** 1,2 tr: doanh thu gọn cho bảng nhiều cột. */
const money = (n: number) => (n ? D.formatVND(n) : "–");
const pctTxt = (n: number | null) => (n === null ? "–" : `${n.toFixed(1).replace(".", ",")}%`);
const dateTxt = (d: string | null) => (d ? D.formatDateVN(d).slice(0, 5) : "–");

/** Các ô đánh giá chung cho dòng phòng và dòng tổng của bảng Theo phòng. */
function RoomScoreCells({ st }: { st: ReviewStats }) {
  const o = st.avg.overall;
  const cl = st.avg.cleanliness;
  return (
    <>
      <td className="n">{st.count || "–"}</td>
      <td className="n">{st.fiveStar || "–"}</td>
      <td className="n">{st.fourStar || "–"}</td>
      <td className={`n ${st.low ? "neg" : ""}`}>{st.low || "–"}</td>
      <td className={`n ${o !== null && o < WEAK ? "neg" : ""}`}><b>{sc(o)}</b></td>
      <td className={`n ${cl !== null && cl < WEAK ? "neg" : ""}`}>{sc(cl)}</td>
    </>
  );
}

function KpiCell({ pct }: { pct: number | null }) {
  return <td className={`n ${pct === null ? "muted" : pct >= 100 ? "pos" : ""}`}>{pctTxt(pct)}</td>;
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
      {r.low && <Link className={`small ${css.taskLink}`} href="/tasks">Xem việc xử lý</Link>}
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

/** Buồng phòng: đánh giá của cơ sở được giao, không có doanh thu. Thưởng 5★ và phạt dưới 4★ tính vào lương tháng. */
function StaffReviews({ s, month, p }: { s: Awaited<ReturnType<typeof monthlyReviewSummary>>; month: string; p?: string }) {
  const monthLow = D.formatMonthVN(month).toLowerCase();
  const showProp = p && s.byProperty.some((x) => x.propertyId === p) ? p : null;
  const listed = showProp ? s.items.filter((r) => r.propertyId === showProp) : s.items;
  return (
    <>
      <div className="topbar">
        <h1>Đánh giá khách</h1>
        <MonthNav month={month} path="/reviews" />
        <p className="sub">Đánh giá các cơ sở bạn được giao, tính vào tháng khách trả phòng. Mỗi đánh giá 5★ được thưởng, mỗi đánh giá dưới {LOW_REVIEW_SCORE}★ bị trừ vào lương tháng.</p>
      </div>
      <div className="cards">
        <div className="stat"><span className="lbl">Điểm trung bình</span><span className="v">{sc(s.total.avg.overall)}</span><span className="s">Sạch sẽ {sc(s.total.avg.cleanliness)}</span></div>
        <div className="stat"><span className="lbl">Đánh giá 5★</span><span className="v pos">{s.total.fiveStar}</span><span className="s">trên {s.total.count} đánh giá</span></div>
        <div className="stat"><span className="lbl">Dưới {LOW_REVIEW_SCORE}★</span><span className={`v ${s.total.low ? "neg" : ""}`}>{s.total.low}</span><span className="s">{s.total.low ? "Đọc nhận xét để rút kinh nghiệm" : "Chưa có đánh giá thấp"}</span></div>
      </div>
      <section className="panel">
        <header>
          <div><h2>Nhận xét của khách</h2><p>Mới nhất trước.</p></div>
          {s.byProperty.length > 1 && (
            <div className="chips">
              <Link className="chip" aria-pressed={!showProp} href={`/reviews?month=${month}`}>Tất cả</Link>
              {s.byProperty.map((x) => <Link key={x.propertyId} className="chip" aria-pressed={showProp === x.propertyId} href={`/reviews?month=${month}&p=${x.propertyId}`}>{x.name} ({x.stats.count})</Link>)}
            </div>
          )}
        </header>
        {listed.length ? <div className={css.list}>{listed.map((r) => <ReviewCard key={r.id} r={r} />)}</div> : <p className="muted">Chưa có đánh giá nào trong {monthLow}.</p>}
      </section>
    </>
  );
}

export default async function Reviews({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!can(user, "viewReviews")) return <NoAccess />;
  const db = getDb();
  const month = monthParam(sp.month);
  const s = await monthlyReviewSummary(db, user, month);
  if (!can(user, "viewFinance")) return <StaffReviews s={s} month={month} p={sp.p} />;
  const isAdmin = can(user, "admin");
  const monthLow = D.formatMonthVN(month).toLowerCase();
  const low = s.items.filter((r) => r.low);
  const showProp = sp.p && s.byProperty.some((p) => p.propertyId === sp.p) ? sp.p : null;
  const listed = showProp ? s.items.filter((r) => r.propertyId === showProp) : s.items;
  const roomProps = (showProp ? s.byProperty.filter((p) => p.propertyId === showProp) : s.byProperty).filter((p) => p.rooms.length);

  return (
    <>
      <div className="topbar">
        <h1>Đánh giá khách</h1>
        <MonthNav month={month} path="/reviews" />
        <p className="sub">
          Đánh giá lấy từ Dayladau mỗi sáng lúc 6:00 và tính vào tháng khách trả phòng.{" "}
          {s.inProgress ? `Số liệu ${monthLow} tính đến hết ngày ${D.formatDateVN(s.asOf)}, còn cập nhật đến cuối tháng.` : `Đã hết ${monthLow}, đánh giá viết muộn vẫn được cộng thêm khi về.`}
        </p>
        <div className={css.actions}>
          {s.total.count > 0 && <a className="btn sm" href={`/reviews/export?month=${month}`} download>Xuất Excel</a>}
          {isAdmin && <ActionForm action={syncReviewsAction} submit="Lấy đánh giá mới" submitClass="btn sm" className={css.syncForm} />}
        </div>
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
              <header><div><h2>Cần xử lý</h2><p>Đánh giá dưới {LOW_REVIEW_SCORE}★ trong {monthLow}. Mỗi đánh giá thấp mới tự tạo việc "Xử lý đánh giá" cho quản lý cơ sở, hạn 2 ngày, và báo Lark.</p></div></header>
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
                        <Link href={`/reviews?month=${month}&p=${p.propertyId}#theo-phong`}>{p.name}</Link>
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

          <section className="panel" style={{ marginBottom: 24 }} id="theo-phong">
            <header>
              <div>
                <h2>Theo phòng</h2>
                <p>
                  Số đánh giá theo mức sao cạnh doanh thu và KPI doanh thu tháng của từng phòng. Doanh thu đã trừ hoa hồng OTA
                  {s.inProgress ? `, tính đến hết ngày ${D.formatDateVN(s.asOf)}` : ""}. Phòng chưa đặt KPI để trống cột % KPI.
                </p>
              </div>
            </header>
            <div className="tbl-wrap">
              <table className={css.roomTbl}>
                <thead>
                  <tr>
                    <th>Phòng</th>
                    <th className="n">Đánh giá</th><th className="n">5★</th><th className="n">4★</th><th className="n">Dưới {LOW_REVIEW_SCORE}★</th>
                    <th className="n">Điểm TB</th><th className="n">Sạch sẽ</th>
                    <th className="n">Doanh thu</th><th className="n">KPI doanh thu</th><th className="n">% KPI</th><th className="n">Số đơn</th>
                  </tr>
                </thead>
                {roomProps.map((p) => (
                  <tbody key={p.propertyId}>
                    {roomProps.length > 1 && <tr className={css.group}><td colSpan={11}>{p.name}</td></tr>}
                    {p.rooms.map((r) => (
                      <tr key={r.roomId ?? "none"}>
                        <td>{r.roomId ? r.roomName : <span className="muted">{r.roomName}</span>}</td>
                        <RoomScoreCells st={r.stats} />
                        <td className="n">{money(r.revenue)}</td>
                        <td className="n muted">{r.revenueKpi ? D.formatVND(r.revenueKpi) : "–"}</td>
                        <KpiCell pct={r.kpiPct} />
                        <td className="n">{r.bookings || "–"}</td>
                      </tr>
                    ))}
                    <tr className="total">
                      <td>Tổng {roomProps.length > 1 ? p.name : ""}</td>
                      <RoomScoreCells st={p.stats} />
                      <td className="n">{money(p.revenue)}</td>
                      <td className="n">{p.revenueKpi ? D.formatVND(p.revenueKpi) : "–"}</td>
                      <KpiCell pct={p.kpiPct} />
                      <td className="n">{p.bookings || "–"}</td>
                    </tr>
                  </tbody>
                ))}
              </table>
            </div>
          </section>

          <section className="panel" id="danh-sach">
            <header>
              <div><h2>Chi tiết đánh giá</h2><p>Mới nhất trước. Dòng nền đỏ là đánh giá dưới {LOW_REVIEW_SCORE}★, ô đỏ là tiêu chí dưới {LOW_REVIEW_SCORE}.</p></div>
              {s.byProperty.length > 1 && (
                <div className="chips">
                  <Link className="chip" aria-pressed={!showProp} href={`/reviews?month=${month}#theo-phong`}>Tất cả</Link>
                  {s.byProperty.filter((p) => p.stats.count || p.revenue).map((p) => (
                    <Link key={p.propertyId} className="chip" aria-pressed={showProp === p.propertyId} href={`/reviews?month=${month}&p=${p.propertyId}#theo-phong`}>{p.name}</Link>
                  ))}
                </div>
              )}
            </header>
            {listed.length === 0 ? (
              <p className="muted">Cơ sở này chưa có đánh giá trong {monthLow}.</p>
            ) : (
              <div className="tbl-wrap">
                <table className={css.detailTbl}>
                  <thead>
                    <tr>
                      <th>Phòng</th><th>Ngày đến</th><th>Ngày đi</th><th>Khách</th>
                      {CRITERIA.map((c) => <th key={c} className="n">{CRITERION_LABEL[c]}</th>)}
                      <th>Nhận xét</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.map((r) => (
                      <tr key={r.id} className={r.low ? css.lowRow : undefined}>
                        <td className={css.nowrap}>
                          {r.roomName ?? <span className="muted">{r.listingName ?? "Chưa gắn phòng"}</span>}
                          {!showProp && s.byProperty.length > 1 && <div className="small muted">{r.propertyName}</div>}
                        </td>
                        <td className={css.nowrap}>{dateTxt(r.checkIn)}</td>
                        <td className={css.nowrap}>{dateTxt(r.checkOut ?? r.reviewDate)}</td>
                        <td>{r.guestName ?? <span className="muted">Không rõ</span>}</td>
                        {CRITERIA.map((c) => {
                          const v = c === "overall" ? r.overall : r.scores[c];
                          return <td key={c} className={`n ${v !== null && v < LOW_REVIEW_SCORE ? "neg" : ""}`}>{c === "overall" ? <b>{sc(v)}</b> : sc(v)}</td>;
                        })}
                        <td className={css.comment}>{r.content ?? <span className="muted">Không viết nhận xét</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
