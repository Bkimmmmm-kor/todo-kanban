'use strict';

// 서버(Supabase) 연결 정보. publishable 키는 공개용이며, 데이터는 DB 보안 규칙(RLS)으로 보호됨
const SUPABASE_URL = 'https://ggukxzqsvlmfaxefazjc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_j_wtAX2FkiL4CkoB78jA3Q_otkyQPzG';
const APP_URL = location.origin + location.pathname;
// 화면 표시용. 실제 권한은 서버의 is_master() 규칙이 판단
const MASTER_EMAILS = ['jungbae900@realigner.co.kr', 'jungbae900@naver.com'];
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';

const ARCHIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COLS = ['todo', 'doing', 'done'];
const COL_NAMES = { todo: '할 일', doing: '진행 중', done: '완료' };
const VIEWS = { todo: '할일', journal: '영업일지', calc: '세일즈가이드' };
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
let tasks = [];
let archive = [];
let journals = [];
let notes = { notice: '', promo: '' }; // 공지 / 프로모션 문구
let promo = { discounts: {}, until: '' }; // 프로모션 패키지별 할인액(원), 종료일
let activeCol = 'todo';

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
      tasks, archive, journals, notes, promo, profileName, priceData: priceTable, approved: accessOk,
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
    notes = data.notes || notes;
    promo = data.promo || promo;
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
    const [taskData, journalData, boardRes, priceRes] = await Promise.all([
      // 마스터는 모든 사람 것을 볼 수 있으므로 내 것만 받음
      selectAll(() => sb.from('tasks').select('*').eq('user_id', uid).order('id')),
      selectAll(() => sb.from('journals').select('*').eq('user_id', uid).order('id')),
      sb.from('board').select('kind, body, data'),
      sb.from('price_table').select('data').maybeSingle(),
    ]);
    if (boardRes.error) throw boardRes.error;
    if (user?.id !== uid) return; // 받는 사이 로그아웃
    if (hasPending()) return; // 받는 사이에 화면에서 바뀜 → 다음 동기화 때 반영
    for (const [table, data] of [['tasks', taskData], ['journals', journalData]]) {
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
function setView(view) {
  if (!VIEWS[view]) view = 'todo';
  document.body.dataset.view = view;
  $$('.view').forEach((v) => (v.hidden = v.dataset.view !== view));
  $$('.bottom-nav button').forEach((b) => {
    if (b.dataset.view === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#pageTitle').textContent = VIEWS[view];
  try {
    localStorage.setItem('last-view', view);
  } catch { /* 무시 */ }
}

$$('.bottom-nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

function renderAll() {
  renderQuote();
  renderTasks();
  renderJournals();
  renderNotes();
  renderAutocomplete();
}

// ================= 할일 =================
function addTask(text, clinic = '', due = '') {
  text = text.trim();
  if (!text) return false;
  const now = Date.now();
  const task = { id: newId(), text, col: 'todo', createdAt: now, movedAt: now, doneAt: null };
  if (clinic.trim()) task.clinic = clinic.trim();
  if (due) task.due = due; // 'YYYY-MM-DD'
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
  if (!task || !text) return;
  task.text = text;
  const clinic = $('#editClinic').value.trim();
  const due = $('#editDue').value;
  if (clinic) task.clinic = clinic; else delete task.clinic;
  if (due) task.due = due; else delete task.due;
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
}

// 예전에 입력한 치과명·지역을 자동완성 목록으로
function renderAutocomplete() {
  const fill = (sel, values) => $(sel).replaceChildren(...[...new Set(values.filter(Boolean))].map((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    return opt;
  }));
  fill('#clinicList', [...journals, ...tasks, ...archive].map((t) => t.clinic));
  fill('#regionList', journals.map((j) => j.region));
}

// 납기일 표시: '10/8 (D-2)', 오늘이면 D-day
function dueLabel(due) {
  const date = parseYmd(due);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / DAY_MS);
  const dday = diff === 0 ? 'D-day' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  return { text: `납기 ${date.getMonth() + 1}/${date.getDate()} (${dday})`, diff };
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
    if (task.clinic) tags.append(tagEl(`🦷 ${task.clinic}`));
    if (task.due) {
      const { text, diff } = dueLabel(task.due);
      const urgent = task.col !== 'done' && (diff < 0 ? 'due-over' : diff <= 1 ? 'due-soon' : '');
      tags.append(tagEl(`📅 ${text}`, urgent || ''));
    }
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

// ---------- 카드: 탭 = 다음 단계, 길게 누르기 = 메뉴 ----------
let pressTimer = null;
let pressStart = null;
let longPressed = false;

const board = $('.board');

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
  if (!task) return;
  if (task.col === 'done') {
    openCardMenu(task.id);
  } else {
    moveTask(task.id, task.col === 'todo' ? 'doing' : 'done');
  }
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
  setDue('');
});

// 납기일 버튼: 누르면 달력, 고르면 버튼에 날짜 표시
const dueInput = $('#dueInput');
const dueBtn = $('#dueBtn');

function setDue(value) {
  dueInput.value = value;
  dueBtn.textContent = value ? `📅 ${dueLabel(value).text.replace('납기 ', '')}` : '📅 납기일';
  dueBtn.classList.toggle('set', !!value);
  $('#dueClear').hidden = !value;
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
dueInput.addEventListener('change', () => setDue(dueInput.value));
$('#dueClear').addEventListener('click', () => setDue(''));

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

function renderJournals() {
  const items = [];
  let lastDate = null;
  for (const j of journals) {
    if (j.date !== lastDate) {
      const h = document.createElement('li');
      h.className = 'journal-day';
      h.textContent = dayLabel(j.date);
      items.push(h);
      lastDate = j.date;
    }
    const li = document.createElement('li');
    li.className = 'journal-item';
    li.dataset.id = j.id;
    const head = document.createElement('div');
    head.className = 'j-head';
    const clinic = document.createElement('span');
    clinic.className = 'j-clinic';
    clinic.textContent = j.clinic || '(치과명 없음)';
    head.append(clinic);
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
    items.push(li);
  }
  $('#journalList').replaceChildren(...items);
}

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

function openJournal(id = null, visit = '') {
  const j = journals.find((x) => x.id === id);
  editJournalId = j ? j.id : null;
  $('#journalDialogTitle').textContent = j ? '영업일지 수정' : '영업일지 작성';
  setSeg($('#jVisit'), j ? j.visit || '' : visit);
  $('#jDate').value = j ? j.date : ymd(new Date());
  $('#jRegion').value = j?.region || '';
  $('#jClinic').value = j?.clinic || '';
  setSeg($('#jType'), j?.type || '');
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
let dateText = '';

function renderDateCalc() {
  const input = $('#dateBase');
  const today = ymd(new Date());
  if (!input.value) input.value = today;
  $('#dateTodayBtn').hidden = input.value === today;
  setSeg($('#dateKindSeg'), dateKind);

  const base = parseYmd(input.value);
  const baseWord = input.value === today ? '오늘 날짜로' : `${mdw(base)}에`;
  const rows = [['접수일', mdw(base)]];
  if (dateKind === 'diag') {
    const up = addBizDays(base, DIAG_DAYS);
    rows.push(['업로드 예상', mdw(up)]);
    dateText = `${baseWord} 접수하여 ${mdw(up)} 업로드 예상됩니다. 진단이 완료되면 알림톡으로 안내 도와드리겠습니다.`;
  } else {
    const ship = addBizDays(base, MAKE_DAYS);
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
}

bindSeg($('#dateKindSeg'), (v) => {
  dateKind = v;
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
$$('.bottom-nav button[data-view="calc"]').forEach((b) => b.addEventListener('click', () => {
  $('#dateBase').value = '';
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
    let { data, error } = await sb.from('profiles').select('name, status').eq('id', uid).maybeSingle();
    if (error) throw error;
    if (user?.id !== uid) return;
    if (!data) {
      // 처음 로그인: 승인 요청용 프로필 만들기 (status 는 서버가 pending 으로 정함)
      const res = await sb.from('profiles').upsert({ id: uid, email: user.email }).select('name, status').single();
      if (res.error) throw res.error;
      data = res.data;
    }
    profileName = data.name || '';
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
  const { data, error } = await sb.from('profiles').select('id, name, email, status, created_at')
    .in('status', ['pending', 'rejected']).order('created_at');
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
  for (const [status, label] of [['pending', '승인 대기'], ['rejected', '거절됨']]) {
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
      meta.textContent = `${p.email || ''} · ${d.getMonth() + 1}/${d.getDate()} 가입`;
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
      if (status === 'pending') li.append(btn('거절', 'ap-reject', 'rejected'));
      li.append(btn('승인', 'ap-approve', 'approved'));
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

$('#reportBtn').addEventListener('click', () => {
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
  settings.close();
  reportDialog.showModal();
});

let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = XLSX_URL;
    s.crossOrigin = 'anonymous';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => {
      xlsxLoading = null;
      reject(new Error('엑셀 도구를 불러오지 못했어요.'));
    };
    document.head.append(s);
  });
  return xlsxLoading;
}

const fmtDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${ymd(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

async function buildWeeklyReport(mondayStr) {
  const start = parseYmd(mondayStr);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const s = start.toISOString();
  const e = end.toISOString();

  const [XLSX, profRows, weekTasks, weekJournals] = await Promise.all([
    loadXlsx(),
    selectAll(() => sb.from('profiles').select('id, name, email').order('id')),
    selectAll(() => sb.from('tasks').select('*')
      .or(`and(created_at.gte.${s},created_at.lt.${e}),and(done_at.gte.${s},done_at.lt.${e})`)
      .order('created_at').order('id')),
    selectAll(() => sb.from('journals').select('*').gte('visit_date', mondayStr).lt('visit_date', ymd(end))
      .order('visit_date').order('created_at').order('id')),
  ]);

  const names = new Map(profRows.map((p) => [p.id, p.name || p.email || '']));
  const who = (id) => names.get(id) || '(이름 없음)';
  const inWeek = (iso) => iso && iso >= s && iso < e;

  // 영업사원별 요약
  const summary = new Map();
  const sum = (id) => {
    if (!summary.has(id)) summary.set(id, { 등록: 0, 완료: 0, 일지: 0, 일반영업: 0, 관리방문: 0, 상: 0, 중: 0, 하: 0 });
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

  const summaryRows = [...summary].map(([id, v]) => ({
    영업사원: who(id), '할일 등록': v.등록, '할일 완료': v.완료, 영업일지: v.일지,
    일반영업: v.일반영업, 관리방문: v.관리방문,
    '감도 상': v.상, '감도 중': v.중, '감도 하': v.하,
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

  const sheet = (rows, headers, widths) => {
    const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
    ws['!cols'] = widths.map((wch) => ({ wch }));
    return ws;
  };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet(summaryRows,
    ['영업사원', '할일 등록', '할일 완료', '영업일지', '일반영업', '관리방문', '감도 상', '감도 중', '감도 하'],
    [14, 10, 10, 10, 10, 10, 8, 8, 8]), '요약');
  XLSX.utils.book_append_sheet(wb, sheet(journalRows,
    ['영업사원', '방문일', '요일', '방문유형', '지역', '치과명', '구분', '감도', '내용'],
    [12, 12, 6, 10, 12, 20, 8, 6, 60]), '영업일지');
  XLSX.utils.book_append_sheet(wb, sheet(taskRows,
    ['영업사원', '치과명', '내용', '상태', '납기일', '등록일시', '완료일시'],
    [12, 20, 50, 8, 12, 17, 17]), '할일');

  const sat = new Date(start);
  sat.setDate(sat.getDate() + 5);
  XLSX.writeFile(wb, `주간보고_${mondayStr}_${ymd(sat)}.xlsx`);
  return { tasks: taskRows.length, journals: journalRows.length };
}

$('#reportForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  btn.textContent = '만드는 중…';
  try {
    const { tasks: nt, journals: nj } = await buildWeeklyReport($('#reportWeek').value);
    reportDialog.close();
    showToast(`엑셀을 만들었어요. (영업일지 ${nj}건, 할일 ${nt}건)`);
  } catch (err) {
    console.error('[report]', err);
    showToast(`엑셀을 만들지 못했어요: ${err.message}`);
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
  const [XLSX, profiles, taskRows, journalRows, boardRows] = await Promise.all([
    loadXlsx(),
    fetchAll('profiles', 'id, name, email, status, created_at'),
    fetchAll('tasks'),
    fetchAll('journals'),
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
  XLSX.utils.book_append_sheet(wb, sheet(boardSheet, ['종류', '내용', '할인', '종료일', '수정일시'], [10, 60, 40, 12, 17]), '공지·프로모션');

  XLSX.writeFile(wb, `할일보드_전체백업_${ymd(now)}.xlsx`);
  try {
    localStorage.setItem(BACKUP_KEY, String(Date.now()));
  } catch { /* 무시 */ }
  return { profiles: profileSheet.length, tasks: taskSheet.length, journals: journalSheet.length };
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
    showToast(`백업 완료: 영업사원 ${r.profiles}명 · 영업일지 ${r.journals}건 · 할일 ${r.tasks}건`);
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
  notes = { notice: '', promo: '' };
  promo = { discounts: {}, until: '' };
  profileName = '';
  setPriceTable(null);
  accessOk = false;
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
    .on('postgres_changes', { event: '*', schema: 'public', table: 'board' }, () => schedulePull())
    // 승인 상태가 바뀌면 바로 반영 (마스터는 새 가입 요청 알림)
    .on('postgres_changes', isMaster()
      ? { event: '*', schema: 'public', table: 'profiles' }
      : { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` },
    () => (isMaster() ? refreshApprovals() : checkAccess()))
    .subscribe();
  if (accessOk) pull();
  checkAccess();
}

// ================= 시작 =================
setActiveCol(activeCol);
let lastView = 'todo';
try {
  lastView = localStorage.getItem('last-view') || 'todo';
} catch { /* 무시 */ }
setView(lastView);
syncCalcInputs();
renderAll();

if (sb) {
  sb.auth.onAuthStateChange((event, session) => {
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
