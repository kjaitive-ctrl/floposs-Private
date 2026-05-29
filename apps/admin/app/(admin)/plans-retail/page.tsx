// 소매 전용 구독플랜 — vertical=retail 고정. 탭 숨김.
// admin 의 /plans 는 전체 vertical 관리용. /plans-retail 은 retail 만.
import PlansPage from "../plans/page";

export default function PlansRetailPage() {
  return <PlansPage fixedVertical="retail" />;
}
