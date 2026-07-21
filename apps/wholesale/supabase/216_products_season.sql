-- ============================================================
-- 216: products.season / season_status — 시즌 관리
--
-- 작성: 2026-07-21
-- 배경: 상품현황(신규 retail 탭) — 상품이 쌓였을 때 시즌오프/재진행 관리.
--   사장 결정 (2026-07-21 회의):
--     1. season = 자유텍스트 태그 (예: "2026SS"). 사람이 입력.
--     2. season_status = active/season_off. 시즌오프 버튼으로 명시적 토글.
--     3. 재진행 = 같은 row 그대로 season/season_status만 갱신 (이력 별도 저장 안 함).
--     4. 시즌오프/재진행은 카페24 연동 상품이면 display 필드까지 같이 PUT
--        (구현은 apps/retail 쪽 — /api/cafe24/display).
--     5. cafe24_display — 카페24 실제 진열상태는 우리 DB에 없어 조회 불가(왕복 API 없이는).
--        PUT 성공 시 낙관적으로 미러링해두는 로컬 캐시 컬럼. 카페24 관리자에서 사람이 직접
--        바꾸면 여기와 어긋날 수 있음(품절 필드와 동일한 class 의 한계, 신규 아님).
-- ============================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS season TEXT,
  ADD COLUMN IF NOT EXISTS season_status TEXT NOT NULL DEFAULT 'active'
    CHECK (season_status IN ('active', 'season_off')),
  ADD COLUMN IF NOT EXISTS cafe24_display BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN products.season IS 'retail: 시즌 태그 자유텍스트 (예: "2026SS"). 사람이 입력, 강제 포맷 없음.';
COMMENT ON COLUMN products.season_status IS 'retail: active/season_off. 시즌오프 버튼으로 토글. 연동 상품이면 cafe24 display 필드도 같이 반영(앱 레이어).';
COMMENT ON COLUMN products.cafe24_display IS 'retail: 카페24 진열상태 로컬 미러(우리가 마지막으로 PUT한 값). 카페24 관리자 직접변경 시 어긋날 수 있음.';

COMMIT;
