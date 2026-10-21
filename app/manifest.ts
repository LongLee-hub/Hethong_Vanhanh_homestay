import type { MetadataRoute } from "next";

// Cho phép "Thêm vào màn hình chính": mở toàn màn hình như app, biểu tượng LOCI.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "LOCI Homestay Manager",
    short_name: "LOCI",
    description: "Quản lý vận hành chuỗi homestay LOCI",
    lang: "vi",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f7f7f7",
    theme_color: "#ffffff",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
