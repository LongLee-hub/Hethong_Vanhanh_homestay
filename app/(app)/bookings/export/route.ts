// GET /bookings/export?month=…&prop=…&from=…&to=…&q=… — file Excel các đơn theo đúng bộ lọc đang xem, để đối chiếu.
import { NextResponse } from "next/server";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { currentUser } from "@/lib/server";
import { monthParam, visibleProperties } from "@/lib/queries";
import { filteredBookings, filterScope, parseBookingFilter } from "../filter";

const SOURCE: Record<string, string> = { DAYLADAU: "Dayladau", MANUAL: "Nhập tay", AIRBNB_PAYOUT: "Payout Airbnb" };
const CHANNEL: Record<string, string> = { Direct: "Trực tiếp" };
const MONEY = "#,##0";
const DATE = "dd/mm/yyyy";
const asDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  if (!can(user, "viewBookings")) return NextResponse.json({ error: "Không có quyền xem đặt phòng" }, { status: 403 });

  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const db = getDb();
  const props = await visibleProperties(db, user);
  const f = parseBookingFilter(sp, monthParam(sp.month), props.map((p) => p.id));
  const rows = await filteredBookings(db, user, f);
  // Buồng phòng chỉ xem lịch check-in/out, không xem tiền
  const showAmt = can(user, "viewBookingAmounts");
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const roomName = Object.fromEntries(props.flatMap((p) => p.rooms.map((r) => [r.id, r.name])));

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Đơn đặt phòng", { views: [{ state: "frozen", ySplit: 4 }] });
  const columns: { header: string; width: number; fmt?: string }[] = [
    { header: "Mã đơn", width: 18 },
    { header: "Khách", width: 24 },
    { header: "Cơ sở", width: 20 },
    { header: "Phòng", width: 12 },
    { header: "Kênh bán", width: 14 },
    { header: "Ngày đặt", width: 12, fmt: DATE },
    { header: "Nhận phòng", width: 12, fmt: DATE },
    { header: "Trả phòng", width: 12, fmt: DATE },
    { header: "Số đêm", width: 8 },
    ...(showAmt ? [{ header: "Khách trả", width: 14, fmt: MONEY }, { header: "Phí kênh bán", width: 14, fmt: MONEY }, { header: "Thực nhận", width: 14, fmt: MONEY }] : []),
    { header: "Trạng thái", width: 13 },
    { header: "Nguồn", width: 14 },
  ];

  const scope = f.ranged ? filterScope(f) : `${filterScope(f)} ${D.formatMonthVN(f.month).toLowerCase()}`;
  ws.addRow([`Đơn đặt phòng · ${scope}${f.prop ? ` · ${propName[f.prop]}` : ""}${f.q ? ` · tìm "${f.q}"` : ""}`]).font = { bold: true, size: 13 };
  ws.addRow([`Xuất lúc ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })} · ${rows.length} đơn. Số tiền là của cả đơn, kể cả phần đêm nằm ngoài khoảng.`]).font = { italic: true, color: { argb: "FF717171" } };
  ws.addRow([]);
  const head = ws.addRow(columns.map((c) => c.header));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } }; c.border = { bottom: { style: "thin" } }; });
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; if (c.fmt) ws.getColumn(i + 1).numFmt = c.fmt; });

  for (const b of rows) {
    ws.addRow([
      b.externalId ?? "Đơn ngoài OTA", b.guestName ?? "Khách", propName[b.propertyId] ?? "", roomName[b.roomId] ?? "",
      CHANNEL[b.channel] ?? b.channel, asDate(b.bookedAt), asDate(b.checkIn), asDate(b.checkOut), D.diffDays(b.checkOut, b.checkIn),
      ...(showAmt ? [b.grossAmount, b.commissionAmount, b.netAmount] : []),
      b.status === "CANCELLED" ? "Đã hủy" : "Đã xác nhận", SOURCE[b.source] ?? b.source,
    ]);
  }

  if (showAmt && rows.length) {
    const ok = rows.filter((b) => b.status !== "CANCELLED");
    const sum = (k: "grossAmount" | "commissionAmount" | "netAmount") => ok.reduce((s, b) => s + b[k], 0);
    const total = ws.addRow(["Tổng đơn đã xác nhận", `${ok.length} đơn`, "", "", "", null, null, null, ok.reduce((s, b) => s + D.diffDays(b.checkOut, b.checkIn), 0), sum("grossAmount"), sum("commissionAmount"), sum("netAmount")]);
    total.font = { bold: true };
    total.eachCell((c) => { c.border = { top: { style: "thin" } }; });
  }

  const buf = await wb.xlsx.writeBuffer();
  const name = `don-dat-phong_${f.ranged ? `${f.from || "dau"}_${f.to || "nay"}` : f.month}.xlsx`;
  return new NextResponse(buf as ArrayBuffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  });
}
