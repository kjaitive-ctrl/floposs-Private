-- ============================================================
-- 197: 촬영 이력 — 1상품 : N촬영 + 옛 products.shoot_info 정리
--
-- 작성: 2026-05-28
-- 사장 결정 (2026-05-28 회의):
--   1. 1 상품에 여러 번 촬영 가능 → 이력 보존.
--   2. ShootModal: 가로 입력 폼 + 세로 listing (이력).
--   3. 모델은 models(196) FK. 코디는 product_id+variant_id JSONB.
--
-- 본 마이그
--   ① product_shoots 테이블 (1:N)
--   ② 옛 products.shoot_info JSONB → product_shoots 이전 (if any)
--   ③ products.shoot_info DROP
--
-- 영향 매트릭스
--   - retail products [촬영] 버튼 → ShootModal 전면 재작성.
--   - 옛 데이터: shoot_info 가 있으면 product_shoots 1행으로 이전.
--     model 은 텍스트였으니 model_id NULL + memo 에 박제 (수동 매칭 필요).
-- ============================================================

BEGIN;


-- ─────────────────────────────────────────────────────────
-- ① product_shoots
-- ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_shoots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  model_id        UUID REFERENCES models(id) ON DELETE SET NULL,
  worn_variant_id UUID REFERENCES product_variants(id) ON DELETE SET NULL,
  shoot_date      DATE,
  coordinates     JSONB NOT NULL DEFAULT '[]'::jsonb,
                    -- 예: [{"product_id":"uuid","variant_id":"uuid"}, ...]
  memo            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_shoots_product_created
  ON product_shoots (product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_product_shoots_model
  ON product_shoots (model_id) WHERE model_id IS NOT NULL;

ALTER TABLE product_shoots DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  product_shoots IS
  '촬영 이력. 1상품:N촬영. ShootModal 가로 입력 + 세로 listing.';
COMMENT ON COLUMN product_shoots.coordinates IS
  '코디 아이템 배열. [{product_id, variant_id}]. 양방향 검색(내 상품명/공급상품명)으로 추가.';

-- updated_at 자동
CREATE OR REPLACE FUNCTION product_shoots_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_shoots_updated_at ON product_shoots;
CREATE TRIGGER trg_product_shoots_updated_at
  BEFORE UPDATE ON product_shoots
  FOR EACH ROW EXECUTE FUNCTION product_shoots_touch_updated_at();


-- ─────────────────────────────────────────────────────────
-- ② 옛 products.shoot_info → product_shoots 이전 (any)
--   shoot_info = {model(text), worn_variant_id, shoot_date, coordinates}
--   model 은 text 였으니 model_id NULL + memo 에 박제.
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_migrated INT;
BEGIN
  -- 컬럼 존재 시에만 이전 (194 적용 안 했으면 컬럼 없음 — skip)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'shoot_info'
  ) THEN
    INSERT INTO product_shoots (product_id, worn_variant_id, shoot_date, coordinates, memo)
    SELECT
      id,
      -- worn_variant_id 가 유효 uuid 인지 안전 변환
      CASE WHEN (shoot_info->>'worn_variant_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN (shoot_info->>'worn_variant_id')::uuid
        ELSE NULL END,
      CASE WHEN (shoot_info->>'shoot_date') ~ '^\d{4}-\d{2}-\d{2}$'
        THEN (shoot_info->>'shoot_date')::date
        ELSE NULL END,
      COALESCE(shoot_info->'coordinates', '[]'::jsonb),
      CASE WHEN shoot_info->>'model' IS NOT NULL
        THEN '[마이그 197 이전] 모델: ' || (shoot_info->>'model')
        ELSE NULL END
    FROM products
    WHERE shoot_info IS NOT NULL
      AND shoot_info != '{}'::jsonb
      AND jsonb_typeof(shoot_info) = 'object';

    GET DIAGNOSTICS v_migrated = ROW_COUNT;
    RAISE NOTICE '[197] 옛 shoot_info → product_shoots 이전: % 건.', v_migrated;
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────
-- ③ products.shoot_info DROP
-- ─────────────────────────────────────────────────────────
ALTER TABLE products DROP COLUMN IF EXISTS shoot_info;


DO $$
BEGIN
  RAISE NOTICE '[197] product_shoots 박힘 + 옛 shoot_info 컬럼 정리 완료.';
END $$;

COMMIT;
