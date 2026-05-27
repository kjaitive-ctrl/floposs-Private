-- ============================================================
-- 145: refresh_order_revenue 가 sample_convert SKIP + 142 영수증 가드 복원
--
-- 두 가지 fix:
--
-- A. sample_convert 더블 박제 (사장 보고 2026-05-07):
--    샘플 1건(3장 30,000) 현금 결제 → 입출금에 판매 행 3개 (10k+10k+30k = 50k) ❌
--    기대: 판매 행 1개 30,000.
--
-- 원인 (136 RPC 설계 결함):
--   convert_samples_bulk 가 신규 주문을 derived_from_order_id=NULL 로 INSERT.
--   refresh_order_revenue 의 derived SKIP 가드 (line 50-53) 가 안 걸림.
--   → order_items 다건 INSERT 마다 trg refresh 발동 →
--     · item 1 INSERT: revenue 10k 로 덮어쓰기 (pre-stored 30k 사라짐), v_increment=0
--     · item 2 INSERT: v_prev_revenue=10k, v_revenue=20k → v_increment=10k → INSERT 10k ❌
--     · item 3 INSERT: v_prev_revenue=20k, v_revenue=30k → v_increment=10k → INSERT 10k ❌
--   + RPC 가 직접 INSERT 한 30k = 총 3행, SUM 50k.
--   132 sync trigger 가 customers.outstanding_balance 를 50k 로 동기화 → 잔액 20k 과대.
--
-- 비교 (안 깨진 흐름):
--   process_pending_ship 은 derived_from_order_id 를 세팅 → SKIP 가드에 걸림 → trigger no-op.
--
--    해결: refresh_order_revenue 의 SKIP 가드에 order_source='sample_convert' 추가.
--          sample_convert 는 RPC 가 모든 박제 직접 책임 — 136 설계 그대로.
--
--    Cleanup: 기존 sample_convert 주문들의 transactions(shipment) 다중 박제 정리.
--             132 sync trigger 가 COMMIT 시 customers.outstanding_balance 자동 정정.
--
-- B. 142 영수증 가드 회귀 (2026-05-07):
--    이전 145 작성 시 138 코드 베이스로 했고 142 의 (v_has_shipped OR v_revenue > 0)
--    가드를 빠뜨림. 결과 보류 등록 (revenue=0, shipped=0) 도 영수증 박제됨 → 영수증
--    list 에 잘못 노출. 142 가드 복원 + 기존 잘못 박제된 보류 영수증 cleanup.
--
--    영수증 박제 정책 (사장 2026-05-06):
--    - 일반 출고 (shipped>0): O
--    - 미송 등록 (shipped=0, revenue>0): O (매출/외상 인식 → 흔적 필요)
--    - 보류 등록 (shipped=0, revenue=0): X (단순 pending)
--    - 샘플 출고 (shipped>0, revenue=0): O (양식: 샘플 전표)
-- ============================================================

-- ── 1) refresh_order_revenue 재정의 ─────────────────────────
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
BEGIN
  -- 107 + 145 안전망: derived 주문 + sample_convert 모두 SKIP
  -- (RPC 가 직접 박제 — refresh 가 추가로 건드리면 다중 박제 발생)
  SELECT derived_from_order_id, order_source
  INTO v_derived_from, v_order_source
  FROM orders WHERE id = p_order_id;
  IF v_derived_from IS NOT NULL THEN RETURN; END IF;
  IF v_order_source = 'sample_convert' THEN RETURN; END IF;

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

  -- 142 가드 — 영수증 박제 조건 = v_has_shipped OR v_revenue > 0 (보류 등록 차단용)
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

  -- 첫 처리 분기 — 매출/transactions/외상 박제는 v_revenue > 0 일 때만
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

  -- 영수증 박제 — 142 정책 복원: 첫 처리 시 + (실물 출고 OR 매출 인식)
  -- 사장 정책 (2026-05-06):
  --   - 일반 출고 (v_has_shipped=T): O
  --   - 미송 등록 (v_revenue>0): O (매출 인식 → 영수증 흔적 필요)
  --   - 보류 등록 (둘 다 0): X (123 패치로 hold revenue=0, 단순 pending)
  --   - 샘플 출고 (v_has_shipped=T, revenue=0): O (양식: 샘플 전표)
  IF v_is_processed AND NOT v_prev_processed AND (v_has_shipped OR v_revenue > 0) THEN
    PERFORM issue_receipt_snapshot(p_order_id, v_old_balance::NUMERIC);
  END IF;

  -- v_increment 분기
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


-- ── 2) Cleanup — 기존 sample_convert 주문의 다중 shipment 박제 정리 ──
--
-- 정합 상태: sample_convert 주문 1건당 transactions(shipment) 1행, amount=orders.total_amount.
-- 132 sync trigger 가 COMMIT 시 customers.outstanding_balance 자동 정정.

-- ── 3) Cleanup — 보류만 등록된 주문에 잘못 박제된 receipt_no 정리 ──
-- 142 정책: 보류 등록은 영수증 박제 X. 138 회귀로 145(이전버전)/138 적용 환경에서 박제됐을 가능성.
UPDATE orders
SET receipt_no              = NULL,
    receipt_issued_at       = NULL,
    receipt_prev_balance    = NULL,
    receipt_day_total       = NULL,
    receipt_payment_method  = NULL,
    receipt_payment_amount  = NULL,
    receipt_post_balance    = NULL,
    receipt_print_count     = 0,
    receipt_last_printed_at = NULL
WHERE receipt_no IS NOT NULL
  AND derived_from_order_id IS NULL
  AND revenue = 0
  AND NOT EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = orders.id AND shipped_qty > 0
  )
  AND EXISTS (
    SELECT 1 FROM order_items
    WHERE order_id = orders.id AND process_type = 'hold' AND status = 'unshipped'
  );

DO $$
DECLARE
  v_order RECORD;
  v_existing_count INT;
  v_existing_sum NUMERIC;
BEGIN
  FOR v_order IN
    SELECT o.id, o.tenant_id, o.customer_id, o.payment_method,
           o.total_amount, o.created_at
    FROM orders o
    WHERE o.order_source = 'sample_convert'
  LOOP
    SELECT COUNT(*), COALESCE(SUM(amount), 0)
    INTO v_existing_count, v_existing_sum
    FROM transactions
    WHERE order_id = v_order.id AND source = 'shipment';

    -- 1건 + amount 정합이면 그대로 둠
    CONTINUE WHEN v_existing_count = 1 AND v_existing_sum = v_order.total_amount;

    -- 그 외 — 모두 삭제 후 단일 행 재박제
    DELETE FROM transactions
    WHERE order_id = v_order.id AND source = 'shipment';

    INSERT INTO transactions (
      tenant_id, customer_id, source, type, method,
      amount, transaction_date, order_id
    ) VALUES (
      v_order.tenant_id, v_order.customer_id, 'shipment', 'receivable',
      v_order.payment_method, v_order.total_amount,
      v_order.created_at::DATE, v_order.id
    );

    RAISE NOTICE 'Cleaned sample_convert order %: % rows (sum %) → 1 row (%)',
      v_order.id, v_existing_count, v_existing_sum, v_order.total_amount;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
