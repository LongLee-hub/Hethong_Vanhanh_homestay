import { describe, expect, it, vi } from "vitest";
import { formatVnAddress, reverseGeocode } from "../lib/services/geocode";

describe("địa chỉ in trên ảnh chấm công", () => {
  it("ghép số nhà, đường, phường, quận, thành phố", () => {
    expect(formatVnAddress({ house_number: "12", road: "Vạn Phúc", quarter: "Phường Kim Mã", city_district: "Quận Ba Đình", city: "Hà Nội" }))
      .toBe("12 Vạn Phúc, Phường Kim Mã, Quận Ba Đình, Hà Nội");
    expect(formatVnAddress({ road: "Khương Trung", suburb: "Phường Khương Trung", county: "Quận Thanh Xuân", city: "Hà Nội" }))
      .toBe("Khương Trung, Phường Khương Trung, Quận Thanh Xuân, Hà Nội");
  });
  it("thiếu thành phần thì dùng display_name, bỏ mã bưu điện và tên nước", () => {
    expect(formatVnAddress({ city: "Hà Nội" }, "Ngõ 5, Kim Mã, Ba Đình, Hà Nội, 11112, Việt Nam")).toBe("Ngõ 5, Kim Mã, Ba Đình, Hà Nội");
    expect(formatVnAddress({})).toBeNull();
  });
  it("tra lỗi trả null, tọa độ sai không gọi dịch vụ, kết quả được nhớ", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ address: { house_number: "3", road: "Lạc Trung", city_district: "Hai Bà Trưng", city: "Hà Nội" } })));
    expect(await reverseGeocode(21.0021, 105.8634, ok as unknown as typeof fetch)).toBe("3 Lạc Trung, Hai Bà Trưng, Hà Nội");
    expect(await reverseGeocode(21.00211, 105.86342, ok as unknown as typeof fetch)).toBe("3 Lạc Trung, Hai Bà Trưng, Hà Nội");
    expect(ok).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => new Response("", { status: 503 }));
    expect(await reverseGeocode(20.9, 105.7, bad as unknown as typeof fetch)).toBeNull();
    expect(await reverseGeocode(Number.NaN, 105.7, bad as unknown as typeof fetch)).toBeNull();
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
