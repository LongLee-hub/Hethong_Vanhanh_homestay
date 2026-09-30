import { z } from "zod";
import { getDb } from "@/lib/db";
import { setTaskStatus } from "@/lib/services/tasks";
import { api } from "@/lib/server";

export const POST = api(async ({ user, params, req }) => {
  const { status } = z.object({ status: z.enum(["TODO", "IN_PROGRESS", "DONE", "CANCELLED"]) }).parse(await req.json());
  await setTaskStatus(getDb(), user, params.id, status);
});
