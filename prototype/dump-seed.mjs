import { build } from "esbuild";
import { writeFileSync, mkdirSync, rmSync } from "fs";
const r = await build({ entryPoints: ["prototype/seed.ts"], bundle: true, format: "esm", platform: "node", write: false });
const mod = await import("data:text/javascript;base64," + Buffer.from(r.outputFiles[0].text).toString("base64"));
const data = mod.makeSampleData("2026-09-30");
const out = process.argv[2];
rmSync(out, { recursive: true, force: true });
const writes = [];
for (const [coll, docs] of Object.entries(data)) for (const d of docs) {
  const { id, ...rest } = d;
  mkdirSync(`${out}/${coll}`, { recursive: true });
  const p = `${out}/${coll}/${id}.json`;
  writeFileSync(p, JSON.stringify(rest));
  writes.push({ op: "set", collection: coll, doc_id: id, file_path: p });
}
writeFileSync(`${out}/writes.json`, JSON.stringify(writes));
console.log(writes.length, Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])));
