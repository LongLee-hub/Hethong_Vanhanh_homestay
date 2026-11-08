// Nhập file chi phí: tải bảng tổng hợp chi phí (Excel) lên, xem trước, chọn dòng rồi kê khai hàng loạt (chờ chủ đầu tư duyệt).
import { can } from "@/lib/auth/access";
import { getDb } from "@/lib/db";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { pendingExpenses } from "@/lib/services/expenses";
import { SHEET_COLUMNS } from "@/lib/expenses/sheet";
import { ExpenseTabs } from "../shared";
import { ImportReview } from "./review";

export default async function ImportExpenses() {
  const user = await requireUser();
  if (!can(user, "editExpense")) return <NoAccess />;
  const pending = await pendingExpenses(getDb(), user);
  return (
    <>
      <div className="topbar">
        <h1>Nhập chi phí từ file</h1>
        <ExpenseTabs current="import" pending={pending.length} bank={can(user, "importStatement")} />
        <p className="sub">
          Tải bảng chi phí Excel đúng các cột <b>{SHEET_COLUMNS.join(" · ")}</b>. App đọc và cho xem trước; chọn dòng rồi kê khai —
          các khoản ở trạng thái chờ duyệt và được gửi nhắc chủ đầu tư như kê khai tay.
        </p>
      </div>
      <ImportReview />
    </>
  );
}
