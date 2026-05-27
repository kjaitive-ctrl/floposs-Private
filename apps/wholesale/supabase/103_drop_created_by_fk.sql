-- ============================================================
-- 103: 102 의 FK 충돌 핫픽스
--
-- 문제: 102 의 fill_created_by_from_auth() trigger 는 auth.uid() 를 채움.
--       그러나 public.users.id ≠ auth.users.id —
--       signup 시 staff-signup/route.ts 가 public.users INSERT 에서
--       id 를 명시 안 해 gen_random_uuid() 로 생성됨.
--       → orders/transactions/inbound_orders.created_by → users(id) FK 위반.
--
-- 해결: created_by 의 FK 제약 제거.
--       컬럼은 UUID 로 유지 — auth.users.id 를 직접 보관.
--       조작자 식별: SELECT * FROM auth.users WHERE id = orders.created_by
--       필요 시 email 매칭으로 public.users 조회 가능.
--
-- 트레이드오프: 참조 무결성 X. 단 created_by 는 추적/감사 용도라
--             FK 가 깨질 일이 거의 없고(auth.users 행은 잘 안 지움) 무관.
-- ============================================================

ALTER TABLE orders         DROP CONSTRAINT IF EXISTS orders_created_by_fkey;
ALTER TABLE transactions   DROP CONSTRAINT IF EXISTS transactions_created_by_fkey;
ALTER TABLE inbound_orders DROP CONSTRAINT IF EXISTS inbound_orders_created_by_fkey;

-- (102 의 trigger 는 그대로 유지. FK 만 제거되어 INSERT 통과)
