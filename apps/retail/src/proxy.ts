import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Next.js 16: middleware → proxy. 함수명도 proxy().
// /order/* 영역만 Supabase session 검증 + redirect.
// /order, /order/signup 은 비로그인 진입점 → 면제.
export async function proxy(req: NextRequest) {
  const res = NextResponse.next();
  const path = req.nextUrl.pathname;

  // 비로그인 진입점
  const publicOrderPaths = new Set(["/order", "/order/signup"]);
  if (publicOrderPaths.has(path)) return res;

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
    url.pathname = "/order";
    url.searchParams.set("redirect", path);
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/order/:path*"],
};
