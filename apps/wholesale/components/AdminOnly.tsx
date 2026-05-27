"use client";

import type { ReactNode } from "react";
import { useAccount } from "@/lib/useAccount";
import { canAccessMenu, type Role } from "@/lib/menuVisibility";

// 사장 전용 정보/액션을 감싸는 컴포넌트
// 매장 계정에서는 fallback (기본 null) 노출
export function AdminOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { isAdmin, loading } = useAccount();
  if (loading) return null;
  return <>{isAdmin ? children : fallback}</>;
}

// 특정 role 들에만 노출
export function RoleGate({
  roles,
  children,
  fallback = null,
}: {
  roles: Role[];
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { role, loading } = useAccount();
  if (loading) return null;
  return <>{role && roles.includes(role) ? children : fallback}</>;
}

// menuKey 기반 게이트 (menuVisibility 와 동일 정의 사용)
export function MenuGate({
  menuKey,
  children,
  fallback = null,
}: {
  menuKey: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { role, loading } = useAccount();
  if (loading) return null;
  return <>{canAccessMenu(role, menuKey) ? children : fallback}</>;
}
