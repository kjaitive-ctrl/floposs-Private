-- ============================================================
-- 095: vat_period_skips.skipped_by 외래키 제약 완화
--
-- 버그:
--   094 의 skipped_by 가 public.users(id) 참조하는데
--   toggle_vat_period_skip RPC 가 auth.jwt() ->> 'sub' (= auth.users.id) 를 박제.
--   public.users.id 는 자체 gen_random_uuid() PK 라 두 ID 가 일치하지 않음.
--   → INSERT 시 외래키 위반.
--
-- 수정:
--   외래키 제약 제거. skipped_by 컬럼은 감사 로그용으로 보존 (UUID 그대로).
--   향후 auth↔public 매핑 인프라 정착 시 다시 묶을 수 있음.
-- ============================================================

ALTER TABLE vat_period_skips
  DROP CONSTRAINT IF EXISTS vat_period_skips_skipped_by_fkey;
