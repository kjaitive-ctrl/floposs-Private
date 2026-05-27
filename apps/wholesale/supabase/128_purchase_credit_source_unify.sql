-- ============================================================
-- 128: Phase 4 #1 — apply_purchase_credit transactions source 통일
--
-- 사장 단일 ledger 원칙: 매입금 충당은 어디서 발생하든 source='credit_apply'
-- 로 통일. 입출금 페이지/매출리포트 라벨 일관성.
--
-- 현재 (084):
--   apply_purchase_credit RPC 의 transactions INSERT source = 'purchase'
--   → 입출금 페이지 라벨 매핑 별도 (이전 작업으로 'purchase' 도 매입충당
--      라벨 추가했지만 옛 데이터 호환용)
--
-- 변경:
--   신규 transactions INSERT source = 'credit_apply' 로 통일
--   기존 데이터의 'purchase' source 는 유지 (옛 데이터 호환)
--
-- 영향:
--   [매입] 버튼 (handlePurchaseCredit) 호출 시 transactions(credit_apply) 박제
--   109/124 의 자동 충당과 동일 source → 일관성
-- ============================================================

CREATE OR REPLACE FUNCTION public.apply_purchase_credit(
  p_tenant_id uuid, p_customer_id uuid, p_order_id uuid
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_balance     BIGINT;
  v_outstanding BIGINT;
  v_apply       BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT outstanding_balance INTO v_balance
  FROM customers WHERE id = p_customer_id AND tenant_id = p_tenant_id;
  IF v_balance >= 0 THEN RETURN 0; END IF;

  SELECT outstanding_amount INTO v_outstanding
  FROM orders WHERE id = p_order_id AND tenant_id = p_tenant_id;
  IF v_outstanding <= 0 THEN RETURN 0; END IF;

  v_apply := LEAST(ABS(v_balance), v_outstanding);

  UPDATE orders
  SET outstanding_amount = outstanding_amount - v_apply,
      paid_amount        = COALESCE(paid_amount, 0) + v_apply,
      payment_status = CASE
        WHEN outstanding_amount - v_apply <= 0 THEN 'paid'
        ELSE 'partial'
      END
  WHERE id = p_order_id AND tenant_id = p_tenant_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance + v_apply
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  -- source 통일: 'purchase' → 'credit_apply'
  -- description 으로 [매입] 버튼 호출 식별 가능
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, order_id, description
  ) VALUES (
    p_tenant_id, p_customer_id, 'credit_apply', 'income', NULL,
    v_apply, CURRENT_DATE, p_order_id, '매입금 적용 (수동)'
  );

  RETURN v_apply;
END;
$$;
