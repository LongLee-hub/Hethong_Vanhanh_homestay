import { getDb } from "../lib/db";
import { computeAlerts } from "../lib/services/alerts";

computeAlerts(getDb()).then((r) => { console.log(r); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
