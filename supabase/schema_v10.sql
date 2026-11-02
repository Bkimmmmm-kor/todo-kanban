-- 할일 보드 v10: 실험트랙 + 월별 매출 목표 달성현황. 여러 번 실행해도 안전.

-- ---------- 실험트랙 (영업일지와 같은 규칙: 승인된 본인만 읽고 쓰기, 마스터는 전체 조회) ----------
create table if not exists public.tracks (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text,                -- 트랙 이름
  purpose     text,                -- 목적
  plan        text,                -- 진행 방법
  status      text not null default '진행중' check (status in ('진행중', '종료')),
  -- 치과마다 {region, clinic, kind: 교정/비교정, status: 진행중/종료, start, end, dx: 진단 건수, mnft: 제작 건수}
  clinics     jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists tracks_user_idx on public.tracks (user_id);
alter table public.tracks enable row level security;

drop policy if exists "own tracks select" on public.tracks;
drop policy if exists "own tracks insert" on public.tracks;
drop policy if exists "own tracks update" on public.tracks;
drop policy if exists "own tracks delete" on public.tracks;
drop policy if exists "master tracks select" on public.tracks;
create policy "own tracks select" on public.tracks for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own tracks insert" on public.tracks for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own tracks update" on public.tracks for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()))
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own tracks delete" on public.tracks for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "master tracks select" on public.tracks for select to authenticated
  using ((select public.is_master()));

drop trigger if exists tracks_set_updated_at on public.tracks;
create trigger tracks_set_updated_at before update on public.tracks
  for each row execute function public.set_updated_at();

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tracks'
  ) then
    alter publication supabase_realtime add table public.tracks;
  end if;
end $$;

-- ---------- 월별 매출 실적 (사내 미니PC가 30분마다 월 합계만 올림, 마스터만 읽기) ----------
-- 청구월 = 전월 26일 ~ 당월 25일. 마감된 달은 마감 금액, 진행 중인 달은 오늘까지 청구 금액
create table if not exists public.sales_monthly (
  yyyymm      text primary key,
  amt         bigint not null,
  closed      boolean not null,
  synced_at   timestamptz not null default now()
);
alter table public.sales_monthly enable row level security;

drop policy if exists "sales master select" on public.sales_monthly;
drop policy if exists "sales sync select" on public.sales_monthly;
drop policy if exists "sales sync insert" on public.sales_monthly;
drop policy if exists "sales sync update" on public.sales_monthly;
create policy "sales master select" on public.sales_monthly for select to authenticated
  using ((select public.is_master()));
create policy "sales sync select" on public.sales_monthly for select to authenticated
  using ((select public.is_sync()));
create policy "sales sync insert" on public.sales_monthly for insert to authenticated
  with check ((select public.is_sync()));
create policy "sales sync update" on public.sales_monthly for update to authenticated
  using ((select public.is_sync())) with check ((select public.is_sync()));

-- ---------- 연간 매출 목표 (월별 12칸, 백만원 단위. 마스터만) ----------
create table if not exists public.sales_targets (
  year        int primary key,
  targets     numeric[] not null check (array_length(targets, 1) = 12),
  updated_at  timestamptz not null default now()
);
alter table public.sales_targets enable row level security;

drop policy if exists "targets master all" on public.sales_targets;
create policy "targets master all" on public.sales_targets for all to authenticated
  using ((select public.is_master())) with check ((select public.is_master()));

insert into public.sales_targets (year, targets)
values (2026, '{60,50,55,50,55,60,75,65,70,55,60,75}')
on conflict (year) do nothing;
