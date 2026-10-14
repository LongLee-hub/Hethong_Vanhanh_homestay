"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks({ items }: { items: [string, string][] }) {
  const path = usePathname();
  return (
    <>
      {items.map(([href, label]) => {
        const on = href === "/" ? path === "/" : path.startsWith(href);
        return <Link key={href} className="nav-btn" href={href} aria-current={on ? "page" : undefined}>{label}</Link>;
      })}
    </>
  );
}
