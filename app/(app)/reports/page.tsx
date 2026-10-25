import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { visibleInvestors, visibleProperties, monthParam } from "@/lib/queries";
import { MonthNav } from "@/components/MonthNav";
import { buildInvestorReport, COMMON_ROW, type ReportMonth } from "@/lib/services/investor-report";
import { DownloadPng } from "./download-png";
import s from "./report.module.css";

// ---- Định dạng theo mẫu bc-ndt: chấm ngàn, phẩy thập phân ----
const full = (n: number) => (n < 0 ? "−" : "") + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const dec1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1).replace(".", ",").replace("-", "−");
const mil = (n: number) => dec1(n / 1e6);
const dec2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2).replace(".", ",");
const pctOf = (n: number, dt: number) => (dt ? (n / dt) * 100 : 0);
const mNum = (m: string) => Number(m.slice(5));
const tLabel = (m: string) => `T${mNum(m)}`;
const slug = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").replace(/[^A-Za-z0-9]/g, "");
const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/** Màu cột lũy kế theo mức LN (triệu ₫). */
const cumulColor = (net: number) => (net < 15e6 ? "#F09595" : net < 30e6 ? "#9FE1CB" : net < 50e6 ? "#5DCAA5" : "#1D9E75");
/** Badge LN: < 10% xấu, 10–25% ổn, ≥ 25% nổi bật nếu là tháng báo cáo hoặc tháng tốt nhất. */
const lnBadge = (pct: number, highlight: boolean) => (pct < 10 ? s.bad : pct >= 25 && highlight ? s.best : s.ok);

type CpKey = "homestay" | "host" | "tax" | "bhxh" | "accounting";

export default async function InvestorReportPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!can(user, "viewFee")) return <NoAccess />;
  const db = getDb();
  const month = monthParam(sp.month);
  const [invs, allProps] = await Promise.all([visibleInvestors(db, user), visibleProperties(db, user)]);
  if (!invs.length) return <div className="empty">Không có nhà đầu tư nào trong phạm vi được xem.</div>;
  const inv = invs.find((i) => i.id === sp.inv) ?? invs[0];
  const props = allProps.filter((p) => p.investorId === inv.id);
  const prop = props.find((p) => p.id === sp.p) ?? null;
  const r = await buildInvestorReport(db, user, inv.id, month, prop?.id ?? null);

  const ms = r.months;
  const cur = ms[3], prev = ms[2];
  const [yy, mm] = [month.slice(0, 4), mNum(month)];
  const title = prop ? `Cơ sở ${prop.name}` : `Toàn bộ cơ sở — ${inv.name}`;
  const scopeShort = prop ? prop.name : `${props.length} cơ sở của ${inv.name}`;
  const fileName = `BC_NĐT_${prop ? slug(prop.name) : `ToanBo_${slug(inv.name)}`}_T${mm}_${yy}`;
  const exportDate = D.formatDateVN(D.todayVN());
  const base = `/reports?month=${month}&inv=${inv.id}`;

  // ---- Tháng báo cáo ----
  const dt = cur.revenue;
  const p = {
    homestay: pctOf(cur.homestay, dt), host: pctOf(cur.host, dt), tax: pctOf(cur.tax, dt),
    vat: pctOf(cur.vat, dt), cit: pctOf(cur.cit, dt), bhxh: pctOf(cur.bhxh, dt), accounting: pctOf(cur.accounting, dt), net: pctOf(cur.net, dt),
  };
  const maxPct = Math.max(p.homestay, p.host, p.tax, p.bhxh, p.accounting, 0.0001);
  const bar = (v: number) => `${Math.min(100, Math.max(0, (v / maxPct) * 100)).toFixed(1)}%`;
  const plBar = (v: number) => `${Math.min(100, Math.max(0, v)).toFixed(1)}%`;
  const prevPct = prev.hasData ? pctOf(prev.net, prev.revenue) : null;
  const diffPp = prevPct === null ? null : p.net - prevPct;

  // ---- Xu hướng 4 tháng ----
  const dtMax = Math.max(...ms.map((m) => m.revenue), 1);
  const withData = ms.filter((m) => m.hasData);
  const range = `${tLabel(ms[0].month)}–${tLabel(month)}/${yy}`;
  const missing = ms.filter((m) => !m.hasData).map((m) => tLabel(m.month));
  const cumul = ms.reduce((t, m) => t + m.net, 0);

  // ---- Bảng so sánh NĐT ----
  const cpRows: [string, CpKey][] = [["CP Homestay", "homestay"], ["CP Host", "host"], ["CP Thuế", "tax"], ["CP BHXH", "bhxh"], ["CP Kế toán", "accounting"]];
  const isNew = (k: CpKey) => (k === "bhxh" || k === "accounting") && cur[k] > 0 && ms.slice(0, 3).every((m) => m[k] === 0);
  const cell = (m: ReportMonth, v: number) => (m.hasData ? mil(v) : "—");
  const arrow = (k: CpKey | "revenue") => {
    if (!prev.hasData || cur[k] === prev[k]) return null;
    const up = cur[k] > prev[k];
    const good = k === "revenue" ? up : !up;
    return <span className={s.arrow} style={{ color: good ? "#1D9E75" : "#A32D2D" }}>{up ? "↑" : "↓"}</span>;
  };
  const bestNet = Math.max(...withData.map((m) => m.net));

  // ---- Chi tiết CP Homestay (3 tháng gần nhất) ----
  const [t2, t1, t0] = [ms[1], ms[2], ms[3]];
  const catNames = [...new Set([t2, t1, t0].flatMap((m) => Object.keys(m.homestayByCategory)))]
    .filter((n) => n !== COMMON_ROW)
    .sort((a, b) => (t0.homestayByCategory[b] ?? 0) - (t0.homestayByCategory[a] ?? 0));
  const hasCommon = [t2, t1, t0].some((m) => m.homestayByCategory[COMMON_ROW]);
  const cmp = (m: ReportMonth, v: number, base0: number) => {
    if (!m.hasData) return undefined;
    const x = Math.round(pctOf(v, m.revenue) * 10), y = Math.round(base0 * 10);
    return x > y ? s.redCmp : x < y ? s.greenCmp : undefined;
  };
  const costRow = (name: string) => {
    const v0 = t0.homestayByCategory[name] ?? 0;
    const p0 = pctOf(v0, t0.revenue);
    const v1 = t1.homestayByCategory[name] ?? 0, v2 = t2.homestayByCategory[name] ?? 0;
    return (
      <tr key={name}>
        <td>{name}</td>
        <td className={s.hlCol}>{full(v0)} ₫</td>
        <td className={s.hlCol}>{dec1(p0)}%</td>
        <td className={cmp(t1, v1, p0)}>{t1.hasData ? `${dec1(pctOf(v1, t1.revenue))}%` : "—"}</td>
        <td className={cmp(t2, v2, p0)}>{t2.hasData ? `${dec1(pctOf(v2, t2.revenue))}%` : "—"}</td>
      </tr>
    );
  };

  // ---- Doanh thu từng phòng ----
  const rr = r.rooms;
  const rTot = rr.rows.reduce((t, x) => ({ revenue: t.revenue + x.revenue, projected: t.projected + x.projected, kpi: t.kpi + x.kpi }), { revenue: 0, projected: 0, kpi: 0 });
  const partial = rr.elapsedDays < rr.daysInMonth;
  const kpiCells = (x: { revenue: number; projected: number; kpi: number }) => {
    const pace = x.kpi ? (x.projected / x.kpi) * 100 : null;
    return (
      <>
        <td className={cx(s.hlCol, pace !== null && (pace >= 100 ? s.greenCmp : s.redCmp))}>{pace === null ? "—" : `${Math.round(pace)}%`}</td>
        <td>{x.kpi ? `${full(x.kpi)} ₫` : "—"}</td>
        <td>{x.kpi ? `${dec2((x.revenue / x.kpi) * 100)}%` : "—"}</td>
      </>
    );
  };

  // CĐT đặc biệt: thuế tự tính GTGT + TNCN thay cho GTGT + TNDN từ khoản chi đã nhập
  const at = cur.autoTax;
  const taxNote = at ? "GTGT + TNCN" : "GTGT + TNDN";
  const summary: [string, number, string, string | undefined][] = [
    ["CP Homestay", cur.homestay, "vận hành cơ sở", undefined],
    ["CP Host", cur.host, "phí quản lý LOCI", "#378ADD"],
    ["CP Thuế", cur.tax, taxNote, "#BA7517"],
    ["CP BHXH", cur.bhxh, "bảo hiểm XH", "#7B5EA7"],
    ["CP Kế toán", cur.accounting, "dịch vụ kế toán", "#7B5EA7"],
  ];
  const spBars: [string, number, string, string][] = [
    ["CP Homestay (vận hành)", p.homestay, "#888780", "#888780"],
    [`CP Thuế (${taxNote})`, p.tax, "#BA7517", "#BA7517"],
    ["CP Host (quản lý)", p.host, "#378ADD", "#378ADD"],
    ["CP Kế toán", p.accounting, "#7B5EA7", "#7B5EA7"],
    ["CP BHXH", p.bhxh, "#7B5EA7", "#9B7EC7"],
  ];

  return (
    <>
      <div className="topbar">
        <h1>Báo cáo NĐT</h1>
        <MonthNav month={month} path="/reports" extra={`&inv=${inv.id}${prop ? `&p=${prop.id}` : ""}`} />
        {invs.length > 1 && (
          <div className="chips" style={{ width: "100%" }}>
            {invs.map((i) => <Link key={i.id} className="chip" aria-pressed={i.id === inv.id} href={`/reports?month=${month}&inv=${i.id}`}>{i.name}</Link>)}
          </div>
        )}
        <div className="chips" style={{ width: "100%" }}>
          <Link className="chip" aria-pressed={!prop} href={base}>Toàn bộ cơ sở</Link>
          {props.map((x) => <Link key={x.id} className="chip" aria-pressed={x.id === prop?.id} href={`${base}&p=${x.id}`}>{x.name}</Link>)}
        </div>
      </div>
      {r.status !== "LOCKED" && <div className="banner">Tháng này chưa khóa sổ, số liệu còn có thể thay đổi.{r.commonProvisional ? " Chi phí chung đang tạm tính theo tháng trước." : ""}</div>}

      <div className={s.dlBar}>
        <span>Báo cáo đầu tư — {scopeShort} T{mm}/{yy}</span>
        <DownloadPng targetId="bc-ndt-report" fileName={fileName} />
      </div>

      <div id="bc-ndt-report" className={s.report}>
        {/* Header */}
        <div className={s.header}>
          <div>
            <div className={s.tag}>Báo cáo cho chủ đầu tư</div>
            <h1>{title}</h1>
            <div className={s.sub}>Kết quả kinh doanh tháng {mm} năm {yy}{prop ? "" : ` · gộp ${props.length} cơ sở`}</div>
          </div>
          <div className={s.headRight}>
            <div className={s.badge}>T{mm} / {yy}</div>
            <div className={s.exportDate}>Xuất ngày {exportDate}</div>
          </div>
        </div>

        {/* 7 thẻ tóm tắt */}
        <div className={s.summary}>
          <div className={cx(s.card, s.hl)}>
            <div className={s.lbl}>★ Doanh thu</div>
            <div className={cx(s.val, s.green)}>{mil(cur.revenue)}M₫</div>
            <div className={s.unit}>tổng trước thuế</div>
          </div>
          {summary.map(([lbl, v, unit, color]) => (
            <div key={lbl} className={s.card}>
              <div className={s.lbl}>{lbl}</div>
              <div className={cx(s.val, !color && s.red)} style={color ? { color } : undefined}>{mil(v)}M₫</div>
              <div className={s.unit}>{unit}</div>
            </div>
          ))}
          <div className={cx(s.card, s.hl)}>
            <div className={s.lbl}>★ Lợi nhuận</div>
            <div className={cx(s.val, cur.net < 0 ? s.red : s.green)}>{mil(cur.net)}M₫</div>
            <div className={s.unit}>về tay NĐT ({dec1(p.net)}%)</div>
          </div>
        </div>

        {/* Spotlight lợi nhuận */}
        <div className={s.spotlight}>
          <div className={s.spLeft}>
            <div className={s.spTag}>★ Lợi nhuận về tay NĐT</div>
            <div className={cx(s.spNum, cur.net < 0 && s.negNum)}>{full(cur.net)} ₫</div>
            <div className={s.spSub}>Tháng {mm} / {yy} — {scopeShort}</div>
            <div className={s.breakdown}>
              <div><span>DT tổng</span><span>{full(cur.revenue)} ₫</span></div>
              <div className={s.neg}><span>− CP Homestay</span><span>{full(cur.homestay)} ₫</span></div>
              <div className={s.neg}><span>− CP Host</span><span>{full(cur.host)} ₫</span></div>
              <div className={s.neg}><span>− CP Thuế</span><span>{full(cur.tax)} ₫</span></div>
              <div className={s.neg}><span>− CP BHXH</span><span>{full(cur.bhxh)} ₫</span></div>
              <div className={s.neg}><span>− CP Kế toán</span><span>{full(cur.accounting)} ₫</span></div>
            </div>
            <div className={s.pills}>
              <span className={cx(s.pill, s.pillGreen)}>LN {dec1(p.net)}% / DT</span>
              {diffPp !== null && Math.round(diffPp * 10) !== 0 && (
                <span className={cx(s.pill, diffPp > 0 ? s.pillUp : s.pillDown)}>
                  {diffPp > 0 ? `▲ +${dec1(diffPp)}` : `▼ ${dec1(diffPp)}`}pp vs {tLabel(prev.month)}
                </span>
              )}
            </div>
          </div>
          <div className={s.spDivider} />
          <div className={s.spRight}>
            <div className={s.barRow}>
              <div className={s.barLabel}><span className={s.barName}>★ Lợi nhuận NĐT</span><span className={s.barPct} style={{ color: "#1D9E75" }}>{dec1(p.net)}%</span></div>
              <div className={s.barTrack}><div className={s.barFill} style={{ width: bar(p.net), background: "#1D9E75" }} /></div>
            </div>
            {spBars.map(([name, v, txt, fill]) => (
              <div key={name} className={s.barRow}>
                <div className={s.barLabel}><span className={s.barName}>{name}</span><span className={s.barPct} style={{ color: txt }}>{dec1(v)}%</span></div>
                <div className={s.barTrack}><div className={s.barFill} style={{ width: bar(v), background: fill }} /></div>
              </div>
            ))}
          </div>
        </div>

        {/* Xu hướng 4 tháng */}
        <div className={s.section}>
          <div className={s.sectionTitle}>Xu hướng doanh thu &amp; lợi nhuận {range}</div>
          <div className={s.chartWrap}>
            <div className={s.chartGrid}>
              {ms.map((m, i) => {
                const now = i === 3;
                return (
                  <div key={m.month} className={cx(s.col, now && s.current)}>
                    <div className={s.dtLabel}>{m.hasData ? `${mil(m.revenue)} M` : "—"}</div>
                    <div className={s.barWrap}>
                      <div className={s.barOuter} style={{ height: `${Math.round((m.revenue / dtMax) * 90)}px` }}>
                        <div className={s.barInner} style={{ height: `${Math.round((Math.max(0, m.net) / dtMax) * 90)}px` }} />
                      </div>
                    </div>
                    <div className={s.month}>{now ? "★ " : ""}{tLabel(m.month)}</div>
                    <div className={s.lnLabel}>{m.hasData ? `LN: ${mil(m.net)} M` : "Chưa có dữ liệu"}</div>
                  </div>
                );
              })}
            </div>
            <div className={s.legend}>
              <div className={s.legendItem}><div className={s.dot} style={{ background: "#9FE1CB" }} />Doanh thu</div>
              <div className={s.legendItem}><div className={s.dot} style={{ background: "#D85A30" }} />Lợi nhuận</div>
            </div>
          </div>
          <div className={s.note}>
            Cột xanh = doanh thu, phần cam = lợi nhuận về tay NĐT.{missing.length ? ` ${missing.join(", ")}: chưa có dữ liệu.` : ""}
          </div>
        </div>

        {/* Doanh thu từng phòng */}
        {rr.rows.length > 0 && (
          <div className={s.section}>
            <div className={s.sectionTitle}>Doanh thu từng phòng — {partial ? `tới ngày ${rr.elapsedDays}/${mm}/${yy}` : `tháng ${mm}/${yy}`}</div>
            <div className={s.tableScroll}>
              <table className={s.costTable}>
                <thead>
                  <tr>
                    <th>Phòng</th>
                    <th>Doanh thu</th>
                    <th>Dự kiến</th>
                    <th className={s.hl}>DT / KPI ngày hiện tại</th>
                    <th>KPI</th>
                    <th>%KPI tháng</th>
                  </tr>
                </thead>
                <tbody>
                  {rr.rows.map((x) => (
                    <tr key={x.roomId}>
                      <td>{x.name}</td>
                      <td>{full(x.revenue)} ₫</td>
                      <td>{full(x.projected)} ₫</td>
                      {kpiCells(x)}
                    </tr>
                  ))}
                  <tr className={s.totalRow}>
                    <td>Tổng</td>
                    <td>{full(rTot.revenue)} ₫</td>
                    <td>{full(rTot.projected)} ₫</td>
                    {kpiCells(rTot)}
                  </tr>
                </tbody>
              </table>
            </div>
            <div className={s.footnote}>
              Doanh thu = tiền đêm phòng (sau hoa hồng kênh) từ ngày 1 tới {partial ? `hết ngày ${rr.elapsedDays}` : "cuối tháng"}, chưa gồm điều chỉnh. Dự kiến = doanh thu ÷ {rr.elapsedDays} ngày × {rr.daysInMonth} ngày.<br />
              DT / KPI ngày hiện tại = dự kiến ÷ KPI tháng (≥ 100% là đang vượt tiến độ) · %KPI tháng = doanh thu đã đạt ÷ KPI tháng.
            </div>
          </div>
        )}

        {/* P&L + so sánh NĐT */}
        <div className={s.twoCol}>
          <div>
            <div className={s.sectionTitle}>Báo cáo P&amp;L — Tháng {mm}/{yy}</div>
            <div className={s.plRow}>
              <div className={s.dot} style={{ background: "#1D9E75" }} />
              <span className={cx(s.plName, s.strong)}>Doanh thu tổng</span>
              <div className={s.plBarWrap}><div className={s.plTrack}><div className={s.plFill} style={{ width: "100%", background: "#1D9E75" }} /></div><span className={cx(s.plAmt, s.green)}>{full(cur.revenue)} ₫</span></div>
            </div>
            <div className={s.plGroup}>Chi phí Homestay</div>
            <PlRow name="Vận hành & chung" color="#888780" pct={plBar(p.homestay)} amount={cur.homestay} />
            <div className={s.plGroup}>Chi phí Host</div>
            <PlRow name="Phí quản lý LOCI" color="#378ADD" pct={plBar(p.host)} amount={cur.host} />
            <div className={s.plGroup}>Chi phí Thuế</div>
            <PlRow name={`GTGT ${at ? at.vatPct : 8}%`} color="#BA7517" pct={plBar(p.vat)} amount={cur.vat} minor tight />
            <PlRow name={at ? `TNCN ${at.pitPct}%` : "TNDN"} color="#BA7517" pct={plBar(p.cit)} amount={cur.cit} minor />
            <div className={s.plGroup}>BHXH &amp; Kế toán</div>
            <PlRow name="Bảo hiểm XH" color="#7B5EA7" pct={plBar(p.bhxh)} amount={cur.bhxh} minor tight />
            <PlRow name="Kế toán" color="#7B5EA7" pct={plBar(p.accounting)} amount={cur.accounting} minor />
            <div className={cx(s.plRow, s.ln)}>
              <div className={s.dot} style={{ background: "#1D9E75" }} />
              <span className={cx(s.plName, s.strong)}>★ Lợi nhuận NĐT</span>
              <div className={s.plBarWrap}><div className={s.plTrack}><div className={s.plFill} style={{ width: bar(p.net), background: "#1D9E75" }} /></div><span className={cx(s.plAmt, cur.net < 0 ? s.red : s.green)}>{full(cur.net)} ₫</span></div>
            </div>
            <div className={s.plNote}>Tỷ suất LN: {dec1(p.net)}% / DT</div>
          </div>

          <div>
            <div className={s.sectionTitle}>Chỉ số NĐT — So sánh 4 tháng</div>
            <table className={s.invTable}>
              <colgroup><col style={{ width: "34%" }} /><col /><col /><col /><col /></colgroup>
              <thead>
                <tr>
                  <th>Chỉ số</th>
                  {ms.slice(0, 3).map((m) => <th key={m.month}>{tLabel(m.month)}</th>)}
                  <th className={s.hl}>{tLabel(month)} ★</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>DT (M₫)</td>
                  {ms.slice(0, 3).map((m) => <td key={m.month}>{cell(m, m.revenue)}</td>)}
                  <td className={s.hlCol}>{mil(cur.revenue)}{arrow("revenue")}</td>
                </tr>
                {cpRows.map(([name, k]) => (
                  <tr key={k} className={s.cpRow}>
                    <td>{name}</td>
                    {ms.slice(0, 3).map((m) => <td key={m.month}>{isNew(k) ? "—" : cell(m, m[k])}</td>)}
                    <td className={s.hlCol}>{mil(cur[k])}{isNew(k) ? <span className={s.invNew}>mới</span> : arrow(k)}</td>
                  </tr>
                ))}
                <tr className={s.lnRow}>
                  <td><b>★ Lợi nhuận</b></td>
                  {ms.map((m, i) => (
                    <td key={m.month} className={i === 3 ? s.hlCol : undefined}>
                      {m.hasData ? <span className={cx(s.invBadge, lnBadge(pctOf(m.net, m.revenue), i === 3 || m.net === bestNet))}>{mil(m.net)}</span> : "—"}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td>Tỷ suất LN</td>
                  {ms.map((m, i) => <td key={m.month} className={i === 3 ? s.hlCol : undefined}>{m.hasData ? `${dec1(pctOf(m.net, m.revenue))}%` : "—"}</td>)}
                </tr>
              </tbody>
            </table>
            <div className={s.cumul}>
              <div className={s.cumulHead}><span className={s.cumulTitle}>Lũy kế LN — {range}</span><span className={s.cumulTotal}>{mil(cumul)} M₫</span></div>
              <div className={s.cumulBar}>
                {ms.map((m) => <div key={m.month} style={{ flex: Math.max(0, m.net), background: cumulColor(m.net) }} />)}
              </div>
              <div className={s.cumulLabels}>
                {ms.map((m, i) => <span key={m.month} className={cx(s.cumulLabel, i === 3 && s.cur)}>{tLabel(m.month)}: {m.hasData ? `${mil(m.net)}M` : "—"}</span>)}
              </div>
            </div>
          </div>
        </div>

        {/* Chi tiết CP Homestay */}
        <div className={s.section}>
          <div className={s.sectionTitle}>Chi tiết CP Homestay — So sánh {tLabel(t2.month)} / {tLabel(t1.month)} / {tLabel(t0.month)}</div>
          <div className={s.tableScroll}>
            <table className={s.costTable}>
              <thead>
                <tr>
                  <th>Khoản mục</th>
                  <th className={s.hl}>{tLabel(t0.month)} — Số tiền</th>
                  <th className={s.hl}>{tLabel(t0.month)} / DT</th>
                  <th>{tLabel(t1.month)} / DT</th>
                  <th>{tLabel(t2.month)} / DT</th>
                </tr>
              </thead>
              <tbody>
                {catNames.length > 0 && <tr className={s.groupHd}><td colSpan={5}>Chi phí của cơ sở</td></tr>}
                {catNames.map(costRow)}
                {hasCommon && <tr className={s.groupHd}><td colSpan={5}>Chi phí chung</td></tr>}
                {hasCommon && costRow(COMMON_ROW)}
                <tr className={s.totalRow}>
                  <td>Tổng CP Homestay</td>
                  <td className={s.hlCol}>{full(cur.homestay)} ₫</td>
                  <td className={s.hlCol}>{dec1(p.homestay)}%</td>
                  <td className={cmp(t1, t1.homestay, p.homestay)}>{t1.hasData ? `${dec1(pctOf(t1.homestay, t1.revenue))}%` : "—"}</td>
                  <td className={cmp(t2, t2.homestay, p.homestay)}>{t2.hasData ? `${dec1(pctOf(t2.homestay, t2.revenue))}%` : "—"}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className={s.footnote}>
            DT tham chiếu: {tLabel(t0.month)} = {full(t0.revenue)} ₫ · {tLabel(t1.month)} = {full(t1.revenue)} ₫ · {tLabel(t2.month)} = {full(t2.revenue)} ₫<br />
            <span style={{ color: "#A32D2D" }}>■ Đỏ</span> = tỷ lệ cao hơn tháng báo cáo (bất lợi) · <span style={{ color: "#0F6E56" }}>■ Xanh</span> = tỷ lệ thấp hơn (tốt hơn)<br />
            CP Host = phí quản lý LOCI {prop ? "tính trên lãi của riêng cơ sở này" : "tính trên tổng lãi các cơ sở"}. {at
              ? `CP Thuế tự tính theo hồ sơ NĐT: GTGT = DT × ${at.vatPct}/${100 + at.vatPct}, TNCN ${at.pitPct}% × lợi nhuận sau phí quản lý. BHXH, Kế toán lấy từ các khoản chi đã nhập đúng loại.`
              : "CP Thuế, BHXH, Kế toán lấy từ các khoản chi đã nhập đúng loại; GTGT = DT × 8/108, phần thuế còn lại tính là TNDN."}
          </div>
        </div>

        <div className={s.footer}>
          Báo cáo đầu tư — {title} — Tháng {mm}/{yy} · DT: {full(cur.revenue)} ₫ · CP Homestay: {full(cur.homestay)} ₫ · CP Host: {full(cur.host)} ₫ · CP Thuế: {full(cur.tax)} ₫ · CP BHXH: {full(cur.bhxh)} ₫ · CP KT: {full(cur.accounting)} ₫ ·
          Lợi nhuận: {full(cur.net)} ₫ ({dec1(p.net)}%) · Lũy kế {range}: {full(cumul)} ₫ · Xuất {exportDate}
        </div>
      </div>
    </>
  );
}

function PlRow({ name, color, pct, amount, minor, tight }: { name: string; color: string; pct: string; amount: number; minor?: boolean; tight?: boolean }) {
  return (
    <div className={cx(s.plRow, s.cp, tight && s.tight)}>
      <div className={s.dot} style={{ background: color, opacity: minor ? 0.7 : 1 }} />
      <span className={cx(s.plName, minor && s.minor)}>{name}</span>
      <div className={s.plBarWrap}>
        <div className={s.plTrack}><div className={s.plFill} style={{ width: pct, background: color }} /></div>
        <span className={cx(s.plAmt, s.red, minor && s.minor)}>{amount > 0 ? "−" : ""}{full(amount)} ₫</span>
      </div>
    </div>
  );
}
