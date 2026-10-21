// Bộ tách email payout Airbnb. Email mẫu dựng theo cấu trúc email payout của Airbnb (TODO(CONFIRM) với email thật).
import { describe, expect, it } from "vitest";
import { findMoney, parseDateRange, parsePayoutEmail } from "../lib/airbnb/payout-parser";
import { htmlToText, messageText } from "../lib/gmail/client";

const EN = {
  subject: "We sent you a payout of ₫3,450,000 VND",
  text: [
    "Airbnb",
    "We sent a payout of ₫3,450,000 VND to your account ••••1234.",
    "It should arrive by Oct 23, 2026.",
    "Details",
    "Nguyen Van An",
    "Oct 3 – 5, 2026",
    "Vạn Phúc P101 · Cozy studio",
    "HMABCD1234",
    "₫1,950,000 VND",
    "John Smith",
    "Oct 30 – Nov 2, 2026",
    "Phan Kế Bính P202",
    "HMXYZ98765",
    "₫1,500,000 VND",
  ].join("\n"),
};

const VI = {
  subject: "Chúng tôi đã gửi cho bạn khoản thanh toán 2.100.000 ₫",
  text: [
    "Chúng tôi đã gửi khoản thanh toán 2.100.000 ₫ tới tài khoản ••••5678.",
    "Khách: Trần Thị Bình",
    "30 thg 12, 2026 – 2 thg 1, 2027",
    "Mã xác nhận HMQWERTY12",
    "2.100.000 ₫",
  ].join("\n"),
};

describe("Tách email payout Airbnb", () => {
  it("email tiếng Anh nhiều đơn: tổng tiền, mã, ngày, tiền từng đơn", () => {
    const p = parsePayoutEmail(EN);
    expect(p.isPayout).toBe(true);
    expect(p.status).toBe("OK");
    expect(p.amount).toBe(3_450_000);
    expect(p.currency).toBe("VND");
    expect(p.items).toEqual([
      { confirmationCode: "HMABCD1234", guestName: "Nguyen Van An", checkIn: "2026-10-03", checkOut: "2026-10-05", amount: 1_950_000 },
      { confirmationCode: "HMXYZ98765", guestName: "John Smith", checkIn: "2026-10-30", checkOut: "2026-11-02", amount: 1_500_000 },
    ]);
  });

  it("email tiếng Việt: dấu chấm phân cách nghìn, ngày qua năm mới, nhãn Khách", () => {
    const p = parsePayoutEmail(VI);
    expect(p.status).toBe("OK");
    expect(p.amount).toBe(2_100_000);
    expect(p.items).toEqual([{ confirmationCode: "HMQWERTY12", guestName: "Trần Thị Bình", checkIn: "2026-12-30", checkOut: "2027-01-02", amount: 2_100_000 }]);
  });

  it("tổng các đơn khác tổng payout → tách được một phần", () => {
    const p = parsePayoutEmail({ ...EN, subject: "We sent you a payout of ₫3,500,000 VND" });
    expect(p.status).toBe("PARTIAL");
    expect(p.note).toMatch(/khác tổng payout/);
  });

  it("email không có mã HM vẫn giữ tổng tiền, đánh dấu một phần", () => {
    const p = parsePayoutEmail({ subject: "Your payout of $120.50 USD was sent", text: "We sent a payout of $120.50 USD." });
    expect(p.amount).toBe(120.5);
    expect(p.currency).toBe("USD");
    expect(p.items).toHaveLength(0);
    expect(p.status).toBe("PARTIAL");
  });

  it("bỏ qua thư không phải tiền đã chuyển", () => {
    expect(parsePayoutEmail({ subject: "Reservation confirmed - An arrives Oct 3", text: "HMABCD1234 ₫1,950,000" }).isPayout).toBe(false);
    expect(parsePayoutEmail({ subject: "Your payout failed", text: "" }).isPayout).toBe(false);
    expect(parsePayoutEmail({ subject: "Cập nhật phương thức nhận khoản thanh toán", text: "" }).isPayout).toBe(false);
  });

  it("đọc số tiền nhiều kiểu viết", () => {
    expect(findMoney("₫1,234,567").map((m) => m.amount)).toEqual([1_234_567]);
    expect(findMoney("1.234.567 ₫").map((m) => m.amount)).toEqual([1_234_567]);
    expect(findMoney("1.234.567đ và 500.000 VND").map((m) => m.amount)).toEqual([1_234_567, 500_000]);
    expect(findMoney("Đức Anh").length).toBe(0);
  });

  it("đọc khoảng ngày nhiều kiểu viết", () => {
    expect(parseDateRange("03/10/2026 – 05/10/2026")).toEqual({ checkIn: "2026-10-03", checkOut: "2026-10-05" });
    expect(parseDateRange("Dec 30, 2026 – Jan 2, 2027")).toEqual({ checkIn: "2026-12-30", checkOut: "2027-01-02" });
    expect(parseDateRange("3 – 5 thg 10, 2026")).toEqual({ checkIn: "2026-10-03", checkOut: "2026-10-05" });
    expect(parseDateRange("Phòng 101")).toBeNull();
  });

  it("thân thư HTML thành từng dòng, ưu tiên phần HTML", () => {
    expect(htmlToText("<table><tr><td>HMABCD1234</td></tr><tr><td>&#8363;1,950,000&nbsp;VND</td></tr></table>")).toBe("HMABCD1234\n₫1,950,000 VND");
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    const text = messageText({ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("plain") } }, { mimeType: "text/html", body: { data: b64("<p>html</p>") } }] });
    expect(text).toBe("html");
  });
});
