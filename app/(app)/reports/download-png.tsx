"use client";
import { useState } from "react";
import s from "./report.module.css";

const SRC = "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js";
type H2C = (el: HTMLElement, opts: Record<string, unknown>) => Promise<HTMLCanvasElement>;

function loadHtml2canvas(): Promise<H2C> {
  const w = window as unknown as { html2canvas?: H2C };
  if (w.html2canvas) return Promise.resolve(w.html2canvas);
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = SRC;
    el.onload = () => (w.html2canvas ? resolve(w.html2canvas) : reject(new Error("html2canvas")));
    el.onerror = reject;
    document.head.appendChild(el);
  });
}

/** Chụp thẻ báo cáo thành ảnh PNG (html2canvas 1.4.1, theo mẫu bc-ndt). */
export function DownloadPng({ targetId, fileName }: { targetId: string; fileName: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  async function run() {
    const el = document.getElementById(targetId);
    if (!el) return;
    setState("busy");
    try {
      const h2c = await loadHtml2canvas();
      const canvas = await h2c(el, { scale: 2, useCORS: true, backgroundColor: "#ffffff", windowWidth: 980, scrollY: -window.scrollY });
      const a = document.createElement("a");
      a.download = `${fileName}.png`;
      a.href = canvas.toDataURL("image/png");
      a.click();
      setState("done");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("error");
    }
  }
  return (
    <button type="button" className={s.dlBtn} onClick={run} disabled={state === "busy"}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 12l-4.5-4.5 1.06-1.06L7 9.88V2h2v7.88l2.44-2.44L12.5 8.5 8 13z" /><rect x="2" y="13" width="12" height="2" rx="1" /></svg>
      {state === "busy" ? "Đang xử lý..." : state === "done" ? "Đã tải xong!" : state === "error" ? "Không tạo được ảnh, bấm để thử lại" : "Tải ảnh PNG"}
    </button>
  );
}
