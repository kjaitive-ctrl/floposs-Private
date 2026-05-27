-- ============================================================
-- 057: restore_inventory — p_reason 파라미터 추가
--      + inventory_logs_reason_check에 'return', 'exchange' 추가
--
-- 기존 함수: reason='receipt' 하드코딩 → p_reason 파라미터로 교체
-- 교환: p_process_type='backorder' 넘기면 미송 상태로 전환
-- ============================================================

-- 제약 먼저 업데이트 (함수 실행 전에 필요)
ALTER TABLE inventory_logs
  DROP CONSTRAINT IF EXISTS inventory_logs_reason_check;

ALTER TABLE inventory_logs
  ADD CONSTRAINT inventory_logs_reason_check
  CHECK (reason IN ('shipment', 'receipt', 'adjustment', 'undo', 'return', 'exchange'));

-- 함수 업데이트: p_reason 파라미터 추가 (기본값 'receipt' 하위호환)
CREATE OR REPLACE FUNCTION public.restore_inventory(
  p_tenant_id         UUID,
  p_variant_id        UUID,
  p_qty               INT,
  p_order_item_id     UUID    DEFAULT NULL,
  p_restore_remaining BOOLEAN DEFAULT TRUE,
  p_process_type      TEXT    DEFAULT NULL,
  p_reason            TEXT    DEFAULT 'receipt'
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_new_inv_qty INT;
BEGIN
  UPDATE inventory
  SET quantity   = quantity + p_qty,
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = p_variant_id
  RETURNING quantity INTO v_new_inv_qty;

  IF p_order_item_id IS NOT NULL THEN
    UPDATE order_items
    SET shipped_qty   = GREATEST(0, shipped_qty - p_qty),
        remaining_qty = CASE
                          WHEN p_restore_remaining
                          THEN LEAST(remaining_qty + p_qty, COALESCE(original_quantity, remaining_qty + p_qty))
                          ELSE remaining_qty
                        END,
        status        = CASE
                          WHEN p_restore_remaining AND status = 'shipped' THEN 'unshipped'
                          ELSE status
                        END,
        process_type  = CASE
                          WHEN p_restore_remaining AND p_process_type IS NOT NULL THEN p_process_type
                          ELSE process_type
                        END
    WHERE id = p_order_item_id;
  END IF;

  INSERT INTO inventory_logs
    (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason)
  VALUES
    (p_tenant_id, p_variant_id, p_order_item_id, p_qty, COALESCE(v_new_inv_qty, 0), p_reason);
END;
$$;
