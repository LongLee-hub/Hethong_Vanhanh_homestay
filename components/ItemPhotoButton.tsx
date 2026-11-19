"use client";
// Nút chụp ảnh cho một mục checklist: mở thẳng camera sau, nén ảnh về 1600px rồi tự gửi, không cần bấm thêm nút lưu.
import { useActionState, useRef } from "react";

type State = { ok: boolean; error?: string } | null;

export function ItemPhotoButton({ action, taskId, index, item, taken }: {
  action: (s: State, f: FormData) => Promise<State>;
  taskId: string;
  index: number;
  item: string;
  taken: boolean;
}) {
  const [state, run, pending] = useActionState(action, null);
  const form = useRef<HTMLFormElement>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const f = input.files?.[0];
    if (!f) return;
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
      const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
      if (blob) {
        const dt = new DataTransfer();
        dt.items.add(new File([blob], "checklist.jpg", { type: "image/jpeg" }));
        input.files = dt.files;
      }
    } catch {
      /* giữ ảnh gốc */
    }
    form.current?.requestSubmit();
  }

  return (
    <form ref={form} action={run} className="clean-photo">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="index" value={index} />
      <label className={`clean-shot ${taken ? "taken" : "need"}`} aria-busy={pending}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="4" />
        </svg>
        <span>{pending ? "Đang gửi…" : taken ? "Chụp lại" : "Chụp ảnh"}</span>
        <input type="file" name="photo" accept="image/*" capture="environment" className="sr-only" onChange={onChange} disabled={pending} aria-label={`${taken ? "Chụp lại" : "Chụp"} ảnh: ${item}`} />
      </label>
      {state?.error && <span className="err small" role="alert">{state.error}</span>}
    </form>
  );
}
