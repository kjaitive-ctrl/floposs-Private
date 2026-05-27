-- ============================================================
-- 084: 운영 DB only RPC 박제 + JWT cross-tenant 가드 + 재고 검증
--
-- 배경:
--   068 와 동일 패턴 — 운영 DB 에 존재하지만 마이그레이션 SQL 파일이
--   누락된 RPC 들. dump 결과를 SQL 파일로 박제 + 모든 RPC 첫 줄에
--   PERFORM assert_tenant_access(...) 호출 추가.
--
--   deduct_inventory 5인자 (BOOLEAN p_close) 버전에는 재고 부족 시
--   RAISE EXCEPTION 추가 (출고처리 시 재고 0 인 상품도 출고되던 버그 fix).
--
-- 함수 목록:
--   apply_purchase_credit, process_payment, process_refund, process_status,
--   deduct_inventory (3인자, 4인자×2 오버로드, 5인자 BOOLEAN — 4개 모두)
--
-- deduct_inventory 오버로드 정책:
--   현 코드 (orders/page.tsx) 는 5인자 BOOLEAN 버전만 호출.
--   다른 3 개 오버로드는 legacy 추정. 외부 anon 호출 시 우회 막기 위해
--   모두 가드 추가. 사용 안 하는 오버로드 DROP 은 별도 작업.
-- ============================================================

-- ── apply_purchase_credit ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_purchase_credit(
  p_tenant_id uuid, p_customer_id uuid, p_order_id uuid
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_balance     BIGINT;
  v_outstanding BIGINT;
  v_apply       BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  SELECT outstanding_balance INTO v_balance
  FROM customers WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  IF v_balance >= 0 THEN RETURN 0; END IF;

  SELECT outstanding_amount INTO v_outstanding
  FROM orders WHERE id = p_order_id AND tenant_id = p_tenant_id;

  IF v_outstanding <= 0 THEN RETURN 0; END IF;

  v_apply := LEAST(ABS(v_balance), v_outstanding);

  UPDATE orders
  SET outstanding_amount = outstanding_amount - v_apply,
      payment_status = CASE
        WHEN outstanding_amount - v_apply <= 0 THEN 'paid'
        ELSE 'partial'
      END
  WHERE id = p_order_id AND tenant_id = p_tenant_id;

  UPDATE customers
  SET outstanding_balance = outstanding_balance + v_apply
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date, order_id
  ) VALUES (
    p_tenant_id, p_customer_id, 'purchase', 'income', 'credit',
    v_apply, CURRENT_DATE, p_order_id
  );

  RETURN v_apply;
END;
$function$;


-- ── process_payment ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_payment(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text,
  p_source text, p_order_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_remaining BIGINT := p_amount;
  v_order     RECORD;
  v_apply     BIGINT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  -- 거래처 총 미수금 차감
  UPDATE customers
  SET outstanding_balance = outstanding_balance - p_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  -- transaction 생성
  INSERT INTO transactions (tenant_id, customer_id, source, type, method, amount, transaction_date, order_id)
  VALUES (p_tenant_id, p_customer_id, p_source, 'income', p_method, p_amount, CURRENT_DATE, p_order_id);

  -- 주문별 outstanding_amount 차감
  IF p_order_id IS NOT NULL THEN
    -- 당일처리: 특정 주문서에 직접 적용
    UPDATE orders
    SET outstanding_amount = GREATEST(0, outstanding_amount - p_amount),
        payment_status = CASE
          WHEN outstanding_amount - p_amount <= 0 THEN 'paid'
          ELSE 'partial'
        END
    WHERE id = p_order_id AND tenant_id = p_tenant_id;
  ELSE
    -- FIFO: created_at ASC 순으로 미결 주문부터 차감
    FOR v_order IN
      SELECT id, outstanding_amount
      FROM orders
      WHERE customer_id = p_customer_id
        AND tenant_id   = p_tenant_id
        AND payment_status != 'paid'
        AND outstanding_amount > 0
      ORDER BY created_at ASC
    LOOP
      EXIT WHEN v_remaining <= 0;
      v_apply := LEAST(v_remaining, v_order.outstanding_amount);
      UPDATE orders
      SET outstanding_amount = outstanding_amount - v_apply,
          payment_status = CASE
            WHEN outstanding_amount - v_apply <= 0 THEN 'paid'
            ELSE 'partial'
          END
      WHERE id = v_order.id;
      v_remaining := v_remaining - v_apply;
    END LOOP;
  END IF;
END;
$function$;


-- ── process_refund ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_refund(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  UPDATE customers
  SET outstanding_balance = outstanding_balance + p_amount
  WHERE id = p_customer_id AND tenant_id = p_tenant_id;

  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method,
    amount, transaction_date
  ) VALUES (
    p_tenant_id, p_customer_id, 'payment', 'expense', p_method,
    p_amount, CURRENT_DATE
  );
END;
$function$;


-- ── process_status ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_status(
  p_order_item_id uuid, p_process_type text, p_tenant_id uuid
)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  IF p_process_type NOT IN ('ordered', 'backorder', 'hold') THEN
    RETURN json_build_object('success', false, 'error', '유효하지 않은 분류값입니다.');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    WHERE oi.id = p_order_item_id
      AND o.tenant_id = p_tenant_id
      AND oi.status = 'unshipped'
  ) THEN
    RETURN json_build_object('success', false, 'error', '출고 완료된 항목은 변경할 수 없습니다.');
  END IF;

  UPDATE order_items
  SET process_type = p_process_type
  WHERE id = p_order_item_id;

  RETURN json_build_object('success', true);
END;
$function$;


-- ── deduct_inventory: 3인자 (legacy) ─────────────────────────
CREATE OR REPLACE FUNCTION public.deduct_inventory(
  p_tenant_id uuid, p_variant_id uuid, p_qty integer
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = p_variant_id;
END;
$function$;


-- ── deduct_inventory: 4인자 (legacy, order_item_id) ─────────
CREATE OR REPLACE FUNCTION public.deduct_inventory(
  p_tenant_id uuid, p_variant_id uuid, p_qty integer,
  p_order_item_id uuid DEFAULT NULL::uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_new_qty INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = p_variant_id
  RETURNING quantity INTO v_new_qty;

  INSERT INTO inventory_logs (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason)
  VALUES (p_tenant_id, p_variant_id, p_order_item_id, -p_qty, COALESCE(v_new_qty, 0), 'shipment');
END;
$function$;


-- ── deduct_inventory: 4인자 (legacy, item_type) ─────────────
CREATE OR REPLACE FUNCTION public.deduct_inventory(
  p_tenant_id uuid, p_variant_id uuid, p_qty integer,
  p_order_item_id uuid DEFAULT NULL::uuid, p_item_type text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_new_qty INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = p_variant_id
  RETURNING quantity INTO v_new_qty;

  INSERT INTO inventory_logs (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason, item_type)
  VALUES (p_tenant_id, p_variant_id, p_order_item_id, -p_qty, COALESCE(v_new_qty, 0), 'shipment', p_item_type);
END;
$function$;


-- ── deduct_inventory: 5인자 BOOLEAN (사용 중) + 재고 검증 ────
-- 코드 (orders/page.tsx) 가 호출하는 시그니처. 재고 부족 시 RAISE EXCEPTION.
-- p_qty = 0 (release 해제) 은 검증 스킵 — 음수 재고/없는 항목 해제 허용.
CREATE OR REPLACE FUNCTION public.deduct_inventory(
  p_tenant_id uuid, p_variant_id uuid, p_qty integer,
  p_order_item_id uuid DEFAULT NULL::uuid, p_close boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
  v_new_inv_qty   INT;
  v_new_remaining INT;
  v_process_type  TEXT;
  v_current_qty   INT;
BEGIN
  PERFORM assert_tenant_access(p_tenant_id);

  -- 재고 검증 — 동시성 보호 위해 FOR UPDATE 로 행 잠금
  IF p_qty > 0 THEN
    SELECT quantity INTO v_current_qty
    FROM inventory
    WHERE tenant_id = p_tenant_id AND variant_id = p_variant_id
    FOR UPDATE;

    IF v_current_qty IS NULL THEN
      RAISE EXCEPTION '재고 정보가 없습니다 (variant: %)', p_variant_id
        USING ERRCODE = 'P0001';
    END IF;

    IF v_current_qty < p_qty THEN
      RAISE EXCEPTION '재고 부족: 현재 %개, 요청 %개', v_current_qty, p_qty
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE inventory
  SET quantity   = GREATEST(0, quantity - p_qty),
      updated_at = NOW()
  WHERE tenant_id  = p_tenant_id
    AND variant_id = p_variant_id
  RETURNING quantity INTO v_new_inv_qty;

  IF p_order_item_id IS NOT NULL THEN
    SELECT process_type,
           CASE WHEN p_close THEN 0
                ELSE GREATEST(0, remaining_qty - p_qty)
           END
    INTO v_process_type, v_new_remaining
    FROM order_items WHERE id = p_order_item_id;

    UPDATE order_items
    SET shipped_qty   = shipped_qty + p_qty,
        remaining_qty = v_new_remaining,
        status        = CASE WHEN v_new_remaining = 0 THEN 'shipped' ELSE status END
    WHERE id = p_order_item_id;
  END IF;

  INSERT INTO inventory_logs
    (tenant_id, variant_id, order_item_id, qty_change, balance_after, reason, process_type)
  VALUES
    (p_tenant_id, p_variant_id, p_order_item_id, -p_qty, COALESCE(v_new_inv_qty, 0), 'shipment', v_process_type);
END;
$function$;
