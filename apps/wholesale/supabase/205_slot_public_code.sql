-- ============================================================
-- 205: slots.public_code — 도매(slot)별 고유 공유 URL (안건3 / 회의1)
--
-- 작성: 2026-06-02
-- 용도: /s/<public_code> = 그 slot 의 전자노트(주문 list) 공개 보드.
--   도매별 URL 이 달라 각 도매는 자기 자리 주문만 봄. retail 이 도매에게 이 링크 공유.
--   짧은 코드(8 hex) = UUID 비노출 + 보내기 깔끔. id 기반 deterministic → 멱등.
--   (클레임/티저 게이트는 Step II — v1 은 무료 배포판 읽기전용)
-- [[project_retail_slot_order_portal_v2]]
-- ============================================================

BEGIN;

ALTER TABLE slots ADD COLUMN IF NOT EXISTS public_code TEXT;

-- 기존 slot 백필 (deterministic — id 해시 8자리)
UPDATE slots SET public_code = substr(md5(id::text), 1, 8) WHERE public_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_slots_public_code ON slots(public_code);

-- 신규 slot 자동 부여 (default 로는 id 참조 불가 → BEFORE INSERT 트리거)
CREATE OR REPLACE FUNCTION set_slot_public_code() RETURNS trigger AS $$
BEGIN
  IF NEW.public_code IS NULL THEN
    NEW.public_code := substr(md5(NEW.id::text), 1, 8);
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_slot_public_code ON slots;
CREATE TRIGGER trg_slot_public_code
  BEFORE INSERT ON slots
  FOR EACH ROW EXECUTE FUNCTION set_slot_public_code();

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM slots WHERE public_code IS NOT NULL;
  RAISE NOTICE '[205] slots.public_code 부여 — % 개.', n;
END $$;

COMMIT;
