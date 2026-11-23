import { describe, expect, it } from "vitest";
import { hostAmountOf, mapDayladauOrder, netOf, toVNDate } from "../lib/dayladau/mapping";
import { ordersUrl } from "../lib/dayladau/client";
import { itemsOf, mapCalendarReservation } from "../lib/dayladau/calendar";

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

  it("đơn hủy không còn tiền host: doanh thu 0", () => {
    const m = mapDayladauOrder(order({ status: "cancelled_by_guest", total_billed: 0, items: [] }));
    expect(m.status).toBe("CANCELLED");
    expect(netOf(m).net).toBe(0);
  });

  it("đơn hủy có phí: doanh thu = host_amount (Quy chế, Điều 3)", () => {
    // Như đơn 283875: giá phòng 335.300, hoàn khách 167.650, host 80%
    const m = mapDayladauOrder(order({
      status: "cancelled", total_billed: 142_650,
      items: [
        { type: "reservation", amount: 335_300, commission_rates: [{ type: "host", rate: 0.8 }] },
        { type: "promotion_code", amount: -50_000, commission_rates: [{ type: "host", rate: 0 }] },
        { type: "reservation", amount: -167_650, commission_rates: [{ type: "host", rate: 0.8 }] },
        { type: "promotion_code", amount: 25_000, commission_rates: [{ type: "host", rate: 0 }] },
      ],
    }));
    expect(m.status).toBe("CANCELLED");
    expect(netOf(m)).toEqual({ net: 134_120, commission: 142_650 - 134_120 });
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

describe("Đơn tạo tay trên lịch (thẻ Host)", () => {
  it("đọc danh sách dưới nhiều khóa khác nhau", () => {
    expect(itemsOf({ calendars: [{ id: 1 }] })).toHaveLength(1);
    expect(itemsOf({ data: { items: [{ id: 1 }, { id: 2 }] } })).toHaveLength(2);
    expect(itemsOf([{ id: 1 }])).toHaveLength(1);
    expect(itemsOf({ message: "ok" })).toBeNull();
  });

  it("map đơn gia hạn giờ thành thuê giờ, host nhận đủ tiền", () => {
    const m = mapCalendarReservation({
      id: "cal2cxvnhiz-1795435507670", type: "reservation", status: "success", source: "zalo", total_price: 59000,
      listing: { id: "ls2z17kjr4", name: "tcung101" }, start_time: "2026-11-21T09:00:00+07:00", end_time: "2026-11-21T10:00:00+07:00", guest_name: "Khách extend 1h",
    });
    expect(m).toMatchObject({ externalId: "cal2cxvnhiz-1795435507670", listingKey: "ls2z17kjr4", channel: "Zalo", checkIn: "2026-11-21", checkOut: "2026-11-22", rentalType: "hourly_rental", grossAmount: 59000, hostAmount: 59000, commissionAmount: 0, status: "CONFIRMED", linkedOrderId: null });
  });

  it("qua đêm là đêm bán; hủy; đơn thuộc đơn Dayladau", () => {
    const base = { id: "c1", listing_id: "L1", start_time: Date.parse("2026-10-23T12:00:00+07:00"), end_time: Date.parse("2026-10-25T12:00:00+07:00"), price: "1.225.000" };
    expect(mapCalendarReservation(base)).toMatchObject({ externalId: "cal:c1", checkIn: "2026-10-23", checkOut: "2026-10-25", rentalType: null, grossAmount: 1_225_000 });
    expect(mapCalendarReservation({ ...base, status: "cancelled" }).status).toBe("CANCELLED");
    // Dữ liệu thật: không có status, avaiable=true là đơn hủy; không có source là DIRECT
    expect(mapCalendarReservation({ ...base, avaiable: true })).toMatchObject({ status: "CANCELLED", rawStatus: "Hủy" });
    expect(mapCalendarReservation({ ...base, avaiable: false, amount: 177000 })).toMatchObject({ status: "CONFIRMED", channel: "Direct" });
    expect(mapCalendarReservation({ ...base, order_id: 327585 }).linkedOrderId).toBe("327585");
    expect(() => mapCalendarReservation({ id: "c2" })).toThrow(/thiếu ngày/);
  });
});
