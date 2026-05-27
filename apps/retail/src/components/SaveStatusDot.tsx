import type { SaveStatus } from "@/lib/samplesUtils";

// 행 자동저장 상태 표시 dot.
// /samples + /products 양쪽에서 사용. 두 페이지의 renderDot 동일 로직 추출 (2026-05-26).
//
// saving = 회색 + pulse, saved = 초록, error = 빨강, idle = 회색 (또는 hideWhenIdle 시 투명).
// hideWhenIdle = /samples 의 draft 행 (아직 INSERT 안 됨) 용. 그 외엔 항상 idle dot 표시.

interface Props {
  status?: SaveStatus;     // undefined = idle
  hideWhenIdle?: boolean;
}

export default function SaveStatusDot({ status, hideWhenIdle }: Props) {
  const base = "inline-block w-2.5 h-2.5 rounded-full";
  if (status === "saving") return <span className={`${base} bg-gray-400 animate-pulse`} title="저장 중" />;
  if (status === "saved")  return <span className={`${base} bg-green-500`} title="저장됨" />;
  if (status === "error")  return <span className={`${base} bg-red-500`} title="저장 실패" />;
  return <span className={`${base} ${hideWhenIdle ? "bg-transparent" : "bg-gray-200"}`} />;
}
