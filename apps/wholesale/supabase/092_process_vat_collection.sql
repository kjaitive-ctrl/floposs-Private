-- ============================================================
-- 092: process_vat_collection — 월별 부가세 정산 입금 처리
--
-- 시나리오:
--   현금/통장 거래처는 매월 부가세를 별도로 입금받음.
--   사용자가 부가세 정산 페이지에서 거래처 선택 → 입금처리.
--
-- 동작:
--   1. transactions INSERT — source='vat_collection', amount=부가세액, vat_amount=amount.
--      트리거 fill_biz_session_id (071) 가 활성 세션 자동 채움 → 영업정산 자동 합산.
--   2. customer.outstanding_balance 무영향 (이미 089 정책으로 외상은 공급가만 추적).
--   3. orders 무영향.
--
-- vat_batches 는 일단 미사용 — 월별 부가세 현황은 transactions GROUP BY 로 충분.
-- 향후 세금계산서 발행 추적이 필요해지면 별도 RPC 추가.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_vat_collection(
  p_tenant_id    uuid,
  p_customer_id  uuid,
  p_amount       bigint,
  p_method       text,
  p_period_month text DEFAULT NULL  -- '2026-04' 형식 — 어느 월의 부가세인지 메모
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_amount <= 0 THEN
    RAISE EXCEPTION '부가세 입금액은 양수여야 합니다 (%)', p_amount;
  END IF;

  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date,
    vat_mode, vat_amount,
    description
  )
  VALUES (
    p_tenant_id, p_customer_id, 'vat_collection', 'income', p_method,
    p_amount, CURRENT_DATE,
    'vat_only', p_amount,  -- 전액이 부가세
    COALESCE(p_period_month, '')
  );
END;
$function$;
