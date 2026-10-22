"use client";
// Cài đặt Google và dán email payout ngay trên web.
import { useState, useTransition } from "react";
import * as D from "@/lib/domain";
import type { ParsedPayout } from "@/lib/airbnb/payout-parser";
import { backfillGmailAction, importPasteAction, previewPasteAction } from "./actions";

export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copy-field">
      <code aria-label={label}>{value}</code>
      <button
        type="button"
        className="btn sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* trình duyệt chặn clipboard: người dùng tự chọn và copy */
          }
        }}
      >
        {copied ? "Đã copy" : "Copy"}
      </button>
    </span>
  );
}

const STATUS: Record<ParsedPayout["status"], [string, string]> = {
  OK: ["Tách đủ", "ok"],
  PARTIAL: ["Tách được một phần", "warn"],
  FAILED: ["Không tách được", "bad"],
};

export const usd = (n: number | null) => (n === null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dates = (a: string | null, b: string | null) => (a && b ? `${D.formatDateVN(a)} – ${D.formatDateVN(b)}` : "—");

function Preview({ p }: { p: ParsedPayout }) {
  if (!p.isPayout) return <div className="banner bad" role="alert">{p.skipReason}. Dán toàn bộ email, gồm cả phần cuối có dòng tổng tiền.</div>;
  return (
    <div className="paste-preview" role="status">
      <div className="row">
        <b>{p.amount !== null ? D.formatVND(p.amount) : "Không đọc được tổng VNĐ"}</b>
        <span className="muted small">{usd(p.totalUsd)}{p.exchangeRate ? ` · tỷ giá ${Math.round(p.exchangeRate).toLocaleString("vi-VN")}` : ""}{p.payoutCode ? ` · mã ${p.payoutCode}` : ""}</span>
        <span className={`pill ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span>
      </div>
      {p.note && <div className="small muted">{p.note}</div>}
      <div className="tbl-wrap"><table>
        <thead><tr><th>Khách / mã đặt phòng</th><th>Loại</th><th>Ngày ở</th><th className="n">USD</th><th className="n">VNĐ</th></tr></thead>
        <tbody>
          {p.items.map((i, k) => (
            <tr key={k}>
              <td><b>{i.guestName ?? "—"}</b><div className="small muted">{i.confirmationCode ?? "Không có mã"}{i.listingName ? ` · ${i.listingName}` : ""}</div></td>
              <td>{i.lineType ?? <span className="muted">—</span>}</td>
              <td className="num">{dates(i.checkIn, i.checkOut)}</td>
              <td className="n">{usd(i.usdAmount)}</td>
              <td className="n">{i.amount !== null ? D.formatVND(i.amount) : "—"}</td>
            </tr>
          ))}
          {!p.items.length && <tr><td colSpan={5} className="small muted">Không đọc được dòng giao dịch nào trong phần &quot;Chi tiết&quot;.</td></tr>}
        </tbody>
      </table></div>
    </div>
  );
}

export function PastePayout({ investors, today }: { investors: { id: string; name: string }[]; today: string }) {
  const [investorId, setInvestorId] = useState(investors[0]?.id ?? "");
  const [receivedOn, setReceivedOn] = useState(today);
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<ParsedPayout | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = () => { setParsed(null); setMsg(null); };

  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await previewPasteAction({ text, receivedOn });
          if (r.ok) { setParsed(r.parsed); setMsg(null); } else setMsg({ ok: false, text: r.error });
        });
      }}
    >
      {investors.length > 1 && (
        <label className="field"><span>Nhà đầu tư</span>
          <select value={investorId} onChange={(e) => setInvestorId(e.target.value)}>{investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
        </label>
      )}
      <label className="field"><span>Ngày nhận email (ngày gửi tiền)</span>
        <input type="date" value={receivedOn} max={today} onChange={(e) => { setReceivedOn(e.target.value); dirty(); }} required />
      </label>
      <label className="field full"><span>Nội dung email</span>
        <textarea className="paste-body" value={text} onChange={(e) => { setText(e.target.value); dirty(); }} required spellCheck={false} placeholder={"Mở email payout của Airbnb, chọn toàn bộ (Ctrl/⌘ + A), copy và dán vào đây.\nCần có phần \"Chi tiết\" và dòng \"Tổng số tiền đã chi trả\"."} />
      </label>
      {parsed && <div className="full"><Preview p={parsed} /></div>}
      <div className="full row">
        <button className="btn" disabled={pending || !text.trim()}>{pending && !parsed ? "Đang tách…" : "Xem trước"}</button>
        {parsed?.isPayout && (
          <button
            type="button"
            className="btn primary"
            disabled={pending || !investorId}
            onClick={() => start(async () => {
              const r = await importPasteAction({ investorId, text, receivedOn });
              if (r?.ok) { setText(""); setParsed(null); setMsg({ ok: true, text: "Đã lưu payout, xem kết quả đối soát ở bảng trên" }); }
              else setMsg({ ok: false, text: r?.error ?? "Lưu không được" });
            })}
          >
            {pending ? "Đang lưu…" : "Lưu payout"}
          </button>
        )}
        {msg && <span className={msg.ok ? "small pos" : "err"} role={msg.ok ? "status" : "alert"}>{msg.text}</span>}
      </div>
    </form>
  );
}

const COUNTS = [50, 100, 200] as const;

/** Đọc lùi email payout cũ của một Gmail: theo số email gần nhất hoặc theo khoảng ngày. */
export function BackfillGmail({ accountId, email, today }: { accountId: string; email: string; today: string }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<number | "range">(100);
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (!open) {
    return <button type="button" className="btn sm" onClick={() => setOpen(true)} aria-expanded={false}>Đọc email cũ</button>;
  }
  return (
    <form
      className="backfill"
      aria-label={`Đọc email cũ của ${email}`}
      onSubmit={(e) => {
        e.preventDefault();
        setMsg(null);
        start(async () => {
          const r = await backfillGmailAction(accountId, mode === "range" ? { since, until: until || undefined } : { count: mode });
          setMsg(r?.ok ? { ok: true, text: r.message ?? "Đã đọc xong" } : { ok: false, text: r?.error ?? "Đọc không được" });
        });
      }}
    >
      <div className="backfill-head">
        <b>Đọc email payout cũ</b>
        <button type="button" className="btn sm" onClick={() => { setOpen(false); setMsg(null); }} disabled={pending}>Đóng</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Đọc lùi từ email mới nhất. Email đã có trong hệ thống được bỏ qua nên bấm lại vẫn không ghi trùng. Mỗi email payout thường gồm vài đơn.</p>
      <div className="chips" role="radiogroup" aria-label="Phạm vi đọc">
        {COUNTS.map((n) => (
          <button key={n} type="button" role="radio" className="chip" aria-checked={mode === n} aria-pressed={mode === n} onClick={() => setMode(n)} disabled={pending}>{n} email gần nhất</button>
        ))}
        <button type="button" role="radio" className="chip" aria-checked={mode === "range"} aria-pressed={mode === "range"} onClick={() => setMode("range")} disabled={pending}>Theo khoảng ngày</button>
      </div>
      {mode === "range" && (
        <div className="row">
          <label className="field"><span>Từ ngày</span><input type="date" value={since} max={until || today} onChange={(e) => setSince(e.target.value)} required disabled={pending} /></label>
          <label className="field"><span>Đến ngày (để trống = hôm nay)</span><input type="date" value={until} min={since || undefined} max={today} onChange={(e) => setUntil(e.target.value)} disabled={pending} /></label>
        </div>
      )}
      <div className="row">
        <button className="btn primary" disabled={pending || (mode === "range" && !since)}>{pending ? "Đang đọc email…" : "Bắt đầu đọc"}</button>
        {pending && <span className="small muted" role="status">Có thể mất 1–2 phút với 100–200 email, đừng đóng trang.</span>}
        {msg && <span className={msg.ok ? "small pos" : "err"} role={msg.ok ? "status" : "alert"}>{msg.text}</span>}
      </div>
    </form>
  );
}
