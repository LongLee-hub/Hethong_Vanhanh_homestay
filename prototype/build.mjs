import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
const r = await build({ entryPoints: ["prototype/main.ts"], bundle: true, format: "iife", target: "es2020", minify: true, write: false, legalComments: "none", define: { "process.env.DAYLADAU_API_BASE": "undefined" } });
const js = r.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const shell = readFileSync("prototype/shell.html", "utf8");
mkdirSync("dist", { recursive: true });
writeFileSync("dist/loci-homestay.html", shell.replace("/*BUNDLE*/", () => js));
console.log("ok", (js.length / 1024).toFixed(1) + " KB js");
