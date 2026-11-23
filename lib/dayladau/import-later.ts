// Nhập đơn cũ của listing vừa gắn vào phòng, chạy nền sau khi đã trả kết quả cho người dùng (không bắt chờ đọc hết lịch sử).
import { after } from "next/server";
import { getDb } from "../db";
import { importListingOrders } from "./sync";

export function importListingOrdersLater(accountId: string | null | undefined, listingKeys: (string | null | undefined)[]) {
  const keys = listingKeys.filter((k): k is string => !!k);
  if (!accountId || !keys.length) return;
  after(async () => {
    const t0 = Date.now();
    try {
      const r = await importListingOrders(getDb(), accountId, keys);
      console.log(`[listing-import] ${accountId} ${keys.join(",")}: ${r?.created ?? 0} mới, ${r?.updated ?? 0} cập nhật, ${Date.now() - t0}ms`);
      if (r?.errors.length) console.error("[listing-import]", r.errors[0].message);
    } catch (e) {
      console.error("[listing-import]", accountId, keys, (e as Error).message);
    }
  });
}
