-- ============================================================
-- 067 ROLLBACK: process_sample_convert 를 063 버전으로 복귀
--
-- 사용법:
--   샘결이 새 주문 생성 방식이 마음에 안 들면 이 파일 실행.
--   기존 in-place 토글 방식(같은 주문 안에서 is_sample=false)으로 복귀.
--
-- 주의:
--   이미 067 방식으로 생성된 새 주문들은 그대로 남음.
--   복귀해도 과거 데이터 자동 정리 안 함 (수동으로 정리해야 함).
-- ============================================================

CREATE OR REPLACE FUNCTION process_sample_convert(
  p_order_item_id UUID,
  p_tenant_id     UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item     RECORD;
  v_order_id UUID;
BEGIN
  SELECT oi.id, oi.order_id, oi.is_sample, oi.sample_status
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

  v_order_id := v_item.order_id;

  UPDATE order_items
  SET is_sample      = FALSE,
      sample_status  = 'converted',
      updated_at     = NOW()
  WHERE id = p_order_item_id;

  PERFORM refresh_order_revenue(v_order_id);

  RETURN json_build_object('success', true);
END;
$$;
