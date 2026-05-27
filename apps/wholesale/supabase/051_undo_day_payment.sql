-- ============================================================
-- 051: undo_day_payment RPC
--      당일처리 취소 — transaction 삭제 + 주문/거래처 복원 원자적 처리
-- ============================================================

CREATE OR REPLACE FUNCTION undo_day_payment(
  p_order_id  UUID,
  p_tenant_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tx RECORD;
BEGIN
  SELECT id, amount, customer_id INTO v_tx
  FROM transactions
  WHERE order_id  = p_order_id
    AND tenant_id = p_tenant_id
    AND type      = 'income'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_tx.id IS NULL THEN RETURN; END IF;

  DELETE FROM transactions WHERE id = v_tx.id;

  UPDATE orders
  SET outstanding_amount = revenue,
      payment_status     = 'unpaid'
  WHERE id = p_order_id AND tenant_id = p_tenant_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance + v_tx.amount
  WHERE id = v_tx.customer_id AND tenant_id = p_tenant_id;
END;
$$;
