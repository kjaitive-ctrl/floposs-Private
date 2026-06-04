-- ============================================================
-- 203: 진행 후 추가된 variant 의 바코드 누락 수정
--
-- 작성: 2026-06-02
-- 버그: issue_product_barcode(진행 시점)는 그 순간의 활성 variant 만 일괄 발급.
--   진행 후 옵션(색상 등)을 추가하면 그 variant 는 issue_variant_barcode 가
--   안 불려 barcode = NULL → SKU 에 "-" 로 보임.
-- 수정:
--   ① sync_variant_barcodes(product) — 진행(바코드 있는) 상품의 활성 variant 중
--      barcode NULL 인 것만 골라 issue_variant_barcode 로 채움 (멱등, 재사용 X).
--   ② 백필 — 기존에 깨진 모든 진행 상품 일괄 보정.
--   앱은 variant 추가 시 이 RPC 호출 (samples 저장 경로).
-- [[project_retail_variant_canonical]]
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION sync_variant_barcodes(p_product_id UUID)
RETURNS INT AS $$
DECLARE
  v_barcode    TEXT;
  v_variant_id UUID;
  v_count      INT := 0;
BEGIN
  -- 진행 상태(상품 바코드 발급됨)에서만 발급. 샘플(NULL)이면 아무것도 안 함.
  SELECT barcode INTO v_barcode FROM products WHERE id = p_product_id;
  IF v_barcode IS NULL THEN
    RETURN 0;
  END IF;

  -- 바코드 없는 활성 variant 만 — issue_variant_barcode 가 seq = (바코드 보유 수)+1 로 이어감
  FOR v_variant_id IN
    SELECT id FROM product_variants
      WHERE product_id = p_product_id AND is_active = true AND barcode IS NULL
      ORDER BY sort_order, created_at
  LOOP
    PERFORM issue_variant_barcode(v_variant_id, v_barcode);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sync_variant_barcodes IS
  '진행 상품의 바코드 미발급 활성 variant 일괄 채움 (진행 후 추가 옵션 보정). 멱등. 샘플 상태면 noop.';

-- 백필 — 기존에 깨진 진행 상품 전체 보정
DO $$
DECLARE r RECORD; v_total INT := 0; v_n INT;
BEGIN
  FOR r IN SELECT id FROM products WHERE barcode IS NOT NULL LOOP
    v_n := sync_variant_barcodes(r.id);
    v_total := v_total + v_n;
  END LOOP;
  RAISE NOTICE '[203] variant 바코드 백필 완료 — % 개 발급.', v_total;
END $$;

COMMIT;
