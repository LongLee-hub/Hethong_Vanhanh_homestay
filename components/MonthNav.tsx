import Link from "next/link";
import * as D from "@/lib/domain";

export function MonthNav({ month, path, extra = "" }: { month: string; path: string; extra?: string }) {
  return (
    <div className="month-step">
      <Link className="btn sm" href={`${path}?month=${D.prevMonth(month)}${extra}`} aria-label="Tháng trước">‹</Link>
      <span className="num">{D.formatMonthVN(month)}</span>
      <Link className="btn sm" href={`${path}?month=${D.nextMonth(month)}${extra}`} aria-label="Tháng sau">›</Link>
    </div>
  );
}

export const vnd = D.formatVND;
export const sign = (n: number) => (n < 0 ? "neg" : n > 0 ? "pos" : "");
