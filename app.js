'use strict';

const STORAGE_KEY = 'kanban-tasks-v1';
const COLS = ['todo', 'doing', 'done'];
const COL_NAMES = { todo: '할 일', doing: '진행 중', done: '완료' };
const LONG_PRESS_MS = 500;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- 저장소 ----------
let tasks = load();
let activeCol = 'todo';

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {
    showToast('저장에 실패했어요. 백업을 내보내 주세요.');
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
  const prev = { col: task.col, doneAt: task.doneAt };
  task.col = col;
  task.doneAt = col === 'done' ? Date.now() : null;
  // 이동한 카드를 해당 열 맨 위로
  tasks = [task, ...tasks.filter((t) => t.id !== id)];
  save();
  render();
  vibrate(20);
  showToast(`${COL_NAMES[col]}(으)로 이동`, () => {
    task.col = prev.col;
    task.doneAt = prev.doneAt;
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

function clearDone() {
  const done = tasks.filter((t) => t.col === 'done');
  if (!done.length) return;
  const before = tasks.slice();
  tasks = tasks.filter((t) => t.col !== 'done');
  save();
  render();
  showToast(`완료 ${done.length}개 비움`, () => {
    tasks = before;
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
  }
}

function cardEl(task) {
  const li = document.createElement('li');
  li.className = 'card';
  li.dataset.id = task.id;
  li.dataset.col = task.col;
  li.textContent = task.text;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = task.col === 'done' && task.doneAt
    ? `완료 ${formatTime(task.doneAt)}`
    : `등록 ${formatTime(task.createdAt)}`;
  li.append(meta);
  return li;
}

function setActiveCol(col) {
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

// ---------- 음성 입력 ----------
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const overlay = $('#listening');
const interimEl = $('#interim');
let recognition = null;
let finalText = '';
let cancelled = false;

$('#micBtn').addEventListener('click', startListening);
$('#stopListenBtn').addEventListener('click', () => {
  cancelled = true;
  recognition?.abort();
  overlay.hidden = true;
});

function startListening() {
  if (!SpeechRecognition) {
    showToast('이 브라우저는 음성 인식을 지원하지 않아요. 크롬을 사용해 주세요.');
    return;
  }
  recognition = new SpeechRecognition();
  recognition.lang = 'ko-KR';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  finalText = '';
  cancelled = false;
  interimEl.textContent = '듣고 있어요…';
  overlay.hidden = false;
  vibrate(20);

  recognition.onresult = (e) => {
    let interim = '';
    finalText = '';
    for (const result of e.results) {
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    interimEl.textContent = (finalText + interim) || '듣고 있어요…';
  };

  recognition.onerror = (e) => {
    overlay.hidden = true;
    const messages = {
      'not-allowed': '마이크 권한이 필요해요. 브라우저 설정에서 허용해 주세요.',
      'service-not-allowed': '마이크 권한이 필요해요. 브라우저 설정에서 허용해 주세요.',
      'network': '음성 인식은 인터넷 연결이 필요해요.',
      'no-speech': '말소리가 들리지 않았어요. 다시 눌러 주세요.',
    };
    if (e.error !== 'aborted') showToast(messages[e.error] || `음성 인식 오류: ${e.error}`);
  };

  recognition.onend = () => {
    overlay.hidden = true;
    if (!cancelled && finalText.trim()) addTask(finalText);
  };

  try {
    recognition.start();
  } catch {
    overlay.hidden = true;
  }
}

// ---------- 백업 ----------
const settings = $('#settings');
$('#settingsBtn').addEventListener('click', () => settings.showModal());
settings.addEventListener('click', (e) => {
  if (e.target === settings || e.target.dataset.action === 'close') settings.close();
});

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(tasks, null, 2)], { type: 'application/json' });
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
    const valid = Array.isArray(data) && data.every((t) => t && t.id && typeof t.text === 'string' && COLS.includes(t.col));
    if (!valid) throw new Error('invalid');
    if (!confirm(`백업의 할 일 ${data.length}개로 현재 목록(${tasks.length}개)을 바꿀까요?`)) return;
    tasks = data;
    save();
    render();
    settings.close();
    showToast('백업을 불러왔어요.');
  } catch {
    showToast('올바른 백업 파일이 아니에요.');
  }
});

// ---------- 시작 ----------
setActiveCol(activeCol);
render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js');
}
