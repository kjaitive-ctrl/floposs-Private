-- ============================================================
-- 137: process_pending_ship — 샘플 라인 매출/외상/영수증 인식 차단
--
-- 사장 보고 (2026-05-06):
--   샘플 주문 → [보류] 처리 → [당일] 출고 시
--   "판매/외상 기록되었고 영수증 박제됨" (영수증 기준 탭에 뜸)
--
-- 원인:
--   124 process_pending_ship 의 hold 분기에서 v_revenue/v_sales_qty 누적 시
--   is_sample 검사 없음 → 샘플 라인도 매출로 잡힘 → derived 주문에 박제 →
--   transactions/외상/영수증 모두 발생.
--
--   refresh_order_revenue (123) 는 is_sample 제외하지만 124 RPC 는 직접 박제.
--   123 패치가 일반 흐름만 커버하고 124 직접 박제 흐름은 누락.
--
-- 수정:
--   1) v_revenue/v_sales_qty 누적 시 v_item.is_sample 제외 (hold 분기)
--   2) issue_receipt_snapshot 호출 조건 — 모든 라인이 샘플이면 SKIP
--      (receipt_no 박제 X → 영수증 기준 탭에 안 뜸. 샘플 출력은 별도 액션)
--   3) v_total/v_qty 는 그대로 (전체 합계 — 샘플 전표 표시용)
--
-- 정합 보존:
--   - 일반 backorder / 일반 hold derived: v_revenue/매출/영수증 그대로
--   - backorder derived (v_revenue=0): issue_receipt_snapshot 호출됨 (
--     모든 라인이 샘플이 아닌 한). 잔액 변동 없는 영수증.
--   - 샘플 hold derived: v_revenue=0, transactions X, 외상 X, receipt_no NULL.
--     deduct_inventory 만 호출 (재고 차감). 사장 의도 충족.
--   - 132 sync trigger: derived 주문에 transactions 가 없으면 outstanding=0 으로
--     자동 동기화 (정합 OK).
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
  v_has_non_sample      BOOLEAN := FALSE;
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

  -- 1) 각 item 처리
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
      RAISE EXCEPTION 'item process_type (%) != p_kind (%)', v_item.process_type, p_kind
        USING ERRCODE = 'P0001';
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

    IF NOT v_item.is_sample THEN
      v_has_non_sample := TRUE;
    END IF;

    -- 보류만 매출/판매로 인식 (미송은 원본에서 이미 인식됨).
    -- 샘플 라인은 hold 라도 매출 인식 X (사장 모델: 샘플 = 매출/외상/영수증 무관).
    IF p_kind = 'hold' AND NOT v_item.is_sample THEN
      v_revenue   := v_revenue + (v_qty_to_ship * v_item.unit_price);
      v_sales_qty := v_sales_qty + v_qty_to_ship;
    END IF;
  END LOOP;

  -- 2) hold derived 는 외상 잡음 (샘플만 있으면 v_revenue=0 → 외상 0)
  v_initial_outstanding := CASE WHEN p_kind = 'hold' THEN v_revenue ELSE 0 END;

  -- 3) 신규 derived 주문 생성
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
    v_total, 0, 0, v_initial_outstanding,
    p_original_order_id, true, false,
    v_sales_qty, v_revenue, v_revenue, v_qty,
    v_memo_label || ' (원본: ' || v_orig.order_number || ')'
  )
  RETURNING id INTO v_new_order_id;

  -- 4) derived 주문 order_items 복사 (is_sample/is_exchange 그대로)
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

  -- 5) hold derived (비샘플): 외상/transactions/매입금 충당 직접 박제
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

  -- 6) 원본 주문 refresh — hold 출고분 제외(123), backorder 도 합계 동일
  PERFORM refresh_order_revenue(p_original_order_id);

  -- 7) 영수증 박제 — 모든 라인이 샘플이면 SKIP (사장 모델: 샘플은 영수증 X).
  --    비샘플 라인 1개라도 있으면 박제 → 영수증 기준 탭에 뜸 + 양식 자동 분기 (API).
  IF v_has_non_sample THEN
    PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);
  END IF;

  RETURN v_new_order_id;
END;
$$;

GRANT EXECUTE ON FUNCTION process_pending_ship(UUID, UUID, JSONB, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
