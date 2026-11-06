'use strict';

// 서버(Supabase) 연결 정보. publishable 키는 공개용이며, 데이터는 DB 보안 규칙(RLS)으로 보호됨
const SUPABASE_URL = 'https://ggukxzqsvlmfaxefazjc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_j_wtAX2FkiL4CkoB78jA3Q_otkyQPzG';
const APP_URL = location.origin + location.pathname;
// 화면 표시용. 실제 권한은 서버의 is_master() 규칙이 판단
const MASTER_EMAILS = ['jungbae900@realigner.co.kr', 'jungbae900@naver.com'];
// 사내 서버(회사 미니PC). 회사 DB를 보는 현황판·미납은 사내 와이파이에서만 열림
const OFFICE_URL = 'http://192.168.0.55:8501';
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
const PPTX_URL = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';

const ARCHIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COLS = ['todo', 'done']; // v23: '진행 중' 칸 없앰 (예전 카드는 dropDoing 이 할 일로 옮김)
const COL_NAMES = { todo: '할 일', done: '완료' };
const VIEWS = {
  todo: '할일', journal: '영업일지', collab: '협업일지', track: '실험트랙', alim: '알림톡 내역', sales: '월별 매출 목표',
  clinic: '치과', calc: '세일즈가이드',
};
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const LONG_PRESS_MS = 500;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const sb = window.supabase
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    // implicit: PC에서 가입하고 폰에서 확인 메일을 눌러도 동작
    auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  : null;

// ---------- 상태 ----------
let user = null;
let profileName = '';
let accessOk = false; // 승인된 사용자(또는 마스터)인지
let salesAccess = false; // 영업채널 권한 (치과 메뉴, 마스터가 켬)
let authToken = null; // 사내 서버에 넘길 로그인 토큰
let tasks = [];
let archive = [];
let journals = [];
let collabs = []; // 협업일지
let tracks = []; // 실험트랙
let notes = { notice: '', promo: '' }; // 공지 / 프로모션 문구
let promo = { discounts: {}, until: '' }; // 프로모션 패키지별 할인액(원), 종료일
let activeCol = 'todo';
let todoMode = 'kanban'; // 할일 보기: kanban / cal(달력)
let calMonth = null; // 달력에 보이는 달 (1일)
let calSel = null; // 달력에서 고른 날 'YYYY-MM-DD'
let journalMode = 'list'; // 영업일지 보기: list / revisit(재방리스트) / map(영업지도)
let regionMap = {}; // 일지 지역 이름 → 지도 시·구 (공용, 직접 고른 것)

const isMaster = () => MASTER_EMAILS.includes(user?.email?.toLowerCase());

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const toIso = (ms) => (ms ? new Date(ms).toISOString() : null);
const toMs = (iso) => (iso ? Date.parse(iso) : null);
const byNewest = (key) => (a, b) => (b[key] || b.createdAt) - (a[key] || a.createdAt);

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---------- 서버 표 ↔ 화면 데이터 변환 ----------
function taskToRow(t) {
  return {
    id: t.id,
    text: t.text,
    clinic: t.clinic || null,
    due: t.due || null,
    col: t.col,
    is_new: !!t.isNew,
    created_at: toIso(t.createdAt),
    moved_at: toIso(t.movedAt || t.createdAt),
    done_at: toIso(t.doneAt),
    archived_at: toIso(t.archivedAt),
  };
}

function taskFromRow(r) {
  const t = { id: r.id, text: r.text, col: r.col, createdAt: toMs(r.created_at), movedAt: toMs(r.moved_at), doneAt: toMs(r.done_at) };
  if (r.clinic) t.clinic = r.clinic;
  if (r.due) t.due = r.due;
  if (r.is_new) t.isNew = true;
  if (r.archived_at) t.archivedAt = toMs(r.archived_at);
  return t;
}

function journalToRow(j) {
  return {
    id: j.id,
    visit_date: j.date,
    region: j.region || null,
    clinic: j.clinic || null,
    clinic_type: j.type || null,
    visit_type: j.visit || null,
    temperature: j.temp || null,
    content: j.content || null,
    created_at: toIso(j.createdAt),
  };
}

function journalFromRow(r) {
  return {
    id: r.id,
    date: r.visit_date,
    region: r.region || '',
    clinic: r.clinic || '',
    type: clinicType(r),
    visit: VISIT_TYPES.includes(r.visit_type) ? r.visit_type : '',
    temp: r.temperature || '',
    content: r.content || '',
    createdAt: toMs(r.created_at),
  };
}

// 치과 구분: 교정과 / 교정페이 / 일반 (예전 일지의 교정과 O/X 도 변환)
const CLINIC_TYPES = ['교정과', '교정페이', '일반'];
// 방문 유형: 일반영업(신규 영업) / 관리방문(기존 거래처 관리)
const VISIT_TYPES = ['일반영업', '관리방문'];
function clinicType(r) {
  if (CLINIC_TYPES.includes(r.clinic_type)) return r.clinic_type;
  if (r.is_ortho === true) return '교정과';
  if (r.is_ortho === false) return '일반';
  return '';
}

function collabToRow(c) {
  return {
    id: c.id,
    collab_date: c.date,
    partner: c.partner || null,
    clinic: c.clinic || null,
    how: c.how || null,
    result: c.result || null,
    created_at: toIso(c.createdAt),
  };
}

function collabFromRow(r) {
  return {
    id: r.id,
    date: r.collab_date,
    partner: r.partner || '',
    clinic: r.clinic || '',
    how: r.how || '',
    result: r.result || '',
    createdAt: toMs(r.created_at),
  };
}

// 실험트랙: 치과 목록(clinics)은 통째로 jsonb 한 칸에 저장
function trackToRow(t) {
  return {
    id: t.id,
    title: t.title || null,
    purpose: t.purpose || null,
    plan: t.plan || null,
    status: t.status,
    start_date: t.start || null,
    end_date: t.end || null,
    clinics: t.clinics,
    created_at: toIso(t.createdAt),
  };
}

function trackFromRow(r) {
  return {
    id: r.id,
    title: r.title || '',
    purpose: r.purpose || '',
    plan: r.plan || '',
    status: r.status || '진행중',
    start: r.start_date || '',
    end: r.end_date || '',
    clinics: Array.isArray(r.clinics) ? r.clinics : [],
    createdAt: toMs(r.created_at),
  };
}

// 진행중 트랙이 위로, 같은 상태면 최근에 만든 것이 위로
const sortTracks = (list) => list.sort((a, b) => trackOn(b) - trackOn(a) || b.createdAt - a.createdAt);

// 영업일지·협업일지 공통: 최근 날짜가 위로
const sortJournals = (list) => list.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

// 서버와 동기화하는 표 목록
const stores = {
  tasks: {
    items: () => [...tasks, ...archive],
    toRow: taskToRow,
    apply(rows) {
      const list = rows.map(taskFromRow);
      tasks = list.filter((t) => !t.archivedAt).sort(byNewest('movedAt'));
      archive = list.filter((t) => t.archivedAt).sort(byNewest('archivedAt'));
    },
    fromRow: taskFromRow,
    synced: new Map(), // id → 서버에 저장된 마지막 내용(JSON)
  },
  journals: {
    items: () => journals,
    toRow: journalToRow,
    apply(rows) {
      journals = sortJournals(rows.map(journalFromRow));
    },
    fromRow: journalFromRow,
    synced: new Map(),
  },
  collabs: {
    items: () => collabs,
    toRow: collabToRow,
    apply(rows) {
      collabs = sortJournals(rows.map(collabFromRow));
    },
    fromRow: collabFromRow,
    synced: new Map(),
  },
  tracks: {
    items: () => tracks,
    toRow: trackToRow,
    apply(rows) {
      tracks = sortTracks(rows.map(trackFromRow));
    },
    fromRow: trackFromRow,
    synced: new Map(),
  },
};

// ---------- 저장 / 동기화 ----------
// 화면에서 바꾼 내용은 save() → 기기 캐시에 바로 저장 → 서버와 다른 부분만 서버로 전송
function save() {
  saveCache();
  return queuePush();
}

const cacheKey = () => `kanban-cache-${user.id}`;

function saveCache() {
  if (!user) return;
  try {
    localStorage.setItem(cacheKey(), JSON.stringify({
      tasks, archive, journals, collabs, tracks, notes, promo, regionMap, profileName, priceData: priceTable, approved: accessOk,
      synced: Object.fromEntries(Object.entries(stores).map(([k, s]) => [k, [...s.synced]])),
    }));
  } catch { /* 저장 공간 부족 등: 서버 저장은 계속됨 */ }
}

function loadCache() {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey()));
    if (!data) return;
    tasks = data.tasks || [];
    archive = data.archive || [];
    // 예전 캐시의 교정과 O/X → 구분으로 변환
    journals = (data.journals || []).map((j) => ('type' in j ? j : { ...j, type: clinicType({ is_ortho: j.ortho }) }));
    collabs = data.collabs || [];
    tracks = data.tracks || [];
    regionMap = data.regionMap || {};
    notes = data.notes || notes;
    promo = data.promo || promo;
    dropDoing();
    accessOk = !!data.approved;
    profileName = data.profileName || '';
    setPriceTable(data.priceData);
    // 예전 캐시(할일만 있던 버전)는 synced 가 배열
    const synced = Array.isArray(data.synced) ? { tasks: data.synced } : (data.synced || {});
    for (const [k, s] of Object.entries(stores)) s.synced = new Map(synced[k] || []);
  } catch { /* 캐시가 깨졌으면 서버에서 다시 받음 */ }
}

function pendingChanges(store) {
  const current = new Map(store.items().map((x) => [x.id, JSON.stringify(store.toRow(x))]));
  const upserts = [...current].filter(([id, json]) => store.synced.get(id) !== json);
  const deletes = [...store.synced.keys()].filter((id) => !current.has(id));
  return { upserts, deletes };
}

const hasPending = () => Object.values(stores).some((s) => {
  const { upserts, deletes } = pendingChanges(s);
  return upserts.length || deletes.length;
});

let pushChain = Promise.resolve(true);
function queuePush() {
  pushChain = pushChain.then(push, push);
  return pushChain;
}

async function push() {
  if (!user || !sb || !accessOk) return false;
  if (!hasPending()) return true;
  setSync('saving');
  try {
    for (const [table, store] of Object.entries(stores)) {
      const { upserts, deletes } = pendingChanges(store);
      if (upserts.length) {
        const { error } = await sb.from(table).upsert(upserts.map(([, json]) => JSON.parse(json)));
        if (error) throw error;
        upserts.forEach(([id, json]) => store.synced.set(id, json));
      }
      if (deletes.length) {
        const { error } = await sb.from(table).delete().in('id', deletes);
        if (error) throw error;
        deletes.forEach((id) => store.synced.delete(id));
      }
    }
    saveCache();
    setSync('ok');
    return true;
  } catch (err) {
    console.error('[sync] push', err);
    setSync('offline');
    return false;
  }
}

// 서버는 한 번에 최대 1000건만 주므로 나눠서 모두 받기
// build: 매번 새 쿼리를 만드는 함수 (정렬 기준이 고정돼 있어야 함)
const PAGE_SIZE = 1000;
async function selectAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build().range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

// 서버에서 최신 내용 받기 (보내지 못한 변경이 있으면 먼저 보냄)
let pulling = false;
let pullAgain = false;
async function pull() {
  if (!user || !sb) return;
  if (!accessOk) return checkAccess();
  if (pulling) {
    pullAgain = true; // 받는 중에 또 바뀌었으면 끝난 뒤 한 번 더
    return;
  }
  pulling = true;
  pullAgain = false;
  try {
    if (!(await queuePush())) return;
    const uid = user.id;
    const [taskData, journalData, collabData, trackData, boardRes, priceRes, regionRes] = await Promise.all([
      // 마스터는 모든 사람 것을 볼 수 있으므로 내 것만 받음
      selectAll(() => sb.from('tasks').select('*').eq('user_id', uid).order('id')),
      selectAll(() => sb.from('journals').select('*').eq('user_id', uid).order('id')),
      selectAll(() => sb.from('collabs').select('*').eq('user_id', uid).order('id')),
      selectAll(() => sb.from('tracks').select('*').eq('user_id', uid).order('id')),
      sb.from('board').select('kind, body, data'),
      sb.from('price_table').select('data').maybeSingle(),
      sb.from('region_map').select('region, area'),
    ]);
    if (boardRes.error) throw boardRes.error;
    if (user?.id !== uid) return; // 받는 사이 로그아웃
    if (hasPending()) return; // 받는 사이에 화면에서 바뀜 → 다음 동기화 때 반영
    for (const [table, data] of [['tasks', taskData], ['journals', journalData], ['collabs', collabData], ['tracks', trackData]]) {
      const store = stores[table];
      store.apply(data);
      store.synced = new Map(data.map((r) => [r.id, JSON.stringify(store.toRow(store.fromRow(r)))]));
    }
    notes = { notice: '', promo: '' };
    promo = { discounts: {}, until: '' };
    boardRes.data.forEach((r) => {
      notes[r.kind] = r.body || '';
      if (r.kind === 'promo' && r.data) promo = { discounts: r.data.discounts || {}, until: r.data.until || '' };
    });
    // 수가표는 없어도 나머지 동기화는 계속
    if (priceRes.error) console.error('[sync] price', priceRes.error);
    else setPriceTable(priceRes.data?.data);
    if (regionRes.error) console.error('[sync] region_map', regionRes.error);
    else regionMap = Object.fromEntries(regionRes.data.map((r) => [r.region, r.area]));
    if (dropDoing()) queuePush();
    saveCache();
    renderAll();
    setSync('ok');
    purgeArchive();
  } catch (err) {
    console.error('[sync] pull', err);
    setSync('offline');
  } finally {
    pulling = false;
    if (pullAgain) schedulePull();
  }
}

let pullTimer;
function schedulePull(delay = 400) {
  clearTimeout(pullTimer);
  pullTimer = setTimeout(pull, delay);
}

function setSync(state) {
  const el = $('#syncStatus');
  el.textContent = { ok: '✓ 동기화됨', saving: '저장 중…', offline: '⚠ 오프라인' }[state] || '';
  el.classList.toggle('warn', state === 'offline');
}

// 보관 30일이 지난 아카이브 항목 삭제
function purgeArchive() {
  const limit = Date.now() - ARCHIVE_DAYS * DAY_MS;
  const before = archive.length;
  archive = archive.filter((t) => t.archivedAt > limit);
  if (archive.length !== before) {
    renderTasks();
    save();
  }
}

// ---------- 메뉴 전환 ----------
// sub: 그 화면의 안쪽 탭 (세일즈가이드: calc/date/ment, 치과: board/ar/invoice)
function setView(view, sub) {
  if (!VIEWS[view] || (view === 'sales' && !isMaster())) view = 'todo';
  document.body.dataset.view = view;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  if (sub && view === 'calc') setGuideTab(sub);
  if (sub && view === 'clinic') setClinicTab(sub);
  if (view === 'alim') loadAlim();
  if (view === 'sales') loadSales();
  $('#pageTitle').textContent = VIEWS[view];
  markDrawer();
  try {
    localStorage.setItem('last-view', view);
  } catch { /* 무시 */ }
}

// ---------- 서랍 메뉴 ----------
const drawer = $('#drawer');
const currentSub = (view) => (view === 'calc' ? $('#guideTabs [aria-selected="true"]')?.dataset.guide
  : view === 'clinic' ? $('#clinicTabs [aria-selected="true"]')?.dataset.clinic : undefined);

function markDrawer() {
  const view = document.body.dataset.view;
  const sub = currentSub(view);
  $$('#drawer [data-view]').forEach((b) => {
    const on = b.dataset.view === view && (!b.dataset.sub || b.dataset.sub === sub);
    if (on) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
}

$('#menuBtn').addEventListener('click', () => {
  $('#reportBtn').hidden = !isMaster();
  $('#salesNavBtn').hidden = !isMaster();
  markDrawer();
  drawer.showModal();
});
$$('#drawer [data-view]').forEach((b) => b.addEventListener('click', () => {
  setView(b.dataset.view, b.dataset.sub);
  drawer.close();
}));

function renderAll() {
  renderQuote();
  renderTasks();
  renderJournals();
  renderCollabs();
  renderTracks();
  renderNotes();
  renderAutocomplete();
}

// ================= 할일 =================
// 예전 '진행 중' 카드 → 할 일. 바뀐 게 있으면 true
function dropDoing() {
  const doing = tasks.filter((t) => t.col === 'doing');
  doing.forEach((t) => (t.col = 'todo'));
  return doing.length > 0;
}

// 할 일은 날짜가 꼭 있어야 함 (달력에 표시)
function addTask(text, clinic = '', due = '') {
  text = text.trim();
  if (!text) return false;
  if (!due) {
    showToast('날짜를 골라 주세요.');
    openPicker(dueInput);
    return false;
  }
  const now = Date.now();
  const task = { id: newId(), text, col: 'todo', due, createdAt: now, movedAt: now, doneAt: null }; // due: 'YYYY-MM-DD'
  if (clinic.trim()) task.clinic = clinic.trim();
  tasks.unshift(task);
  save();
  setActiveCol('todo');
  renderTasks();
  renderAutocomplete();
  vibrate(40);
  showToast(`추가됨: ${text}`, () => {
    tasks = tasks.filter((t) => t.id !== task.id);
    save();
    renderTasks();
  });
  return true;
}

function moveTask(id, col) {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.col === col) return;
  const prev = { col: task.col, doneAt: task.doneAt, isNew: task.isNew, movedAt: task.movedAt };
  task.col = col;
  task.movedAt = Date.now();
  task.doneAt = col === 'done' ? task.movedAt : null;
  task.isNew = true; // 옮겨간 칸에서 NEW로 표시
  // 이동한 카드를 해당 열 맨 위로
  tasks = [task, ...tasks.filter((t) => t.id !== id)];
  save();
  renderTasks();
  vibrate(20);
  showToast(`${COL_NAMES[col]}(으)로 이동`, () => {
    Object.assign(task, prev);
    tasks.sort(byNewest('movedAt'));
    save();
    renderTasks();
  });
}

function deleteTask(id) {
  const index = tasks.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [removed] = tasks.splice(index, 1);
  save();
  renderTasks();
  showToast('삭제됨', () => {
    tasks.splice(index, 0, removed);
    save();
    renderTasks();
  });
}

const editDialog = $('#editDialog');
let editTaskId = null;

function editTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  editTaskId = id;
  $('#editClinic').value = task.clinic || '';
  $('#editDue').value = task.due || '';
  $('#editText').value = task.text;
  editDialog.showModal();
}

$('#editForm').addEventListener('submit', () => {
  const task = tasks.find((t) => t.id === editTaskId);
  const text = $('#editText').value.trim();
  const due = $('#editDue').value;
  if (!task || !text || !due) return;
  task.text = text;
  task.due = due;
  const clinic = $('#editClinic').value.trim();
  if (clinic) task.clinic = clinic; else delete task.clinic;
  save();
  renderTasks();
  renderAutocomplete();
});

// 완료 항목을 아카이브로 이동
function clearDone() {
  const done = tasks.filter((t) => t.col === 'done');
  if (!done.length) return;
  const prevTasks = tasks.slice();
  const prevArchive = archive.slice();
  const now = Date.now();
  archive = [...done.map(({ isNew, ...t }) => ({ ...t, archivedAt: now })), ...archive];
  tasks = tasks.filter((t) => t.col !== 'done');
  save();
  renderTasks();
  showToast(`완료 ${done.length}개를 아카이브로 옮김`, () => {
    tasks = prevTasks;
    archive = prevArchive;
    save();
    renderTasks();
  });
}

function formatTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `오늘 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

// 납기 빠른 순 → 납기 없는 카드는 아래 → 같으면 최근에 옮긴 순
function byDue(a, b) {
  if (a.due && b.due) return a.due.localeCompare(b.due) || (b.movedAt || 0) - (a.movedAt || 0);
  if (a.due || b.due) return a.due ? -1 : 1;
  return (b.movedAt || b.createdAt) - (a.movedAt || a.createdAt);
}

function renderTasks() {
  for (const col of COLS) {
    const list = $(`[data-list="${col}"]`);
    const items = tasks.filter((t) => t.col === col);
    if (col !== 'done') items.sort(byDue);
    list.replaceChildren(...items.map(cardEl));
    $(`[data-count="${col}"]`).textContent = items.length;
    $(`.tab[data-col="${col}"]`).classList.toggle('has-new', items.some((t) => t.isNew));
  }
  $('#archiveCount').textContent = archive.length ? `(${archive.length})` : '';
  renderCalendar();
}

// ---------- 달력 보기 ----------
// 날짜가 없는 예전 할 일은 등록한 날에 표시
const taskDay = (t) => t.due || ymd(new Date(t.createdAt));

function setTodoMode(mode) {
  todoMode = mode === 'cal' ? 'cal' : 'kanban';
  const cal = todoMode === 'cal';
  $$('#todoMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === todoMode));
  $('.view[data-view="todo"]').classList.toggle('cal-mode', cal);
  $('#calendar').hidden = !cal;
  $('#todoHint').textContent = cal
    ? '날짜를 고르고 아래에 적기 · 할 일 탭: 완료/되돌리기 · 길게 누르기: 수정/삭제'
    : '탭: 완료로 · 길게 누르기: 수정/삭제';
  setDue(cal ? calSel : ymd(new Date()));
  renderCalendar();
  try {
    localStorage.setItem('todo-mode', todoMode);
  } catch { /* 무시 */ }
}

function selectDay(day) {
  calSel = day;
  const d = parseYmd(day);
  calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  setDue(day);
  renderCalendar();
}

function renderCalendar() {
  if (todoMode !== 'cal') return;
  const byDay = new Map();
  // 적은 순서대로 아래로 이어짐. 완료(아카이브 포함)는 가로줄
  for (const t of [...tasks, ...archive].sort((a, b) => a.createdAt - b.createdAt)) {
    const day = taskDay(t);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(t);
  }
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  $('#calTitle').textContent = `${y}년 ${m + 1}월`;
  const today = ymd(new Date());
  const weeks = Math.ceil((calMonth.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
  const cells = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(y, m, 1 - calMonth.getDay() + i);
    const day = ymd(d);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day';
    cell.dataset.day = day;
    cell.classList.toggle('out', d.getMonth() !== m);
    cell.classList.toggle('today', day === today);
    cell.classList.toggle('sel', day === calSel);
    cell.classList.toggle('red', d.getDay() === 0 || HOLIDAYS.has(day));
    cell.classList.toggle('blue', d.getDay() === 6 && !HOLIDAYS.has(day));
    const num = document.createElement('span');
    num.className = 'cal-num';
    num.textContent = d.getDate();
    cell.append(num);
    for (const t of byDay.get(day) || []) {
      const item = document.createElement('span');
      item.className = `cal-item${t.col === 'done' ? ' done' : ''}`;
      item.textContent = t.text;
      cell.append(item);
    }
    cells.push(cell);
  }
  $('#calGrid').replaceChildren(...cells);
  const list = byDay.get(calSel) || [];
  $('#calDayTitle').textContent = `${dayLabel(calSel)} · ${list.length}개`;
  $('#calList').replaceChildren(...list.map(cardEl));
}

$$('#todoMode button').forEach((b) => b.addEventListener('click', () => setTodoMode(b.dataset.mode)));
$('#calGrid').addEventListener('click', (e) => {
  const cell = e.target.closest('.cal-day');
  if (cell) selectDay(cell.dataset.day);
});
function shiftMonth(n) {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + n, 1);
  renderCalendar();
}
$('#calPrev').addEventListener('click', () => shiftMonth(-1));
$('#calNext').addEventListener('click', () => shiftMonth(1));
$('#calToday').addEventListener('click', () => selectDay(ymd(new Date())));

// 예전에 입력한 치과명·지역을 자동완성 목록으로
function renderAutocomplete() {
  const fill = (sel, values) => $(sel).replaceChildren(...[...new Set(values.filter(Boolean))].map((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    return opt;
  }));
  const trackClinics = tracks.flatMap((t) => t.clinics);
  fill('#clinicList', [...journals, ...collabs, ...tasks, ...archive, ...trackClinics].map((t) => t.clinic));
  fill('#regionList', [...journals, ...trackClinics].map((j) => j.region));
  fill('#partnerList', collabs.map((c) => c.partner));
}

// 납기일 표시: '10/8 (D-2)', 오늘이면 D-day
function dueLabel(due) {
  const date = parseYmd(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / DAY_MS);
  const dday = diff === 0 ? 'D-day' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  return { text: `${date.getMonth() + 1}/${date.getDate()} (${dday})`, diff };
}

function tagEl(text, cls = '') {
  const span = document.createElement('span');
  span.className = `tag ${cls}`.trim();
  span.textContent = text;
  return span;
}

function cardEl(task) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = task.id;
  li.dataset.col = task.col;
  if (task.clinic || task.due) {
    const tags = document.createElement('div');
    tags.className = 'tags';
    if (task.due) {
      const { text, diff } = dueLabel(task.due);
      const urgent = task.col !== 'done' && (diff <= 0 ? 'due-over' : diff === 1 ? 'due-soon' : '');
      tags.append(tagEl(`📅 ${text}`, urgent || ''));
    }
    if (task.clinic) tags.append(tagEl(`🦷 ${task.clinic}`, 'clinic'));
    li.append(tags);
  }
  if (task.isNew) {
    const badge = document.createElement('span');
    badge.className = 'new-badge';
    badge.textContent = 'NEW';
    li.append(badge);
  }
  li.append(task.text);
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = task.col === 'done' && task.doneAt
    ? `완료 ${formatTime(task.doneAt)}`
    : `등록 ${formatTime(task.createdAt)}`;
  li.append(meta);
  return li;
}

function setActiveCol(col) {
  // 보고 있던 칸을 떠나면 그 칸의 NEW 표시를 지움
  if (col !== activeCol) {
    let changed = false;
    for (const t of tasks) {
      if (t.col === activeCol && t.isNew) {
        delete t.isNew;
        changed = true;
      }
    }
    if (changed) {
      save();
      renderTasks();
    }
  }
  activeCol = col;
  $$('.tab[data-col]').forEach((tab) => tab.setAttribute('aria-selected', tab.dataset.col === col));
  $$('.column').forEach((c) => c.classList.toggle('active', c.dataset.col === col));
}

// ---------- 토스트 (되돌리기) ----------
let toastTimer;
function showToast(msg, undo) {
  const toast = $('#toast');
  const undoBtn = $('#toastUndo');
  $('#toastMsg').textContent = msg;
  undoBtn.hidden = !undo;
  undoBtn.onclick = () => {
    toast.hidden = true;
    undo();
  };
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}

function vibrate(ms) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// ---------- 카드: 탭 = 완료(달력에서는 완료/되돌리기), 길게 누르기 = 메뉴 ----------
let pressTimer = null;
let pressStart = null;
let longPressed = false;

const board = $('.view[data-view="todo"]'); // 칸반 + 달력의 그날 목록

board.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  longPressed = false;
  pressStart = { x: e.clientX, y: e.clientY };
  pressTimer = setTimeout(() => {
    longPressed = true;
    vibrate(30);
    openCardMenu(card.dataset.id);
  }, LONG_PRESS_MS);
});

board.addEventListener('pointermove', (e) => {
  if (!pressTimer || !pressStart) return;
  // 스크롤 중이면 길게 누르기 취소
  if (Math.abs(e.clientX - pressStart.x) > 10 || Math.abs(e.clientY - pressStart.y) > 10) cancelPress();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((type) => board.addEventListener(type, cancelPress));

function cancelPress() {
  clearTimeout(pressTimer);
  pressTimer = null;
}

board.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (!card || longPressed) return;
  const task = tasks.find((t) => t.id === card.dataset.id);
  if (!task) return; // 아카이브된 카드(달력)는 그대로
  if (card.closest('#calList')) moveTask(task.id, task.col === 'done' ? 'todo' : 'done');
  else if (task.col === 'done') openCardMenu(task.id);
  else moveTask(task.id, 'done');
});

board.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.card')) e.preventDefault();
});

const cardMenu = $('#cardMenu');
let menuTaskId = null;

function openCardMenu(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  menuTaskId = id;
  $('#menuTitle').textContent = task.text;
  cardMenu.querySelectorAll('[data-action]').forEach((btn) => {
    btn.hidden = btn.dataset.action === task.col;
  });
  cardMenu.showModal();
}

cardMenu.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action || action === 'close') return;
  cardMenu.close();
  if (action === 'edit') editTask(menuTaskId);
  else if (action === 'delete') deleteTask(menuTaskId);
  else if (COLS.includes(action)) moveTask(menuTaskId, action);
});

$$('.tab[data-col]').forEach((tab) => tab.addEventListener('click', () => setActiveCol(tab.dataset.col)));

$('#addForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#taskInput');
  if (!addTask(input.value, $('#clinicInput').value, $('#dueInput').value)) {
    input.focus();
    return;
  }
  input.value = '';
  $('#clinicInput').value = '';
  // 달력에서는 같은 날에 이어서 적음, 칸반은 오늘로 돌아감
  setDue(todoMode === 'cal' ? calSel : ymd(new Date()));
});

// 날짜 버튼: 누르면 달력, 고르면 버튼에 날짜 표시 (기본 오늘, 꼭 있어야 함)
const dueInput = $('#dueInput');
const dueBtn = $('#dueBtn');

function setDue(value) {
  dueInput.value = value;
  dueBtn.textContent = value ? `📅 ${dueLabel(value).text}` : '📅 날짜';
  dueBtn.classList.toggle('set', !!value);
}

function openPicker(input) {
  try {
    input.showPicker();
  } catch {
    input.focus();
    input.click();
  }
}

dueBtn.addEventListener('click', () => openPicker(dueInput));
dueInput.addEventListener('change', () => {
  if (!dueInput.value) return setDue(todoMode === 'cal' ? calSel : ymd(new Date())); // 지우기 누름
  if (todoMode === 'cal') selectDay(dueInput.value);
  else setDue(dueInput.value);
});

$('#clearDoneBtn').addEventListener('click', clearDone);

// ================= 영업일지 =================
function dayLabel(dateStr) {
  const d = parseYmd(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - d) / DAY_MS);
  const base = `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
  return diff === 0 ? `오늘 · ${base}` : diff === 1 ? `어제 · ${base}` : base;
}

// 날짜별로 묶은 목록 (영업일지·협업일지). fill(li, item): 카드 내용 채우기
function renderDayList(listSel, list, fill) {
  const items = [];
  let lastDate = null;
  for (const x of list) {
    if (x.date !== lastDate) {
      const h = document.createElement('li');
      h.className = 'journal-day';
      h.textContent = dayLabel(x.date);
      items.push(h);
      lastDate = x.date;
    }
    const li = document.createElement('li');
    li.className = 'journal-item';
    li.dataset.id = x.id;
    fill(li, x);
    items.push(li);
  }
  $(listSel).replaceChildren(...items);
}

function journalHead(title) {
  const head = document.createElement('div');
  head.className = 'j-head';
  const name = document.createElement('span');
  name.className = 'j-clinic';
  name.textContent = title;
  head.append(name);
  return head;
}

function renderJournals() {
  if (journalMode === 'revisit') renderRevisit();
  if (journalMode === 'map' && MAP_READY) renderSalesMap();
  renderDayList('#journalList', journals, (li, j) => {
    const head = journalHead(j.clinic || '(치과명 없음)');
    if (j.region) head.append(tagEl(`📍 ${j.region}`));
    if (j.visit) head.append(tagEl(j.visit, j.visit === '관리방문' ? 'visit-care' : 'visit-sales'));
    if (j.type) head.append(tagEl(j.type));
    if (j.temp) head.append(tagEl(`감도 ${j.temp}`, `temp-${j.temp}`));
    li.append(head);
    if (j.content) {
      const p = document.createElement('p');
      p.className = 'j-content';
      p.textContent = j.content;
      li.append(p);
    }
  });
}

// ---------- 영업일지 보기: 영업일지 / 재방리스트 / 영업지도 ----------
function setJournalMode(mode) {
  journalMode = ['revisit', 'map'].includes(mode) ? mode : 'list';
  $$('#journalMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === journalMode));
  $$('[data-jmode]').forEach((el) => (el.hidden = el.dataset.jmode !== journalMode));
  renderJournals();
  try {
    localStorage.setItem('journal-mode', journalMode);
  } catch { /* 무시 */ }
}
$$('#journalMode button').forEach((b) => b.addEventListener('click', () => setJournalMode(b.dataset.mode)));

const daysAgo = (day) => Math.round((parseYmd(ymd(new Date())) - parseYmd(day)) / DAY_MS);
// 올해가 아니면 연도도: 2025/9/1
const dayText = (day) => (day.slice(0, 4) === ymd(new Date()).slice(0, 4) ? '' : `${day.slice(0, 4)}/`) + mdShort(parseYmd(day));
const agoText = (day) => {
  const n = daysAgo(day);
  return n <= 0 ? '오늘' : `${n}일 전`;
};
// 최근 일지가 먼저: 방문일, 같은 날이면 작성 순서
const newerFirst = (a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0);

// 재방리스트: 치과마다 가장 최근 일지의 감도가 상·중이면 넣고, 마지막 방문이 오래된 치과가 위로
function renderRevisit() {
  const byClinic = new Map();
  for (const j of journals) {
    const name = j.clinic.trim();
    if (!name) continue;
    if (!byClinic.has(name)) byClinic.set(name, []);
    byClinic.get(name).push(j);
  }
  const rows = [...byClinic.values()]
    .map((list) => ({ last: [...list].sort(newerFirst)[0], count: list.length }))
    .filter(({ last }) => last.temp === '상' || last.temp === '중')
    .sort((a, b) => a.last.date.localeCompare(b.last.date));
  $('#revisitList').replaceChildren(...rows.map(({ last, count }) => {
    const li = document.createElement('li');
    li.className = 'journal-item';
    li.dataset.id = last.id;
    const head = journalHead(last.clinic.trim());
    if (last.region) head.append(tagEl(`📍 ${last.region}`));
    head.append(tagEl(`감도 ${last.temp}`, `temp-${last.temp}`));
    const meta = document.createElement('p');
    meta.className = 'revisit-meta';
    const when = document.createElement('b');
    when.textContent = `${dayText(last.date)} (${agoText(last.date)})`;
    when.classList.toggle('old', daysAgo(last.date) >= 30);
    meta.append('마지막 방문 ', when, ` · 방문 ${count}회`);
    li.append(head, meta);
    if (last.content) {
      const p = document.createElement('p');
      p.className = 'j-content c-line';
      p.textContent = last.content;
      li.append(p);
    }
    return li;
  }));
}

// 재방리스트에서 누르면 그 치과로 새 일지 작성
$('#revisitList').addEventListener('click', (e) => {
  const item = e.target.closest('.journal-item');
  const last = item && journals.find((x) => x.id === item.dataset.id);
  if (last) openJournal(null, '일반영업', { region: last.region, clinic: last.clinic.trim(), type: last.type });
});

// ---------- 영업지도 ----------
const MAP_READY = false; // 영업지도 보류(공사 중). 다시 열 때 true + index.html #mapPane hidden 해제
let mapData = null; // map/capital.json (수도권 시·구 경계 + 동 이름 사전)
let mapLoading = null;
let mapSel = null; // 누른 시·구 id
let mapZoom = 'all';

function loadMapData() {
  mapLoading ||= fetch('map/capital.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((d) => {
      mapData = d;
      // 이름으로 찾기: '광명시'·'광명', 일반구 '분당구'·'분당'
      mapData.names = [];
      for (const a of d.areas) {
        for (const n of [a.name, ...a.gu]) {
          mapData.names.push([n, a.id]);
          const short = n.replace(/(시|군|구)$/, '');
          if (short.length >= 2) mapData.names.push([short, a.id]);
        }
      }
      if (journalMode === 'map') renderSalesMap();
    })
    .catch((err) => {
      console.error('[map]', err);
      mapLoading = null;
      $('#mapSummary').textContent = '지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.';
    });
  return mapLoading;
}

// 일지 '지역' → 시·구 id. 직접 고른 것 → 시·구 이름 → 동 이름 순. 못 찾거나 후보가 여럿이면 null
function regionArea(text) {
  const key = (text || '').trim();
  if (!key) return null;
  if (regionMap[key]) return regionMap[key];
  const byName = new Set(mapData.names.filter(([n]) => key.includes(n)).map(([, id]) => id));
  if (byName.size === 1) return [...byName][0];
  if (byName.size > 1) return null;
  for (const token of key.split(/[\s_·,()/]+/)) {
    for (let len = token.length; len >= 2; len--) {
      const hit = mapData.dong[token.slice(0, len)];
      if (hit) return hit.length === 1 ? hit[0] : null;
    }
  }
  return null;
}

// 마지막 방문일 → 색: 3개월 안 파랑 / 3개월+ 초록 / 6개월+ 노랑 / 12개월+·없음 빨강
function mapColor(last) {
  if (!last) return 'm-red';
  const before = (months) => {
    const d = new Date();
    d.setMonth(d.getMonth() - months);
    return ymd(d);
  };
  if (last > before(3)) return 'm-blue';
  if (last > before(6)) return 'm-green';
  if (last > before(12)) return 'm-yellow';
  return 'm-red';
}

const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const areaLabel = (a) => (a.name.length > 2 ? a.name.replace(/(시|군|구)$/, '') : a.name);

function renderSalesMap() {
  if (!mapData) {
    $('#mapSummary').textContent = '지도를 불러오는 중…';
    loadMapData();
    return;
  }
  // 시·구별 방문 일지 (최근순)
  const visits = new Map();
  const unmatched = new Map(); // 지역 이름 → 일지 수
  for (const j of [...journals].sort(newerFirst)) {
    if (!j.region.trim()) continue;
    const id = regionArea(j.region);
    if (!id) {
      unmatched.set(j.region.trim(), (unmatched.get(j.region.trim()) || 0) + 1);
      continue;
    }
    if (!visits.has(id)) visits.set(id, []);
    visits.get(id).push(j);
  }
  const svg = $('#mapSvg');
  const seoul = mapZoom === 'seoul';
  const shown = mapData.areas.filter((a) => !seoul || a.id.startsWith('서울'));
  const paths = shown.map((a) => {
    const last = visits.get(a.id)?.[0]?.date;
    const p = svgEl('path', { d: a.d, class: `${mapColor(last)}${a.id === mapSel ? ' sel' : ''}`, 'data-id': a.id });
    const title = svgEl('title');
    title.textContent = `${a.id} · ${last ? `마지막 방문 ${dayText(last)}` : '방문 기록 없음'}`;
    p.append(title);
    return p;
  });
  const sel = paths.find((p) => p.dataset.id === mapSel);
  if (sel) paths.push(paths.splice(paths.indexOf(sel), 1)[0]); // 굵은 테두리가 가려지지 않게 맨 위로
  // 이름: 서울 보기는 구 이름, 수도권 보기는 누른 시·구만 (깔끔하게)
  const labels = shown.filter((a) => seoul || a.id === mapSel).map((a) => {
    const t = svgEl('text', { x: a.x, y: a.y });
    t.textContent = areaLabel(a);
    return t;
  });
  svg.replaceChildren(...paths, ...labels);
  const box = seoul ? mapData.seoul : [0, 0, mapData.w, mapData.h];
  svg.setAttribute('viewBox', box.join(' '));
  labels.forEach((t) => t.setAttribute('style', `font-size:${(box[2] / (seoul ? 42 : 40)).toFixed(1)}px`));
  $$('#mapZoom button').forEach((b) => b.classList.toggle('on', b.dataset.zoom === mapZoom));
  const total = mapData.areas.length;
  $('#mapSummary').textContent = `방문한 시·구 ${visits.size} / ${total}`;
  renderMapDetail(visits);
  renderUnmatched(unmatched);
}

function renderMapDetail(visits) {
  const box = $('#mapDetail');
  const area = mapData.areas.find((a) => a.id === mapSel);
  if (!area) {
    box.innerHTML = '<p class="muted map-sec"><small>지도에서 시·구를 누르면 방문한 치과가 나와요.</small></p>';
    return;
  }
  const list = visits.get(area.id) || [];
  const h = document.createElement('p');
  h.className = 'map-sec';
  h.textContent = area.id;
  const small = document.createElement('small');
  small.textContent = list.length ? `마지막 방문 ${dayText(list[0].date)} (${agoText(list[0].date)}) · ${list.length}건` : '방문 기록 없음';
  h.append(small);
  const ul = document.createElement('ul');
  ul.className = 'map-visits';
  ul.append(...list.slice(0, 30).map((j) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${j.clinic || '(치과명 없음)'} · ${j.region}`;
    const when = document.createElement('span');
    when.textContent = `${dayText(j.date)}${j.visit ? ` ${j.visit}` : ''}`;
    li.append(name, when);
    return li;
  }));
  box.replaceChildren(h, ul);
}

// 자동으로 못 찾은 지역 이름: 한 번 고르면 모두가 같이 씀(region_map)
function renderUnmatched(unmatched) {
  const box = $('#mapUnmatched');
  if (!unmatched.size) {
    box.replaceChildren();
    return;
  }
  const h = document.createElement('p');
  h.className = 'map-sec';
  h.textContent = `연결 안 된 지역 ${unmatched.size}개`;
  const small = document.createElement('small');
  small.textContent = '어느 시·구인지 한 번만 골라 주세요';
  h.append(small);
  const options = [...mapData.areas].sort((a, b) => a.id.localeCompare(b.id, 'ko'));
  const rows = [...unmatched].map(([name, n]) => {
    const row = document.createElement('div');
    row.className = 'unmatched-row';
    const b = document.createElement('b');
    b.textContent = `${name} (${n})`;
    const select = document.createElement('select');
    select.dataset.region = name;
    select.append(new Option('시·구 고르기', ''), ...options.map((a) => new Option(a.id, a.id)));
    row.append(b, select);
    return row;
  });
  box.replaceChildren(h, ...rows);
}

$('#mapUnmatched').addEventListener('change', async (e) => {
  const { region } = e.target.dataset;
  const area = e.target.value;
  if (!region || !area) return;
  regionMap[region] = area;
  saveCache();
  renderSalesMap();
  showToast(`'${region}' → ${area}`);
  if (!sb || !user) return;
  const { error } = await sb.from('region_map').upsert({ region, area });
  if (error) {
    console.error('[region_map]', error);
    showToast('이 기기에만 저장했어요. 서버 저장은 나중에 다시 골라 주세요.');
  }
});

$('#mapSvg').addEventListener('click', (e) => {
  const id = e.target.closest('path')?.dataset.id;
  if (!id) return;
  mapSel = mapSel === id ? null : id;
  renderSalesMap();
});
$('#mapZoom').addEventListener('click', (e) => {
  const zoom = e.target.closest('button')?.dataset.zoom;
  if (!zoom || zoom === mapZoom) return;
  mapZoom = zoom;
  renderSalesMap();
});

// 선택 버튼 묶음(교정과, 감도, 등급): 다시 누르면 선택 해제
function segValue(seg) {
  return seg.querySelector('button.on')?.dataset.value ?? '';
}
function setSeg(seg, value) {
  seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === String(value)));
}
function bindSeg(seg, onChange, allowEmpty = true) {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const next = btn.classList.contains('on') && allowEmpty ? '' : btn.dataset.value;
    setSeg(seg, next);
    onChange?.(next);
  });
}

const journalDialog = $('#journalDialog');
let editJournalId = null;
bindSeg($('#jType'));
bindSeg($('#jTemp'));

// prefill: 재방리스트에서 새로 쓸 때 지역·치과명·구분
function openJournal(id = null, visit = '', prefill = {}) {
  const j = journals.find((x) => x.id === id);
  editJournalId = j ? j.id : null;
  $('#journalDialogTitle').textContent = j ? '영업일지 수정' : '영업일지 작성';
  setSeg($('#jVisit'), j ? j.visit || '' : visit);
  $('#jDate').value = j ? j.date : ymd(new Date());
  const src = j || prefill;
  $('#jRegion').value = src.region || '';
  $('#jClinic').value = src.clinic || '';
  setSeg($('#jType'), src.type || '');
  setSeg($('#jTemp'), j?.temp || '');
  $('#jContent').value = j?.content || '';
  $('#jDeleteBtn').hidden = !j;
  journalDialog.showModal();
}

// [＋ 영업일지 작성] → 먼저 일반영업 / 관리방문 선택
const visitTypeDialog = $('#visitTypeDialog');
$('#newJournalBtn').addEventListener('click', () => visitTypeDialog.showModal());
visitTypeDialog.addEventListener('click', (e) => {
  const visit = e.target.closest('[data-visit]')?.dataset.visit;
  if (!visit) return;
  visitTypeDialog.close();
  openJournal(null, visit);
});
bindSeg($('#jVisit'), null, false);
$('#journalList').addEventListener('click', (e) => {
  const item = e.target.closest('.journal-item');
  if (item) openJournal(item.dataset.id);
});

$('#journalForm').addEventListener('submit', (e) => {
  const data = {
    date: $('#jDate').value || ymd(new Date()),
    region: $('#jRegion').value.trim(),
    clinic: $('#jClinic').value.trim(),
    visit: segValue($('#jVisit')),
    type: segValue($('#jType')),
    temp: segValue($('#jTemp')),
    content: $('#jContent').value.trim(),
  };
  if (!data.clinic && !data.content) {
    e.preventDefault();
    showToast('치과명이나 내용 중 하나는 적어 주세요.');
    return;
  }
  const existing = journals.find((x) => x.id === editJournalId);
  if (existing) Object.assign(existing, data);
  else journals.push({ id: newId(), createdAt: Date.now(), ...data });
  sortJournals(journals);
  save();
  renderJournals();
  renderAutocomplete();
  vibrate(30);
  showToast(existing ? '영업일지를 수정했어요.' : '영업일지를 저장했어요.');
});

$('#jDeleteBtn').addEventListener('click', () => {
  const index = journals.findIndex((x) => x.id === editJournalId);
  if (index < 0) return;
  const [removed] = journals.splice(index, 1);
  journalDialog.close();
  save();
  renderJournals();
  showToast('영업일지를 삭제했어요.', () => {
    journals.push(removed);
    sortJournals(journals);
    save();
    renderJournals();
  });
});

// ================= 협업일지 =================
// 누가/어느 부서가 → 어떻게 협력 → 어떤 결과
function collabLine(label, text) {
  const p = document.createElement('p');
  p.className = 'j-content c-line';
  const b = document.createElement('b');
  b.textContent = label;
  p.append(b, text);
  return p;
}

function renderCollabs() {
  renderDayList('#collabList', collabs, (li, c) => {
    const head = journalHead(`🤝 ${c.partner || '(협력자 없음)'}`);
    if (c.clinic) head.append(tagEl(`🦷 ${c.clinic}`));
    li.append(head);
    if (c.how) li.append(collabLine('협력', c.how));
    if (c.result) li.append(collabLine('결과', c.result));
  });
}

const collabDialog = $('#collabDialog');
let editCollabId = null;

function openCollab(id = null) {
  const c = collabs.find((x) => x.id === id);
  editCollabId = c ? c.id : null;
  $('#collabDialogTitle').textContent = c ? '협업일지 수정' : '협업일지 작성';
  $('#cDate').value = c ? c.date : ymd(new Date());
  $('#cPartner').value = c?.partner || '';
  $('#cClinic').value = c?.clinic || '';
  $('#cHow').value = c?.how || '';
  $('#cResult').value = c?.result || '';
  $('#cDeleteBtn').hidden = !c;
  collabDialog.showModal();
}

$('#newCollabBtn').addEventListener('click', () => openCollab());
$('#collabList').addEventListener('click', (e) => {
  const item = e.target.closest('.journal-item');
  if (item) openCollab(item.dataset.id);
});

$('#collabForm').addEventListener('submit', (e) => {
  const data = {
    date: $('#cDate').value || ymd(new Date()),
    partner: $('#cPartner').value.trim(),
    clinic: $('#cClinic').value.trim(),
    how: $('#cHow').value.trim(),
    result: $('#cResult').value.trim(),
  };
  if (!data.partner || !(data.how || data.result)) {
    e.preventDefault();
    showToast('협력자와, 협력 내용이나 결과 중 하나는 적어 주세요.');
    return;
  }
  const existing = collabs.find((x) => x.id === editCollabId);
  if (existing) Object.assign(existing, data);
  else collabs.push({ id: newId(), createdAt: Date.now(), ...data });
  sortJournals(collabs);
  save();
  renderCollabs();
  renderAutocomplete();
  vibrate(30);
  showToast(existing ? '협업일지를 수정했어요.' : '협업일지를 저장했어요.');
});

$('#cDeleteBtn').addEventListener('click', () => {
  const index = collabs.findIndex((x) => x.id === editCollabId);
  if (index < 0) return;
  const [removed] = collabs.splice(index, 1);
  collabDialog.close();
  save();
  renderCollabs();
  showToast('협업일지를 삭제했어요.', () => {
    collabs.push(removed);
    sortJournals(collabs);
    save();
    renderCollabs();
  });
});

// ================= 계산기 =================
// 수가 규칙은 calc.js 의 realignerQuote() 에 있음
const CALC_KEY = 'calc-quote';
let calc = { grade: 'gold', name: '', upper: '', lower: '' };
try {
  const saved = JSON.parse(localStorage.getItem(CALC_KEY));
  if (saved && ['family', 'gold', 'platinum'].includes(saved.grade)) calc = { ...calc, ...saved };
} catch { /* 무시 */ }

function saveCalc() {
  try {
    localStorage.setItem(CALC_KEY, JSON.stringify(calc));
  } catch { /* 무시 */ }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function quoteCard(q, sub = false) {
  const card = el('div', `quote${sub ? ' sub' : ''}`);
  card.append(
    el('p', 'quote-pkg', q.name),
    el('p', 'quote-price', `${won(q.price)}원`),
    el('p', 'quote-formula', q.formula),
  );
  if (q.discount) {
    const promoLine = el('p', 'quote-promo', `🎁 프로모션 -${won(q.discount)}원`);
    promoLine.append(el('span', 'quote-list', `정가 ${won(q.listPrice)}원`));
    card.append(promoLine);
  }
  if (q.key !== 'unit') card.append(el('p', 'quote-meta', `보증 ${q.warranty} · 리파인먼트 ${q.refinement}`));
  return card;
}

let lastQuoteText = '';
const promoNote = (x) => (x.discount ? ` (프로모션 ${won(x.discount)}원 할인 적용)` : '');

function renderQuote() {
  const out = $('#calcOut');
  if (!priceTable) {
    out.replaceChildren(el('p', 'calc-empty', user
      ? '수가표를 불러오는 중이에요. 인터넷 연결을 확인해 주세요.'
      : '로그인하면 수가표를 불러와요.'));
    $('#calcCopyBtn').hidden = true;
    lastQuoteText = '';
    return;
  }
  const q = realignerQuote(calc.grade, calc.upper, calc.lower, priceTable, activeDiscounts());
  $('#calcCopyBtn').hidden = !q;
  if (!q) {
    out.replaceChildren(el('p', 'calc-empty', '상악·하악 stage를 입력하면 청구액이 나와요.'));
    lastQuoteText = '';
    return;
  }
  const stages = q.arches.map(([label, n]) => `${label} ${n}`).join(' · ');
  const basis = q.single
    ? `${stages} stage · 편악 진행 (패키지가 60%${Object.values(activeDiscounts()).some((v) => v > 0) ? ', 프로모션 할인 제외' : ''})`
    : `${stages} stage → 큰 쪽 ${q.maxStage} stage 기준`;
  const nodes = [el('p', 'quote-basis', `${q.grade} · ${basis}`)];
  const lines = ['[리얼라이너 수가 안내]'];
  if (calc.name.trim()) lines.push(`환자: ${calc.name.trim()}`);
  lines.push(stages.replaceAll(' · ', ' / ') + ' stage' + (q.single ? ' (편악)' : ''));

  if (q.choices) {
    nodes.push(el('p', 'quote-basis', '40 stage 이상: 아래 두 패키지 중 선택 (추가 비용 없음)'));
    q.choices.forEach((c, i) => nodes.push(quoteCard(c, i > 0)));
    q.choices.forEach((c) => lines.push(`· ${c.name}: ${won(c.price)}원${promoNote(c)} (보증 ${c.warranty})`));
  } else {
    nodes.push(quoteCard(q.main));
    lines.push(`· ${q.main.name}: ${won(q.main.price)}원${promoNote(q.main)}`);
    lines.push(`  (${q.main.formula})`);
  }

  const alt = q.alternative;
  if (alt) {
    const tip = el('div', 'quote-tip');
    const benefit = alt.key === 'unit' ? '' : ` · 보증 ${alt.warranty}, 리파인먼트 ${alt.refinement}`;
    tip.append('💡 ', el('strong', '', `${alt.name}`), ` 적용 시 ${won(alt.price)}원 — `,
      el('strong', '', `${won(alt.saving)}원 절감`), benefit);
    nodes.push(tip, quoteCard(alt, true));
    lines.push(`· 추천 ${alt.name}: ${won(alt.price)}원${promoNote(alt)} (${won(alt.saving)}원 절감${benefit})`);
  }
  lines.push('※ VAT 포함');
  lastQuoteText = lines.join('\n');
  out.replaceChildren(...nodes);
}

function syncCalcInputs() {
  setSeg($('#gradeSeg'), calc.grade);
  $('#calcName').value = calc.name;
  $('#calcUpper').value = calc.upper;
  $('#calcLower').value = calc.lower;
  renderQuote();
}

bindSeg($('#gradeSeg'), (value) => {
  calc.grade = value;
  saveCalc();
  renderQuote();
}, false);

[['#calcName', 'name'], ['#calcUpper', 'upper'], ['#calcLower', 'lower']].forEach(([sel, field]) => {
  $(sel).addEventListener('input', (e) => {
    if (field !== 'name') e.target.value = e.target.value.replace(/\D/g, '').slice(0, 3);
    calc[field] = e.target.value;
    saveCalc();
    renderQuote();
  });
});

$('#calcCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(lastQuoteText);
    showToast('견적을 복사했어요. 카톡에 붙여넣으면 돼요.');
  } catch {
    showToast('복사하지 못했어요.');
  }
});

$('#calcResetBtn').addEventListener('click', () => {
  calc = { ...calc, name: '', upper: '', lower: '' };
  saveCalc();
  syncCalcInputs();
});

// ================= 세일즈가이드: 안쪽 탭 =================
const GUIDE_KEY = 'guide-tab';
function setGuideTab(tab) {
  if (!['calc', 'date', 'ment'].includes(tab)) tab = 'calc';
  $$('#guideTabs .tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.guide === tab));
  $$('[data-guide-pane]').forEach((p) => (p.hidden = p.dataset.guidePane !== tab));
  if (tab === 'date') renderDateCalc();
  try {
    localStorage.setItem(GUIDE_KEY, tab);
  } catch { /* 무시 */ }
}
$('#guideTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-guide]')?.dataset.guide;
  if (tab) setGuideTab(tab);
});

// ================= 치과 (영업채널: 마스터가 권한을 켠 사람, 담당 치과만) =================
const CLINIC_KEY = 'clinic-tab';
const canSales = () => isMaster() || salesAccess;
function setClinicTab(tab) {
  if (!['board', 'ar', 'invoice'].includes(tab)) tab = 'board';
  $$('#clinicTabs .tab').forEach((b) => b.setAttribute('aria-selected', b.dataset.clinic === tab));
  $$('[data-clinic-pane]').forEach((p) => (p.hidden = p.dataset.clinicPane !== tab));
  try {
    localStorage.setItem(CLINIC_KEY, tab);
  } catch { /* 무시 */ }
}

// 현황판·미납: 사내 서버를 새 탭으로 (로그인 토큰을 넘겨 바로 열림). 회사 밖에서는 주소가 열리지 않음
function renderOffice() {
  $$('.office-note').forEach((p) => (p.textContent = canSales()
    ? '회사 밖(LTE·외부 와이파이)에서는 열리지 않아요.'
    : '영업채널 권한이 필요해요. 마스터에게 요청하세요.'));
  $$('.office-btn').forEach((b) => (b.disabled = !canSales()));
}
$$('.office-btn').forEach((b) => b.addEventListener('click', () => {
  if (!canSales()) return;
  const t = authToken ? `?t=${encodeURIComponent(authToken)}` : '';
  window.open(`${OFFICE_URL}/${b.dataset.office}${t}`, '_blank', 'noopener');
}));

// 알림톡: 사내 미니PC가 30분마다 올린 최근 7일 발송 기록. 서버 규칙(RLS)이 내 담당 치과 것만 내려줌
let alimRows = [];
let alimLoading = false;
async function loadAlim() {
  renderAlim();
  if (!sb || !user || !canSales() || alimLoading) return;
  alimLoading = true;
  const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const { data, error } = await sb.from('alim_log')
    .select('seq, send_dt, clinic_id, clinic_name, patient, kind, success, fail_msg, synced_at')
    .gte('send_dt', since).order('send_dt', { ascending: false }).limit(2000);
  alimLoading = false;
  if (error) {
    console.error('[alim]', error);
    $('#alimSummary').textContent = '알림톡 내역을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.';
    return;
  }
  alimRows = data.map((r) => ({ ...r, id: String(r.seq), date: ymd(new Date(r.send_dt)) }));
  const clinics = [...new Map(alimRows.map((r) => [r.clinic_id, r.clinic_name || r.clinic_id])).entries()]
    .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'ko'));
  const sel = $('#alimClinic');
  const keep = sel.value;
  sel.replaceChildren(new Option('전체 치과', ''), ...clinics.map(([id, name]) => new Option(name, id)));
  sel.value = clinics.some(([id]) => id === keep) ? keep : '';
  renderAlim();
}

function renderAlim() {
  if (!canSales()) {
    $('#alimSummary').textContent = '영업채널 권한이 필요해요. 마스터에게 요청하세요.';
    $('#alimList').replaceChildren();
    return;
  }
  const days = Number(segValue($('#alimDays')) || 6);
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - days);
  const clinic = $('#alimClinic').value;
  const failOnly = $('#alimFailOnly').checked;
  const inRange = alimRows.filter((r) => new Date(r.send_dt) >= from && (!clinic || r.clinic_id === clinic));
  const shown = failOnly ? inRange.filter((r) => !r.success) : inRange;
  const fails = inRange.filter((r) => !r.success).length;
  const synced = alimRows.reduce((m, r) => (r.synced_at > m ? r.synced_at : m), '');
  const ago = synced ? Math.round((Date.now() - new Date(synced)) / 60000) : null;
  $('#alimSummary').textContent = `발송 ${inRange.length}건 · 성공 ${inRange.length - fails} · 실패 ${fails}`
    + (ago === null ? '' : ` · ${ago < 60 ? `${ago}분` : `${Math.floor(ago / 60)}시간`} 전 갱신`);
  renderDayList('#alimList', shown, (li, r) => {
    const head = journalHead(r.clinic_name || '(치과 없음)');
    head.append(tagEl(r.success ? '✅ 성공' : '❌ 실패', r.success ? 'alim-ok' : 'alim-fail'));
    li.append(head);
    const p = document.createElement('p');
    p.className = 'j-content';
    const d = new Date(r.send_dt);
    p.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      + ` · ${r.patient || '-'} · ${r.kind || '알림톡'}${r.success ? '' : `\n사유: ${r.fail_msg || '알 수 없음'}`}`;
    li.append(p);
  });
}
bindSeg($('#alimDays'), renderAlim, false);
$('#alimClinic').addEventListener('change', renderAlim);
$('#alimFailOnly').addEventListener('change', renderAlim);
renderOffice();
$('#clinicTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-clinic]')?.dataset.clinic;
  if (tab) setClinicTab(tab);
});
try {
  setClinicTab(localStorage.getItem(CLINIC_KEY));
} catch {
  setClinicTab('board');
}

// ================= 실험트랙 =================
// 트랙: 특정 치과들의 매출을 올리려는 지원 실험 (1인 1~2개가 보통, 더 만들 수 있음). 치과마다 진단 접수·제작 건수를 직접 셈
const trackSum = (clinics) => clinics.reduce((s, c) => ({ dx: s.dx + (c.dx || 0), mnft: s.mnft + (c.mnft || 0) }), { dx: 0, mnft: 0 });
const tcName = (c) => (c.region ? `${c.region}_${c.clinic}` : c.clinic);
// 치과별 특이사항 기록 [{date, text, at}] — 최근 것이 위
const tcNotes = (c) => [...(c.notes || [])].sort((a, b) => b.date.localeCompare(a.date) || (b.at || 0) - (a.at || 0));
const tcLastNote = (c) => tcNotes(c)[0] || null;
// 기간: 치과 종료일이 비어 있으면 트랙 종료일을 따름. 치과는 앞당겨 끝낼 수만 있음(조기 종료, 연장 불가)
const mdSlash = (d) => d.slice(5).replace('-', '/');
const tcEnd = (t, c) => c.end || t.end || '';
const trackOn = (t) => t.status !== '종료' && !(t.end && t.end < ymd(new Date()));
const tcOn = (t, c) => trackOn(t) && c.status !== '종료' && !(tcEnd(t, c) && tcEnd(t, c) < ymd(new Date()));
const tcStatus = (t, c) => (tcOn(t, c) ? '진행중' : c.end && c.end < (t.end || '9999') ? '조기 종료' : '종료');
const tcPeriod = (t, c) => [c.start, tcEnd(t, c)].filter(Boolean).map(mdSlash).join('~');
const trackPeriod = (t) => (t.start && t.end ? `${mdSlash(t.start)}~${mdSlash(t.end)}` : '기간 미정');

function counterEl(label, key, value) {
  const box = document.createElement('span');
  box.className = 'tc-count';
  const name = document.createElement('span');
  name.textContent = label;
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.dataset.step = `${key}:-1`;
  minus.textContent = '−';
  minus.setAttribute('aria-label', `${label} 빼기`);
  const num = document.createElement('b');
  num.textContent = value || 0;
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.dataset.step = `${key}:1`;
  plus.textContent = '＋';
  plus.setAttribute('aria-label', `${label} 더하기`);
  box.append(name, minus, num, plus);
  return box;
}

function renderTracks() {
  const items = tracks.map((t) => {
    const li = document.createElement('li');
    const on = trackOn(t);
    li.className = `journal-item track-card${on ? '' : ' track-done'}`;
    li.dataset.id = t.id;
    const head = journalHead(`🧪 ${t.title || '(이름 없음)'}`);
    head.append(tagEl(on ? '진행중' : '종료', on ? 'track-on' : ''));
    head.append(tagEl(`📅 ${trackPeriod(t)}`, t.start && t.end ? '' : 'due-soon'));
    li.append(head);
    if (t.purpose) li.append(collabLine('목적', t.purpose));
    if (t.plan) li.append(collabLine('진행', t.plan));
    const sum = trackSum(t.clinics);
    const total = document.createElement('p');
    total.className = 'track-total';
    total.textContent = `치과 ${t.clinics.length}곳 · 진단 ${sum.dx}건 · 제작 ${sum.mnft}건`;
    li.append(total);
    const list = document.createElement('ul');
    list.className = 'tc-list';
    t.clinics.forEach((c, i) => {
      const row = document.createElement('li');
      row.className = `tc-row${tcOn(t, c) ? '' : ' tc-done'}`;
      row.dataset.idx = i;
      const main = document.createElement('div');
      main.className = 'tc-main';
      const name = document.createElement('b');
      name.textContent = tcName(c);
      const meta = document.createElement('span');
      meta.textContent = [c.kind, `${tcStatus(t, c)}(${tcPeriod(t, c)})`].filter(Boolean).join(' · ');
      main.append(name, meta);
      const last = tcLastNote(c);
      if (last) {
        const note = document.createElement('span');
        note.className = 'tc-last';
        note.textContent = `📝 ${mdSlash(last.date)} ${last.text}`;
        main.append(note);
      }
      const counts = document.createElement('div');
      counts.className = 'tc-counts';
      counts.append(counterEl('진단', 'dx', c.dx), counterEl('제작', 'mnft', c.mnft));
      row.append(main, counts);
      list.append(row);
    });
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'tc-add';
    add.textContent = '＋ 치과 추가';
    li.append(list, add);
    return li;
  });
  $('#trackList').replaceChildren(...items);
}

const trackDialog = $('#trackDialog');
let editTrackId = null;
bindSeg($('#tStatus'), null, false);

function openTrack(id = null) {
  const t = tracks.find((x) => x.id === id);
  editTrackId = t ? t.id : null;
  $('#trackDialogTitle').textContent = t ? '실험트랙 수정' : '실험트랙 만들기';
  $('#tTitle').value = t?.title || '';
  $('#tPurpose').value = t?.purpose || '';
  $('#tPlan').value = t?.plan || '';
  $('#tStart').value = t?.start || ymd(new Date());
  $('#tEnd').value = t?.end || '';
  setSeg($('#tStatus'), t?.status || '진행중');
  $('#tDeleteBtn').hidden = !t;
  trackDialog.showModal();
}

$('#newTrackBtn').addEventListener('click', () => {
  openTrack();
});

$('#trackForm').addEventListener('submit', (e) => {
  const data = {
    title: $('#tTitle').value.trim(),
    purpose: $('#tPurpose').value.trim(),
    plan: $('#tPlan').value.trim(),
    status: segValue($('#tStatus')) || '진행중',
    start: $('#tStart').value,
    end: $('#tEnd').value,
  };
  const stop = (msg) => {
    e.preventDefault();
    showToast(msg);
  };
  if (!data.title) return stop('트랙 이름을 적어 주세요.');
  if (!data.start || !data.end) return stop('트랙 시작일과 종료일을 정해 주세요.');
  if (data.end < data.start) return stop('종료일이 시작일보다 빨라요.');
  const existing = tracks.find((x) => x.id === editTrackId);
  // 트랙 기간이 줄면 치과 기간도 그 안으로 (종료일이 트랙보다 늦은 치과는 트랙 종료일을 따름)
  if (existing) {
    data.clinics = existing.clinics.map((c) => ({
      ...c,
      start: c.start && c.start < data.start ? data.start : c.start,
      end: c.end && c.end >= data.end ? '' : c.end,
    }));
  }
  if (existing) Object.assign(existing, data);
  else tracks.push({ id: newId(), createdAt: Date.now(), clinics: [], ...data });
  sortTracks(tracks);
  save();
  renderTracks();
  vibrate(30);
  showToast(existing ? '실험트랙을 수정했어요.' : '실험트랙을 만들었어요. ＋ 치과 추가로 치과를 넣어 보세요.');
});

$('#tDeleteBtn').addEventListener('click', () => {
  const index = tracks.findIndex((x) => x.id === editTrackId);
  if (index < 0) return;
  const [removed] = tracks.splice(index, 1);
  trackDialog.close();
  save();
  renderTracks();
  showToast('실험트랙을 삭제했어요.', () => {
    tracks.push(removed);
    sortTracks(tracks);
    save();
    renderTracks();
  });
});

const tcDialog = $('#trackClinicDialog');
let tcEdit = null; // { id: 트랙 id, idx: 치과 순번 또는 null(추가) }
bindSeg($('#tcKind'));
bindSeg($('#tcStatus'), null, false);

function openTrackClinic(id, idx = null) {
  const t = tracks.find((x) => x.id === id);
  if (!t) return;
  const c = idx === null ? null : t.clinics[idx];
  if (!t.start || !t.end) {
    showToast('먼저 트랙 기간(시작일·종료일)을 정해 주세요.');
    openTrack(id);
    return;
  }
  tcEdit = { id, idx: c ? idx : null };
  $('#tcDialogTitle').textContent = c ? '치과 수정' : `치과 추가 · ${t.title}`;
  $('#tcPeriodHint').textContent = `트랙 기간 ${trackPeriod(t)} 안에서만 정할 수 있어요. 종료일은 앞당길 수만 있어요(조기 종료).`;
  for (const el of [$('#tcStart'), $('#tcEnd')]) {
    el.min = t.start;
    el.max = t.end;
  }
  $('#tcRegion').value = c?.region || '';
  $('#tcClinic').value = c?.clinic || '';
  setSeg($('#tcKind'), c?.kind || '');
  setSeg($('#tcStatus'), c?.status || '진행중');
  const today = ymd(new Date());
  $('#tcStart').value = c?.start || (today < t.start ? t.start : today > t.end ? t.end : today);
  $('#tcEnd').value = c ? tcEnd(t, c) : t.end;
  $('#tcDx').value = c?.dx || 0;
  $('#tcMnft').value = c?.mnft || 0;
  $('#tcDeleteBtn').hidden = !c;
  tcDialog.showModal();
}

const countValue = (sel) => Math.max(0, Math.floor(Number($(sel).value) || 0));

$('#trackClinicForm').addEventListener('submit', (e) => {
  const t = tracks.find((x) => x.id === tcEdit?.id);
  const data = {
    region: $('#tcRegion').value.trim(),
    clinic: $('#tcClinic').value.trim(),
    kind: segValue($('#tcKind')) || '',
    status: segValue($('#tcStatus')) || '진행중',
    start: $('#tcStart').value || '',
    end: $('#tcEnd').value || '',
    dx: countValue('#tcDx'),
    mnft: countValue('#tcMnft'),
  };
  const stop = (msg) => {
    e.preventDefault();
    showToast(msg);
  };
  if (!t || !data.clinic) return stop('치과명을 적어 주세요.');
  if (!data.start) return stop('치과 시작일을 정해 주세요.');
  if (data.start < t.start) return stop(`시작일은 트랙 시작일(${mdSlash(t.start)}) 이후여야 해요.`);
  if (data.end > t.end) return stop(`연장은 안 돼요. 종료일은 트랙 종료일(${mdSlash(t.end)})까지예요.`);
  if (data.end && data.end < data.start) return stop('종료일이 시작일보다 빨라요.');
  // 조기 종료를 골랐는데 종료일이 트랙 종료일 그대로면 오늘로 앞당김
  if (data.status === '종료' && (!data.end || data.end === t.end)) {
    const today = ymd(new Date());
    data.end = today < data.start ? data.start : today > t.end ? t.end : today;
  }
  if (data.end === t.end) data.end = ''; // 트랙 종료일을 따름 (트랙 기간이 바뀌어도 같이 바뀜)
  t.clinics = tcEdit.idx === null ? [...t.clinics, data] : t.clinics.map((c, i) => (i === tcEdit.idx ? { ...c, ...data } : c));
  save();
  renderTracks();
  renderAutocomplete();
  vibrate(30);
  showToast(tcEdit.idx === null ? '치과를 추가했어요.' : '치과를 수정했어요.');
});

$('#tcDeleteBtn').addEventListener('click', () => {
  const t = tracks.find((x) => x.id === tcEdit?.id);
  if (!t || tcEdit.idx === null) return;
  const before = t.clinics;
  t.clinics = before.filter((_, i) => i !== tcEdit.idx);
  tcDialog.close();
  save();
  renderTracks();
  showToast('치과를 뺐어요.', () => {
    t.clinics = before;
    save();
    renderTracks();
  });
});

// ---------- 치과 특이사항 (누르면 기록, 위 '수정' 버튼으로 치과 수정) ----------
const tcNoteDialog = $('#tcNoteDialog');
let tcNoteAt = null; // { id: 트랙 id, idx: 치과 순번 }

function renderTcNote() {
  const t = tracks.find((x) => x.id === tcNoteAt?.id);
  const c = t?.clinics[tcNoteAt.idx];
  if (!c) return tcNoteDialog.close();
  $('#tcNoteTitle').textContent = tcName(c);
  $('#tcNoteInfo').textContent = [t.title, c.kind, `${tcStatus(t, c)}(${tcPeriod(t, c)})`, `진단 ${c.dx || 0} · 제작 ${c.mnft || 0}`]
    .filter(Boolean).join(' · ');
  const notes = tcNotes(c);
  $('#tcNoteList').replaceChildren(...(notes.length ? notes.map((n) => {
    const li = document.createElement('li');
    const date = document.createElement('span');
    date.className = 'n-date';
    date.textContent = mdSlash(n.date);
    const text = document.createElement('span');
    text.className = 'n-text';
    text.textContent = n.text;
    const del = document.createElement('button');
    del.type = 'button';
    del.dataset.at = n.at;
    del.textContent = '×';
    del.setAttribute('aria-label', '특이사항 지우기');
    li.append(date, text, del);
    return li;
  }) : [Object.assign(document.createElement('li'), { className: 'n-empty', textContent: '아직 적은 특이사항이 없어요.' })]));
}

function openTcNote(id, idx) {
  tcNoteAt = { id, idx };
  $('#tcNoteText').value = '';
  $('#tcNoteDate').value = ymd(new Date());
  renderTcNote();
  tcNoteDialog.showModal();
}

// 특이사항 바꾸기: fn(notes) → 새 notes
function updateTcNotes(fn) {
  const t = tracks.find((x) => x.id === tcNoteAt?.id);
  if (!t) return null;
  t.clinics = t.clinics.map((c, i) => (i === tcNoteAt.idx ? { ...c, notes: fn(c.notes || []) } : c));
  save();
  renderTracks();
  renderTcNote();
  return t;
}

$('#tcNoteForm').addEventListener('submit', (e) => {
  e.preventDefault(); // 기록 후에도 시트는 열어 둠
  const text = $('#tcNoteText').value.trim();
  if (!text) return showToast('특이사항을 적어 주세요.');
  updateTcNotes((notes) => [...notes, { date: $('#tcNoteDate').value || ymd(new Date()), text, at: Date.now() }]);
  $('#tcNoteText').value = '';
  vibrate(30);
  showToast('특이사항을 기록했어요.');
});

$('#tcNoteList').addEventListener('click', (e) => {
  const at = e.target.closest('button[data-at]')?.dataset.at;
  if (!at) return;
  const at0 = { ...tcNoteAt };
  let removed = null;
  updateTcNotes((notes) => notes.filter((n) => {
    if (String(n.at) !== at) return true;
    removed = n;
    return false;
  }));
  showToast('특이사항을 지웠어요.', () => {
    tcNoteAt = at0;
    updateTcNotes((notes) => [...notes, removed]);
  });
});

$('#tcNoteEditBtn').addEventListener('click', () => {
  const { id, idx } = tcNoteAt;
  tcNoteDialog.close();
  openTrackClinic(id, idx);
});

// 카드: −/＋ 는 바로 세기, 치과 줄은 특이사항(위 버튼으로 수정), '＋ 치과 추가', 나머지는 트랙 수정
$('#trackList').addEventListener('click', (e) => {
  const card = e.target.closest('.track-card');
  const t = card && tracks.find((x) => x.id === card.dataset.id);
  if (!t) return;
  const row = e.target.closest('.tc-row');
  const step = e.target.closest('[data-step]')?.dataset.step;
  if (step && row) {
    const [key, d] = step.split(':');
    const i = Number(row.dataset.idx);
    t.clinics = t.clinics.map((c, n) => (n === i ? { ...c, [key]: Math.max(0, (c[key] || 0) + Number(d)) } : c));
    save();
    renderTracks();
    vibrate(15);
  } else if (row) openTcNote(t.id, Number(row.dataset.idx));
  else if (e.target.closest('.tc-add')) openTrackClinic(t.id);
  else openTrack(t.id);
});

// ================= 월별 매출 목표 달성현황 (마스터) =================
// 사내 미니PC가 30분마다 월 합계(sales_monthly)를 올림. 청구월 = 전월 26일 ~ 당월 25일
function billingMonth(d = new Date()) {
  let y = d.getFullYear();
  let m = d.getMonth() + 1;
  if (d.getDate() >= 26) [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return { y, m };
}

// months[i] = i+1월 { target: 백만원, amt: 원(없으면 null), closed, rate: % }
async function fetchSales() {
  const { y, m } = billingMonth();
  const [salesRes, targetRes] = await Promise.all([
    sb.from('sales_monthly').select('yyyymm, amt, closed, synced_at').like('yyyymm', `${y}%`).order('yyyymm'),
    sb.from('sales_targets').select('targets').eq('year', y).maybeSingle(),
  ]);
  if (salesRes.error) throw salesRes.error;
  if (targetRes.error) throw targetRes.error;
  const targets = (targetRes.data?.targets || []).map(Number);
  const byMonth = new Map(salesRes.data.map((r) => [Number(r.yyyymm.slice(4)), r]));
  const months = Array.from({ length: 12 }, (_, i) => {
    const r = byMonth.get(i + 1);
    const target = targets[i] ?? null;
    const amt = r ? Number(r.amt) : null;
    return { m: i + 1, target, amt, closed: !!r?.closed, rate: amt !== null && target ? Math.round(amt / 1e4 / target) : null };
  });
  const closed = months.filter((x) => x.closed && x.target);
  const sum = (key) => closed.reduce((s, x) => s + x[key], 0);
  return {
    y, cur: m, months, targets, hasTargets: targets.length === 12,
    closedCount: closed.length,
    lastClosed: closed.at(-1)?.m,
    cum: closed.length ? Math.round(sum('amt') / 1e4 / sum('target')) : null,
    avg: closed.length ? Math.round(sum('rate') / closed.length) : null,
    synced: salesRes.data.reduce((a, r) => (r.synced_at > a ? r.synced_at : a), ''),
  };
}

// 진행 중인 달의 경과일 (청구기간 첫날부터 오늘까지 / 전체 일수)
function billingProgress(y, m) {
  const start = new Date(y, m - 2, 26);
  const end = new Date(y, m - 1, 25);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const total = Math.round((end - start) / DAY_MS) + 1;
  return { elapsed: Math.min(total, Math.max(0, Math.round((today - start) / DAY_MS) + 1)), total };
}

const mil = (amt) => (amt / 1e6).toFixed(1);
let salesData = null;

async function loadSales() {
  if (!sb || !user || !isMaster()) return;
  try {
    salesData = await fetchSales();
    renderSales();
  } catch (err) {
    console.error('[sales]', err);
    $('#salesSummary').textContent = `매출 자료를 불러오지 못했어요: ${err.message}`;
  }
}

function salesChartSvg(d) {
  const W = 360, H = 200, top = 22, bottom = 22, left = 6, slot = (W - left * 2) / 12;
  const max = Math.max(1, ...d.months.map((x) => Math.max(x.target || 0, x.amt === null ? 0 : x.amt / 1e6))) * 1.1;
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const parts = [];
  d.months.forEach((x, i) => {
    const cx = left + slot * i + slot / 2;
    if (x.target) parts.push(`<rect class="bar-target" x="${cx - 11}" y="${y(x.target)}" width="10" height="${y(0) - y(x.target)}" rx="2"/>`);
    if (x.amt !== null) {
      const v = x.amt / 1e6;
      parts.push(`<rect class="${x.closed ? 'bar-actual' : 'bar-open'}" x="${cx + 1}" y="${y(v)}" width="10" height="${y(0) - y(v)}" rx="2"/>`);
      if (x.rate !== null) {
        const yTop = Math.min(y(v), x.target ? y(x.target) : y(v)) - 5;
        parts.push(`<text class="bar-rate${x.rate >= 100 ? ' ok' : ''}" x="${cx}" y="${yTop}">${x.rate}%</text>`);
      }
    }
    parts.push(`<text class="bar-month${x.m === d.cur ? ' cur' : ''}" x="${cx}" y="${H - 6}">${x.m}월</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${d.y}년 월별 목표 대비 실적">`
    + `<line class="bar-base" x1="${left}" x2="${W - left}" y1="${y(0)}" y2="${y(0)}"/>${parts.join('')}</svg>`;
}

function renderSales() {
  const d = salesData;
  if (!d) return;
  $('#salesChartTitle').textContent = `${d.y}년 월별 목표 대비 실적 (백만원)`;
  $('#salesChart').innerHTML = salesChartSvg(d);
  const cur = d.months[d.cur - 1];
  const p = billingProgress(d.y, d.cur);
  const box = (label, value, sub = '') => `<div><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
  $('#salesCur').innerHTML = `<p class="sales-cur-title">${d.cur}월 현재 (진행 중 · ${p.elapsed}/${p.total}일)</p><div class="sales-boxes">`
    + box('당월 목표', cur.target ? `${cur.target}백만` : '-')
    + box('누적 실적', cur.amt === null ? '-' : `${mil(cur.amt)}백만`)
    + box('달성률', cur.rate === null ? '-' : `${cur.rate}%`, `기간 경과 ${Math.round((p.elapsed / p.total) * 100)}%`)
    + '</div>';
  $('#salesSummary').textContent = !d.hasTargets ? `${d.y}년 목표가 없어요. 아래 '목표 수정'에서 넣어 주세요.`
    : d.closedCount ? `1~${d.lastClosed}월 누적 달성률 ${d.cum}% · 월평균 ${d.avg}%` : '마감된 달이 아직 없어요.';
  const rows = d.months.filter((x) => x.amt !== null).map((x) => `<tr${x.closed ? '' : ' class="open"'}>`
    + `<td>${x.m}월${x.closed ? '' : ' (진행 중)'}</td><td>${x.target ?? '-'}</td><td>${mil(x.amt)}</td>`
    + `<td class="${x.rate >= 100 ? 'ok' : ''}">${x.rate === null ? '-' : `${x.rate}%`}</td></tr>`);
  $('#salesTable').innerHTML = `<thead><tr><th>월</th><th>목표(백만)</th><th>실적(백만)</th><th>달성률</th></tr></thead><tbody>${rows.join('')}</tbody>`;
  const ago = d.synced ? Math.round((Date.now() - new Date(d.synced)) / 60000) : null;
  $('#salesSynced').textContent = ago === null ? '사내 미니PC에서 아직 자료가 올라오지 않았어요.'
    : `마감된 달은 마감 금액, ${d.cur}월은 오늘까지 청구 금액 · ${ago < 60 ? `${ago}분` : `${Math.floor(ago / 60)}시간`} 전 갱신`;
}

const targetDialog = $('#targetDialog');
$('#targetBtn').addEventListener('click', () => {
  if (!salesData) return;
  $('#targetDialogTitle').textContent = `${salesData.y}년 매출 목표 수정`;
  $('#targetGrid').replaceChildren(...Array.from({ length: 12 }, (_, i) => {
    const label = document.createElement('label');
    label.textContent = `${i + 1}월`;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.1';
    input.inputMode = 'decimal';
    input.value = salesData.targets[i] ?? '';
    label.append(input);
    return label;
  }));
  targetDialog.showModal();
});

$('#targetForm').addEventListener('submit', async (e) => {
  const values = [...$$('#targetGrid input')].map((i) => Number(i.value));
  if (values.some((v) => !(v > 0))) {
    e.preventDefault();
    showToast('12달 목표를 모두 넣어 주세요 (백만원 단위).');
    return;
  }
  const { error } = await sb.from('sales_targets')
    .upsert({ year: salesData.y, targets: values, updated_at: new Date().toISOString() });
  if (error) {
    showToast(`목표를 저장하지 못했어요: ${error.message}`);
    return;
  }
  showToast('목표를 저장했어요.');
  loadSales();
});

// ================= 날짜계산기 (영업일 기준) =================
// 공휴일(대체공휴일 포함, 토요일과 겹친 공휴일도 적음 → 택배 도착일 계산용).
// 해마다 다음 해 날짜를 추가해 주세요.
const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-03-02', '2026-05-01', '2026-05-05',
  '2026-05-25', '2026-06-03', '2026-06-06', '2026-07-17', '2026-08-15', '2026-08-17', '2026-09-24',
  '2026-09-25', '2026-09-26', '2026-09-28', '2026-10-03', '2026-10-05', '2026-10-09', '2026-12-25',
  // 2027
  '2027-01-01', '2027-02-06', '2027-02-08', '2027-02-09', '2027-03-01', '2027-05-01', '2027-05-03',
  '2027-05-05', '2027-05-13', '2027-07-17', '2027-07-19', '2027-08-16', '2027-09-14', '2027-09-15',
  '2027-09-16', '2027-10-04', '2027-10-09', '2027-10-11', '2027-12-25', '2027-12-27',
]);
const DIAG_DAYS = 4; // 진단: 접수 +4영업일 업로드
const MAKE_DAYS = 4; // 제작: 접수 +4영업일 출고, 택배 +1~2일 도착(토요일 배송 포함)

const isBizDay = (d) => d.getDay() !== 0 && d.getDay() !== 6 && !HOLIDAYS.has(ymd(d));
// 택배 배송일: 토요일도 배송, 일요일·공휴일 제외
const isDeliveryDay = (d) => d.getDay() !== 0 && !HOLIDAYS.has(ymd(d));
function addBizDays(date, n, ok = isBizDay) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  while (n > 0) {
    d.setDate(d.getDate() + 1);
    if (ok(d)) n--;
  }
  return d;
}
const mdw = (d) => `${d.getMonth() + 1}월 ${d.getDate()}일(${WEEKDAYS[d.getDay()]})`;

let dateKind = 'diag';
let dateCount = ''; // same: 접수일부터 셈 / next: 다음 날부터 셈 / '': 지금 시각으로 자동
const DATE_CUTOFF_HOUR = 11; // 이 시각 전이면 당일 카운팅이 기본
let dateText = '';

function renderDateCalc() {
  const input = $('#dateBase');
  const today = ymd(new Date());
  if (!input.value) input.value = today;
  $('#dateTodayBtn').hidden = input.value === today;
  setSeg($('#dateKindSeg'), dateKind);
  const count = dateCount || (new Date().getHours() < DATE_CUTOFF_HOUR ? 'same' : 'next');
  setSeg($('#dateCountSeg'), count);

  const base = parseYmd(input.value);
  // 당일 카운팅: 접수일이 영업일이면 그날을 1일째로 셈 → 전날에서 출발
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - (count === 'same' ? 1 : 0));
  const baseWord = input.value === today ? '오늘 날짜로' : `${mdw(base)}에`;
  const rows = [['접수일', mdw(base)]];
  if (dateKind === 'diag') {
    const up = addBizDays(start, DIAG_DAYS);
    rows.push(['업로드 예상', mdw(up)]);
    dateText = `${baseWord} 접수하여 ${mdw(up)} 업로드 예상됩니다. 진단이 완료되면 알림톡으로 안내 도와드리겠습니다.`;
  } else {
    const ship = addBizDays(start, MAKE_DAYS);
    const a1 = addBizDays(ship, 1, isDeliveryDay);
    const a2 = addBizDays(ship, 2, isDeliveryDay);
    rows.push(['출고 예상', mdw(ship)], ['치과 도착', `${mdw(a1)} ~ ${mdw(a2)}`]);
    dateText = `${baseWord} 접수하여 ${mdw(ship)} 출고 예상되며, ${mdw(a1)}~${mdw(a2)} 치과 도착 예상됩니다.`;
  }
  const card = el('div', 'date-card');
  rows.forEach(([k, v], i) => {
    const row = el('div', i ? 'date-row hl' : 'date-row');
    row.append(el('span', 'date-k', k), el('span', 'date-v', v));
    card.append(row);
  });
  const out = $('#dateOut');
  out.replaceChildren(card, el('p', 'date-msg', dateText));
  if (!isBizDay(base)) out.append(el('p', 'quote-basis', '※ 접수일이 휴일이라 다음 영업일부터 세었어요.'));
  else out.append(el('p', 'quote-basis', count === 'same' ? '※ 접수일(당일)을 1일째로 세었어요.' : '※ 접수 다음 영업일을 1일째로 세었어요.'));
}

bindSeg($('#dateKindSeg'), (v) => {
  dateKind = v;
  renderDateCalc();
}, false);
bindSeg($('#dateCountSeg'), (v) => {
  dateCount = v;
  renderDateCalc();
}, false);
$('#dateBase').addEventListener('change', renderDateCalc);
$('#dateTodayBtn').addEventListener('click', () => {
  $('#dateBase').value = ymd(new Date());
  renderDateCalc();
});
$('#dateCopyBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(dateText);
    showToast('안내 문구를 복사했어요. 카톡에 붙여넣으면 돼요.');
  } catch {
    showToast('복사하지 못했어요.');
  }
});
// 메뉴를 다시 열면 날짜를 오늘로
$$('#drawer [data-view="calc"]').forEach((b) => b.addEventListener('click', () => {
  $('#dateBase').value = '';
  dateCount = '';
  if (!$('[data-guide-pane="date"]').hidden) renderDateCalc();
}));
try {
  setGuideTab(localStorage.getItem(GUIDE_KEY));
} catch {
  setGuideTab('calc');
}

// ================= 공지 / 프로모션 =================
const NOTE_LABELS = { notice: '공지', promo: '프로모션' };

const PROMO_PKGS = [['lite', 'Lite'], ['moderate', 'Moderate'], ['advanced', 'Advanced'], ['comprehensive', 'Comprehensive']];

// 종료일이 지나면 할인 꺼짐
const promoExpired = () => !!promo.until && promo.until < ymd(new Date());
const hasDiscounts = () => Object.values(promo.discounts || {}).some((v) => v > 0);
function activeDiscounts() {
  return promoExpired() ? {} : (promo.discounts || {});
}

const manwon = (n) => `${Number((n / 10000).toFixed(1))}만원`;

function renderNotes() {
  $$('.board-note').forEach((el) => {
    const kind = el.dataset.kind;
    const body = notes[kind] || '';
    const isPromo = kind === 'promo';
    const expired = isPromo && promoExpired();
    const hasContent = !!body || (isPromo && hasDiscounts());
    const masterEmpty = (!hasContent || expired) && isMaster();
    el.hidden = (!hasContent || expired) && !isMaster();
    el.classList.toggle('empty-master', masterEmpty);
    let text = body;
    if (!hasContent) text = `${NOTE_LABELS[kind]} 작성하기 (마스터)`;
    else if (expired) text = `(종료된 프로모션) ${body}`;
    el.querySelector('.note-body').textContent = text;
    const badge = el.querySelector('.note-new');
    if (badge) badge.hidden = !hasContent;
    const chips = el.querySelector('.promo-chips');
    if (chips) {
      const items = expired ? [] : PROMO_PKGS
        .filter(([key]) => promo.discounts?.[key] > 0)
        .map(([key, name]) => {
          const s = document.createElement('span');
          s.textContent = `${name} -${manwon(promo.discounts[key])}`;
          return s;
        });
      if (items.length && promo.until) {
        const s = document.createElement('span');
        const d = parseYmd(promo.until);
        s.textContent = `~${d.getMonth() + 1}/${d.getDate()}`;
        items.push(s);
      }
      chips.replaceChildren(...items);
      chips.hidden = !items.length;
    }
  });
}

const noteDialog = $('#noteDialog');
let noteKind = 'notice';

function openNoteEditor(kind) {
  noteKind = kind;
  $('#noteDialogTitle').textContent = `${NOTE_LABELS[kind]} 작성`;
  $('#noteText').value = notes[kind] || '';
  const isPromo = kind === 'promo';
  $('#promoFields').hidden = !isPromo;
  if (isPromo) {
    $$('#promoFields [data-pkg]').forEach((input) => {
      const v = promo.discounts?.[input.dataset.pkg];
      input.value = v > 0 ? String(Number((v / 10000).toFixed(1))) : '';
    });
    $('#promoUntil').value = promo.until || '';
  }
  noteDialog.showModal();
}

$$('.board-note').forEach((el) => el.addEventListener('click', () => {
  if (isMaster()) openNoteEditor(el.dataset.kind);
  else el.classList.toggle('expanded');
}));

$$('#promoFields [data-pkg]').forEach((input) => input.addEventListener('input', () => {
  input.value = input.value.replace(/[^0-9.]/g, '');
}));

$('#noteForm').addEventListener('submit', async () => {
  const kind = noteKind;
  const body = $('#noteText').value.trim();
  const row = { kind, body };
  const prevBody = notes[kind];
  const prevPromo = promo;
  if (kind === 'promo') {
    const discounts = {};
    $$('#promoFields [data-pkg]').forEach((input) => {
      const amount = Math.round((parseFloat(input.value) || 0) * 10000);
      if (amount > 0) discounts[input.dataset.pkg] = amount;
    });
    promo = { discounts, until: $('#promoUntil').value || '' };
    row.data = promo;
  }
  notes[kind] = body;
  renderNotes();
  renderQuote();
  const { error } = await sb.from('board').upsert(row);
  if (error) {
    notes[kind] = prevBody;
    promo = prevPromo;
    renderNotes();
    renderQuote();
    showToast(`${NOTE_LABELS[kind]}을(를) 저장하지 못했어요: ${error.message}`);
    return;
  }
  saveCache();
  const has = body || (kind === 'promo' && hasDiscounts());
  showToast(has ? `${NOTE_LABELS[kind]}을(를) 올렸어요.` : `${NOTE_LABELS[kind]}을(를) 내렸어요.`);
});

// ================= 설정 =================
const settings = $('#settings');
$('#settingsBtn').addEventListener('click', () => {
  $('#accountEmail').textContent = user ? `로그인: ${user.email}${isMaster() ? ' (마스터)' : ''}` : '';
  $('#nameLabel').textContent = profileName ? `(${profileName})` : '';
  $('#masterTools').hidden = !isMaster();
  if (isMaster()) renderBackupHint();
  settings.showModal();
});

$('#logoutBtn').addEventListener('click', async () => {
  if (hasPending() && !(await queuePush())
    && !confirm('아직 서버에 저장되지 않은 변경이 있어요. 그래도 로그아웃할까요?')) return;
  settings.close();
  await sb.auth.signOut();
});

// 이름 (주간 보고서에 표시)
// ---------- 가입 승인 확인 ----------
const pendingScreen = $('#pendingScreen');
let checkingAccess = false;

async function checkAccess() {
  if (!user || !sb || checkingAccess) return;
  checkingAccess = true;
  const uid = user.id;
  try {
    let { data, error } = await sb.from('profiles').select('name, status, sales_access').eq('id', uid).maybeSingle();
    if (error) throw error;
    if (user?.id !== uid) return;
    if (!data) {
      // 처음 로그인: 승인 요청용 프로필 만들기 (status 는 서버가 pending 으로 정함)
      const res = await sb.from('profiles').upsert({ id: uid, email: user.email })
        .select('name, status, sales_access').single();
      if (res.error) throw res.error;
      data = res.data;
    }
    profileName = data.name || '';
    salesAccess = !!data.sales_access;
    renderOffice();
    const ok = isMaster() || data.status === 'approved';
    showPending(ok ? null : data.status);
    if (!data.name) {
      await askName(true);
      if (!ok) showPending(data.status);
    }
    if (ok && !accessOk) {
      accessOk = true;
      saveCache();
      pull();
    } else if (!ok && accessOk) {
      // 승인이 취소된 경우
      accessOk = false;
      tasks = [];
      archive = [];
      journals = [];
      collabs = [];
      tracks = [];
      renderAll();
    }
    saveCache();
    if (isMaster()) {
      refreshApprovals();
      remindBackup();
    }
  } catch (err) {
    console.error('[access]', err);
    // 오프라인: 예전에 승인된 기기면 캐시로 계속 사용
    if (!accessOk) showPending('offline');
    setSync('offline');
  } finally {
    checkingAccess = false;
  }
}

function showPending(status) {
  pendingScreen.hidden = !status;
  if (!status) return;
  const text = {
    pending: ['승인을 기다리고 있어요', '마스터가 가입을 승인하면 바로 사용할 수 있어요.'],
    rejected: ['가입이 승인되지 않았어요', '마스터에게 문의해 주세요.'],
    offline: ['서버에 연결할 수 없어요', '인터넷 연결을 확인한 뒤 다시 확인을 눌러 주세요.'],
  }[status] || ['승인을 기다리고 있어요', ''];
  $('#pendingTitle').textContent = text[0];
  $('#pendingDesc').textContent = text[1];
  $('#pendingWho').textContent = user ? `${profileName ? `${profileName} · ` : ''}${user.email}` : '';
}

$('#pendingRefreshBtn').addEventListener('click', () => checkAccess());
$('#pendingNameBtn').addEventListener('click', async () => {
  await askName();
  if (!pendingScreen.hidden) $('#pendingWho').textContent = `${profileName ? `${profileName} · ` : ''}${user.email}`;
});
$('#pendingLogoutBtn').addEventListener('click', () => sb.auth.signOut());

async function askName(first = false) {
  const name = prompt(first
    ? '처음 오셨네요! 이름을 입력해 주세요.\n(마스터 승인과 주간 보고서에 표시돼요)'
    : '이름을 입력해 주세요.', profileName)?.trim();
  if (!name) return;
  const { error } = await sb.from('profiles').upsert({ id: user.id, email: user.email, name });
  if (error) {
    showToast(`이름을 저장하지 못했어요: ${error.message}`);
    return;
  }
  profileName = name;
  saveCache();
  showToast(`${name}님으로 저장했어요.`);
}

// ---------- 가입 승인 (마스터) ----------
const approvalDialog = $('#approvalDialog');
let approvals = [];

async function refreshApprovals() {
  if (!isMaster()) return;
  const { data, error } = await sb.from('profiles').select('id, name, email, status, created_at, sales_access, emp_ids')
    .in('status', ['pending', 'rejected', 'approved']).order('created_at');
  if (error) {
    console.error('[approval]', error);
    return;
  }
  approvals = data.filter((p) => !MASTER_EMAILS.includes((p.email || '').toLowerCase()));
  const waiting = approvals.filter((p) => p.status === 'pending').length;
  $('#settingsBtn').classList.toggle('has-badge', waiting > 0);
  $('#approvalCount').hidden = !waiting;
  $('#approvalCount').textContent = waiting;
  if (approvalDialog.open) renderApprovals();
}

function renderApprovals() {
  const items = [];
  for (const [status, label] of [['pending', '승인 대기'], ['rejected', '거절됨'], ['approved', '승인됨 · 영업채널']]) {
    const list = approvals.filter((p) => p.status === status);
    if (!list.length) continue;
    const h = document.createElement('li');
    h.className = 'approval-section';
    h.textContent = `${label} (${list.length})`;
    items.push(h);
    for (const p of list) {
      const li = document.createElement('li');
      const who = document.createElement('div');
      who.className = 'ap-who';
      const name = document.createElement('span');
      name.className = 'ap-name';
      name.textContent = p.name || '(이름 미입력)';
      const meta = document.createElement('span');
      meta.className = 'ap-meta';
      const d = new Date(p.created_at);
      meta.textContent = status === 'approved'
        ? `${p.email || ''} · ${p.sales_access ? `담당자 코드 ${(p.emp_ids || []).length}개` : '영업채널 꺼짐'}`
        : `${p.email || ''} · ${d.getMonth() + 1}/${d.getDate()} 가입`;
      who.append(name, meta);
      li.append(who);
      const btn = (text, cls, next) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.className = cls;
        b.dataset.id = p.id;
        b.dataset.status = next;
        return b;
      };
      if (status === 'approved') {
        // 영업채널 켜기/끄기. 담당자 코드 연결은 사내 현황판의 '담당자 연결' 화면에서
        const b = btn(p.sales_access ? '영업채널 끄기' : '영업채널 켜기', p.sales_access ? 'ap-reject' : 'ap-approve', '');
        b.dataset.sales = p.sales_access ? '0' : '1';
        li.append(b);
      } else {
        if (status === 'pending') li.append(btn('거절', 'ap-reject', 'rejected'));
        li.append(btn('승인', 'ap-approve', 'approved'));
      }
      items.push(li);
    }
  }
  $('#approvalList').replaceChildren(...items);
}

$('#approvalBtn').addEventListener('click', async () => {
  settings.close();
  renderApprovals();
  approvalDialog.showModal();
  await refreshApprovals();
  renderApprovals();
});

approvalDialog.addEventListener('click', async (e) => {
  const b = e.target.closest('.approval-list button');
  if (!b) return;
  const p = approvals.find((x) => x.id === b.dataset.id);
  const who = p?.name || p?.email || '';
  if (b.dataset.sales) {
    const on = b.dataset.sales === '1';
    b.disabled = true;
    const { error } = await sb.from('profiles').update({ sales_access: on }).eq('id', b.dataset.id);
    if (error) {
      b.disabled = false;
      showToast(`처리하지 못했어요: ${error.message}`);
      return;
    }
    showToast(on ? `${who} 님 영업채널을 켰어요. 사내 현황판 '담당자 연결'에서 담당자 코드를 연결해 주세요.`
      : `${who} 님 영업채널을 껐어요.`);
    await refreshApprovals();
    renderApprovals();
    return;
  }
  if (b.dataset.status === 'rejected' && !confirm(`${who} 님의 가입을 거절할까요?`)) return;
  b.disabled = true;
  const { error } = await sb.from('profiles').update({ status: b.dataset.status }).eq('id', b.dataset.id);
  if (error) {
    b.disabled = false;
    showToast(`처리하지 못했어요: ${error.message}`);
    return;
  }
  showToast(b.dataset.status === 'approved' ? `${who} 님을 승인했어요.` : `${who} 님의 가입을 거절했어요.`);
  await refreshApprovals();
  renderApprovals();
});

$('#nameBtn').addEventListener('click', () => {
  settings.close();
  askName();
});

$('#noticeEditBtn').addEventListener('click', () => {
  settings.close();
  openNoteEditor('notice');
});
$('#promoEditBtn').addEventListener('click', () => {
  settings.close();
  openNoteEditor('promo');
});

// ---------- 아카이브 ----------
const archiveDialog = $('#archive');

function renderArchive() {
  const now = Date.now();
  $('#archiveList').replaceChildren(...archive.map((t) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    text.className = 'a-text';
    text.textContent = t.clinic ? `[${t.clinic}] ${t.text}` : t.text;
    const meta = document.createElement('span');
    meta.className = 'a-meta';
    const daysLeft = Math.max(1, Math.ceil((t.archivedAt + ARCHIVE_DAYS * DAY_MS - now) / DAY_MS));
    meta.textContent = `완료 ${formatTime(t.doneAt || t.archivedAt)} · ${daysLeft}일 후 삭제`;
    text.append(meta);
    const del = document.createElement('button');
    del.textContent = '🗑️';
    del.setAttribute('aria-label', '삭제');
    del.dataset.id = t.id;
    li.append(text, del);
    return li;
  }));
}

$('#archiveBtn').addEventListener('click', () => {
  purgeArchive();
  renderArchive();
  settings.close();
  archiveDialog.showModal();
});

archiveDialog.addEventListener('click', (e) => {
  const id = e.target.closest('.archive-list button')?.dataset.id;
  if (!id) return;
  archive = archive.filter((t) => t.id !== id);
  save();
  renderTasks();
  renderArchive();
});

$('#archiveClearBtn').addEventListener('click', () => {
  if (!confirm(`아카이브 ${archive.length}개를 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
  archive = [];
  save();
  renderTasks();
  renderArchive();
});

// ---------- 할일 백업 ----------
function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('#exportBtn').addEventListener('click', () => {
  downloadBlob(new Blob([JSON.stringify({ tasks, archive }, null, 2)], { type: 'application/json' }),
    `할일백업_${ymd(new Date()).replaceAll('-', '')}.json`);
  settings.close();
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    // 예전 백업(할일 배열만)도 받음
    const newTasks = Array.isArray(data) ? data : data.tasks;
    const newArchive = Array.isArray(data) ? [] : (data.archive || []);
    const isTask = (t) => t && t.id && typeof t.text === 'string';
    const valid = Array.isArray(newTasks) && newTasks.every((t) => isTask(t) && COLS.includes(t.col))
      && Array.isArray(newArchive) && newArchive.every((t) => isTask(t) && t.archivedAt);
    if (!valid) throw new Error('invalid');
    if (!confirm(`백업의 할 일 ${newTasks.length}개(아카이브 ${newArchive.length}개)로 현재 목록을 바꿀까요?`)) return;
    tasks = newTasks;
    archive = newArchive;
    purgeArchive();
    save();
    renderTasks();
    settings.close();
    showToast('백업을 불러왔어요.');
  } catch {
    showToast('올바른 백업 파일이 아니에요.');
  }
});

// ================= 주간 엑셀 (마스터) =================
const reportDialog = $('#reportDialog');

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// 주간 보고 주 선택 (kind: xlsx 주간 엑셀 · ppt 주간보고 PPT)
let reportKind = 'xlsx';
function openReport(kind) {
  reportKind = kind;
  $('#reportTitle').textContent = kind === 'ppt' ? '주간보고 PPT' : '주간 엑셀 다운로드';
  $('#reportDesc').textContent = kind === 'ppt'
    ? (isMaster()
      ? '월별 매출 목표 현황 → 영업사원별 실험트랙 → 영업사원별 주간보고(선택한 주 월~일) 순서로 세로 A4 PPT를 받아요.'
      : '내 실험트랙 → 내 주간보고(선택한 주 월~일) 순서로 세로 A4 PPT를 받아요.')
    : '선택한 주(월~일)의 전체 영업사원 할일·영업일지·협업일지를 엑셀로 받아요.';
  const thisMonday = mondayOf(new Date());
  const options = [];
  for (let i = 0; i < 8; i++) {
    const mon = new Date(thisMonday);
    mon.setDate(mon.getDate() - 7 * i);
    const sat = new Date(mon);
    sat.setDate(sat.getDate() + 5);
    const opt = document.createElement('option');
    opt.value = ymd(mon);
    const label = `${mon.getMonth() + 1}/${mon.getDate()}(월) ~ ${sat.getMonth() + 1}/${sat.getDate()}(토)`;
    opt.textContent = i === 0 ? `이번 주 · ${label}` : i === 1 ? `지난주 · ${label}` : label;
    options.push(opt);
  }
  $('#reportWeek').replaceChildren(...options);
  // 일요일·월요일에는 지난주를 기본으로
  if ([0, 1].includes(new Date().getDay())) $('#reportWeek').selectedIndex = 1;
  drawer.close();
  reportDialog.showModal();
}
$('#reportBtn').addEventListener('click', () => openReport('xlsx'));
$('#pptBtn').addEventListener('click', () => openReport('ppt'));

// 엑셀·PPT 도구는 필요할 때만 불러옴
const libLoading = {};
function loadLib(url, name, label) {
  if (window[name]) return Promise.resolve(window[name]);
  libLoading[name] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window[name]);
    s.onerror = () => {
      libLoading[name] = null;
      reject(new Error(`${label} 도구를 불러오지 못했어요.`));
    };
    document.head.append(s);
  });
  return libLoading[name];
}
const loadXlsx = () => loadLib(XLSX_URL, 'XLSX', '엑셀');
const loadPptx = () => loadLib(PPTX_URL, 'PptxGenJS', 'PPT');

const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// 주간 보고(엑셀·PPT) 공통: 선택한 주(월~일)의 할일·영업일지·협업일지
// 마스터는 전원 것, 영업사원은 서버 규칙(RLS)상 자기 것만 받음
async function fetchWeek(mondayStr) {
  const start = parseYmd(mondayStr);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const s = start.toISOString();
  const e = end.toISOString();

  const [profRows, weekTasks, weekJournals, weekCollabs] = await Promise.all([
    selectAll(() => sb.from('profiles').select('id, name, email').order('id')),
    selectAll(() => sb.from('tasks').select('*')
      .or(`and(created_at.gte.${s},created_at.lt.${e}),and(done_at.gte.${s},done_at.lt.${e})`)
      .order('created_at').order('id')),
    selectAll(() => sb.from('journals').select('*').gte('visit_date', mondayStr).lt('visit_date', ymd(end))
      .order('visit_date').order('created_at').order('id')),
    selectAll(() => sb.from('collabs').select('*').gte('collab_date', mondayStr).lt('collab_date', ymd(end))
      .order('collab_date').order('created_at').order('id')),
  ]);

  const names = new Map(profRows.map((p) => [p.id, p.name || p.email || '']));
  return {
    start, weekTasks, weekJournals, weekCollabs,
    who: (id) => names.get(id) || '(이름 없음)',
    inWeek: (iso) => iso && iso >= s && iso < e,
  };
}

async function buildWeeklyReport(mondayStr) {
  const [XLSX, { start, weekTasks, weekJournals, weekCollabs, who, inWeek }] = await Promise.all([
    loadXlsx(),
    fetchWeek(mondayStr),
  ]);

  // 영업사원별 요약
  const summary = new Map();
  const sum = (id) => {
    if (!summary.has(id)) summary.set(id, { 등록: 0, 완료: 0, 일지: 0, 일반영업: 0, 관리방문: 0, 상: 0, 중: 0, 하: 0, 협업: 0 });
    return summary.get(id);
  };
  weekTasks.forEach((t) => {
    if (inWeek(t.created_at)) sum(t.user_id).등록++;
    if (inWeek(t.done_at)) sum(t.user_id).완료++;
  });
  weekJournals.forEach((j) => {
    const row = sum(j.user_id);
    row.일지++;
    if (VISIT_TYPES.includes(j.visit_type)) row[j.visit_type]++;
    if (j.temperature) row[j.temperature]++;
  });
  weekCollabs.forEach((c) => sum(c.user_id).협업++);

  const summaryRows = [...summary].map(([id, v]) => ({
    영업사원: who(id), '할일 등록': v.등록, '할일 완료': v.완료, 영업일지: v.일지,
    일반영업: v.일반영업, 관리방문: v.관리방문,
    '감도 상': v.상, '감도 중': v.중, '감도 하': v.하, 협업일지: v.협업,
  })).sort((a, b) => a.영업사원.localeCompare(b.영업사원, 'ko'));

  const taskRows = weekTasks.map((t) => ({
    영업사원: who(t.user_id),
    치과명: t.clinic || '',
    내용: t.text,
    상태: COL_NAMES[t.col] || t.col,
    납기일: t.due || '',
    등록일시: fmtDateTime(t.created_at),
    완료일시: fmtDateTime(t.done_at),
  })).sort((a, b) => a.영업사원.localeCompare(b.영업사원, 'ko'));

  const journalRows = weekJournals.map((j) => ({
    영업사원: who(j.user_id),
    방문일: j.visit_date,
    요일: WEEKDAYS[parseYmd(j.visit_date).getDay()],
    지역: j.region || '',
    치과명: j.clinic || '',
    방문유형: j.visit_type || '',
    구분: clinicType(j),
    감도: j.temperature || '',
    내용: j.content || '',
  })).sort((a, b) => a.영업사원.localeCompare(b.영업사원, 'ko') || a.방문일.localeCompare(b.방문일));

  const collabRows = weekCollabs.map((c) => ({
    영업사원: who(c.user_id),
    날짜: c.collab_date,
    요일: WEEKDAYS[parseYmd(c.collab_date).getDay()],
    협력자: c.partner || '',
    치과명: c.clinic || '',
    협력내용: c.how || '',
    결과: c.result || '',
  })).sort((a, b) => a.영업사원.localeCompare(b.영업사원, 'ko') || a.날짜.localeCompare(b.날짜));

  const sheet = (rows, headers, widths) => {
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    ws['!cols'] = widths.map((wch) => ({ wch }));
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(summaryRows,
    ['영업사원', '할일 등록', '할일 완료', '영업일지', '일반영업', '관리방문', '감도 상', '감도 중', '감도 하', '협업일지'],
    [14, 10, 10, 10, 10, 10, 8, 8, 8, 10]), '요약');
  XLSX.utils.book_append_sheet(wb, sheet(journalRows,
    ['영업사원', '방문일', '요일', '방문유형', '지역', '치과명', '구분', '감도', '내용'],
    [12, 12, 6, 10, 12, 20, 8, 6, 60]), '영업일지');
  XLSX.utils.book_append_sheet(wb, sheet(taskRows,
    ['영업사원', '치과명', '내용', '상태', '납기일', '등록일시', '완료일시'],
    [12, 20, 50, 8, 12, 17, 17]), '할일');
  XLSX.utils.book_append_sheet(wb, sheet(collabRows,
    ['영업사원', '날짜', '요일', '협력자', '치과명', '협력내용', '결과'],
    [12, 12, 6, 16, 20, 45, 45]), '협업일지');

  const sat = new Date(start);
  sat.setDate(sat.getDate() + 5);
  XLSX.writeFile(wb, `주간보고_${mondayStr}_${ymd(sat)}.xlsx`);
  return { tasks: taskRows.length, journals: journalRows.length, collabs: collabRows.length };
}

// ---------- 주간보고 PPT: 영업사원별 세로 A4 보고서 (내용이 길면 다음 장으로 이어짐) ----------
const PPT = { font: 'Malgun Gothic', accent: '2563EB', text: '111827', muted: '6B7280', danger: 'DC2626' };
const md = (d) => `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
const mdShort = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// 세로 A4(8.27×11.69인치)에 위에서부터 차례로 쌓고, 자리가 모자라면 '(계속)' 장을 새로 만듦
function pptPage(pptx, title) {
  const X = 0.6, W = 7.07, BOTTOM = 11.1;
  let slide, y;
  const newSlide = (cont) => {
    slide = pptx.addSlide();
    slide.addText(cont ? `${title} (계속)` : title, {
      x: X, y: 0.45, w: W, h: 0.5, fontSize: 16, bold: true, color: PPT.text, margin: 0,
    });
    slide.addShape(pptx.ShapeType.line, { x: X, y: 1.0, w: W, h: 0, line: { color: PPT.text, width: 1.5 } });
    y = 1.15;
  };
  // 10.5pt 한글은 1인치에 약 6.6자 (영문·숫자·공백은 반 칸)로 어림해 줄 수를 셈
  const lineCount = (text, w) => {
    const units = [...text].reduce((n, ch) => n + (ch.charCodeAt(0) < 0x1100 ? 0.55 : 1), 0);
    return Math.max(1, Math.ceil(units / (w * 6.6)));
  };
  newSlide(false);
  return {
    heading(text) {
      if (y + 0.9 > BOTTOM) newSlide(true);
      y += 0.15;
      slide.addText(text, { x: X, y, w: W, h: 0.34, fontSize: 13, bold: true, color: PPT.accent, margin: 0 });
      y += 0.42;
    },
    sub(text) {
      if (y + 0.6 > BOTTOM) newSlide(true);
      slide.addText(text, { x: X + 0.1, y, w: W - 0.1, h: 0.28, fontSize: 11, bold: true, color: PPT.text, margin: 0 });
      y += 0.32;
    },
    // 글머리표 한 개 (한 줄 안에서 굵기·색을 섞으면 pptxgenjs가 PowerPoint 복구 오류가 나는 XML을 만들어 한 모양으로만)
    item(text, color = PPT.text) {
      const x = X + 0.15;
      const h = lineCount(text, W - 0.15 - 0.3) * 0.21 + 0.06;
      if (y + h > BOTTOM) newSlide(true);
      slide.addText(text, {
        x, y, w: X + W - x, h, fontSize: 10.5, color, valign: 'top', margin: 0, bullet: { indent: 12 },
      });
      y += h + 0.05;
    },
    // 그림·차트 등 높이 h 인치를 차지하는 내용: draw(slide, x, y, w)
    block(h, draw) {
      if (y + h > BOTTOM) newSlide(true);
      draw(slide, X, y, W);
      y += h + 0.1;
    },
    // 표: rows = [{ cells: [...], bold }]. 자리가 모자라면 다음 장에 머리줄과 함께 이어 그림
    table(head, rows, colW, align = []) {
      const RH = 0.3;
      const cell = (text, i, opt = {}) => ({ text: String(text), options: { align: align[i] || 'left', ...opt } });
      const headRow = head.map((t, i) => cell(t, i, { bold: true, color: 'FFFFFF', fill: { color: PPT.accent } }));
      let rest = rows;
      while (rest.length) {
        if (Math.floor((BOTTOM - y) / RH) - 1 < 2) newSlide(true);
        const fit = Math.floor((BOTTOM - y) / RH) - 1;
        const chunk = rest.slice(0, fit);
        rest = rest.slice(fit);
        slide.addTable([headRow, ...chunk.map((r) => r.cells.map((t, i) => cell(t, i, r.bold ? { bold: true, fill: { color: 'F3F4F6' } } : {})))], {
          x: X, y, w: W, colW, rowH: RH, fontSize: 9.5, color: PPT.text, valign: 'middle',
          border: { type: 'solid', pt: 0.5, color: 'D1D5DB' },
        });
        y += (chunk.length + 1) * RH + 0.12;
      }
    },
  };
}

// 월별 매출 목표 달성현황 (마스터 PPT 첫 장)
function pptSales(pptx, d) {
  const page = pptPage(pptx, `■ ${d.y}년 월별 매출 목표 달성 현황`);
  page.item(`집계 기준: 전월 26일~당월 25일 · ${ymd(new Date())} 기준 (마감된 달은 마감 금액, ${d.cur}월은 오늘까지 청구 금액)`, PPT.muted);
  const labels = d.months.map((x) => `${x.m}월`);
  page.block(3.4, (slide, x, y, w) => slide.addChart(pptx.ChartType.bar, [
    { name: '목표(백만원)', labels, values: d.months.map((m) => m.target || 0) },
    { name: '실적(백만원)', labels, values: d.months.map((m) => (m.amt === null ? 0 : Number(mil(m.amt)))) },
  ], {
    x, y, w, h: 3.4, barDir: 'col', barGrouping: 'clustered', chartColors: ['D1D5DB', PPT.accent],
    showLegend: true, legendPos: 't', legendFontSize: 9, legendFontFace: PPT.font,
    catAxisLabelFontSize: 9, catAxisLabelFontFace: PPT.font, valAxisLabelFontSize: 8, valAxisMinVal: 0,
    valGridLine: { color: 'E5E7EB', size: 0.5 },
  }));
  const cur = d.months[d.cur - 1];
  const prog = billingProgress(d.y, d.cur);
  page.heading(`${d.cur}월 현재 (진행 중)`);
  page.item(`당월 목표 ${cur.target ?? '-'}백만원 · 누적 실적 ${cur.amt === null ? '-' : `${mil(cur.amt)}백만원`} · 달성률 ${cur.rate === null ? '-' : `${cur.rate}%`}`);
  page.item(`기간 경과 ${prog.elapsed}/${prog.total}일 (${Math.round((prog.elapsed / prog.total) * 100)}%)`, PPT.muted);
  page.heading('월별 실적');
  const rows = d.months.filter((x) => x.amt !== null).map((x) => ({
    cells: [`${x.m}월${x.closed ? '' : ' (진행 중)'}`, x.target ?? '-', mil(x.amt), x.rate === null ? '-' : `${x.rate}%`],
  }));
  if (d.closedCount) {
    const closed = d.months.filter((x) => x.closed && x.target);
    rows.push({
      cells: [`1~${d.lastClosed}월 누적`, closed.reduce((s, x) => s + x.target, 0), mil(closed.reduce((s, x) => s + x.amt, 0)), `${d.cum}%`],
      bold: true,
    });
  }
  if (rows.length) page.table(['월', '목표(백만원)', '실적(백만원)', '달성률'], rows, [2.27, 1.6, 1.6, 1.6], ['left', 'right', 'right', 'right']);
  else page.item('사내 미니PC에서 아직 매출 자료가 올라오지 않았어요.', PPT.muted);
}

// 실험트랙: 진행 중인 트랙마다 목적·진행 방법·치과 표
function pptTracks(pptx, name, list) {
  const page = pptPage(pptx, `■ 실험트랙 – ${name}`);
  if (!list.length) {
    page.item('진행 중인 실험트랙이 없어요.', PPT.muted);
    return;
  }
  list.forEach((t, i) => {
    page.heading(`트랙 ${i + 1}. ${t.title || '(이름 없음)'} (${trackPeriod(t)})`);
    page.item(`목적: ${t.purpose || '-'}`);
    page.item(`진행 방법: ${t.plan || '-'}`);
    if (!t.clinics.length) {
      page.item('등록한 치과가 없어요.', PPT.muted);
      return;
    }
    const sum = trackSum(t.clinics);
    const rows = t.clinics.map((c) => ({
      cells: [clip(tcName(c), 20), c.kind || '-', `${tcStatus(t, c)}(${tcPeriod(t, c)})`, c.dx || 0, c.mnft || 0],
    }));
    rows.push({ cells: [`합계 (${t.clinics.length}곳)`, '', '', sum.dx, sum.mnft], bold: true });
    const noted = t.clinics.filter(tcLastNote);
    page.table(['지역_치과명', '유형', '상태(기간)', '진단', '제작'], rows, [2.7, 0.8, 2.07, 0.75, 0.75],
      ['left', 'center', 'left', 'center', 'center']);
    if (noted.length) {
      page.sub('치과별 최근 특이사항');
      noted.forEach((c) => {
        const n = tcLastNote(c);
        page.item(`${clip(tcName(c), 20)}: ${n.text.replace(/\s+/g, ' ')} (${mdSlash(n.date)})`);
      });
    }
  });
}

function pptReport(pptx, name, period, p, today) {
  const page = pptPage(pptx, `■ 주간업무 보고 (${period}) – ${name}`);
  const none = () => page.item('없음', PPT.muted);
  const visits = p.journals;
  const care = (j) => j.visit_type === '관리방문';
  const regions = [...new Set(visits.map((j) => (j.region || '').trim()).filter(Boolean))];

  page.heading('1. 지난주 영업 활동 요약');
  page.item(`총 ${visits.length}곳 방문 (일반영업 ${visits.filter((j) => !care(j)).length}, 관리방문 ${visits.filter(care).length})`);
  page.item(`지역: ${regions.join(', ') || '-'}`);

  page.heading('2. 주요 거래처 이슈');
  // 관리방문 일지 + 치과명을 적은 완료 할일을 치과별로 묶음
  const clinics = new Map();
  const at = (clinic) => {
    const key = (clinic || '').trim() || '(치과명 없음)';
    if (!clinics.has(key)) clinics.set(key, { visits: [], tasks: [] });
    return clinics.get(key);
  };
  visits.filter(care).forEach((j) => at(j.clinic).visits.push(j));
  p.done.filter((t) => t.clinic?.trim()).forEach((t) => at(t.clinic).tasks.push(t));
  page.sub('관리 거래처 (방문·처리 내역)');
  if (!clinics.size) none();
  clinics.forEach(({ visits: vs, tasks }, clinic) => {
    const parts = [
      ...vs.map((j) => `[방문 ${mdShort(parseYmd(j.visit_date))}] ${clip(j.content || '', 300)}`.trim()),
      ...(tasks.length ? [`[처리] ${tasks.map((t) => t.text).join(', ')}`] : []),
    ];
    page.item(`${clinic} — ${parts.join(' / ')}`);
  });
  const TEMP_ORDER = { 상: 0, 중: 1 };
  const warm = visits.filter((j) => !care(j) && j.temperature in TEMP_ORDER)
    .sort((a, b) => TEMP_ORDER[a.temperature] - TEMP_ORDER[b.temperature]);
  page.sub('일반영업 (감도 중 이상)');
  if (!warm.length) none();
  warm.forEach((j) => {
    const info = [j.region, `감도 ${j.temperature}`].filter(Boolean).join(', ');
    page.item(`${j.clinic || '(치과명 없음)'} (${info})${j.content ? ` — ${clip(j.content, 300)}` : ''}`);
  });

  page.heading('3. 주요 업무 처리 현황');
  const work = p.done.filter((t) => !t.clinic?.trim()).sort((a, b) => a.done_at.localeCompare(b.done_at));
  if (!work.length) none();
  work.forEach((t) => page.item(t.text));

  page.heading('4. 추후 업무 계획');
  if (!p.plan.length) none();
  p.plan.forEach((t) => {
    const late = t.due && t.due < today;
    const date = t.due ? mdShort(parseYmd(t.due)) : '날짜 없음';
    page.item(`${date}${late ? ' (지연)' : ''}  ${t.clinic?.trim() ? `[${t.clinic.trim()}] ` : ''}${t.text}`,
      late ? PPT.danger : PPT.text);
  });
}

// 마스터: 월별 매출 → 영업사원별 실험트랙 → 영업사원별 주간보고 / 영업사원: 본인 실험트랙 → 본인 주간보고
async function buildWeeklyPpt(mondayStr) {
  const master = isMaster();
  const [PptxGenJS, week, openTasks, trackRows, sales] = await Promise.all([
    loadPptx(),
    fetchWeek(mondayStr),
    // 추후 계획: 지금 남아 있는 할일 (아카이브 제외)
    selectAll(() => sb.from('tasks').select('*').is('archived_at', null).eq('col', 'todo')
      .order('created_at').order('id')),
    // 진행 중인 실험트랙 (마스터는 서버 규칙상 전원 것)
    selectAll(() => sb.from('tracks').select('*').eq('status', '진행중').order('created_at').order('id')),
    master ? fetchSales() : null,
  ]);
  const { start, weekTasks, weekJournals, who, inWeek } = week;
  const sun = new Date(start);
  sun.setDate(sun.getDate() + 6);

  const people = new Map();
  const of = (id) => {
    if (!people.has(id)) people.set(id, { done: [], journals: [], plan: [] });
    return people.get(id);
  };
  weekTasks.filter((t) => inWeek(t.done_at)).forEach((t) => of(t.user_id).done.push(t));
  weekJournals.forEach((j) => of(j.user_id).journals.push(j));
  // 아직 안 끝낸 할일 전부 (치과명 있는 일 포함, 지난 날짜는 '지연')
  openTasks.forEach((t) => of(t.user_id).plan.push(t));
  if (!master) of(user.id); // 영업사원은 내용이 없어도 본인 보고서를 만듦
  const trackBy = new Map();
  // 기간이 지난 트랙은 빼고
  trackRows.map(trackFromRow).forEach((t, i) => {
    if (!trackOn(t)) return;
    const id = trackRows[i].user_id;
    if (!trackBy.has(id)) trackBy.set(id, []);
    trackBy.get(id).push(t);
  });
  if (!people.size && !trackBy.size && !sales) throw new Error('이 주에는 보고할 내용이 없어요.');

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'A4_PORTRAIT', width: 8.27, height: 11.69 });
  pptx.layout = 'A4_PORTRAIT';
  pptx.theme = { headFontFace: PPT.font, bodyFontFace: PPT.font };
  const period = `${mdShort(start)}~${mdShort(sun)}`;
  const today = ymd(new Date());
  const byName = ([a], [b]) => who(a).localeCompare(who(b), 'ko');
  if (sales) pptSales(pptx, sales);
  if (master) [...trackBy].sort(byName).forEach(([id, list]) => pptTracks(pptx, who(id), list));
  else pptTracks(pptx, who(user.id), trackBy.get(user.id) || []);
  [...people].sort(byName).forEach(([id, p]) => {
    p.plan.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    pptReport(pptx, who(id), period, p, today);
  });
  const suffix = master ? '' : `_${profileName || '내보고'}`;
  await pptx.writeFile({ fileName: `주간보고${suffix}_${mondayStr}.pptx` });
  return { people: people.size, slides: pptx.slides.length };
}

$('#reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = '만드는 중…';
  const label = reportKind === 'ppt' ? 'PPT' : '엑셀';
  try {
    if (reportKind === 'ppt') {
      const { people, slides } = await buildWeeklyPpt($('#reportWeek').value);
      reportDialog.close();
      showToast(isMaster() ? `PPT를 만들었어요. (영업사원 ${people}명, ${slides}장)` : `PPT를 만들었어요. (${slides}장)`);
    } else {
      const { tasks: nt, journals: nj, collabs: nc } = await buildWeeklyReport($('#reportWeek').value);
      reportDialog.close();
      showToast(`엑셀을 만들었어요. (영업일지 ${nj}건, 할일 ${nt}건, 협업일지 ${nc}건)`);
    }
  } catch (err) {
    console.error('[report]', err);
    showToast(`${label}를 만들지 못했어요: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = '다운로드';
  }
});

// ================= 전체 데이터 백업 (마스터) =================
const BACKUP_KEY = 'last-backup-at';
const BACKUP_REMIND_DAYS = 30;
const fetchAll = (table, columns = '*', orderBy = 'created_at', key = 'id') =>
  selectAll(() => sb.from(table).select(columns).order(orderBy).order(key));

async function buildFullBackup() {
  const [XLSX, profiles, taskRows, journalRows, collabRows, trackRows, boardRows] = await Promise.all([
    loadXlsx(),
    fetchAll('profiles', 'id, name, email, status, created_at'),
    fetchAll('tasks'),
    fetchAll('journals'),
    fetchAll('collabs'),
    fetchAll('tracks'),
    fetchAll('board', 'kind, body, data, updated_at', 'kind', 'kind'),
  ]);
  const names = new Map(profiles.map((p) => [p.id, p.name || p.email || '']));
  const who = (id) => names.get(id) || '(이름 없음)';
  const byName = (a, b) => a.영업사원.localeCompare(b.영업사원, 'ko');
  const STATUS = { pending: '승인 대기', approved: '승인', rejected: '거절' };

  const profileSheet = profiles.map((p) => ({
    이름: p.name || '', 이메일: p.email || '',
    상태: MASTER_EMAILS.includes((p.email || '').toLowerCase()) ? '마스터' : (STATUS[p.status] || p.status || ''),
    가입일시: fmtDateTime(p.created_at), ID: p.id,
  }));

  const taskSheet = taskRows.map((t) => ({
    영업사원: who(t.user_id),
    치과명: t.clinic || '',
    내용: t.text,
    상태: t.archived_at ? '아카이브' : (COL_NAMES[t.col] || t.col),
    납기일: t.due || '',
    등록일시: fmtDateTime(t.created_at),
    완료일시: fmtDateTime(t.done_at),
    아카이브일시: fmtDateTime(t.archived_at),
    ID: t.id,
    사용자ID: t.user_id,
  })).sort((a, b) => byName(a, b) || a.등록일시.localeCompare(b.등록일시));

  const journalSheet = journalRows.map((j) => ({
    영업사원: who(j.user_id),
    방문일: j.visit_date,
    요일: WEEKDAYS[parseYmd(j.visit_date).getDay()],
    지역: j.region || '',
    치과명: j.clinic || '',
    방문유형: j.visit_type || '',
    구분: clinicType(j),
    감도: j.temperature || '',
    내용: j.content || '',
    작성일시: fmtDateTime(j.created_at),
    ID: j.id,
    사용자ID: j.user_id,
  })).sort((a, b) => byName(a, b) || a.방문일.localeCompare(b.방문일));

  const collabSheet = collabRows.map((c) => ({
    영업사원: who(c.user_id),
    날짜: c.collab_date,
    요일: WEEKDAYS[parseYmd(c.collab_date).getDay()],
    협력자: c.partner || '',
    치과명: c.clinic || '',
    협력내용: c.how || '',
    결과: c.result || '',
    작성일시: fmtDateTime(c.created_at),
    ID: c.id,
    사용자ID: c.user_id,
  })).sort((a, b) => byName(a, b) || a.날짜.localeCompare(b.날짜));

  // 실험트랙: 치과 한 곳당 한 줄 (치과가 없으면 트랙만 한 줄)
  const trackSheet = trackRows.flatMap((r) => {
    const t = trackFromRow(r);
    const base = {
      영업사원: who(r.user_id), 트랙: t.title, 트랙상태: trackOn(t) ? '진행중' : '종료',
      트랙시작일: t.start, 트랙종료일: t.end, 목적: t.purpose, 진행방법: t.plan,
    };
    const tail = { 작성일시: fmtDateTime(r.created_at), ID: r.id, 사용자ID: r.user_id };
    if (!t.clinics.length) return [{ ...base, ...tail }];
    return t.clinics.map((c) => ({
      ...base, 지역: c.region || '', 치과명: c.clinic || '', 유형: c.kind || '',
      치과상태: tcStatus(t, c), 시작일: c.start || '', 종료일: tcEnd(t, c), 진단: c.dx || 0, 제작: c.mnft || 0,
      특이사항: tcNotes(c).map((n) => `${n.date} ${n.text}`).join('\n'), ...tail,
    }));
  }).sort(byName);

  const boardSheet = boardRows.map((r) => {
    const d = r.data || {};
    const discounts = PROMO_PKGS.filter(([k]) => d.discounts?.[k] > 0)
      .map(([k, name]) => `${name} -${won(d.discounts[k])}원`).join(', ');
    return {
      종류: NOTE_LABELS[r.kind] || r.kind,
      내용: r.body || '',
      할인: discounts,
      종료일: d.until || '',
      수정일시: fmtDateTime(r.updated_at),
    };
  });

  const now = new Date();
  const infoSheet = [
    { 항목: '백업 일시', 값: fmtDateTime(now.toISOString()) },
    { 항목: '백업한 사람', 값: `${profileName || ''} (${user.email})` },
    { 항목: '영업사원(계정)', 값: `${profileSheet.length}명` },
    { 항목: '할일', 값: `${taskSheet.length}건 (아카이브 포함)` },
    { 항목: '영업일지', 값: `${journalSheet.length}건` },
    { 항목: '협업일지', 값: `${collabSheet.length}건` },
    { 항목: '실험트랙', 값: `${trackRows.length}개` },
    { 항목: '공지·프로모션', 값: `${boardSheet.length}건` },
    { 항목: '참고', 값: 'ID·사용자ID 열은 복원할 때 쓰이니 지우지 마세요.' },
  ];

  const sheet = (rows, headers, widths) => {
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    ws['!cols'] = widths.map((wch) => ({ wch }));
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(infoSheet, ['항목', '값'], [16, 50]), '안내');
  XLSX.utils.book_append_sheet(wb, sheet(profileSheet, ['이름', '이메일', '상태', '가입일시', 'ID'], [12, 28, 10, 17, 38]), '영업사원');
  XLSX.utils.book_append_sheet(wb, sheet(journalSheet,
    ['영업사원', '방문일', '요일', '방문유형', '지역', '치과명', '구분', '감도', '내용', '작성일시', 'ID', '사용자ID'],
    [12, 12, 6, 10, 12, 20, 9, 6, 60, 17, 16, 38]), '영업일지');
  XLSX.utils.book_append_sheet(wb, sheet(taskSheet,
    ['영업사원', '치과명', '내용', '상태', '납기일', '등록일시', '완료일시', '아카이브일시', 'ID', '사용자ID'],
    [12, 20, 50, 9, 12, 17, 17, 17, 16, 38]), '할일');
  XLSX.utils.book_append_sheet(wb, sheet(collabSheet,
    ['영업사원', '날짜', '요일', '협력자', '치과명', '협력내용', '결과', '작성일시', 'ID', '사용자ID'],
    [12, 12, 6, 16, 20, 45, 45, 17, 16, 38]), '협업일지');
  XLSX.utils.book_append_sheet(wb, sheet(trackSheet,
    ['영업사원', '트랙', '트랙상태', '트랙시작일', '트랙종료일', '목적', '진행방법', '지역', '치과명', '유형', '치과상태', '시작일', '종료일', '진단', '제작', '특이사항', '작성일시', 'ID', '사용자ID'],
    [12, 24, 8, 12, 12, 36, 36, 10, 20, 8, 9, 12, 12, 6, 6, 40, 17, 16, 38]), '실험트랙');
  XLSX.utils.book_append_sheet(wb, sheet(boardSheet, ['종류', '내용', '할인', '종료일', '수정일시'], [10, 60, 40, 12, 17]), '공지·프로모션');

  XLSX.writeFile(wb, `할일보드_전체백업_${ymd(now)}.xlsx`);
  try {
    localStorage.setItem(BACKUP_KEY, String(Date.now()));
  } catch { /* 무시 */ }
  return { profiles: profileSheet.length, tasks: taskSheet.length, journals: journalSheet.length, collabs: collabSheet.length };
}

function backupOverdue() {
  let last = 0;
  try {
    last = Number(localStorage.getItem(BACKUP_KEY)) || 0;
  } catch { /* 무시 */ }
  return Date.now() - last > BACKUP_REMIND_DAYS * DAY_MS;
}

function renderBackupHint() {
  let last = 0;
  try {
    last = Number(localStorage.getItem(BACKUP_KEY)) || 0;
  } catch { /* 무시 */ }
  const label = $('#backupLabel');
  if (!last) label.textContent = '(아직 안 함)';
  else label.textContent = `(마지막 ${new Date(last).getMonth() + 1}/${new Date(last).getDate()})`;
  label.classList.toggle('warn-text', backupOverdue());
}

// 마스터: 마지막 백업 후 30일이 지나면 한 번 알림
let backupReminded = false;
function remindBackup() {
  if (!isMaster() || backupReminded || !backupOverdue()) return;
  backupReminded = true;
  showToast('전체 데이터 백업을 한 지 30일이 지났어요. 설정에서 백업해 주세요.');
}

$('#backupBtn').addEventListener('click', async () => {
  const btn = $('#backupBtn');
  if (btn.disabled) return;
  btn.disabled = true;
  const label = btn.firstChild;
  const original = label.textContent;
  label.textContent = '💾 백업 파일 만드는 중… ';
  try {
    const r = await buildFullBackup();
    settings.close();
    showToast(`백업 완료: 영업사원 ${r.profiles}명 · 영업일지 ${r.journals}건 · 협업일지 ${r.collabs}건 · 할일 ${r.tasks}건`);
  } catch (err) {
    console.error('[backup]', err);
    showToast(`백업하지 못했어요: ${err.message}`);
  } finally {
    btn.disabled = false;
    label.textContent = original;
    renderBackupHint();
  }
});

// ---------- 공통: 시트 닫기 ----------
$$('dialog').forEach((dlg) => dlg.addEventListener('click', (e) => {
  if (e.target === dlg || e.target.closest('[data-action="close"]')) dlg.close();
}));

// ================= 로그인 =================
const authScreen = $('#authScreen');
const authMsg = $('#authMsg');

function setAuthMsg(text, isError = false) {
  authMsg.textContent = text;
  authMsg.classList.toggle('error', isError);
}

const AUTH_ERRORS = {
  'Invalid login credentials': '이메일 또는 비밀번호가 맞지 않아요.',
  'Email not confirmed': '메일함에서 가입 확인 링크를 먼저 눌러 주세요.',
  'User already registered': '이미 가입된 이메일이에요. 로그인해 주세요.',
};
const authError = (err) => AUTH_ERRORS[err.message] || (err.status === 429
  ? '요청이 너무 많아요. 잠시 후 다시 시도해 주세요.'
  : `오류: ${err.message}`);

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!sb) return setAuthMsg('서버에 연결할 수 없어요. 인터넷을 확인해 주세요.', true);
  const mode = e.submitter?.dataset.mode || 'login';
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const buttons = $$('#authForm button');
  buttons.forEach((b) => (b.disabled = true));
  setAuthMsg(mode === 'signup' ? '가입 중…' : '로그인 중…');
  try {
    if (mode === 'signup') {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: APP_URL } });
      if (error) throw error;
      if (data.user && !data.user.identities?.length) {
        setAuthMsg('이미 가입된 이메일이에요. 로그인해 주세요.', true);
      } else if (!data.session) {
        setAuthMsg(`${email} 로 확인 메일을 보냈어요. 메일의 링크를 누르면 가입이 끝나요.`);
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      setAuthMsg('');
    }
  } catch (err) {
    setAuthMsg(authError(err), true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
});

$('#resetPwBtn').addEventListener('click', async () => {
  const email = $('#authEmail').value.trim();
  if (!email) return setAuthMsg('이메일을 먼저 입력해 주세요.', true);
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: APP_URL });
  setAuthMsg(error ? authError(error) : `${email} 로 비밀번호 재설정 메일을 보냈어요.`, !!error);
});

let channel = null;
let authReady = false;

function setUser(u) {
  if (authReady && u?.id === user?.id) return; // 토큰 갱신 등 같은 사용자
  authReady = true;
  if (channel) {
    sb.removeChannel(channel);
    channel = null;
  }
  user = u;
  tasks = [];
  archive = [];
  journals = [];
  collabs = [];
  tracks = [];
  regionMap = {};
  notes = { notice: '', promo: '' };
  promo = { discounts: {}, until: '' };
  profileName = '';
  setPriceTable(null);
  accessOk = false;
  salesAccess = false;
  alimRows = [];
  renderOffice();
  approvals = [];
  $('#settingsBtn').classList.remove('has-badge');
  Object.values(stores).forEach((s) => (s.synced = new Map()));
  setSync('');
  authScreen.hidden = !!user;
  pendingScreen.hidden = true;
  if (!user) {
    renderAll();
    return;
  }
  loadCache();
  renderAll();
  // 다른 기기에서 바꾸면 바로 다시 받기
  const mine = `user_id=eq.${user.id}`;
  channel = sb.channel(`sync-${user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: mine }, () => schedulePull())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'journals', filter: mine }, () => schedulePull())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, () => schedulePull())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'journals' }, () => schedulePull())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'collabs', filter: mine }, () => schedulePull())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'collabs' }, () => schedulePull())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tracks', filter: mine }, () => schedulePull())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tracks' }, () => schedulePull())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'board' }, () => schedulePull())
    // 승인 상태가 바뀌면 바로 반영 (마스터는 새 가입 요청 알림)
    .on('postgres_changes', isMaster()
      ? { event: '*', schema: 'public', table: 'profiles' }
      : { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` },
    () => (isMaster() ? refreshApprovals() : checkAccess()))
    .subscribe();
  if (accessOk) pull();
  checkAccess();
  if (document.body.dataset.view === 'alim') loadAlim();
}

// ================= 시작 =================
setActiveCol(activeCol);
let lastView = 'todo';
try {
  lastView = localStorage.getItem('last-view') || 'todo';
  todoMode = localStorage.getItem('todo-mode') || 'kanban';
  journalMode = localStorage.getItem('journal-mode') || 'list';
} catch { /* 무시 */ }
calSel = ymd(new Date());
calMonth = parseYmd(calSel.slice(0, 8) + '01');
setTodoMode(todoMode);
setJournalMode(journalMode);
setView(lastView);
syncCalcInputs();
renderAll();

if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
    authToken = session?.access_token ?? null; // 토큰 갱신 때도 최신으로
    // 이 콜백 안에서 바로 서버를 호출하면 멈출 수 있어 다음 차례로 미룸
    setTimeout(async () => {
      if (event === 'PASSWORD_RECOVERY') {
        const pw = prompt('새 비밀번호를 입력해 주세요 (6자 이상)');
        if (pw) {
          const { error } = await sb.auth.updateUser({ password: pw });
          showToast(error ? authError(error) : '비밀번호를 바꿨어요.');
        }
      }
      setUser(session?.user ?? null);
    }, 0);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedulePull(0);
  });
  window.addEventListener('online', () => schedulePull(0));
} else {
  authScreen.hidden = false;
  setAuthMsg('서버에 연결할 수 없어요. 인터넷 연결을 확인한 뒤 앱을 다시 열어 주세요.', true);
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  // 새 버전이 설치되면 한 번 새로고침해서 바로 적용
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
}
