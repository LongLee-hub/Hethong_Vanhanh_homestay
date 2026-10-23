"use client";
// Bảng phân loại sao kê: mỗi khoản tiền ra chọn cơ sở, loại, tháng, mô tả (đã gợi ý sẵn) rồi ghi nhận hàng loạt.
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { ignoreTxnsAction, recordTxnsAction } from "../actions";

type Txn = {
  id: string; ref: string; bookedOn: string; debit: number; credit: number; counterparty: string | null; content: string;
  status: "NEW" | "RECORDED" | "IGNORED" | "INCOME"; note: string | null;
  suggestion: { propertyId: string | null | undefined; categoryId: string | null; month: string; description: string; hints: string[]; confident: boolean } | null;
  expense: { id: string; propertyId: string | null; categoryId: string; month: string; approvalStatus: string } | null;
};
type Opt = { id: string; name: string };
type Draft = { property: string; category: string; month: string; description: string; checked: boolean };

const COMMON = "__common";
const vnd = (n: number) => n.toLocaleString("vi-VN") + " ₫";
const dmy = (d: string) => d.split("-").reverse().join("/");
const APPROVAL: Record<string, [string, string]> = { PENDING: ["Chờ duyệt", "warn"], APPROVED: ["Đã duyệt", "ok"], REJECTED: ["Bị từ chối", "bad"] };

export function StatementReview({ txns, props, cats, allowCommon }: { txns: Txn[]; props: Opt[]; cats: Opt[]; allowCommon: boolean }) {
  const open = useMemo(() => txns.filter((t) => t.status === "NEW"), [txns]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() =>
    Object.fromEntries(
      open.map((t) => {
        const s = t.suggestion;
        const property = s?.propertyId === undefined ? "" : s.propertyId === null ? (allowCommon ? COMMON : "") : s.propertyId;
        const category = s?.categoryId ?? "";
        return [t.id, { property, category, month: s?.month ?? t.bookedOn.slice(0, 7), description: s?.description ?? t.content, checked: !!property && !!category && !!s?.confident }];
      }),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulk, setBulk] = useState({ property: "", category: "" });
  const [ignoreNote, setIgnoreNote] = useState("");
  const [pending, start] = useTransition();

  const set = (id: string, patch: Partial<Draft>) => setDrafts((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
  const live = open.filter((t) => drafts[t.id]);
  const selected = live.filter((t) => drafts[t.id].checked);
  const allChecked = live.length > 0 && selected.length === live.length;
  const done = txns.filter((t) => t.status === "RECORDED" || t.status === "IGNORED");
  const income = txns.filter((t) => t.status === "INCOME");

  function record() {
    const missing = selected.filter((t) => !drafts[t.id].property || !drafts[t.id].category);
    if (!selected.length) return setMsg({ ok: false, text: "Chọn ít nhất một dòng" });
    if (missing.length) {
      setErrors(Object.fromEntries(missing.map((t) => [t.id, "Chọn cơ sở và loại"])));
      return setMsg({ ok: false, text: `${missing.length} dòng chưa chọn cơ sở hoặc loại` });
    }
    const items = selected.map((t) => {
      const d = drafts[t.id];
      return { txnId: t.id, propertyId: d.property === COMMON ? null : d.property, categoryId: d.category, month: d.month, description: d.description };
    });
    start(async () => {
      const r = await recordTxnsAction(items);
      if (!r.ok) return setMsg({ ok: false, text: r.error ?? "Lỗi" });
      const errs = Object.fromEntries((r.errors ?? []).map((e) => [e.txnId, e.message]));
      setErrors(errs);
      // Dòng đã ghi nhận biến mất khỏi danh sách sau khi trang tải lại; dòng lỗi giữ nguyên để sửa
      setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => errs[id] || !items.some((i) => i.txnId === id))));
      setMsg({ ok: !r.errors?.length, text: r.info + (r.errors?.length ? ` · ${r.errors.length} dòng lỗi, xem ở từng dòng` : "") });
    });
  }

  function ignore(ids: string[], ignored: boolean, note?: string) {
    if (!ids.length) return setMsg({ ok: false, text: "Chọn ít nhất một dòng" });
    start(async () => {
      const r = await ignoreTxnsAction(ids, ignored, note);
      setMsg(r.ok ? { ok: true, text: ignored ? `Đã bỏ qua ${ids.length} dòng` : "Đã đưa về chưa phân loại" } : { ok: false, text: r.error ?? "Lỗi" });
      if (r.ok && ignored) setDrafts((d) => Object.fromEntries(Object.entries(d).filter(([id]) => !ids.includes(id))));
    });
  }

  const propOptions = (
    <>
      <option value="">— Chọn cơ sở —</option>
      {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      {allowCommon && <option value={COMMON}>Chi phí chung (Unix)</option>}
    </>
  );
  const catOptions = (
    <>
      <option value="">— Chọn loại —</option>
      {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </>
  );

  return (
    <div className="stack">
      {live.length > 0 ? (
        <>
          <div className="row bulk-bar">
            <span className="small muted">{selected.length}/{live.length} dòng đã chọn · {vnd(selected.reduce((s, t) => s + t.debit, 0))}</span>
            <span className="spacer" />
            <select aria-label="Cơ sở cho các dòng đã chọn" value={bulk.property} onChange={(e) => setBulk({ ...bulk, property: e.target.value })}>{propOptions}</select>
            <select aria-label="Loại cho các dòng đã chọn" value={bulk.category} onChange={(e) => setBulk({ ...bulk, category: e.target.value })}>{catOptions}</select>
            <button type="button" className="btn sm" disabled={!bulk.property && !bulk.category}
              onClick={() => selected.forEach((t) => set(t.id, { ...(bulk.property ? { property: bulk.property } : {}), ...(bulk.category ? { category: bulk.category } : {}) }))}>
              Áp dụng cho dòng đã chọn
            </button>
          </div>
          <div className="tbl-wrap"><table className="statement">
            <thead><tr>
              <th><input type="checkbox" aria-label="Chọn tất cả" checked={allChecked} onChange={(e) => live.forEach((t) => set(t.id, { checked: e.target.checked }))} /></th>
              <th>Ngày</th><th className="n">Tiền ra</th><th>Nội dung chuyển khoản</th><th>Cơ sở</th><th>Loại</th><th>Tháng</th><th>Mô tả chi phí</th>
            </tr></thead>
            <tbody>
              {live.map((t) => {
                const d = drafts[t.id];
                return (
                  <tr key={t.id}>
                    <td><input type="checkbox" aria-label={`Chọn ${t.ref}`} checked={d.checked} onChange={(e) => set(t.id, { checked: e.target.checked })} /></td>
                    <td className="num">{dmy(t.bookedOn)}</td>
                    <td className="n"><b>{vnd(t.debit)}</b></td>
                    <td style={{ minWidth: 220 }}>
                      <div className="small">{t.content}</div>
                      <div className="hint">{t.counterparty}{t.suggestion?.hints.length ? ` · gợi ý: ${t.suggestion.hints.join(", ")}` : ""}</div>
                      {errors[t.id] && <div className="err small">{errors[t.id]}</div>}
                    </td>
                    <td><select aria-label="Cơ sở" value={d.property} onChange={(e) => set(t.id, { property: e.target.value, checked: true })}>{propOptions}</select></td>
                    <td><select aria-label="Loại" value={d.category} onChange={(e) => set(t.id, { category: e.target.value, checked: true })}>{catOptions}</select></td>
                    <td><input type="month" aria-label="Tháng hạch toán" value={d.month} onChange={(e) => set(t.id, { month: e.target.value })} /></td>
                    <td><input type="text" aria-label="Mô tả" value={d.description} onChange={(e) => set(t.id, { description: e.target.value })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          <div className="row bulk-bar">
            <button type="button" className="btn primary" disabled={pending} onClick={record}>{pending ? "Đang ghi nhận…" : `Ghi nhận ${selected.length} khoản & gửi duyệt`}</button>
            <input type="text" aria-label="Lý do bỏ qua" placeholder="Lý do (vd: chuyển nội bộ, hoàn tiền)" value={ignoreNote} onChange={(e) => setIgnoreNote(e.target.value)} />
            <button type="button" className="btn" disabled={pending} onClick={() => ignore(selected.map((t) => t.id), true, ignoreNote)}>Không phải chi phí</button>
          </div>
        </>
      ) : (
        <p className="muted">{txns.length ? "Đã phân loại hết các khoản tiền ra." : "Không có khoản tiền ra nào cần phân loại."}</p>
      )}
      {msg && <p className={msg.ok ? "small pos" : "err"}>{msg.text}</p>}

      {done.length > 0 && (
        <details className="fold">
          <summary><b>Đã xử lý</b><span className="muted small">{done.length} dòng</span></summary>
          <div className="tbl-wrap"><table>
            <tbody>
              {done.map((t) => {
                const a = t.expense ? APPROVAL[t.expense.approvalStatus] : null;
                return (
                  <tr key={t.id}>
                    <td className="num">{dmy(t.bookedOn)}</td><td className="n">{vnd(t.debit)}</td>
                    <td className="small">{t.content}<div className="hint">{t.counterparty}</div></td>
                    <td>
                      {t.status === "RECORDED" && t.expense && <><Link href={`/expenses/${t.expense.id}`}>Chi phí</Link> {a && <span className={`pill ${a[1]}`}>{a[0]}</span>}</>}
                      {t.status === "IGNORED" && <><span className="pill">Không phải chi phí</span>{t.note && <span className="hint"> {t.note}</span>} <button type="button" className="btn sm" disabled={pending} onClick={() => ignore([t.id], false)}>Phân loại lại</button></>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
        </details>
      )}
      {income.length > 0 && (
        <details className="fold">
          <summary><b>Tiền vào</b><span className="muted small">{income.length} dòng · {vnd(income.reduce((s, t) => s + t.credit, 0))} — không ghi chi phí</span></summary>
          <div className="tbl-wrap"><table><tbody>
            {income.map((t) => <tr key={t.id}><td className="num">{dmy(t.bookedOn)}</td><td className="n pos">+{vnd(t.credit)}</td><td className="small">{t.content}<div className="hint">{t.counterparty}</div></td></tr>)}
          </tbody></table></div>
        </details>
      )}
    </div>
  );
}
