-- ============================================================
-- 144: dead RPC 일괄 정리 (Phase 2 cleanup)
--
-- 사용처 없음 (orders/page.tsx 옛 POS 삭제 + handleHistoryProcess/handleDetailProcess
-- 가 process_return_derived 로 교체됨에 따라 dead).
--
-- DROP 대상:
--   1. process_undo_shipment — [취소] 폐지로 호출처 X (사장 정책: 영수증 박제 비가역)
--   2. process_return_item   — process_return_derived (140) 로 교체
--   3. restore_inventory      — process_return_derived 가 inventory 직접 UPDATE
--   4. deduct_inventory legacy 오버로드 (3인자/4인자×2) — 5인자 BOOLEAN 만 사용 중
--
-- 안전 검증:
--   - SQL 안 PERFORM 호출 X (검색 완료)
--   - 클라이언트 supabase.rpc 호출 X (검색 완료)
--   - 트리거 의존 X
-- ============================================================

DROP FUNCTION IF EXISTS public.process_undo_shipment(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.process_return_item(uuid, uuid, uuid, bigint, text);
DROP FUNCTION IF EXISTS public.restore_inventory(uuid, uuid, integer, uuid, boolean, text, text);

-- deduct_inventory legacy 오버로드 — 5인자 BOOLEAN 만 유지
DROP FUNCTION IF EXISTS public.deduct_inventory(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.deduct_inventory(uuid, uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.deduct_inventory(uuid, uuid, integer, uuid, text);

NOTIFY pgrst, 'reload schema';
