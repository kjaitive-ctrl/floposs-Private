"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";

const LINKS: { href: string; label: string }[] = [
  { href: "/samples", label: "샘플" },
  { href: "/products", label: "내 상품" },
  // TEST 전용 — dev 서버에서만 노출. production 빌드 시 NODE_ENV='production' 으로 자동 숨김.
  // 라벨에 "COMMIT 안 함" 명시 — 사장 규칙([[test-menu-no-commit]]).
  ...(process.env.NODE_ENV !== "production"
    ? [{ href: "/sku-test", label: "SKU (TEST · COMMIT 안 함)" }]
    : []),
];

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();
  // NavBar 는 TenantContext 의 공유값 사용 — 자체 fetch 없음 (한 페이지 진입 시 me 1번만 호출)
  const { tenant } = useTenant();

  // 외부 주문 포털 (v1 자체 흐름) 과 인증 페이지는 NavBar 숨김
  if (pathname.startsWith("/order")) return null;
  if (pathname === "/login" || pathname === "/signup") return null;
  if (pathname === "/subscription-required") return null;

  async function handleLogout() {
    await fetch("/api/order-portal/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <nav className={styles.nav}>
      <span className={styles.navBrand}>RETAIL</span>
      {LINKS.map(link => {
        const active = pathname === link.href || pathname.startsWith(link.href + "/");
        return (
          <Link key={link.href} href={link.href}
            className={active ? styles.navLinkActive : styles.navLink}>
            {link.label}
          </Link>
        );
      })}
      <div className="ml-auto flex items-center gap-3 text-xs">
        {tenant && (
          <span className="text-black font-medium">{tenant.company_name}</span>
        )}
        <Link href="/dashboard/settings" className="px-2 py-1 text-gray-600 hover:text-black border border-gray-200 rounded">
          내정보
        </Link>
        <button onClick={handleLogout}
          className="px-2 py-1 text-gray-600 hover:text-black border border-gray-200 rounded">
          로그아웃
        </button>
      </div>
    </nav>
  );
}
