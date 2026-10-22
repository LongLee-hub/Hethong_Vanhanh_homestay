// Trang máy chủ chỉ được dùng component (tên viết hoa) từ file "use client". Gọi hàm thường từ file đó
// ở máy chủ sẽ lỗi lúc chạy ("Attempted to call … from the server"), typecheck và build đều không bắt được.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const isClient = (src: string) => /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "node_modules" || f.startsWith(".") ? [] : files(p)) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) if (existsSync(base + ext)) return base + ext;
  return null;
}

describe("Ranh giới máy chủ / trình duyệt", () => {
  it("file máy chủ không nhập hàm thường từ file \"use client\"", () => {
    const bad: string[] = [];
    for (const f of [...files(join(ROOT, "app")), ...files(join(ROOT, "components")), ...files(join(ROOT, "lib"))]) {
      const src = readFileSync(f, "utf8");
      if (isClient(src)) continue;
      for (const m of src.matchAll(/import\s+(?!type\b)\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
        const target = resolveImport(f, m[2]);
        if (!target || !isClient(readFileSync(target, "utf8"))) continue;
        for (const name of m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]).filter(Boolean)) {
          if (m[1].includes(`type ${name}`)) continue;
          if (!/^[A-Z]/.test(name)) bad.push(`${f.replace(ROOT + "/", "")}: ${name} từ ${m[2]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
