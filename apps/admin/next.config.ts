import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 모노레포 — packages/* 의 TS 코드를 Next.js 가 transpile 하도록 명시.
  // 한 곳 변경 = 양쪽 app 자동 반영의 핵심 설정.
  transpilePackages: ["@floposs/ui"],
};

export default nextConfig;
