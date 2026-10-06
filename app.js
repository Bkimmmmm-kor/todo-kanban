'use strict';

// 서버(Supabase) 연결 정보. publishable 키는 공개용이며, 데이터는 DB 보안 규칙(RLS)으로 본인 것만 접근 가능
const SUPABASE_URL = 'https://ggukxzqsvlmfaxefazjc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_j_wtAX2FkiL4CkoB78jA3Q_otkyQPzG';
const APP_URL = location.origin + location.pathname;

// 계정 연결 전(버전 4까지) 이 기기에만 저장하던 데이터
const LEGACY_TASKS_KEY = 'kanban-tasks-v1';
const LEGACY_ARCHIVE_KEY = 'kanban-archive-v1';
const LEGACY_DONE_KEY = 'kanban-legacy-migrated';

const ARCHIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COLS = ['todo', 'doing', 'done'];
const COL_NAMES = { todo: '할 일', doing: '진행 중', done: '완료' };
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
let tasks = [];
let archive = [];
let synced = new Map(); // id → 서버에 저장된 마지막 내용(JSON)
let activeCol = 'todo';

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const toIso = (ms) => (ms ? new Date(ms).toISOString() : null);
const toMs = (iso) => (iso ? Date.parse(iso) : null);

function toRow(t) {
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

function fromRow(r) {
  const t = { id: r.id, text: r.text, col: r.col, createdAt: toMs(r.created_at), movedAt: toMs(r.moved_at), doneAt: toMs(r.done_at) };
  if (r.clinic) t.clinic = r.clinic;
  if (r.due) t.due = r.due;
  if (r.is_new) t.isNew = true;
  if (r.archived_at) t.archivedAt = toMs(r.archived_at);
  return t;
}

const byNewest = (key) => (a, b) => (b[key] || b.createdAt) - (a[key] || a.createdAt);

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
    localStorage.setItem(cacheKey(), JSON.stringify({ tasks, archive, synced: [...synced] }));
  } catch { /* 저장 공간 부족 등: 서버 저장은 계속됨 */ }
}

function loadCache() {
  try {
    const data = JSON.parse(localStorage.getItem(cacheKey()));
    if (!data) return;
    tasks = data.tasks || [];
    archive = data.archive || [];
    synced = new Map(data.synced || []);
  } catch { /* 캐시가 깨졌으면 서버에서 다시 받음 */ }
}

function pendingChanges() {
  const current = new Map([...tasks, ...archive].map((t) => [t.id, JSON.stringify(toRow(t))]));
  const upserts = [...current].filter(([id, json]) => synced.get(id) !== json);
  const deletes = [...synced.keys()].filter((id) => !current.has(id));
  return { upserts, deletes };
}

let pushChain = Promise.resolve(true);
function queuePush() {
  pushChain = pushChain.then(push, push);
  return pushChain;
}

async function push() {
  if (!user || !sb) return false;
  const { upserts, deletes } = pendingChanges();
  if (!upserts.length && !deletes.length) return true;
  setSync('saving');
  try {
    if (upserts.length) {
      const { error } = await sb.from('tasks').upsert(upserts.map(([, json]) => JSON.parse(json)));
      if (error) throw error;
      upserts.forEach(([id, json]) => synced.set(id, json));
    }
    if (deletes.length) {
      const { error } = await sb.from('tasks').delete().in('id', deletes);
      if (error) throw error;
      deletes.forEach((id) => synced.delete(id));
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
    const { data, error } = await sb.from('tasks').select('*');
    if (error) throw error;
    const { upserts, deletes } = pendingChanges();
    if (upserts.length || deletes.length) return; // 받는 사이에 화면에서 바뀜 → 다음 동기화 때 반영
    const rows = data.map(fromRow);
    tasks = rows.filter((t) => !t.archivedAt).sort(byNewest('movedAt'));
    archive = rows.filter((t) => t.archivedAt).sort(byNewest('archivedAt'));
    synced = new Map(data.map((r) => [r.id, JSON.stringify(toRow(fromRow(r)))]));
    saveCache();
    render();
    setSync('ok');
    purgeArchive();
    await offerLegacyMigration();
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

// 계정 연결 전에 이 기기에 저장해 둔 할일을 계정으로 옮기기 (한 번만 물어봄)
async function offerLegacyMigration() {
  if (localStorage.getItem(LEGACY_DONE_KEY)) return;
  const read = (key) => {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const known = new Set([...tasks, ...archive].map((t) => t.id));
  const oldTasks = read(LEGACY_TASKS_KEY).filter((t) => t && t.id && !known.has(t.id));
  const oldArchive = read(LEGACY_ARCHIVE_KEY).filter((t) => t && t.id && !known.has(t.id));
  if (!oldTasks.length && !oldArchive.length) return;
  localStorage.setItem(LEGACY_DONE_KEY, '1');
  const n = oldTasks.length + oldArchive.length;
  if (!confirm(`이 기기에 저장된 할일 ${n}개가 있어요. 내 계정으로 옮길까요?`)) return;
  tasks = [...oldTasks, ...tasks].sort(byNewest('movedAt'));
  archive = [...oldArchive, ...archive].sort(byNewest('archivedAt'));
  purgeArchive();
  render();
  await save();
  showToast(`할일 ${n}개를 계정으로 옮겼어요.`);
}

// 보관 30일이 지난 아카이브 항목 삭제
function purgeArchive() {
  const limit = Date.now() - ARCHIVE_DAYS * DAY_MS;
  const before = archive.length;
  archive = archive.filter((t) => t.archivedAt > limit);
  if (archive.length !== before) {
    render();
    save();
  }
}

// ---------- 조작 ----------
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
  render();
  vibrate(40);
  showToast(`추가됨: ${text}`, () => {
    tasks = tasks.filter((t) => t.id !== task.id);
    save();
    render();
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
  render();
  vibrate(20);
  showToast(`${COL_NAMES[col]}(으)로 이동`, () => {
    Object.assign(task, prev);
    tasks.sort(byNewest('movedAt'));
    save();
    render();
  });
}

function deleteTask(id) {
  const index = tasks.findIndex((t) => t.id === id);
  if (index < 0) return;
  const [removed] = tasks.splice(index, 1);
  save();
  render();
  showToast('삭제됨', () => {
    tasks.splice(index, 0, removed);
    save();
    render();
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

$('#editForm').addEventListener('submit', (e) => {
  const task = tasks.find((t) => t.id === editTaskId);
  const text = $('#editText').value.trim();
  if (!task || !text) return;
  task.text = text;
  const clinic = $('#editClinic').value.trim();
  const due = $('#editDue').value;
  if (clinic) task.clinic = clinic; else delete task.clinic;
  if (due) task.due = due; else delete task.due;
  save();
  render();
});

editDialog.addEventListener('click', (e) => {
  if (e.target === editDialog || e.target.dataset.action === 'close') editDialog.close();
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
  render();
  showToast(`완료 ${done.length}개를 아카이브로 옮김`, () => {
    tasks = prevTasks;
    archive = prevArchive;
    save();
    render();
  });
}

// ---------- 화면 ----------
function formatTime(ms) {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `오늘 ${time}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function render() {
  for (const col of COLS) {
    const list = $(`[data-list="${col}"]`);
    const items = tasks.filter((t) => t.col === col);
    list.replaceChildren(...items.map(cardEl));
    $(`[data-count="${col}"]`).textContent = items.length;
    $(`.tab[data-col="${col}"]`).classList.toggle('has-new', items.some((t) => t.isNew));
  }
  $('#archiveCount').textContent = archive.length ? `(${archive.length})` : '';
  renderClinicList();
}

// 예전에 입력한 치과명을 자동완성 목록으로
function renderClinicList() {
  const names = [...new Set([...tasks, ...archive].map((t) => t.clinic).filter(Boolean))];
  $('#clinicList').replaceChildren(...names.map((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    return opt;
  }));
}

// 납기일 표시: '10/8 (D-2)', 오늘이면 D-day
function dueLabel(due) {
  const [y, m, d] = due.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(y, m - 1, d) - today) / DAY_MS);
  const dday = diff === 0 ? 'D-day' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
  return { text: `납기 ${m}/${d} (${dday})`, diff };
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
      render();
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

// ---------- 카드 메뉴 ----------
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
  if (e.target === cardMenu) return cardMenu.close(); // 바깥 영역 탭
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  cardMenu.close();
  if (action === 'edit') editTask(menuTaskId);
  else if (action === 'delete') deleteTask(menuTaskId);
  else if (COLS.includes(action)) moveTask(menuTaskId, action);
});

// ---------- 탭 / 입력 ----------
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

dueBtn.addEventListener('click', () => {
  try {
    dueInput.showPicker();
  } catch {
    dueInput.focus();
    dueInput.click();
  }
});
dueInput.addEventListener('change', () => setDue(dueInput.value));
$('#dueClear').addEventListener('click', () => setDue(''));

$('#clearDoneBtn').addEventListener('click', clearDone);

// ---------- 설정 ----------
const settings = $('#settings');
$('#settingsBtn').addEventListener('click', () => {
  $('#accountEmail').textContent = user ? `로그인: ${user.email}` : '';
  settings.showModal();
});

$('#logoutBtn').addEventListener('click', async () => {
  const { upserts, deletes } = pendingChanges();
  if ((upserts.length || deletes.length) && !(await queuePush())
    && !confirm('아직 서버에 저장되지 않은 변경이 있어요. 그래도 로그아웃할까요?')) return;
  settings.close();
  await sb.auth.signOut();
});
settings.addEventListener('click', (e) => {
  if (e.target === settings || e.target.dataset.action === 'close') settings.close();
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
  if (e.target === archiveDialog || e.target.dataset.action === 'close') return archiveDialog.close();
  const id = e.target.closest('.archive-list button')?.dataset.id;
  if (!id) return;
  archive = archive.filter((t) => t.id !== id);
  save();
  render();
  renderArchive();
});

$('#archiveClearBtn').addEventListener('click', () => {
  if (!confirm(`아카이브 ${archive.length}개를 모두 삭제할까요? 되돌릴 수 없어요.`)) return;
  archive = [];
  save();
  render();
  renderArchive();
});

// ---------- 백업 ----------
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ tasks, archive }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `할일백업_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
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
    render();
    settings.close();
    showToast('백업을 불러왔어요.');
  } catch {
    showToast('올바른 백업 파일이 아니에요.');
  }
});

// ---------- 로그인 ----------
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
  synced = new Map();
  setSync('');
  authScreen.hidden = !!user;
  if (!user) {
    render();
    return;
  }
  loadCache();
  render();
  // 다른 기기에서 바꾸면 바로 다시 받기
  channel = sb.channel(`tasks-${user.id}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks', filter: `user_id=eq.${user.id}` }, () => schedulePull())
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'tasks' }, () => schedulePull())
    .subscribe();
  pull();
}

// ---------- 시작 ----------
setActiveCol(activeCol);
render();

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
