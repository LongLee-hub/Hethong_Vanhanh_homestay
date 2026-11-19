"use client";
// Bật nhận thông báo đẩy trên điện thoại đang dùng: xin quyền, đăng ký với service worker, gửi đăng ký lên máy chủ.
// iPhone chỉ nhận thông báo khi app đã được thêm vào màn hình chính (iOS 16.4 trở lên).
import { useEffect, useState } from "react";

type State = "loading" | "unsupported" | "ios-install" | "denied" | "off" | "on" | "busy";

function keyBytes(base64: string) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.register("/sw.js");
}

export function PushToggle({ publicKey, testAction }: {
  publicKey: string | null;
  testAction: () => Promise<{ ok: boolean; error?: string; info?: string }>;
}) {
  const [state, setState] = useState<State>("loading");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
      const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        setState(ios && !standalone ? "ios-install" : "unsupported");
        return;
      }
      if (Notification.permission === "denied") { setState("denied"); return; }
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setState(sub ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, []);

  async function enable() {
    if (!publicKey) { setMsg("Máy chủ chưa cấu hình thông báo đẩy. Báo admin đặt khóa VAPID."); return; }
    setState("busy");
    setMsg(null);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "off"); return; }
      const reg = await registration();
      await navigator.serviceWorker.ready;
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
      const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON() }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Lỗi ${r.status}`);
      setState("on");
      setMsg("Đã bật. Phòng sắp có khách mà chưa dọn xong sẽ báo lên điện thoại này.");
    } catch (e) {
      setState("off");
      setMsg(`Chưa bật được: ${(e as Error).message}`);
    }
  }

  async function disable() {
    setState("busy");
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    setState("off");
    setMsg("Đã tắt thông báo trên máy này.");
  }

  async function test() {
    const r = await testAction();
    setMsg(r.ok ? r.info ?? "Đã gửi" : r.error ?? "Không gửi được");
  }

  if (state === "loading") return null;
  return (
    <section className="push-card" data-state={state} aria-live="polite">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      <div className="push-text">
        {state === "on" && <b>Điện thoại này đang nhận cảnh báo dọn phòng</b>}
        {(state === "off" || state === "busy") && <><b>Bật thông báo trên điện thoại</b><span className="small">Báo ngay khi phòng sắp có khách mà chưa dọn xong, kể cả khi đang không mở app.</span></>}
        {state === "denied" && <><b>Thông báo đang bị chặn</b><span className="small">Mở cài đặt trình duyệt, cho phép thông báo cho baocaodau rồi tải lại trang.</span></>}
        {state === "ios-install" && <><b>Cài app để nhận thông báo</b><span className="small">Trên iPhone: mở bằng Safari, bấm Chia sẻ rồi chọn Thêm vào MH chính, sau đó mở app từ màn hình chính.</span></>}
        {state === "unsupported" && <><b>Máy này chưa nhận được thông báo đẩy</b><span className="small">Dùng Chrome trên Android, hoặc app đã cài trên iPhone.</span></>}
        {msg && <span className="small" role="status">{msg}</span>}
      </div>
      {(state === "off" || state === "busy") && <button type="button" className="btn primary sm" onClick={enable} disabled={state === "busy"}>{state === "busy" ? "Đang bật…" : "Bật thông báo"}</button>}
      {state === "on" && (
        <span className="push-actions">
          <button type="button" className="btn sm" onClick={test}>Gửi thử</button>
          <button type="button" className="btn sm" onClick={disable}>Tắt</button>
        </span>
      )}
    </section>
  );
}
