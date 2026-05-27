-- ============================================================
-- 081: 약관/개인정보처리방침 시스템 + platform_settings 확장
--
-- 배경: 가입 시 약관/개인정보 동의 의무. 변경 이력 보관 의무 (법적).
--       super_admin 이 /admin/legal 에서 편집. 표준 템플릿 시드 제공.
--
-- 정책:
--   - legal_documents: kind 별 (terms, privacy, refund 등) 버전 누적.
--   - 가장 최근 row (kind, MAX(effective_at)) 가 현재 적용 버전.
--   - 변경 = 새 row INSERT (UPDATE 안 함). 이력 자동 보존.
--   - signup 폼은 "최신 버전" fetch → 사장 동의 시 수정 안 됨 (그대로 보존).
--   - platform_settings 확장: 서비스명, 개인정보보호책임자, 책임자 이메일.
-- ============================================================

-- ── 1. legal_documents 테이블 ──────────────────────
CREATE TABLE IF NOT EXISTS legal_documents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('terms', 'privacy', 'refund')),
  version       TEXT NOT NULL,                -- 'v1.0', '2026-04-29' 등 자유
  body          TEXT NOT NULL,                -- 본문 (마크다운 또는 plain)
  effective_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes         TEXT,                         -- 변경 사유 (admin 메모)
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_legal_kind_effective
  ON legal_documents (kind, effective_at DESC);

ALTER TABLE legal_documents DISABLE ROW LEVEL SECURITY;

COMMENT ON TABLE legal_documents IS
  '약관/개인정보처리방침 등 법적 문서. kind 별로 버전 누적 (UPDATE 안 함). 최신 = MAX(effective_at).';

-- ── 2. platform_settings 확장 ──────────────────────
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS service_name              TEXT,    -- "플로포스"
  ADD COLUMN IF NOT EXISTS service_brand_letter      TEXT,    -- "F" (login 로고)
  ADD COLUMN IF NOT EXISTS privacy_officer_name      TEXT,    -- 개인정보보호책임자
  ADD COLUMN IF NOT EXISTS privacy_officer_email     TEXT,    -- 책임자 이메일
  ADD COLUMN IF NOT EXISTS privacy_officer_phone     TEXT;    -- 책임자 연락처

-- 기본값 시드 (하드코딩 → DB 이전)
UPDATE platform_settings SET
  service_name           = COALESCE(service_name, '플로포스'),
  service_brand_letter   = COALESCE(service_brand_letter, 'F')
WHERE id = 1;

-- ── 3. 표준 템플릿 시드 ─────────────────────────────
-- 최소한의 템플릿. admin 이 회사 정보 채워 넣고 추후 보완.
-- {{service_name}} / {{company_name}} 등 placeholder 는 사장이 직접 치환 (또는 추후 자동 치환 헬퍼).
INSERT INTO legal_documents (kind, version, body, notes) VALUES (
  'terms', 'v1.0',
'제1조 (목적)
본 약관은 (주)케이제이리테일(이하 "회사")이 제공하는 플로포스 서비스(이하 "서비스")의 이용과 관련하여 회사와 이용자 간의 권리, 의무 및 책임사항, 기타 필요한 사항을 규정함을 목적으로 합니다.

제2조 (정의)
1. "서비스"란 회사가 제공하는 플로포스 SaaS 플랫폼 및 관련 부가 서비스를 의미합니다.
2. "이용자"란 회사와 본 약관에 따라 서비스 이용 계약을 체결한 사업자를 의미합니다.
3. "계정"이란 이용자가 서비스 이용을 위해 회사로부터 발급받은 식별 정보(이메일/비밀번호)를 의미합니다.

제3조 (약관의 효력 및 변경)
1. 본 약관은 회사가 서비스 화면에 게시하거나 기타 방법으로 이용자에게 공지함으로써 효력이 발생합니다.
2. 회사는 관련 법령을 위반하지 않는 범위에서 본 약관을 개정할 수 있으며, 약관이 변경되는 경우 적용일자 7일 이전부터 공지합니다.
3. 변경된 약관에 동의하지 않는 이용자는 서비스 이용 계약을 해지할 수 있습니다.

제4조 (이용 계약의 성립)
1. 이용자가 회사가 정한 양식에 따라 가입 신청을 하고, 회사가 이를 승인함으로써 이용 계약이 성립합니다.
2. 회사는 다음 각 호의 경우 가입 신청을 거절할 수 있습니다.
   - 허위 정보를 기재하거나 회사가 요구한 자료를 제출하지 않은 경우
   - 사회 질서 또는 미풍양속을 저해할 목적으로 신청한 경우
   - 기타 회사가 정한 기준에 부합하지 않는 경우

제5조 (서비스의 제공 및 변경)
회사는 안정적인 서비스 제공을 위해 노력하며, 시스템 점검 등의 사유로 서비스를 일시 중단할 수 있습니다.

제6조 (이용료 및 결제)
1. 서비스 이용료는 회사가 정한 구독 플랜에 따릅니다.
2. 이용료는 매월 또는 매년 정기 결제됩니다.
3. 결제 실패 시 회사는 서비스 이용을 정지할 수 있습니다.

제7조 (이용자의 의무)
이용자는 다음 행위를 하여서는 안 됩니다.
1. 타인의 정보 도용
2. 회사가 게시한 정보의 무단 변경
3. 회사 및 제3자의 권리 침해
4. 기타 관계 법령에 위반되는 행위

제8조 (개인정보 보호)
회사는 이용자의 개인정보를 보호하며, 자세한 내용은 별도의 개인정보처리방침에 따릅니다.

제9조 (계약 해지)
1. 이용자는 언제든지 서비스 이용 계약을 해지할 수 있습니다.
2. 회사는 이용자가 본 약관을 위반한 경우 사전 통지 후 이용 계약을 해지할 수 있습니다.

제10조 (책임의 제한)
1. 회사는 천재지변 또는 이에 준하는 불가항력으로 인한 서비스 중단에 대해 책임을 지지 않습니다.
2. 회사는 이용자의 귀책사유로 인한 서비스 이용 장애에 대해 책임을 지지 않습니다.

제11조 (분쟁 해결)
본 약관과 관련하여 분쟁이 발생할 경우, 양 당사자는 성실히 협의하여 해결하며, 협의가 이루어지지 않는 경우 회사 본점 소재지를 관할하는 법원을 합의 관할 법원으로 합니다.

부칙
본 약관은 2026년 4월 29일부터 시행됩니다.',
  '초기 표준 템플릿 (v1.0)'
)
ON CONFLICT DO NOTHING;

INSERT INTO legal_documents (kind, version, body, notes) VALUES (
  'privacy', 'v1.0',
'제1조 (개인정보의 수집 및 이용 목적)
(주)케이제이리테일(이하 "회사")은 다음의 목적을 위하여 개인정보를 처리합니다.
1. 회원 가입 및 관리
2. 서비스 제공 및 계약 이행
3. 결제 및 환불 처리
4. 고객 지원 및 문의 응대
5. 법령상 의무 이행

제2조 (수집하는 개인정보 항목)
1. 필수항목: 이메일 주소, 비밀번호, 업체명, 사업자등록번호
2. 선택항목: 대표자명, 연락처, 주소
3. 자동 수집 항목: 접속 IP, 쿠키, 서비스 이용 기록

제3조 (개인정보의 보유 및 이용 기간)
1. 회원 정보: 회원 탈퇴 시까지 (단, 관계 법령에서 정한 기간 동안 보관)
2. 결제 기록: 전자상거래법에 따라 5년
3. 서비스 이용 기록: 통신비밀보호법에 따라 3개월

제4조 (개인정보의 제3자 제공)
회사는 이용자의 개인정보를 원칙적으로 외부에 제공하지 않습니다. 단, 다음의 경우는 예외로 합니다.
1. 이용자가 사전에 동의한 경우
2. 법령의 규정에 의거하거나 수사 목적으로 법령에 정한 절차에 따라 요구가 있는 경우

제5조 (개인정보의 처리 위탁)
회사는 서비스 제공을 위해 다음과 같이 개인정보 처리를 위탁할 수 있습니다.
- Supabase (호스팅 및 인증)
- 결제대행사 (결제 처리)

제6조 (이용자의 권리)
이용자는 언제든지 본인의 개인정보를 조회, 수정, 삭제 요청할 수 있으며, 가입 해지를 통해 처리 정지를 요청할 수 있습니다.

제7조 (개인정보의 안전성 확보 조치)
회사는 개인정보 보호를 위해 다음과 같은 조치를 취하고 있습니다.
1. 비밀번호 암호화 저장
2. 접속 기록 보관 및 위변조 방지
3. 개인정보 취급자 제한 및 교육

제8조 (개인정보보호 책임자)
이용자는 개인정보 관련 문의 사항을 아래 책임자에게 연락할 수 있습니다.
- 책임자: (개인정보보호책임자명 — 일반설정에서 관리)
- 이메일: (책임자 이메일)
- 연락처: (책임자 전화)

제9조 (방침의 변경)
본 방침이 변경될 경우 회사는 변경사항을 시행 7일 전부터 서비스 화면에 공지합니다.

부칙
본 방침은 2026년 4월 29일부터 시행됩니다.',
  '초기 표준 템플릿 (v1.0)'
)
ON CONFLICT DO NOTHING;
