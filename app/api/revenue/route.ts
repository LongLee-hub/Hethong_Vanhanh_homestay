// API tổng hợp doanh thu theo phòng/cơ sở/chủ đầu tư.
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/auth/access";
import { roomRevenueByDay, propertyRevenueByMonth, investorRevenueByMonth } from "@/lib/queries";
import { api } from "@/lib/server";

// GET /api/revenue?scope=room&propertyId=xxx&month=2026-10
// GET /api/revenue?scope=property&month=2026-10
// GET /api/revenue?scope=investor&month=2026-10
export const GET = api(async ({ user, req }) => {
  requirePermission(user, "viewFinance");
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") ?? "property";
  const month = url.searchParams.get("month") ?? D.monthOf(D.todayVN());
  const db = getDb();

  switch (scope) {
    case "room": {
      const propertyId = url.searchParams.get("propertyId");
      if (!propertyId) return { error: "Thiếu propertyId khi scope=room" };
      return { scope, month, data: await roomRevenueByDay(db, user, propertyId, month) };
    }
    case "property":
      return { scope, month, data: await propertyRevenueByMonth(db, user, month) };
    case "investor":
      return { scope, month, data: await investorRevenueByMonth(db, user, month) };
    default:
      return { error: "scope không hợp lệ. Dùng: room, property, investor" };
  }
});
