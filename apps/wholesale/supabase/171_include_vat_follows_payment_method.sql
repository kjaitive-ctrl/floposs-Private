-- ============================================================
-- 171: customers.include_vat 을 default_payment_method 종속으로 backfill
--
-- 관리자 정책 (2026-05-11):
--   "include_vat 은 payment_method 를 자동으로 따라가게. 사용자가 직접 토글 X."
--
-- 규칙:
--   - default_payment_method = 'credit'        → include_vat = TRUE
--   - default_payment_method IN ('cash', 'transfer') → include_vat = FALSE
--
-- 변경 범위:
--   - 기존 거래처 데이터 1회 backfill (이 마이그)
--   - 이후 신규 등록/수정 시점부터는 CustomerModal 가 payment_method 따라 자동 박제
--   - 미래 운영에서 다른 경로로 customers.default_payment_method 만 UPDATE 시
--     include_vat 자동 sync 가 필요하면 별도 트리거 추가 검토
--
-- 영향:
--   - 박제된 영수증 (orders.receipt_*) 영향 X — immutable 박제값 그대로
--   - 신규 주문/처리만 새 규칙 적용
-- ============================================================

BEGIN;

UPDATE customers
SET include_vat = (default_payment_method = 'credit')
WHERE include_vat IS DISTINCT FROM (default_payment_method = 'credit');

NOTIFY pgrst, 'reload schema';

COMMIT;
