-- ============================================================
-- 176: orders.biz_session_id NULLABLE — 외부 staging 주문 영업 무관 수신
--
-- 작성: 2026-05-15
-- 사장 정책 (확정):
--   "외부 주문(retail v1) 은 영업세션과 관계없이 전송되어야 하고,
--    처리되는 순간(wholesale 사장이 처리 화면에서 [처리!]) 영업세션에 기록되어야 한다."
--
-- 배경 (마이그 072 한계)
--   - 072: orders.biz_session_id NOT NULL (wholesale 단일 시스템 가정)
--   - 071: orders/transactions INSERT 시 NULL 이면 활성 세션 자동 채움
--   - 영업 안 중인 상태에서 INSERT → 071 가 NULL 그대로 → 072 NOT NULL 위반 → INSERT 실패
--   - 5축 가치사슬 시대에 외부 시스템(retail v1) 에서 들어오는 staging 주문 차단됨
--
-- 본 마이그
--   ① orders.biz_session_id NULL 허용 (072 제약 일부 해제)
--   ② enforce trigger 신설: order_source != 'external_inbox' 인데 NULL 박히면 RAISE
--      → wholesale 내부 SaleForm 등 기존 흐름의 NOT NULL 강제력 유지 (안전망)
--      → retail v1 external_inbox 만 NULL 박제 허용
--   ③ 071 trigger 그대로 유지 (활성 세션 있으면 채움)
--   ④ transactions.biz_session_id 는 NOT NULL 그대로 (매출 박제 정합 핵심)
--
-- 처리 시점 매출 박제 흐름 (변경 없음)
--   1. retail submit  → orders INSERT (biz_session_id NULL, order_source='external_inbox')
--                       order_items INSERT (staging)
--   2. wholesale POS  → 미처리 탭 [외] 뱃지로 식별
--   3. 사장 처리      → process_register_action RPC
--                       → derived order INSERT (071 가 활성 세션 자동 채움)
--                       → transactions(source='shipment') INSERT (071 가 활성 세션 채움)
--                       → 매출 박제 = 처리 시점 활성 세션
--   4. 영업 정산      → 075 가 transactions.biz_session_id 기반 통계 박제
--                       → NULL staging order 는 자연 제외 (o.biz_session_id = p_biz_session_id 그루핑)
--
-- 영향 검증
--   - 075 settle_biz_session_rpc: 매출/통계 박제 모두 `biz_session_id = X` 그루핑 → NULL row 자연 제외 ✓
--   - 077 v2 closed session guards: transactions 만 가드, orders 자유 → 영향 0 ✓
--   - SaleForm (wholesale 내부): 071 가 활성 세션 채움. 영업개시 안 한 상태면 enforce trigger 가 차단 → 기존 가드 그대로 ✓
--   - process_register_action (처리 시점 derived): 071 가 활성 세션 채움 → enforce 통과 ✓
--
-- 안전
--   - BEGIN/COMMIT 트랜잭션
--   - 071 trigger 이름(`orders_fill_biz_session`) 이 신규 enforce(`orders_zguard_biz_session_required`)
--     보다 alphabetical 앞 → 071 가 먼저 활성 세션 채운 뒤 enforce 가 검사 (실행 순서 보장)
--   - 멱등 (DROP TRIGGER IF EXISTS / CREATE OR REPLACE)
-- ============================================================

BEGIN;

-- ─────────────────────────────────────────────────────────
-- ① orders.biz_session_id NULL 허용
-- ─────────────────────────────────────────────────────────
ALTER TABLE orders ALTER COLUMN biz_session_id DROP NOT NULL;

COMMENT ON COLUMN orders.biz_session_id IS
  '주문이 속한 영업세션. 처리(transactions 박제) 시점에 활성 세션 자동 박제 (071 trigger). '
  'order_source=external_inbox staging 은 NULL 허용 — 처리 전이라 영업세션 무관. '
  '그 외 source 는 enforce trigger(176) 가 NULL 차단.';


-- ─────────────────────────────────────────────────────────
-- ② enforce trigger: external_inbox 외엔 NULL 차단
-- ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION orders_enforce_biz_session_for_internal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- 071 trigger(orders_fill_biz_session) 가 먼저 동작해서 활성 세션 채웠을 것
  -- 그래도 NULL 이면 = 활성 세션 자체가 없음
  IF NEW.biz_session_id IS NULL THEN
    IF NEW.order_source IS DISTINCT FROM 'external_inbox' THEN
      RAISE EXCEPTION
        'orders.biz_session_id 가 NULL 입니다. order_source=% 인 주문은 영업개시 후에만 등록할 수 있습니다.',
        COALESCE(NEW.order_source, '(null)')
        USING ERRCODE = '23502';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- trigger 이름 `orders_zguard_...` (z prefix) → 071 의 `orders_fill_...` 보다 alphabetical 뒤 → 실행 순서 보장
DROP TRIGGER IF EXISTS orders_zguard_biz_session_required ON orders;
CREATE TRIGGER orders_zguard_biz_session_required
  BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_enforce_biz_session_for_internal();


-- ─────────────────────────────────────────────────────────
-- ③ 검증: 현재 트리거 두 개의 실행 순서가 보장되는지 메타 확인
-- ─────────────────────────────────────────────────────────
DO $$
DECLARE
  v_first  TEXT;
  v_second TEXT;
BEGIN
  SELECT tgname INTO v_first
  FROM pg_trigger
  WHERE tgrelid = 'orders'::regclass
    AND NOT tgisinternal
    AND tgname IN ('orders_fill_biz_session', 'orders_zguard_biz_session_required')
  ORDER BY tgname
  LIMIT 1;

  SELECT tgname INTO v_second
  FROM pg_trigger
  WHERE tgrelid = 'orders'::regclass
    AND NOT tgisinternal
    AND tgname IN ('orders_fill_biz_session', 'orders_zguard_biz_session_required')
  ORDER BY tgname DESC
  LIMIT 1;

  IF v_first <> 'orders_fill_biz_session' OR v_second <> 'orders_zguard_biz_session_required' THEN
    RAISE EXCEPTION '[176] trigger 실행 순서가 예상과 다릅니다. first=%, second=%', v_first, v_second;
  END IF;

  RAISE NOTICE '[176] trigger 실행 순서 OK: 1) % → 2) %', v_first, v_second;
END $$;


-- ─────────────────────────────────────────────────────────
-- ④ 완료 메시지
-- ─────────────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE '[176] orders.biz_session_id NULL 허용 + enforce(external_inbox 외 차단) 정착. retail v1 staging 주문 영업 무관 수신 가능.';
END $$;

COMMIT;
