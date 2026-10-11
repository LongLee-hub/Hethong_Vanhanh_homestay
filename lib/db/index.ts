import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema";

export { schema };
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const globalForDb = globalThis as unknown as {
  _db?: DB;
  _client?: postgres.Sql;
};

/** Kết nối dùng chung cho ứng dụng. Test truyền DB riêng (PGlite) vào các service. */
export function getDb(): DB {
  if (!globalForDb._db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Thiếu DATABASE_URL");
    const client = globalForDb._client ?? postgres(url, { max: Number(process.env.DB_POOL_MAX ?? 10), prepare: false });
    globalForDb._client = client;
    globalForDb._db = drizzle(client, { schema }) as unknown as DB;
  }
  return globalForDb._db;
}
