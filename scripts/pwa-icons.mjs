// Sinh biểu tượng cài app (PWA) vào public/icons từ logo baocaodau. Chạy lại khi đổi logo: node scripts/pwa-icons.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { createElement as h } from "react";
import { ImageResponse } from "next/og.js";

const BRAND = "#2e9c92";

// Nền xanh phủ kín ô vuông để Android cắt theo hình tròn/bo góc (maskable) và iOS tự bo góc;
// tờ báo cáo nằm trong vùng an toàn ở giữa. Ở cỡ favicon nét dày hơn cho dễ nhìn.
function svg(size) {
  const small = size <= 48;
  const sw = small ? 5.5 : 3.8;
  const cw = small ? 3.8 : 3.5;
  // Icon đầy đủ (không favicon): thu nét vẽ về 78% để không bị cắt khi Android bo tròn.
  const t = small ? "" : ' transform="translate(7.04 7.04) scale(.78)"';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64">`
    + `<rect width="64" height="64" fill="${BRAND}"/>`
    + `<g${t} fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">`
    + `<path stroke-width="${sw}" d="M18 38 V14 H32 L45 27 V38 A12 12 0 0 1 33 50 H24 M32 14 V27 H45 M25 34 H37 M25 42 H32"/>`
    + `<circle cx="18" cy="50" r="3.6" stroke-width="${cw}"/></g></svg>`;
}

const out = new URL("../public/icons/", import.meta.url);
await mkdir(out, { recursive: true });
for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["apple-touch-icon.png", 180], ["favicon-32.png", 32]]) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg(size)).toString("base64")}`;
  const el = h("div", { style: { width: size, height: size, display: "flex" } }, h("img", { src, width: size, height: size }));
  const png = Buffer.from(await new ImageResponse(el, { width: size, height: size }).arrayBuffer());
  await writeFile(new URL(name, out), png);
  console.log(name, png.length, "bytes");
}
