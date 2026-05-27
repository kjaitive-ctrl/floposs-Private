-- fee_rate 컬럼 추가 (없으면)
ALTER TABLE retail_platforms ADD COLUMN IF NOT EXISTS fee_rate NUMERIC(5,2);
ALTER TABLE retail_platforms ADD COLUMN IF NOT EXISTS memo TEXT;

-- 기본 플랫폼 데이터
INSERT INTO retail_platforms (retailer_id, name, fee_rate) VALUES
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '네이버 스마트스토어', 5.85),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '쿠팡', 10.80),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '무신사', 20.00),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '에이블리', 15.00),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '지그재그', 15.00),
  ('d4cdcd56-e47b-487f-8ace-d84654dec489', '자사몰', 0.00)
ON CONFLICT (retailer_id, name) DO NOTHING;
