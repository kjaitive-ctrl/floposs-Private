"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { styles } from "@/common/styles";
import { useTenant } from "@/lib/TenantContext";

const LINKS: { href: string; label: string }[] = [
  { href: "/samples", label: "샘플" },
  { href: "/products", label: "내 상품" },
  { href: "/product-status", label: "상품현황" },
  { href: "/routines", label: "업무루틴" },
  // TEST 전용 — dev 서버에서만 노출. production 빌드 시 NODE_ENV='production' 으로 자동 숨김.
  // 라벨에 "COMMIT 안 함" 명시 — 사장 규칙([[test-menu-no-commit]]).
  // 발주(DEV) = 외부주문포털(안건3). dev 작업/테스트용 — Vercel(prod+preview) 빌드는 NODE_ENV=production 이라 숨김.
  //   C4(전자노트 박제) 완료 후 게이트 해제해 정식 노출.
  ...(process.env.NODE_ENV !== "production"
    ? [
        { href: "/sku-test", label: "SKU (TEST · COMMIT 안 함)" },
        { href: "/order/browse", label: "발주 (DEV)" },
      ]
    : []),
];

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();
  // NavBar 는 TenantContext 의 공유값 사용 — 자체 fetch 없음 (한 페이지 진입 시 me 1번만 호출)
  const { tenant } = useTenant();

  // 포털 로그인/회원가입(로그인 前)은 NavBar 숨김.
  // 발주 내부 페이지(/order/browse·/me·/complete)는 리테일 셸로 통합 → NavBar 노출 (안건3 C1-B).
  if (pathname === "/order" || pathname === "/order/signup") return null;
  if (pathname === "/login" || pathname === "/signup") return null;
  if (pathname === "/subscription-required") return null;
  if (pathname.startsWith("/s/")) return null;  // 전자노트 공개 보드 (도매용, 로그인 X)

  async function handleLogout() {
    await fetch("/api/order-portal/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <nav className={styles.nav + " sticky top-0 z-40 bg-white"}>
      <Link href="/dashboard" className={styles.navBrand}>FLO</Link>
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
