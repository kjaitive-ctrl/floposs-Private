-- ============================================================
-- 056: process_return_item — paid/unpaid 분기 처리
--
-- unpaid: outstanding_balance 감소하되 0 이하 불가 (현금 미수취)
-- paid:   outstanding_balance 음수 허용 (크레딧 = 돌려줄 돈)
-- ============================================================

CREATE OR REPLACE FUNCTION process_return_item(
  p_tenant_id   UUID,
  p_order_id    UUID,
  p_customer_id UUID,
  p_amount      BIGINT,
  p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_payment_status TEXT;
BEGIN
  SELECT payment_status INTO v_payment_status
  FROM orders WHERE id = p_order_id;

  INSERT INTO transactions (
    tenant_id, customer_id, order_id, source, type, amount, transaction_date, description
  ) VALUES (
    p_tenant_id, p_customer_id, p_order_id, 'return', 'receivable', p_amount, CURRENT_DATE, p_description
  );

  UPDATE orders
  SET outstanding_amount = GREATEST(0, outstanding_amount - p_amount)
  WHERE id = p_order_id;

  UPDATE customers
  SET outstanding_balance = CASE
    WHEN v_payment_status = 'paid'
    THEN outstanding_balance - p_amount        -- 음수 허용 (크레딧)
    ELSE GREATEST(0, outstanding_balance - p_amount)  -- 0 이하 불가
  END
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;
END;
$$;
