-- ============================================================
-- 111: process_pending_ship — 미송/보류 분리 + order_source 분기
--
-- 사장 모델 (회의 2026-05-03 Step 2):
--   미송 derived 주문: order_source='backorder_ship' → 영수증 API 가 미발송 양식 자동 선택
--   보류 derived 주문: order_source='hold_ship'     → 영수증 API 가 오더전표 양식 자동 선택
--
-- 변경:
--   시그니처 (UUID, UUID, JSONB) → (UUID, UUID, JSONB, TEXT)
--   p_kind ('backorder' | 'hold') 인자 추가.
--   호출자 (handleProcess) 가 batch 별로 분리 호출 — 한 호출 안에 미송과 보류 섞이지 않음.
--
-- 검증:
--   items 의 process_type 모두 p_kind 와 일치하는지 검사. 다르면 에러.
--   기존 'pending_ship' order_source 는 옛 derived 주문 — API 폴백이 미발송 양식 사용.
--
-- 외상/매출 흐름:
--   - 변화 0. revenue 분리 (105) 그대로 — 보류만 인식.
--   - 107 안전망 그대로 — derived 주문에 refresh SKIP.
--   - 영수증 박제 (issue_receipt_snapshot) 그대로 — idempotent.
-- ============================================================

DROP FUNCTION IF EXISTS process_pending_ship(UUID, UUID, JSONB);

CREATE OR REPLACE FUNCTION process_pending_ship(
  p_tenant_id          UUID,
  p_original_order_id  UUID,
  p_item_qty           JSONB,
  p_kind               TEXT  -- 'backorder' | 'hold'
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total            NUMERIC := 0;
  v_qty              INT     := 0;
  v_revenue          NUMERIC := 0;
  v_sales_qty        INT     := 0;
  v_payload          JSONB;
  v_item             RECORD;
  v_qty_to_ship      INT;
  v_balance_before   NUMERIC;
  v_order_source     TEXT;
  v_suffix           TEXT;
  v_memo_label       TEXT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_kind NOT IN ('backorder', 'hold') THEN
    RAISE EXCEPTION 'p_kind 는 backorder 또는 hold 만 허용. 받은: %', p_kind
      USING ERRCODE = 'P0001';
  END IF;

  v_order_source := p_kind || '_ship';                       -- backorder_ship / hold_ship
  v_suffix       := CASE p_kind WHEN 'hold' THEN 'O' ELSE 'S' END;  -- O=오더(보류), S=미송
  v_memo_label   := CASE p_kind WHEN 'hold' THEN '보류 출고' ELSE '미송 출고' END;

  SELECT customer_id, customer_name, payment_method, order_number, order_type
  INTO v_orig
  FROM orders WHERE id = p_original_order_id AND tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '원본 주문을 찾을 수 없습니다 (%)', p_original_order_id
      USING ERRCODE = 'P0001';
  END IF;

  SELECT outstanding_balance INTO v_balance_before
  FROM customers WHERE id = v_orig.customer_id;

  -- 1) 각 item 처리: 모두 같은 process_type (p_kind) 검증
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
    IF v_item.process_type <> p_kind THEN
      RAISE EXCEPTION 'item 의 process_type (%) 가 p_kind (%) 와 다릅니다 — handleProcess batch 분리 확인 필요',
        v_item.process_type, p_kind USING ERRCODE = 'P0001';
    END IF;

    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := v_qty_to_ship,
      p_order_item_id := v_item.id,
      p_close         := v_qty_to_ship >= v_item.remaining_qty
    );

    v_total := v_total + (v_qty_to_ship * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_ship;

    -- 보류만 매출/판매로 인식 (미송은 원본에서 이미 인식됨)
    IF p_kind = 'hold' THEN
      v_revenue   := v_revenue + (v_qty_to_ship * v_item.unit_price);
      v_sales_qty := v_sales_qty + v_qty_to_ship;
    END IF;
  END LOOP;

  -- 2) 신규 derived 주문 생성 (order_source 분기)
  v_new_order_number := v_orig.order_number || '-' || v_suffix
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
    v_order_source, 'shipped', v_orig.payment_method, 'unpaid',
    v_total, 0, 0, 0,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    v_memo_label || ' (원본: ' || v_orig.order_number || ')'
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

  -- 4) 원본 주문 refresh — 보류면 외상 +X, 미송이면 변동 X
  PERFORM refresh_order_revenue(p_original_order_id);

  -- 5) 영수증 박제 (109: 결제수단/derived 분기 자동)
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB, TEXT) TO authenticated;
