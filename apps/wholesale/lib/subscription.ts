// 구독 활성 여부 판단.
//   - plan_id 없음 → 구독 없음
//   - expires_at NULL → 무제한 (admin grandfathered)
//   - expires_at < 오늘 → 만료
//   - 그 외 → 활성
export function isSubscriptionActive(
  planId: string | null | undefined,
  expiresAt: string | null | undefined
): boolean {
  if (!planId) return false;
  if (!expiresAt) return true;
  const today = new Date().toISOString().slice(0, 10);
  return expiresAt >= today;
}
