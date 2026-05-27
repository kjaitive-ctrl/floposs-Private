-- ============================================================
-- 148: 미송 해제 박제 원칙 정합 — receipt 박제 보존 + derived 음수 라인 (단순화 v2)
--
-- 사장 원칙 (2026-05-07, 진단 후 재정의):
--   비가역 (박제):  receipt_no, revenue, confirmed_amount  ← refresh receipt 가드로 보존
--   가변 (working): remaining_qty, status                  ← legacy 와 동일 mutate 허용
--   별개 박제:      derived order + items (음수)            ← 영수증 list 흐름 추적
--
-- 사장 멘탈 모델 유지:
--   "영수증 list 만 봐도 흐름 추적 가능해야"
--   +90K 미송 등록 → +30K 출고 derived → -60K 해제 derived
--   원본 영수증 박제값 (revenue/confirmed_amount) 영구 보존 → list 에서 +90K 흔적 영원
--
-- 시도했던 "원본 100% 보존" 모델 철회 이유:
--   - 원본 remaining_qty 영구 = quantity 면 미송·보류 탭에서 처리 후도 잔존 표시
--   - view 126 의존 → partial ship (146 미적용) 시 view double-count 로 행 잘못 hide
--   - 호환성 깨짐. 단순 status+remaining_qty 가드와 어긋남.
--   결론: 박제값과 working state 분리. 박제값만 보존, working state 는 legacy 로.
--
-- 변경 2가지:
--
-- A. refresh_order_revenue: receipt_no IS NOT NULL 원본 SKIP 가드 추가
--    → revenue/confirmed_amount/sales_qty 등 등록 시점 박제값 영구 보존.
--
-- B. process_release_for_customer 재구성:
--    - 원본 remaining_qty 차감 + status='shipped' if remaining=0 (legacy 호환)
--    - 재고 차감 X (release 는 미송 취소이지 출고 아님)
--    - derived order 음수 박제 (총 매출/외상)
--    - derived order_items INSERT (양수 quantity, 부모 source='backorder_release' → 음수 표시)
--    - 멀티 클릭 안전 (clamp + remaining=0 시 skip)
--
-- 호환성:
--    - 132 sync trigger / inventory / 매출 통계: 영향 X
--    - 미송·보류 탭 filter: 단순 status+remaining_qty 로 정합 (view 의존 X)
--    - partial ship (146 미적용): 영향 X (process_pending_ship 그대로)
--    - 사장 박제 원칙: revenue/confirmed_amount/receipt_no 보존됨 ← 핵심
-- ============================================================


-- ── A) refresh_order_revenue: receipt_no 가드 추가 ──────────
-- 145 의 함수 본체 그대로 + receipt 가드만 SKIP 분기 추가
CREATE OR REPLACE FUNCTION refresh_order_revenue(p_order_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_sales_qty        INT;
  v_revenue          BIGINT;
  v_confirmed_amount BIGINT;
  v_order_qty        INT;
  v_is_processed     BOOLEAN;
  v_has_pending      BOOLEAN;
  v_prev_processed   BOOLEAN;
  v_prev_revenue     BIGINT;
  v_tenant_id        UUID;
  v_customer_id      UUID;
  v_payment_method   TEXT;
  v_payment_status   TEXT;
  v_increment        BIGINT;
  v_old_balance      NUMERIC;
  v_credit_used      BIGINT;
  v_derived_from     UUID;
  v_order_source     TEXT;
  v_has_shipped      BOOLEAN;
  v_receipt_no       TEXT;
BEGIN
  -- 107 + 145 안전망: derived 주문 + sample_convert 모두 SKIP
  SELECT derived_from_order_id, order_source, receipt_no
  INTO v_derived_from, v_order_source, v_receipt_no
  FROM orders WHERE id = p_order_id;
  IF v_derived_from IS NOT NULL THEN RETURN; END IF;
  IF v_order_source = 'sample_convert' THEN RETURN; END IF;

  -- 148: 영수증 박제된 원본은 SKIP — 등록 시점 박제 영구 보존 (사장 원칙)
  IF v_receipt_no IS NOT NULL THEN RETURN; END IF;

  SELECT is_processed, tenant_id, customer_id, payment_method, payment_status, revenue
  INTO v_prev_processed, v_tenant_id, v_customer_id, v_payment_method, v_payment_status, v_prev_revenue
  FROM orders WHERE id = p_order_id;

  SELECT outstanding_balance INTO v_old_balance
  FROM customers WHERE id = v_customer_id AND tenant_id = v_tenant_id;

  SELECT
    COALESCE(SUM(CASE
      WHEN process_type IN ('ordered', 'backorder')
        AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
      THEN shipped_qty ELSE 0 END), 0)
      + COALESCE(SUM(CASE
          WHEN process_type = 'backorder' AND status = 'unshipped'
            AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
          THEN remaining_qty ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN process_type IN ('ordered', 'backorder')
        AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
      THEN shipped_qty * unit_price ELSE 0 END), 0)
      + COALESCE(SUM(CASE
          WHEN process_type = 'backorder' AND status = 'unshipped'
            AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
          THEN remaining_qty * unit_price ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
      THEN shipped_qty * unit_price ELSE 0 END), 0)
      + COALESCE(SUM(CASE
          WHEN process_type IN ('backorder', 'hold') AND status = 'unshipped'
            AND NOT COALESCE(is_exchange, FALSE) AND NOT COALESCE(is_sample, FALSE)
          THEN remaining_qty * unit_price ELSE 0 END), 0),
    COALESCE(SUM(quantity), 0),
    NOT EXISTS (
      SELECT 1 FROM order_items
      WHERE order_id = p_order_id
        AND process_type = 'ordered'
        AND status = 'unshipped'
    ),
    EXISTS (
      SELECT 1 FROM order_items
      WHERE order_id = p_order_id
        AND process_type IN ('backorder', 'hold')
        AND status = 'unshipped'
    )
  INTO v_sales_qty, v_revenue, v_confirmed_amount, v_order_qty, v_is_processed, v_has_pending
  FROM order_items
  WHERE order_id = p_order_id;

  -- 142 가드 — 영수증 박제 조건
  SELECT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = p_order_id AND shipped_qty > 0
  ) INTO v_has_shipped;

  v_increment := CASE
    WHEN v_is_processed AND v_prev_processed AND v_revenue > v_prev_revenue
    THEN v_revenue - v_prev_revenue
    ELSE 0
  END;

  UPDATE orders
  SET sales_qty        = v_sales_qty,
      revenue          = v_revenue,
      confirmed_amount = v_confirmed_amount,
      order_qty        = v_order_qty,
      is_processed     = v_is_processed,
      has_pending      = v_has_pending,
      payment_status   = CASE WHEN v_increment > 0 THEN 'unpaid' ELSE payment_status END,
      outstanding_amount = CASE
        WHEN v_is_processed AND NOT v_prev_processed AND v_payment_status = 'unpaid' THEN v_revenue
        WHEN v_increment > 0 THEN outstanding_amount + v_increment
        ELSE outstanding_amount
      END
  WHERE id = p_order_id;

  IF v_is_processed AND NOT v_prev_processed AND v_revenue > 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id
    ) VALUES (
      v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method,
      v_revenue, CURRENT_DATE, p_order_id
    );
    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_revenue
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;

    IF v_old_balance < 0 THEN
      v_credit_used := LEAST(ABS(v_old_balance)::BIGINT, v_revenue);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status
          END
      WHERE id = p_order_id;
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL,
        v_credit_used, CURRENT_DATE, p_order_id, '매입금 자동 충당'
      );
    END IF;
  END IF;

  -- 영수증 박제 — 142 정책 (보류 등록 차단)
  IF v_is_processed AND NOT v_prev_processed AND (v_has_shipped OR v_revenue > 0) THEN
    PERFORM issue_receipt_snapshot(p_order_id, v_old_balance::NUMERIC);
  END IF;

  IF v_increment > 0 THEN
    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id
    ) VALUES (
      v_tenant_id, v_customer_id, 'shipment', 'receivable', v_payment_method,
      v_increment, CURRENT_DATE, p_order_id
    );
    UPDATE customers
    SET outstanding_balance = outstanding_balance + v_increment
    WHERE id = v_customer_id AND tenant_id = v_tenant_id;

    IF v_old_balance < 0 THEN
      v_credit_used := LEAST(ABS(v_old_balance)::BIGINT, v_increment);
      UPDATE orders
      SET paid_amount        = COALESCE(paid_amount, 0) + v_credit_used,
          outstanding_amount = GREATEST(0, outstanding_amount - v_credit_used),
          payment_status     = CASE
            WHEN outstanding_amount - v_credit_used <= 0 THEN 'paid'
            WHEN v_credit_used > 0 THEN 'partial'
            ELSE payment_status
          END
      WHERE id = p_order_id;
      INSERT INTO transactions (
        tenant_id, customer_id, source, type, method,
        amount, transaction_date, order_id, description
      ) VALUES (
        v_tenant_id, v_customer_id, 'credit_apply', 'income', NULL,
        v_credit_used, CURRENT_DATE, p_order_id, '매입금 자동 충당'
      );
    END IF;
  END IF;
END;
$$;


-- ── B) process_release_for_customer: 원본 mutation + derived 음수 라인 INSERT ──
-- 사장 원칙 재정의 (2026-05-07):
--   영수증 박제값 (receipt_no/revenue/confirmed_amount) = 비가역 ← refresh receipt 가드로 보존
--   working state (remaining_qty/status) = 잔량 추적용 ← mutate 허용 (legacy + 단순 filter 호환)
--   derived 음수 라인 = 영수증 양식 음수 표시용 (사장 박제 원칙: 이벤트 따로 박제)
CREATE OR REPLACE FUNCTION process_release_for_customer(
  p_tenant_id   UUID,
  p_customer_id UUID,
  p_items       JSONB
) RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_orig             RECORD;
  v_new_order_id     UUID;
  v_new_order_number TEXT;
  v_total_amount     NUMERIC := 0;
  v_total_qty        INT     := 0;
  v_balance_before   NUMERIC;
  v_payload          JSONB;
  v_item_id          UUID;
  v_qty              INT;
  v_item             RECORD;
  v_first_order_id   UUID;
  v_clamped          JSONB := '[]'::JSONB;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_items IS NULL OR jsonb_array_length(p_items) = 0 THEN
    RETURN json_build_object('success', false, 'error', '항목이 비어있습니다.');
  END IF;

  -- 첫 항목으로 원본 주문 정보 (영수증 메타용)
  SELECT o.id AS order_id, o.customer_name, o.payment_method, o.order_number, o.order_type
  INTO v_orig
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE oi.id = (p_items->0->>'item_id')::UUID
    AND o.tenant_id = p_tenant_id
    AND o.customer_id = p_customer_id;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', '첫 항목을 찾을 수 없습니다.');
  END IF;
  v_first_order_id := v_orig.order_id;

  SELECT outstanding_balance INTO v_balance_before
  FROM customers WHERE id = p_customer_id;

  -- ── 단일 loop: 검증 + clamp + 원본 mutate + clamped payload 저장 ──
  FOR v_payload IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_item_id := (v_payload->>'item_id')::UUID;
    v_qty     := (v_payload->>'qty')::INT;

    SELECT oi.id, oi.variant_id, oi.unit_price, oi.process_type, oi.is_sample, oi.is_exchange,
           oi.remaining_qty, o.customer_id
    INTO v_item
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE oi.id = v_item_id AND o.tenant_id = p_tenant_id;

    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_item.process_type NOT IN ('backorder', 'hold') THEN CONTINUE; END IF;
    IF v_item.customer_id <> p_customer_id THEN CONTINUE; END IF;
    IF v_item.remaining_qty <= 0 THEN CONTINUE; END IF;

    -- clamp
    IF v_qty > v_item.remaining_qty THEN v_qty := v_item.remaining_qty; END IF;
    IF v_qty <= 0 THEN CONTINUE; END IF;

    -- 원본 mutation (remaining_qty 차감 + 0이면 close)
    UPDATE order_items
    SET remaining_qty = GREATEST(0, remaining_qty - v_qty),
        status = CASE WHEN GREATEST(0, remaining_qty - v_qty) = 0 THEN 'shipped' ELSE status END,
        updated_at = NOW()
    WHERE id = v_item_id;

    -- backorder 만 derived 라인 + 음수 매출 합산 (보류는 매출 인식 X)
    IF v_item.process_type = 'backorder' THEN
      v_total_amount := v_total_amount + (v_qty * v_item.unit_price);
      v_total_qty    := v_total_qty + v_qty;
      v_clamped := v_clamped || jsonb_build_object(
        'item_id',   v_item_id,
        'qty',       v_qty,
        'variant_id', v_item.variant_id,
        'unit_price', v_item.unit_price,
        'is_sample',  v_item.is_sample,
        'is_exchange', v_item.is_exchange
      );
    END IF;
  END LOOP;

  IF v_total_amount <= 0 THEN
    RETURN json_build_object('success', true, 'new_order_id', NULL, 'amount', 0, 'count', 0);
  END IF;

  -- derived 주문 INSERT (음수 부호 매출/외상)
  v_new_order_number := v_orig.order_number || '-R'
    || substr(replace(gen_random_uuid()::text, '-', ''), 1, 4);

  INSERT INTO orders (
    tenant_id, customer_id, customer_name, order_number, order_type,
    order_source, status, payment_method, payment_status,
    total_amount, vat_amount, paid_amount, outstanding_amount,
    derived_from_order_id, is_processed, has_pending,
    sales_qty, revenue, confirmed_amount, order_qty,
    memo
  ) VALUES (
    p_tenant_id, p_customer_id, v_orig.customer_name, v_new_order_number,
    COALESCE(v_orig.order_type, 'wholesale'),
    'backorder_release', 'shipped', v_orig.payment_method, 'paid',
    -v_total_amount, 0, 0, -v_total_amount,
    v_first_order_id, true, false,
    -v_total_qty, -v_total_amount, -v_total_amount, v_total_qty,
    '미송해제 (' || v_total_qty || '개)'
  )
  RETURNING id INTO v_new_order_id;

  -- derived order_items INSERT — clamped payload 사용 (loop 1 에서 collected)
  FOR v_payload IN SELECT * FROM jsonb_array_elements(v_clamped)
  LOOP
    v_qty := (v_payload->>'qty')::INT;
    INSERT INTO order_items (
      order_id, variant_id, quantity, original_quantity, remaining_qty,
      unit_price, total_price, status, process_type,
      shipped_qty, shipped_at, is_sample, is_exchange
    ) VALUES (
      v_new_order_id,
      (v_payload->>'variant_id')::UUID,
      v_qty, v_qty, 0,
      (v_payload->>'unit_price')::NUMERIC,
      v_qty * (v_payload->>'unit_price')::NUMERIC,
      'shipped', 'ordered',
      v_qty, NOW(),
      (v_payload->>'is_sample')::BOOLEAN,
      (v_payload->>'is_exchange')::BOOLEAN
    );
  END LOOP;

  -- 외상 차감 (manual + transactions, 132 sync trigger 정합)
  UPDATE customers
  SET outstanding_balance = outstanding_balance - v_total_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, order_id, description
  ) VALUES (
    p_tenant_id, p_customer_id, 'shipment', 'receivable', v_orig.payment_method,
    -v_total_amount, CURRENT_DATE, v_new_order_id, '미송해제'
  );

  -- 영수증 박제 (109 issue_receipt_snapshot 의 derived 분기: post = prev + revenue 음수)
  PERFORM issue_receipt_snapshot(v_new_order_id, v_balance_before);

  RETURN json_build_object(
    'success',          true,
    'new_order_id',     v_new_order_id,
    'new_order_number', v_new_order_number,
    'amount',           -v_total_amount,
    'count',            v_total_qty
  );
END;
$$;

GRANT EXECUTE ON FUNCTION process_release_for_customer(UUID, UUID, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';
