-- ============================================================
-- 077: 정산완료 세션 보호 트리거 (v2 — 단순화)
--
-- 사장님 정책 (확정):
--   "막아야 할 로직은 되돌리기뿐 (영업세션이 끝난)"
--   매출 인식 시점 = 출고/미송 처리 시점 = transactions(source='shipment') INSERT 시점
--   → 매출 박제 출처 = transactions 테이블만
--
-- 따라서 077 v2 정책: **transactions 테이블만** 보호.
--
-- 차단 대상 (closed 세션의 transactions):
--   1. DELETE — 되돌리기(process_undo_shipment)가 shipment transactions DELETE → 매출 박제 깨짐
--   2. UPDATE 중 박제 영향 컬럼 (amount, type, method, source, customer_id, biz_session_id)
--   3. closed biz_session_id 명시 INSERT (정상 흐름은 071 트리거가 활성 세션 자동 채움)
--
-- 허용 (사장 워크플로우):
--   - orders / order_items / inbound_orders / inbound_items 모든 변경
--     → 미처리 주문 삭제, 출고 처리, 미송 처리, 입고 수정 등 모두 자유
--   - 정산 후 출고 → refresh_order_revenue가 새 transactions(source='shipment') INSERT
--     → 071 트리거가 활성 세션(현재 세션) 자동 매핑 → 그 세션 매출에 잡힘
--
-- v1(077 초기) 대비 변경:
--   - guard_orders_closed_session 트리거 제거
--   - guard_order_items_closed_session 트리거 제거
--   - guard_inbound_orders_closed_session 트리거 제거
--   - guard_inbound_items_closed_session 트리거 제거
--   - guard_transactions_closed_session 만 유지
-- ============================================================


-- ── 헬퍼: biz_session_id 가 closed 세션인지 ───────────
CREATE OR REPLACE FUNCTION is_biz_session_closed(p_biz_session_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    (SELECT status = 'closed' FROM biz_sessions WHERE id = p_biz_session_id),
    FALSE
  );
$$;


-- ── orders / order_items / inbound_orders / inbound_items 트리거 제거 (v1 잔재) ──
DROP TRIGGER IF EXISTS guard_orders_closed_session         ON orders;
DROP TRIGGER IF EXISTS guard_order_items_closed_session    ON order_items;
DROP TRIGGER IF EXISTS guard_inbound_orders_closed_session ON inbound_orders;
DROP TRIGGER IF EXISTS guard_inbound_items_closed_session  ON inbound_items;
DROP FUNCTION IF EXISTS guard_orders_closed_session();
DROP FUNCTION IF EXISTS guard_order_items_closed_session();
DROP FUNCTION IF EXISTS guard_inbound_orders_closed_session();
DROP FUNCTION IF EXISTS guard_inbound_items_closed_session();


-- ============================================================
-- transactions 보호 (유일하게 남은 가드)
-- ============================================================
CREATE OR REPLACE FUNCTION guard_transactions_closed_session()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    -- 정상 흐름: 071 트리거가 활성 세션 자동 채움 → 항상 active 세션
    -- 이상 흐름: 명시적으로 closed biz_session_id 지정 → 차단
    IF NEW.biz_session_id IS NOT NULL AND is_biz_session_closed(NEW.biz_session_id) THEN
      RAISE EXCEPTION '정산완료 세션에 새 거래를 등록할 수 없습니다 (biz_session_id=%)', NEW.biz_session_id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF (TG_OP = 'DELETE') THEN
    -- 되돌리기(process_undo_shipment)가 정산된 세션의 shipment transactions 삭제 시도 → 차단
    IF is_biz_session_closed(OLD.biz_session_id) THEN
      RAISE EXCEPTION '정산완료 세션의 거래는 삭제할 수 없습니다 (반품으로 처리하세요)'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE: 박제 영향 컬럼 변경 + closed면 차단. 그 외(vat_cleared 등)는 허용
  IF is_biz_session_closed(OLD.biz_session_id) THEN
    IF NEW.amount         IS DISTINCT FROM OLD.amount         OR
       NEW.type           IS DISTINCT FROM OLD.type           OR
       NEW.method         IS DISTINCT FROM OLD.method         OR
       NEW.source         IS DISTINCT FROM OLD.source         OR
       NEW.customer_id    IS DISTINCT FROM OLD.customer_id    OR
       NEW.biz_session_id IS DISTINCT FROM OLD.biz_session_id
    THEN
      RAISE EXCEPTION '정산완료 세션의 거래는 금액/유형/거래처를 수정할 수 없습니다'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_transactions_closed_session ON transactions;
CREATE TRIGGER guard_transactions_closed_session
  BEFORE INSERT OR UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION guard_transactions_closed_session();
