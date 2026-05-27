-- ============================================================
-- 067: 샘플 매입 전환 = 새 주문 생성 방식으로 재설계
--
-- 배경:
--   기존 process_sample_convert는 같은 주문 안에서 is_sample=false 토글만 함.
--   결과: orders.total_amount=0 그대로, 부분 샘결 시 영수증 합계 깨짐.
--
-- 새 동작:
--   1. 원본 샘플 라인은 그대로 유지 (is_sample=true, sample_status='converted')
--      → 샘플 관리 탭에 영원히 이력으로 남음
--   2. 동일 거래처에 새 주문 생성 (정상 주문, 출고완료 상태)
--   3. 새 order_items INSERT (이미 출고된 상품)
--   4. refresh_order_revenue 자동 호출 → 매출/외상 발생, 매입 자동 충당
--
-- 롤백: 067_rollback.sql 실행 → 063 버전 동작으로 복귀
-- ============================================================

CREATE OR REPLACE FUNCTION process_sample_convert(
  p_order_item_id UUID,
  p_tenant_id     UUID
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item             RECORD;
  v_amount           NUMERIC;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
BEGIN
  -- 원본 샘플 라인 + 주문 정보 조회
  SELECT
    oi.id, oi.order_id, oi.variant_id, oi.quantity, oi.unit_price,
    oi.is_sample, oi.sample_status,
    o.customer_id, o.customer_name, o.payment_method, o.order_number, o.order_type
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

  v_amount := v_item.quantity * v_item.unit_price;
  -- 새 주문번호: 원본 + '-S' + UUID 앞 4자리 (충돌 방지)
  v_new_order_number := v_item.order_number || '-S'
                     || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  -- 1. 원본 샘플 라인은 보존 + sample_status='converted'로 마킹 (이력)
  UPDATE order_items
  SET sample_status = 'converted',
      updated_at    = NOW()
  WHERE id = p_order_item_id;

  -- 2. 새 주문 INSERT (정상 주문, 이미 출고된 상태)
  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, total_amount, vat_amount, paid_amount, outstanding_amount,
    payment_method, payment_status, memo
  ) VALUES (
    p_tenant_id, v_item.customer_id, v_item.customer_name, v_new_order_number,
    COALESCE(v_item.order_type, 'wholesale'),
    'sample_convert', 'shipped',
    v_amount, 0, 0, v_amount,
    v_item.payment_method, 'unpaid',
    '샘플 매입 전환 (원본: ' || v_item.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  -- 3. 새 order_items INSERT (이미 출고된 상품, 인벤토리 차감 X)
  INSERT INTO order_items (
    order_id, variant_id, quantity, original_quantity, remaining_qty,
    unit_price, total_price, status, process_type,
    shipped_qty, shipped_at, is_sample, is_exchange,
    sample_status, sample_due_date
  ) VALUES (
    v_new_order_id, v_item.variant_id, v_item.quantity, v_item.quantity, 0,
    v_item.unit_price, v_amount, 'shipped', 'ordered',
    v_item.quantity, NOW(), FALSE, FALSE,
    NULL, NULL
  );

  -- 4. 매출 갱신 + 외상 발생 + 매입 자동 충당 (기존 로직 재사용)
  PERFORM refresh_order_revenue(v_new_order_id);

  RETURN json_build_object(
    'success', true,
    'new_order_id', v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount', v_amount
  );
END;
$$;
