-- 할일 보드 v7: 영업일지 방문 유형 (일반영업 / 관리방문)
alter table public.journals add column if not exists visit_type text
  check (visit_type in ('일반영업', '관리방문'));
