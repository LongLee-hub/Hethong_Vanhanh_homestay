import { NextResponse } from "next/server";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { generateCleaningTasks } from "@/lib/services/tasks";
import { cronAuthorized } from "@/lib/server";

// Sinh việc dọn phòng cho check-out hôm nay và ngày mai.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const today = D.todayVN();
  const created = await generateCleaningTasks(getDb(), today, D.addDays(today, 1));
  return NextResponse.json({ created });
}
