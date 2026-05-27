-- ============================================================
-- 015_remaining_qty.sql
-- 1) order_items: original_quantity, shipped_qty 컬럼 추가
-- 2) process_ship_item: 잔여행 생성 → shipped_qty 누적 방식으로 교체
-- 3) reverse_ship_item: shipped_qty 기준 복원으로 업데이트
-- ============================================================

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS original_quantity INT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS shipped_qty       INT NOT NULL DEFAULT 0;

-- 기존 데이터: original_quantity = quantity
UPDATE order_items SET original_quantity = quantity WHERE original_quantity IS NULL;

-- ============================================================
-- process_ship_item: shipped_qty 누적 방식
-- p_keep_remainder 파라미터는 하위호환성 유지 (무시됨)
-- ============================================================
CREATE OR REPLACE FUNCTION process_ship_item(
  p_order_item_id  UUID,
  p_qty            INT,
  p_tenant_id      UUID,
  p_keep_remainder BOOLEAN DEFAULT TRUE
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item              RECORD;
  v_new_shipped_qty   INT;
  v_original_qty      INT;
  v_is_complete       BOOLEAN;
  v_ship_amount       NUMERIC;
  v_pending_decrement NUMERIC;
  v_pending_tx        RECORD;
  v_tx_date           DATE := CURRENT_DATE;
  v_label             TEXT;
BEGIN
  SELECT
    oi.id, oi.quantity, oi.original_quantity, oi.shipped_qty,
    oi.unit_price, oi.item_type, oi.variant_id, oi.order_id, oi.status,
    o.customer_id, o.order_number, o.tenant_id
  INTO v_item
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  WHERE oi.id = p_order_item_id
    AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;

  IF v_item.status IN ('shipped', 'delivered') THEN
    RETURN json_build_object('success', false, 'error', '이미 처리된 항목입니다.');
  END IF;

  v_original_qty    := COALESCE(v_item.original_quantity, v_item.quantity);
  v_new_shipped_qty := COALESCE(v_item.shipped_qty, 0) + p_qty;
  v_is_complete     := v_new_shipped_qty >= v_original_qty;
  v_ship_amount     := p_qty * v_item.unit_price;
  v_pending_decrement := v_ship_amount;

  v_label := CASE v_item.item_type
    WHEN 'backorder' THEN '미송'
    WHEN 'order'     THEN '오더'
    WHEN 'sample'    THEN '샘플'
    ELSE '출고'
  END;

  -- 아이템 업데이트: shipped_qty 누적, 완료 시 status=shipped
  UPDATE order_items
  SET shipped_qty = v_new_shipped_qty,
      status      = CASE WHEN v_is_complete THEN 'shipped' ELSE status END,
      shipped_at  = CASE WHEN v_is_complete THEN NOW() ELSE shipped_at END,
      updated_at  = NOW()
  WHERE id = p_order_item_id;

  -- 재고 차감
  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = v_item.variant_id;

  -- pos_sale 기록
  INSERT INTO transactions (
    tenant_id, customer_id, order_id, order_item_id,
    type, amount, method, description,
    transaction_date, source
  ) VALUES (
    p_tenant_id, v_item.customer_id, v_item.order_id, p_order_item_id,
    'receivable', v_ship_amount, NULL,
    v_item.order_number || ' 출고처리 (' || v_label || ')',
    v_tx_date, 'pos_sale'
  );

  -- pos_pending 차감
  SELECT id, amount INTO v_pending_tx
  FROM transactions
  WHERE order_id = v_item.order_id
    AND source   = 'pos_pending'
  LIMIT 1;

  IF FOUND THEN
    IF v_pending_tx.amount - v_pending_decrement <= 0 THEN
      DELETE FROM transactions WHERE id = v_pending_tx.id;
    ELSE
      UPDATE transactions
      SET amount = v_pending_tx.amount - v_pending_decrement
      WHERE id = v_pending_tx.id;
    END IF;
  END IF;

  RETURN json_build_object('success', true, 'ship_amount', v_ship_amount);
END;
$$;

-- ============================================================
-- reverse_ship_item: shipped_qty 기준 전량 취소
-- ============================================================
CREATE OR REPLACE FUNCTION reverse_ship_item(
  p_order_item_id UUID,
  p_tenant_id     UUID
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item        RECORD;
  v_pending_tx  RECORD;
  v_ship_amount NUMERIC;
  v_restore_qty INT;
BEGIN
  SELECT
    oi.id, oi.quantity, oi.original_quantity, oi.shipped_qty,
    oi.unit_price, oi.item_type, oi.variant_id, oi.order_id, oi.status,
    o.customer_id, o.order_number, o.tenant_id
  INTO v_item
  FROM order_items oi
  JOIN orders o ON oi.order_id = o.id
  WHERE oi.id = p_order_item_id
    AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;

  IF v_item.status != 'shipped' THEN
    RETURN json_build_object('success', false, 'error', '출고 상태가 아닙니다.');
  END IF;

  -- shipped_qty가 없으면 quantity로 폴백
  v_restore_qty := COALESCE(NULLIF(v_item.shipped_qty, 0), v_item.quantity);
  v_ship_amount := v_restore_qty * v_item.unit_price;

  -- 아이템 복원: shipped_qty 초기화, pending 복원
  UPDATE order_items
  SET shipped_qty = 0,
      status      = 'pending',
      shipped_at  = NULL,
      updated_at  = NOW()
  WHERE id = p_order_item_id;

  -- 재고 복원
  UPDATE inventory
  SET quantity   = quantity + v_restore_qty,
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = v_item.variant_id;

  -- pos_sale 전체 삭제 (부분출고 시 여러 건 존재 가능)
  DELETE FROM transactions
  WHERE order_item_id = p_order_item_id
    AND source        = 'pos_sale';

  -- pos_pending 복원
  SELECT id, amount INTO v_pending_tx
  FROM transactions
  WHERE order_id = v_item.order_id
    AND source   = 'pos_pending'
  LIMIT 1;

  IF FOUND THEN
    UPDATE transactions
    SET amount = v_pending_tx.amount + v_ship_amount
    WHERE id = v_pending_tx.id;
  ELSE
    INSERT INTO transactions (
      tenant_id, customer_id, order_id,
      type, amount, method, description,
      transaction_date, source
    ) VALUES (
      p_tenant_id, v_item.customer_id, v_item.order_id,
      'receivable', v_ship_amount, NULL,
      v_item.order_number || ' 출고취소 복원',
      CURRENT_DATE, 'pos_pending'
    );
  END IF;

  RETURN json_build_object('success', true, 'reversed_amount', v_ship_amount);
END;
$$;
