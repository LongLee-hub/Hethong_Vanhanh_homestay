"use client";
// Bảng nhập chỉ tiêu tháng theo cơ sở. Dòng NĐT tự cộng từ các cơ sở; ô lệch giữa 3 chỉ tiêu được tô vàng để nhắc.
import { useActionState, useMemo, useState } from "react";
import { aggregateTargets, formatVND, targetConsistency, type KpiTarget } from "@/lib/domain";

type State = { ok: boolean; error?: string; info?: string } | null;
type Row = { rev: string; occ: string; adr: string };
export interface TargetsProp { id: string; name: string; avail: number; locked: boolean }
export interface TargetsInvestor { id: string; name: string; props: TargetsProp[] }

const fmt = (n: number) => (n ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") : "");
const toRow = (t?: KpiTarget): Row => ({ rev: fmt(t?.revenue ?? 0), occ: t?.occupancyPct ? String(t.occupancyPct).replace(".", ",") : "", adr: fmt(t?.adr ?? 0) });
const num = (v: string) => Number(v.replace(/[^\d]/g, "")) || 0;
const pctNum = (v: string) => Number(v.replace(",", ".")) || 0;
const toTarget = (r: Row): KpiTarget | null => {
  const t = { revenue: num(r.rev), occupancyPct: pctNum(r.occ), adr: num(r.adr) };
  return t.revenue || t.occupancyPct || t.adr ? t : null;
};

export function TargetsForm({ month, investors, current, previous, action }: {
  month: string;
  investors: TargetsInvestor[];
  current: Record<string, KpiTarget>;
  previous: Record<string, KpiTarget>;
  action: (s: State, f: FormData) => Promise<State>;
}) {
  const all = investors.flatMap((i) => i.props);
  const [rows, setRows] = useState<Record<string, Row>>(() => Object.fromEntries(all.map((p) => [p.id, toRow(current[p.id])])));
  const [state, run, pending] = useActionState(action, null);
  const set = (id: string, k: keyof Row, v: string) => setRows((r) => ({ ...r, [id]: { ...r[id], [k]: k === "occ" ? v.replace(/[^\d,.]/g, "") : fmt(num(v)) } }));
  const hasPrev = all.some((p) => previous[p.id]);
  const copyPrev = () => setRows((r) => Object.fromEntries(all.map((p) => [p.id, p.locked || !previous[p.id] ? r[p.id] : toRow(previous[p.id])])));

  const totals = useMemo(
    () => Object.fromEntries(investors.map((i) => [i.id, aggregateTargets(i.props.map((p) => ({ target: toTarget(rows[p.id]), monthAvailableNights: p.avail })))])),
    [investors, rows],
  );

  return (
    <form action={run} className="panel targets">
      <input type="hidden" name="month" value={month} />
      <input type="hidden" name="ids" value={all.filter((p) => !p.locked).map((p) => p.id).join(",")} />
      <header>
        <div><h2>Chỉ tiêu theo cơ sở</h2><p>Dòng nhà đầu tư tự cộng từ các cơ sở. Giá trung bình tính gộp cả doanh thu thuê giờ.</p></div>
        {hasPrev && <button type="button" className="btn sm" onClick={copyPrev}>Chép từ tháng trước</button>}
      </header>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>Cơ sở</th><th className="n">Doanh thu (đ)</th><th className="n">Công suất (%)</th><th className="n">Giá TB / đêm (đ)</th></tr>
          </thead>
          <tbody>
            {investors.map((inv) => {
              const t = totals[inv.id];
              return [
                <tr key={inv.id} className="inv-total">
                  <td><b>{inv.name}</b> <span className="small muted">tự tính</span></td>
                  <td className="n">{t ? formatVND(t.revenue) : "—"}</td>
                  <td className="n">{t ? `${String(t.occupancyPct).replace(".", ",")}%` : "—"}</td>
                  <td className="n">{t ? formatVND(t.adr) : "—"}</td>
                </tr>,
                ...inv.props.map((p) => {
                  const tg = toTarget(rows[p.id]);
                  const chk = tg ? targetConsistency(tg, p.avail) : null;
                  const hintId = `hint-${p.id}`;
                  return (
                    <tr key={p.id} className={chk?.off ? "off" : ""}>
                      <td className="prop-name">
                        {p.name}
                        <span className="small muted"> ({p.avail} đêm mở bán)</span>
                        {p.locked && <span className="pill">Đã khóa sổ</span>}
                        {chk?.off && <span id={hintId} className="hint">3 chỉ tiêu chưa khớp: công suất × đêm mở bán × giá TB ra khoảng {formatVND(chk.implied)}</span>}
                      </td>
                      <td className="n"><input inputMode="numeric" aria-label={`Doanh thu mục tiêu ${p.name}`} aria-describedby={chk?.off ? hintId : undefined} name={`rev:${p.id}`} value={rows[p.id].rev} disabled={p.locked} onChange={(e) => set(p.id, "rev", e.target.value)} /></td>
                      <td className="n"><input inputMode="decimal" aria-label={`Công suất mục tiêu ${p.name}`} name={`occ:${p.id}`} value={rows[p.id].occ} disabled={p.locked} onChange={(e) => set(p.id, "occ", e.target.value)} /></td>
                      <td className="n"><input inputMode="numeric" aria-label={`Giá trung bình mục tiêu ${p.name}`} name={`adr:${p.id}`} value={rows[p.id].adr} disabled={p.locked} onChange={(e) => set(p.id, "adr", e.target.value)} /></td>
                    </tr>
                  );
                }),
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={pending}>{pending ? "Đang lưu…" : "Lưu chỉ tiêu"}</button>
        {state?.error && <span className="err">{state.error}</span>}
        {state?.ok && <span className="small pos">{state.info}</span>}
        <span className="spacer" />
        <span className="small muted">Để trống cả 3 ô thì cơ sở đó không có chỉ tiêu.</span>
      </div>
    </form>
  );
}
