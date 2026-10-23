// Phần dùng chung giữa các trang chi phí.
import Link from "next/link";
import * as D from "@/lib/domain";
import { photoHref } from "@/lib/storage";

export function ApprovalPill({ status }: { status: "PENDING" | "APPROVED" | "REJECTED" }) {
  if (status === "APPROVED") return <span className="pill ok">Đã duyệt</span>;
  if (status === "REJECTED") return <span className="pill bad">Bị từ chối</span>;
  return <span className="pill warn">Chờ duyệt</span>;
}

export function Receipts({ urls }: { urls: string[] }) {
  return urls.length ? (
    <span className="receipts">{urls.map((u, i) => <a key={u} href={photoHref(u)} target="_blank" rel="noopener">Ảnh{urls.length > 1 ? ` ${i + 1}` : ""}</a>)}</span>
  ) : (
    <span className="muted">—</span>
  );
}

/** Thanh chuyển giữa các màn hình chi phí. */
export function ExpenseTabs({ current, pending, bank, month }: { current: "list" | "pending" | "bank"; pending: number; bank: boolean; month?: string }) {
  return (
    <div className="chips" style={{ width: "100%" }}>
      <Link className="chip" aria-pressed={current === "list"} href={month ? `/expenses?month=${month}` : "/expenses"}>Theo tháng</Link>
      <Link className="chip" aria-pressed={current === "pending"} href="/expenses/pending">Chờ duyệt{pending ? ` (${pending})` : ""}</Link>
      {bank && <Link className="chip" aria-pressed={current === "bank"} href="/expenses/bank">Sao kê ngân hàng</Link>}
    </div>
  );
}

export type PropOption = { id: string; name: string };
export type CatOption = { id: string; name: string };

/** Các ô nhập của một khoản chi (dùng cho kê khai mới và sửa). */
export function ExpenseFields({ props, cats, allowCommon, value, idPrefix }: {
  props: PropOption[];
  cats: CatOption[];
  allowCommon: boolean;
  idPrefix: string;
  value?: { propertyId: string | null; categoryId: string; amount: number; month: string; incurredOn: string; description: string };
}) {
  const f = (k: string) => `${idPrefix}-${k}`;
  return (
    <>
      <label className="field full"><span>Cơ sở</span>
        <select name="propertyId" id={f("propertyId")} defaultValue={value ? value.propertyId ?? "__common" : undefined}>
          {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          {allowCommon && <option value="__common">Chi phí chung (Unix)</option>}
        </select>
      </label>
      <label className="field"><span>Loại</span><select name="categoryId" id={f("categoryId")} defaultValue={value?.categoryId}>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
      <label className="field"><span>Số tiền (VND)</span><input type="text" inputMode="numeric" name="amount" id={f("amount")} defaultValue={value?.amount ? value.amount.toLocaleString("vi-VN") : undefined} required /></label>
      <label className="field"><span>Tháng hạch toán</span><input type="month" name="month" id={f("month")} defaultValue={value?.month} required /></label>
      <label className="field"><span>Ngày phát sinh</span><input type="date" name="incurredOn" id={f("incurredOn")} defaultValue={value?.incurredOn ?? D.todayVN()} required /></label>
      <label className="field full"><span>Mô tả</span><input type="text" name="description" id={f("description")} defaultValue={value?.description} required /></label>
    </>
  );
}
