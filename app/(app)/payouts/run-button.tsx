"use client";
// Nút chạy một server action, hiện kết quả ngay cạnh nút.
import { useState, useTransition } from "react";

type State = { ok: boolean; error?: string; message?: string } | null;

export function RunButton({ run, label, pendingLabel, confirm: ask, danger }: {
  run: () => Promise<State>;
  label: string;
  pendingLabel: string;
  confirm?: string;
  danger?: boolean;
}) {
  const [state, setState] = useState<State>(null);
  const [pending, start] = useTransition();
  return (
    <span className="row">
      <button
        type="button"
        className={`btn sm${danger ? " danger" : ""}`}
        disabled={pending}
        onClick={() => {
          if (ask && !window.confirm(ask)) return;
          start(async () => setState(await run()));
        }}
      >
        {pending ? pendingLabel : label}
      </button>
      {state?.error && <span className="err" role="alert">{state.error}</span>}
      {state?.ok && state.message && <span className="small pos" role="status">{state.message}</span>}
    </span>
  );
}
