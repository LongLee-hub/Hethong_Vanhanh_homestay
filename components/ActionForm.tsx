"use client";
// Form gọi server action, hiển thị lỗi nghiệp vụ trả về.
import { useActionState } from "react";

type State = { ok: boolean; error?: string; info?: string } | null;

export function ActionForm({ action, children, submit, className, okText, submitClass, confirmText }: {
  action: (s: State, f: FormData) => Promise<State>;
  children?: React.ReactNode;
  submit: string;
  className?: string;
  okText?: string;
  /** Lớp của nút gửi, mặc định "btn primary" */
  submitClass?: string;
  /** Hỏi lại trước khi gửi (thao tác không hoàn tác được) */
  confirmText?: string;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form
      action={run}
      className={className ?? "form-grid"}
      onSubmit={confirmText ? (e) => { if (!window.confirm(confirmText)) e.preventDefault(); } : undefined}
    >
      {children}
      <div className="full row">
        <button className={submitClass ?? "btn primary"} disabled={pending}>{pending ? "Đang lưu…" : submit}</button>
        {state?.error && <span className="err">{state.error}</span>}
        {state?.ok && (state.info || okText) && <span className="small pos">{state.info || okText}</span>}
      </div>
    </form>
  );
}
