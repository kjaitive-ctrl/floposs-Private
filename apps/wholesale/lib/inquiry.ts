// 문의(inquiries) 공용 상수/타입.
//   - status / category 라벨, 색상 등 admin/dashboard 양쪽에서 사용.

export type InquiryStatus = "open" | "in_progress" | "resolved" | "closed";
export type InquiryCategory = "general" | "billing" | "technical" | "feature" | "other";

export const INQUIRY_STATUS_LABEL: Record<InquiryStatus, string> = {
  open: "접수",
  in_progress: "처리중",
  resolved: "해결됨",
  closed: "종결",
};

export const INQUIRY_STATUS_CLASS: Record<InquiryStatus, string> = {
  open: "bg-orange-100 text-orange-700",
  in_progress: "bg-primary-soft text-primary-hover",
  resolved: "bg-green-100 text-green-700",
  closed: "bg-gray-100 text-gray-500",
};

export const INQUIRY_CATEGORY_LABEL: Record<InquiryCategory, string> = {
  general: "일반",
  billing: "결제/구독",
  technical: "기술/오류",
  feature: "기능 제안",
  other: "기타",
};

export type Inquiry = {
  id: string;
  author_email: string;
  author_role: string;
  tenant_id: string | null;
  retailer_id: string | null;
  category: InquiryCategory;
  title: string;
  body: string;
  status: InquiryStatus;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
};

export type InquiryReply = {
  id: string;
  inquiry_id: string;
  responder_email: string;
  responder_role: string;
  is_admin_reply: boolean;
  body: string;
  created_at: string;
};
