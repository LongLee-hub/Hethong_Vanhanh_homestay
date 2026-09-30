import { z } from "zod";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/auth/access";
import { createExpense, listExpenses } from "@/lib/services/expenses";
import { api } from "@/lib/server";

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
  paymentStatus: z.enum(["UNPAID", "PAID"]).optional(),
  receiptUrls: z.array(z.string()).optional(),
  taskId: z.string().nullable().optional(),
});

export const POST = api(async ({ user, req }) => createExpense(getDb(), user, Body.parse(await req.json())));
