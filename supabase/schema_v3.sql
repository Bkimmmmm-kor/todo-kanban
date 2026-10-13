-- 할일 보드 v3: 수가표 (로그인한 사용자만 조회, 마스터만 수정)
-- 실제 금액은 이 저장소에 두지 않습니다. 금액 입력 SQL은 따로 전달받아 실행하세요.

create table if not exists public.price_table (
  id         int primary key default 1 check (id = 1),  -- 한 줄만 사용
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.price_table enable row level security;

drop policy if exists "price select" on public.price_table;
drop policy if exists "price master insert" on public.price_table;
drop policy if exists "price master update" on public.price_table;
create policy "price select" on public.price_table for select to authenticated using (true);
create policy "price master insert" on public.price_table for insert to authenticated
  with check ((select public.is_master()));
create policy "price master update" on public.price_table for update to authenticated
  using ((select public.is_master())) with check ((select public.is_master()));

drop trigger if exists price_table_set_updated_at on public.price_table;
create trigger price_table_set_updated_at before update on public.price_table
  for each row execute function public.set_updated_at();
