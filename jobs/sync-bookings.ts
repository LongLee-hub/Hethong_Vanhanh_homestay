// Chạy tay: npm run job:sync  (trên Vercel dùng /api/cron/sync)
import { getDb } from "../lib/db";
import { syncBookings } from "../lib/dayladau/sync";
import { computeAlerts } from "../lib/services/alerts";

const db = getDb();
syncBookings(db)
  .then(async (s) => { console.log("Đồng bộ:", s); console.log("Cảnh báo:", await computeAlerts(db)); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
