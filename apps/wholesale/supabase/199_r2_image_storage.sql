-- 199_r2_image_storage.sql
-- product_images 테이블에 R2 메타데이터 컬럼 추가.
-- url/sort_order/is_main 은 기존 (schema.sql:157). 여기선 추적용 메타만 보강.
--
-- file_size: tenant 별 R2 사용량 합계 산출용 (즉시 조회). 미래 과금 진입 시 사용.
-- mime_type: 표시/cleanup 시 참고. (R2 자체에도 박혀있지만 DB 측에서 즉시 조회).

ALTER TABLE product_images
  ADD COLUMN IF NOT EXISTS file_size BIGINT,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS image_type TEXT NOT NULL DEFAULT 'thumbnail';

-- image_type enum 값 (사장 결정): thumbnail / detail / etc.
-- 자유 TEXT — 향후 추가 시 ALTER 불필요. 코드에서 검증.
-- UI 라벨: 썸네일 / 상세페이지 / 기타.
-- is_main 컬럼과 별개. is_main = "리스팅 카드용 단 1장" (어느 type 이든 1상품당 1장).

-- product_id + type + sort_order 기반 조회 인덱스 — 섹션별 list fetch 용
CREATE INDEX IF NOT EXISTS idx_product_images_product_type_sort
  ON product_images(product_id, image_type, sort_order, created_at);

-- RLS — 다른 신규 테이블 컬럼 추가는 RLS 영향 없지만, 신규 테이블 INSERT 회귀 방지 차원에서
-- 명시적으로 비활성 재확인. (feedback_supabase_new_table_rls.md)
ALTER TABLE product_images DISABLE ROW LEVEL SECURITY;
