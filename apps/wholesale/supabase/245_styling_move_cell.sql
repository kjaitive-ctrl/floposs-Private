-- ============================================================
-- 245: 스타일링 칸 옮기기 (끌어다 놓기)
--
-- 작성: 2026-11-23
-- 코디 줄 사이에서 같은 열(하의는 하의끼리)의 칸을 바꿈.
--   놓은 자리에 칸이 있으면 서로 맞바꾸고, 없으면 그 자리로 옮기기만.
--   칸 id 는 그대로 → 주문 줄(purchase_order_items.styling_cell_id)·사진 연결도 그대로 따라감.
-- UNIQUE(look_id, slot) 은 맞바꾸는 도중에 걸리므로 DEFERRABLE 로 다시 만들고
-- 함수 안에서만 끝에 검사(DEFERRED). 평소 INSERT/UPDATE 는 지금처럼 바로 검사.
-- ============================================================

BEGIN;

DO $$
DECLARE c TEXT;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'styling_cells'::regclass AND contype = 'u';
  IF c IS NOT NULL THEN
    EXECUTE format('ALTER TABLE styling_cells DROP CONSTRAINT %I', c);
  END IF;
END $$;

ALTER TABLE styling_cells
  ADD CONSTRAINT styling_cells_look_slot_key UNIQUE (look_id, slot) DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION styling_move_cell(p_cell_id UUID, p_target_look_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_cell  styling_cells%ROWTYPE;
  v_other UUID;
BEGIN
  SET CONSTRAINTS styling_cells_look_slot_key DEFERRED;

  SELECT * INTO v_cell FROM styling_cells WHERE id = p_cell_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '칸을 찾을 수 없습니다'; END IF;
  IF v_cell.look_id = p_target_look_id THEN
    RETURN jsonb_build_object('swapped_id', NULL);
  END IF;

  PERFORM 1 FROM styling_looks
   WHERE id = p_target_look_id AND tenant_id = v_cell.tenant_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION '옮길 코디 줄을 찾을 수 없습니다'; END IF;

  SELECT id INTO v_other FROM styling_cells
   WHERE look_id = p_target_look_id AND slot = v_cell.slot FOR UPDATE;

  UPDATE styling_cells SET look_id = p_target_look_id, updated_at = now() WHERE id = v_cell.id;
  IF v_other IS NOT NULL THEN
    UPDATE styling_cells SET look_id = v_cell.look_id, updated_at = now() WHERE id = v_other;
  END IF;

  RETURN jsonb_build_object('swapped_id', v_other);
END $$;

GRANT EXECUTE ON FUNCTION styling_move_cell(UUID, UUID) TO anon, authenticated;

COMMIT;

-- 확인: 제약이 DEFERRABLE 로 바뀌었는지
SELECT conname, condeferrable FROM pg_constraint
 WHERE conrelid = 'styling_cells'::regclass AND contype = 'u';
