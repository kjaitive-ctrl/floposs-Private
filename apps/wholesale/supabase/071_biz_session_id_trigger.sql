-- ============================================================
-- 071: biz_session_id 자동 채움 트리거 (Layer 2)
--
-- 정책 (가): 한 tenant 안에 status='open'인 biz_session이 동시 1개만 존재 (070).
--   → DB가 활성 세션을 글로벌하게 안다.
--
-- 동작:
--   transactions / orders INSERT 시 biz_session_id가 NULL이면
--   같은 tenant의 활성 세션 ID로 자동 채운다.
--   활성 세션이 없으면 NULL 그대로 → 072의 NOT NULL 제약이 거부.
--
-- 의도:
--   RPC들(process_payment, refresh_order_revenue, process_ship_item 등)이
--   INSERT 시 biz_session_id 컬럼을 명시 안 해도 되게 한다.
--   → 모든 RPC 코드 0줄 수정.
--   → 신규 RPC 추가 시에도 자동 적용.
--   → 클라이언트가 명시적으로 biz_session_id를 채워 보내면 그 값 유지.
--
-- 방어 레이어:
--   1. UI 가드 (ensureBizOpen) — 사용자 친화 alert
--   2. 본 트리거 — 자동 채움 (코드 수정 0)
--   3. NOT NULL 제약 (072) — 활성 세션 없으면 INSERT 거부
-- ============================================================

CREATE OR REPLACE FUNCTION fill_biz_session_id()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.biz_session_id IS NULL THEN
    SELECT id INTO NEW.biz_session_id
    FROM biz_sessions
    WHERE tenant_id = NEW.tenant_id AND status = 'open'
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_fill_biz_session ON transactions;
CREATE TRIGGER transactions_fill_biz_session
  BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION fill_biz_session_id();

DROP TRIGGER IF EXISTS orders_fill_biz_session ON orders;
CREATE TRIGGER orders_fill_biz_session
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION fill_biz_session_id();
