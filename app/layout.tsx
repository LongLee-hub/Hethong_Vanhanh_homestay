import type { Metadata, Viewport } from "next";
import { RegisterSW } from "@/components/RegisterSW";
import "./globals.css";

export const metadata: Metadata = {
  title: "LOCI Homestay Manager",
  description: "Quản lý vận hành chuỗi homestay LOCI",
  applicationName: "LOCI",
  appleWebApp: { capable: true, title: "LOCI", statusBarStyle: "default" },
  icons: { icon: "/icons/favicon-32.png", apple: "/icons/apple-touch-icon.png" },
  formatDetection: { telephone: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#ffffff" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
      </head>
      <body>
        {children}
        <RegisterSW />
      </body>
    </html>
  );
}
