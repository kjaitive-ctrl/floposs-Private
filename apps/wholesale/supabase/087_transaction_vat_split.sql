-- ============================================================
-- 087: transactions 부가세 분리 + 영업정산 부가세 합산
--
-- 배경:
--   영업정산 부가세 열은 orders.vat_amount 만 합산 → 입출금(수동입금/거래처입금)
--   에는 부가세 정보가 박히지 않아 누락됨.
--
-- 정책:
--   "입금액 = 통장 찍힌 부가세 포함 금액" 기본 가정.
--   거래처 부가세 ON 또는 사용자 토글 ON 일 때 amount 의 1/11 = 부가세, 10/11 = 공급가.
--   부가세 OFF 면 vat_amount = 0.
--
-- 변경:
--   1. transactions.vat_amount 컬럼 추가 (NUMERIC(12,2) DEFAULT 0)
--   2. process_payment / process_refund 에 p_vat_mode, p_vat_amount 인자 추가 (DEFAULT)
--   3. refresh_biz_session_stats: vat_total 에 transactions.vat_amount 도 합산
-- ============================================================

-- ── 1. 컬럼 추가 ─────────────────────────────────────────────
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS vat_amount NUMERIC(12,2) DEFAULT 0;


-- ── 2. process_payment — vat 인자 추가 ───────────────────────
CREATE OR REPLACE FUNCTION public.process_payment(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text,
  p_source text, p_order_id uuid DEFAULT NULL::uuid,
  p_vat_mode text DEFAULT NULL::text, p_vat_amount bigint DEFAULT 0
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

  -- transaction 생성 — vat_mode/vat_amount 박제
  INSERT INTO transactions (
    tenant_id, customer_id, source, type, method, amount, transaction_date, order_id,
    vat_mode, vat_amount
  )
  VALUES (
    p_tenant_id, p_customer_id, p_source, 'income', p_method, p_amount, CURRENT_DATE, p_order_id,
    p_vat_mode, COALESCE(p_vat_amount, 0)
  );

  -- 주문별 outstanding_amount 차감
  IF p_order_id IS NOT NULL THEN
    UPDATE orders
    SET outstanding_amount = GREATEST(0, outstanding_amount - p_amount),
        payment_status = CASE
          WHEN outstanding_amount - p_amount <= 0 THEN 'paid'
          ELSE 'partial'
        END
    WHERE id = p_order_id AND tenant_id = p_tenant_id;
  ELSE
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


-- ── 3. process_refund — vat 인자 추가 ────────────────────────
CREATE OR REPLACE FUNCTION public.process_refund(
  p_tenant_id uuid, p_customer_id uuid, p_amount bigint, p_method text,
  p_vat_mode text DEFAULT NULL::text, p_vat_amount bigint DEFAULT 0
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
    amount, transaction_date, vat_mode, vat_amount
  ) VALUES (
    p_tenant_id, p_customer_id, 'payment', 'expense', p_method,
    p_amount, CURRENT_DATE, p_vat_mode, COALESCE(p_vat_amount, 0)
  );
END;
$function$;


-- ── 4. refresh_biz_session_stats — vat_total 에 transactions vat_amount 합산 ──
-- 변경점: vat_stat CTE 가 orders.vat_amount + transactions.vat_amount 둘 다 합산.
CREATE OR REPLACE FUNCTION refresh_biz_session_stats(p_biz_session_id UUID)
RETURNS biz_sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_session   biz_sessions;
BEGIN
  PERFORM assert_biz_session_tenant_access(p_biz_session_id);

  SELECT tenant_id INTO v_tenant_id FROM biz_sessions WHERE id = p_biz_session_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'biz_session % not found', p_biz_session_id;
  END IF;

  -- (거래처별 stats — 변경 없음)
  DELETE FROM biz_session_customer_stats WHERE biz_session_id = p_biz_session_id;
  INSERT INTO biz_session_customer_stats
    (biz_session_id, tenant_id, customer_id, customer_name,
     sales_count, sales_amount, returns_count, returns_amount, purchase_count, purchase_amount)
  WITH agg AS (
    SELECT
      t.customer_id,
      MAX(c.company_name) AS company_name,
      COUNT(*) FILTER (WHERE t.source = 'shipment')::INT     AS sales_count,
      COALESCE(SUM(CASE WHEN t.source = 'shipment'     THEN t.amount ELSE 0 END), 0) AS sales_amount,
      COUNT(*) FILTER (WHERE t.source = 'return')::INT       AS returns_count,
      COALESCE(SUM(CASE WHEN t.source = 'return'       THEN t.amount ELSE 0 END), 0) AS returns_amount,
      COUNT(*) FILTER (WHERE t.source = 'credit_apply')::INT AS purchase_count,
      COALESCE(SUM(CASE WHEN t.source = 'credit_apply' THEN t.amount ELSE 0 END), 0) AS purchase_amount
    FROM transactions t
    LEFT JOIN customers c ON c.id = t.customer_id
    WHERE t.biz_session_id = p_biz_session_id
      AND t.customer_id IS NOT NULL
      AND t.source IN ('shipment', 'return', 'credit_apply')
    GROUP BY t.customer_id
  )
  SELECT
    p_biz_session_id, v_tenant_id, customer_id,
    COALESCE(company_name, '(미지정)') AS customer_name,
    sales_count, sales_amount, returns_count, returns_amount, purchase_count, purchase_amount
  FROM agg
  WHERE sales_count + returns_count + purchase_count > 0;

  -- (상품별 stats — 변경 없음)
  DELETE FROM biz_session_product_stats WHERE biz_session_id = p_biz_session_id;
  INSERT INTO biz_session_product_stats
    (biz_session_id, tenant_id, variant_id, product_id, product_name, color, size, qty, amount)
  WITH eligible AS (
    SELECT
      oi.variant_id,
      pv.product_id,
      p.name AS product_name,
      pv.color,
      pv.size,
      CASE
        WHEN COALESCE(oi.is_sample, FALSE) OR COALESCE(oi.is_exchange, FALSE) THEN 0
        ELSE COALESCE(oi.shipped_qty, 0)
             + CASE WHEN oi.process_type = 'backorder' AND oi.status = 'unshipped'
                    THEN COALESCE(oi.remaining_qty, 0) ELSE 0 END
      END AS eligible_qty,
      oi.unit_price
    FROM orders o
    JOIN order_items     oi ON oi.order_id = o.id
    JOIN product_variants pv ON pv.id = oi.variant_id
    JOIN products         p  ON p.id  = pv.product_id
    WHERE o.biz_session_id = p_biz_session_id
      AND o.status <> 'cancelled'
  )
  SELECT
    p_biz_session_id, v_tenant_id, variant_id, product_id, product_name, color, size,
    SUM(eligible_qty)::INT,
    COALESCE(SUM(eligible_qty * unit_price), 0)
  FROM eligible
  WHERE eligible_qty > 0
  GROUP BY variant_id, product_id, product_name, color, size;

  -- biz_sessions 스칼라 통계
  WITH tx_cat AS (
    SELECT amount,
      CASE
        WHEN source = 'shipment'                                            THEN 'shipment'
        WHEN source = 'return'                                              THEN 'return'
        WHEN source = 'credit_apply'                                        THEN 'purchase'
        WHEN source = 'manual' AND customer_id IS NULL AND type = 'income'  THEN 'manual_in'
        WHEN source = 'manual' AND customer_id IS NULL AND type = 'expense' THEN 'manual_out'
        WHEN type = 'income' AND method = 'cash'                            THEN 'cash_in'
        WHEN type = 'income' AND method = 'transfer'                        THEN 'transfer_in'
        WHEN type = 'receivable'                                            THEN 'credit'
        ELSE 'other'
      END AS bucket
    FROM transactions
    WHERE biz_session_id = p_biz_session_id
  ),
  tx_stat AS (
    SELECT
      COUNT(*) FILTER (WHERE bucket = 'shipment')::INT       AS sales_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'shipment'),    0) AS sales_amount,
      COUNT(*) FILTER (WHERE bucket = 'return')::INT          AS returns_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'return'),      0) AS returns_amount,
      COUNT(*) FILTER (WHERE bucket = 'purchase')::INT        AS purchase_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'purchase'),    0) AS purchase_amount,
      COUNT(*) FILTER (WHERE bucket = 'cash_in')::INT         AS cash_in_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'cash_in'),     0) AS cash_in_amount,
      COUNT(*) FILTER (WHERE bucket = 'transfer_in')::INT     AS transfer_in_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'transfer_in'), 0) AS transfer_in_amount,
      COUNT(*) FILTER (WHERE bucket = 'credit')::INT          AS credit_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'credit'),      0) AS credit_amount,
      COUNT(*) FILTER (WHERE bucket = 'manual_in')::INT       AS manual_in_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'manual_in'),   0) AS manual_in_amount,
      COUNT(*) FILTER (WHERE bucket = 'manual_out')::INT      AS manual_out_count,
      COALESCE(SUM(amount) FILTER (WHERE bucket = 'manual_out'),  0) AS manual_out_amount
    FROM tx_cat
  ),
  -- VAT: orders 의 출고 매출 vat_amount + transactions 의 입금 vat_amount.
  -- 영업정산 부가세 열에 둘 다 합산.
  vat_orders AS (
    SELECT
      COUNT(*) FILTER (WHERE o.vat_amount IS NOT NULL AND o.vat_amount <> 0)::INT AS cnt,
      COALESCE(SUM(o.vat_amount), 0) AS amt
    FROM orders o
    WHERE o.biz_session_id = p_biz_session_id
      AND o.status <> 'cancelled'
      AND EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.order_id = o.id
          AND t.source = 'shipment'
          AND t.biz_session_id = p_biz_session_id
      )
  ),
  vat_txs AS (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(vat_amount, 0) <> 0)::INT AS cnt,
      COALESCE(SUM(vat_amount), 0) AS amt
    FROM transactions
    WHERE biz_session_id = p_biz_session_id
  ),
  vat_stat AS (
    SELECT
      (vat_orders.cnt + vat_txs.cnt) AS vat_count,
      (vat_orders.amt + vat_txs.amt) AS vat_total
    FROM vat_orders, vat_txs
  ),
  inb_stat AS (
    SELECT
      COUNT(*)::INT                              AS inbound_count,
      COALESCE(SUM(COALESCE(total_amount, 0)),0) AS inbound_amount
    FROM inbound_orders WHERE biz_session_id = p_biz_session_id
  ),
  cust_count AS (
    SELECT COUNT(*)::INT AS n
    FROM biz_session_customer_stats
    WHERE biz_session_id = p_biz_session_id
  )
  UPDATE biz_sessions SET
    sales_count        = tx_stat.sales_count,
    sales_amount       = tx_stat.sales_amount,
    vat_count          = vat_stat.vat_count,
    vat_total          = vat_stat.vat_total,
    returns_count      = tx_stat.returns_count,
    returns_amount     = tx_stat.returns_amount,
    purchase_count     = tx_stat.purchase_count,
    purchase_amount    = tx_stat.purchase_amount,
    cash_in_count      = tx_stat.cash_in_count,
    cash_in_amount     = tx_stat.cash_in_amount,
    transfer_in_count  = tx_stat.transfer_in_count,
    transfer_in_amount = tx_stat.transfer_in_amount,
    credit_count       = tx_stat.credit_count,
    credit_amount      = tx_stat.credit_amount,
    manual_in_count    = tx_stat.manual_in_count,
    manual_in_amount   = tx_stat.manual_in_amount,
    manual_out_count   = tx_stat.manual_out_count,
    manual_out_amount  = tx_stat.manual_out_amount,
    inbound_count      = inb_stat.inbound_count,
    inbound_amount     = inb_stat.inbound_amount,
    customer_count     = cust_count.n,
    stats_finalized_at = now()
  FROM tx_stat, vat_stat, inb_stat, cust_count
  WHERE biz_sessions.id = p_biz_session_id
  RETURNING biz_sessions.* INTO v_session;

  RETURN v_session;
END;
$$;
