-- ============================================================
-- 013_process_ship_item_rpc.sql
-- 출고처리 통합 RPC — 어느 페이지에서 호출해도 동일하게 동작
-- Supabase SQL Editor에서 실행하세요
-- ============================================================

CREATE OR REPLACE FUNCTION process_ship_item(
  p_order_item_id UUID,
  p_qty           INT,
  p_tenant_id     UUID
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item        RECORD;
  v_ship_amount NUMERIC;
  v_pending_tx  RECORD;
  v_tx_date     DATE := CURRENT_DATE;
  v_label       TEXT;
BEGIN
  -- 1. 아이템 + 주문 정보 조회
  SELECT
    oi.id, oi.quantity, oi.unit_price, oi.item_type,
    oi.variant_id, oi.order_id, oi.status,
    o.customer_id, o.order_number, o.tenant_id
  INTO v_item
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  WHERE oi.id = p_order_item_id
    AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;

  IF v_item.status IN ('shipped', 'delivered', 'cancelled') THEN
    RETURN json_build_object('success', false, 'error', '이미 처리된 항목입니다.');
  END IF;

  v_ship_amount := p_qty * v_item.unit_price;
  v_label := CASE v_item.item_type
    WHEN 'backorder' THEN '미송'
    WHEN 'order'     THEN '오더'
    WHEN 'sample'    THEN '샘플'
    ELSE '출고'
  END;

  -- 2. 부분 출고: 잔여 아이템 먼저 INSERT (트리거가 remaining 체크 전에 존재해야 함)
  IF p_qty < v_item.quantity THEN
    INSERT INTO order_items (
      order_id, variant_id, item_type, quantity, unit_price, total_price,
      status, is_backorder
    ) VALUES (
      v_item.order_id, v_item.variant_id, v_item.item_type,
      v_item.quantity - p_qty,
      v_item.unit_price,
      (v_item.quantity - p_qty) * v_item.unit_price,
      'pending',
      v_item.item_type = 'backorder'
    );

    UPDATE order_items
    SET quantity    = p_qty,
        total_price = v_ship_amount,
        status      = 'shipped'
    WHERE id = p_order_item_id;
  ELSE
    -- 전량 출고: 트리거가 orders.status 자동 처리
    UPDATE order_items
    SET status = 'shipped'
    WHERE id = p_order_item_id;
  END IF;

  -- 3. 재고 차감
  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = v_item.variant_id;

  -- 4. 출고 판매 기록 (pos_sale)
  INSERT INTO transactions (
    tenant_id, customer_id, order_id,
    type, amount, method, description,
    transaction_date, source
  ) VALUES (
    p_tenant_id, v_item.customer_id, v_item.order_id,
    'receivable', v_ship_amount, NULL,
    v_item.order_number || ' 출고처리 (' || v_label || ')',
    v_tx_date, 'pos_sale'
  );

  -- 5. 보류 거래 차감/삭제 (pos_pending)
  SELECT id, amount
  INTO v_pending_tx
  FROM transactions
  WHERE order_id = v_item.order_id
    AND source   = 'pos_pending'
  LIMIT 1;

  IF FOUND THEN
    IF v_pending_tx.amount - v_ship_amount <= 0 THEN
      DELETE FROM transactions WHERE id = v_pending_tx.id;
    ELSE
      UPDATE transactions
      SET amount = v_pending_tx.amount - v_ship_amount
      WHERE id = v_pending_tx.id;
    END IF;
  END IF;

  RETURN json_build_object('success', true, 'ship_amount', v_ship_amount);
END;
$$;
