# 할일 보드 (영업사원용 업무 앱)

㈜리얼라이너 국내영업팀 업무 앱. 빌드 도구 없이 순수 HTML/CSS/JS로 만든 PWA이고, GitHub Pages로 배포한다.

- 배포 주소: https://bkimmmmm-kor.github.io/todo-kanban/
- 서버: Supabase (주소와 공개 키는 app.js 위쪽에 있음)
- 메뉴: 할일(칸반) · 영업일지 · 세일즈가이드(계산기 / 날짜계산기 / 자주쓰는멘트)

## 사용자
- 사용자는 영업팀장이고 개발자가 아니다. 한국어로, 쉬운 말로, 단계별로 설명한다.
- SQL은 Supabase SQL Editor에서 사용자가 직접 실행한다. 실행할 SQL은 클립보드에 복사해서 준다 (`Get-Content 파일 | Set-Clipboard`).
- 이 앱은 집 PC와 회사 미니PC 두 곳에서 개발한다. 작업 시작 전에 `git pull`, 끝나면 commit 후 push.

## 파일
- `index.html` 화면 구조 · `style.css` 디자인 · `app.js` 앱 로직 전체
- `calc.js` 수가 계산 규칙 (`realignerQuote`)
- `sw.js` 서비스 워커 (오프라인 캐시)
- `supabase/schema*.sql` 서버 표 정의 (v1부터 순서대로 적용됨)

## 배포 규칙 (꼭 지킬 것)
1. 수정할 때마다 버전을 올린다. 세 곳을 같은 숫자로 바꾼다.
   - `index.html`의 `?v=N` (style.css, calc.js, app.js)
   - `index.html`의 "앱 버전 N"
   - `sw.js`의 `VERSION = 'vN'`
2. 서버에 새 칸(열)이 필요하면 순서를 지킨다: 새 `supabase/schemaN.sql` 작성 → 사용자가 SQL 실행 → 서버에 칸이 생겼는지 확인 → push.
   순서가 바뀌면 동기화가 오프라인으로 멈춘다.
3. push하면 GitHub Pages에 1~2분 뒤 반영된다. 사용자는 폰에서 "앱 버전 N"으로 확인한다.

## 대외비
- **수가 금액은 절대 저장소에 넣지 않는다** (공개 저장소). 금액은 서버의 price_table에만 있고, 앱은 로그인한 뒤 받아온다.
- 금액 입력용 SQL은 저장소 밖(`어플개발\수가표_입력.sql`)에만 둔다.

## 주요 동작
- 가입하면 마스터가 승인해야 쓸 수 있다 (profiles.status, 서버 RLS의 is_approved()). 마스터 계정은 app.js의 MASTER_EMAILS와 SQL의 is_master()에 있다.
- 계산기: 등급(Family/Gold/Platinum) + 상·하악 stage → 패키지와 청구액. 프로모션 할인 자동 반영.
- 날짜계산기: 진단은 접수 후 4영업일에 업로드, 제작은 4영업일에 출고하고 택배로 1~2일 뒤 도착(토요일 배송 포함). 당일/익일 카운팅을 고를 수 있다 (11시 전이면 당일이 기본).
  - **공휴일 목록(app.js의 HOLIDAYS)은 해마다 다음 해 날짜를 추가해야 한다.** 토요일과 겹친 공휴일도 적는다.

## 테스트
- 앱 폴더에 `_test.html`을 임시로 만든다. index.html에서 supabase 스크립트를 빼고 테스트용 스크립트를 넣은 뒤 헤드리스 크롬으로 연다 (`--screenshot`, `--dump-dom`, `--virtual-time-budget`).
- 테스트가 끝나면 `_test.html`을 반드시 지운다 (올리지 않음).
