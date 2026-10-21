"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// Thanh tab dưới trên điện thoại: tối đa 4 mục chính có biểu tượng + "Thêm" mở bảng trượt
// chứa các mục còn lại, tài khoản, cài app và đăng xuất.

const ICON: Record<string, string> = {
  "/": "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
  "/properties": "M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M2 21h20M8 8h3M8 12h3M8 16h3",
  "/bookings": "M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 10h16M8 3v4M16 3v4",
  "/expenses": "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3",
  "/settlements": "M4 7h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2h12v4M16 13.5h.01",
  "/payouts": "M3 7h18v12H3zM3 11h18M7 15h4M16 3l-4 4-4-4",
  "/reports": "M3 21h18M6 17v-5M11 17V6M16 17v-8M21 17v-3",
  "/tasks": "M10 6h10M10 12h10M10 18h10M3.5 6l1.5 1.5L7.5 5M3.5 12l1.5 1.5 2.5-2.5M3.5 18l1.5 1.5 2.5-2.5",
  "/attendance": "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  "/dayladau": "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  "/users": "M16 20v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  more: "M4 6h16M4 12h16M4 18h16",
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[name] ?? ICON.more} />
    </svg>
  );
}

type InstallPrompt = Event & { prompt: () => Promise<void> };

export function MobileNav({ items, primary, user }: { items: [string, string][]; primary: string[]; user: { name: string; role: string } }) {
  const path = usePathname();
  const sheet = useRef<HTMLDialogElement>(null);
  const isOn = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));

  const main = items.filter(([href]) => primary.includes(href)).slice(0, 4);
  const shown = main.length ? main : items.slice(0, 4);
  const rest = items.filter((it) => !shown.includes(it));

  // Chuyển trang thì đóng bảng trượt.
  useEffect(() => { sheet.current?.close(); }, [path]);

  // Cài app: Android/Chrome có nút cài trực tiếp; iPhone phải dùng nút Chia sẻ của Safari.
  const [install, setInstall] = useState<InstallPrompt | null>(null);
  const [iosHint, setIosHint] = useState(false);
  useEffect(() => {
    const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    if (standalone) return;
    setIosHint(/iphone|ipad|ipod/i.test(navigator.userAgent));
    const onPrompt = (e: Event) => { e.preventDefault(); setInstall(e as InstallPrompt); };
    const onInstalled = () => { setInstall(null); setIosHint(false); };
    addEventListener("beforeinstallprompt", onPrompt);
    addEventListener("appinstalled", onInstalled);
    return () => { removeEventListener("beforeinstallprompt", onPrompt); removeEventListener("appinstalled", onInstalled); };
  }, []);

  return (
    <>
      <nav className="tabbar" aria-label="Điều hướng chính">
        {shown.map(([href, label]) => (
          <Link key={href} href={href} className="tab" aria-current={isOn(href) ? "page" : undefined}>
            <Icon name={href} /><span>{label}</span>
          </Link>
        ))}
        <button type="button" className="tab" aria-haspopup="dialog" aria-current={rest.some(([h]) => isOn(h)) ? "page" : undefined} onClick={() => sheet.current?.showModal()}>
          <Icon name="more" /><span>Thêm</span>
        </button>
      </nav>

      <dialog ref={sheet} className="sheet" aria-label="Menu" onClick={(e) => { if (e.target === e.currentTarget) e.currentTarget.close(); }}>
        <div className="sheet-in">
          <div className="sheet-grip" aria-hidden="true" />
          <div className="sheet-user">
            <span className="avatar" aria-hidden="true">{user.name.trim().split(/\s+/).pop()?.[0]?.toUpperCase()}</span>
            <span><b>{user.name}</b><span className="lbl">{user.role}</span></span>
          </div>

          {rest.length > 0 && (
            <ul className="sheet-list">
              {rest.map(([href, label]) => (
                <li key={href}>
                  <Link href={href} aria-current={isOn(href) ? "page" : undefined}><Icon name={href} /><span>{label}</span></Link>
                </li>
              ))}
            </ul>
          )}

          {install && (
            <button type="button" className="btn primary sheet-wide" onClick={async () => { await install.prompt(); setInstall(null); }}>
              Cài LOCI lên màn hình chính
            </button>
          )}
          {!install && iosHint && (
            <p className="sheet-hint">Cài app trên iPhone: mở bằng Safari, bấm nút <b>Chia sẻ</b> rồi chọn <b>Thêm vào MH chính</b>.</p>
          )}

          <form action="/api/auth/logout" method="post">
            <button className="btn sheet-wide">Đăng xuất</button>
          </form>
        </div>
      </dialog>
    </>
  );
}
