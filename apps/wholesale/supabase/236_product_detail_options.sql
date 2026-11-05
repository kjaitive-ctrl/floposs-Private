-- ============================================================
-- 236: products.detail_options — 카페24 상세페이지 선택 항목
--
-- 작성: 2026-11-05
-- 배경: 멘트 창 메모 입력란 아래에서 계절감/세탁방법/주의사항을 선택해 상세페이지에 표시.
--   메모(comment_data)와 섞지 않고 별도 저장 — 문구/디자인을 바꿔도 선택값은 유지.
--   형식: { seasons: [], season_note: "", washes: [], cautions: [] }
--   항목 키 목록 = apps/retail/src/lib/detailOptions.ts
-- ============================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS detail_options JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN products.detail_options IS 'retail: 상세페이지 선택 항목. { seasons, season_note, washes, cautions }. 키 목록은 앱 lib/detailOptions.ts.';

COMMIT;
