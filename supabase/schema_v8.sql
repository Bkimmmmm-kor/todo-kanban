-- 할일 보드 v8: 협업일지 (누가/어느 부서가 → 어떻게 협력 → 어떤 결과)
-- 영업일지와 같은 규칙: 승인된 본인만 읽고 쓰기, 마스터는 전체 조회. 여러 번 실행해도 안전.

create table if not exists public.collabs (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  collab_date date not null default current_date,
  partner     text,                -- 협력한 부서/사람
  clinic      text,                -- 관련 치과 (선택)
  how         text,                -- 어떻게 협력했는지
  result      text,                -- 어떤 결과가 있었는지
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists collabs_user_date_idx on public.collabs (user_id, collab_date);
alter table public.collabs enable row level security;

drop policy if exists "own collabs select" on public.collabs;
drop policy if exists "own collabs insert" on public.collabs;
drop policy if exists "own collabs update" on public.collabs;
drop policy if exists "own collabs delete" on public.collabs;
drop policy if exists "master collabs select" on public.collabs;
create policy "own collabs select" on public.collabs for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own collabs insert" on public.collabs for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own collabs update" on public.collabs for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()))
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own collabs delete" on public.collabs for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "master collabs select" on public.collabs for select to authenticated
  using ((select public.is_master()));

drop trigger if exists collabs_set_updated_at on public.collabs;
create trigger collabs_set_updated_at before update on public.collabs
  for each row execute function public.set_updated_at();

-- 실시간 동기화 (다른 기기에서 바꾸면 바로 반영)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'collabs'
  ) then
    alter publication supabase_realtime add table public.collabs;
  end if;
end $$;
