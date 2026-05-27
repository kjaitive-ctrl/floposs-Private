import { NextResponse, type NextRequest } from "next/server";

// admin 의 super_admin 가드는 (admin)/layout.tsx 의 client-side useEffect 만 사용.
// middleware server-side 가드는 supabase 공식 패턴 (cookie 갱신 보존) 정착 후 다시 enable 예정.
// 현재 matcher 비워서 middleware 호출 자체 차단.
export function middleware(_req: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [],
};
