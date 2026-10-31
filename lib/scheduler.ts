// Hẹn giờ ngay trong app, dùng khi chạy trên server riêng (không có Vercel Cron).
// Chỉ bật khi đặt AUTO_SYNC_MINUTES > 0 (bản PM2 trên VPS đặt sẵn 30). Mặc định TẮT: một máy khác (máy tính chạy `npm run dev`
// hay `next start` với .env trỏ vào DB thật) mà tự đồng bộ thì khi máy ngủ, kết nối DB treo ~15 phút rồi đứt, ghi lỗi
// "CONNECTION_CLOSED / ECONNRESET" vào hệ thống thật. Trên Vercel không chạy, dùng vercel.json.
// Riêng email payout Gmail chỉ đọc một lần mỗi ngày lúc PAYOUT_HOUR_VN.
import * as D from "./domain";
import { getDb } from "./db";
import { syncBookings } from "./dayladau/sync";
import { syncReviews } from "./dayladau/reviews";
import { sendMonthlyReviewDigest } from "./services/reviews";
import { computeAlerts } from "./services/alerts";
import { generateCleaningTasks } from "./services/tasks";
import { syncPayouts } from "./airbnb/payouts";
import { syncDayladauPayouts } from "./dayladau/payouts";

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
    const reviews = await syncReviews(db).catch((e: Error) => ({ error: e.message }));
    await sendMonthlyReviewDigest(db).catch(() => false);
    const alerts = await computeAlerts(db);
    const today = D.todayVN();
    const cleaning = await generateCleaningTasks(db, today, D.addDays(today, 1));
    console.log(`[auto-sync] ${new Date().toISOString()}`, { sync, reviews, alerts, cleaning });
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
        const dayladau = await syncDayladauPayouts(getDb()).catch((e: Error) => ({ error: e.message }));
        console.log(`[payout-sync] ${new Date().toISOString()}`, { payouts, dayladau });
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
  if (!(Number(process.env.AUTO_SYNC_MINUTES ?? 0) > 0)) {
    console.log("[auto-sync] tắt (AUTO_SYNC_MINUTES chưa đặt): máy này không tự đồng bộ");
    return;
  }
  if (!g._payoutSync) {
    schedulePayouts();
    console.log(`[payout-sync] bật: ${PAYOUT_HOUR_VN}:00 hằng ngày`);
  }
  const minutes = Number(process.env.AUTO_SYNC_MINUTES ?? 0);
  if (!(minutes > 0) || g._autoSync) return;
  g._autoSync = { timer: setInterval(tick, minutes * 60_000), running: false };
  console.log(`[auto-sync] bật: ${minutes} phút/lần`);
  void tick();
}
