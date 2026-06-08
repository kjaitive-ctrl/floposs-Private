import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import NavBar from "@/components/NavBar";
import Footer from "@/components/Footer";
import ImpersonationBanner from "@/components/ImpersonationBanner";
import { TenantProvider } from "@/lib/TenantContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Retail Site",
  description: "소매업체 B2B 쇼핑몰",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased bg-white`}
      style={{ colorScheme: "light" }}
    >
      <body className="min-h-full flex flex-col bg-white">
        <TenantProvider>
          <ImpersonationBanner />
          <NavBar />
          <div className="flex-1">{children}</div>
          <Footer />
        </TenantProvider>
      </body>
    </html>
  );
}
