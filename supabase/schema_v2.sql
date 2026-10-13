-- 할일 보드 v2: 영업일지 · 공지/프로모션 · 마스터 · 이름
-- schema.sql 을 먼저 실행한 뒤 이 파일을 실행. 여러 번 실행해도 안전.

-- 마스터 계정 확인 (로그인한 이메일로 판단)
create or replace function public.is_master() returns boolean
language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) in ('jungbae900@realigner.co.kr', 'jungbae900@naver.com')
$$;

-- ---------- 이름 (주간 보고서에 표시) ----------
create table if not exists public.profiles (
  id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  email      text,
  name       text,
  updated_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profile select" on public.profiles;
drop policy if exists "profile insert" on public.profiles;
drop policy if exists "profile update" on public.profiles;
create policy "profile select" on public.profiles for select to authenticated
  using ((select auth.uid()) = id or (select public.is_master()));
create policy "profile insert" on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);
create policy "profile update" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------- 할일: 마스터는 전체 조회 가능 (주간 보고서용) ----------
drop policy if exists "master tasks select" on public.tasks;
create policy "master tasks select" on public.tasks for select to authenticated
  using ((select public.is_master()));

-- ---------- 영업일지 ----------
create table if not exists public.journals (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  visit_date  date not null default current_date,
  region      text,
  clinic      text,
  is_ortho    boolean,                                   -- 교정과 여부
  temperature text check (temperature in ('상', '중', '하')), -- 감도
  content     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists journals_user_date_idx on public.journals (user_id, visit_date);
alter table public.journals enable row level security;

drop policy if exists "own journals select" on public.journals;
drop policy if exists "own journals insert" on public.journals;
drop policy if exists "own journals update" on public.journals;
drop policy if exists "own journals delete" on public.journals;
drop policy if exists "master journals select" on public.journals;
create policy "own journals select" on public.journals for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "own journals insert" on public.journals for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "own journals update" on public.journals for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own journals delete" on public.journals for delete to authenticated
  using ((select auth.uid()) = user_id);
create policy "master journals select" on public.journals for select to authenticated
  using ((select public.is_master()));

drop trigger if exists journals_set_updated_at on public.journals;
create trigger journals_set_updated_at before update on public.journals
  for each row execute function public.set_updated_at();

-- ---------- 공지 / 프로모션 (모두 읽기, 마스터만 쓰기) ----------
create table if not exists public.board (
  kind       text primary key check (kind in ('notice', 'promo')),
  body       text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.board enable row level security;

drop policy if exists "board select" on public.board;
drop policy if exists "board master insert" on public.board;
drop policy if exists "board master update" on public.board;
drop policy if exists "board master delete" on public.board;
create policy "board select" on public.board for select to authenticated using (true);
create policy "board master insert" on public.board for insert to authenticated
  with check ((select public.is_master()));
create policy "board master update" on public.board for update to authenticated
  using ((select public.is_master())) with check ((select public.is_master()));
create policy "board master delete" on public.board for delete to authenticated
  using ((select public.is_master()));

drop trigger if exists board_set_updated_at on public.board;
create trigger board_set_updated_at before update on public.board
  for each row execute function public.set_updated_at();

-- ---------- 실시간 동기화 ----------
do $$
declare t text;
begin
  foreach t in array array['journals', 'board'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
