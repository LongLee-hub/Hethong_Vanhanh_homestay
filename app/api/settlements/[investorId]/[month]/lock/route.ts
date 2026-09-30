import { getDb } from "@/lib/db";
import { lockSettlement } from "@/lib/services/settlement";
import { api } from "@/lib/server";

export const POST = api(async ({ user, params }) => lockSettlement(getDb(), user, params.investorId, params.month));
