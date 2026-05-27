-- ============================================================
-- 126: 잔량/처리완료 동적 helper view (비파괴)
--
-- Step B-1 (Phase 7.1 원본 보존 인프라):
--   사장 원칙 — 원 order_items 의 shipped_qty/remaining_qty/status 보존
--   잔량/처리완료는 derived 주문 합산으로 동적 계산
--
-- view 의 의미:
--   원 item 의 실제 잔량 = original quantity − (자체 shipped + derived 출고 합계)
--   처리완료 = 자체 shipped + derived 출고 합계 >= original
--
-- 현재 모델 (Step B-2 전):
--   - 일반 출고 (process_type='ordered'): 자체 shipped_qty 갱신, derived 없음
--     → direct_shipped = quantity, derived_shipped = 0, total = quantity, remaining = 0
--   - 미송/보류 출고 (현재): 자체 shipped_qty 갱신 + derived 도 INSERT
--     → direct_shipped = quantity, derived_shipped = quantity (이중!)
--     → total > quantity, remaining = 0 (GREATEST 가 0 이상)
--
-- Step B-2 적용 후:
--   - 일반 출고: 그대로 (derived 없음)
--   - 미송/보류 출고: 자체 shipped_qty=0 유지 + derived 만 INSERT
--     → direct_shipped = 0, derived_shipped = quantity, total = quantity (정합)
--
-- 즉 view 는 Step B-2 후 정합. 지금 view 만 만들면 사장님 데이터에서 양방향
-- 비교 가능 (옛 출고 vs 새 출고).
--
-- 비파괴:
--   read-only. 운영 RPC/UI 영향 0. 화면이 view 사용하면 변경 보임.
-- ============================================================

CREATE OR REPLACE VIEW order_item_remaining AS
SELECT
  oi.id                                                            AS item_id,
  oi.order_id,
  oi.variant_id,
  oi.process_type,
  oi.is_sample,
  oi.is_exchange,
  oi.quantity                                                       AS original_quantity,
  oi.shipped_qty                                                    AS direct_shipped,
  COALESCE(d_sum.derived_shipped, 0)                                AS derived_shipped,
  oi.shipped_qty + COALESCE(d_sum.derived_shipped, 0)               AS total_shipped,
  GREATEST(0, oi.quantity - oi.shipped_qty - COALESCE(d_sum.derived_shipped, 0))
                                                                     AS remaining,
  (oi.shipped_qty + COALESCE(d_sum.derived_shipped, 0)) >= oi.quantity
                                                                     AS is_fully_shipped
FROM order_items oi
LEFT JOIN LATERAL (
  -- 같은 원 주문에서 파생된 derived 주문들의 같은 variant 출고 합계
  SELECT SUM(d_item.shipped_qty) AS derived_shipped
  FROM orders d
  JOIN order_items d_item ON d_item.order_id = d.id
  WHERE d.derived_from_order_id = oi.order_id
    AND d_item.variant_id = oi.variant_id
) d_sum ON TRUE;

GRANT SELECT ON order_item_remaining TO authenticated;


-- ── 사장님 검증용 SQL (참고) ────────────────────────────────
-- 미송/보류 원 item 의 잔량 확인:
-- SELECT oi.id, oi.process_type, oi.quantity AS original, oi.shipped_qty AS direct,
--        v.derived_shipped, v.total_shipped, v.remaining, v.is_fully_shipped,
--        o.order_number
-- FROM order_items oi
-- JOIN orders o ON o.id = oi.order_id
-- JOIN order_item_remaining v ON v.item_id = oi.id
-- WHERE oi.process_type IN ('backorder', 'hold')
-- ORDER BY o.created_at DESC LIMIT 20;
