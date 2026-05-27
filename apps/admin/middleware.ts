import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// admin app 의 super_admin 가드.
// /login 외의 모든 페이지 접근 시:
//   - 비로그인 → /login redirect
//   - 로그인했으나 super_admin 아님 → /login redirect (layout 의 client-side 가드도 추가 보조)
// cookie 이름은 lib/supabase.ts 와 동일 (sb-admin-auth) — wholesale/retail 과 격리.
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login")) return NextResponse.next();
  if (pathname.startsWith("/_next")) return NextResponse.next();
  if (pathname.startsWith("/api/auth")) return NextResponse.next();

  const res = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (cookies) => cookies.forEach(({ name, value, options }) => res.cookies.set(name, value, options)),
      },
      cookieOptions: { name: "sb-admin-auth" },
    }
  );

  const { data: { user } } = await supabase.auth.getUser();
  const role = (user?.app_metadata as { role?: string } | undefined)?.role;

  if (!user || role !== "super_admin") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
