import { z } from "zod";
import { getDb } from "@/lib/db";
import { unlockSettlement } from "@/lib/services/settlement";
import { api } from "@/lib/server";

export const POST = api(async ({ user, params, req }) => {
  const { reason } = z.object({ reason: z.string().min(1, "Bắt buộc nhập lý do") }).parse(await req.json());
  await unlockSettlement(getDb(), user, params.investorId, params.month, reason);
});
