-- ============================================================
-- 134: apply_purchase_credit (128) 의 manual customer UPDATE 제거
--
-- Phase 2 (132) 활성화 후 [매입] 버튼 시 거래처 외상이 +v_apply 만큼 잘못
-- 박히는 시한폭탄 봉합.
--
-- 정합 분석:
--   132 trigger SUM (customer): credit_apply -amount 적용 (= 매입금 사용분)
--   128 manual: customer outstanding += v_apply (= 매입금 잔여 갱신 의도)
--   → trigger COMMIT 시 manual +v_apply 사라지고 -v_apply (트리거) 만 잡힘
--   → customer outstanding = manual 결과 - 2*v_apply 로 잘못 박힘
--
-- 사장 단일 ledger 모델:
--   customer.outstanding_balance = SUM(transactions for customer with sign convention)
--   = pure cash ledger derived. 별도 매입금 잔액 추적 X.
--
-- [매입] 버튼의 의미 ([매입] 본질 = "이 주문을 매입금으로 결제"):
--   - 주문 outstanding -= v_apply (이 주문 결제됨) ✓ trigger order SUM 일치
--   - 거래처 outstanding 은 변동 X (사용된 매입금 만큼 미결 차감 → net 동일)
--     OR trigger 가 -amount 차감 → 매입금 잔여를 따로 표시한다는 의미
--
-- 사장 모델 = SUM 일치. 즉 trigger 의 -amount 가 진실. 128 의 manual UPDATE
--   가 잘못 (양쪽 다 차감 → 2배). 제거.
--
-- 109 / 124 의 자동 충당 분기 비교:
--   109/124 는 customer outstanding 변경 X (자동 충당 분기 안). trigger -amount
--   적용 시 정합. (109/124 패치 불필요)
--
-- 부가 효과:
--   사장이 [매입] 버튼 누르면 거래처 외상이 v_apply 만큼 추가 차감됨
--   = 매입금 잔여가 줄어드는 게 SUM 에 반영됨 (사장 모델 일관)
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

  -- 주문 차감 (trigger order SUM 의 credit_apply -amount 와 일치)
  UPDATE orders
  SET outstanding_amount = outstanding_amount - v_apply,
      paid_amount        = COALESCE(paid_amount, 0) + v_apply,
      payment_status = CASE
        WHEN outstanding_amount - v_apply <= 0 THEN 'paid'
        ELSE 'partial'
      END
  WHERE id = p_order_id AND tenant_id = p_tenant_id;

  -- 134 변경: customer outstanding manual UPDATE 제거
  --   trigger 132 의 customer SUM credit_apply -amount 가 자동 처리
  --   (manual + trigger 이중 차감 방지)

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
