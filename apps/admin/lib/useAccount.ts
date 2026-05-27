"use client";

import { useEffect, useState } from "react";
import { supabase } from "./supabase";
import { isAdminRole, type Role } from "./menuVisibility";

export type AccountInfo = {
  userId: string;
  email: string;
  role: Role | null;
  tenantId: string | null;
};

export function useAccount() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    function setFromSession(session: { user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> } } | null) {
      if (!mounted) return;
      if (!session?.user) {
        setAccount(null);
        setLoading(false);
        return;
      }
      const meta = (session.user.app_metadata ?? {}) as { role?: string; tenant_id?: string };
      setAccount({
        userId: session.user.id,
        email: session.user.email ?? "",
        role: (meta.role as Role | undefined) ?? null,
        tenantId: meta.tenant_id ?? null,
      });
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data: { session } }) => setFromSession(session));

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setFromSession(session));

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return {
    account,
    loading,
    role: account?.role ?? null,
    tenantId: account?.tenantId ?? null,
    isAdmin: isAdminRole(account?.role),
    isStaff: account?.role === "staff",
  };
}
