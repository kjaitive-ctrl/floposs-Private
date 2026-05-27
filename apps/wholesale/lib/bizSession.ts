export type BizStatus = "before" | "active";

export function getBizSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("biz_session_id");
}

export function getBizStatus(): BizStatus {
  if (typeof window === "undefined") return "before";
  return localStorage.getItem("biz_status") === "active" ? "active" : "before";
}

export function ensureBizOpen(): boolean {
  if (getBizSessionId()) return true;
  alert("영업개시가 필요합니다.\n\n[영업정산] 메뉴에서 영업개시 후 진행해주세요.");
  return false;
}

export function bizOpen(bizSessionId: string) {
  const now = new Date();
  localStorage.setItem("biz_status", "active");
  localStorage.setItem("biz_start", now.toISOString());
  localStorage.setItem("biz_session_id", bizSessionId);
  window.dispatchEvent(new CustomEvent("bizStatusChange"));
}

export function bizClose() {
  const now = new Date();
  localStorage.setItem("biz_status", "before");
  localStorage.removeItem("biz_start");
  localStorage.removeItem("biz_session_id");
  localStorage.setItem("biz_settlement", now.toISOString());
  window.dispatchEvent(new CustomEvent("bizStatusChange"));
}

// 로그아웃/계정 전환 시 — 다른 tenant 의 세션이 새어나오지 않도록 모든 키 제거.
// bizClose 와 달리 biz_settlement(이전 정산 시각 표시) 도 지운다.
export function bizReset() {
  if (typeof window === "undefined") return;
  localStorage.removeItem("biz_status");
  localStorage.removeItem("biz_start");
  localStorage.removeItem("biz_session_id");
  localStorage.removeItem("biz_settlement");
  window.dispatchEvent(new CustomEvent("bizStatusChange"));
}

// DB 의 활성 biz_session 1건과 localStorage 를 동기화한다.
// row 가 있으면 active 로 채우고, 없으면 reset(다른 tenant 의 잔재 제거).
export function bizSyncFromRow(row: { id: string; opened_at: string } | null) {
  if (typeof window === "undefined") return;
  if (row) {
    localStorage.setItem("biz_status", "active");
    localStorage.setItem("biz_start", row.opened_at);
    localStorage.setItem("biz_session_id", row.id);
  } else {
    localStorage.removeItem("biz_status");
    localStorage.removeItem("biz_start");
    localStorage.removeItem("biz_session_id");
  }
  window.dispatchEvent(new CustomEvent("bizStatusChange"));
}
