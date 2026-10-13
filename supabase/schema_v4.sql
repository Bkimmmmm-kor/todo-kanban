-- 할일 보드 v4: 프로모션 패키지별 할인 (board.data)
-- data 예: { "discounts": { "lite": 50000, "moderate": 100000 }, "until": "2026-10-31" }
alter table public.board add column if not exists data jsonb not null default '{}'::jsonb;
