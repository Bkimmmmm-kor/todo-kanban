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
const VIEWS = { todo: '할일', journal: '영업일지', calc: '계산기' };
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
let tasks = [];
let archive = [];
let journals = [];
let notes = { notice: '', promo: '' }; // 공지 / 프로모션
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
    is_ortho: typeof j.ortho === 'boolean' ? j.ortho : null,
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
    ortho: typeof r.is_ortho === 'boolean' ? r.is_ortho : null,
    temp: r.temperature || '',
    content: r.content || '',
    createdAt: toMs(r.created_at),
  };
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
      tasks, archive, journals, notes, profileName, priceData: priceTable,
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
    journals = data.journals || [];
    notes = data.notes || notes;
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
  if (!user || !sb) return false;
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

// 서버에서 최신 내용 받기 (보내지 못한 변경이 있으면 먼저 보냄)
let pulling = false;
let pullAgain = false;
async function pull() {
  if (!user || !sb) return;
  if (pulling) {
    pullAgain = true; // 받는 중에 또 바뀌었으면 끝난 뒤 한 번 더
    return;
  }
  pulling = true;
  pullAgain = false;
  try {
    if (!(await queuePush())) return;
    const uid = user.id;
    const [taskRes, journalRes, boardRes, priceRes] = await Promise.all([
      // 마스터는 모든 사람 것을 볼 수 있으므로 내 것만 받음
      sb.from('tasks').select('*').eq('user_id', uid),
      sb.from('journals').select('*').eq('user_id', uid),
      sb.from('board').select('kind, body'),
      sb.from('price_table').select('data').maybeSingle(),
    ]);
    for (const res of [taskRes, journalRes, boardRes]) if (res.error) throw res.error;
    if (user?.id !== uid) return; // 받는 사이 로그아웃
    if (hasPending()) return; // 받는 사이에 화면에서 바뀜 → 다음 동기화 때 반영
    for (const [table, data] of [['tasks', taskRes.data], ['journals', journalRes.data]]) {
      const store = stores[table];
      store.apply(data);
      store.synced = new Map(data.map((r) => [r.id, JSON.stringify(store.toRow(store.fromRow(r)))]));
    }
    notes = { notice: '', promo: '' };
    boardRes.data.forEach((r) => (notes[r.kind] = r.body || ''));
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

function renderTasks() {
  for (const col of COLS) {
    const list = $(`[data-list="${col}"]`);
    const items = tasks.filter((t) => t.col === col);
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
  $$('.tab').forEach((tab) => tab.setAttribute('aria-selected', tab.dataset.col === col));
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

$$('.tab').forEach((tab) => tab.addEventListener('click', () => setActiveCol(tab.dataset.col)));

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
    if (typeof j.ortho === 'boolean') head.append(tagEl(j.ortho ? '교정과 O' : '교정과 X'));
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
bindSeg($('#jOrtho'));
bindSeg($('#jTemp'));

function openJournal(id = null) {
  const j = journals.find((x) => x.id === id);
  editJournalId = j ? j.id : null;
  $('#journalDialogTitle').textContent = j ? '영업일지 수정' : '영업일지 작성';
  $('#jDate').value = j ? j.date : ymd(new Date());
  $('#jRegion').value = j?.region || '';
  $('#jClinic').value = j?.clinic || '';
  setSeg($('#jOrtho'), j && typeof j.ortho === 'boolean' ? j.ortho : '');
  setSeg($('#jTemp'), j?.temp || '');
  $('#jContent').value = j?.content || '';
  $('#jDeleteBtn').hidden = !j;
  journalDialog.showModal();
}

$('#newJournalBtn').addEventListener('click', () => openJournal());
$('#journalList').addEventListener('click', (e) => {
  const item = e.target.closest('.journal-item');
  if (item) openJournal(item.dataset.id);
});

$('#journalForm').addEventListener('submit', (e) => {
  const ortho = segValue($('#jOrtho'));
  const data = {
    date: $('#jDate').value || ymd(new Date()),
    region: $('#jRegion').value.trim(),
    clinic: $('#jClinic').value.trim(),
    ortho: ortho === '' ? null : ortho === 'true',
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
  if (q.key !== 'unit') card.append(el('p', 'quote-meta', `보증 ${q.warranty} · 리파인먼트 ${q.refinement}`));
  return card;
}

let lastQuoteText = '';

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
  const q = realignerQuote(calc.grade, calc.upper, calc.lower);
  $('#calcCopyBtn').hidden = !q;
  if (!q) {
    out.replaceChildren(el('p', 'calc-empty', '상악·하악 stage를 입력하면 청구액이 나와요.'));
    lastQuoteText = '';
    return;
  }
  const stages = q.arches.map(([label, n]) => `${label} ${n}`).join(' · ');
  const basis = q.single
    ? `${stages} stage · 편악 진행 (패키지가 60%)`
    : `${stages} stage → 큰 쪽 ${q.maxStage} stage 기준`;
  const nodes = [el('p', 'quote-basis', `${q.grade} · ${basis}`)];
  const lines = [`[리얼라이너 수가 안내] ${q.grade} 등급`];
  if (calc.name.trim()) lines.push(`환자: ${calc.name.trim()}`);
  lines.push(stages.replaceAll(' · ', ' / ') + ' stage' + (q.single ? ' (편악)' : ''));

  if (q.choices) {
    nodes.push(el('p', 'quote-basis', '40 stage 이상: 아래 두 패키지 중 선택 (추가 비용 없음)'));
    q.choices.forEach((c, i) => nodes.push(quoteCard(c, i > 0)));
    q.choices.forEach((c) => lines.push(`· ${c.name}: ${won(c.price)}원 (보증 ${c.warranty})`));
  } else {
    nodes.push(quoteCard(q.main));
    lines.push(`· ${q.main.name}: ${won(q.main.price)}원`);
    lines.push(`  (${q.main.formula})`);
  }

  const alt = q.alternative;
  if (alt) {
    const tip = el('div', 'quote-tip');
    const benefit = alt.key === 'unit' ? '' : ` · 보증 ${alt.warranty}, 리파인먼트 ${alt.refinement}`;
    tip.append('💡 ', el('strong', '', `${alt.name}`), ` 적용 시 ${won(alt.price)}원 — `,
      el('strong', '', `${won(alt.saving)}원 절감`), benefit);
    nodes.push(tip, quoteCard(alt, true));
    lines.push(`· 추천 ${alt.name}: ${won(alt.price)}원 (${won(alt.saving)}원 절감${benefit})`);
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

// ================= 공지 / 프로모션 =================
const NOTE_LABELS = { notice: '공지', promo: '프로모션' };

function renderNotes() {
  $$('.board-note').forEach((el) => {
    const kind = el.dataset.kind;
    const body = notes[kind] || '';
    const masterEmpty = !body && isMaster();
    el.hidden = !body && !masterEmpty;
    el.classList.toggle('empty-master', masterEmpty);
    el.querySelector('.note-body').textContent = body || `${NOTE_LABELS[kind]} 작성하기 (마스터)`;
  });
}

const noteDialog = $('#noteDialog');
let noteKind = 'notice';

function openNoteEditor(kind) {
  noteKind = kind;
  $('#noteDialogTitle').textContent = `${NOTE_LABELS[kind]} 작성`;
  $('#noteText').value = notes[kind] || '';
  noteDialog.showModal();
}

$$('.board-note').forEach((el) => el.addEventListener('click', () => {
  if (isMaster()) openNoteEditor(el.dataset.kind);
  else el.classList.toggle('expanded');
}));

$('#noteForm').addEventListener('submit', async () => {
  const kind = noteKind;
  const body = $('#noteText').value.trim();
  const prev = notes[kind];
  notes[kind] = body;
  renderNotes();
  const { error } = await sb.from('board').upsert({ kind, body });
  if (error) {
    notes[kind] = prev;
    renderNotes();
    showToast(`${NOTE_LABELS[kind]}을(를) 저장하지 못했어요: ${error.message}`);
    return;
  }
  saveCache();
  showToast(body ? `${NOTE_LABELS[kind]}을(를) 올렸어요.` : `${NOTE_LABELS[kind]}을(를) 내렸어요.`);
});

// ================= 설정 =================
const settings = $('#settings');
$('#settingsBtn').addEventListener('click', () => {
  $('#accountEmail').textContent = user ? `로그인: ${user.email}${isMaster() ? ' (마스터)' : ''}` : '';
  $('#nameLabel').textContent = profileName ? `(${profileName})` : '';
  $('#masterTools').hidden = !isMaster();
  settings.showModal();
});

$('#logoutBtn').addEventListener('click', async () => {
  if (hasPending() && !(await queuePush())
    && !confirm('아직 서버에 저장되지 않은 변경이 있어요. 그래도 로그아웃할까요?')) return;
  settings.close();
  await sb.auth.signOut();
});

// 이름 (주간 보고서에 표시)
async function loadProfile() {
  const uid = user.id;
  const { data, error } = await sb.from('profiles').select('name').eq('id', uid).maybeSingle();
  if (error || user?.id !== uid) return;
  if (data?.name) {
    profileName = data.name;
    saveCache();
  } else {
    await askName(true);
  }
}

async function askName(first = false) {
  const name = prompt(first
    ? '처음 오셨네요! 이름을 입력해 주세요.\n(주간 보고서에 표시돼요)'
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

  const [XLSX, profRes, taskRes, journalRes] = await Promise.all([
    loadXlsx(),
    sb.from('profiles').select('id, name, email'),
    sb.from('tasks').select('*')
      .or(`and(created_at.gte.${s},created_at.lt.${e}),and(done_at.gte.${s},done_at.lt.${e})`)
      .order('created_at'),
    sb.from('journals').select('*').gte('visit_date', mondayStr).lt('visit_date', ymd(end))
      .order('visit_date').order('created_at'),
  ]);
  for (const res of [profRes, taskRes, journalRes]) if (res.error) throw res.error;

  const names = new Map(profRes.data.map((p) => [p.id, p.name || p.email || '']));
  const who = (id) => names.get(id) || '(이름 없음)';
  const inWeek = (iso) => iso && iso >= s && iso < e;

  // 영업사원별 요약
  const summary = new Map();
  const sum = (id) => {
    if (!summary.has(id)) summary.set(id, { 등록: 0, 완료: 0, 일지: 0, 상: 0, 중: 0, 하: 0 });
    return summary.get(id);
  };
  taskRes.data.forEach((t) => {
    if (inWeek(t.created_at)) sum(t.user_id).등록++;
    if (inWeek(t.done_at)) sum(t.user_id).완료++;
  });
  journalRes.data.forEach((j) => {
    const row = sum(j.user_id);
    row.일지++;
    if (j.temperature) row[j.temperature]++;
  });

  const summaryRows = [...summary].map(([id, v]) => ({
    영업사원: who(id), '할일 등록': v.등록, '할일 완료': v.완료, 영업일지: v.일지,
    '감도 상': v.상, '감도 중': v.중, '감도 하': v.하,
  })).sort((a, b) => a.영업사원.localeCompare(b.영업사원, 'ko'));

  const taskRows = taskRes.data.map((t) => ({
    영업사원: who(t.user_id),
    치과명: t.clinic || '',
    내용: t.text,
    상태: COL_NAMES[t.col] || t.col,
    납기일: t.due || '',
    등록일시: fmtDateTime(t.created_at),
    완료일시: fmtDateTime(t.done_at),
  })).sort((a, b) => a.영업사원.localeCompare(b.영업사원, 'ko'));

  const journalRows = journalRes.data.map((j) => ({
    영업사원: who(j.user_id),
    방문일: j.visit_date,
    요일: WEEKDAYS[parseYmd(j.visit_date).getDay()],
    지역: j.region || '',
    치과명: j.clinic || '',
    교정과: j.is_ortho === true ? 'O' : j.is_ortho === false ? 'X' : '',
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
    ['영업사원', '할일 등록', '할일 완료', '영업일지', '감도 상', '감도 중', '감도 하'],
    [14, 10, 10, 10, 8, 8, 8]), '요약');
  XLSX.utils.book_append_sheet(wb, sheet(journalRows,
    ['영업사원', '방문일', '요일', '지역', '치과명', '교정과', '감도', '내용'],
    [12, 12, 6, 12, 20, 8, 6, 60]), '영업일지');
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
  profileName = '';
  setPriceTable(null);
  Object.values(stores).forEach((s) => (s.synced = new Map()));
  setSync('');
  authScreen.hidden = !!user;
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
    .subscribe();
  pull().then(() => user && loadProfile());
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
