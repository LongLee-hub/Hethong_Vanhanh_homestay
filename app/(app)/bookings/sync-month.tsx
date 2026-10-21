"use client";
// Nút "Lấy tất cả đơn tháng X": đồng bộ đơn Dayladau có đêm trong tháng đang xem vào hệ thống, theo một host ID hoặc tất cả (chỉ Admin).
import Link from "next/link";
import { useState, useTransition } from "react";
import type { SyncSummary } from "@/lib/dayladau/sync";
import { syncMonthAction } from "../dayladau/actions";

export type SyncAccount = { id: string; label: string; hostId: string };

export function SyncMonth({ month, label, accounts }: { month: string; label: string; accounts: SyncAccount[] }) {
  const [pending, start] = useTransition();
  const [accountId, setAccountId] = useState(accounts.length === 1 ? accounts[0].id : "");
  const [res, setRes] = useState<{ ok: boolean; error?: string; summary?: SyncSummary } | null>(null);
  const s = res?.summary;
  const missed = s?.unmapped.reduce((n, u) => n + u.count, 0) ?? 0;
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="row">
        <select aria-label="Host ID" value={accountId} disabled={pending} onChange={(e) => setAccountId(e.target.value)} style={{ width: "auto" }}>
          {accounts.length > 1 && <option value="">Tất cả host ID</option>}
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.hostId}</option>)}
        </select>
        <button className="btn sm primary" disabled={pending || !accounts.length} title="Đọc toàn bộ đơn trên Dayladau và ghi vào hệ thống các đơn có đêm trong tháng này" onClick={() => start(async () => setRes(await syncMonthAction(month, accountId || undefined)))}>
          {pending ? "Đang lấy đơn…" : `Lấy tất cả đơn ${label.toLowerCase()}`}
        </button>
        {pending && <span className="small muted">Có thể mất vài phút với host nhiều đơn, đừng đóng trang.</span>}
        {s && <span className="small">{s.created} đơn mới · {s.updated} có thay đổi · {s.unchanged} không đổi{s.adjustments ? ` · ${s.adjustments} điều chỉnh tháng đã khóa` : ""}</span>}
        {res?.error && <span className="err">{res.error}</span>}
      </div>
      {s && s.unmapped.length > 0 && (
        <div className="banner" style={{ marginTop: 12, display: "block" }}>
          <b>{missed} đơn bị bỏ qua vì {s.unmapped.length} listing chưa gắn phòng.</b> Tạo phòng và gắn listing ở mục <Link href="/dayladau">Kết nối Dayladau</Link>, rồi lấy đơn lại.
          <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {s.unmapped.map((u) => <li key={`${u.account}|${u.listing}`}>{u.account}: {u.listing} ({u.count} đơn)</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
