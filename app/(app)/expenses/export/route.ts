// GET /expenses/export?month=…&prop=…&cat=…&q=…&from=…&to=… — file Excel chi phí theo đúng bộ lọc đang xem,
// đúng cột mẫu bảng tổng hợp chi phí (Ngày | Khoản chi | Nhóm chi phí | Cơ sở | Người nhận | Số tiền | Ghi chú | Thuộc tháng).
// GET /expenses/export?template=1 — file mẫu trống để kế toán điền rồi tải lên ở "Nhập từ file".
import { NextResponse } from "next/server";
import * as D from "@/lib/domain";
import { inArray } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { currentUser } from "@/lib/server";
import { categories, expensesForMonth, expensesInRange, monthParam, visibleProperties } from "@/lib/queries";
import { fold } from "@/lib/bank/statement-parser";
import { SHEET_COLUMNS, monthLabel, splitDescription } from "@/lib/expenses/sheet";

const MONEY = "#,##0";
const DATE = "dd/mm/yyyy";
const WIDTHS = [12, 36, 16, 18, 26, 14, 36, 12, 12];
const STATUS = { PENDING: "Chờ duyệt", APPROVED: "Đã duyệt", REJECTED: "Bị từ chối" } as const;
const isDay = (v?: string) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!can(user, "viewFinance")) return NextResponse.json({ error: "Không có quyền xem chi phí" }, { status: 403 });
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const template = sp.template === "1";
  // approved=1: bảng kê chi phí đã duyệt theo tháng hạch toán (trang /expenses/approved) — thay cột Trạng thái bằng Người duyệt, Ngày duyệt
  const approvedOnly = !template && sp.approved === "1";
  const db = getDb();
  const props = await visibleProperties(db, user);
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const catName = Object.fromEntries((await categories(db)).map((c) => [c.id, c.name]));

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(template ? "Kê khai chi phí" : "Chi phí", { views: [{ state: "frozen", ySplit: 1 }] });
  const header = template ? [...SHEET_COLUMNS] : approvedOnly ? [...SHEET_COLUMNS, "Người duyệt", "Ngày duyệt"] : [...SHEET_COLUMNS, "Trạng thái"];
  const head = ws.addRow(header);
  head.height = 20;
  head.eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3B57" } };
    c.alignment = { horizontal: "center", vertical: "middle" };
  });
  header.forEach((_, i) => { ws.getColumn(i + 1).width = WIDTHS[i]; });
  ws.getColumn(1).numFmt = DATE;
  ws.getColumn(6).numFmt = MONEY;
  if (approvedOnly) { ws.getColumn(10).width = 14; ws.getColumn(10).numFmt = DATE; }

  let name: string;
  if (template) {
    const help = wb.addWorksheet("Hướng dẫn");
    help.getColumn(1).width = 110;
    [
      "Cách điền file kê khai chi phí",
      "• Giữ nguyên dòng tiêu đề ở sheet \"Kê khai chi phí\", mỗi khoản chi một dòng.",
      "• Ví dụ: 03/10/2026 | Tiền điện | Điện nước | Vạn Phúc | EVN Hà Nội | 1.250.000 | Thanh toán hoá đơn | T10",
      "• Ngày: ngày chi tiền, dạng 03/10/2026.",
      `• Cơ sở: ghi đúng tên cơ sở trong app (${props.map((p) => p.name).join(", ") || "xem trang Cơ sở & phòng"}) hoặc "Chi phí chung" cho khoản chia chung các cơ sở Unix.`,
      `• Nhóm chi phí: tên loại chi phí trong app (${Object.values(catName).join(", ")}). Tên mới sẽ được tạo thành loại mới.`,
      "• Số tiền: số nguyên VND. Người nhận, Ghi chú: không bắt buộc — được ghép vào mô tả khoản chi.",
      "• Thuộc tháng: T10, T9… Khi tải lên chọn hạch toán theo tháng của Ngày chi (mặc định) hoặc theo cột này.",
      "• Mọi khoản tải lên đều ở trạng thái chờ duyệt và được gửi nhắc chủ đầu tư như kê khai tay.",
    ].forEach((t, i) => { const c = help.getCell(i + 1, 1); c.value = t; if (!i) c.font = { bold: true, size: 13 }; });
    name = "mau-ke-khai-chi-phi.xlsx";
  } else {
    const month = monthParam(sp.month);
    const f = { prop: sp.prop ?? "", cat: sp.cat ?? "", q: (sp.q ?? "").trim(), from: isDay(sp.from), to: isDay(sp.to) };
    const ranged = !!(f.from || f.to);
    const { direct, common } = ranged ? await expensesInRange(db, user, f.from || "2000-01-01", f.to || "2999-12-31") : await expensesForMonth(db, user, month);
    const words = fold(f.q).split(" ").filter(Boolean);
    const rows = [...direct, ...common]
      .filter((e) => (!approvedOnly || e.approvalStatus === "APPROVED") && (!f.prop || (f.prop === "common" ? e.propertyId === null : e.propertyId === f.prop)) && (!f.cat || e.categoryId === f.cat) && words.every((w) => fold(e.description).includes(w)))
      .sort((a, b) => approvedOnly
        ? (a.propertyId ? propName[a.propertyId] ?? "" : "\uffff").localeCompare(b.propertyId ? propName[b.propertyId] ?? "" : "\uffff", "vi") ||
          (catName[a.categoryId] ?? "").localeCompare(catName[b.categoryId] ?? "", "vi") || a.incurredOn.localeCompare(b.incurredOn)
        : a.incurredOn.localeCompare(b.incurredOn) || a.createdAt.getTime() - b.createdAt.getTime());
    const approverIds = [...new Set(rows.map((e) => e.approvedById).filter((v): v is string => !!v))];
    const approverName: Record<string, string> = approvedOnly && approverIds.length
      ? Object.fromEntries((await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, approverIds))).map((u) => [u.id, u.name]))
      : {};
    for (const e of rows) {
      const d = splitDescription(e.description);
      ws.addRow([
        new Date(`${e.incurredOn}T00:00:00Z`), d.item, catName[e.categoryId] ?? "", e.propertyId ? propName[e.propertyId] ?? "" : "Chi phí chung",
        d.recipient, e.amount, d.note, monthLabel(e.month, e.incurredOn),
        ...(approvedOnly
          ? [e.approvedById ? approverName[e.approvedById] ?? "" : "", e.approvedAt ? new Date(`${D.todayVN(e.approvedAt)}T00:00:00Z`) : ""]
          : [STATUS[e.approvalStatus]]),
      ]);
    }
    if (rows.length) {
      const ok = rows.filter((e) => e.approvalStatus === "APPROVED");
      const total = ws.addRow(["Tổng đã duyệt", `${ok.length}/${rows.length} khoản`, "", "", "", ok.reduce((s, e) => s + e.amount, 0)]);
      total.font = { bold: true };
      total.eachCell((c) => { c.border = { top: { style: "thin" } }; });
    }
    name = approvedOnly ? `chi-phi-da-duyet_${month}${f.prop ? `_${f.prop === "common" ? "chung" : f.prop}` : ""}.xlsx` : `chi-phi_${ranged ? `${f.from || "dau"}_${f.to || "nay"}` : month}.xlsx`;
  }

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
