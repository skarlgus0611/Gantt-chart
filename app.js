/* =========================================================
 * 간트차트 app.js  (v3)
 *
 * 이전 버전 대비 바뀐 점
 *  - 좌우 행 높이를 CSS 고정 높이로 맞춤 (JS 높이 동기화 제거)
 *  - 주 헤더 · 배경선 · 막대 · 오늘 선이 모두 같은 '하루 너비' 기준
 *  - 순서 변경: 카드 왼쪽 손잡이(⋮⋮)를 끌어서 이동 (마우스/터치 공통)
 *    카테고리와 상관없이 옮길 수 있고, 놓은 자리의 카테고리로 바뀜
 *  - 막대 글자색 자동 대비, 진행률은 어두운 반투명으로 표시
 *  - 작업이 없는 카테고리도 표시, 카테고리 이름/색 수정 가능
 *  - 저장 중 버튼 잠금 + 상단 알림(토스트), 중복 제출 방지
 *  - 상세창이 열리면 화면으로 스크롤, 처음 열면 오늘 위치로 스크롤
 *  - 새 작업은 색을 따로 고르지 않으면 카테고리 기본색을 따름
 *  - 월별 뒷배경 색(흰색/옅은 회백색) 번갈아 표시
 * ========================================================= */

const API_URL =
  "https://script.google.com/macros/s/AKfycbx33KL-l94mz08Q8rWJHYrGUXyipmxrm02z3Y26OR20V9q5V2diZRFIzvyFpqio-0Jg8Q/exec";

const DEFAULT_COLOR = "#3b82f6";


/* =========================================================
 * STATE
 * ========================================================= */

let state = {
  tasks: [],
  categories: [],

  // 화면은 항상 한 개 연도만 표시한다.
  year: new Date().getFullYear(),

  // 선택 연도 내부에서만 확대/축소
  rangeStart: 0,
  rangeEnd: 364,

  selectedTask: null,
  draggingTaskId: null,

  // 다음 렌더링 뒤에 '오늘' 위치로 가로 스크롤할지
  scrollToToday: true
};


/* =========================================================
 * API
 *
 * - 편집 키는 처음 접속할 때 입력받아 이 기기의 브라우저
 *   (localStorage)에만 저장한다.
 * - 모든 요청은 POST 다. (키가 주소에 남지 않는다)
 * ========================================================= */

const KEY_STORAGE = "gantt_edit_key";

let editKey = "";

try {
  editKey = localStorage.getItem(KEY_STORAGE) || "";
} catch (error) {
  // 저장소를 못 쓰는 환경이면 접속할 때마다 입력받는다.
}


function askKey(message) {
  const input = prompt(message || "편집 키를 입력하세요");

  if (!input || !input.trim()) {
    return "";
  }

  editKey = input.trim();

  try {
    localStorage.setItem(KEY_STORAGE, editKey);
  } catch (error) {
    // 무시
  }

  return editKey;
}


function clearKey() {
  editKey = "";

  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch (error) {
    // 무시
  }
}


async function request(action, data = {}, retried = false) {

  if (!editKey && !askKey()) {
    throw new Error("편집 키가 필요합니다.");
  }

  let response;

  try {
    response = await fetch(API_URL, {
      method: "POST",

      // text/plain 이어야 브라우저가 사전 요청(preflight)을 보내지 않는다.
      headers: {
        "Content-Type": "text/plain;charset=utf-8"
      },

      body: JSON.stringify({
        action,
        key: editKey,
        ...data
      })
    });
  } catch (error) {
    throw new Error("서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
  }

  let result;

  try {
    result = await response.json();
  } catch (error) {
    throw new Error(
      "서버 응답을 읽을 수 없습니다. " +
      "배포 주소와 접근 권한(모든 사용자)을 확인하세요."
    );
  }

  if (!result.ok) {

    // 키가 틀리면 한 번만 다시 입력받는다.
    if (result.error === "Forbidden" && !retried) {
      clearKey();

      if (askKey("편집 키가 올바르지 않습니다. 다시 입력하세요")) {
        return request(action, data, true);
      }
    }

    throw new Error(result.error || "요청 실패");
  }

  return result;
}


async function apiGet() {
  const result = await request("load");

  return result.data;
}


async function apiPost(action, data = {}) {
  return request(action, data);
}


/* =========================================================
 * TOAST / BUSY
 * ========================================================= */

let toastTimer = null;


function showToast(message, isError = false, duration = 2500) {

  const toast = document.getElementById("toast");

  if (!toast) {
    return;
  }

  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");

  clearTimeout(toastTimer);

  if (duration > 0) {
    toastTimer = setTimeout(() => {
      toast.classList.add("hidden");
    }, duration);
  }
}


function hideToast() {

  const toast = document.getElementById("toast");

  clearTimeout(toastTimer);

  if (toast) {
    toast.classList.add("hidden");
  }
}


/* 버튼을 잠근 채로 작업을 실행한다. (이미 처리 중이면 무시 -> 중복 제출 방지) */
async function withBusy(button, label, task) {

  if (button && button.disabled) {
    return;
  }

  const original = button ? button.textContent : "";

  if (button) {
    button.disabled = true;

    if (label) {
      button.textContent = label;
    }
  }

  try {
    return await task();
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}


/* =========================================================
 * DATA LOAD
 * ========================================================= */

async function loadData(showProgress = true) {

  const reloadButton = document.getElementById("reloadBtn");

  if (reloadButton) {
    reloadButton.disabled = true;
  }

  if (showProgress) {
    showToast("불러오는 중…", false, 0);
  }

  try {
    const data = await apiGet();

    state.tasks =
      Array.isArray(data.tasks) ? data.tasks : [];

    state.categories =
      Array.isArray(data.categories) ? data.categories : [];

    render();

    if (showProgress) {
      hideToast();
    }

  } catch (error) {
    console.error(error);

    hideToast();

    alert(
      "데이터를 불러오지 못했습니다.\n" +
      error.message
    );

  } finally {
    if (reloadButton) {
      reloadButton.disabled = false;
    }
  }
}


/* =========================================================
 * DATE
 * ========================================================= */

function dateObj(value) {
  if (!value) return null;

  const [y, m, d] =
    String(value).split("-").map(Number);

  return new Date(y, m - 1, d);
}


function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}


function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 1);

  return Math.floor(
    (date.getTime() - start.getTime()) / 86400000
  );
}


function daysInYear(year) {
  return (
    new Date(year + 1, 0, 1).getTime() -
    new Date(year, 0, 1).getTime()
  ) / 86400000;
}


/* 선택된 연도의 1월 1일 */
function getYearStart() {
  return new Date(state.year, 0, 1);
}


/* 선택된 연도의 12월 31일 */
function getYearEnd() {
  return new Date(state.year, 11, 31);
}


/* 선택된 연도 1월 1일부터 몇 번째 날인지 */
function dayOffsetFromYearStart(date) {
  const start = getYearStart();

  return Math.floor(
    (date.getTime() - start.getTime()) / 86400000
  );
}


/* 선택 연도의 n번째 날(0부터) -> Date */
function dateFromYearDay(day) {
  const date = new Date(state.year, 0, 1);

  date.setDate(date.getDate() + day);

  return date;
}


/* =========================================================
 * COLOR
 * ========================================================= */

function validHex(value) {
  const text = String(value || "").trim();

  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : "";
}


/* 밝은 색이면 흰 글자의 대비가 부족하므로 어두운 글자를 쓴다. */
function isLightColor(hex) {

  const color = validHex(hex);

  if (!color) {
    return false;
  }

  const n = parseInt(color.slice(1), 16);

  const channel = value => {
    const c = value / 255;

    return c <= 0.03928
      ? c / 12.92
      : Math.pow((c + 0.055) / 1.055, 2.4);
  };

  const luminance =
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255);

  // 흰 글자 대비가 3:1 미만이면 밝은 색으로 본다.
  return 1.05 / (luminance + 0.05) < 3;
}


/* =========================================================
 * RENDER
 * ========================================================= */

function render() {

  const yearTitle = document.getElementById("yearTitle");

  if (yearTitle) {
    yearTitle.textContent = state.year;
  }

  renderTaskColumn();
  renderTimeline();
  updateRangeLabel();

  if (state.scrollToToday) {
    state.scrollToToday = false;
    scrollTimelineToToday();
  }
}


/* 오늘이 보이도록 가로 스크롤 */
function scrollTimelineToToday() {

  const timeline = document.getElementById("timeline");

  const inner =
    timeline && timeline.querySelector(".timeline-inner");

  if (!timeline || !inner) {
    return;
  }

  const today = new Date();

  if (today.getFullYear() !== state.year) {
    return;
  }

  const day = dayOfYear(today);

  if (day < state.rangeStart || day > state.rangeEnd) {
    return;
  }

  const visibleDays = state.rangeEnd - state.rangeStart + 1;

  const dayWidth =
    (parseFloat(inner.style.width) || 0) / visibleDays;

  const x = (day - state.rangeStart) * dayWidth;

  timeline.scrollLeft =
    Math.max(0, x - timeline.clientWidth / 3);
}


/* =========================================================
 * TASK / CATEGORY GROUP
 *
 * 1. 선택한 연도에 걸쳐 있는 작업만 표시
 *    (시작일 <= 선택연도 12/31 && 종료일 >= 선택연도 1/1)
 * 2. 전년도부터 이어진 작업은 카테고리 안에서 가장 위
 * 3. 그런 작업이 있는 카테고리도 가장 위
 * 4. 다른 연도에만 작업이 있는 카테고리는 숨김
 * 5. 작업이 아예 없는 카테고리는 표시 (추가/수정/삭제할 수 있도록)
 * 6. 삭제된 카테고리의 작업은 "기타"
 * ========================================================= */

function groupTasks() {

  const yearStart = `${state.year}-01-01`;
  const yearEnd = `${state.year}-12-31`;

  const visibleTasks =
    state.tasks.filter(task => {

      if (!task.start || !task.end) {
        return false;
      }

      return (
        task.start <= yearEnd &&
        task.end >= yearStart
      );
    });


  /* 전체 작업 중 하나라도 속해 있는 카테고리 */
  const usedCategoryIds =
    new Set(state.tasks.map(task => task.categoryId));


  /* 전년도부터 현재 연도로 넘어온 작업 */
  function isContinuing(task) {
    return (
      task.start < yearStart &&
      task.end >= yearStart
    );
  }


  function sortContinuingFirst(groups) {
    groups.sort((a, b) => {

      if (a.hasContinuing !== b.hasContinuing) {
        return a.hasContinuing ? -1 : 1;
      }

      return 0;
    });
  }


  const groups = [];


  state.categories.forEach(category => {

    const tasks =
      visibleTasks.filter(
        task => task.categoryId === category.id
      );

    if (!tasks.length) {

      /* 작업이 아예 없는 카테고리만 빈 상태로 보여 준다. */
      if (!usedCategoryIds.has(category.id)) {
        groups.push({
          id: category.id,
          name: category.name,
          color: category.color,
          tasks: [],
          hasContinuing: false,
          empty: true
        });
      }

      return;
    }

    const continuing = tasks.filter(isContinuing);
    const newTasks = tasks.filter(task => !isContinuing(task));

    groups.push({
      id: category.id,
      name: category.name,
      color: category.color,
      tasks: [...continuing, ...newTasks],
      hasContinuing: continuing.length > 0,
      empty: false
    });
  });


  sortContinuingFirst(groups);


  /* 카테고리가 삭제된 작업 -> 기타 */
  const uncategorized =
    visibleTasks.filter(
      task =>
        !state.categories.some(
          category => category.id === task.categoryId
        )
    );


  if (uncategorized.length) {

    const continuing = uncategorized.filter(isContinuing);
    const newTasks = uncategorized.filter(task => !isContinuing(task));

    groups.push({
      id: "",
      name: "기타",
      color: "",
      tasks: [...continuing, ...newTasks],
      hasContinuing: continuing.length > 0,
      empty: false
    });

    /* 기타도 이어진 작업이 있으면 최상단으로 */
    sortContinuingFirst(groups);
  }


  return groups;
}


/* =========================================================
 * LEFT TASK COLUMN
 * ========================================================= */

function renderTaskColumn() {

  const column = document.getElementById("taskColumn");

  if (!column) {
    return;
  }

  column.innerHTML = "";


  /* Header */
  const header = document.createElement("div");

  header.className = "task-header";
  header.textContent = "작업";

  column.appendChild(header);


  groupTasks().forEach(group => {

    /* Category row */
    const category = document.createElement("div");

    category.className = "category-label";
    category.dataset.group = group.id;


    if (group.id) {

      const dot = document.createElement("span");

      dot.className = "cat-dot";
      dot.style.background = validHex(group.color) || DEFAULT_COLOR;

      category.appendChild(dot);
    }


    const name = document.createElement("span");

    name.className = "category-label-name";
    name.textContent = group.name;

    /* 실제 카테고리는 이름을 눌러 이름/색을 수정한다. */
    if (group.id) {

      name.title = "눌러서 이름·색 수정";
      name.tabIndex = 0;
      name.setAttribute("role", "button");

      name.addEventListener("click", () => {
        openCategoryModal(group.id);
      });

      name.addEventListener("keydown", event => {

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openCategoryModal(group.id);
        }
      });
    }

    category.appendChild(name);


    if (group.empty) {

      const note = document.createElement("span");

      note.className = "category-empty";
      note.textContent = "작업 없음";

      category.appendChild(note);
    }


    /* "기타"는 실제 카테고리가 아니므로 삭제 버튼을 만들지 않는다. */
    if (group.id) {

      const deleteButton = document.createElement("button");

      deleteButton.type = "button";
      deleteButton.className = "category-delete-btn";
      deleteButton.textContent = "×";
      deleteButton.title = "카테고리 삭제";

      deleteButton.setAttribute(
        "aria-label",
        group.name + " 카테고리 삭제"
      );

      deleteButton.addEventListener("click", event => {

        event.preventDefault();
        event.stopPropagation();

        deleteCategory(group.id, group.name);
      });

      category.appendChild(deleteButton);
    }

    column.appendChild(category);


    /* Tasks */
    group.tasks.forEach(task => {

      const card = document.createElement("div");

      card.className =
        "task-card" +
        (state.draggingTaskId === task.id ? " dragging" : "");

      card.dataset.id = task.id;
      card.dataset.group = group.id;

      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", task.name + " 상세 보기");

      card.innerHTML = `
        <span
          class="drag-handle"
          title="끌어서 순서 변경"
          aria-hidden="true"
        >⋮⋮</span>

        <div class="task-name">
          ${escapeHtml(task.name)}
        </div>
      `;

      card.addEventListener("click", event => {

        if (
          state.draggingTaskId ||
          event.target.closest(".drag-handle")
        ) {
          return;
        }

        showTaskDetail(task.id);
      });

      card.addEventListener("keydown", event => {

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          showTaskDetail(task.id);
        }
      });

      column.appendChild(card);
    });
  });
}


/* =========================================================
 * TIMELINE
 *
 * 폭 = max(화면 폭, 표시 일수 x 8px)
 * 하루 너비(dayWidth) = 폭 / 표시 일수
 * 주 헤더, 배경선, 막대, 오늘 선 모두 이 하루 너비를 기준으로 한다.
 * ========================================================= */

function renderTimeline() {

  const timeline = document.getElementById("timeline");

  if (!timeline) {
    return;
  }

  timeline.innerHTML = "";


  const inner = document.createElement("div");

  inner.className = "timeline-inner";


  /* 화면은 반드시 선택된 한 해만 사용 */
  const totalDays = daysInYear(state.year);


  /* range 역시 선택 연도 안에서만 움직인다. */
  state.rangeStart =
    Math.max(0, Math.min(state.rangeStart, totalDays - 1));

  state.rangeEnd =
    Math.max(
      state.rangeStart,
      Math.min(state.rangeEnd, totalDays - 1)
    );


  const visibleDays = state.rangeEnd - state.rangeStart + 1;

  const width =
    Math.max(timeline.clientWidth || 900, visibleDays * 8);

  const dayWidth = width / visibleDays;

  inner.style.width = width + "px";

  inner.style.setProperty("--week-width", (dayWidth * 7) + "px");


  /* 주 헤더 */
  renderWeekHeader(inner, visibleDays, dayWidth);


  /* 월별 뒷배경 (흰색 / 옅은 회백색 번갈아) */
  renderMonthBands(inner, dayWidth);


  /* Category + Task rows */
  groupTasks().forEach(group => {

    const categoryRow = document.createElement("div");

    categoryRow.className = "timeline-category";

    inner.appendChild(categoryRow);


    group.tasks.forEach(task => {

      const row = document.createElement("div");

      row.className = "timeline-task-row";
      row.dataset.id = task.id;

      renderTaskBar(row, task, totalDays, visibleDays);

      inner.appendChild(row);
    });
  });


  /* 오늘 선 */
  renderTodayLine(inner, totalDays, visibleDays, width);

  timeline.appendChild(inner);
}


/* =========================================================
 * MONTH BANDS
 *
 * 월 단위로 뒷배경 색을 번갈아 칠한다.
 *   1월 흰색 / 2월 옅은 회백색 / 3월 흰색 / 4월 옅은 회백색 ...
 * 확대해서 일부 기간만 보고 있어도 달마다 색은 그대로다.
 * ========================================================= */

function renderMonthBands(inner, dayWidth) {

  const layer = document.createElement("div");

  layer.className = "month-bands";

  const yearStart = getYearStart();

  /* 자정 기준 날짜끼리의 차이이므로 반올림해서 하루 단위로 센다. */
  const dayIndex = date =>
    Math.round((date.getTime() - yearStart.getTime()) / 86400000);

  for (let month = 0; month < 12; month++) {

    const first = dayIndex(new Date(state.year, month, 1));

    const last = dayIndex(new Date(state.year, month + 1, 0));

    /* 지금 보이는 기간과 겹치는 부분만 그린다. */
    const from = Math.max(first, state.rangeStart);
    const to = Math.min(last, state.rangeEnd);

    if (from > to) {
      continue;
    }

    const band = document.createElement("div");

    band.className =
      "month-band" + (month % 2 === 1 ? " alt" : "");

    band.style.left =
      ((from - state.rangeStart) * dayWidth) + "px";

    band.style.width =
      ((to - from + 1) * dayWidth) + "px";

    layer.appendChild(band);
  }

  inner.appendChild(layer);
}


/* =========================================================
 * WEEK HEADER
 *
 * 표시 범위의 첫 날부터 7일씩 끊고, 각 칸의 너비를
 * (칸의 일수 x 하루 너비)로 정확히 정한다.
 * ========================================================= */

function renderWeekHeader(inner, visibleDays, dayWidth) {

  const header = document.createElement("div");

  header.className = "week-header";

  const columns = [];


  for (let offset = 0; offset < visibleDays; offset += 7) {

    const days = Math.min(7, visibleDays - offset);

    const date = dateFromYearDay(state.rangeStart + offset);

    const end = dateFromYearDay(state.rangeStart + offset + days - 1);

    const cell = document.createElement("div");

    cell.className = "week-cell";
    cell.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
    cell.title = `${dateKey(date)} ~ ${dateKey(end)}`;

    header.appendChild(cell);

    columns.push((days * dayWidth) + "px");
  }

  header.style.gridTemplateColumns = columns.join(" ");

  inner.appendChild(header);
}


/* =========================================================
 * TASK BAR
 *
 * 날짜가 여러 해에 걸쳐 있어도 현재 선택한 연도에 맞춰
 * 잘라서 표시한다.
 * ========================================================= */

function renderTaskBar(
  row,
  task,
  totalDays,
  visibleDays
) {

  if (!task.start || !task.end) {
    return;
  }

  const start = dateObj(task.start);
  const end = dateObj(task.end);

  if (!start || !end) {
    return;
  }

  const yearStart = getYearStart();
  const yearEnd = getYearEnd();

  /* 현재 연도와 전혀 겹치지 않으면 표시하지 않는다. */
  if (end < yearStart || start > yearEnd) {
    return;
  }

  /* 현재 연도 안에서 잘라낸다. */
  const visibleStartDate = start < yearStart ? yearStart : start;
  const visibleEndDate = end > yearEnd ? yearEnd : end;

  let startDay = dayOffsetFromYearStart(visibleStartDate);
  let endDay = dayOffsetFromYearStart(visibleEndDate);

  /* 현재 확대 범위 안에서 다시 잘라낸다. */
  if (
    endDay < state.rangeStart ||
    startDay > state.rangeEnd
  ) {
    return;
  }

  startDay = Math.max(startDay, state.rangeStart);
  endDay = Math.min(endDay, state.rangeEnd);

  const left =
    (startDay - state.rangeStart) / visibleDays * 100;

  const width =
    (endDay - startDay + 1) / visibleDays * 100;

  const bar = document.createElement("div");

  bar.className = "task-bar";

  const color = validHex(task.color) || DEFAULT_COLOR;

  if (isLightColor(color)) {
    bar.classList.add("light");
  }

  bar.style.left = left + "%";
  bar.style.width = width + "%";
  bar.style.background = color;

  bar.title =
    `${task.name}\n${task.start} ~ ${task.end}`;

  const progress =
    Math.max(0, Math.min(100, Number(task.progress) || 0));

  bar.innerHTML = `
    <div
      class="task-progress"
      style="width:${progress}%"
    ></div>

    <div class="task-bar-text">
      ${escapeHtml(task.name)}
      &nbsp;
      ${progress}%
    </div>
  `;

  bar.addEventListener("click", event => {

    event.stopPropagation();

    showTaskDetail(task.id);
  });

  row.appendChild(bar);
}


/* =========================================================
 * TODAY LINE
 * ========================================================= */

function renderTodayLine(
  inner,
  totalDays,
  visibleDays,
  width
) {

  const today = new Date();

  /* 현재 선택한 연도와 다르면 오늘 선을 그리지 않는다. */
  if (today.getFullYear() !== state.year) {
    return;
  }

  const todayDay = dayOfYear(today);

  if (
    todayDay < state.rangeStart ||
    todayDay > state.rangeEnd
  ) {
    return;
  }

  const line = document.createElement("div");

  line.className = "today-line";

  line.style.left =
    ((todayDay - state.rangeStart) / visibleDays * 100) + "%";

  inner.appendChild(line);
}


/* =========================================================
 * TASK DETAIL
 * ========================================================= */

function showTaskDetail(id) {

  const task = state.tasks.find(item => item.id === id);

  if (!task) {
    return;
  }

  state.selectedTask = id;

  const panel = document.getElementById("detailPanel");

  if (!panel) {
    return;
  }

  panel.classList.remove("hidden");

  /* 색을 바꾸지 않으면 서버에 색을 보내지 않는다. (기본색 따르기 유지) */
  panel.dataset.originalColor = validHex(task.color);


  /* 카테고리가 삭제된 작업도 상세창에서 "기타"로 볼 수 있게 한다. */
  const categoryOptions = [

    `<option value="">기타</option>`,

    ...state.categories.map(
      category => `
        <option
          value="${escapeAttr(category.id)}"
          ${category.id === task.categoryId ? "selected" : ""}
        >
          ${escapeHtml(category.name)}
        </option>
      `
    )

  ].join("");


  panel.innerHTML = `

    <div class="detail-title">

      <h2>${escapeHtml(task.name)}</h2>

      <button
        id="closeDetail"
        type="button"
        aria-label="닫기"
      >×</button>

    </div>


    <div class="detail-grid">

      <div class="detail-item">
        <span>작업명</span>
        <input id="detailName" value="${escapeAttr(task.name)}">
      </div>

      <div class="detail-item">
        <span>카테고리</span>
        <select id="detailCategory">${categoryOptions}</select>
      </div>

      <div class="detail-item">
        <span>시작일</span>
        <input id="detailStart" type="date" value="${escapeAttr(task.start)}">
      </div>

      <div class="detail-item">
        <span>종료일</span>
        <input id="detailEnd" type="date" value="${escapeAttr(task.end)}">
      </div>

      <div class="detail-item">
        <span>진행률</span>
        <input
          id="detailProgress"
          type="number"
          min="0"
          max="100"
          value="${Number(task.progress) || 0}"
        >
      </div>

      <div class="detail-item">
        <span>막대 색상</span>
        <input
          id="detailColor"
          type="color"
          value="${escapeAttr(validHex(task.color) || DEFAULT_COLOR)}"
        >
      </div>

      <div class="detail-item">
        <span>대상처</span>
        <input id="detailTarget" value="${escapeAttr(task.target)}">
      </div>

      <div class="detail-item">
        <span>담당자</span>
        <input id="detailOwner" value="${escapeAttr(task.owner)}">
      </div>

    </div>


    <div class="detail-memo">
      <span>메모</span>
      <textarea id="detailMemo">${escapeHtml(task.memo)}</textarea>
    </div>


    <div class="detail-actions">

      <button id="deleteTaskBtn" type="button">삭제</button>

      <button id="saveDetailBtn" class="primary" type="button">저장</button>

    </div>

  `;


  const closeButton = document.getElementById("closeDetail");

  if (closeButton) {
    closeButton.onclick = () => {
      panel.classList.add("hidden");
    };
  }

  const saveButton = document.getElementById("saveDetailBtn");

  if (saveButton) {
    saveButton.onclick = () => saveTaskDetail(task.id);
  }

  const deleteButton = document.getElementById("deleteTaskBtn");

  if (deleteButton) {
    deleteButton.onclick = () => deleteTask(task.id);
  }

  /* 화면 아래쪽에 열리므로 보이는 위치로 스크롤한다. */
  if (typeof panel.scrollIntoView === "function") {
    panel.scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  }
}


/* =========================================================
 * SAVE TASK DETAIL
 * ========================================================= */

async function saveTaskDetail(id) {

  const panel = document.getElementById("detailPanel");

  const button = document.getElementById("saveDetailBtn");

  const data = {

    id,

    name: document.getElementById("detailName").value.trim(),

    categoryId: document.getElementById("detailCategory").value,

    start: document.getElementById("detailStart").value,

    end: document.getElementById("detailEnd").value,

    progress: document.getElementById("detailProgress").value,

    memo: document.getElementById("detailMemo").value,

    target: document.getElementById("detailTarget").value,

    owner: document.getElementById("detailOwner").value
  };


  /* 색을 바꿨을 때만 보낸다. */
  const color = document.getElementById("detailColor").value;

  if (
    color.toLowerCase() !==
    ((panel && panel.dataset.originalColor) || "")
  ) {
    data.color = color;
  }


  if (!data.name) {
    alert("작업명을 입력해주세요.");
    return;
  }

  if (!data.start || !data.end) {
    alert("시작일과 종료일을 입력해주세요.");
    return;
  }

  if (data.start > data.end) {
    alert("종료일은 시작일보다 빠를 수 없습니다.");
    return;
  }


  await withBusy(button, "저장 중…", async () => {

    try {

      await apiPost("update", { data });

      await loadData(false);

      /* 수정 후에도 상세창을 다시 보여준다. */
      showTaskDetail(id);

      showToast("저장했습니다.");

    } catch (error) {

      alert("저장 실패\n" + error.message);
    }
  });
}


/* =========================================================
 * DELETE TASK
 * ========================================================= */

async function deleteTask(id) {

  if (!confirm("이 작업을 삭제할까요?")) {
    return;
  }

  const button = document.getElementById("deleteTaskBtn");

  await withBusy(button, "삭제 중…", async () => {

    try {

      await apiPost("delete", { id });

      state.selectedTask = null;

      const panel = document.getElementById("detailPanel");

      if (panel) {
        panel.classList.add("hidden");
      }

      await loadData(false);

      showToast("삭제했습니다.");

    } catch (error) {

      alert("삭제 실패\n" + error.message);
    }
  });
}


/* =========================================================
 * DELETE CATEGORY
 *
 * 카테고리 행만 삭제된다. 그 카테고리의 작업은 삭제되지 않고
 * 이후 화면에서 "기타"로 표시된다.
 * ========================================================= */

async function deleteCategory(id, name) {

  if (!id) {
    return;
  }

  const confirmed = confirm(
    `"${name}" 카테고리를 삭제할까요?\n\n` +
    "카테고리에 속해 있던 작업은 삭제되지 않고 " +
    "'기타'로 남습니다."
  );

  if (!confirmed) {
    return;
  }

  try {

    showToast("삭제 중…", false, 0);

    await apiPost("deleteCategory", { id });

    /* 삭제된 카테고리의 작업을 보고 있었다면 상세창을 닫는다. */
    const selected =
      state.tasks.find(task => task.id === state.selectedTask);

    if (selected && selected.categoryId === id) {

      const panel = document.getElementById("detailPanel");

      if (panel) {
        panel.classList.add("hidden");
      }

      state.selectedTask = null;
    }

    await loadData(false);

    showToast("카테고리를 삭제했습니다.");

  } catch (error) {

    hideToast();

    alert("카테고리 삭제 실패\n" + error.message);
  }
}


/* =========================================================
 * ADD TASK
 * ========================================================= */

function setFieldValue(id, value) {

  const element = document.getElementById(id);

  if (element) {
    element.value = value;
  }
}


/* 선택된 카테고리의 기본색 (없으면 기본 파랑) */
function categoryColorOf(categoryId) {

  const category =
    state.categories.find(item => item.id === categoryId);

  return (category && validHex(category.color)) || DEFAULT_COLOR;
}


/* 색을 직접 고르지 않았다면 색 입력칸이 카테고리 기본색을 미리 보여 준다. */
function syncTaskColor() {

  const colorInput = document.getElementById("taskColor");
  const categorySelect = document.getElementById("taskCategory");

  if (!colorInput || !categorySelect) {
    return;
  }

  if (colorInput.dataset.touched === "1") {
    return;
  }

  colorInput.value = categoryColorOf(categorySelect.value);
}


function openTaskModal() {

  const select = document.getElementById("taskCategory");

  if (select) {

    select.innerHTML =
      `<option value="">기타</option>` +
      state.categories
        .map(
          category => `
            <option value="${escapeAttr(category.id)}">
              ${escapeHtml(category.name)}
            </option>
          `
        )
        .join("");
  }

  const todayString = dateKey(new Date());

  setFieldValue("taskStart", todayString);
  setFieldValue("taskEnd", todayString);
  setFieldValue("taskName", "");
  setFieldValue("taskProgress", 0);
  setFieldValue("taskMemo", "");
  setFieldValue("taskTarget", "");
  setFieldValue("taskOwner", "");

  const colorInput = document.getElementById("taskColor");

  if (colorInput) {
    colorInput.dataset.touched = "0";
  }

  syncTaskColor();

  const modal = document.getElementById("taskModal");

  if (modal) {
    modal.classList.remove("hidden");
  }
}


async function saveNewTask() {

  const name = document.getElementById("taskName").value.trim();

  if (!name) {
    alert("작업명을 입력해주세요.");
    return;
  }

  const start = document.getElementById("taskStart").value;
  const end = document.getElementById("taskEnd").value;

  if (!start || !end) {
    alert("시작일과 종료일을 입력해주세요.");
    return;
  }

  if (start > end) {
    alert("종료일은 시작일보다 빠를 수 없습니다.");
    return;
  }

  const colorInput = document.getElementById("taskColor");

  /* 색을 직접 고르지 않았다면 빈 값을 보내 카테고리 기본색을 따르게 한다. */
  const color =
    colorInput && colorInput.dataset.touched === "1"
      ? colorInput.value
      : "";

  const button = document.getElementById("saveTaskBtn");

  await withBusy(button, "저장 중…", async () => {

    try {

      await apiPost("create", {
        data: {

          name,

          categoryId: document.getElementById("taskCategory").value,

          start,

          end,

          progress: document.getElementById("taskProgress").value,

          color,

          memo: document.getElementById("taskMemo").value,

          target: document.getElementById("taskTarget").value,

          owner: document.getElementById("taskOwner").value
        }
      });

      closeModal("taskModal");

      await loadData(false);

      showToast("작업을 추가했습니다.");

    } catch (error) {

      alert("작업 추가 실패\n" + error.message);
    }
  });
}


/* =========================================================
 * ADD / EDIT CATEGORY
 * ========================================================= */

/* categoryId 가 있으면 수정, 없으면 새로 추가 */
function openCategoryModal(categoryId) {

  const category =
    categoryId
      ? state.categories.find(item => item.id === categoryId)
      : null;

  setFieldValue("categoryId", category ? category.id : "");
  setFieldValue("categoryName", category ? category.name : "");
  setFieldValue(
    "categoryColor",
    category ? (validHex(category.color) || DEFAULT_COLOR) : DEFAULT_COLOR
  );

  const title = document.getElementById("categoryModalTitle");

  if (title) {
    title.textContent = category ? "카테고리 수정" : "카테고리 추가";
  }

  const modal = document.getElementById("categoryModal");

  if (modal) {
    modal.classList.remove("hidden");
  }
}


async function saveCategory() {

  const id = document.getElementById("categoryId").value;

  const name = document.getElementById("categoryName").value.trim();

  if (!name) {
    alert("카테고리명을 입력해주세요.");
    return;
  }

  const color = document.getElementById("categoryColor").value;

  const button = document.getElementById("saveCategoryBtn");

  await withBusy(button, "저장 중…", async () => {

    try {

      if (id) {
        await apiPost("updateCategory", { data: { id, name, color } });
      } else {
        await apiPost("createCategory", { data: { name, color } });
      }

      closeModal("categoryModal");

      await loadData(false);

      showToast(id ? "카테고리를 수정했습니다." : "카테고리를 추가했습니다.");

    } catch (error) {

      alert("카테고리 저장 실패\n" + error.message);
    }
  });
}


/* =========================================================
 * DRAG & DROP  (순서 변경 + 카테고리 이동)
 *
 * - 카드 왼쪽의 손잡이(⋮⋮)를 눌러 끈다. (마우스/터치 공통)
 * - 카테고리와 상관없이 어디로든 옮길 수 있다.
 *     · 다른 카드의 위쪽 절반에 가져가면 그 앞에, 아래쪽 절반이면 그 뒤에 들어간다.
 *     · 카테고리 이름 줄에 가져가면 그 카테고리의 맨 위에 들어간다.
 *       (작업이 없는 카테고리도 여기로 옮길 수 있다)
 * - 놓으면 그 자리의 카테고리로 작업의 카테고리가 바뀌고 저장된다.
 *     · 색을 따로 지정하지 않은(기본색인) 작업은 새 카테고리 색을 따른다.
 *     · 직접 고른 색은 그대로 유지한다.
 * - 손잡이에만 touch-action:none 이 걸려 있어서
 *   카드 나머지 부분에서는 폰에서 평소처럼 스크롤된다.
 * - 끄는 동안에는 화면을 다시 그리지 않고 요소만 옮긴다.
 *   (요소가 교체되면 포인터 이벤트가 끊기기 때문)
 * ========================================================= */

function timelineRowOf(id) {

  const rows = document.querySelectorAll(".timeline-task-row");

  return [...rows].find(row => row.dataset.id === id) || null;
}


/* 왼쪽의 카테고리 행에 대응하는 오른쪽(타임라인) 카테고리 행 */
function timelineCategoryRowOf(label) {

  const labels =
    [...document.querySelectorAll("#taskColumn .category-label")];

  const rows =
    document.querySelectorAll(".timeline-inner .timeline-category");

  return rows[labels.indexOf(label)] || null;
}


/* 카드 바로 위쪽에 있는 카테고리 행 = 카드가 속한 카테고리 */
function groupLabelOf(card) {

  let element = card.previousElementSibling;

  while (
    element &&
    !element.classList.contains("category-label")
  ) {
    element = element.previousElementSibling;
  }

  return element;
}


function groupIdOfCard(card) {

  const label = groupLabelOf(card);

  return label ? (label.dataset.group || "") : "";
}


/* 지금 놓으면 들어가게 될 카테고리를 강조한다. */
function highlightDropGroup(card) {

  document
    .querySelectorAll(".category-label.drag-over")
    .forEach(element => element.classList.remove("drag-over"));

  const label = groupLabelOf(card);

  if (label) {
    label.classList.add("drag-over");
  }
}


function setupDrag() {

  const column = document.getElementById("taskColumn");

  if (!column) {
    return;
  }

  column.addEventListener("pointerdown", event => {

    const handle =
      event.target.closest && event.target.closest(".drag-handle");

    if (!handle) {
      return;
    }

    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const card = handle.closest(".task-card");

    if (!card) {
      return;
    }

    event.preventDefault();

    startDrag(card, handle, event);
  });
}


function startDrag(card, handle, startEvent) {

  const id = card.dataset.id;

  const originalGroup = groupIdOfCard(card);

  let moved = false;

  let lastX = startEvent.clientX;
  let lastY = startEvent.clientY;

  state.draggingTaskId = id;

  card.classList.add("dragging");

  document.body.classList.add("is-dragging");

  highlightDropGroup(card);

  try {
    handle.setPointerCapture(startEvent.pointerId);
  } catch (error) {
    // 일부 브라우저에서는 capture가 실패할 수 있다.
  }


  /* target 카드의 앞/뒤로 옮긴다. (이미 그 자리면 아무것도 안 함) */
  function placeNextTo(target, after) {

    const alreadyThere =
      after
        ? target.nextElementSibling === card
        : target.previousElementSibling === card;

    if (alreadyThere) {
      return;
    }

    const row = timelineRowOf(id);
    const targetRow = timelineRowOf(target.dataset.id);

    if (after) {
      target.after(card);

      if (row && targetRow) {
        targetRow.after(row);
      }

    } else {
      target.before(card);

      if (row && targetRow) {
        targetRow.before(row);
      }
    }

    moved = true;

    highlightDropGroup(card);
  }


  /* 카테고리 행 바로 아래(그 카테고리의 맨 위)로 옮긴다. */
  function placeUnder(label) {

    if (label.nextElementSibling === card) {
      return;
    }

    const row = timelineRowOf(id);
    const categoryRow = timelineCategoryRowOf(label);

    label.after(card);

    if (row && categoryRow) {
      categoryRow.after(row);
    }

    moved = true;

    highlightDropGroup(card);
  }


  /* 포인터 아래에 무엇이 있는지 보고 카드를 옮긴다. */
  function evaluate(x, y) {

    const element = document.elementFromPoint(x, y);

    const column = document.getElementById("taskColumn");

    if (
      !element ||
      !element.closest ||
      !column ||
      !column.contains(element)
    ) {
      return;
    }

    const target = element.closest(".task-card");

    if (target) {

      if (target === card) {
        return;
      }

      /* 카드의 위쪽 절반이면 그 앞, 아래쪽 절반이면 그 뒤에 들어간다.
         (같은 카테고리든 다른 카테고리든 같은 규칙) */
      const rect = target.getBoundingClientRect();

      const after = y > rect.top + rect.height / 2;

      placeNextTo(target, after);

      return;
    }

    const label = element.closest(".category-label");

    if (label) {
      placeUnder(label);
    }
  }


  function onMove(event) {

    lastX = event.clientX;
    lastY = event.clientY;

    evaluate(lastX, lastY);
  }


  /* 화면 위/아래 가장자리에 가져가면 페이지가 스크롤된다. */
  const scroller = setInterval(() => {

    const edge = 70;

    if (lastY < edge) {
      window.scrollBy(0, -14);
      evaluate(lastX, lastY);

    } else if (lastY > window.innerHeight - edge) {
      window.scrollBy(0, 14);
      evaluate(lastX, lastY);
    }

  }, 16);


  async function onEnd() {

    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);

    clearInterval(scroller);

    card.classList.remove("dragging");

    document.body.classList.remove("is-dragging");

    document
      .querySelectorAll(".category-label.drag-over")
      .forEach(element => element.classList.remove("drag-over"));

    try {
      handle.releasePointerCapture(startEvent.pointerId);
    } catch (error) {
      // 무시
    }

    if (moved) {
      await saveDrop(card, id, originalGroup);
    }

    /* 손을 뗀 직후의 click 이 상세창을 열지 않도록 잠깐 유지 */
    setTimeout(() => {
      state.draggingTaskId = null;
    }, 100);
  }


  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
}


/* 화면에서 바뀐 순서·카테고리를 state 에 반영하고 서버에 저장한다. */
async function saveDrop(card, id, originalGroup) {

  const newGroup = groupIdOfCard(card);

  const changedCategory = newGroup !== originalGroup;

  const task = state.tasks.find(item => item.id === id);

  if (!task) {
    return;
  }


  /* 카테고리가 바뀔 때 서버에 보낼 값 */
  const updateData = { id, categoryId: newGroup };

  /* 색이 옛 카테고리의 기본색과 같으면 '따로 고른 색'이 아니므로
     비워서 새 카테고리의 기본색을 따르게 한다. */
  if (
    changedCategory &&
    validHex(task.color) === categoryColorOf(originalGroup)
  ) {
    updateData.color = "";
  }


  /* 순서: 화면에서 바로 뒤에 오는 카드 앞으로, 없으면 바로 앞 카드 뒤로 */
  const next = card.nextElementSibling;
  const prev = card.previousElementSibling;

  const from = state.tasks.findIndex(item => item.id === id);

  const [movedTask] = state.tasks.splice(from, 1);

  let to = from;

  if (next && next.classList.contains("task-card")) {
    to = state.tasks.findIndex(item => item.id === next.dataset.id);

  } else if (prev && prev.classList.contains("task-card")) {
    to = state.tasks.findIndex(item => item.id === prev.dataset.id) + 1;
  }

  if (to < 0) {
    to = from;
  }

  state.tasks.splice(to, 0, movedTask);

  movedTask.categoryId = newGroup;


  try {

    if (changedCategory) {
      await apiPost("update", { data: updateData });
    }

    await apiPost("reorder", {
      ids: state.tasks.map(item => item.id)
    });

    /* 새 카테고리 색 등 서버 기준으로 다시 그린다. */
    await loadData(false);

    if (changedCategory) {

      const category =
        state.categories.find(item => item.id === newGroup);

      showToast(
        `'${category ? category.name : "기타"}' 카테고리로 옮겼습니다.`
      );
    }

  } catch (error) {

    alert("순서 저장 실패\n" + error.message);

    await loadData(false);
  }
}


/* =========================================================
 * ZOOM RANGE
 *
 * 연도는 넘어가지 않는다.
 * range는 선택된 연도 안에서만 움직인다.
 * ========================================================= */

function updateRangeLabel() {

  const label = document.getElementById("rangeLabel");

  if (!label) {
    return;
  }

  label.textContent =
    `${dateKey(dateFromYearDay(state.rangeStart))} ~ ` +
    `${dateKey(dateFromYearDay(state.rangeEnd))} ` +
    `(${state.rangeEnd - state.rangeStart + 1}일)`;
}


function updateRange() {

  const minElement = document.getElementById("rangeMin");
  const maxElement = document.getElementById("rangeMax");

  if (!minElement || !maxElement) {
    return;
  }

  let min = Number(minElement.value);
  let max = Number(maxElement.value);

  const totalDays = daysInYear(state.year);

  min = Math.max(0, Math.min(min, totalDays - 1));
  max = Math.max(0, Math.min(max, totalDays - 1));

  /* 최소/최대가 같아지는 것을 방지 */
  if (min >= max) {

    if (document.activeElement === minElement) {
      min = Math.max(0, max - 1);
    } else {
      max = Math.min(totalDays - 1, min + 1);
    }
  }

  state.rangeStart = min;
  state.rangeEnd = max;

  minElement.value = min;
  maxElement.value = max;

  renderTimeline();
  updateRangeLabel();
}


function resetRange() {

  const days = daysInYear(state.year);

  state.rangeStart = 0;
  state.rangeEnd = days - 1;

  const min = document.getElementById("rangeMin");
  const max = document.getElementById("rangeMax");

  if (min) {
    min.min = 0;
    min.max = days - 1;
    min.value = 0;
  }

  if (max) {
    max.min = 0;
    max.max = days - 1;
    max.value = days - 1;
  }
}


/* =========================================================
 * YEAR
 * ========================================================= */

function changeYear(amount) {

  state.year += amount;

  /* 연도를 바꾸면 반드시 새 연도 전체를 기본 화면으로 한다. */
  resetRange();

  state.scrollToToday = true;

  /* 선택한 연도에 존재하지 않는 작업/카테고리는
     groupTasks()에서 자동으로 숨겨진다. */
  render();
}


/* 이전 연도 */
const prevYear = document.getElementById("prevYear");

if (prevYear) {
  prevYear.onclick = () => {
    changeYear(-1);
  };
}


/* 다음 연도 */
const nextYear = document.getElementById("nextYear");

if (nextYear) {
  nextYear.onclick = () => {
    changeYear(1);
  };
}


/* =========================================================
 * TODAY / FULL
 * ========================================================= */

const todayBtn = document.getElementById("todayBtn");

if (todayBtn) {

  todayBtn.onclick = () => {

    const today = new Date();

    state.year = today.getFullYear();

    const day = dayOfYear(today);

    const totalDays = daysInYear(state.year);

    /* 오늘 전후 30일 (현재 연도를 벗어나지 않는다) */
    const start = Math.max(0, day - 30);
    const end = Math.min(totalDays - 1, day + 30);

    state.rangeStart = start;
    state.rangeEnd = end;

    const rangeMinElement = document.getElementById("rangeMin");
    const rangeMaxElement = document.getElementById("rangeMax");

    if (rangeMinElement) {
      rangeMinElement.min = 0;
      rangeMinElement.max = totalDays - 1;
      rangeMinElement.value = start;
    }

    if (rangeMaxElement) {
      rangeMaxElement.min = 0;
      rangeMaxElement.max = totalDays - 1;
      rangeMaxElement.value = end;
    }

    state.scrollToToday = true;

    render();
  };
}


/* 확대를 풀고 선택한 연도 전체를 본다. */
const fullBtn = document.getElementById("fullBtn");

if (fullBtn) {

  fullBtn.onclick = () => {

    resetRange();

    state.scrollToToday = true;

    render();
  };
}


/* =========================================================
 * MODAL
 * ========================================================= */

function closeModal(id) {

  const modal = document.getElementById(id);

  if (!modal) {
    return;
  }

  modal.classList.add("hidden");
}


/* data-close가 있는 버튼 */
document
  .querySelectorAll("[data-close]")
  .forEach(button => {

    button.addEventListener("click", () => {
      closeModal(button.dataset.close);
    });
  });


/* 작업 추가 */
const addTaskBtn = document.getElementById("addTaskBtn");

if (addTaskBtn) {
  addTaskBtn.onclick = openTaskModal;
}

const saveTaskBtn = document.getElementById("saveTaskBtn");

if (saveTaskBtn) {
  saveTaskBtn.onclick = saveNewTask;
}

/* 작업 색: 직접 고르면 그 색을 쓰고, 안 고르면 카테고리 기본색을 따른다. */
const taskColorInput = document.getElementById("taskColor");

if (taskColorInput) {
  taskColorInput.addEventListener("input", () => {
    taskColorInput.dataset.touched = "1";
  });
}

const taskCategorySelect = document.getElementById("taskCategory");

if (taskCategorySelect) {
  taskCategorySelect.addEventListener("change", syncTaskColor);
}


/* 카테고리 추가 / 수정 */
const addCategoryBtn = document.getElementById("addCategoryBtn");

if (addCategoryBtn) {
  addCategoryBtn.onclick = () => openCategoryModal();
}

const saveCategoryBtn = document.getElementById("saveCategoryBtn");

if (saveCategoryBtn) {
  saveCategoryBtn.onclick = saveCategory;
}


/* 새로고침 */
const reloadBtn = document.getElementById("reloadBtn");

if (reloadBtn) {
  reloadBtn.onclick = () => loadData();
}


/* 편집 키 다시 입력 */
const keyBtn = document.getElementById("keyBtn");

if (keyBtn) {

  keyBtn.onclick = () => {

    if (askKey("편집 키를 입력하세요")) {
      loadData();
    }
  };
}


/* 확대/축소 범위 */
const rangeMin = document.getElementById("rangeMin");

if (rangeMin) {
  rangeMin.addEventListener("input", updateRange);
}

const rangeMax = document.getElementById("rangeMax");

if (rangeMax) {
  rangeMax.addEventListener("input", updateRange);
}


/* =========================================================
 * ESC
 * ========================================================= */

document.addEventListener("keydown", event => {

  if (event.key !== "Escape") {
    return;
  }

  /* 작업 추가 모달 */
  const taskModal = document.getElementById("taskModal");

  if (taskModal && !taskModal.classList.contains("hidden")) {
    taskModal.classList.add("hidden");
    return;
  }

  /* 카테고리 추가/수정 모달 */
  const categoryModal = document.getElementById("categoryModal");

  if (categoryModal && !categoryModal.classList.contains("hidden")) {
    categoryModal.classList.add("hidden");
    return;
  }

  /* 상세 패널 */
  const detailPanel = document.getElementById("detailPanel");

  if (detailPanel && !detailPanel.classList.contains("hidden")) {
    detailPanel.classList.add("hidden");
    state.selectedTask = null;
  }
});


/* =========================================================
 * WINDOW RESIZE
 *
 * 타임라인 폭이 화면 폭에 따라 달라지므로 다시 그린다.
 * ========================================================= */

let resizeTimer = null;

window.addEventListener("resize", () => {

  clearTimeout(resizeTimer);

  resizeTimer = setTimeout(() => {
    renderTimeline();
  }, 150);
});


/* =========================================================
 * HTML ESCAPE
 * ========================================================= */

function escapeHtml(value) {

  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function escapeAttr(value) {
  return escapeHtml(value);
}


/* =========================================================
 * INITIALIZE
 * ========================================================= */

setupDrag();

/* 현재 연도의 전체 범위로 초기화 */
resetRange();

/* 데이터 불러오기 */
loadData();
