import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "도매 POS",
  description: "의류 도매업체 POS 시스템",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" className="h-full">
      <body className="min-h-full flex flex-col bg-gray-50 font-sans">{children}</body>
    </html>
  );
}
