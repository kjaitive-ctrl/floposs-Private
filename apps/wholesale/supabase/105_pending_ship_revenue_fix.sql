-- ============================================================
-- 105: Phase 2 핫픽스 — process_pending_ship 의 매출/판매 박제 정밀화
--
-- 사장 보고 (2026-05-03):
--   미송 출고 derived 주문에 "판매" 와 "당일" 금액이 표시됨 (잘못).
--   미송은 원본 주문 등록 시 이미 매출/판매에 인식됨 → derived 에서 또 잡으면 이중.
--
-- 정책:
--   - 미송 출고분 → derived 주문의 revenue/sales_qty/confirmed_amount = 0
--                  (외상은 이미 원본에 잡혀있어 변동 X — Phase 2 그대로)
--   - 보류 출고분 → derived 주문에 매출/판매로 정상 인식 (이때 처음 매출 발생)
--   - total_amount/order_qty 는 전체 (영수증 표시용)
--
-- 코드 흐름:
--   loop 안에서 process_type 별로 v_revenue/v_sales_qty 분리 누적.
--   total_amount/order_qty 는 전체 누적 (변경 X).
-- ============================================================

CREATE OR REPLACE FUNCTION process_pending_ship(
  p_tenant_id          UUID,
  p_original_order_id  UUID,
  p_item_qty           JSONB
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total            NUMERIC := 0;  -- total_amount (전체 출고 금액)
  v_qty              INT     := 0;  -- order_qty (전체 출고 수량)
  v_revenue          NUMERIC := 0;  -- revenue (보류 출고분만)
  v_sales_qty        INT     := 0;  -- sales_qty (보류 출고분만)
  v_payload          JSONB;
  v_item             RECORD;
  v_qty_to_ship      INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  -- 원본 주문 정보 조회
  SELECT customer_id, customer_name, payment_method, order_number, order_type
  INTO v_orig
  FROM orders
  WHERE id = p_original_order_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '원본 주문을 찾을 수 없습니다 (%)', p_original_order_id
      USING ERRCODE = 'P0001';
  END IF;

  -- 1) 각 item: 재고 차감 + 원본 order_item 업데이트
  --    동시에 미송/보류 구분 누적 (보류만 매출/판매에 인식)
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;

    SELECT id, variant_id, unit_price, remaining_qty, process_type, is_sample, is_exchange
    INTO v_item
    FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_item 을 찾을 수 없습니다 (%)', v_payload->>'item_id'
        USING ERRCODE = 'P0001';
    END IF;

    IF v_item.process_type NOT IN ('backorder', 'hold') THEN
      RAISE EXCEPTION '미송/보류 항목만 처리 가능. 받은 process_type: %', v_item.process_type
        USING ERRCODE = 'P0001';
    END IF;

    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := v_qty_to_ship,
      p_order_item_id := v_item.id,
      p_close         := v_qty_to_ship >= v_item.remaining_qty
    );

    -- total_amount/order_qty 는 전체 누적 (영수증 표시용)
    v_total := v_total + (v_qty_to_ship * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_ship;

    -- 매출/판매는 보류 출고분만 인식 (미송은 원본에서 이미 인식됨)
    IF v_item.process_type = 'hold' THEN
      v_revenue   := v_revenue + (v_qty_to_ship * v_item.unit_price);
      v_sales_qty := v_sales_qty + v_qty_to_ship;
    END IF;
  END LOOP;

  -- 2) 신규 derived 주문 생성
  v_new_order_number := v_orig.order_number || '-S'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, payment_method, payment_status,
    total_amount, vat_amount, paid_amount, outstanding_amount,
    derived_from_order_id, is_processed, has_pending,
    sales_qty, revenue, confirmed_amount, order_qty,
    memo
  ) VALUES (
    p_tenant_id, v_orig.customer_id, v_orig.customer_name, v_new_order_number,
    COALESCE(v_orig.order_type, 'wholesale'),
    'pending_ship', 'shipped', v_orig.payment_method, 'unpaid',
    v_total, 0, 0, 0,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,  -- 핵심: 보류분만 매출/판매로
    '미송/보류 출고 (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  -- 3) derived 주문에 출고된 항목 복사
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;

    SELECT variant_id, unit_price, is_sample, is_exchange
    INTO v_item
    FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange
    ) VALUES (
      v_new_order_id, v_item.variant_id, v_qty_to_ship, v_qty_to_ship, 0,
      v_item.unit_price, v_qty_to_ship * v_item.unit_price, 'shipped', 'ordered',
      v_qty_to_ship, NOW(), v_item.is_sample, v_item.is_exchange
    );
  END LOOP;

  -- 4) 원본 주문 refresh
  PERFORM refresh_order_revenue(p_original_order_id);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB) TO authenticated;
