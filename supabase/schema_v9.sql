-- 할일 보드 v9: 영업채널 권한 · 담당자 코드 · 알림톡 발송 기록(사내 미니PC가 30분마다 올림)
-- schema_v8 까지 실행한 뒤 이 파일을 실행. 여러 번 실행해도 안전.

-- ---------- 영업채널 권한 / 담당자 코드 (마스터만 바꿀 수 있음) ----------
alter table public.profiles add column if not exists sales_access boolean not null default false;
alter table public.profiles add column if not exists emp_ids text[] not null default '{}';

-- 본인이 status·영업채널 권한·담당자 코드를 바꾸지 못하게 (v5 트리거 확장)
create or replace function public.profiles_guard_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not public.is_master() then
    if tg_op = 'INSERT' then
      new.status := 'pending';
      new.sales_access := false;
      new.emp_ids := '{}';
    else
      new.status := old.status;
      new.sales_access := old.sales_access;
      new.emp_ids := old.emp_ids;
    end if;
  end if;
  return new;
end;
$$;

-- 로그인한 사람의 담당자 코드 (승인 + 영업채널 권한이 있을 때만, 아니면 빈 목록)
create or replace function public.my_emp_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select p.emp_ids from public.profiles p
      where p.id = auth.uid() and p.status = 'approved' and p.sales_access),
    '{}'::text[])
$$;

-- 알림톡 기록을 올리는 전용 계정 (Authentication 에서 이 이메일로 사용자를 만들어 둠)
create or replace function public.is_sync() returns boolean
language sql stable set search_path = '' as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'alim-sync@realigner.co.kr'
$$;

-- ---------- 알림톡 발송 기록 (최근 7일치만 유지) ----------
-- 전화번호·문자 내용은 넣지 않음
create table if not exists public.alim_log (
  seq         bigint primary key,          -- 회사 DB 발송이력 번호
  send_dt     timestamptz not null,        -- 발송 시각
  clinic_id   text,
  clinic_name text,
  emp_id      text,                        -- 그 치과의 담당자 코드
  patient     text,                        -- 환자 실명(차트번호)
  kind        text,                        -- 안내 종류 (예: 진단완료안내)
  success     boolean not null,
  fail_msg    text,                        -- 실패 사유
  synced_at   timestamptz not null default now()
);
create index if not exists alim_log_emp_dt_idx on public.alim_log (emp_id, send_dt desc);
create index if not exists alim_log_dt_idx on public.alim_log (send_dt);
alter table public.alim_log enable row level security;

drop policy if exists "alim select" on public.alim_log;
drop policy if exists "alim sync insert" on public.alim_log;
drop policy if exists "alim sync update" on public.alim_log;
drop policy if exists "alim sync delete" on public.alim_log;
drop policy if exists "alim sync select" on public.alim_log;
-- 읽기: 승인된 사람 중 마스터는 전체, 영업채널은 본인 담당 치과만
create policy "alim select" on public.alim_log for select to authenticated
  using ((select public.is_approved())
         and ((select public.is_master()) or emp_id = any(public.my_emp_ids())));
-- 쓰기: 전용 계정만 (upsert 하려면 읽기도 필요)
create policy "alim sync select" on public.alim_log for select to authenticated
  using ((select public.is_sync()));
create policy "alim sync insert" on public.alim_log for insert to authenticated
  with check ((select public.is_sync()));
create policy "alim sync update" on public.alim_log for update to authenticated
  using ((select public.is_sync())) with check ((select public.is_sync()));
create policy "alim sync delete" on public.alim_log for delete to authenticated
  using ((select public.is_sync()));
