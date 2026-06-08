// retail tenant 가입 필드 정리 엑셀 생성 (1회성)
// 출력: C:/Users/Min/Desktop/retail_tenant_fields.xlsx
import * as XLSX from "xlsx";
import path from "node:path";
import os from "node:os";

const sections = [
  {
    label: "A. 현재 가입 시 채우는 필드",
    rows: [
      {
        field: "휴대폰 (아이디)",
        column: "users.phone + users.email (dummy)",
        type: "TEXT",
        required: "필수",
        definition:
          "로그인 ID. 휴대폰 11자리 숫자만 박제 (users.phone). Supabase Auth 는 email/password 만 받으므로 {digits}@order-portal.local 형식의 가짜 이메일로 변환해 Auth 에 박제. 본인 식별 유일 키.",
        status: "가입 폼 입력. 형식 010-XXXX-XXXX 검증.",
        decision: "",
      },
      {
        field: "비밀번호",
        column: "Supabase Auth password",
        type: "TEXT (영문+숫자+특수문자 8자 이상)",
        required: "필수",
        definition:
          "로그인 비밀번호. 영문·숫자·특수문자 포함 8자 이상. Auth 에 bcrypt 해시로 저장. (레거시 4자리 PIN 가입자는 로그인 허용·점진 승격)",
        status: "가입 폼 입력 + 확인 칸 일치 검증.",
        decision: "",
      },
      {
        field: "매장명",
        column: "tenants.company_name + users.name",
        type: "TEXT",
        required: "필수",
        definition:
          "사장이 운영하는 매장 공식 명칭. 영수증/주문서/admin 목록/검색 결과에 노출. tenants 와 users 두 곳에 같은 값 박제 (users.name = 매장명).",
        status: "가입 폼 입력. 변경 UI 아직 없음.",
        decision: "",
      },
      {
        field: "매장 주소",
        column: "tenants.address",
        type: "TEXT",
        required: "선택",
        definition:
          "매장 실제 운영 위치 (도로명 주소). 사업자등록증 주소(biz_address)와 다를 수 있음. 향후 배송지/물류 매칭 시 사용.",
        status: "가입 폼 입력. 빈칸이면 NULL.",
        decision: "",
      },
      {
        field: "매장 대표연락처",
        column: "tenants.phone",
        type: "TEXT",
        required: "선택",
        definition:
          "가게 전화번호. 사장 휴대폰(로그인 ID, users.phone)과 별개. 도매처가 매장에 연락할 때 사용. 비어 있으면 로그인 휴대폰으로 자동 박제.",
        status: "가입 폼 입력. 빈칸이면 로그인 휴대폰으로 fallback.",
        decision: "",
      },
      {
        field: "기본 결제수단",
        column: "tenants.default_payment_method",
        type: "TEXT enum",
        required: "필수",
        definition:
          "도매처와 거래 시 기본 결제 방식. cash(현금) / transfer(계좌이체) / credit(외상·청구) 중 1택. 가입 후 변경 불가. 외부 주문 포털 submit 시 wholesale customers.payment_method 에 자동 박제.",
        status: "가입 폼 선택 (default credit). DB CHECK 제약.",
        decision: "",
      },
      {
        field: "tenant_type",
        column: "tenants.tenant_type",
        type: "TEXT enum",
        required: "자동",
        definition:
          "5축 가치사슬(디자이너/도매/물류/소매/플랫폼) + restaurant + other 중 vertical 식별자. retail 가입자는 항상 'retail' 박제. admin 3탭 분기/cookie 분리/RLS 가드의 핵심 키.",
        status: "가입 시 'retail' 고정 박제.",
        decision: "",
      },
      {
        field: "role",
        column: "users.role",
        type: "TEXT enum",
        required: "자동",
        definition:
          "사용자 권한 레벨. super_admin(우리)/tenant_admin(매장 사장)/manager/staff 중 1. 가입자 = 매장 사장이므로 항상 tenant_admin. 향후 직원 추가 시 staff/manager 박제.",
        status: "가입 시 'tenant_admin' 고정.",
        decision: "",
      },
      {
        field: "is_active",
        column: "tenants.is_active",
        type: "BOOLEAN",
        required: "자동",
        definition:
          "tenant 활성 상태. super_admin 이 정지/탈퇴 처리 시 false 박제. false 면 로그인 차단 + 모든 기능 접근 불가.",
        status: "가입 시 true 고정.",
        decision: "",
      },
      {
        field: "app_metadata (JWT)",
        column: "Supabase Auth app_metadata",
        type: "JSONB",
        required: "자동",
        definition:
          "{ role, user_type, tenant_id } 박제. JWT claim 에 박혀 매 요청마다 인증서로 사용. RLS 가드, /api/* 분기, cookie 분리(sb-retail-auth)에 활용.",
        status: "가입 직후 자동 박제.",
        decision: "",
      },
    ],
  },
  {
    label: "B. tenants 테이블에 컬럼 있지만 retail 가입에서 안 채우는 필드",
    rows: [
      {
        field: "사업자등록번호",
        column: "tenants.business_number",
        type: "TEXT UNIQUE",
        required: "선택",
        definition:
          "사업자등록증 10자리 번호 (예: 123-45-67890). 세금계산서/거래명세서 발행 시 필수. UNIQUE 제약 → 중복 가입 차단의 핵심 키. 본인인증 대체 수단으로 활용 가능.",
        status: "컬럼 존재, NULL. retail 가입 폼에 입력 칸 없음.",
        decision: "",
      },
      {
        field: "대표자명",
        column: "tenants.owner_name",
        type: "TEXT",
        required: "선택",
        definition:
          "사업자등록증상 대표자 (개인사업자=본인, 법인=대표이사). 매장명(브랜드명)과 다를 수 있음. 세무/계약/거래명세서에 사용.",
        status: "컬럼 존재. 현재 가입 시 매장명(company_name) 동일 박제 → 사실상 의미 없는 중복.",
        decision: "",
      },
      {
        field: "사업자등록증 주소",
        column: "tenants.biz_address",
        type: "TEXT",
        required: "선택",
        definition:
          "사업자등록증에 등재된 주소 (본사 주소). 실 매장 주소(address)와 다를 수 있음 (예: 본사는 따로, 매장만 운영). 세무신고/세금계산서 발행처 주소에 사용.",
        status: "컬럼 존재, NULL.",
        decision: "",
      },
      {
        field: "업체 카테고리",
        column: "tenants.category",
        type: "TEXT",
        required: "자동",
        definition:
          "매장 업종 분류. 마케팅/매출 통계/카테고리별 필터링에 사용. 현재 DEFAULT 'wholesale' 라 retail 도 'wholesale' 박힘 → 의미 불일치 (정리 필요).",
        status: "DEFAULT 'wholesale'. retail 가입 시 그대로 'wholesale' 박제 (검토 필요).",
        decision: "",
      },
      {
        field: "관리자 메모",
        column: "tenants.admin_note",
        type: "TEXT",
        required: "—",
        definition:
          "super_admin (우리) 만 보는 내부 메모. 고객 특이사항/요청사항/상담 기록 박제. 사장한테는 노출 X.",
        status: "NULL. admin/accounts 에서 우리가 수기 입력.",
        decision: "",
      },
      {
        field: "구독 플랜 (레거시)",
        column: "tenants.subscription_plan",
        type: "TEXT",
        required: "—",
        definition:
          "옛 구독 시스템 필드. basic/pro 같은 plan name. 신구독(plan_id FK)으로 이전 중이라 사용 안 함.",
        status: "DEFAULT 'basic'. 레거시, 무시 가능.",
        decision: "",
      },
      {
        field: "구독 상태 (레거시)",
        column: "tenants.subscription_status",
        type: "TEXT",
        required: "—",
        definition:
          "옛 구독 상태 (active/cancelled). 사용 안 함.",
        status: "DEFAULT 'active'. 레거시, 무시 가능.",
        decision: "",
      },
      {
        field: "구독 플랜 (신)",
        column: "tenants.plan_id",
        type: "UUID FK",
        required: "—",
        definition:
          "subscription_plans 테이블 참조. 신 구독 시스템. retail 은 아직 유료 플랜 적용 X.",
        status: "NULL.",
        decision: "",
      },
      {
        field: "구독 만료",
        column: "tenants.subscription_expires_at",
        type: "TIMESTAMPTZ",
        required: "—",
        definition:
          "유료 구독 만료 시각. 만료 시 기능 제한/읽기 전용 전환.",
        status: "NULL.",
        decision: "",
      },
      {
        field: "구독 해지 예약",
        column: "tenants.cancel_at_period_end",
        type: "BOOLEAN",
        required: "—",
        definition:
          "갱신 직전 해지 예약 플래그. 만료까지는 사용 가능하지만 자동 갱신 안 됨.",
        status: "DEFAULT false.",
        decision: "",
      },
      {
        field: "샘플 회수 기한",
        column: "tenants.sample_period_days",
        type: "INT",
        required: "—",
        definition:
          "도매처가 샘플 발송 후 회수까지 며칠 기한 두는지. wholesale 전용 필드. retail 사용 X.",
        status: "DEFAULT 7. wholesale 전용, retail 무시.",
        decision: "",
      },
      {
        field: "마지막 주문 시각",
        column: "tenants.last_order_at",
        type: "TIMESTAMPTZ",
        required: "자동",
        definition:
          "외부 주문 포털에서 마지막으로 주문 전송한 시각. 매장 활성도 지표 / 휴면 매장 식별 / admin 정렬에 사용.",
        status: "NULL. 외부 주문 submit 시 자동 갱신 (마이그 175).",
        decision: "",
      },
      {
        field: "박제 시각 / 수정 시각",
        column: "tenants.created_at / updated_at",
        type: "TIMESTAMPTZ",
        required: "자동",
        definition:
          "row 생성/마지막 수정 타임스탬프. 가입일 추적, admin 정렬에 사용.",
        status: "자동 박제.",
        decision: "",
      },
    ],
  },
  {
    label: "C. 영업 테스트용으로 추가 후보 (현재 컬럼 없음, 신규 마이그 필요)",
    rows: [
      {
        field: "사업자등록증 사본",
        column: "tenants.business_license_url (신규)",
        type: "TEXT (URL)",
        required: "—",
        definition:
          "사업자등록증 이미지 파일을 Supabase Storage 에 업로드 후 URL 박제. 본인인증/도매처와의 거래 신뢰성 확보.",
        status: "신규 컬럼 필요 + Storage bucket 필요.",
        decision: "",
      },
      {
        field: "매장 카테고리 (enum)",
        column: "tenants.store_category (신규)",
        type: "TEXT enum",
        required: "—",
        definition:
          "소매 매장 업종. 편집샵/속옷/잡화/액세서리/신발/가방/아동복/스포츠 등. 도매처가 retail 매장 검색/필터링할 때 사용. 마케팅 분류.",
        status: "신규 컬럼 + enum 정의 필요. 기존 category 컬럼과 별도로 갈지 합칠지 결정.",
        decision: "",
      },
      {
        field: "인스타그램",
        column: "tenants.instagram_handle (신규)",
        type: "TEXT",
        required: "—",
        definition:
          "@handle 형식. 매장 인스타 계정. 매장 진단/마케팅 채널/도매처가 retail 매장 컨셉 파악 시 활용.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "온라인 쇼핑몰 URL",
        column: "tenants.online_store_url (신규)",
        type: "TEXT (URL)",
        required: "—",
        definition:
          "자체 쇼핑몰 / 스마트스토어 / 카페24 URL. 오프라인 + 온라인 병행 매장 식별. v5 플랫폼 연동 시 매핑 기준.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "카카오톡 ID",
        column: "tenants.kakao_id (신규)",
        type: "TEXT",
        required: "—",
        definition:
          "사장 카톡 ID (또는 카톡 채널). 도매처-소매 영업 채널의 주력. CS/상담 채널.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "실 이메일",
        column: "tenants.real_email (신규)",
        type: "TEXT",
        required: "—",
        definition:
          "Auth 의 dummy email({phone}@order-portal.local)과 별도로 실제 사용 이메일 박제. 영수증/공지/마케팅 발송 채널.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "개업일",
        column: "tenants.opened_at (신규)",
        type: "DATE",
        required: "—",
        definition:
          "매장 오픈 일자. 신생/숙성 매장 분류. 매장 운영 기간 통계.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "매장 면적",
        column: "tenants.store_size_pyeong (신규)",
        type: "INT (평)",
        required: "—",
        definition:
          "매장 크기 (평). 매장 규모 분류 / 발주량 예측 / 도매처 추천 매칭.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "직원수",
        column: "tenants.staff_count (신규)",
        type: "INT",
        required: "—",
        definition:
          "매장 운영 인원 (사장 포함). 매장 규모 분류 / 향후 staff 권한 관리 기능 출시 시 활용.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "영업시간",
        column: "tenants.business_hours (신규)",
        type: "TEXT",
        required: "—",
        definition:
          "매장 영업 시간 (예: 평일 10-21, 주말 11-22). 자유 텍스트 or JSONB. 도매처 방문/배송 일정 협의 시 사용.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "주력 브랜드/카테고리",
        column: "tenants.focus_brand (신규)",
        type: "TEXT",
        required: "—",
        definition:
          "주로 판매하는 브랜드/스타일 (예: 영캐주얼, 미시, K2 스포츠). 도매처가 retail 매장 컨셉 파악 / 상품 추천에 사용.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "거래 도매처 수 (자기 보고)",
        column: "tenants.wholesale_partner_count (신규)",
        type: "INT",
        required: "—",
        definition:
          "현재 거래중인 도매처 대략적 숫자 (가입자 자기 보고). 매장 규모/네트워크 지표. 마케팅 분류용.",
        status: "신규 컬럼 필요.",
        decision: "",
      },
      {
        field: "월 평균 매출 구간",
        column: "tenants.monthly_revenue_band (신규)",
        type: "TEXT enum",
        required: "—",
        definition:
          "월 매출 구간 (1000만 미만/1-3천/3-5천/5천-1억/1억+). 실 매출 대신 구간으로 받아 부담 최소화. 마케팅 분류/플랜 추천에 사용.",
        status: "신규 컬럼 + enum 정의 필요.",
        decision: "",
      },
    ],
  },
];

const wb = XLSX.utils.book_new();

// 한 시트에 섹션 전부 (구분 + 빈 행으로 시각 분리)
const aoa = [];

// 헤더
aoa.push([
  "구분",
  "필드명 (한글)",
  "DB 컬럼 / 위치",
  "타입",
  "필수",
  "정의 (구체)",
  "현재 상태",
  "결정 (추가 / 유지 / 제거 / 변경)",
]);

for (const section of sections) {
  // 섹션 헤더 행 (한 칸에 라벨)
  aoa.push([section.label, "", "", "", "", "", "", ""]);
  for (const r of section.rows) {
    aoa.push([
      "",
      r.field,
      r.column,
      r.type,
      r.required,
      r.definition,
      r.status,
      r.decision,
    ]);
  }
  // 섹션 간 빈 행
  aoa.push(["", "", "", "", "", "", "", ""]);
}

const ws = XLSX.utils.aoa_to_sheet(aoa);

// 컬럼 너비
ws["!cols"] = [
  { wch: 6 },   // 구분
  { wch: 22 },  // 필드명
  { wch: 36 },  // DB 컬럼
  { wch: 14 },  // 타입
  { wch: 7 },   // 필수
  { wch: 70 },  // 정의
  { wch: 50 },  // 현재 상태
  { wch: 22 },  // 결정
];

// 행 높이 (헤더 / 본문)
ws["!rows"] = aoa.map((row, idx) => {
  if (idx === 0) return { hpt: 26 };
  // 섹션 헤더 행
  if (row[0] && !row[1]) return { hpt: 22 };
  return { hpt: 60 };
});

// 셀 단위 스타일 적용 (흑백)
const range = XLSX.utils.decode_range(ws["!ref"]);
const thinBlack = { style: "thin", color: { rgb: "000000" } };
const border = { top: thinBlack, bottom: thinBlack, left: thinBlack, right: thinBlack };

for (let R = range.s.r; R <= range.e.r; ++R) {
  for (let C = range.s.c; C <= range.e.c; ++C) {
    const addr = XLSX.utils.encode_cell({ r: R, c: C });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    const row = aoa[R];
    const isHeader = R === 0;
    const isSectionHeader = R > 0 && row[0] && !row[1];
    const isBlank = row.every(v => v === "");

    if (isBlank) {
      // 빈 행 — 테두리 없음
      ws[addr].s = { fill: { fgColor: { rgb: "FFFFFF" } } };
      continue;
    }

    ws[addr].s = {
      font: {
        name: "맑은 고딕",
        sz: isHeader ? 11 : isSectionHeader ? 11 : 10,
        bold: isHeader || isSectionHeader,
        color: { rgb: "000000" },
      },
      fill: {
        fgColor: {
          rgb: isHeader ? "D9D9D9" : isSectionHeader ? "F2F2F2" : "FFFFFF",
        },
      },
      alignment: {
        vertical: "center",
        horizontal: C === 5 || C === 6 ? "left" : C === 4 || C === 3 ? "center" : "left",
        wrapText: true,
      },
      border,
    };
  }
}

// freeze 첫 행
ws["!freeze"] = { xSplit: 0, ySplit: 1 };

XLSX.utils.book_append_sheet(wb, ws, "retail tenant 필드");

const outPath = path.join(os.homedir(), "Desktop", "retail_tenant_fields.xlsx");
XLSX.writeFile(wb, outPath, { cellStyles: true });
console.log("[OK] 생성:", outPath);
