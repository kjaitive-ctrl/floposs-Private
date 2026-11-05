import { redirect } from "next/navigation";

// 일정은 대시보드로 이동 (2026-11-05). 옛 주소로 들어와도 찾을 수 있게 유지.
export default function RoutinesPage() {
  redirect("/dashboard");
}
