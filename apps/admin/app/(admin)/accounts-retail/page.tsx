"use client";

import { AccountsView } from "@/components/AccountsView";

// 소매 계정관리 — retail vertical 고정 (3탭 숨김).
export default function RetailAccountsPage() {
  return <AccountsView lockedVertical="retail" />;
}
