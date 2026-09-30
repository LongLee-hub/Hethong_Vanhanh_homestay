import { z } from "zod";
import { getDb } from "@/lib/db";
import { markPaid } from "@/lib/services/expenses";
import { api } from "@/lib/server";

export const POST = api(async ({ user, req }) => ({ updated: await markPaid(getDb(), user, z.object({ ids: z.array(z.string()) }).parse(await req.json()).ids) }));
