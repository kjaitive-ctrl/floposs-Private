-- ============================================================
-- 014_ship_item_updates.sql
-- 1) order_items: shipped_at, updated_at 컬럼 추가
-- 2) transactions: order_item_id 컬럼 추가
-- 3) process_ship_item: p_keep_remainder + 잔여취소 처리
--    - 잔여 남김(true):  pos_sale + 잔여행 생성 (기존 동일)
--    - 잔여 안 남김(false): pos_sale + pos_cancel(-공급가액) + orders 합계 차감
-- 4) reverse_ship_item: 출고 취소 → 대기 복원 (pos_cancel 복원 포함)
-- ============================================================

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS shipped_at  TIMESTAMPTZ;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ DEFAULT NOW();

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES order_items(id) ON DELETE SET NULL;

-- ============================================================
-- process_ship_item
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
  v_order             RECORD;
  v_ship_amount       NUMERIC;
  v_cancel_supply     NUMERIC;
  v_cancel_vat        NUMERIC;
  v_cancel_total      NUMERIC;
  v_pending_decrement NUMERIC;
  v_pending_tx        RECORD;
  v_tx_date           DATE := CURRENT_DATE;
  v_label             TEXT;
BEGIN
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

  -- ── 부분 출고 ──────────────────────────────────────────────
  IF p_qty < v_item.quantity THEN

    IF p_keep_remainder THEN
      -- 잔여행 먼저 INSERT (트리거가 remaining 체크 전에 존재해야 함)
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
          status      = 'shipped',
          shipped_at  = NOW(),
          updated_at  = NOW()
      WHERE id = p_order_item_id;

      v_pending_decrement := v_ship_amount;

    ELSE
      -- 잔여 없이 출고완료 → 취소분을 별도 거래로 기록
      v_cancel_supply := (v_item.quantity - p_qty) * v_item.unit_price;

      -- 주문 부가세 비율로 취소 부가세 산출
      SELECT total_amount, vat_amount, outstanding_amount
      INTO v_order
      FROM orders WHERE id = v_item.order_id;

      IF v_order.vat_amount > 0
         AND (v_order.total_amount - v_order.vat_amount) > 0 THEN
        v_cancel_vat := ROUND(
          v_cancel_supply
          * v_order.vat_amount
          / (v_order.total_amount - v_order.vat_amount),
          0
        );
      ELSE
        v_cancel_vat := 0;
      END IF;

      v_cancel_total := v_cancel_supply + v_cancel_vat;

      -- 원본 아이템: 출고 수량으로 축소 후 shipped
      UPDATE order_items
      SET quantity    = p_qty,
          total_price = v_ship_amount,
          status      = 'shipped',
          shipped_at  = NOW(),
          updated_at  = NOW()
      WHERE id = p_order_item_id;

      -- 주문 합계에서 취소분 차감
      UPDATE orders
      SET total_amount       = GREATEST(0, total_amount       - v_cancel_total),
          vat_amount         = GREATEST(0, vat_amount         - v_cancel_vat),
          outstanding_amount = GREATEST(0, outstanding_amount - v_cancel_total)
      WHERE id = v_item.order_id;

      -- pos_cancel: 취소된 공급가액을 음수로 기록
      INSERT INTO transactions (
        tenant_id, customer_id, order_id, order_item_id,
        type, amount, method, description,
        transaction_date, source
      ) VALUES (
        p_tenant_id, v_item.customer_id, v_item.order_id, p_order_item_id,
        'receivable', -v_cancel_supply, NULL,
        v_item.order_number || ' 취소 (' || v_label || ')',
        v_tx_date, 'pos_cancel'
      );

      -- pos_pending: 출고+취소 = 원래 아이템 전체 금액 차감
      v_pending_decrement := v_item.quantity * v_item.unit_price;
    END IF;

  -- ── 전량/초과 출고 ────────────────────────────────────────
  ELSE
    UPDATE order_items
    SET quantity    = p_qty,
        total_price = v_ship_amount,
        status      = 'shipped',
        shipped_at  = NOW(),
        updated_at  = NOW()
    WHERE id = p_order_item_id;

    v_pending_decrement := v_item.quantity * v_item.unit_price;
  END IF;

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

  -- pos_pending 차감/삭제
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
-- reverse_ship_item: 출고 취소 → 대기 복원
-- pos_cancel이 있는 경우(잔여 미보존 부분출고) orders 합계도 복원
-- ============================================================
CREATE OR REPLACE FUNCTION reverse_ship_item(
  p_order_item_id UUID,
  p_tenant_id     UUID
)
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item          RECORD;
  v_order         RECORD;
  v_pending_tx    RECORD;
  v_cancel_tx     RECORD;
  v_ship_amount   NUMERIC;
  v_restore_qty   INT;
  v_cancel_supply NUMERIC;
  v_cancel_vat    NUMERIC;
  v_cancel_total  NUMERIC;
BEGIN
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

  IF v_item.status != 'shipped' THEN
    RETURN json_build_object('success', false, 'error', '출고 상태가 아닙니다.');
  END IF;

  -- pos_cancel 존재 여부 확인 (잔여 미보존 부분출고였는지)
  SELECT id, amount INTO v_cancel_tx
  FROM transactions
  WHERE order_item_id = p_order_item_id
    AND source        = 'pos_cancel'
  LIMIT 1;

  IF FOUND THEN
    -- 취소된 수량 역산: cancel_supply / unit_price
    v_cancel_supply := ABS(v_cancel_tx.amount);
    v_restore_qty   := v_item.quantity + ROUND(v_cancel_supply / v_item.unit_price)::INT;

    -- 현재 주문 vat 비율로 취소 vat 역산 (근사값)
    SELECT total_amount, vat_amount, outstanding_amount
    INTO v_order
    FROM orders WHERE id = v_item.order_id;

    IF v_order.vat_amount > 0
       AND (v_order.total_amount - v_order.vat_amount) > 0 THEN
      v_cancel_vat := ROUND(
        v_cancel_supply
        * v_order.vat_amount
        / (v_order.total_amount - v_order.vat_amount),
        0
      );
    ELSE
      v_cancel_vat := 0;
    END IF;

    v_cancel_total := v_cancel_supply + v_cancel_vat;

    -- 주문 합계 복원
    UPDATE orders
    SET total_amount       = total_amount       + v_cancel_total,
        vat_amount         = vat_amount         + v_cancel_vat,
        outstanding_amount = outstanding_amount + v_cancel_total
    WHERE id = v_item.order_id;

    -- pos_cancel 삭제
    DELETE FROM transactions WHERE id = v_cancel_tx.id;

    -- pos_pending 복원: 출고+취소 전체 금액
    v_ship_amount := v_restore_qty * v_item.unit_price;

  ELSE
    -- 전량 출고 또는 잔여 보존 부분출고였던 경우
    v_restore_qty := v_item.quantity;
    v_ship_amount := v_item.quantity * v_item.unit_price;
  END IF;

  -- 아이템 상태 복원 (수량도 원래대로)
  UPDATE order_items
  SET quantity   = v_restore_qty,
      total_price = v_restore_qty * v_item.unit_price,
      status     = 'pending',
      shipped_at = NULL,
      updated_at = NOW()
  WHERE id = p_order_item_id;

  -- 재고 복원
  UPDATE inventory
  SET quantity   = quantity + v_item.quantity,
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = v_item.variant_id;

  -- pos_sale 삭제 (order_item_id 기준 정확 삭제)
  DELETE FROM transactions
  WHERE order_item_id = p_order_item_id
    AND source        = 'pos_sale';

  -- pos_pending 복원 (없으면 신규 생성)
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
