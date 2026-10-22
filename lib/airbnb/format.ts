// Định dạng dùng chung cho trang máy chủ và component chạy trên trình duyệt.
// Không đặt hàm tiện ích trong file "use client": trang máy chủ không gọi được hàm từ file đó.

/** Số USD có dấu: −$4.00, $80.00; null → "—". */
export const usd = (n: number | null) => (n === null ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
