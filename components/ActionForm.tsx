"use client";
// Form gọi server action, hiển thị lỗi nghiệp vụ trả về.
import { useActionState } from "react";

type State = { ok: boolean; error?: string } | null;

export function ActionForm({ action, children, submit, className, okText }: {
  action: (s: State, f: FormData) => Promise<State>;
  children?: React.ReactNode;
  submit: string;
  className?: string;
  okText?: string;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className={className ?? "form-grid"}>
      {children}
      <div className="full row">
        <button className="btn primary" disabled={pending}>{pending ? "Đang lưu…" : submit}</button>
        {state?.error && <span className="err">{state.error}</span>}
        {state?.ok && okText && <span className="small pos">{okText}</span>}
      </div>
    </form>
  );
}
