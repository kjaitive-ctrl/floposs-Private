-- ============================================================
-- 133: process_refund source 'payment'(expense) → 'refund' 통일
--
-- 130 의 TODO 이행. Phase 2 (132) 활성화 후 환불 시 거래처 외상이
-- silently flip 되는 시한폭탄 봉합.
--
-- 문제:
--   089 process_refund 가 transactions(source='payment', type='expense') 박제
--   132 trigger CASE: WHEN source IN ('payment'...) THEN -amount (type 무관)
--   → COMMIT 시 trigger 가 환불 부호를 반대로 SUM → customer outstanding flip
--
-- 수정:
--   089 process_refund 의 INSERT source 를 'payment' → 'refund' 로 변경
--   132 trigger 의 'refund' THEN amount 분기로 자연 라우팅 → manual UPDATE
--   (outstanding_balance + v_supply) 와 sign 일치.
--
-- transactions_source_check (098) 에 'refund' 이미 허용. 안전.
--
-- 라벨 매핑:
--   transactions/page.tsx 의 txLabel 에 'refund' → '환불' 추가 별도 진행.
--
-- vat 분리 정합 (별도 이슈):
--   manual UPDATE 는 v_supply (vat 제외), trigger SUM 은 tx.amount (vat 포함)
--   사용. 패치 후에도 vat_amount > 0 인 환불은 trigger 가 vat 포함으로 SUM
--   → outstanding 에 vat 만큼 더 박힘 (잘못). 단, 환불 시 vat_mode='none'/
--   vat_amount=0 가 다수면 영향 X. vat 정합은 별도 작업.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_refund(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text,
  p_vat_mode text DEFAULT NULL::text, p_vat_amount bigint DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_supply BIGINT := p_amount - COALESCE(p_vat_amount, 0);
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  -- 거래처 외상은 공급가만큼만 환원 (vat 제외)
  UPDATE customers
  SET outstanding_balance = outstanding_balance + v_supply
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  -- transactions.amount 는 통장에서 빠진 금액(부가세 포함) 그대로.
  -- source='refund' (변경): 132 trigger 의 'refund' +amount 분기로 라우팅.
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, vat_mode, vat_amount
  ) VALUES (
    p_tenant_id, p_customer_id, 'refund', 'expense', p_method,
    p_amount, CURRENT_DATE, p_vat_mode, COALESCE(p_vat_amount, 0)
  );
END;
$function$;
