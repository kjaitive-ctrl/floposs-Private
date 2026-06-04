-- ============================================================
-- 207: product_price_history — 가격 변경 이력 (자동 트리거 박제)
--
-- 작성: 2026-06-02
-- 용도: products 의 가격 컬럼이 바뀌면 트리거가 자동으로 1줄 박제.
--   UI 어디서 바꾸든(모달/인라인/SQL) 전부 잡힘. auth.uid() 로 "누가" 캡처.
--   추적: wholesale_price_current(공급가) · regular_sale_price(상시판매가)
--        · sale_price(판매가) · consumer_price(소비자가)
--   조회: 상품별 📜 이력 버튼.
-- 부하: 변경 시에만 INSERT, 읽기는 이력 볼 때만 → 무시할 수준.
-- [[feedback_accounting_integrity]]
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS product_price_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  field               TEXT NOT NULL,   -- 어떤 가격
  old_value           NUMERIC,
  new_value           NUMERIC,
  changed_by_user_id  UUID,            -- auth.uid() (없으면 NULL=시스템)
  changed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE product_price_history DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_price_history_product
  ON product_price_history(product_id, changed_at DESC);

-- 트리거: 가격 컬럼 변경 시 자동 박제
CREATE OR REPLACE FUNCTION log_product_price_change() RETURNS trigger AS $$
DECLARE
  uid UUID;
BEGIN
  BEGIN uid := auth.uid(); EXCEPTION WHEN OTHERS THEN uid := NULL; END;

  IF NEW.wholesale_price_current IS DISTINCT FROM OLD.wholesale_price_current THEN
    INSERT INTO product_price_history(product_id, field, old_value, new_value, changed_by_user_id)
      VALUES (NEW.id, 'wholesale_price_current', OLD.wholesale_price_current, NEW.wholesale_price_current, uid);
  END IF;
  IF NEW.regular_sale_price IS DISTINCT FROM OLD.regular_sale_price THEN
    INSERT INTO product_price_history(product_id, field, old_value, new_value, changed_by_user_id)
      VALUES (NEW.id, 'regular_sale_price', OLD.regular_sale_price, NEW.regular_sale_price, uid);
  END IF;
  IF NEW.sale_price IS DISTINCT FROM OLD.sale_price THEN
    INSERT INTO product_price_history(product_id, field, old_value, new_value, changed_by_user_id)
      VALUES (NEW.id, 'sale_price', OLD.sale_price, NEW.sale_price, uid);
  END IF;
  IF NEW.consumer_price IS DISTINCT FROM OLD.consumer_price THEN
    INSERT INTO product_price_history(product_id, field, old_value, new_value, changed_by_user_id)
      VALUES (NEW.id, 'consumer_price', OLD.consumer_price, NEW.consumer_price, uid);
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_product_price_history ON products;
CREATE TRIGGER trg_product_price_history
  AFTER UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION log_product_price_change();

DO $$ BEGIN
  RAISE NOTICE '[207] product_price_history + 자동 트리거 박힘 (공급가/상시판매가/판매가/소비자가).';
END $$;

COMMIT;
