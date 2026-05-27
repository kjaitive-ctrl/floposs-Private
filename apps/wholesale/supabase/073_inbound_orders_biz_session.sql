-- ============================================================
-- 073: inbound_orders.biz_session_id 추가 + 071 트리거 확장
--
-- 배경:
--   영업정산 페이지의 "입고계"는 그 영업세션 동안 등록된 입고의 합계.
--   inbound_orders도 biz_session_id로 세션에 묶어야 한다.
--
-- 정책:
--   NOT NULL은 걸지 않는다. 입고는 영업개시 전/정산 후에도 가능 (납품 시간이
--   영업시간과 다를 수 있음). 영업 중에 등록된 입고만 세션에 자동 묶임.
--
-- 트리거: 071의 fill_biz_session_id()를 inbound_orders에도 BEFORE INSERT 적용.
--   활성 세션이 있으면 그 ID로 자동 채움. 없으면 NULL 그대로.
-- ============================================================

ALTER TABLE inbound_orders
  ADD COLUMN IF NOT EXISTS biz_session_id UUID REFERENCES biz_sessions(id);

CREATE INDEX IF NOT EXISTS idx_inbound_orders_biz_session
  ON inbound_orders(biz_session_id);

DROP TRIGGER IF EXISTS inbound_orders_fill_biz_session ON inbound_orders;
CREATE TRIGGER inbound_orders_fill_biz_session
  BEFORE INSERT ON inbound_orders
  FOR EACH ROW EXECUTE FUNCTION fill_biz_session_id();
