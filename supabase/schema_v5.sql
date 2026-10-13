-- 할일 보드 v5: 회원가입 → 마스터 승인
-- 승인 전 계정은 할일·영업일지·공지·수가표에 접근할 수 없음. 여러 번 실행해도 안전.

-- 가입 상태: pending(승인 대기) / approved(승인) / rejected(거절)
alter table public.profiles add column if not exists status text not null default 'pending'
  check (status in ('pending', 'approved', 'rejected'));
alter table public.profiles add column if not exists created_at timestamptz not null default now();

-- 마스터 계정은 승인 상태로
update public.profiles set status = 'approved'
  where lower(email) in ('jungbae900@realigner.co.kr', 'jungbae900@naver.com');

-- 승인 여부 (마스터는 항상 승인)
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_master() or exists (
    select 1 from public.profiles where id = auth.uid() and status = 'approved'
  )
$$;

-- 본인이 status 를 바꾸지 못하게: 마스터가 아니면 새 가입은 pending, 수정 시 기존 값 유지
create or replace function public.profiles_guard_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not public.is_master() then
    if tg_op = 'INSERT' then
      new.status := 'pending';
    else
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_status on public.profiles;
create trigger profiles_guard_status before insert or update on public.profiles
  for each row execute function public.profiles_guard_status();

-- 마스터는 다른 사람의 가입 상태를 바꿀 수 있음
drop policy if exists "profile master update" on public.profiles;
create policy "profile master update" on public.profiles for update to authenticated
  using ((select public.is_master())) with check ((select public.is_master()));

-- ---------- 기존 규칙에 '승인된 사용자만' 조건 추가 ----------
-- 할일
drop policy if exists "own tasks select" on public.tasks;
drop policy if exists "own tasks insert" on public.tasks;
drop policy if exists "own tasks update" on public.tasks;
drop policy if exists "own tasks delete" on public.tasks;
create policy "own tasks select" on public.tasks for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own tasks insert" on public.tasks for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own tasks update" on public.tasks for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()))
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own tasks delete" on public.tasks for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));

-- 영업일지
drop policy if exists "own journals select" on public.journals;
drop policy if exists "own journals insert" on public.journals;
drop policy if exists "own journals update" on public.journals;
drop policy if exists "own journals delete" on public.journals;
create policy "own journals select" on public.journals for select to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own journals insert" on public.journals for insert to authenticated
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own journals update" on public.journals for update to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()))
  with check ((select auth.uid()) = user_id and (select public.is_approved()));
create policy "own journals delete" on public.journals for delete to authenticated
  using ((select auth.uid()) = user_id and (select public.is_approved()));

-- 공지 / 프로모션
drop policy if exists "board select" on public.board;
create policy "board select" on public.board for select to authenticated
  using ((select public.is_approved()));

-- 수가표
drop policy if exists "price select" on public.price_table;
create policy "price select" on public.price_table for select to authenticated
  using ((select public.is_approved()));

-- 승인되면 직원 앱이 바로 열리도록 실시간 알림
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;
end $$;
