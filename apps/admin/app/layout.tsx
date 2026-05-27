import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "플로포스 통합 관리자",
  description: "플로포스 멀티 vertical 관리 콘솔",
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
