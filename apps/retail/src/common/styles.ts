// 중앙 스타일 — 여기서 바꾸면 모든 페이지에 적용됩니다.
//
// 사이즈 등급:
//   Lg = 폼 (로그인/가입 등 외부 노출)     — py-2.5, rounded-lg
//   Md = 모달/내정보 (작은 폼)             — py-2,   rounded-lg
//   Sm = 표 셀 / 액션 (밀집 영역)          — py-1,   rounded
//
// 색상 등급:
//   text-black     = 본문 / 입력값
//   text-gray-600  = 라벨 / 가이드
//   text-gray-500  = 보조 / 메타
//   text-gray-400  = placeholder / 비활성

export const styles = {
  // ── 페이지 / 레이아웃 ──
  page: "min-h-screen bg-white",
  header: "bg-white border-b border-gray-200 px-6 py-4",
  headerTitle: "text-xl font-bold text-black",
  main: "max-w-6xl mx-auto px-6 py-8",

  // ── 카드 컨테이너 ──
  card: "bg-white border border-gray-200 rounded-2xl p-6",
  cardSm: "bg-white border border-gray-200 rounded-lg p-4",

  // ── 섹션 헤더 (폼 안의 구역 라벨) ──
  sectionHeader: "text-xs font-semibold text-gray-500 uppercase tracking-wider mt-4 mb-2 border-t border-gray-100 pt-3",
  sectionLabel: "text-xs font-semibold text-gray-400 uppercase mb-3",
  modalSection: "text-xs font-semibold text-gray-400 uppercase mb-3",  // = sectionLabel alias (호환)

  // ── 라벨 ──
  formLabel: "block text-sm font-medium text-gray-700 mb-1",   // Lg 폼용
  modalLabel: "block text-xs font-medium text-black mb-1",     // Md 폼용

  // ── 입력 (사이즈 등급) ──
  inputLg: "w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-primary-ring",
  inputMd: "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-primary-ring",
  inputSm: "px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-primary-ring",
  inputDisabled: "bg-gray-50 text-gray-500 cursor-not-allowed",

  // 호환 alias (옛 코드)
  modalInput: "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-primary-ring",
  filterInput: "px-3 py-1.5 border border-gray-300 rounded-lg text-sm text-black focus:outline-none focus:ring-2 focus:ring-primary-ring",

  // ── 버튼 (사이즈 + variant) ──
  btnPrimary:    "bg-primary text-white text-sm px-4 py-2 rounded-lg hover:bg-primary-hover disabled:opacity-50",
  btnSecondary:  "px-4 py-2 border border-gray-300 text-black text-sm rounded-lg hover:bg-gray-50 disabled:opacity-50",
  btnOutline:    "px-3 py-1 text-xs font-medium rounded border border-black text-black hover:bg-gray-100",
  btnSmall:      "px-2 py-0.5 text-xs border border-black text-black rounded hover:bg-gray-100",
  btnSmallGhost: "px-2 py-0.5 text-xs border border-gray-300 text-gray-600 rounded hover:bg-gray-50",

  // ── 모달 ──
  modalOverlay: "fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4",
  modalContent: "bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col",
  modalHeader:  "px-6 pt-6 pb-4 border-b border-gray-100",
  modalBody:    "overflow-y-auto flex-1 px-6 py-5 space-y-4",
  modalFooter:  "px-6 pb-6 pt-3 border-t border-gray-100 flex gap-2",

  // ── 알림/메시지 박스 ──
  msgError:   "text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2",
  msgOk:      "text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-3 py-2",
  msgWarn:    "text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2",

  // ── 필터 바 ──
  filterBar: "flex items-center gap-3 mb-4",
  filterCount: "ml-auto text-xs text-black",

  // ── 테이블 (일반) ──
  th: "text-center px-4 py-3 text-black font-medium whitespace-nowrap bg-gray-50",
  thLeft: "text-left px-4 py-3 text-black font-medium whitespace-nowrap bg-gray-50",
  tdText: "px-4 py-2 text-xs text-black",
  tdCenter: "px-4 py-2 text-xs text-center text-black",
  tdRight: "px-4 py-2 text-xs text-right text-black",
  tr: "border-b border-gray-100 hover:bg-gray-50 transition-colors",

  // ── 표 인라인 셀 (밀집 그리드 — /samples /products) ──
  // 헤더/셀 구조(sticky 줄 수·border 위치)는 페이지마다 달라 로컬에 둠.
  // gridInput 만 두 페이지에서 byte-identical 이라 공용으로 뺌.
  gridInput: "w-full px-2 py-1.5 text-xs bg-transparent text-black placeholder:text-gray-500 focus:outline-none focus:bg-white focus:ring-1 focus:ring-black focus:ring-inset",

  // ── 네비게이션 ──
  nav: "bg-white border-b border-gray-200 px-6 flex items-center gap-1 h-12",
  navBrand: "text-sm font-bold text-primary mr-6",
  navLink: "px-4 py-2 text-sm text-gray-500 hover:text-black border-b-2 border-transparent transition-colors",
  navLinkActive: "px-4 py-2 text-sm text-primary font-medium border-b-2 border-primary",
  navAction: "px-2 py-1 text-xs text-gray-600 hover:text-black border border-gray-200 rounded",

  // ── 상태 배지 ──
  badge: "inline-block px-2 py-0.5 text-xs rounded-full whitespace-nowrap",
  badgeSample: "bg-gray-100 text-gray-700",
  badgeShooting: "bg-blue-50 text-blue-700",
  badgeRegistered: "bg-green-50 text-green-700",
  badgeReturned: "bg-amber-50 text-amber-700",
  badgeInactive: "bg-red-50 text-red-700",
};

// 상태별 배지 클래스 매핑 (호출부에서 styles.badge와 함께 사용)
export const badgeClassByStatus: Record<string, string> = {
  sample_received: styles.badgeSample,
  shooting_done: styles.badgeShooting,
  registered: styles.badgeRegistered,
  returned: styles.badgeReturned,
  inactive: styles.badgeInactive,
};
