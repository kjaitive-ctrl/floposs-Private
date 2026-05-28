-- ============================================================
-- 194: MD기능 (멘트 / 촬영) 컬럼 추가 — products + tenants
--
-- 작성: 2026-05-28
-- 사장 결정 (2026-05-28 회의):
--   1. retail "내 상품" 행 1 MD기능 컬럼에 버튼 3개 (멘트 / 촬영 / AI).
--   2. 멘트:
--      - tenant 가 본인의 폼 양식 등록 (예: 원단/착용감/계절감)
--      - 각 상품에 양식대로 입력 (메모장 + 가이드)
--   3. 촬영:
--      - 모델 / 착용옵션(자기 variant) / 촬영날짜(선택) / 코디아이템(다른 상품+옵션)
--   4. AI: 비활성 (Anthropic 연결 보류 — [[ai-credit-system-2026-05-28]]).
--
-- 본 마이그
--   ① tenants.comment_template JSONB — 멘트 폼 라벨 배열
--      예: ["원단","착용감","계절감"]
--   ② products.comment_data JSONB — 라벨별 값 박제
--      예: {"원단":"면 100%","착용감":"슬림","계절감":"봄/가을"}
--   ③ products.shoot_info JSONB — 촬영 정보 묶음
--      예: {model, worn_variant_id, shoot_date, coordinates:[{product_id,variant_id}]}
--
-- 영향 매트릭스
--   - retail products 페이지: MD기능 셀 — [멘트][촬영][AI(비활성)] 3 버튼.
--   - 신규 모달 2개 (CommentModal / ShootModal).
--   - 라벨 rename 시 옛 데이터는 orphan (UI 안 보임) — 데이터 손실 X.
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① tenants.comment_template
-- ─────────────────────────────────────────────────────────
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS comment_template JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN tenants.comment_template IS
  '멘트 폼 양식 라벨 배열. 예: ["원단","착용감","계절감"]. retail products [멘트] 버튼 → CommentModal.';


-- ─────────────────────────────────────────────────────────
-- ② products.comment_data
-- ─────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS comment_data JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN products.comment_data IS
  '상품별 멘트 값. tenant.comment_template 의 라벨을 키로. 예: {"원단":"면","착용감":"슬림"}.';


-- ─────────────────────────────────────────────────────────
-- ③ products.shoot_info
-- ─────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS shoot_info JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN products.shoot_info IS
  '촬영 메타데이터. {model, worn_variant_id, shoot_date, coordinates:[{product_id,variant_id}]}.';


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[194] MD기능 컬럼 박힘. tenants.comment_template / products.comment_data / products.shoot_info.';
END $$;

COMMIT;
