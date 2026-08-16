import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 모노레포 — packages/* 의 TS 코드를 Next.js 가 transpile 하도록 명시.
  // 한 곳 변경 = 양쪽 app 자동 반영의 핵심 설정.
  transpilePackages: ["@floposs/ui"],
  // 네이티브 addon(.node) 을 가진 패키지 — Turbopack 이 번들링 시도하면 깨짐. node_modules 에서 직접 require 하도록 제외.
  serverExternalPackages: ["@resvg/resvg-js"],
  // stamp-image 라우트가 런타임에 fs.readFileSync(process.cwd()+...) 로 폰트 파일을 읽는데,
  // process.cwd() 기반 경로는 @vercel/nft 정적분석이 못 잡아서 프로덕션 번들에서 누락될 수 있음 → 명시 포함.
  outputFileTracingIncludes: {
    "/api/products/stamp-image": ["./src/assets/fonts/**"],
  },
};

export default nextConfig;
