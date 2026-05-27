-- ============================================================
-- 146: Phase 7 — process_pending_ship 원본 보존
--
-- 사장 결정 (2026-05-07):
--   미송/보류 출고 시 원본 item 의 shipped_qty 를 박제하지 않는다.
--   = 같은 물리 출고가 원본 + derived 양쪽에 박제되는 더블 카운트 차단.
--
-- 변경 (138 vs 146):
--   기존 138 흐름:
--     for 각 item:
--       deduct_inventory(원본id, qty)  -- ① 재고 -qty + ② 원본 shipped_qty +qty
--     INSERT derived order
--     for 각 item:
--       INSERT derived item (shipped_qty=qty 직접 박제)
--     결과: shipped_qty 가 원본+derived 양쪽 박제 → cross-order SUM 시 더블
--
--   신 146 흐름:
--     for 각 item:
--       검증 + 합계 누적 (deduct_inventory 호출 X)
--     INSERT derived order
--     for 각 item:
--       INSERT derived item (shipped_qty=0, remaining_qty=qty, status='unshipped' 임시)
--       deduct_inventory(derived_item_id, qty, p_close=true)
--         → ① 재고 -qty (동일) + ② derived item shipped_qty=qty 박제
--     원본 item: 일절 mutation 없음 (shipped_qty=0, remaining_qty=quantity, status='unshipped' 유지)
--
-- 재고 영향: 0 (deduct_inventory 호출 횟수 동일, p_qty 동일, inventory.quantity 차감 동일)
-- inventory_logs: 1 이벤트 = 1 행 (동일). order_item_id 만 derived 참조로 시프트.
-- transactions/매출/외상: 영향 X (별개 로직).
-- 영수증 receipt_no 박제: 영향 X (issue_receipt_snapshot 별도).
--
-- 잔량/처리완료 동적 계산:
--   이미 view 126 (order_item_remaining) 이 derived 합산으로 계산. 활용.
--   원본 미송/보류 item 은 영구 unshipped → UI 가 view 의 is_fully_shipped 로 hide 처리.
--
-- 기존 데이터 호환:
--   146 적용 전에 처리된 미송/보류 item 들은 원본 shipped_qty>0 박제된 채로 남음.
--   신규 처리부터 신 모델 적용. 사장 환경 (1인 테스트, 실거래 X) → 옛 데이터 reset 옵션 별도.
--
-- 안전 검증 (마이그 직후):
--   1. SELECT SUM(quantity) FROM inventory; -- 마이그 전후 동일 확인
--   2. SELECT SUM(qty_change) FROM inventory_logs WHERE reason='shipment'; -- 마이그 전후 동일
--   3. 새 미송→출고 1건 manual 테스트:
--      a. inventory.quantity 정확히 -N
--      b. 원본 item.shipped_qty=0 유지 (이전: =N 박제됨)
--      c. derived item.shipped_qty=N 박제 (이전과 동일)
--      d. 영수증 양쪽 정상 (원본=미송 N장, derived=출고 N장)
-- ============================================================

DROP FUNCTION IF EXISTS process_pending_ship(UUID, UUID, JSONB, TEXT);

CREATE OR REPLACE FUNCTION process_pending_ship(
  p_tenant_id          UUID,
  p_original_order_id  UUID,
  p_item_qty           JSONB,
  p_kind               TEXT
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig                RECORD;
  v_new_order_id        UUID;
  v_new_order_number    TEXT;
  v_total               NUMERIC := 0;
  v_qty                 INT     := 0;
  v_revenue             NUMERIC := 0;
  v_sales_qty           INT     := 0;
  v_payload             JSONB;
  v_item                RECORD;
  v_qty_to_ship         INT;
  v_balance_before      NUMERIC;
  v_order_source        TEXT;
  v_suffix              TEXT;
  v_memo_label          TEXT;
  v_initial_outstanding NUMERIC := 0;
  v_credit_used         BIGINT;
  v_derived_item_id     UUID;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_kind NOT IN ('backorder', 'hold') THEN
    RAISE EXCEPTION 'p_kind 는 backorder 또는 hold 만 허용. 받은: %', p_kind
      USING ERRCODE = 'P0001';
  END IF;

  v_order_source := p_kind || '_ship';
  v_suffix       := CASE p_kind WHEN 'hold' THEN 'O' ELSE 'S' END;
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

  -- ── 1단계: 검증 + 합계 누적 (deduct_inventory 호출 X — 원본 보존) ──
  -- 원본 item 의 process_type/잔량 검증만. 재고는 deduct_inventory 가 derived 호출 시 검증.
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;

    -- view 126 (order_item_remaining) 으로 잔량 검증 — derived 합산 차감 후 잔량
    SELECT oi.id, oi.variant_id, oi.unit_price, oi.process_type,
           oi.is_sample, oi.is_exchange,
           v.remaining
    INTO v_item
    FROM order_items oi
    JOIN order_item_remaining v ON v.item_id = oi.id
    WHERE oi.id = (v_payload->>'item_id')::UUID;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'order_item 을 찾을 수 없습니다 (%)', v_payload->>'item_id'
        USING ERRCODE = 'P0001';
    END IF;
    IF v_item.process_type <> p_kind THEN
      RAISE EXCEPTION 'item process_type (%) != p_kind (%)', v_item.process_type, p_kind
        USING ERRCODE = 'P0001';
    END IF;
    IF v_qty_to_ship > v_item.remaining THEN
      RAISE EXCEPTION '출고 수량(%) > 남은 잔량(%) — item %', v_qty_to_ship, v_item.remaining, v_item.id
        USING ERRCODE = 'P0001';
    END IF;

    v_total := v_total + (v_qty_to_ship * v_item.unit_price);
    v_qty   := v_qty + v_qty_to_ship;

    -- 매출/외상 인식 — hold 분기 + 비샘플 라인만 (138 정책 그대로)
    IF p_kind = 'hold' AND NOT v_item.is_sample THEN
      v_revenue   := v_revenue + (v_qty_to_ship * v_item.unit_price);
      v_sales_qty := v_sales_qty + v_qty_to_ship;
    END IF;
  END LOOP;

  v_initial_outstanding := CASE WHEN p_kind = 'hold' THEN v_revenue ELSE 0 END;

  v_new_order_number := v_orig.order_number || '-' || v_suffix
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  -- ── 2단계: derived 주문 INSERT ──
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
    v_total, 0, 0, v_initial_outstanding,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    v_memo_label || ' (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  -- ── 3단계: derived item INSERT + deduct_inventory(derived_item_id) ──
  -- 원본 item 은 일절 건드리지 않음. derived item 만 박제.
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_item_qty)
  LOOP
    v_qty_to_ship := (v_payload->>'qty')::INT;
    SELECT variant_id, unit_price, is_sample, is_exchange
    INTO v_item
    FROM order_items WHERE id = (v_payload->>'item_id')::UUID;

    -- derived item: 출고 전 임시 상태 (shipped_qty=0). deduct_inventory 가 박제할 예정.
    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange
    ) VALUES (
      v_new_order_id, v_item.variant_id, v_qty_to_ship, v_qty_to_ship, v_qty_to_ship,
      v_item.unit_price, v_qty_to_ship * v_item.unit_price, 'unshipped', 'ordered',
      0, NULL, v_item.is_sample, v_item.is_exchange
    )
    RETURNING id INTO v_derived_item_id;

    -- deduct_inventory: 재고 차감 + derived item 의 shipped_qty/remaining_qty/status 갱신
    PERFORM deduct_inventory(
      p_tenant_id     := p_tenant_id,
      p_variant_id    := v_item.variant_id,
      p_qty           := v_qty_to_ship,
      p_order_item_id := v_derived_item_id,    -- ← 원본 id 가 아니라 derived id
      p_close         := true
    );
  END LOOP;

  -- ── 4단계: hold derived 비샘플 — 외상/transactions/매입금 충당 ──
  IF p_kind = 'hold' AND v_revenue > 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id
    ) VALUES (
      p_tenant_id, v_orig.customer_id, 'shipment', 'receivable', v_orig.payment_method,
      v_revenue, CURRENT_DATE, v_new_order_id
    );

    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_revenue
    WHERE id = v_orig.customer_id;

    IF v_balance_before < 0 THEN
      v_credit_used := LEAST(ABS(v_balance_before)::BIGINT, v_revenue::BIGINT);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status
          END
      WHERE id = v_new_order_id;
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        p_tenant_id, v_orig.customer_id, 'credit_apply', 'income', NULL,
        v_credit_used, CURRENT_DATE, v_new_order_id, '매입금 자동 충당'
      );
    END IF;
  END IF;

  -- ── 5단계: 원본 주문 refresh — 원본 자체 정합 (107 가드: derived_from NULL 만 처리) ──
  -- 원본의 매출/외상은 이미 등록 시점 박제. 이 호출은 view 기반 잔량/처리완료 마킹 시 사용 가능.
  -- 단 138 호환을 위해 그대로 호출 유지.
  PERFORM refresh_order_revenue(p_original_order_id);

  -- ── 6단계: 영수증 박제 (138 정책 그대로) ──
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
