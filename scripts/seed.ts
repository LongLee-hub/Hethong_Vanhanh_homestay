// Tạo Admin đầu tiên, danh mục chi phí và cài đặt mặc định. Chạy: npm run db:seed
import { getDb } from "../lib/db";
import { expenseCategories, settings, users } from "../lib/db/schema";
import { hashPassword } from "../lib/auth/session";
import { DEFAULTS } from "../lib/services/settings";

const CATEGORIES: [string, "DIRECT" | "COMMON"][] = [
  ["Thuê nhà", "DIRECT"], ["Điện nước", "DIRECT"], ["Internet", "DIRECT"], ["Vật tư tiêu hao", "DIRECT"], ["Giặt là", "DIRECT"],
  ["Bảo trì", "DIRECT"], ["Thuế", "DIRECT"], ["Lương", "COMMON"], ["Marketing", "COMMON"], ["Phần mềm", "COMMON"],
];
// Loại chi phí báo cáo NĐT tách riêng; thêm cả vào DB đã có sẵn loại chi phí.
const REPORT_CATEGORIES: [string, "DIRECT" | "COMMON"][] = [["BHXH", "DIRECT"], ["Kế toán", "DIRECT"]];

async function main() {
  const db = getDb();
  const email = process.env.ADMIN_EMAIL, password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error("Đặt ADMIN_EMAIL và ADMIN_PASSWORD trong .env");
  await db.insert(users).values({ name: "Admin LOCI", email: email.toLowerCase(), role: "ADMIN", passwordHash: await hashPassword(password) }).onConflictDoNothing();
  if (!(await db.select().from(expenseCategories)).length) await db.insert(expenseCategories).values(CATEGORIES.map(([name, scope]) => ({ name, scope })));
  const have = new Set((await db.select().from(expenseCategories)).map((c) => c.name));
  const missing = REPORT_CATEGORIES.filter(([name]) => !have.has(name));
  if (missing.length) await db.insert(expenseCategories).values(missing.map(([name, scope]) => ({ name, scope })));
  for (const [key, value] of Object.entries(DEFAULTS)) await db.insert(settings).values({ key, value }).onConflictDoNothing();
  console.log("Đã tạo Admin", email);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
