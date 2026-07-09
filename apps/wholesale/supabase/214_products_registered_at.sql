-- ============================================================
-- 214: products.registered_at — "진행" 시점 전용 정렬 컬럼
--
-- 작성: 2026-07-09
-- 배경:
--   handlePromote("진행")가 /products 정렬을 진행순으로 맞추려고 created_at
--   을 now() 로 덮어썼는데, handleRevert("샘플로")는 created_at 을 되돌리지
--   않아서 → 진행 후 샘플로 되돌리면 /samples(등록순 정렬) 에서 원래 등록
--   자리가 아니라 엉뚱한 옛 진행시점 자리에 나타나는 문제 발견.
--   created_at 하나로 "등록순"(불변)과 "진행순"(진행마다 갱신) 두 의미를
--   겸용시킨 게 근본 원인 → 전용 컬럼으로 분리 (033 의 variant sort_order
--   와 같은 패턴).
--
-- 이후:
--   - created_at = 순수 샘플 등록시점. 다시는 코드에서 덮어쓰지 않음.
--   - registered_at = "진행" 액션마다 now() 로 갱신. /products 정렬 기준.
--   - /samples 는 그대로 created_at DESC (변경 없음).
-- ============================================================

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ;

COMMENT ON COLUMN products.registered_at IS
  '"진행"(샘플→정식상품) 액션 시점. /products 정렬 기준. created_at(순수 샘플 등록시점)과 분리됨 — "샘플로" 회귀해도 created_at 은 안 바뀜.';

-- 기존 등록 상품 백필 — barcode_history 의 활성 "진행" 기록(issued_at)에서 역산.
-- 198 이후 진행된 상품은 전부 바코드가 발급되므로 커버리지 100%.
UPDATE products p
SET registered_at = bh.issued_at
FROM barcode_history bh
WHERE bh.product_id = p.id
  AND bh.variant_id IS NULL
  AND bh.reason = '진행'
  AND bh.revoked_at IS NULL
  AND p.status = 'registered'
  AND p.registered_at IS NULL;

DO $$
DECLARE
  v_backfilled INT;
BEGIN
  SELECT COUNT(*) INTO v_backfilled FROM products WHERE status = 'registered' AND registered_at IS NOT NULL;
  RAISE NOTICE '[214] registered_at 백필 완료. status=registered 중 % 개 채워짐.', v_backfilled;
END $$;

COMMIT;
