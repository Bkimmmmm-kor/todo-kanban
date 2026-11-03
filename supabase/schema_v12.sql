-- 할일 보드 v12: 영업지도 지역 연결 (일지의 동네 이름 → 수도권 시·구). 여러 번 실행해도 안전.
-- 모두가 같이 쓰는 사전: 승인된 사람은 읽고 고칠 수 있음 (알림톡 동기화 계정은 제외)
create table if not exists public.region_map (
  region      text primary key,    -- 일지에 적은 지역 (예: 은계)
  area        text not null,       -- 지도 시·구 (예: 경기 시흥시)
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now()
);
alter table public.region_map enable row level security;

drop policy if exists "region_map select" on public.region_map;
drop policy if exists "region_map insert" on public.region_map;
drop policy if exists "region_map update" on public.region_map;
create policy "region_map select" on public.region_map for select to authenticated
  using ((select public.is_approved()));
create policy "region_map insert" on public.region_map for insert to authenticated
  with check ((select public.is_approved()) and not (select public.is_sync()));
create policy "region_map update" on public.region_map for update to authenticated
  using ((select public.is_approved()) and not (select public.is_sync()))
  with check ((select public.is_approved()) and not (select public.is_sync()));

drop trigger if exists region_map_set_updated_at on public.region_map;
create trigger region_map_set_updated_at before update on public.region_map
  for each row execute function public.set_updated_at();
