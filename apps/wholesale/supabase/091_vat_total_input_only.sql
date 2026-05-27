-- ============================================================
-- 091: 영업정산 vat_total 을 입금 기준으로 단순화
--
-- 배경:
--   087 에서 vat_total = orders.vat_amount(매출기준) + transactions.vat_amount(입금기준)
--   둘 다 합산. 청구 거래처가 매출+입금 같은 세션에 발생하면 부가세 2번 잡힘.
--
-- 정책 (089 외상=공급가만 정책의 자연스러운 연장):
--   부가세 정산은 입금 시점 일관 처리.
--   매출 시점 부가세는 참고용 (orders.vat_amount 박제는 유지 — 세금계산서 발행시 사용).
--   영업정산 vat_total = 그 세션에 transactions.vat_amount 합산만.
--
-- 변경:
--   refresh_biz_session_stats 의 vat_orders CTE 제거. vat_txs 만 사용.
-- ============================================================

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

  -- (거래처별 stats — 087과 동일)
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

  -- (상품별 stats — 087과 동일)
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
  -- VAT: 입금 기준만. 매출 시점이 아닌 transactions.vat_amount 합산.
  --   - process_payment / process_refund 가 박제한 vat (청구 거래처 입금)
  --   - process_vat_collection 이 박제할 vat (현금/통장 거래처 월별 부가세 정산)
  vat_stat AS (
    SELECT
      COUNT(*) FILTER (WHERE COALESCE(vat_amount, 0) <> 0)::INT AS vat_count,
      COALESCE(SUM(vat_amount), 0) AS vat_total
    FROM transactions
    WHERE biz_session_id = p_biz_session_id
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
