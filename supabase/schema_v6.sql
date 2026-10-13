-- 할일 보드 v6: 영업일지 치과 구분 (교정과 / 교정페이 / 일반)
alter table public.journals add column if not exists clinic_type text
  check (clinic_type in ('교정과', '교정페이', '일반'));

-- 예전 일지 옮기기: 교정과 O → 교정과, 교정과 X → 일반
update public.journals set clinic_type = case when is_ortho then '교정과' else '일반' end
  where clinic_type is null and is_ortho is not null;
