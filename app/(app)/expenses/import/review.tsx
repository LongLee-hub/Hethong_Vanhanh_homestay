"use client";
// Tải file chi phí → bảng xem trước (lỗi, cảnh báo trùng, loại mới) → kê khai các dòng đã chọn.
import Link from "next/link";
import { useState, useTransition } from "react";
import type { PreviewRow } from "@/lib/services/expense-import";
import { MonthList } from "@/components/MonthsField";
import { commitImportAction, previewImportAction } from "../actions";

const vnd = (n: number) => n.toLocaleString("vi-VN") + " ₫";
const dmy = (d: string) => (d ? d.split("-").reverse().join("/") : "—");
const mLabel = (m: string) => (m ? `T${Number(m.slice(5))}/${m.slice(0, 4)}` : "—");

export function ImportReview() {
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  // Tháng hạch toán từng dòng; thêm tháng thì số tiền chia đều
  const [months, setMonths] = useState<Record<number, string[]>>({});
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({});
  const [done, setDone] = useState<{ count: number; months: string[] } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const valid = (r: PreviewRow) => !r.errors.length && r.propertyId !== undefined;
  const list = rows ?? [];
  const selected = list.filter((r) => valid(r) && checked[r.line]);
  const selectable = list.filter(valid);
  const bad = list.filter((r) => !valid(r));
  const dups = list.filter((r) => valid(r) && r.warnings.some((w) => w.startsWith("Đã có") || w.startsWith("Giống hệt")));
  const newCats = [...new Set(selected.filter((r) => r.newCategory).map((r) => r.categoryName))];

  function read(f: FormData) {
    setMsg(null);
    setDone(null);
    setLineErrors({});
    start(async () => {
      const r = await previewImportAction(f);
      if (!r.ok || !r.rows) {
        setRows(null);
        return setMsg({ ok: false, text: r.error ?? "Không đọc được file" });
      }
      setRows(r.rows);
      setFileName(r.fileName ?? "");
      setMonths(Object.fromEntries(r.rows.map((x) => [x.line, [x.month]])));
      // Mặc định chọn dòng hợp lệ; dòng có thể trùng để người dùng tự quyết
      setChecked(Object.fromEntries(r.rows.map((x) => [x.line, !x.errors.length && x.propertyId !== undefined && !x.duplicateOf && !x.warnings.some((w) => w.startsWith("Giống hệt"))])));
    });
  }

  function commit() {
    if (!selected.length) return setMsg({ ok: false, text: "Chọn ít nhất một dòng" });
    const badMonths = selected.filter((r) => { const m = months[r.line] ?? []; return !m.length || m.some((x) => !x) || new Set(m).size !== m.length || r.amount < m.length; });
    if (badMonths.length) {
      setLineErrors(Object.fromEntries(badMonths.map((r) => [r.line, "Tháng hạch toán trống hoặc bị trùng"])));
      return setMsg({ ok: false, text: `${badMonths.length} dòng có tháng hạch toán chưa hợp lệ` });
    }
    const items = selected.map((r) => ({
      line: r.line, propertyId: r.propertyId ?? null, categoryId: r.categoryId, categoryName: r.categoryName,
      months: months[r.line] ?? [r.month], incurredOn: r.incurredOn, amount: r.amount, description: r.description,
    }));
    start(async () => {
      const res = await commitImportAction(items);
      if (!res.ok) return setMsg({ ok: false, text: res.error ?? "Lỗi" });
      const errs = Object.fromEntries((res.errors ?? []).map((e) => [e.line, e.message]));
      const ok = items.filter((i) => !errs[i.line]);
      setLineErrors(errs);
      setRows((rs) => (rs ?? []).filter((r) => !ok.some((i) => i.line === r.line)));
      setDone({ count: ok.length, months: [...new Set(ok.flatMap((i) => i.months))].sort() });
      setMsg({ ok: !res.errors?.length, text: res.info + (res.errors?.length ? ` · ${res.errors.length} dòng lỗi, xem ở từng dòng` : "") });
    });
  }

  return (
    <div className="stack">
      <section className="panel">
        <header>
          <div><h2>Tải file chi phí</h2><p>File Excel (.xlsx), tối đa 500 dòng. Google Sheets: Tệp → Tải xuống → Microsoft Excel.</p></div>
          <a className="btn sm" href="/expenses/export?template=1" download>Tải file mẫu</a>
        </header>
        <form action={read} className="form-grid">
          <label className="field full"><span>File chi phí</span>
            <input type="file" name="file" id="expense-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
          </label>
          <label className="field full"><span>Tháng hạch toán</span>
            <select name="monthMode" id="expense-month-mode" defaultValue="paid">
              <option value="paid">Theo tháng của cột Ngày (tháng chi tiền)</option>
              <option value="file">Theo cột Thuộc tháng (trống thì theo Ngày)</option>
            </select>
          </label>
          <div className="full row">
            <button className="btn primary" disabled={pending}>{pending && !rows ? "Đang đọc…" : "Đọc file"}</button>
            {msg && !rows && <span className="err">{msg.text}</span>}
          </div>
        </form>
      </section>

      {done && done.count > 0 && (
        <div className="banner info">
          <span>Đã kê khai <b>{done.count}</b> dòng, đang chờ chủ đầu tư duyệt.</span>
          <span className="spacer" />
          {done.months.map((m) => <Link key={m} className="btn sm" href={`/expenses?month=${m}`}>Xem {mLabel(m)}</Link>)}
        </div>
      )}

      {rows && (
        <section className="panel">
          <header>
            <div>
              <h2>Xem trước{fileName ? ` · ${fileName}` : ""}</h2>
              <p>
                {list.length} dòng · {selectable.length} hợp lệ{bad.length ? ` · ${bad.length} dòng lỗi (không kê khai được)` : ""}
                {dups.length ? ` · ${dups.length} dòng có thể trùng (bỏ chọn sẵn)` : ""}
              </p>
            </div>
          </header>

          {list.length > 0 ? (
            <>
              <div className="tbl-wrap"><table className="statement">
                <thead><tr>
                  <th><input type="checkbox" aria-label="Chọn tất cả dòng hợp lệ" checked={selectable.length > 0 && selected.length === selectable.length}
                    onChange={(e) => setChecked((c) => ({ ...c, ...Object.fromEntries(selectable.map((r) => [r.line, e.target.checked])) }))} /></th>
                  <th className="n">Dòng</th><th>Ngày</th><th>Khoản chi</th><th>Nhóm chi phí</th><th>Cơ sở</th><th className="n">Số tiền</th><th>Hạch toán</th><th>Kiểm tra</th>
                </tr></thead>
                <tbody>
                  {list.map((r) => {
                    const ok = valid(r);
                    const err = lineErrors[r.line];
                    return (
                      <tr key={r.line} className={ok ? undefined : "muted"}>
                        <td><input type="checkbox" aria-label={`Chọn dòng ${r.line}`} disabled={!ok} checked={ok && !!checked[r.line]} onChange={(e) => setChecked((c) => ({ ...c, [r.line]: e.target.checked }))} /></td>
                        <td className="n num">{r.line}</td>
                        <td className="num">{dmy(r.incurredOn)}</td>
                        <td style={{ minWidth: 200 }}>
                          {r.item || <span className="muted">—</span>}
                          {(r.recipient || r.note) && <div className="hint">{[r.recipient, r.note].filter(Boolean).join(" · ")}</div>}
                        </td>
                        <td>{r.categoryName || "—"}{r.newCategory && <> <span className="pill fc">Loại mới</span></>}</td>
                        <td>{r.propertyId === null ? <span className="muted">Chi phí chung (Unix)</span> : r.propertyName || "—"}</td>
                        <td className="n"><b>{r.amount ? vnd(r.amount) : "—"}</b></td>
                        <td>{ok
                          ? <MonthList idPrefix={`month-${r.line}`} label={`Tháng hạch toán dòng ${r.line}`} months={months[r.line] ?? [r.month]} amount={r.amount}
                              onChange={(m) => setMonths((x) => ({ ...x, [r.line]: m }))} />
                          : <span className="num">{mLabel(r.month)}</span>}</td>
                        <td style={{ minWidth: 200 }}>
                          {err && <div className="err small">{err}</div>}
                          {r.errors.map((e) => <div key={e} className="err small">{e}</div>)}
                          {r.warnings.map((w) => <div key={w} className="hint">{w}</div>)}
                          {ok && !err && !r.warnings.length && <span className="pill ok">Hợp lệ</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
              <div className="row bulk-bar">
                <button type="button" className="btn primary" disabled={pending || !selected.length} onClick={commit}>
                  {pending ? "Đang kê khai…" : `Kê khai ${selected.length} khoản & gửi duyệt`}
                </button>
                <span className="small muted">
                  Tổng {vnd(selected.reduce((s, r) => s + r.amount, 0))}{newCats.length ? ` · sẽ tạo loại mới: ${newCats.join(", ")}` : ""}
                </span>
              </div>
            </>
          ) : (
            <p className="muted">Đã kê khai hết các dòng trong file.</p>
          )}
          {msg && <p className={msg.ok ? "small pos" : "err"}>{msg.text}</p>}
        </section>
      )}
    </div>
  );
}
