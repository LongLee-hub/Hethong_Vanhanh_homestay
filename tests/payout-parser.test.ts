// Bộ tách email payout Airbnb, theo Apps Script "AIRBNB PAYOUT EMAIL IMPORTER v2" của LOCI.
import { describe, expect, it } from "vitest";
import { allocateVnd, extractNickname, parseDateRangeStr, parseMoney, parsePayoutEmail, prorate, splitStay } from "../lib/airbnb/payout-parser";
import { gmailErrorMessage, htmlToText, messageText } from "../lib/gmail/client";
import { SAMPLE_VI } from "./fixtures/payout-emails";

describe("Tách email payout Airbnb", () => {
  it("đọc đủ dòng giao dịch, loại dòng, listing, mã đặt phòng, mã khoản chi trả", () => {
    const p = parsePayoutEmail({ subject: "", text: SAMPLE_VI, payDate: "2026-10-06" });
    expect(p).toMatchObject({ isPayout: true, status: "OK", payoutCode: "ABCDEF123456", amount: 2_335_042, totalUsd: 94.3 });
    expect(p.items.map((i) => [i.confirmationCode, i.guestName, i.lineType, i.checkIn, i.checkOut, i.usdAmount])).toEqual([
      ["HMABCD1234", "Nguyen Van An", "Tiền phòng", "2026-10-03", "2026-10-05", 80],
      ["HMABCD1234", "Nguyen Van An", "Thuế TNCN", "2026-10-03", "2026-10-05", -4],
      ["HMABCD1234", "Nguyen Van An", "Thuế VAT", "2026-10-03", "2026-10-05", -2],
      ["HMXYZ98765", "John Smith", "Tiền phòng", "2026-10-30", "2026-11-02", 20.3],
    ]);
    expect(p.items[0]).toMatchObject({ listingName: "NTG402@Oldquarter/Studio/Balcony", listingId: "1234567890123456" });
  });

  it("VNĐ từng dòng theo tỷ giá của chính email, tổng khớp đúng số tiền email", () => {
    const p = parsePayoutEmail({ subject: "", text: SAMPLE_VI, payDate: "2026-10-06" });
    expect(p.items.map((i) => i.amount)).toEqual([1_980_948, -99_047, -49_524, 502_665]);
    expect(p.items.reduce((s, i) => s + (i.amount ?? 0), 0)).toBe(2_335_042);
    expect(Math.round(p.exchangeRate!)).toBe(24_762);
  });

  it("phần dư làm tròn dồn vào dòng có |USD| lớn nhất", () => {
    const { vnd } = allocateVnd([1, 1, 1], 100);
    expect(vnd).toEqual([34, 33, 33]);
    expect(allocateVnd([10], null).vnd).toEqual([null]);
  });

  it("email tiếng Anh: Details / Total paid out / Payout ID", () => {
    const text = ["Details", "Jane Doe  $50.00 USD", "Accommodation • 12/20/2026 - 12/23/2026", "Lac Trung 2 (1111111111)", "HMEN000001", "Total paid out: ₫1.250.000 VND", "Payout ID: G1234567890XYZ"].join("\n");
    const p = parsePayoutEmail({ subject: "", text, payDate: "2026-12-21" });
    expect(p).toMatchObject({ status: "OK", payoutCode: "G1234567890XYZ", amount: 1_250_000 });
    expect(p.items[0]).toMatchObject({ lineType: "Tiền phòng", checkIn: "2026-12-20", checkOut: "2026-12-23", amount: 1_250_000 });
  });

  it("bỏ qua email không có dòng tổng chi trả (xác nhận đặt phòng, nhắc cập nhật…)", () => {
    const p = parsePayoutEmail({ subject: "Payout update", text: "Reservation confirmed HMABCD1234 $80,00 USD" });
    expect(p.isPayout).toBe(false);
  });

  it("email có tổng nhưng không đọc được phần Chi tiết → một phần", () => {
    const p = parsePayoutEmail({ subject: "", text: "Tổng số tiền đã chi trả: ₫500.000 VND" });
    expect(p).toMatchObject({ isPayout: true, status: "PARTIAL", amount: 500_000, items: [] });
  });

  it("đọc số tiền nhiều kiểu viết như parseMoney của script", () => {
    expect(parseMoney("$16,30 USD")).toBe(16.3);
    expect(parseMoney("-$1.234,56 USD")).toBe(-1234.56);
    expect(parseMoney("2.335.042")).toBe(2_335_042);
    expect(parseMoney("1,234.56")).toBe(1234.56);
  });

  it("ngày d/M hay M/d: theo phần > 12, số 0 đứng đầu, rồi so với ngày gửi tiền", () => {
    expect(parseDateRangeStr("13/10/2026", "15/10/2026", null)).toEqual({ checkIn: "2026-10-13", checkOut: "2026-10-15" });
    expect(parseDateRangeStr("10/13/2026", "10/15/2026", null)).toEqual({ checkIn: "2026-10-13", checkOut: "2026-10-15" });
    expect(parseDateRangeStr("3/10/2026", "5/10/2026", "2026-10-06")).toEqual({ checkIn: "2026-10-03", checkOut: "2026-10-05" });
    // Đọc kiểu Việt Nam (3/10 → 4/10) thì check-in sau ngày gửi tiền quá 45 ngày → đọc kiểu Mỹ (10/3 → 10/4)
    expect(parseDateRangeStr("3/10/2026", "4/10/2026", "2026-03-12")).toEqual({ checkIn: "2026-03-10", checkOut: "2026-04-10" });
    // Cả hai cách đều hợp lệ → mặc định kiểu Việt Nam
    expect(parseDateRangeStr("10/3/2026", "10/5/2026", "2026-10-04")).toEqual({ checkIn: "2026-03-10", checkOut: "2026-05-10" });
  });

  it("tách kỳ ở theo tháng, chia tiền theo đêm, phần cuối nhận phần dư", () => {
    const parts = splitStay("2026-10-30", "2026-11-02")!;
    expect(parts).toEqual([
      { month: "2026-10", nights: 2, totalNights: 3, checkIn: "2026-10-30", checkOut: "2026-10-31" },
      { month: "2026-11", nights: 1, totalNights: 3, checkIn: "2026-11-01", checkOut: "2026-11-02" },
    ]);
    expect(prorate(100_000, parts)).toEqual([66_667, 33_333]);
    expect(splitStay(null, "2026-11-02")).toBeNull();
  });

  it("lấy nickname phòng từ tên listing", () => {
    expect(extractNickname("NTG402@Oldquarter/Studio")).toBe("NTG402");
    expect(extractNickname("Unix76NTG401. Máy chiếu")).toBe("NTG401");
  });

  it("thân thư: lấy phần text/plain giống getPlainBody(), không có thì đổi HTML ra chữ", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    expect(messageText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("plain") } }, { mimeType: "text/html", body: { data: b64("<p>html</p>") } }] })).toBe("plain");
    expect(messageText({ mimeType: "text/html", body: { data: b64("<p>a</p><p>&#8363;1&nbsp;VND</p>") } })).toBe("a\n₫1 VND");
    expect(htmlToText("<style>x</style><div>HMABCD1234</div>")).toBe("HMABCD1234");
  });

  it("lỗi Gmail API → hướng dẫn sửa bằng tiếng Việt", () => {
    const disabled = JSON.stringify({ error: { code: 403, message: "Gmail API has not been used in project 485731234567 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=485731234567 then retry.", errors: [{ message: "...", domain: "usageLimits", reason: "accessNotConfigured" }], status: "PERMISSION_DENIED", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED", domain: "googleapis.com", metadata: { service: "gmail.googleapis.com", consumer: "projects/485731234567" } }] } }, null, 2);
    expect(gmailErrorMessage(403, disabled)).toBe('Gmail API chưa được bật cho project Google Cloud 485731234567. Mở https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=485731234567, bấm Enable, đợi 2–5 phút rồi bấm "Đọc thư ngay" (không cần kết nối lại).');
    const scope = JSON.stringify({ error: { code: 403, message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] } });
    expect(gmailErrorMessage(403, scope)).toMatch(/Chưa cấp quyền đọc Gmail/);
    expect(gmailErrorMessage(401, "{}")).toMatch(/kết nối lại Gmail/);
    expect(gmailErrorMessage(500, "Backend\nError")).toBe("Gmail API lỗi 500: Backend Error");
  });
});
