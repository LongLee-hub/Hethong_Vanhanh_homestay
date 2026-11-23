import { NextResponse } from "next/server";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { generateCleaningTasks } from "@/lib/services/tasks";
import { closePassedCleaningTasks } from "@/lib/services/cleaning";
import { cronAuthorized } from "@/lib/server";

// Đóng việc dọn của ngày trước đã qua lượt, rồi sinh việc dọn phòng cho check-out hôm nay và ngày mai.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const today = D.todayVN();
  const db = getDb();
  const closed = await closePassedCleaningTasks(db, today);
  const created = await generateCleaningTasks(db, today, D.addDays(today, 1));
  return NextResponse.json({ closed, created });
}
