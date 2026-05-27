import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import type { Role } from "./menuVisibility";

// Server Components / Route Handlers 에서 사용
export async function getServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(toSet) {
          try {
            toSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // RSC 안에서는 set 불가 — middleware/route handler 에서만 동작
          }
        },
      },
    }
  );
}

export type SessionInfo = {
  userId: string;
  email: string;
  role: Role | null;
  tenantId: string | null;
};

export async function getSessionInfo(): Promise<SessionInfo | null> {
  const supabase = await getServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const meta = (user.app_metadata ?? {}) as { role?: string; tenant_id?: string };
  return {
    userId: user.id,
    email: user.email ?? "",
    role: (meta.role as Role | undefined) ?? null,
    tenantId: meta.tenant_id ?? null,
  };
}
