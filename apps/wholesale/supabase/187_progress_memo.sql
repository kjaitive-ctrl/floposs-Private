-- ============================================================
-- 187: retail Phase I — 진행 단계 메모 컬럼
--
-- 작성: 2026-05-25
-- 사장 결정 (2026-05-25 회의):
--   /products 메모를 2 row 로 분리.
--     위 줄 "메모(진행)" = /products 측 박제 (정식 등록 후 메모)
--     아래 줄 "메모(샘플)" = /samples 측 박제 (samples 단계 메모, 기존 description)
--   두 메모는 별개 박제축. samples 측 description 은 박제 그대로.
--
-- 본 마이그
--   products ALTER 1 컬럼
--     progress_memo TEXT — /products 진행 단계 메모. description 과 별도.
--
-- 영향 매트릭스
--   - 기존 row: progress_memo NULL → SELECT 영향 0
--   - /samples: description 박제 그대로
--   - /products: progress_memo 박제 (위 줄), description read-only (아래 줄)
--
-- 관련 마이그
--   - 186 (consumer 컬럼 4개)
--
-- 멱등 + BEGIN/COMMIT
-- ============================================================

BEGIN;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS progress_memo TEXT;

COMMENT ON COLUMN products.progress_memo IS 'retail 박제: /products 진행 단계 메모. samples 단계 description (samples 메모) 와 별도. 사장 결정 (2026-05-25).';

DO $$
DECLARE
  v_total INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM products;
  RAISE NOTICE '[187] progress_memo 컬럼 박힘. products 전체 % rows.', v_total;
END $$;

COMMIT;
