-- ============================================================
-- 075: settle_biz_session RPC — 정산 시 통계 박제 (v2)
--
-- 호출 시점: BusinessSettleModal에서 영업정산 버튼.
-- 동작:
--   1. 세션 잠금 (FOR UPDATE) — 동시 정산 방지
--   2. 마감 정보 update (status='closed', closer_name, closing_cash, closed_at)
--   3. refresh_biz_session_stats() — 통계 박제 (스칼라 + 거래처별 + 상품별)
--   모두 한 트랜잭션 → RPC 자체가 atomic. 부분 박제 발생 불가.
--
-- ── v2 변경: 매출 인식 시점 = 출고/미송 처리 시점 ──────────
-- 사장님 정책: "출고처리(출고/미송) 시점에 매출 인식". 미처리(unshipped+ordered)는 매출 X.
--
-- 매출 박제 출처:
--   - sales_*    = transactions(source='shipment')  ← refresh_order_revenue가 출고/미송 시 INSERT
--   - returns_*  = transactions(source='return')    ← process_return_item이 INSERT
--   - purchase_* = transactions(source='credit_apply')  ← 매입금 자동 충당
--   - cash/transfer/credit/manual = 기존 분류 그대로 (transactions 기반)
--   - vat_total  = SUM(orders.vat_amount) — 추후 정밀화 후순위
--   - inbound_*  = SUM(inbound_orders.total_amount)
--
-- 효과: 정산 후 미처리 주문 삭제 / 출고 자유. 박제 출처가 transactions라 영향 0.
--      "되돌리기"(process_undo_shipment)는 transactions DELETE → 077이 차단.
-- ============================================================


-- ── 통계만 갱신 (status/closer/closing_cash 건드리지 않음) ──
CREATE OR REPLACE FUNCTION refresh_biz_session_stats(p_biz_session_id UUID)
RETURNS biz_sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant_id UUID;
  v_session   biz_sessions;
BEGIN
  SELECT tenant_id INTO v_tenant_id FROM biz_sessions WHERE id = p_biz_session_id;
  IF v_tenant_id IS NULL THEN
    RAISE EXCEPTION 'biz_session % not found', p_biz_session_id;
  END IF;

  -- ============================================================
  -- 1. 거래처별 stats — transactions 기반 (shipment/return/credit_apply)
  -- ============================================================
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
  WHERE sales_count + returns_count + purchase_count > 0;  -- 모두 0인 거래처는 박제 제외

  -- ============================================================
  -- 2. 상품별 stats — 출고/미송된 부분만 (064 refresh_order_revenue 정의와 동일)
  --    sample/exchange 제외, shipped_qty + (backorder의 remaining_qty) 부분만 합산
  -- ============================================================
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
      -- 출고된 수량 + (미송 명시된 미출고 수량)
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

  -- ============================================================
  -- 3. biz_sessions 스칼라 통계 일괄 갱신
  -- ============================================================
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
  -- VAT은 그 세션에 등록되고 그 세션에서 출고/미송 처리된 주문만 합산.
  -- "처리된 주문만 카운팅" 정책 (참고용 표시 — 실제 VAT 발행은 입금 기준 vat_batches 흐름).
  vat_stat AS (
    SELECT
      COUNT(*) FILTER (WHERE o.vat_amount IS NOT NULL AND o.vat_amount <> 0)::INT AS vat_count,
      COALESCE(SUM(o.vat_amount), 0) AS vat_total
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


-- ── 정산: 마감 정보 update + 통계 박제 (atomic) ──
CREATE OR REPLACE FUNCTION settle_biz_session(
  p_biz_session_id UUID,
  p_closer_name    TEXT,
  p_closing_cash   NUMERIC
)
RETURNS biz_sessions
LANGUAGE plpgsql
AS $$
DECLARE
  v_session biz_sessions;
BEGIN
  -- 세션 잠금 (동시 정산 방지)
  SELECT * INTO v_session FROM biz_sessions
    WHERE id = p_biz_session_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'biz_session % not found', p_biz_session_id;
  END IF;
  IF v_session.status = 'closed' THEN
    RAISE EXCEPTION 'biz_session % is already closed', p_biz_session_id
      USING ERRCODE = 'P0002';
  END IF;
  IF p_closer_name IS NULL OR length(trim(p_closer_name)) = 0 THEN
    RAISE EXCEPTION 'closer_name is required';
  END IF;

  -- 마감 정보 update
  UPDATE biz_sessions SET
    status       = 'closed',
    closer_name  = trim(p_closer_name),
    closing_cash = COALESCE(p_closing_cash, 0),
    closed_at    = now()
  WHERE id = p_biz_session_id;

  -- 통계 박제
  RETURN refresh_biz_session_stats(p_biz_session_id);
END;
$$;
