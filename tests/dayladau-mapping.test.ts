import { describe, expect, it } from "vitest";
import { hostAmountOf, mapDayladauOrder, netOf, toVNDate } from "../lib/dayladau/mapping";
import { ordersUrl } from "../lib/dayladau/client";

const order = (over: Record<string, any> = {}) => ({
  id: 12345,
  total_billed: 1_200_000,
  status: "confirmed",
  listing: { id: 77, name: "Vạn Phúc – P201" },
  guest: { fullname: "Trần Hà", phone: "0901" },
  reservation: { start_time: "2026-09-29T14:00:00+07:00", end_time: "2026-10-01T12:00:00+07:00", subtotal_detail_v2: { type_rental: "night" } },
  items: [
    { amount: 1_000_000, commission_rates: [{ type: "host", rate: 0.85 }] },
    { amount: 200_000, commission_rates: [{ type: "host", rate: 1 }] },
  ],
  ...over,
});

describe("Map order Dayladau (theo script Apps Script)", () => {
  it("URL đúng định dạng script", () => {
    expect(ordersUrl("usc62mtlkh", "TOKEN", 200, 100)).toBe("https://api.dayladau.com/v1/hosts/usc62mtlkh/orders?offset=200&limit=100&x_access_token=TOKEN");
  });

  it("Amount host = Σ item.amount × tỷ lệ host", () => {
    expect(hostAmountOf(order())).toBe(850_000 + 200_000);
    expect(hostAmountOf({ items: [{ amount: 1_000_000, commission_rates: [{ type: "host", rate: 85 }] }] })).toBe(850_000);
    expect(hostAmountOf({})).toBe(0);
  });

  it("map các trường chính", () => {
    const m = mapDayladauOrder(order());
    expect(m).toMatchObject({
      externalId: "12345", listingKey: "77", listingName: "Vạn Phúc – P201", guestName: "Trần Hà",
      checkIn: "2026-09-29", checkOut: "2026-10-01", grossAmount: 1_200_000, hostAmount: 1_050_000, commissionAmount: 150_000,
      status: "CONFIRMED", rentalType: "night",
    });
    expect(netOf(m)).toEqual({ commission: 150_000, net: 1_050_000 });
  });

  it("không có listing.id thì dùng tên listing làm khóa", () => {
    expect(mapDayladauOrder(order({ listing: { name: "P301" } })).listingKey).toBe("P301");
  });

  it("đơn hủy: doanh thu 0", () => {
    const m = mapDayladauOrder(order({ status: "cancelled_by_guest" }));
    expect(m.status).toBe("CANCELLED");
    expect(netOf(m).net).toBe(0);
  });

  it("thuê theo giờ trong ngày → 1 đêm ngày nhận phòng", () => {
    const m = mapDayladauOrder(order({ reservation: { start_time: "2026-09-29T09:00:00+07:00", end_time: "2026-09-29T13:00:00+07:00", subtotal_detail_v2: { type_rental: "hourly" } } }));
    expect([m.checkIn, m.checkOut]).toEqual(["2026-09-29", "2026-09-30"]);
  });

  it("giờ UTC chuyển về ngày Việt Nam", () => {
    expect(toVNDate("2026-09-29T18:00:00Z")).toBe("2026-09-30");
    expect(toVNDate(1790700000)).toBe(toVNDate(1790700000 * 1000));
    expect(toVNDate("30/09/2026")).toBe("2026-09-30");
  });

  it("không có commission_rates: dùng tỷ lệ hoa hồng cấu hình", () => {
    const m = mapDayladauOrder(order({ items: undefined }));
    expect(netOf(m, 15)).toEqual({ commission: 180_000, net: 1_020_000 });
  });

  it("thiếu ngày → báo lỗi rõ ràng", () => {
    expect(() => mapDayladauOrder(order({ reservation: {} }))).toThrow(/thiếu ngày/);
  });
});
