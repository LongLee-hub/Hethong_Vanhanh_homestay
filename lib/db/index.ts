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
    const max = Number(process.env.DB_POOL_MAX ?? 10);
    const client = globalForDb._client ?? postgres(url, { max, prepare: false });
    globalForDb._client = client;
    globalForDb._db = drizzle(limitConcurrency(client, max), { schema }) as unknown as DB;
  }
  return globalForDb._db;
}

/**
 * Giữ số câu truy vấn chạy cùng lúc không quá số kết nối, để mỗi câu có một kết nối rảnh riêng.
 * Cổng pooler 6543 của Supabase (transaction mode) bị treo khi postgres-js xếp câu thứ hai vào kết nối đang bận,
 * điều này xảy ra khi trang đọc nhiều câu song song (Promise.all).
 */
function limitConcurrency(client: postgres.Sql, max: number): postgres.Sql {
  let active = 0;
  const waiting: (() => void)[] = [];
  const acquire = () => (active < max ? (active++, Promise.resolve()) : new Promise<void>((r) => waiting.push(r)));
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };
  const run = async <T>(f: () => PromiseLike<T>): Promise<T> => {
    await acquire();
    try {
      return await f();
    } finally {
      release();
    }
  };
  return new Proxy(client, {
    get(target, key, receiver) {
      if (key === "unsafe") {
        // drizzle gọi client.unsafe(q, p) rồi await, hoặc gọi tiếp .values(); câu chỉ chạy khi có kết nối rảnh
        return (...args: Parameters<postgres.Sql["unsafe"]>) => {
          const pending = () => target.unsafe(...args);
          return {
            values: () => run(() => pending().values()),
            then: <A, B>(ok?: (v: unknown) => A, fail?: (e: unknown) => B) => run(() => pending()).then(ok, fail),
          };
        };
      }
      // Transaction giữ một kết nối suốt thời gian chạy; câu bên trong dùng kết nối của transaction
      if (key === "begin") return (...args: unknown[]) => run(() => (target.begin as (...a: unknown[]) => Promise<unknown>)(...args));
      return Reflect.get(target, key, receiver);
    },
  });
}
