-- ============================================================
-- 177: customers.include_vat 안전망 — INSERT 시 default_payment_method 따라 자동 박제
--
-- 작성: 2026-05-15
-- 배경
--   - 마이그 171: customers.include_vat = (default_payment_method='credit') 정책 backfill (기존 row 만).
--   - DB default 가 `true` 라서 INSERT 시점에 클라이언트가 include_vat 박제 누락하면
--     cash/transfer 거래처도 include_vat=true 박힘 → 외상에 vat 잘못 포함 (마이그 147 supply only 깨짐).
--   - retail 외부 주문 자동 등록 path (2026-05-15) 에서 발견.
--   - 5축 vertical 확장 시 새 자동 등록 path 마다 같은 함정 가능 → 안전망 필요.
--
-- 본 마이그
--   ① customers.include_vat 의 DB default `true` 제거 (NULL 허용 그대로)
--   ② BEFORE INSERT trigger 신설: include_vat IS NULL 면
--      default_payment_method='credit' → true, 그 외 → false 로 자동 채움
--   ③ UPDATE sync 는 안 함 — include_vat 는 [VAT 절대원칙] 의 토글이라
--      사장이 의도적으로 default_payment_method 와 다르게 둘 수 있음. INSERT 시점만 default 채움.
--
-- 효과
--   - 클라이언트가 include_vat 명시 박제 → 그 값 그대로 (toggle 의도 존중)
--   - 클라이언트가 박제 누락 → trigger 가 default_payment_method 따라 정합 박제
--   - 옛 row 영향 X (BEFORE INSERT only)
--
-- 안전 — 멱등 (DROP TRIGGER IF EXISTS / CREATE OR REPLACE), BEGIN/COMMIT
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────
-- ① DB default 제거
-- ─────────────────────────────────────────────────────────
ALTER TABLE customers ALTER COLUMN include_vat DROP DEFAULT;

COMMENT ON COLUMN customers.include_vat IS
  '결제 시 vat 포함 입금 여부 토글. 마이그 171/147 정책: credit 거래처만 외상에 vat 포함. '
  '클라이언트 박제 누락 시 trigger(177) 가 default_payment_method 따라 자동 채움.';


-- ─────────────────────────────────────────────────────────
-- ② INSERT 자동 채움 trigger
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION customers_fill_include_vat_default()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.include_vat IS NULL THEN
    NEW.include_vat := (NEW.default_payment_method = 'credit');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customers_fill_include_vat_default ON customers;
CREATE TRIGGER customers_fill_include_vat_default
  BEFORE INSERT ON customers
  FOR EACH ROW EXECUTE FUNCTION customers_fill_include_vat_default();


-- ─────────────────────────────────────────────────────────
-- 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[177] customers.include_vat default 제거 + INSERT 자동 채움 trigger 정착. retail 자동 등록 + 미래 vertical 안전망.';
END $$;

COMMIT;
