// Sinh biểu tượng cài app (PWA) vào public/icons. Chạy lại khi đổi logo: node scripts/pwa-icons.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { createElement as h } from "react";
import { ImageResponse } from "next/og.js";

const ACCENT = "#0e6a5b";

// Nền phủ kín ô vuông để Android cắt theo hình tròn/bo góc (maskable) và iOS tự bo góc.
// Chữ nằm trong vùng an toàn 80% ở giữa.
function icon(size) {
  return h(
    "div",
    { style: { width: size, height: size, background: ACCENT, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "#fff" } },
    h("div", { style: { fontSize: size * 0.24, fontWeight: 700, letterSpacing: size * 0.012, lineHeight: 1 } }, "LOCI"),
    h("div", { style: { width: size * 0.16, height: Math.max(2, size * 0.014), background: "#e2b35c", marginTop: size * 0.06, borderRadius: size } }),
  );
}

const out = new URL("../public/icons/", import.meta.url);
await mkdir(out, { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180], ["favicon-32.png", 32]]) {
  const png = Buffer.from(await new ImageResponse(icon(size), { width: size, height: size }).arrayBuffer());
  await writeFile(new URL(name, out), png);
  console.log(name, png.length, "bytes");
}
