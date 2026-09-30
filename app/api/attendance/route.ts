import { z } from "zod";
import { getDb } from "@/lib/db";
import { clockIn, clockOut } from "@/lib/services/tasks";
import { api } from "@/lib/server";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("in"), propertyId: z.string(), photoUrl: z.string().optional() }),
  z.object({ action: z.literal("out") }),
]);

export const POST = api(async ({ user, req }) => {
  const b = Body.parse(await req.json());
  return b.action === "in" ? clockIn(getDb(), user, b.propertyId, b.photoUrl) : clockOut(getDb(), user);
});
