import Link from "next/link";

// Thanh chuyển giữa các màn của buồng phòng; giữ cơ sở đang chọn (?p=).
// manage: Admin / Quản lý thấy thêm mục sửa checklist.
export function CleanNav({ current, p, manage }: { current: "board" | "calendar" | "issues" | "checklist"; p?: string; manage?: boolean }) {
  const q = p ? `?p=${p}` : "";
  const items: [typeof current, string, string][] = [
    ["board", "Phòng hôm nay", `/don-dep${q}`],
    ["calendar", "Lịch tuần", `/don-dep/lich${q}`],
    ["issues", "Báo sự cố", `/don-dep/su-co${q}`],
    ...(manage ? [["checklist", "Checklist", `/don-dep/checklist${q}`] as [typeof current, string, string]] : []),
  ];
  return (
    <nav className="clean-nav" aria-label="Dọn phòng">
      {items.map(([k, label, href]) => <Link key={k} href={href} aria-current={current === k ? "page" : undefined}>{label}</Link>)}
    </nav>
  );
}
