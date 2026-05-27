-- ============================================================
-- 088: process_payment / process_refund legacy 시그니처 제거
--
-- 문제:
--   087 이 vat_mode/vat_amount 인자가 추가된 새 시그니처로 CREATE OR REPLACE.
--   하지만 PG 는 시그니처가 다르면 별개 함수로 취급 → 이전 6인자 시그니처가
--   살아있는 채로 새 8인자 시그니처가 추가됨.
--
--   클라이언트가 6인자만 보내면 (예: handleDayPayment 의 현금처리) PG 가
--   "best candidate function" 을 못 골라 에러.
--
-- 해결:
--   이전 시그니처를 DROP. 새 시그니처는 vat_mode/vat_amount DEFAULT 가 있어서
--   기존 6인자 호출도 그대로 받아냄. 동작 100% 호환.
-- ============================================================

DROP FUNCTION IF EXISTS public.process_payment(
  uuid, uuid, bigint, text, text, uuid
);

DROP FUNCTION IF EXISTS public.process_refund(
  uuid, uuid, bigint, text
);
