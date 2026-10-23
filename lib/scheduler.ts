// Hẹn giờ ngay trong app, dùng khi chạy trên server riêng (không có Vercel Cron).
// Mặc định 30 phút/lần; đổi bằng AUTO_SYNC_MINUTES trong .env (0 = tắt). Trên Vercel không chạy, dùng vercel.json.
// Riêng email payout Gmail chỉ đọc một lần mỗi ngày lúc PAYOUT_HOUR_VN.
import * as D from "./domain";
import { getDb } from "./db";
import { syncBookings } from "./dayladau/sync";
import { computeAlerts } from "./services/alerts";
import { generateCleaningTasks } from "./services/tasks";
import { syncPayouts } from "./airbnb/payouts";

export const PAYOUT_HOUR_VN = 15;
const VN_OFFSET_MS = 7 * 3600_000;

const g = globalThis as unknown as { _autoSync?: { timer: NodeJS.Timeout; running: boolean }; _payoutSync?: { timer: NodeJS.Timeout } };

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

/** Số ms tới lần PAYOUT_HOUR_VN:00 giờ VN kế tiếp. */
export function msUntilPayoutRun(now = Date.now()): number {
  const vn = new Date(now + VN_OFFSET_MS);
  let next = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate(), PAYOUT_HOUR_VN) - VN_OFFSET_MS;
  if (next <= now) next += 86400_000;
  return next - now;
}

function schedulePayouts() {
  g._payoutSync = {
    timer: setTimeout(async () => {
      try {
        const payouts = await syncPayouts(getDb());
        console.log(`[payout-sync] ${new Date().toISOString()}`, payouts);
      } catch (e) {
        console.error("[payout-sync] lỗi:", (e as Error).message);
      } finally {
        schedulePayouts();
      }
    }, msUntilPayoutRun()),
  };
}

export function startScheduler() {
  if (process.env.VERCEL) return; // serverless: không giữ được hẹn giờ, đã có Vercel Cron
  if (!g._payoutSync) {
    schedulePayouts();
    console.log(`[payout-sync] bật: ${PAYOUT_HOUR_VN}:00 hằng ngày`);
  }
  const minutes = Number(process.env.AUTO_SYNC_MINUTES ?? 30);
  if (!(minutes > 0) || g._autoSync) return;
  g._autoSync = { timer: setInterval(tick, minutes * 60_000), running: false };
  console.log(`[auto-sync] bật: ${minutes} phút/lần`);
  void tick();
}
