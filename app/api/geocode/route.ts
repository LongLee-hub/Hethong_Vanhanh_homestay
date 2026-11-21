// GET /api/geocode?lat=…&lng=… — địa chỉ của vị trí hiện tại, dùng để in lên ảnh chấm công.
import { api } from "@/lib/server";
import { reverseGeocode } from "@/lib/services/geocode";

export const GET = api(async ({ req }) => {
  const q = new URL(req.url).searchParams;
  return { address: await reverseGeocode(Number(q.get("lat")), Number(q.get("lng"))) };
});
