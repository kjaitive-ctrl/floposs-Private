// 외부 주문 포털 전용 레이아웃. RootLayout 의 NavBar 를 가리면서 자체 헤더 패턴 사용.
export default function OrderPortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-white">{children}</div>;
}
