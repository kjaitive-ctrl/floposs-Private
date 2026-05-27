-- ============================================================
-- 070: 한 tenant 안에서 동시에 status='open'인 biz_session 1개만 허용
--
-- 정책: (가) tenant당 1세션 — 매장 단위 영업. 직원 여럿이 같은 세션 공유.
--
-- partial unique index로 status='open' 행에만 UNIQUE 적용.
-- → 동시 두 번 영업개시 시도, 정산 전 재개시, 다른 브라우저 우회 모두 차단.
--
-- 운영 적용 시점 데이터: biz_sessions 1건이 status='closed' (open 0건)
-- → 충돌 없이 인덱스 생성 가능.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS biz_sessions_one_open
  ON biz_sessions(tenant_id)
  WHERE status = 'open';
