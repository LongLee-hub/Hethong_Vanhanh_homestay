"use client";
// Ô tháng hạch toán có nút "+ Thêm tháng": một khoản chi trải nhiều tháng thì tổng được chia đều cho các tháng chọn.
import { useEffect, useRef, useState } from "react";

const vnd = (n: number) => n.toLocaleString("vi-VN") + " ₫";
const next = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  if (!y || !mo) return "";
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};
/** Giống splitAmount ở máy chủ: phần lẻ dồn vào tháng đầu. */
const parts = (total: number, n: number) => {
  const base = Math.floor(total / n);
  return { first: total - base * (n - 1), base };
};

/** Danh sách tháng có điều khiển (dùng trong bảng xem trước nhập file). `name` có thì mỗi ô gửi kèm form. */
export function MonthList({ months, onChange, amount, name, idPrefix, label = "Tháng hạch toán" }: {
  months: string[];
  onChange: (m: string[]) => void;
  amount?: number;
  name?: string;
  idPrefix: string;
  label?: string;
}) {
  const set = (k: number, v: string) => onChange(months.map((m, i) => (i === k ? v : m)));
  const dup = months.some((m, i) => m && months.indexOf(m) !== i);
  const p = amount && months.length > 1 ? parts(amount, months.length) : null;
  return (
    <div className="month-list">
      {months.map((m, k) => (
        <div className="month-item" key={k}>
          <input type="month" name={name} id={k ? `${idPrefix}-${k}` : idPrefix} aria-label={months.length > 1 ? `${label} ${k + 1}` : label} value={m} required onChange={(e) => set(k, e.target.value)} />
          {months.length > 1 && (
            <button type="button" className="btn sm month-remove" aria-label={`Bỏ tháng ${k + 1}`} onClick={() => onChange(months.filter((_, i) => i !== k))}>×</button>
          )}
        </div>
      ))}
      <button type="button" className="btn sm month-add" disabled={months.length >= 24} onClick={() => onChange([...months, next(months[months.length - 1] ?? "") ])}>+ Thêm tháng</button>
      {dup && <span className="err small">Có tháng bị trùng</span>}
      {months.length > 1 && !dup && (
        <span className="hint">
          Chia đều {months.length} tháng{p ? `: ${p.first === p.base ? vnd(p.base) : `${vnd(p.first)} tháng đầu, ${vnd(p.base)}`}/tháng` : ""}
        </span>
      )}
    </div>
  );
}

/** Dùng trong form kê khai: tự đọc ô số tiền của form để hiện số tiền mỗi tháng. */
export function MonthsField({ name, defaultValue, idPrefix, amountName = "amount" }: { name: string; defaultValue: string; idPrefix: string; amountName?: string }) {
  const [months, setMonths] = useState([defaultValue]);
  const [amount, setAmount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = ref.current?.closest("form")?.querySelector<HTMLInputElement>(`[name="${amountName}"]`);
    if (!input) return;
    const read = () => setAmount(Number(input.value.replace(/[^\d]/g, "")) || 0);
    read();
    input.addEventListener("input", read);
    return () => input.removeEventListener("input", read);
  }, [amountName]);
  return (
    <div ref={ref}><MonthList months={months} onChange={setMonths} amount={amount} name={name} idPrefix={idPrefix} /></div>
  );
}
