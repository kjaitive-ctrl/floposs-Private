// route handler 에서 본인 session 읽을 때 사용 (cookies 기반).
// Next 16 + @supabase/ssr 패턴.
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

export async function getSupabaseRouteClient() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookieOptions: { name: "sb-retail-auth" },
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(toSet) {
          for (const { name, value, options } of toSet) {
            try {
              cookieStore.set(name, value, options);
            } catch {
              // RSC 환경에서 set 호출 시 throw — refresh 토큰 갱신 시도 무시
            }
          }
        },
      },
    }
  );
}
