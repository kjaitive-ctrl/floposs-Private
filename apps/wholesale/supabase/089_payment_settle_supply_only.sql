-- ============================================================
-- 089: process_payment / process_refund — 외상은 공급가만 정산
--
-- 버그:
--   087 에서 vat_mode/vat_amount 인자는 추가했지만 외상 차감 로직은 그대로
--   p_amount(통장 찍힌 금액) 전체를 차감. 부가세까지 외상에서 빠짐.
--   예: 외상 19,000 + 통장 20,900 입금 → 외상 = 19,000 - 20,900 = -1,900 (잘못)
--
-- 정책:
--   외상은 공급가 기준 → 공급가 = p_amount - p_vat_amount 만 차감.
--   transactions.amount 는 통장 입금액 그대로 박제 (현금 흐름 추적용).
--   transactions.vat_amount 도 그대로 박제 → 영업정산 vat 합산은 087 에서 이미 처리.
-- ============================================================

CREATE OR REPLACE FUNCTION public.process_payment(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text,
  p_source text, p_order_id uuid DEFAULT NULL::uuid,
  p_vat_mode text DEFAULT NULL::text, p_vat_amount bigint DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_supply    BIGINT := p_amount - COALESCE(p_vat_amount, 0);  -- 공급가 (외상 차감 기준)
  v_remaining BIGINT := v_supply;
  v_order     RECORD;
  v_apply     BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  -- 거래처 총 미수금 차감 — 공급가만
  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_supply
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  -- transaction 생성 — amount 는 통장 입금액(부가세 포함), vat_amount 별도 박제
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method, amount, transaction_date, order_id,
    vat_mode, vat_amount
  )
  VALUES (
    p_tenant_id, p_customer_id, p_source, 'income', p_method, p_amount, CURRENT_DATE, p_order_id,
    p_vat_mode, COALESCE(p_vat_amount, 0)
  );

  -- 주문별 outstanding_amount 차감 — 공급가만
  IF p_order_id IS NOT NULL THEN
    UPDATE orders
    SET outstanding_amount = GREATEST(0, outstanding_amount - v_supply),
        payment_status = CASE
          WHEN outstanding_amount - v_supply <= 0 THEN 'paid'
          ELSE 'partial'
        END
    WHERE id = p_order_id AND tenant_id = p_tenant_id;
  ELSE
    -- FIFO: 공급가 v_remaining 만큼 차례로 차감
    FOR v_order IN
      SELECT id, outstanding_amount
      FROM orders
      WHERE customer_id = p_customer_id
        AND tenant_id   = p_tenant_id
        AND payment_status != 'paid'
        AND outstanding_amount > 0
      ORDER BY created_at ASC
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_apply := LEAST(v_remaining, v_order.outstanding_amount);
      UPDATE orders
      SET outstanding_amount = outstanding_amount - v_apply,
          payment_status = CASE
            WHEN outstanding_amount - v_apply <= 0 THEN 'paid'
            ELSE 'partial'
          END
      WHERE id = v_order.id;
      v_remaining := v_remaining - v_apply;
    END LOOP;
  END IF;
END;
$function$;


-- process_refund — 환불도 공급가 기준
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

  -- 거래처 외상은 공급가만큼만 환원
  UPDATE customers
  SET outstanding_balance = outstanding_balance + v_supply
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  -- transactions 의 amount 는 통장에서 빠진 금액(부가세 포함) 그대로
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, vat_mode, vat_amount
  ) VALUES (
    p_tenant_id, p_customer_id, 'payment', 'expense', p_method,
    p_amount, CURRENT_DATE, p_vat_mode, COALESCE(p_vat_amount, 0)
  );
END;
$function$;
