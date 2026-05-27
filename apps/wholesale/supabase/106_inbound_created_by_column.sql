-- ============================================================
-- 106: 입고처리 실패 핫픽스
--
-- 문제: 102 의 trg_fill_created_by trigger 가 inbound_orders 에
--      등록됨 → INSERT 시 NEW.created_by 참조.
--      그러나 schema.sql 의 inbound_orders 정의에 created_by 컬럼 없음
--      → "column does not exist" 에러로 입고 INSERT 실패.
--
-- 해결: inbound_orders 에 created_by 컬럼 추가.
--      orders/transactions 와 동일한 감사 추적 가능 (입고 단가 조작 등).
--      FK 없음 — auth.users.id 직접 보관 (103 정책과 동일).
-- ============================================================

ALTER TABLE inbound_orders
  ADD COLUMN IF NOT EXISTS created_by UUID;

-- 103 에서 FK constraint 만 DROP 했으나 컬럼 자체가 없어 noop 이었음 (이번에 컬럼 추가).
-- FK 새로 만들지 않음 — auth.users.id 직접 보관용.
