-- ============================================================
-- 086: process_sample_return 가 inventory_logs 에 기록되도록 수정
--
-- 버그:
--   샘플 반납 시 inventory.quantity 는 +되지만 inventory_logs INSERT 누락.
--   재고관리 → 입출고 내역 탭은 inventory_logs 만 조회 → 반납 +qty 행이 안 보임.
--
-- 다른 RPC 들은 모두 INSERT 함:
--   restore_inventory  → reason: 'undo' / 'receipt' / caller 지정
--   deduct_inventory   → reason: 'shipment'
--
-- 수정:
--   재고 +행 INSERT (reason='return', qty_change=+quantity, order_item_id 포함).
--   reason 값은 inventory_logs CHECK 제약 (055) 의 허용 집합 안에서 'return' 사용
--   — 의미상 "반납 = 반품"으로 일치, UI 도 "반품/교환" 카테고리로 표시.
-- ============================================================

CREATE OR REPLACE FUNCTION process_sample_return(
  p_order_item_id UUID,
  p_tenant_id     UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item    RECORD;
  v_new_qty INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT oi.id, oi.variant_id, oi.quantity, oi.is_sample, oi.sample_status
  INTO v_item
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = p_order_item_id AND o.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '항목을 찾을 수 없습니다.');
  END IF;
  IF NOT v_item.is_sample THEN
    RETURN json_build_object('success', false, 'error', '샘플 항목이 아닙니다.');
  END IF;
  IF v_item.sample_status <> 'pending' THEN
    RETURN json_build_object('success', false, 'error', '이미 처리된 샘플입니다.');
  END IF;

  UPDATE order_items
  SET sample_status = 'returned',
      updated_at    = NOW()
  WHERE id = p_order_item_id;

  UPDATE inventory
  SET quantity   = quantity + v_item.quantity,
      updated_at = NOW()
  WHERE tenant_id = p_tenant_id AND variant_id = v_item.variant_id
  RETURNING quantity INTO v_new_qty;

  -- 입출고 내역 기록 — order_item_id 가 있으면 UI 에서 '반품/교환' 카테고리로 표시.
  -- reason='return' (CHECK 제약 허용 값 중 의미 일치).
  INSERT INTO inventory_logs
    (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason)
  VALUES
    (p_tenant_id, v_item.variant_id, p_order_item_id,
     v_item.quantity, COALESCE(v_new_qty, 0), 'return');

  RETURN json_build_object('success', true);
END;
$$;
