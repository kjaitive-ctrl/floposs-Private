import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { canAccessMenu, pathToMenuKey, type Role } from "@/lib/menuVisibility";

// Edge runtime — 매 요청 JWT 검증 (DB 호출 0)
// app_metadata.role 만 읽어서 라우팅 가드. 1000업체 SaaS 가도 부하 없음.
// (Next.js 16: middleware → proxy 로 이름 변경)
export async function proxy(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: "sb-wholesale-auth" },
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(toSet) {
          toSet.forEach(({ name, value }) => req.cookies.set(name, value));
          toSet.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    }
  );

  // getUser() 는 access_token 검증 (서명만 검사, DB 호출 0)
  const { data: { user } } = await supabase.auth.getUser();

  // 미인증 → /login (refresh 도 자동 시도됨)
  if (!user) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("redirect", req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }

  const role = ((user.app_metadata ?? {}) as { role?: Role }).role ?? null;

  // (admin 분리 — 모노레포) /admin/* 라우트는 별도 admin 사이트로 이전됨.
  // super_admin 은 loginRedirect 에서 ADMIN_SITE_URL 로 cross-domain 이동.

  // /dashboard/* 가드
  const menuKey = pathToMenuKey(req.nextUrl.pathname);

  // role 미설정 (백필 안 된 기존 사장 계정) → 단일 계정 호환 모드: 전체 통과
  // 백필 후엔 자동으로 정상 권한 분기 동작
  if (!role) return res;

  if (menuKey && !canAccessMenu(role, menuKey)) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
