import { z } from "zod";
import { getDb } from "@/lib/db";
import { clockIn, clockOut } from "@/lib/services/tasks";
import { api } from "@/lib/server";

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("in"), propertyId: z.string(), shift: z.enum(["MORNING", "EVENING", "OVERTIME"]).optional(), photoUrl: z.string().optional(),
    lat: z.number().nullish(), lng: z.number().nullish(), accuracyM: z.number().nullish(),
  }),
  z.object({ action: z.literal("out") }),
]);

export const POST = api(async ({ user, req }) => {
  const b = Body.parse(await req.json());
  return b.action === "in" ? clockIn(getDb(), user, b) : clockOut(getDb(), user);
});
