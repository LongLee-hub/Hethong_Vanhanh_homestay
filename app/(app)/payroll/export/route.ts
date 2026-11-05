// GET /payroll/export?month=… — file Excel bảng lương buồng phòng của tháng. Chỉ admin.
import { NextResponse } from "next/server";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { currentUser } from "@/lib/server";
import { monthParam } from "@/lib/queries";
import { LOW_PENALTY_BELOW, monthlyPayroll } from "@/lib/services/payroll";

const VND = "#,##0";
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } } as const;

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!can(user, "admin")) return NextResponse.json({ error: "Chỉ admin xem được bảng lương" }, { status: 403 });

  const month = monthParam(new URL(req.url).searchParams.get("month") ?? undefined);
  const p = await monthlyPayroll(getDb(), user, month);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Bảng lương", { views: [{ state: "frozen", ySplit: 4 }] });
  ws.addRow([`Lương buồng phòng ${D.formatMonthVN(month).toLowerCase()}`]).font = { bold: true, size: 13 };
  ws.addRow([`Công chuẩn ${p.standardDays} ngày. Tăng ca ${D.formatVND(p.rates.overtimeRate)}/lần, thưởng ${D.formatVND(p.rates.fiveStarBonus)}/đánh giá 5★, phạt ${D.formatVND(p.rates.lowReviewPenalty)}/đánh giá dưới ${LOW_PENALTY_BELOW}★.`]).font = { italic: true, color: { argb: "FF717171" } };
  ws.addRow([]);
  const head = ws.addRow([
    "Nhân viên", "Cơ sở", "Lương ca sáng/tháng", "Số ca sáng", "Đơn giá ca sáng", "Tiền ca sáng",
    "Lương ca tối/tháng", "Số ca tối", "Đơn giá ca tối", "Tiền ca tối", "Số lần tăng ca", "Tiền tăng ca",
    "Số đánh giá 5★", "Thưởng", `Số đánh giá dưới ${LOW_PENALTY_BELOW}★`, "Phạt", "Cộng/trừ", "Ghi chú cộng/trừ", "Thực lĩnh",
  ]);
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = HEAD_FILL; c.border = { bottom: { style: "thin" } }; c.alignment = { wrapText: true, vertical: "middle" }; });
  for (const r of p.rows) {
    ws.addRow([
      r.name, r.propertyNames.join(", "), r.morningMonthly, r.morningShifts, r.morningRate, r.morningPay,
      r.eveningMonthly, r.eveningShifts, r.eveningRate, r.eveningPay, r.overtime, r.overtimePay,
      r.fiveStar, r.bonus, r.low, -r.penalty, r.adjustments, r.adjustmentItems.map((a) => `${a.amount > 0 ? "+" : ""}${a.amount.toLocaleString("vi-VN")} ${a.reason}`).join("; "), r.total,
    ]);
  }
  const total = ws.addRow(["Tổng", "", "", "", "", { formula: `SUM(F5:F${ws.rowCount})` }, "", "", "", { formula: `SUM(J5:J${ws.rowCount})` }, "", { formula: `SUM(L5:L${ws.rowCount})` },
    "", { formula: `SUM(N5:N${ws.rowCount})` }, "", { formula: `SUM(P5:P${ws.rowCount})` }, { formula: `SUM(Q5:Q${ws.rowCount})` }, "", { formula: `SUM(S5:S${ws.rowCount})` }]);
  total.font = { bold: true };
  [22, 24, 14, 9, 12, 13, 14, 9, 12, 13, 10, 12, 10, 11, 10, 11, 12, 28, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
  for (const c of [3, 5, 6, 7, 9, 10, 12, 14, 16, 17, 19]) ws.getColumn(c).numFmt = VND;

  const buf = await wb.xlsx.writeBuffer();
  return new Response(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="luong-buong-phong-${month}.xlsx"`,
    },
  });
}
