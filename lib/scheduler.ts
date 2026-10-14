// Hẹn giờ ngay trong app, dùng khi chạy trên server riêng (không có Vercel Cron).
// Mặc định 30 phút/lần; đổi bằng AUTO_SYNC_MINUTES trong .env (0 = tắt). Trên Vercel không chạy, dùng vercel.json.
import * as D from "./domain";
import { getDb } from "./db";
import { syncBookings } from "./dayladau/sync";
import { computeAlerts } from "./services/alerts";
import { generateCleaningTasks } from "./services/tasks";

const g = globalThis as unknown as { _autoSync?: { timer: NodeJS.Timeout; running: boolean } };

async function tick() {
  const state = g._autoSync;
  if (!state || state.running) return; // lần trước chưa xong thì bỏ qua lần này
  state.running = true;
  try {
    const db = getDb();
    const sync = await syncBookings(db);
    const alerts = await computeAlerts(db);
    const today = D.todayVN();
    const cleaning = await generateCleaningTasks(db, today, D.addDays(today, 1));
    console.log(`[auto-sync] ${new Date().toISOString()}`, { sync, alerts, cleaning });
  } catch (e) {
    console.error("[auto-sync] lỗi:", (e as Error).message);
  } finally {
    state.running = false;
  }
}

export function startScheduler() {
  if (process.env.VERCEL) return; // serverless: không giữ được hẹn giờ, đã có Vercel Cron
  const minutes = Number(process.env.AUTO_SYNC_MINUTES ?? 30);
  if (!(minutes > 0) || g._autoSync) return;
  g._autoSync = { timer: setInterval(tick, minutes * 60_000), running: false };
  console.log(`[auto-sync] bật: ${minutes} phút/lần`);
  void tick();
}
