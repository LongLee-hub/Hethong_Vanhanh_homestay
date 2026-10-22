import type { MetadataRoute } from "next";

// Cho phép "Thêm vào màn hình chính": mở toàn màn hình như app, biểu tượng baocaodau.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "baocaodau.com",
    short_name: "baocaodau",
    description: "Báo cáo vận hành và quyết toán homestay",
    lang: "vi",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f3f6f6",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
