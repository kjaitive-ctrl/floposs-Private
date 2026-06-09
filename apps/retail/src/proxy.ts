import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Next.js 16: middleware → proxy. 함수명도 proxy().
// 보호 경로(로그인 필요)를 서버에서 인증 가드 → 미로그인은 렌더 전에 redirect.
//   → 메인 페이지 셸/로딩 깜빡임 없음 (클라 getUser 의존 X). 데이터 fetch 는 그대로 브라우저 직통.
//   /order/* → /order 로, 그 외 메인(/samples 등) → /login 로 redirect.
// 공개 경로는 matcher 에서 제외 (/login·/signup·/s/*·/impersonate·/ 루트).
//   /order, /order/signup 은 matcher 에 잡히지만 비로그인 진입점이라 아래에서 면제.
export async function proxy(req: NextRequest) {
  const res = NextResponse.next();
  const path = req.nextUrl.pathname;

  // 비로그인 진입점 (외부 주문 포털 로그인/가입) — 면제
  if (path === "/order" || path === "/order/signup") return res;

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: "sb-retail-auth" },
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(toSet) {
          toSet.forEach(({ name, value }) => req.cookies.set(name, value));
          toSet.forEach(({ name, value, options }) =>
            res.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const url = req.nextUrl.clone();
    // /order 영역은 외부포털 진입점(/order)으로, 그 외 메인은 /login 으로.
    url.pathname = path.startsWith("/order") ? "/order" : "/login";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: [
    "/order/:path*",
    "/samples/:path*",
    "/products/:path*",
    "/routines/:path*",
    "/dashboard/:path*",
  ],
};
