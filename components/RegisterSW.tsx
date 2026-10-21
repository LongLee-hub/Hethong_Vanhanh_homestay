"use client";
import { useEffect } from "react";

// Đăng ký service worker để điện thoại cho cài app. Bỏ qua khi chạy dev để không bị lưu tạm mã cũ.
export function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
