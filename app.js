'use strict';

const STORAGE_KEY = 'kanban-tasks-v1';
const ARCHIVE_KEY = 'kanban-archive-v1';
const ARCHIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const COLS = ['todo', 'doing', 'done'];
const COL_NAMES = { todo: '할 일', doing: '진행 중', done: '완료' };
const LONG_PRESS_MS = 500;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- 저장소 ----------
let tasks = load(STORAGE_KEY);
let archive = load(ARCHIVE_KEY);
let activeCol = 'todo';

function load(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
  } catch {
    showToast('저장에 실패했어요. 백업을 내보내 주세요.');
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 보관 30일이 지난 아카이브 항목 삭제
function purgeArchive() {
  const limit = Date.now() - ARCHIVE_DAYS * DAY_MS;
  const before = archive.length;
  archive = archive.filter((t) => t.archivedAt > limit);
  if (archive.length !== before) save();
}

// ---------- 조작 ----------
function addTask(text) {
  text = text.trim();
  if (!text) return;
  const task = { id: newId(), text, col: 'todo', createdAt: Date.now(), doneAt: null };
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
}

function moveTask(id, col) {
  const task = tasks.find((t) => t.id === id);
  if (!task || task.col === col) return;
  const prev = { col: task.col, doneAt: task.doneAt, isNew: task.isNew };
  task.col = col;
  task.doneAt = col === 'done' ? Date.now() : null;
  task.isNew = true; // 옮겨간 칸에서 NEW로 표시
  // 이동한 카드를 해당 열 맨 위로
  tasks = [task, ...tasks.filter((t) => t.id !== id)];
  save();
  render();
  vibrate(20);
  showToast(`${COL_NAMES[col]}(으)로 이동`, () => {
    Object.assign(task, prev);
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

function editTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  const text = prompt('할 일 수정', task.text);
  if (text === null || !text.trim()) return;
  task.text = text.trim();
  save();
  render();
}

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
}

function cardEl(task) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = task.id;
  li.dataset.col = task.col;
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
  addTask(input.value);
  input.value = '';
});

$('#clearDoneBtn').addEventListener('click', clearDone);

// ---------- 설정 ----------
const settings = $('#settings');
$('#settingsBtn').addEventListener('click', () => settings.showModal());
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
    text.textContent = t.text;
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

// ---------- 시작 ----------
purgeArchive();
setActiveCol(activeCol);
render();

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
