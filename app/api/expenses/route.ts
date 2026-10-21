import { z } from "zod";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/auth/access";
import { createExpense, listExpenses } from "@/lib/services/expenses";
import { api, appBaseUrl } from "@/lib/server";
import { notifyPendingExpenses } from "@/lib/services/expense-notify";

export const GET = api(async ({ user, req }) => {
  requirePermission(user, "viewFinance");
  const month = new URL(req.url).searchParams.get("month") ?? D.monthOf(D.todayVN());
  return listExpenses(getDb(), user, month);
});

const Body = z.object({
  propertyId: z.string().nullable(),
  categoryId: z.string(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  incurredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().int().positive(),
  description: z.string().min(1),
  receiptUrls: z.array(z.string()).optional(),
  taskId: z.string().nullable().optional(),
});

// Kê khai qua API cũng đi qua bước chủ đầu tư duyệt và gửi nhắc duyệt như trên web
export const POST = api(async ({ user, req }) => {
  const e = await createExpense(getDb(), user, Body.parse(await req.json()));
  if (e.approvalStatus === "PENDING") await notifyPendingExpenses(getDb(), [e.id], await appBaseUrl()).catch((err) => console.error(err));
  return e;
});
