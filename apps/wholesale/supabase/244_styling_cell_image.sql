-- ============================================================
-- 244: 스타일링 후보 샘플 사진 (칸마다 1장)
--
-- 작성: 2026-11-23
-- 칸에 캡처 이미지 붙여넣기(Ctrl+V)/끌어놓기/앨범 선택 → R2 업로드 → 칸에 사진 표시.
--   R2 key: tenants/{tenant_id}/styling/{cell_id}/{uuid}.webp  (/api/r2/sign kind='styling')
--   새 표가 아니라 칼럼 추가라 RLS 함정 없음.
-- ============================================================

ALTER TABLE styling_cells
  ADD COLUMN IF NOT EXISTS image_key TEXT,   -- R2 object key (삭제용)
  ADD COLUMN IF NOT EXISTS image_url TEXT;   -- 공개 URL (표시용)

COMMENT ON COLUMN styling_cells.image_key IS 'R2 key — tenants/{tenant}/styling/{cell}/{uuid}.webp';
COMMENT ON COLUMN styling_cells.image_url IS 'R2 공개 URL';
