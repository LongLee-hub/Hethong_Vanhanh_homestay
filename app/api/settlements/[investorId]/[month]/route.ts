import { getDb } from "@/lib/db";
import { getSettlement } from "@/lib/services/settlement";
import { api } from "@/lib/server";

export const GET = api(async ({ user, params }) => getSettlement(getDb(), user, params.investorId, params.month));
