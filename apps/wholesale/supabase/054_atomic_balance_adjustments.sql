-- ============================================================
-- 054: 원자적 외상 조정 함수 (동시성 안전)
--
-- 문제: fetch+update 패턴은 동시 요청 시 레이스 컨디션 발생
--   read(balance=100) → compute(100-50=50) → write(50)
--   동시 요청도 read(balance=100) → compute(100-30=70) → write(70) ← 50차감 유실
--
-- 해결: DB 내 atomic SQL (SET col = col + delta)
--   PostgreSQL row-level lock이 동시성 보장
-- ============================================================

-- 미송해제: cancel 트랜잭션 + 주문 미수금 차감 + 거래처 외상 차감 (원자적)
CREATE OR REPLACE FUNCTION process_backorder_release(
  p_tenant_id   UUID,
  p_order_id    UUID,
  p_customer_id UUID,
  p_amount      BIGINT,
  p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO transactions (
    tenant_id, customer_id, order_id, source, type, amount, transaction_date, description
  ) VALUES (
    p_tenant_id, p_customer_id, p_order_id, 'cancel', 'receivable', p_amount, CURRENT_DATE, p_description
  );

  UPDATE orders
  SET outstanding_amount = GREATEST(0, outstanding_amount - p_amount)
  WHERE id = p_order_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - p_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;
END;
$$;

-- 반품: return 트랜잭션 + 주문 미수금 차감 + 거래처 외상 차감 (원자적)
CREATE OR REPLACE FUNCTION process_return_item(
  p_tenant_id   UUID,
  p_order_id    UUID,
  p_customer_id UUID,
  p_amount      BIGINT,
  p_description TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO transactions (
    tenant_id, customer_id, order_id, source, type, amount, transaction_date, description
  ) VALUES (
    p_tenant_id, p_customer_id, p_order_id, 'return', 'receivable', p_amount, CURRENT_DATE, p_description
  );

  UPDATE orders
  SET outstanding_amount = GREATEST(0, outstanding_amount - p_amount)
  WHERE id = p_order_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance - p_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;
END;
$$;

-- 출고 되돌리기: shipment 트랜잭션 삭제 + 거래처 외상 차감 + 주문 미수금 리셋 (원자적)
CREATE OR REPLACE FUNCTION process_undo_shipment(
  p_tenant_id   UUID,
  p_order_id    UUID,
  p_customer_id UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_tx_id     UUID;
  v_tx_amount BIGINT;
BEGIN
  SELECT id, amount INTO v_tx_id, v_tx_amount
  FROM transactions
  WHERE tenant_id = p_tenant_id
    AND order_id  = p_order_id
    AND source    = 'shipment'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_tx_id IS NULL THEN RETURN; END IF;

  DELETE FROM transactions WHERE id = v_tx_id;

  UPDATE customers
  SET outstanding_balance = GREATEST(0, outstanding_balance - v_tx_amount)
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  UPDATE orders
  SET outstanding_amount = 0
  WHERE id = p_order_id;
END;
$$;
