"use client";
// Cài đặt Google và dán email payout ngay trên web.
import { useState, useTransition } from "react";
import * as D from "@/lib/domain";
import type { ParsedPayout } from "@/lib/airbnb/payout-parser";
import { importPasteAction, previewPasteAction } from "./actions";

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

function Preview({ p }: { p: ParsedPayout }) {
  if (!p.isPayout) return <div className="banner bad" role="alert">{p.skipReason}. Nhập đúng tiêu đề email payout (ví dụ "We sent you a payout of ₫…").</div>;
  const money = (n: number | null) => (n === null ? "—" : p.currency === "VND" ? D.formatVND(n) : `${n} ${p.currency}`);
  return (
    <div className="paste-preview" role="status">
      <div className="row">
        <b>Tổng payout {money(p.amount)}</b>
        <span className={`pill ${STATUS[p.status][1]}`}>{STATUS[p.status][0]}</span>
      </div>
      {p.note && <div className="small muted">{p.note}</div>}
      <div className="tbl-wrap"><table>
        <thead><tr><th>Mã đặt phòng</th><th>Khách</th><th>Nhận – trả phòng</th><th className="n">Số tiền</th></tr></thead>
        <tbody>
          {p.items.map((i) => (
            <tr key={i.confirmationCode}>
              <td className="num">{i.confirmationCode}</td>
              <td>{i.guestName ?? <span className="muted">—</span>}</td>
              <td className="num">{i.checkIn && i.checkOut ? `${D.formatDateVN(i.checkIn)} – ${D.formatDateVN(i.checkOut)}` : <span className="muted">—</span>}</td>
              <td className="n">{money(i.amount)}</td>
            </tr>
          ))}
          {!p.items.length && <tr><td colSpan={4} className="small muted">Không thấy mã đặt phòng HM… trong nội dung.</td></tr>}
        </tbody>
      </table></div>
    </div>
  );
}

export function PastePayout({ investors, today }: { investors: { id: string; name: string }[]; today: string }) {
  const [investorId, setInvestorId] = useState(investors[0]?.id ?? "");
  const [receivedOn, setReceivedOn] = useState(today);
  const [subject, setSubject] = useState("");
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
          const r = await previewPasteAction({ subject, text });
          if (r.ok) { setParsed(r.parsed); setMsg(null); } else setMsg({ ok: false, text: r.error });
        });
      }}
    >
      {investors.length > 1 && (
        <label className="field"><span>Nhà đầu tư</span>
          <select value={investorId} onChange={(e) => setInvestorId(e.target.value)}>{investors.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
        </label>
      )}
      <label className="field"><span>Ngày nhận email</span><input type="date" value={receivedOn} max={today} onChange={(e) => setReceivedOn(e.target.value)} required /></label>
      <label className="field full"><span>Tiêu đề email</span>
        <input type="text" value={subject} onChange={(e) => { setSubject(e.target.value); dirty(); }} placeholder="We sent you a payout of ₫3,450,000 VND" />
      </label>
      <label className="field full"><span>Nội dung email</span>
        <textarea className="paste-body" value={text} onChange={(e) => { setText(e.target.value); dirty(); }} required placeholder="Mở email payout, chọn toàn bộ nội dung (Ctrl/⌘ + A) rồi dán vào đây" />
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
              const r = await importPasteAction({ investorId, subject, text, receivedOn });
              if (r?.ok) { setSubject(""); setText(""); setParsed(null); setMsg({ ok: true, text: "Đã lưu payout, xem kết quả đối soát ở bảng trên" }); }
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
