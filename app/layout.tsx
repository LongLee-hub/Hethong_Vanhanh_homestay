import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "LOCI Homestay Manager", description: "Quản lý vận hành chuỗi homestay LOCI" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700&family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&display=swap" />
      </head>
      <body>{children}</body>
    </html>
  );
}
