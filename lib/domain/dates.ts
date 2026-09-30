// Tiện ích ngày tháng dùng chuỗi "YYYY-MM-DD" / "YYYY-MM" để tránh lệch múi giờ.
// Mọi ngày trong domain là ngày lịch theo Asia/Ho_Chi_Minh.

export type ISODate = string; // "YYYY-MM-DD"
export type Month = string; // "YYYY-MM"

function toUTC(d: ISODate): Date {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function fromUTC(dt: Date): ISODate {
  return dt.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const dt = toUTC(d);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUTC(dt);
}

export function diffDays(a: ISODate, b: ISODate): number {
  // a - b, tính bằng ngày
  return Math.round((toUTC(a).getTime() - toUTC(b).getTime()) / 86_400_000);
}

export function monthOf(d: ISODate): Month {
  return d.slice(0, 7);
}

export function firstDay(m: Month): ISODate {
  return `${m}-01`;
}

export function lastDay(m: Month): ISODate {
  const [y, mo] = m.split("-").map(Number);
  return fromUTC(new Date(Date.UTC(y, mo, 0)));
}

export function daysInMonth(m: Month): number {
  return Number(lastDay(m).slice(8, 10));
}

export function prevMonth(m: Month): Month {
  const [y, mo] = m.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 2, 1));
  return fromUTC(dt).slice(0, 7);
}

export function nextMonth(m: Month): Month {
  const [y, mo] = m.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo, 1));
  return fromUTC(dt).slice(0, 7);
}

/** Danh sách ngày từ `from` đến `to` (bao gồm cả hai đầu). */
export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Hôm nay theo giờ Việt Nam. */
export function todayVN(now: Date = new Date()): ISODate {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}
