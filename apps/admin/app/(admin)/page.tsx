import { redirect } from "next/navigation";

// admin 메인 (/) → 계정관리로 (URL 단순화 후 /accounts).
export default function AdminPage() {
  redirect("/accounts");
}
