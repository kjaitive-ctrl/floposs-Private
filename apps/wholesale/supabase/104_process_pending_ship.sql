-- ============================================================
-- 104: 영수증 v2 Phase 2 — 미송/보류 출고 시 신규 derived 주문 자동 생성
--
-- 사장 모델 (회의 2026-05-03):
--   영수증 = 주문 1:1. 미송/보류 출고 시점에 거래처가 받아갈 영수증이 필요함.
--   → 신규 주문 자동 생성하여 derived_from_order_id 로 원본 연결.
--   영수증 박제는 Phase 3 에서 (issue_receipt_snapshot RPC).
--
-- 외상 처리 정책 (064 refresh_order_revenue 와 자연 정합):
--   - 미송→출고: 원본 주문 refresh 시 revenue 변화 X = 외상 변화 X (이미 잡힘)
--   - 보류→출고: 원본 주문 refresh 시 revenue +X = 외상 +X (이때 처음 잡힘)
--   - derived 주문은 transactions/외상 처리 X (원본 주문이 자연 처리)
--
-- derived 주문 = 영수증 발행/표시 목적의 가상 주문.
--   - revenue/sales_qty/confirmed_amount 직접 채움 (refresh 호출 X)
--   - transactions INSERT 안 함 (매출 박제는 원본 주문에서)
--
-- Phase 3 안전망 예정: refresh_order_revenue 안에 derived_from_order_id 분기.
--   현재는 process_pending_ship 가 derived 주문에 refresh 호출 안 함으로 회피.
-- ============================================================

CREATE OR REPLACE FUNCTION process_pending_ship(
  p_tenant_id          UUID,
  p_original_order_id  UUID,
  p_item_qty           JSONB  -- [{"item_id": "uuid", "qty": 5}, ...]
)
RETURNS UUID  -- 신규 derived 주문 id
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total            NUMERIC := 0;
  v_qty              INT := 0;
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

    -- deduct_inventory: 재고 차감 + 원본 order_item.shipped_qty 증가 + remaining_qty 감소
    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := v_qty_to_ship,
      p_order_item_id := v_item.id,
      p_close         := v_qty_to_ship >= v_item.remaining_qty
    );

    v_total := v_total + (v_qty_to_ship * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_ship;
  END LOOP;

  -- 2) 신규 derived 주문 생성 (영수증 발행 목적)
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
    v_qty, v_total, v_total, v_qty,
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

  -- 4) 원본 주문 refresh — 매출/외상 자연 처리
  --    - 미송→출고: revenue 변화 X (미송이 출고로 바뀐 합산 동일) → 외상 변화 X
  --    - 보류→출고: revenue +X (보류는 매출 합산 제외였으나 출고는 포함) → 외상 +X
  PERFORM refresh_order_revenue(p_original_order_id);

  -- derived 주문에 refresh 호출 안 함 (외상 이중 계산 방지)
  -- derived 주문의 revenue/sales_qty 등은 위에서 직접 INSERT 됨

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB) TO authenticated;
