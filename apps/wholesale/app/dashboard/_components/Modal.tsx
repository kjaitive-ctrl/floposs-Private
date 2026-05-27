// 옛 위치 — 실제 코드는 packages/ui 로 이전됨 (Day 3, 모노레포 정공법).
// 옛 import 경로 (`@/app/dashboard/_components/Modal` 또는 `./Modal`) 호환 위한 re-export.
// dashboard 6개 컴포넌트의 import 경로는 그대로 사용 가능 → wholesale 회귀 위험 0.
// 향후 사용처 정리 시점에 packages/ui 직접 import 으로 변경 권장.
export { Modal as default } from "@floposs/ui";
