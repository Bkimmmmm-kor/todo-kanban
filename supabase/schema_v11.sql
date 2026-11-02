-- 할일 보드 v11: 실험트랙 기간 (치과는 트랙 기간 안에서만, 종료일은 트랙 종료일까지. 조기 종료 가능, 연장 불가)
-- 여러 번 실행해도 안전.
alter table public.tracks add column if not exists start_date date;
alter table public.tracks add column if not exists end_date date;
alter table public.tracks drop constraint if exists tracks_period_check;
alter table public.tracks add constraint tracks_period_check
  check (start_date is null or end_date is null or start_date <= end_date);
