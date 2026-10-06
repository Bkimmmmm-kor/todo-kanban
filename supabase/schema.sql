-- 할일 보드 데이터베이스 설정
-- Supabase 대시보드 → SQL Editor → New query 에 전체를 붙여넣고 Run

create table if not exists public.tasks (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  text        text not null,
  clinic      text,                -- 치과명 (선택)
  due         date,                -- 납기일 (선택)
  col         text not null default 'todo' check (col in ('todo', 'doing', 'done')),
  is_new      boolean not null default false,
  created_at  timestamptz not null default now(),
  moved_at    timestamptz not null default now(),  -- 현재 칸으로 옮긴 시각 (정렬용)
  done_at     timestamptz,
  archived_at timestamptz,         -- 값이 있으면 아카이브 항목 (30일 후 삭제)
  updated_at  timestamptz not null default now()
);

-- 예전 버전 SQL을 이미 실행한 경우를 위해
alter table public.tasks add column if not exists moved_at timestamptz not null default now();

create index if not exists tasks_user_id_idx on public.tasks (user_id);

-- 수정 시각 자동 기록
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at before update on public.tasks
  for each row execute function public.set_updated_at();

-- 보안: 로그인한 본인의 할일만 읽고 쓸 수 있음
alter table public.tasks enable row level security;

drop policy if exists "own tasks select" on public.tasks;
drop policy if exists "own tasks insert" on public.tasks;
drop policy if exists "own tasks update" on public.tasks;
drop policy if exists "own tasks delete" on public.tasks;

create policy "own tasks select" on public.tasks for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "own tasks insert" on public.tasks for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "own tasks update" on public.tasks for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own tasks delete" on public.tasks for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 실시간 동기화 (다른 기기에서 바꾸면 바로 반영)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'tasks'
  ) then
    alter publication supabase_realtime add table public.tasks;
  end if;
end $$;
