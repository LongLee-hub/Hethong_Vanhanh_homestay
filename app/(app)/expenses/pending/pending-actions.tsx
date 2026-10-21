"use client";
// Nút duyệt / từ chối / nhắc lại cho các khoản đã chọn trong bảng chờ duyệt.
import { useState, useTransition } from "react";
import { approveAction, rejectAction, remindAction } from "../actions";

type Result = { ok: boolean; error?: string; info?: string } | null;

export function PendingActions({ mode }: { mode: "approve" | "remind" }) {
  const [pending, start] = useTransition();
  const [res, setRes] = useState<Result>(null);
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  const run = (fn: (s: Result, f: FormData) => Promise<Result>, extra?: Record<string, string>) => {
    const form = document.getElementById("pending-form") as HTMLFormElement;
    const fd = new FormData(form);
    if (!fd.getAll("ids").length) return setRes({ ok: false, error: "Chọn ít nhất một khoản" });
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    start(async () => {
      const r = await fn(null, fd);
      setRes(r);
      if (r?.ok) setRejecting(false);
    });
  };

  return (
    <div className="stack" style={{ marginTop: 16 }}>
      <div className="row">
        {mode === "approve" ? (
          <>
            <button type="button" className="btn primary" disabled={pending} onClick={() => run(approveAction)}>{pending ? "Đang lưu…" : "Duyệt & xác nhận đã chi các khoản đã chọn"}</button>
            <button type="button" className="btn danger" disabled={pending} onClick={() => setRejecting((v) => !v)}>Từ chối…</button>
          </>
        ) : (
          <button type="button" className="btn" disabled={pending} onClick={() => run(remindAction)}>{pending ? "Đang gửi…" : "Nhắc lại trong nhóm Lark"}</button>
        )}
        {res?.error && <span className="err">{res.error}</span>}
        {res?.ok && res.info && <span className="small pos">{res.info}</span>}
      </div>
      {rejecting && (
        <div className="row bulk-bar">
          <input type="text" aria-label="Lý do từ chối" placeholder="Lý do từ chối, vd: sai số tiền" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button type="button" className="btn danger" disabled={pending} onClick={() => run(rejectAction, { reason })}>Từ chối các khoản đã chọn</button>
        </div>
      )}
    </div>
  );
}
