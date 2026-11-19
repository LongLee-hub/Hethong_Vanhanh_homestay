"use client";
// Tải lại dữ liệu trang định kỳ (không tải lại cả trang) để cảnh báo "Dọn ngay" tự hiện khi tới giờ.
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}
