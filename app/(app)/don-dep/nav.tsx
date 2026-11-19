import Link from "next/link";

// Thanh chuyển giữa ba màn của buồng phòng; giữ cơ sở đang chọn (?p=).
export function CleanNav({ current, p }: { current: "board" | "calendar" | "issues"; p?: string }) {
  const q = p ? `?p=${p}` : "";
  const items: [typeof current, string, string][] = [
    ["board", "Phòng hôm nay", `/don-dep${q}`],
    ["calendar", "Lịch tuần", `/don-dep/lich${q}`],
    ["issues", "Báo sự cố", `/don-dep/su-co${q}`],
  ];
  return (
    <nav className="clean-nav" aria-label="Dọn phòng">
      {items.map(([k, label, href]) => <Link key={k} href={href} aria-current={current === k ? "page" : undefined}>{label}</Link>)}
    </nav>
  );
}
