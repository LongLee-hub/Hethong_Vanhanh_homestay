/** Kết quả db.execute: postgres-js trả mảng dòng, PGlite (test) trả { rows }. */
export function rowsOf<T>(r: unknown): T[] {
  if (Array.isArray(r)) return r as T[];
  return ((r as { rows?: T[] })?.rows ?? []) as T[];
}
