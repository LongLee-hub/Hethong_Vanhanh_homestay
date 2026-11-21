// Đổi tọa độ GPS thành địa chỉ đọc được (số nhà, đường, phường, quận) để in lên ảnh chấm công.
// Dùng Nominatim (OpenStreetMap): miễn phí, không cần khóa; gọi từ máy chủ để gắn User-Agent theo quy định của họ
// và giữ bộ nhớ đệm, vì nhân viên đứng một chỗ thì tọa độ gần như không đổi giữa các lần chụp.

export type OsmAddress = Partial<Record<
  "house_number" | "road" | "neighbourhood" | "quarter" | "suburb" | "village" | "city_district" | "county" | "district" | "town" | "city" | "state",
  string
>>;

/** Ghép địa chỉ ngắn kiểu Việt Nam: "12 Vạn Phúc, Phường Kim Mã, Quận Ba Đình, Hà Nội". */
export function formatVnAddress(a: OsmAddress, displayName?: string): string | null {
  const street = [a.house_number, a.road].filter(Boolean).join(" ");
  const parts = [
    street,
    a.quarter ?? a.suburb ?? a.neighbourhood ?? a.village,
    a.city_district ?? a.county ?? a.district ?? a.town,
    a.city ?? a.state,
  ].filter((x): x is string => !!x && !!x.trim());
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  if (uniq.length >= 2) return uniq.join(", ");
  if (!displayName) return uniq[0] ?? null;
  // Không đủ thành phần thì lấy display_name, bỏ mã bưu điện và tên nước ở cuối
  return displayName.split(",").map((s) => s.trim()).filter((s) => s && !/^\d{5,6}$/.test(s) && s !== "Việt Nam" && s !== "Vietnam").join(", ") || null;
}

const cache = new Map<string, { at: number; address: string | null }>();
const TTL = 7 * 24 * 3600_000;

/** Tra địa chỉ cho tọa độ. Trả null nếu không tra được (mất mạng, dịch vụ lỗi) để ảnh vẫn chụp được. */
export async function reverseGeocode(lat: number, lng: number, fetchFn: typeof fetch = fetch): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // Làm tròn ~10 m: các lần chụp trong cùng một nhà dùng chung kết quả
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.address;
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=vi&lat=${lat}&lon=${lng}`;
  try {
    const res = await fetchFn(url, { headers: { "User-Agent": "baocaodau.com cham-cong (LOCI homestay)" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { address?: OsmAddress; display_name?: string };
    const address = formatVnAddress(j.address ?? {}, j.display_name);
    cache.set(key, { at: Date.now(), address });
    if (cache.size > 2000) cache.delete(cache.keys().next().value!);
    return address;
  } catch {
    return null;
  }
}
