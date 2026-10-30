// GET /reviews/export?month=… — file Excel đánh giá của tháng: sheet Tổng hợp theo cơ sở và sheet Chi tiết từng đánh giá.
// Cùng phạm vi với trang Đánh giá: chỉ cơ sở người tải được phép xem.
import { NextResponse } from "next/server";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { currentUser } from "@/lib/server";
import { monthParam } from "@/lib/queries";
import { CRITERIA, CRITERION_LABEL, monthlyReviewSummary } from "@/lib/services/reviews";
import { LOW_REVIEW_SCORE, SCORE_FIELDS } from "@/lib/dayladau/reviews";

const SCORE = "0.00";
const DATE = "dd/mm/yyyy";
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } } as const;
const LOW_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDECE8" } } as const;
const RED = { argb: "FFC0392B" };

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!can(user, "viewFinance")) return NextResponse.json({ error: "Không có quyền xem đánh giá" }, { status: 403 });

  const month = monthParam(new URL(req.url).searchParams.get("month") ?? undefined);
  const s = await monthlyReviewSummary(getDb(), user, month);
  const monthTxt = D.formatMonthVN(month);
  const scope = s.inProgress ? `tính đến hết ngày ${D.formatDateVN(s.asOf)}` : "cả tháng";
  const exported = `Xuất lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}. Đánh giá tính vào tháng khách trả phòng.`;

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  // ---- Sheet 1: Tổng hợp ----
  const sumWs = wb.addWorksheet("Tổng hợp", { views: [{ state: "frozen", ySplit: 4 }] });
  sumWs.addRow([`Đánh giá khách ${monthTxt.toLowerCase()} (${scope})`]).font = { bold: true, size: 13 };
  sumWs.addRow([exported]).font = { italic: true, color: { argb: "FF717171" } };
  sumWs.addRow([]);
  const sumHead = sumWs.addRow(["Cơ sở", "Số đánh giá", ...CRITERIA.map((c) => CRITERION_LABEL[c]), `Dưới ${LOW_REVIEW_SCORE}★`, "5★", "Tổng thể tháng trước"]);
  sumHead.font = { bold: true };
  sumHead.eachCell((c) => { c.fill = HEAD_FILL; c.border = { bottom: { style: "thin" } }; });
  [24, 12, 10, 10, 12, 12, 10, 11, 10, 8, 18].forEach((w, i) => { sumWs.getColumn(i + 1).width = w; });
  for (let i = 3; i <= 2 + CRITERIA.length; i++) sumWs.getColumn(i).numFmt = SCORE;
  sumWs.getColumn(CRITERIA.length + 5).numFmt = SCORE;

  for (const p of s.byProperty) {
    const row = sumWs.addRow([p.name, p.stats.count, ...CRITERIA.map((c) => p.stats.avg[c]), p.stats.low, p.stats.fiveStar, p.prevOverall]);
    if (p.stats.low) row.getCell(CRITERIA.length + 3).font = { bold: true, color: RED };
  }
  const total = sumWs.addRow(["Tất cả cơ sở", s.total.count, ...CRITERIA.map((c) => s.total.avg[c]), s.total.low, s.total.fiveStar, s.prevTotal.avg.overall]);
  total.font = { bold: true };
  total.eachCell((c) => { c.border = { top: { style: "thin" } }; });

  // ---- Sheet 2: Chi tiết ----
  const ws = wb.addWorksheet("Chi tiết", { views: [{ state: "frozen", ySplit: 1 }] });
  const cols: { header: string; width: number; fmt?: string }[] = [
    { header: "Trả phòng", width: 12, fmt: DATE },
    { header: "Cơ sở", width: 20 },
    { header: "Phòng", width: 10 },
    { header: "Listing", width: 24 },
    { header: "Khách", width: 22 },
    { header: "Tổng thể", width: 10, fmt: SCORE },
    ...SCORE_FIELDS.map((f) => ({ header: CRITERION_LABEL[f], width: 11, fmt: SCORE })),
    { header: "Nhận xét", width: 70 },
  ];
  const head = ws.addRow(cols.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = HEAD_FILL; c.border = { bottom: { style: "thin" } }; });
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; if (c.fmt) ws.getColumn(i + 1).numFmt = c.fmt; });
  ws.getColumn(cols.length).alignment = { wrapText: true, vertical: "top" };

  for (const r of s.items) {
    const row = ws.addRow([
      new Date(`${r.reviewDate}T00:00:00Z`), r.propertyName, r.roomName ?? "", r.listingName ?? "", r.guestName ?? "",
      r.overall, ...SCORE_FIELDS.map((f) => r.scores[f]), r.content ?? "",
    ]);
    // Đánh giá thấp tô nền đỏ nhạt để lọc nhanh
    if (r.low) row.eachCell((c) => { c.fill = LOW_FILL; });
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="danh-gia_${month}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
}
