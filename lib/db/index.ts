import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

export { schema };
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

let _db: DB | undefined;

/** Kết nối dùng chung cho ứng dụng. Test truyền DB riêng (PGlite) vào các service. */
export function getDb(): DB {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Thiếu DATABASE_URL");
    const client = postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 5), prepare: false });
    _db = drizzle(client, { schema }) as unknown as DB;
  }
  return _db;
}
