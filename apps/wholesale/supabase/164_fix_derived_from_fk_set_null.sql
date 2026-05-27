-- ============================================================
-- 164: orders_derived_from_order_id_fkey → ON DELETE SET NULL
--
-- 배경 (2026-05-08 사장 보고):
--   163 적용 후 process_register_action 호출 시 FK 위반.
--   "update or delete on table 'orders' violates foreign key constraint
--    'orders_derived_from_order_id_fkey' on table 'orders'"
--
--   원인: process_register_action 이 처리 끝에 staging 삭제. 새로 만들어진 derived 들이
--         derived_from_order_id = staging.id 참조 중 → FK 위반.
--
--   해결: FK 를 ON DELETE SET NULL 로 변경. staging 삭제 시 자식 derived 의
--         derived_from_order_id 가 자동 NULL 됨.
--
--   영향: staging 사라진 derived (shipment_action / backorder_register / hold_register) 의
--         derived_from_order_id = NULL. staging 자체가 영수증 박제 X (사라지는 임시 객체) 라
--         부모 추적 의미 없음. 후속 derived chain (backorder_ship, backorder_release 등) 은
--         살아있는 derived 끼리 참조라 정상.
-- ============================================================

BEGIN;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_derived_from_order_id_fkey;

ALTER TABLE orders ADD CONSTRAINT orders_derived_from_order_id_fkey
  FOREIGN KEY (derived_from_order_id) REFERENCES orders(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';

COMMIT;
