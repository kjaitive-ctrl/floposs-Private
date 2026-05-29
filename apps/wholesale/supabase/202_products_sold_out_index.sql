-- ============================================================
-- 202: products.sold_out 인덱스 — 10만개 대비
--
-- 작성: 2026-05-29
-- 사장 결정 (2026-05-29):
--   - retail /products 전체/진행/품절 자동 필터 도입
--   - 10만개 시점에도 sold_out 필터 <50ms 보장 위해 부분 인덱스
--
-- 본 마이그
--   tenant_id + sold_out 복합 인덱스 (is_active=true 조건 부분 인덱스)
--   → fetchItems 의 .eq("tenant_id") + .eq("is_active", true) + .eq("sold_out", ?) 패턴 직격
--
-- 멱등 (CONCURRENTLY 불가 — BEGIN 트랜잭션 안. 일반 CREATE INDEX 사용)
-- ============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_products_tenant_sold_out
  ON products (tenant_id, sold_out)
  WHERE is_active = true;

COMMENT ON INDEX idx_products_tenant_sold_out IS '마이그 202 — retail /products 전체/진행/품절 자동 필터 가속. 활성 상품만 부분 인덱스.';

COMMIT;
