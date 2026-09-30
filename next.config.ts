import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["postgres"],
  experimental: { serverActions: { bodySizeLimit: "10mb" } }, // ảnh hóa đơn / nghiệm thu
};

export default config;
