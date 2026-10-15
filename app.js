/* =========================================================
 * 간트차트 app.js  (v3, 2026-09-21-q)
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
 *  - 연도 숫자를 누르면 연도 선택창, 1년 전체가 화면 폭에 맞춰 한눈에 보임
 *  - 캡처 버튼: 지금 확대 상태와 무관하게 연도 전체를 이미지로 저장
 * ========================================================= */

const API_URL =
  "https://script.google.com/macros/s/AKfycbx33KL-l94mz08Q8rWJHYrGUXyipmxrm02z3Y26OR20V9q5V2diZRFIzvyFpqio-0Jg8Q/exec";

/* ===== 멀티 차트 (추가분) =====
   주소에 ?chart=아이디 가 있으면: 이 창은 "그 차트 하나"를 보여주는
   기존 화면 그대로 동작한다(없으면 'default' = 기존 Tasks/Categories).
   주소에 ?chart= 가 전혀 없으면: 이 창은 "여러 차트를 쌓아 보여주는 틀(shell)"
   역할을 한다 (아래 SHELL 섹션 참고). */
const CHART_PARAM = new URLSearchParams(window.location.search).get("chart");
const IS_SHELL_MODE = CHART_PARAM === null;
const CHART_ID = CHART_PARAM || "default";

/* 기존 액션 이름 -> 차트별 액션 이름 매핑. apiGet/apiPost 안에서만 쓰고
   그 외 호출부(아래 곳곳의 apiPost("update", ...) 등)는 전혀 손대지 않는다. */
const CHART_ACTION_MAP = {
  create: "createForChart",
  update: "updateForChart",
  delete: "deleteForChart",
  reorder: "reorderForChart",
  createCategory: "createCategoryForChart",
  updateCategory: "updateCategoryForChart",
  deleteCategory: "deleteCategoryForChart",
  reorderCategories: "reorderCategoriesForChart"
};

const DEFAULT_COLOR = "#3b82f6";

/* 주 단위 날짜 라벨을 보여 주려면 한 주 칸이 최소 이만큼(px) 필요하다.
   1년 전체를 화면 폭에 맞추면 이보다 좁아져서 월 라벨만 보인다. */
const WEEK_LABEL_MIN_WIDTH = 40;

/* 세 파일(index.html / app.js / style.css)이 같은 버전인지 화면 맨 아래에 표시한다.
   파일을 새로 올렸는데 예전 파일이 뜨는 경우(브라우저 캐시, 일부만 교체)를
   바로 알아볼 수 있다. 파일을 고칠 때마다 세 곳의 버전을 같이 올린다. */
const APP_VERSION = "2026-09-21-q";


/* =========================================================
 * STATE
 * ========================================================= */

let state = {
  tasks: [],
  categories: [],

  // 화면은 항상 한 개 연도만 표시한다.
  year: new Date().getFullYear(),

  /* ===== 멀티 차트 (추가분): 이 차트에 연도와 무관한 표시 기간이
     설정돼 있으면 Date로 들어간다. null이면 위 year 기준(기존 동작). */
  customStart: null,
  customEnd: null,

  // 선택 연도 내부에서만 확대/축소
  rangeStart: 0,
  rangeEnd: 364,

  selectedTask: null,
  draggingTaskId: null,

  // 다음 렌더링 뒤에 '오늘' 위치로 가로 스크롤할지
  scrollToToday: true,

  // 차트 전체 높이(px). 아래쪽 손잡이로 사용자가 직접 조절한다.
  chartHeight: 420
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
  const result = await request("loadChart", { chartId: CHART_ID });

  return result.data;
}


async function apiPost(action, data = {}) {
  const mapped = CHART_ACTION_MAP[action] || action;
  return request(mapped, { ...data, chartId: CHART_ID });
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


/* (추가분) 커스텀 표시 기간 제목용 짧은 표기(YY.MM.DD). 줄바꿈 방지용. */
function shortDateKey(date) {
  return [
    String(date.getFullYear()).slice(2),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join(".");
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


/* 선택된 연도의 1월 1일. (추가분) 이 차트에 연도 무관 표시 기간이
   설정돼 있으면 그 시작일. 없으면 기존 그대로 연도 1/1. */
function getYearStart() {
  return state.customStart ? new Date(state.customStart) : new Date(state.year, 0, 1);
}


/* 선택된 연도의 12월 31일. (추가분) 커스텀 기간이 있으면 그 종료일. */
function getYearEnd() {
  return state.customEnd ? new Date(state.customEnd) : new Date(state.year, 11, 31);
}


/* (추가분) 지금 표시 중인 "창"(연도 전체 또는 커스텀 기간)의 총 일수.
   커스텀 기간이 없으면 daysInYear(state.year)와 완전히 같은 값이 나온다. */
function windowTotalDays() {
  return Math.round(
    (getYearEnd().getTime() - getYearStart().getTime()) / 86400000
  ) + 1;
}


/* (추가분) 지금 창이 걸쳐 있는 달들을, 각 달이 창 안에서 차지하는
   일수와 함께 돌려준다. 커스텀 기간이 없으면 항상 state.year의
   1~12월 12개가, 각 달의 실제 날짜수 그대로 나온다(기존과 동일). */
function windowMonths() {
  const start = getYearStart();
  const end = getYearEnd();
  const out = [];
  let y = start.getFullYear();
  let m = start.getMonth();
  const endY = end.getFullYear();
  const endM = end.getMonth();

  while (y < endY || (y === endY && m <= endM)) {
    const monthStart = new Date(y, m, 1);
    const monthEnd = new Date(y, m + 1, 0);
    const clippedStart = monthStart < start ? start : monthStart;
    const clippedEnd = monthEnd > end ? end : monthEnd;
    const days = Math.round((clippedEnd.getTime() - clippedStart.getTime()) / 86400000) + 1;

    out.push({ year: y, month: m, days });

    m++;
    if (m > 11) { m = 0; y++; }
  }

  return out;
}


/* 선택된 연도 1월 1일부터 몇 번째 날인지 */
function dayOffsetFromYearStart(date) {
  const start = getYearStart();

  return Math.floor(
    (date.getTime() - start.getTime()) / 86400000
  );
}


/* 선택 연도(또는 커스텀 기간)의 n번째 날(0부터) -> Date */
function dateFromYearDay(day) {
  const date = getYearStart();

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
    const yearNumber = yearTitle.querySelector(".year-num");

    /* (추가분) 이 차트에 커스텀 표시 기간이 있으면 연도 대신 그 기간을 보여주고,
       연도 이동(이전/다음 연도, 연도 선택창)은 의미가 없으므로 숨긴다.
       (수정) 줄바꿈을 막기 위해 YYYY-MM-DD가 아닌 YY.MM.DD로 짧게 표기한다. */
    (yearNumber || yearTitle).textContent = state.customStart
      ? shortDateKey(getYearStart()) + " ~ " + shortDateKey(getYearEnd())
      : state.year;
  }

  const prevYearBtn = document.getElementById("prevYear");
  const nextYearBtn = document.getElementById("nextYear");
  if (prevYearBtn) prevYearBtn.classList.toggle("hidden", !!state.customStart);
  if (nextYearBtn) nextYearBtn.classList.toggle("hidden", !!state.customStart);

  const clearBtn = document.getElementById("chartRangeClearBtn");
  if (clearBtn) clearBtn.classList.toggle("hidden", !state.customStart);

  syncRowRange();
  applyGanttHeight();
  computeRowScale();

  renderTaskColumn();
  renderTimeline();
  updateRangeLabel();

  if (hSlider) hSlider.layout();
  if (vSlider) vSlider.layout();

  if (isYearPickerOpen()) {
    renderYearPicker();
  }

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

  /* (추가분) 커스텀 기간이 없으면 getYearStart/getYearEnd가 기존과
     똑같이 "state.year의 1/1~12/31"을 돌려주므로 결과가 완전히 같다. */
  const yearStart = dateKey(getYearStart());
  const yearEnd = dateKey(getYearEnd());

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
 * ROWS  (카테고리 줄 + 작업 줄을 하나의 순서 있는 목록으로)
 *
 * 왼쪽 목록과 오른쪽 타임라인이 항상 같은 순서로 그려지므로,
 * 세로 범위 슬라이더는 이 하나의 목록에서 구간만 잘라 보여 준다.
 * ========================================================= */

function buildRows() {

  const rows = [];

  groupTasks().forEach(group => {

    rows.push({ kind: "category", group });

    group.tasks.forEach(task => {
      rows.push({ kind: "task", group, task });
    });
  });

  return rows;
}


/* 기본 줄 높이. 작업 줄을 예전(72px)보다 얇게 만든다.
   (수정) 카테고리 줄은 "구분줄" 역할이라 작업 줄(48px)과 더 분명히
   구분되도록 30px로 줄였다. 드래그 손잡이·색점·이름·삭제 버튼이
   눌리기엔 넉넉한 하한선. */
const CATEGORY_ROW_HEIGHT = 30;
const TASK_ROW_HEIGHT = 48;

function rowHeightOf(row) {
  return row.kind === "category" ? CATEGORY_ROW_HEIGHT : TASK_ROW_HEIGHT;
}


/* 전체 줄을 원래 높이(38/72)로 이어 붙였을 때, 각 줄이 몇 px 지점에서
   시작해서 몇 px 지점에서 끝나는지. (세로 슬라이더가 다루는 좌표계) */
function rowCumulative() {

  let acc = 0;

  return buildRows().map(row => {

    const start = acc;

    acc += rowHeightOf(row);

    return { row, start, end: acc };
  });
}


/* 세로 슬라이더는 '자연 높이 기준으로 어디부터 어디까지 볼지'를
   연속적인 px 단위로 고른다(줄 단위로 뚝뚝 끊기지 않는다).
   고른 구간은 차트의 고정 높이(state.chartHeight)를 항상 꽉
   채우도록 배율이 매끄럽게 바뀐다 - 범위를 벌릴수록 압축되어
   다 보이고, 좁힐수록 그 구간만 확대되어 자세히 보인다. 전체
   높이가 바뀌면(연도 변경, 작업 추가/삭제) 범위를 전체로 되돌린다. */
function syncRowRange() {

  const total = rowCumulative().reduce((max, r) => Math.max(max, r.end), 0);

  if (state.rowsTotal !== total) {

    state.rowsTotal = total;
    state.rowStart = 0;
    state.rowEnd = total;

  } else {

    state.rowStart = Math.max(0, Math.min(state.rowStart, total));
    state.rowEnd = Math.max(state.rowStart, Math.min(state.rowEnd, total));
  }
}


/* 고른 구간과 조금이라도 겹치는 줄은 전부 포함한다(경계 줄도 보임). */
function selectedRowsWithCum() {

  return rowCumulative().filter(
    r => r.end > state.rowStart && r.start < state.rowEnd
  );
}


function selectedRows() {
  return selectedRowsWithCum().map(r => r.row);
}


/* 고른 구간의 '너비'(자연 px)를 차트의 남은 세로 공간에 꽉 채우기
   위한 배율. 어떤 줄이 경계에서 드나드는지와 무관하게 슬라이더
   위치만으로 매끄럽게 정해지므로, 손잡이를 조금만 움직여도 배율이
   그만큼만 매끄럽게 바뀐다(끊기지 않는다). */
/* 세로로 심하게 확대해도 줄이 한없이 커지지는 않게 상한을 둔다.
   (작업 줄 기준 최대 96px 정도 - 막대는 그대로인데 줄만 텅 비어
   보이는 걸 막는다) 상한에 걸리면 남는 세로 공간은 그냥 빈 배경으로
   남는다(새로 뭘 그리지 않음). */
/* 세로로 확대해도 작업 줄이 이 높이(px)를 넘지 않게 한다. */
const MAX_TASK_ROW_HEIGHT = 96;
const MAX_ROW_SCALE = MAX_TASK_ROW_HEIGHT / TASK_ROW_HEIGHT;

function computeRowScale() {

  const width = Math.max(1, state.rowEnd - state.rowStart);

  const available = Math.max(1, state.chartHeight - 52);

  state.rowScale = Math.min(available / width, MAX_ROW_SCALE);
}


/* 화면에 보이는 첫 줄의 위쪽 끝을, 창의 맨 위(0px)에 맞추기 위해
   안쪽 콘텐츠를 위로 밀어 올리는 양(뷰포트 안에서, 배율 적용 후). */
function rowsOffset(rows) {

  if (!rows.length) {
    return 0;
  }

  return (state.rowStart - rows[0].start) * state.rowScale;
}


/* 각 줄의 실제(배율 적용) 표시 높이. 누적 반올림으로 오차가 쌓이지
   않게 한다. */
function scaledRowHeights(rows) {

  const heights = [];
  let cumulative = 0;

  rows.forEach(r => {

    cumulative += rowHeightOf(r.row) * state.rowScale;

    const rounded = Math.round(cumulative);

    heights.push(rounded - heights.reduce((a, b) => a + b, 0));
  });

  return heights;
}


/* 세로 슬라이더로 일부 줄만 보일 때도 .gantt 상자 크기는 항상
   "전체 줄을 다 보여줄 때"의 높이로 고정한다. (좌우 확대/축소가
   화면 폭을 그대로 두는 것과 같은 방식) 그래야 줄 수를 줄였을 때
   생기는 빈 공간에 새로 뭘 그리지 않고, 원래 있던 흰 배경이 그대로
   보인다. */
function applyGanttHeight() {

  const gantt = document.querySelector(".gantt");

  if (!gantt) {
    return;
  }

  gantt.style.minHeight = state.chartHeight + "px";
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


  /* Header (항상 고정, 세로 범위와 무관) */
  const header = document.createElement("div");

  header.className = "task-header";
  header.textContent = "작업";

  column.appendChild(header);


  /* 세로 창: 항상 (차트 높이 - 헤더) 만큼만 보인다. 그 안에서
     콘텐츠를 위로 살짝 밀어(offset) 경계 줄이 매끄럽게 드나든다. */
  const viewport = document.createElement("div");

  viewport.className = "rows-viewport";
  viewport.style.height = Math.max(1, state.chartHeight - 52) + "px";

  column.appendChild(viewport);

  const rowsInner = document.createElement("div");

  rowsInner.className = "rows-inner";

  viewport.appendChild(rowsInner);

  const rowsWithCum = selectedRowsWithCum();
  const heights = scaledRowHeights(rowsWithCum);

  rowsInner.style.transform =
    "translateY(" + (-rowsOffset(rowsWithCum)) + "px)";

  rowsWithCum.forEach((entry, i) => {

    const row = entry.row;
    const h = heights[i];

    if (row.kind === "category") {

      const group = row.group;

      const category = document.createElement("div");

      category.className = "category-label";
      category.dataset.group = group.id;
      category.style.height = h + "px";


      /* "기타"는 실제 카테고리가 아니라 순서를 저장할 곳이 없으므로
         끌 수 없다(손잡이 자체를 넣지 않는다). */
      if (group.id) {

        const catHandle = document.createElement("span");

        catHandle.className = "drag-handle category-drag-handle";
        catHandle.title = "끌어서 카테고리 순서 변경 (하위 작업도 함께 이동)";
        catHandle.setAttribute("aria-hidden", "true");
        catHandle.innerHTML = "<i></i><i></i><i></i>";

        category.appendChild(catHandle);
      }


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

      rowsInner.appendChild(category);

      return;
    }

    /* Task row */
    const { group, task } = row;

    const card = document.createElement("div");

    card.className =
      "task-card" +
      (state.draggingTaskId === task.id ? " dragging" : "");

    card.dataset.id = task.id;
    card.dataset.group = group.id;

    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", task.name + " 상세 보기");
    card.style.height = h + "px";

    card.innerHTML = `
      <span
        class="drag-handle"
        title="끌어서 순서 변경"
        aria-hidden="true"
      ><i></i><i></i><i></i></span>

      <div
        class="task-name"
        title="두 번 눌러 이름 수정"
      >${escapeHtml(task.name)}</div>
    `;

    /* (수정) 제목을 더블클릭해서 이름을 고칠 때, 그 첫 번째 클릭만으로
       상세 패널이 열려버리면(그 안의 scrollIntoView 때문에) 화면이
       아래로 스크롤된 뒤에야 인라인 입력창이 뜬다. 제목 부분 클릭은
       더블클릭일 수도 있으니 살짝 늦춰서 열고, 더블클릭으로 확정되면
       (= 인라인 수정 시작) 그 예약을 취소해 상세 패널이 아예 열리지
       않게 한다. 제목이 아닌 다른 부분 클릭은 기존처럼 즉시 연다. */
    let detailOpenTimer = null;

    card.addEventListener("click", event => {

      if (
        state.draggingTaskId ||
        event.target.closest(".drag-handle") ||
        event.target.closest(".task-name-edit")
      ) {
        return;
      }

      if (event.target.closest(".task-name")) {
        clearTimeout(detailOpenTimer);
        detailOpenTimer = setTimeout(() => showTaskDetail(task.id), 250);
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

    const nameEl = card.querySelector(".task-name");

    nameEl.addEventListener("dblclick", event => {

      event.preventDefault();
      event.stopPropagation();

      clearTimeout(detailOpenTimer);

      startInlineRename(nameEl, task);
    });

    rowsInner.appendChild(card);
  });
}


/* =========================================================
 * INLINE RENAME  (작업명을 두 번 눌러 그 자리에서 바로 수정)
 * ========================================================= */

function startInlineRename(nameEl, task) {

  if (nameEl.querySelector(".task-name-edit")) {
    return;
  }

  /* 더블클릭을 이루는 두 번의 클릭이 먼저 카드 클릭으로 처리되어
     상세창이 열려 있을 수 있다. 이름만 조용히 고치는 게 목적이므로
     그 상세창은 다시 닫는다. */
  if (state.selectedTask === task.id) {

    const panel = document.getElementById("detailPanel");

    if (panel && !panel.classList.contains("hidden")) {
      panel.classList.add("hidden");
      state.selectedTask = null;
    }
  }

  const original = task.name;

  nameEl.textContent = "";

  const input = document.createElement("input");

  input.type = "text";
  input.className = "task-name-edit";
  input.value = original;

  nameEl.appendChild(input);
  input.focus();
  input.select();

  let done = false;

  async function finish(save) {

    if (done) {
      return;
    }

    done = true;

    const value = input.value.trim();

    if (save && value && value !== original) {

      nameEl.textContent = value;

      try {
        await apiPost("update", { data: { id: task.id, name: value } });
        await loadData(false);
      } catch (error) {
        alert("이름 저장 실패\n" + error.message);
        await loadData(false);
      }

    } else {

      nameEl.textContent = original;
    }
  }

  input.addEventListener("blur", () => finish(true));

  input.addEventListener("keydown", event => {

    /* 카드 자체가 role="button"이라 스페이스/엔터 키를 누르면
       카드를 "누른" 것으로 처리하는 리스너가 따로 있다. 이 입력칸
       안에서 누르는 키는 그쪽으로 새어나가면 안 된다 - 특히
       스페이스는 그대로 두면 preventDefault 되어 띄어쓰기가
       입력되지 않는다. */
    event.stopPropagation();

    if (event.key === "Enter") {
      event.preventDefault();
      input.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      done = true;
      nameEl.textContent = original;
    }
  });

  input.addEventListener("click", event => event.stopPropagation());
  input.addEventListener("dblclick", event => event.stopPropagation());
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
  const totalDays = windowTotalDays();


  /* range 역시 선택 연도 안에서만 움직인다. */
  state.rangeStart =
    Math.max(0, Math.min(state.rangeStart, totalDays - 1));

  state.rangeEnd =
    Math.max(
      state.rangeStart,
      Math.min(state.rangeEnd, totalDays - 1)
    );


  const visibleDays = state.rangeEnd - state.rangeStart + 1;

  /* 보이는 기간은 항상 화면 폭에 딱 맞춘다.
     (1년 전체를 보면 1년이 한눈에 들어오고, 확대하면 그만큼 하루 폭이 커진다) */
  const width = timeline.clientWidth || 900;

  const dayWidth = width / visibleDays;

  inner.style.width = width + "px";

  inner.style.setProperty("--week-width", (dayWidth * 7) + "px");

  /* 주 칸이 너무 좁으면 주 단위 세로선은 그리지 않는다. (월 배경이 구분해 준다) */
  if (dayWidth * 7 < WEEK_LABEL_MIN_WIDTH) {
    inner.classList.add("no-week-lines");
  }


  /* 주 헤더 */
  renderWeekHeader(inner, visibleDays, dayWidth);


  /* 세로 창: 왼쪽 목록과 정확히 같은 규칙으로 보인다. */
  const viewport = document.createElement("div");

  viewport.className = "rows-viewport";
  viewport.style.height = Math.max(1, state.chartHeight - 52) + "px";

  inner.appendChild(viewport);

  /* 월별 뒷배경 (흰색 / 옅은 회백색 번갈아) - 세로 창 안에 고정 */
  renderMonthBands(viewport, dayWidth);

  const rowsInner = document.createElement("div");

  rowsInner.className = "rows-inner";

  viewport.appendChild(rowsInner);

  const rowsWithCum = selectedRowsWithCum();
  const heights = scaledRowHeights(rowsWithCum);

  rowsInner.style.transform =
    "translateY(" + (-rowsOffset(rowsWithCum)) + "px)";

  /* Category + Task rows (왼쪽 목록과 같은 순서·같은 배율) */
  rowsWithCum.forEach((entry, i) => {

    const item = entry.row;
    const h = heights[i];

    if (item.kind === "category") {

      const categoryRow = document.createElement("div");

      categoryRow.className = "timeline-category";
      categoryRow.style.height = h + "px";

      rowsInner.appendChild(categoryRow);

      return;
    }

    const row = document.createElement("div");

    row.className = "timeline-task-row";
    row.dataset.id = item.task.id;
    row.style.height = h + "px";

    renderTaskBar(row, item.task, totalDays, visibleDays, h);

    rowsInner.appendChild(row);
  });


  /* 오늘 선 (세로 창에 고정) */
  renderTodayLine(viewport, totalDays, visibleDays, width);

  timeline.appendChild(inner);
}


/* =========================================================
 * MONTH SEGMENTS / MONTH BANDS
 *
 * 월별로 뒷배경 색을 번갈아 칠한다.
 *   1월 흰색 / 2월 옅은 회백색 / 3월 흰색 / 4월 옅은 회백색 ...
 * 확대해서 일부 기간만 보고 있어도 달마다 색은 그대로다.
 * ========================================================= */

/* 지금 보이는 기간과 겹치는 달들: [{ month, from, to }]
   (from / to 는 그 해의 n번째 날, 0부터) */
function monthSegments() {

  const yearStart = getYearStart();
  const yearEnd = getYearEnd();

  /* 자정 기준 날짜끼리의 차이이므로 반올림해서 하루 단위로 센다. */
  const dayIndex = date =>
    Math.round((date.getTime() - yearStart.getTime()) / 86400000);

  const segments = [];

  /* (추가분) 커스텀 기간이 없으면 이 루프는 예전처럼 state.year의
     0~11월 12번을 그대로 돈다. 있으면 그 기간이 걸친 달만 돈다
     (연도를 넘어가도 됨). */
  let y = yearStart.getFullYear();
  let m = yearStart.getMonth();
  const endY = yearEnd.getFullYear();
  const endM = yearEnd.getMonth();

  while (y < endY || (y === endY && m <= endM)) {

    const first = dayIndex(new Date(y, m, 1));
    const last = dayIndex(new Date(y, m + 1, 0));

    const from = Math.max(first, state.rangeStart);
    const to = Math.min(last, state.rangeEnd);

    if (from <= to) {
      segments.push({ month: m, year: y, from, to });
    }

    m++;
    if (m > 11) { m = 0; y++; }
  }

  return segments;
}


function renderMonthBands(inner, dayWidth) {

  const layer = document.createElement("div");

  layer.className = "month-bands";

  monthSegments().forEach(({ month, from, to }) => {

    const band = document.createElement("div");

    band.className =
      "month-band" + (month % 2 === 1 ? " alt" : "");

    band.style.left =
      ((from - state.rangeStart) * dayWidth) + "px";

    band.style.width =
      ((to - from + 1) * dayWidth) + "px";

    layer.appendChild(band);
  });

  inner.appendChild(layer);
}


/* =========================================================
 * HEADER  (월 줄 + 주 줄)
 *
 * - 1행: 월. 항상 보인다.
 * - 2행: 주 시작 날짜. 한 주 칸이 충분히 넓을 때만 보인다.
 * 각 칸의 너비는 (칸의 일수 x 하루 너비)로 정확히 정해서
 * 배경, 막대, 오늘 선과 어긋나지 않는다.
 * ========================================================= */

function renderWeekHeader(inner, visibleDays, dayWidth) {

  const header = document.createElement("div");

  header.className = "week-header";


  /* 1행: 월 */
  const monthRow = document.createElement("div");

  monthRow.className = "month-row";

  const monthColumns = [];

  monthSegments().forEach(({ month, year, from, to }) => {

    const width = (to - from + 1) * dayWidth;

    const cell = document.createElement("div");

    cell.className =
      "month-cell" + (month % 2 === 1 ? " alt" : "");

    cell.title =
      `${year === undefined ? state.year : year}-${String(month + 1).padStart(2, "0")}`;

    /* 칸이 좁으면 '9월' 대신 '9', 더 좁으면 글자를 생략 */
    cell.textContent =
      width >= 40 ? `${month + 1}월`
      : width >= 14 ? String(month + 1)
      : "";

    monthRow.appendChild(cell);

    monthColumns.push(width + "px");
  });

  monthRow.style.gridTemplateColumns = monthColumns.join(" ");

  header.appendChild(monthRow);


  /* 2행: 주 시작 날짜. 칸이 너무 좁아지면 글자 없이 구분선만 남긴다.
     (헤더 높이를 늘 같게 유지해서 오늘 선 · 월별 뒷배경 위치가 어긋나지 않는다) */
  const showWeekLabels = dayWidth * 7 >= WEEK_LABEL_MIN_WIDTH;

  const weekRow = document.createElement("div");

  weekRow.className = "week-row" + (showWeekLabels ? "" : " compact");

  const weekColumns = [];

  for (let offset = 0; offset < visibleDays; offset += 7) {

    const days = Math.min(7, visibleDays - offset);

    const date = dateFromYearDay(state.rangeStart + offset);

    const end = dateFromYearDay(state.rangeStart + offset + days - 1);

    const cell = document.createElement("div");

    cell.className = "week-cell";
    cell.title = `${dateKey(date)} ~ ${dateKey(end)}`;

    if (showWeekLabels) {
      cell.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
    }

    weekRow.appendChild(cell);

    weekColumns.push((days * dayWidth) + "px");
  }

  weekRow.style.gridTemplateColumns = weekColumns.join(" ");

  header.appendChild(weekRow);

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
  visibleDays,
  rowHeight
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

  /* 막대(색상 박스)는 줄 높이를 그대로 채운다(위아래 여백 없음).
     줄 사이 구분은 줄 자체의 아래쪽 테두리선이 대신한다. */
  const h = rowHeight || 72;

  bar.style.top = "0px";
  bar.style.height = h + "px";

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

  const idElement = document.getElementById("categoryId");

  const id = idElement ? idElement.value : "";

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

    if (card) {

      event.preventDefault();

      startDrag(card, handle, event);

      return;
    }

    const label = handle.closest(".category-label");

    if (label && label.dataset.group) {

      event.preventDefault();

      startCategoryDrag(label, handle, event);
    }
  });
}


/* =========================================================
 * CATEGORY DRAG  (카테고리 순서 변경 - 하위 작업은 묶여서 함께 이동)
 *
 * 개별 작업처럼 화면의 요소를 직접 옮기지는 않는다. 카테고리와 그
 * 하위 작업들을 화면에서 하나씩 옮기려면 복잡해지므로, 끄는 동안은
 * "여기에 놓으면 이 카테고리 앞/뒤로 들어간다"만 강조해서 보여주고,
 * 실제 순서 변경은 손을 뗄 때 한 번에 반영한다(카테고리 몇 개뿐이라
 * 다시 그려도 충분히 빠르다). 다른 카테고리의 작업 목록 안으로는
 * 들어가지 않는다 - 항상 카테고리 단위로만 자리를 바꾼다.
 * ========================================================= */

function categoryLabelElements() {

  return [
    ...document.querySelectorAll("#taskColumn .rows-inner > .category-label")
  ];
}


/* 그 카테고리 이름 줄부터, 다음 카테고리 줄 바로 앞까지(그 카테고리의
   작업들 전체)를 하나의 블록으로 보고 위/아래 경계를 구한다. */
function categoryBlockBounds(labelEl) {

  const top = labelEl.getBoundingClientRect().top;

  let next = labelEl.nextElementSibling;

  while (next && !next.classList.contains("category-label")) {
    next = next.nextElementSibling;
  }

  const bottom = next
    ? next.getBoundingClientRect().top
    : document.querySelector("#taskColumn .rows-inner").getBoundingClientRect().bottom;

  return { top, bottom };
}


function startCategoryDrag(labelEl, handle, startEvent) {

  const groupId = labelEl.dataset.group;

  let targetIndex = state.categories.findIndex(c => c.id === groupId);

  let moved = false;

  labelEl.classList.add("dragging");

  document.body.classList.add("is-dragging");

  try {
    handle.setPointerCapture(startEvent.pointerId);
  } catch (error) {
    // 일부 브라우저에서는 capture가 실패할 수 있다.
  }


  function clearHighlight() {

    document
      .querySelectorAll(".category-label.drag-over")
      .forEach(element => element.classList.remove("drag-over"));
  }


  /* 지금 포인터 아래 위치라면, 카테고리 목록에서 몇 번째 자리에
     들어가게 될지(0 ~ 카테고리 개수) 계산한다. 해당하는 카테고리가
     없으면(내 카테고리 위이거나 목록 밖이면) null. */
  function targetAt(x, y) {

    const column = document.getElementById("taskColumn");

    const el = document.elementFromPoint(x, y);

    if (!el || !column || !column.contains(el)) {
      return null;
    }

    let label = el.closest(".category-label");

    if (!label) {

      const card = el.closest(".task-card");

      if (card) {
        label = groupLabelOf(card);
      }
    }

    if (!label || label === labelEl || !label.dataset.group) {
      return null;
    }

    const bounds = categoryBlockBounds(label);
    const mid = (bounds.top + bounds.bottom) / 2;
    const idx = state.categories.findIndex(c => c.id === label.dataset.group);

    return y < mid ? idx : idx + 1;
  }


  function onMove(event) {

    const idx = targetAt(event.clientX, event.clientY);

    clearHighlight();

    if (idx === null) {
      return;
    }

    targetIndex = idx;
    moved = true;

    /* 그 자리에 실제로 놓일 때 바로 위/아래가 되는 카테고리를
       강조해서, 어디에 들어갈지 미리 보여준다. */
    const labels = categoryLabelElements();
    const after = labels[idx - 1];
    const before = labels[idx] && labels[idx] !== labelEl ? labels[idx] : null;

    if (before) {
      before.classList.add("drag-over");
    } else if (after && after !== labelEl) {
      after.classList.add("drag-over");
    }
  }


  function onEnd() {

    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
    window.removeEventListener("pointercancel", onEnd);

    labelEl.classList.remove("dragging");
    document.body.classList.remove("is-dragging");
    clearHighlight();

    try {
      handle.releasePointerCapture(startEvent.pointerId);
    } catch (error) {
      // 무시
    }

    if (moved) {
      saveCategoryOrder(groupId, targetIndex);
    }
  }


  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
  window.addEventListener("pointercancel", onEnd);
}


async function saveCategoryOrder(groupId, targetIndex) {

  const from = state.categories.findIndex(c => c.id === groupId);

  if (from === -1) {
    return;
  }

  const [moved] = state.categories.splice(from, 1);

  let to = targetIndex;

  if (to > from) {
    to -= 1; // 자기 자신을 먼저 뺐으므로 뒤쪽 목표 지점은 하나 당겨진다.
  }

  to = Math.max(0, Math.min(to, state.categories.length));

  state.categories.splice(to, 0, moved);

  renderTaskColumn();
  renderTimeline();

  try {

    await apiPost("reorderCategories", {
      ids: state.categories.map(c => c.id)
    });

    showToast("카테고리 순서를 저장했습니다.");

  } catch (error) {

    alert("순서 저장 실패\n" + error.message);
    await loadData(false);
  }
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


function resetRange() {

  const days = windowTotalDays();

  state.rangeStart = 0;
  state.rangeEnd = days - 1;
}


/* =========================================================
 * RANGE SLIDER  (좌우 확대/축소, 상하 표시 범위 공용)
 *
 * 손잡이 두 개(a, b)와 그 사이를 잇는 막대로 이루어진, 완전히 직접
 * 만든 슬라이더다. (이전에는 <input type="range"> 두 개를 겹쳐 쓰다가
 * 왼쪽 손잡이가 움직이지 않는 문제가 있었다.)
 *   - 손잡이를 끌면 그 쪽 끝만 움직인다.
 *   - 가운데 막대를 끌면 두 끝의 간격을 유지한 채 통째로 옮겨진다(평행이동).
 * ========================================================= */

function buildRangeSlider(container, opts) {

  if (!container) {
    return null;
  }

  const horizontal = opts.orientation !== "v";

  /* 손잡이 절반이 컨테이너 가장자리 밖으로 나가면(특히 .gantt처럼
     overflow:hidden인 조상 안에서는) 그 부분이 잘려서 클릭이 안 먹는
     "죽은 자리"가 생긴다. 양 끝에 손잡이 반지름만큼 여백을 둬서 막는다. */
  const inset = opts.inset || 0;

  container.innerHTML =
    '<div class="range-track"></div>' +
    '<div class="range-bar"></div>' +
    '<div class="range-handle range-handle-a" tabindex="0" role="slider"></div>' +
    '<div class="range-handle range-handle-b" tabindex="0" role="slider"></div>';

  const bar = container.querySelector(".range-bar");
  const handleA = container.querySelector(".range-handle-a");
  const handleB = container.querySelector(".range-handle-b");

  function unitSize() {

    const rect = container.getBoundingClientRect();
    const size = Math.max(1, (horizontal ? rect.width : rect.height) - inset * 2);
    const total = Math.max(1, opts.getTotal());

    return { rect, size, unit: total > 1 ? size / total : size };
  }

  function layout() {

    const { unit } = unitSize();
    const [start, end] = opts.getRange();

    const p1 = inset + start * unit;
    const p2 = inset + (end + 1) * unit;

    if (horizontal) {

      bar.style.left = p1 + "px";
      bar.style.width = Math.max(2, p2 - p1) + "px";
      handleA.style.left = p1 + "px";
      handleB.style.left = p2 + "px";

    } else {

      bar.style.top = p1 + "px";
      bar.style.height = Math.max(2, p2 - p1) + "px";
      handleA.style.top = p1 + "px";
      handleB.style.top = p2 + "px";
    }
  }

  function unitAt(clientPos) {

    const { rect, unit } = unitSize();

    const rel = (horizontal ? clientPos - rect.left : clientPos - rect.top) - inset;

    const total = opts.getTotal();

    return Math.max(0, Math.min(total - 1, Math.floor(rel / unit)));
  }

  function pos(event) {
    return horizontal ? event.clientX : event.clientY;
  }

  function drag(onMove) {

    function move(event) {
      onMove(event);
      layout();
      opts.onChange();
    }

    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  handleA.addEventListener("pointerdown", event => {

    event.preventDefault();

    drag(e2 => {

      const value = unitAt(pos(e2));
      const [, end] = opts.getRange();

      opts.setRange(Math.min(value, end), end);
    });
  });

  handleB.addEventListener("pointerdown", event => {

    event.preventDefault();

    drag(e2 => {

      const value = unitAt(pos(e2));
      const [start] = opts.getRange();

      opts.setRange(start, Math.max(value, start));
    });
  });

  /* 가운데 막대: 간격을 유지한 채 평행이동 */
  bar.addEventListener("pointerdown", event => {

    event.preventDefault();

    const { unit } = unitSize();
    const startPos = pos(event);
    const [s0, e0] = opts.getRange();
    const width = e0 - s0;

    drag(e2 => {

      const deltaUnits = Math.round((pos(e2) - startPos) / unit);

      const total = opts.getTotal();

      let start = Math.max(0, Math.min(total - 1 - width, s0 + deltaUnits));

      opts.setRange(start, start + width);
    });
  });

  return { layout };
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
 * CAPTURE  (지금 확대 상태와 무관하게, 연도 전체를 이미지로 저장)
 *
 * 화면의 확대/축소 상태를 그대로 두고, 화면 밖(-99999px)에 그 연도
 * 전체(1/1~12/31, 모든 카테고리·작업을 원래 크기로)를 따로 그려서
 * 캡처한 뒤 없앤다. 작업이 많은 연도일수록 이미지가 길어진다.
 * ========================================================= */

const CAPTURE_PX_PER_DAY = 8;

function buildCaptureChart() {

  const totalDays = windowTotalDays();
  const width = totalDays * CAPTURE_PX_PER_DAY;

  const rows = buildRows(); // 세로 확대와 무관하게 전체 줄
  const heights = rows.map(rowHeightOf);
  const contentHeight = heights.reduce((a, b) => a + b, 0);

  const root = document.createElement("div");

  root.className = "gantt capture-gantt";
  root.style.cssText =
    "position:fixed; left:-99999px; top:0; width:" +
    (260 + width) + "px; height:" +
    (52 + contentHeight) + "px;";

  /* 왼쪽 목록 */
  const col = document.createElement("div");

  col.className = "task-column";

  const header = document.createElement("div");

  header.className = "task-header";
  header.textContent =
    (state.customStart
      ? dateKey(getYearStart()) + " ~ " + dateKey(getYearEnd())
      : state.year + "년") + " 작업";

  col.appendChild(header);

  const rowsInnerLeft = document.createElement("div");

  rowsInnerLeft.className = "rows-inner";

  col.appendChild(rowsInnerLeft);

  rows.forEach((row, i) => {

    if (row.kind === "category") {

      const group = row.group;
      const category = document.createElement("div");

      category.className = "category-label";
      category.style.height = heights[i] + "px";

      if (group.id) {

        const dot = document.createElement("span");

        dot.className = "cat-dot";
        dot.style.background = validHex(group.color) || DEFAULT_COLOR;

        category.appendChild(dot);
      }

      const name = document.createElement("span");

      name.className = "category-label-name";
      name.textContent = group.name;

      category.appendChild(name);

      rowsInnerLeft.appendChild(category);

      return;
    }

    const task = row.task;
    const card = document.createElement("div");

    card.className = "task-card";
    card.style.height = heights[i] + "px";

    card.innerHTML =
      '<div class="task-name">' + escapeHtml(task.name) + "</div>";

    rowsInnerLeft.appendChild(card);
  });


  /* 오른쪽 타임라인 */
  const timelineEl = document.createElement("div");

  timelineEl.className = "timeline";
  timelineEl.style.overflow = "visible";

  const inner = document.createElement("div");

  inner.className = "timeline-inner";
  inner.style.width = width + "px";
  inner.style.setProperty(
    "--week-width",
    (CAPTURE_PX_PER_DAY * 7) + "px"
  );

  timelineEl.appendChild(inner);


  /* 월 + 주 헤더 (연도 전체 기준) */
  const headerRow = document.createElement("div");

  headerRow.className = "week-header";

  const monthRow = document.createElement("div");

  monthRow.className = "month-row";

  const monthCols = [];
  let acc = 0;

  /* (추가분) 커스텀 기간이 없으면 windowMonths()가 예전처럼
     state.year의 1~12월 12개를, 각 달의 실제 날짜수로 돌려준다. */
  windowMonths().forEach(({ month, days }) => {

    const cell = document.createElement("div");

    cell.className =
      "month-cell" + (month % 2 === 1 ? " alt" : "");

    cell.textContent = (month + 1) + "월";

    monthRow.appendChild(cell);
    monthCols.push((days * CAPTURE_PX_PER_DAY) + "px");

    acc += days;
  });

  monthRow.style.gridTemplateColumns = monthCols.join(" ");
  headerRow.appendChild(monthRow);

  const weekRow = document.createElement("div");

  weekRow.className = "week-row";

  const weekCols = [];

  for (let offset = 0; offset < totalDays; offset += 7) {

    const days = Math.min(7, totalDays - offset);
    const date = dateFromYearDay(offset);
    const cell = document.createElement("div");

    cell.className = "week-cell";
    cell.textContent =
      (date.getMonth() + 1) + "/" + date.getDate();

    weekRow.appendChild(cell);
    weekCols.push((days * CAPTURE_PX_PER_DAY) + "px");
  }

  weekRow.style.gridTemplateColumns = weekCols.join(" ");
  headerRow.appendChild(weekRow);

  inner.appendChild(headerRow);


  /* 월별 뒷배경 */
  const bands = document.createElement("div");

  bands.className = "month-bands";

  /* 공용 .month-bands 스타일은 세로 창(뷰포트) 기준으로 top:0 인데,
     여기서는 그런 창이 없으니 헤더(52px) 아래부터 시작하도록
     직접 지정한다. 안 그러면 배경이 헤더 글자를 덮어 버린다. */
  bands.style.top = "52px";

  let dayAcc = 0;

  windowMonths().forEach(({ month, days }) => {

    const band = document.createElement("div");

    band.className =
      "month-band" + (month % 2 === 1 ? " alt" : "");

    band.style.left = (dayAcc * CAPTURE_PX_PER_DAY) + "px";
    band.style.width = (days * CAPTURE_PX_PER_DAY) + "px";

    bands.appendChild(band);
    dayAcc += days;
  });

  inner.appendChild(bands);


  /* 줄 */
  const rowsInnerRight = document.createElement("div");

  rowsInnerRight.className = "rows-inner";

  inner.appendChild(rowsInnerRight);

  rows.forEach((row, i) => {

    if (row.kind === "category") {

      const categoryRow = document.createElement("div");

      categoryRow.className = "timeline-category";
      categoryRow.style.height = heights[i] + "px";

      rowsInnerRight.appendChild(categoryRow);

      return;
    }

    const task = row.task;
    const barRow = document.createElement("div");

    barRow.className = "timeline-task-row";
    barRow.style.height = heights[i] + "px";

    if (task.start && task.end) {

      const start = dateObj(task.start);
      const end = dateObj(task.end);

      if (start && end) {

        const yearStart = getYearStart();
        const yearEnd = getYearEnd();
        const clippedStart = start < yearStart ? yearStart : start;
        const clippedEnd = end > yearEnd ? yearEnd : end;

        if (clippedStart <= clippedEnd) {

          const startDay = dayOffsetFromYearStart(clippedStart);
          const endDay = dayOffsetFromYearStart(clippedEnd);

          const bar = document.createElement("div");

          bar.className = "task-bar";

          const color = validHex(task.color) || DEFAULT_COLOR;

          if (isLightColor(color)) {
            bar.classList.add("light");
          }

          bar.style.top = "0px";
          bar.style.height = heights[i] + "px";
          bar.style.left = (startDay / totalDays * 100) + "%";
          bar.style.width =
            ((endDay - startDay + 1) / totalDays * 100) + "%";
          bar.style.background = color;

          const progress =
            Math.max(0, Math.min(100, Number(task.progress) || 0));

          bar.innerHTML =
            '<div class="task-progress" style="width:' +
            progress + '%"></div>' +
            '<div class="task-bar-text">' +
            escapeHtml(task.name) + "&nbsp;" + progress + "%</div>";

          barRow.appendChild(bar);
        }
      }
    }

    rowsInnerRight.appendChild(barRow);
  });


  root.appendChild(col);
  root.appendChild(timelineEl);

  return root;
}


async function captureChart() {

  const button = document.getElementById("captureBtn");

  if (typeof html2canvas === "undefined") {
    alert("캡처 기능을 불러오지 못했습니다. 인터넷 연결을 확인하세요.");
    return;
  }

  await withBusy(button, "캡처 중…", async () => {

    const root = buildCaptureChart();

    document.body.appendChild(root);

    try {

      // 폰트/레이아웃이 자리 잡을 시간을 아주 조금 준다.
      await new Promise(resolve => setTimeout(resolve, 50));

      const canvas = await html2canvas(root, {
        backgroundColor: "#ffffff",
        scale: 2
      });

      const link = document.createElement("a");

      // 한글 파일명은 일부 브라우저/환경에서 저장 시 깨지거나
      // "download"로만 저장되는 경우가 있어, 영문+숫자로 안전하게 만든다.
      link.download = "gantt-chart-" + state.year + ".png";
      link.href = canvas.toDataURL("image/png");
      link.click();

      showToast(state.year + "년 전체 차트를 저장했습니다.");

    } catch (error) {

      alert("캡처 실패\n" + error.message);

    } finally {

      root.remove();
    }
  });
}


const captureBtn = document.getElementById("captureBtn");

if (captureBtn) {
  captureBtn.onclick = captureChart;
}


/* =========================================================
 * YEAR PICKER  (연도 숫자를 누르면 나오는 연도 선택창)
 *
 * - 12개 연도를 격자로 보여 준다. 좌우 화살표로 12년씩 넘긴다.
 * - 선택한 연도는 파랗게, 올해는 테두리로, 일정이 있는 해는 점으로 표시한다.
 * - 연도를 누르면 그 해의 간트차트가 표시된다.
 * - 바깥을 누르거나 Esc 를 누르면 닫힌다. 방향키로도 고를 수 있다.
 * ========================================================= */

let yearPickerStart = new Date().getFullYear() - 5;


function yearHasTasks(year) {

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  return state.tasks.some(
    task =>
      task.start &&
      task.end &&
      task.start <= to &&
      task.end >= from
  );
}


function getYearPicker() {

  let picker = document.getElementById("yearPicker");

  if (picker) {
    return picker;
  }

  picker = document.createElement("div");

  picker.id = "yearPicker";
  picker.className = "year-picker hidden";

  picker.setAttribute("role", "dialog");
  picker.setAttribute("aria-label", "연도 선택");

  (document.querySelector(".control-bar") || document.body)
    .appendChild(picker);

  /* 창 안쪽을 누를 때는 바깥 클릭으로 취급하지 않는다. */
  picker.addEventListener("click", event => {

    event.stopPropagation();

    const nav = event.target.closest(".yp-nav");

    if (nav) {
      yearPickerStart += Number(nav.dataset.page) * 12;
      renderYearPicker();
      return;
    }

    const year = event.target.closest(".yp-year");

    if (year) {
      selectYear(Number(year.dataset.year));
      return;
    }

    if (event.target.closest(".yp-today")) {
      selectYear(new Date().getFullYear());
    }
  });

  picker.addEventListener("keydown", event => {

    const buttons = [...picker.querySelectorAll(".yp-year")];

    const index = buttons.indexOf(document.activeElement);

    if (index === -1) {
      return;
    }

    const step = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -4,
      ArrowDown: 4
    }[event.key];

    if (step !== undefined) {

      event.preventDefault();

      if (buttons[index + step]) {
        buttons[index + step].focus();
      }

      return;
    }

    if (event.key === "PageUp" || event.key === "PageDown") {

      event.preventDefault();

      yearPickerStart += (event.key === "PageUp" ? -12 : 12);

      renderYearPicker();

      const next = picker.querySelectorAll(".yp-year")[index];

      if (next) {
        next.focus();
      }
    }
  });

  return picker;
}


function isYearPickerOpen() {

  const picker = document.getElementById("yearPicker");

  return Boolean(picker && !picker.classList.contains("hidden"));
}


function renderYearPicker() {

  const picker = getYearPicker();

  const thisYear = new Date().getFullYear();

  const years = Array.from({ length: 12 }, (_, i) => yearPickerStart + i);

  picker.innerHTML = `

    <div class="yp-head">

      <button
        type="button"
        class="yp-nav"
        data-page="-1"
        aria-label="이전 연도 목록"
      >‹</button>

      <span class="yp-range">${years[0]} – ${years[11]}</span>

      <button
        type="button"
        class="yp-nav"
        data-page="1"
        aria-label="다음 연도 목록"
      >›</button>

    </div>

    <div class="yp-grid" role="listbox" aria-label="연도">
      ${years.map(year => `
        <button
          type="button"
          role="option"
          class="yp-year${year === state.year ? " selected" : ""}${year === thisYear ? " this-year" : ""}${yearHasTasks(year) ? " has-tasks" : ""}"
          data-year="${year}"
          aria-selected="${year === state.year}"
        >${year}</button>
      `).join("")}
    </div>

    <div class="yp-foot">

      <button type="button" class="yp-today">올해로 이동</button>

      <span class="yp-legend"><i></i>일정 있음</span>

    </div>

  `;
}


function openYearPicker() {

  yearPickerStart = state.year - 5;

  renderYearPicker();

  getYearPicker().classList.remove("hidden");

  const trigger = document.getElementById("yearTitle");

  if (trigger) {
    trigger.setAttribute("aria-expanded", "true");
  }

  const selected = getYearPicker().querySelector(".yp-year.selected");

  if (selected) {
    selected.focus();
  }
}


function closeYearPicker(returnFocus = false) {

  const picker = document.getElementById("yearPicker");

  if (picker) {
    picker.classList.add("hidden");
  }

  const trigger = document.getElementById("yearTitle");

  if (trigger) {
    trigger.setAttribute("aria-expanded", "false");

    if (returnFocus) {
      trigger.focus();
    }
  }
}


function selectYear(year) {

  closeYearPicker(true);

  if (year !== state.year) {
    changeYear(year - state.year);
  }
}


const yearTitleButton = document.getElementById("yearTitle");

if (yearTitleButton) {

  yearTitleButton.classList.add("year-title");

  yearTitleButton.setAttribute("aria-haspopup", "dialog");
  yearTitleButton.setAttribute("aria-expanded", "false");

  /* 예전 index.html 처럼 button 이 아니어도 누를 수 있게 한다. */
  if (yearTitleButton.tagName !== "BUTTON") {

    yearTitleButton.tabIndex = 0;
    yearTitleButton.setAttribute("role", "button");

    yearTitleButton.addEventListener("keydown", event => {

      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        yearTitleButton.click();
      }
    });
  }

  yearTitleButton.addEventListener("click", event => {

    event.stopPropagation();

    if (isYearPickerOpen()) {
      closeYearPicker();
    } else {
      openYearPicker();
    }
  });
}


/* 바깥을 누르면 닫는다. */
document.addEventListener("click", event => {

  if (!isYearPickerOpen()) {
    return;
  }

  const trigger = document.getElementById("yearTitle");

  if (trigger && trigger.contains(event.target)) {
    return;
  }

  closeYearPicker();
});


/* =========================================================
 * TODAY / FULL
 * ========================================================= */

const todayBtn = document.getElementById("todayBtn");

if (todayBtn) {

  todayBtn.onclick = () => {

    const today = new Date();

    state.year = today.getFullYear();

    const day = dayOfYear(today);

    const totalDays = windowTotalDays();

    /* 오늘 전후 30일 (현재 연도를 벗어나지 않는다) */
    const start = Math.max(0, day - 30);
    const end = Math.min(totalDays - 1, day + 30);

    state.rangeStart = start;
    state.rangeEnd = end;

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


/* 확대/축소(좌우) + 표시 범위(상하) 슬라이더 */
let hSlider = null;
let vSlider = null;

hSlider = buildRangeSlider(document.getElementById("hRangeSlider"), {
  orientation: "h",
  inset: 10,
  getTotal: () => windowTotalDays(),
  getRange: () => [state.rangeStart, state.rangeEnd],
  setRange: (start, end) => {
    state.rangeStart = start;
    state.rangeEnd = end;
  },
  onChange: () => {
    renderTimeline();
    updateRangeLabel();
  }
});

/* 차트 전체 높이 손잡이: .gantt 맨 아래를 끌면 세로로 늘고 준다. */
const heightHandle = document.getElementById("chartHeightHandle");

if (heightHandle) {

  const MIN_CHART_HEIGHT = 160;
  const MAX_CHART_HEIGHT = 1400;

  heightHandle.addEventListener("pointerdown", event => {

    event.preventDefault();

    const startY = event.clientY;
    const startHeight = state.chartHeight;

    function move(e2) {

      state.chartHeight = Math.max(
        MIN_CHART_HEIGHT,
        Math.min(MAX_CHART_HEIGHT, startHeight + (e2.clientY - startY))
      );

      applyGanttHeight();
      computeRowScale();
      renderTaskColumn();
      renderTimeline();
    }

    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}


vSlider = buildRangeSlider(document.getElementById("vRangeSlider"), {
  orientation: "v",
  inset: 8,
  getTotal: () => Math.max(1, state.rowsTotal || 1),
  getRange: () => [state.rowStart || 0, state.rowEnd || 0],
  setRange: (start, end) => {
    state.rowStart = start;
    state.rowEnd = end;
  },
  onChange: () => {
    computeRowScale();
    renderTaskColumn();
    renderTimeline();
  }
});


/* =========================================================
 * ESC
 * ========================================================= */

document.addEventListener("keydown", event => {

  if (event.key !== "Escape") {
    return;
  }

  /* 연도 선택창 */
  if (isYearPickerOpen()) {
    closeYearPicker(true);
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
 * VERSION CHECK
 * ========================================================= */

function checkVersions() {

  const meta = document.querySelector('meta[name="app-version"]');

  const htmlVersion = meta ? meta.content : "(없음)";

  const cssVersion =
    (
      getComputedStyle(document.documentElement)
        .getPropertyValue("--css-version") || ""
    ).replace(/["'\s]/g, "") || "(없음)";

  const same =
    htmlVersion === APP_VERSION &&
    cssVersion === APP_VERSION;

  let note = document.getElementById("versionNote");

  if (!note) {

    note = document.createElement("div");

    note.id = "versionNote";
    note.className = "version-note";

    (document.querySelector("main") || document.body).appendChild(note);
  }

  if (same) {

    note.classList.remove("mismatch");
    note.textContent = "화면 버전 " + APP_VERSION;

  } else {

    note.classList.add("mismatch");

    note.textContent =
      "⚠ 파일 버전이 서로 다릅니다 " +
      "(index.html: " + htmlVersion +
      " / app.js: " + APP_VERSION +
      " / style.css: " + cssVersion + "). " +
      "세 파일을 모두 새 것으로 올렸는지 확인하고 " +
      "Ctrl+F5 로 새로고침하세요.";
  }
}


/* =========================================================
 * ▼▼▼ 멀티 차트 SHELL (추가분) ▼▼▼
 * 이 아래부터는 "주소에 ?chart= 가 없을 때"만 쓰이는 코드다.
 * 기존 함수(request, apiPost, showToast, askKey, clearKey 등)를
 * 그대로 재사용하고, 새 함수만 추가한다. 기존 간트차트 로직은
 * 전혀 호출하지 않는다 (그 쪽은 그대로 숨겨 둘 뿐).
 * ========================================================= */

let shellChartsCache = [];

function shellRangeLabel(chart) {
  if (chart.rangeStart && chart.rangeEnd) {
    return chart.rangeStart + " ~ " + chart.rangeEnd;
  }
  return "표시 기간: 박스 안에서 설정";
}

async function shellLoadCharts() {
  try {
    const result = await apiPost("listCharts");
    shellChartsCache = Array.isArray(result.result) ? result.result : [];
    shellRenderList();
  } catch (error) {
    console.error(error);
    showToast(error.message || "차트 목록을 불러오지 못했습니다.", true, 0);
  }
}

function shellRenderList() {
  const root = document.getElementById("mcChartList");
  const empty = document.getElementById("mcEmpty");

  const existing = {};
  root.querySelectorAll(".mc-chart-box").forEach((box) => {
    existing[box.dataset.chartId] = box;
  });

  const visible = shellChartsCache.filter((c) => !c.hidden);
  empty.classList.toggle("hidden", visible.length > 0);

  const seen = {};
  visible.forEach((chart) => {
    seen[chart.id] = true;
    let box = existing[chart.id];

    if (!box) {
      box = document.createElement("div");
      box.className = "mc-chart-box";
      box.dataset.chartId = chart.id;

      const head = document.createElement("div");
      head.className = "mc-chart-box-head";

      /* (추가분) 접기/펼치기 토글: 펼친 상태엔 ▼ 만, 접힌 상태엔 ▶ + "펼치기". */
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mc-chart-toggle";
      toggle.setAttribute("aria-expanded", "true");
      toggle.title = "접기/펼치기";
      toggle.innerHTML =
        '<span class="mc-chart-toggle-arrow">▼</span>' +
        '<span class="mc-chart-toggle-label"></span>';
      head.appendChild(toggle);

      const headInfo = document.createElement("div");
      headInfo.className = "mc-chart-box-headinfo";

      const name = document.createElement("div");
      name.className = "mc-chart-box-name";
      headInfo.appendChild(name);

      const range = document.createElement("div");
      range.className = "mc-chart-box-range";
      headInfo.appendChild(range);

      head.appendChild(headInfo);

      box.appendChild(head);

      toggle.addEventListener("click", () => {
        const collapsed = box.classList.toggle("mc-chart-box-collapsed");
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.querySelector(".mc-chart-toggle-arrow").textContent =
          collapsed ? "▶" : "▼";
        toggle.querySelector(".mc-chart-toggle-label").textContent =
          collapsed ? "펼치기" : "";
      });

      const wrap = document.createElement("div");
      wrap.className = "mc-chart-iframe-wrap";

      const iframe = document.createElement("iframe");
      // 같은 index.html 을 ?chart=아이디 로 다시 열면, 그 창은 "그 차트 하나짜리"
      // 기존 화면 그대로 동작한다 (위 IS_SHELL_MODE 분기 참고).
      iframe.src = "index.html?chart=" + encodeURIComponent(chart.id);
      iframe.setAttribute("scrolling", "no");
      iframe.addEventListener("load", () => shellAutoResize(iframe));

      wrap.appendChild(iframe);
      box.appendChild(wrap);

      root.appendChild(box);
    }

    box.querySelector(".mc-chart-box-name").textContent = chart.name;
    box.querySelector(".mc-chart-box-range").textContent = shellRangeLabel(chart);
  });

  Object.keys(existing).forEach((id) => {
    if (!seen[id]) existing[id].remove();
  });
}

function shellAutoResize(iframe) {
  const sync = () => {
    try {
      const doc = iframe.contentDocument;
      if (!doc || !doc.documentElement) return;

      /* (수정) 기존에는 documentElement.scrollHeight와 body.scrollHeight 중
         "더 큰 값"을 썼는데, 이 페이지의 html/body는 둘 다 min-height:100%
         이라서 documentElement.scrollHeight는 실제 내용 높이가 아니라
         "iframe이 지금 몇 px인지"를 거의 그대로 따라간다. 그러면 한 번
         커진 높이가 절대 줄어들지 않는 피드백 루프가 생겨서(최댓값만 취하므로),
         차트 높이를 줄여도 박스 아래에 빈 여백이 계속 남는 버그가 된다.
         실제 내용 높이는 body.scrollHeight 쪽이 정확하므로 그것만 쓴다. */
      const h = doc.body ? doc.body.scrollHeight : 0;
      if (h > 0) iframe.style.height = h + "px";
    } catch (error) {
      /* cross-origin 등으로 못 읽으면 기본 높이로 둔다. */
    }
  };

  sync();

  try {
    const doc = iframe.contentDocument;
    if (doc && doc.body && "ResizeObserver" in iframe.contentWindow) {
      const observer = new iframe.contentWindow.ResizeObserver(sync);
      observer.observe(doc.body);
    } else {
      [300, 800, 1500].forEach((t) => setTimeout(sync, t));
    }
  } catch (error) {
    [300, 800, 1500].forEach((t) => setTimeout(sync, t));
  }
}

function shellOpenModal(id) { document.getElementById(id).classList.remove("hidden"); }
function shellCloseModal(id) { document.getElementById(id).classList.add("hidden"); }

function shellRenderManageRows() {
  const root = document.getElementById("mcManageRows");
  root.innerHTML = "";

  shellChartsCache.forEach((chart) => {
    const row = document.createElement("div");
    row.className = "mc-manage-row";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = chart.name;
    nameInput.maxLength = 200;
    row.appendChild(nameInput);

    if (chart.hidden) {
      const badge = document.createElement("span");
      badge.className = "mc-manage-badge";
      badge.textContent = "숨김";
      row.appendChild(badge);
    }

    const saveBtn = document.createElement("button");
    saveBtn.className = "mc-btn mc-btn-ghost";
    saveBtn.type = "button";
    saveBtn.textContent = "이름 저장";
    saveBtn.addEventListener("click", () => withBusy(saveBtn, "저장 중…", async () => {
      const newName = nameInput.value.trim();
      if (!newName) { showToast("이름을 입력하세요.", true); return; }
      try {
        await apiPost("updateChart", { data: { id: chart.id, name: newName } });
        showToast("이름을 바꿨습니다.");
        await shellLoadCharts();
        shellRenderManageRows();
      } catch (error) {
        showToast(error.message || "변경하지 못했습니다.", true, 0);
      }
    }));
    row.appendChild(saveBtn);

    const toggleBtn = document.createElement("button");
    toggleBtn.className = "mc-btn mc-btn-ghost";
    toggleBtn.type = "button";
    toggleBtn.textContent = chart.hidden ? "보이기" : "숨기기";
    toggleBtn.addEventListener("click", () => withBusy(toggleBtn, "변경 중…", async () => {
      try {
        await apiPost("updateChart", { data: { id: chart.id, hidden: !chart.hidden } });
        showToast(chart.hidden ? "다시 보이게 했습니다." : "숨겼습니다.");
        await shellLoadCharts();
        shellRenderManageRows();
      } catch (error) {
        showToast(error.message || "변경하지 못했습니다.", true, 0);
      }
    }));
    row.appendChild(toggleBtn);

    if (chart.id !== "default") {
      const delBtn = document.createElement("button");
      delBtn.className = "mc-btn mc-btn-danger";
      delBtn.type = "button";
      delBtn.textContent = "삭제";
      delBtn.addEventListener("click", () => withBusy(delBtn, "삭제 중…", async () => {
        if (!confirm('"' + chart.name + '" 차트를 완전히 삭제할까요? 이 차트의 모든 데이터가 함께 삭제되며 되돌릴 수 없습니다.')) {
          return;
        }
        try {
          await apiPost("deleteChart", { id: chart.id });
          showToast("삭제했습니다.");
          await shellLoadCharts();
          shellRenderManageRows();
        } catch (error) {
          showToast(error.message || "삭제하지 못했습니다.", true, 0);
        }
      }));
      row.appendChild(delBtn);
    }

    root.appendChild(row);
  });
}

function initShell() {
  document.querySelectorAll("#shellView [data-close]").forEach((btn) => {
    btn.addEventListener("click", () => shellCloseModal(btn.dataset.close));
  });

  document.getElementById("mcAddBtn").addEventListener("click", () => {
    document.getElementById("mcAddName").value = "";
    shellOpenModal("mcAddModal");
  });

  document.getElementById("mcAddSaveBtn").addEventListener("click", () => withBusy(
    document.getElementById("mcAddSaveBtn"), "추가 중…", async () => {
      const name = document.getElementById("mcAddName").value.trim();
      if (!name) { showToast("차트 이름을 입력하세요.", true); return; }
      try {
        await apiPost("createChart", { data: { name } });
        shellCloseModal("mcAddModal");
        showToast("차트를 추가했습니다.");
        await shellLoadCharts();
      } catch (error) {
        showToast(error.message || "추가하지 못했습니다.", true, 0);
      }
    }
  ));

  document.getElementById("mcManageBtn").addEventListener("click", async () => {
    await shellLoadCharts();
    shellRenderManageRows();
    shellOpenModal("mcManageModal");
  });

  document.getElementById("mcKeyBtn").addEventListener("click", () => {
    clearKey();
    if (askKey()) {
      showToast("키를 저장했습니다.");
      shellLoadCharts();
    }
  });

  document.getElementById("mcReloadBtn").addEventListener("click", () => {
    shellLoadCharts();
  });

  shellLoadCharts();
}
/* ▲▲▲ 멀티 차트 SHELL (추가분) 끝 ▲▲▲ */


/* =========================================================
 * ▼▼▼ 멀티 차트: 이 차트의 커스텀 표시 기간 (추가분) ▼▼▼
 * ========================================================= */

/** 이 차트(CHART_ID)의 저장된 표시 기간을 서버에서 읽어 state에 반영하고,
 *  입력칸도 채워 둔다. 설정된 게 없으면 아무것도 안 바뀐다(기존 동작 그대로). */
async function loadChartRangeMeta() {
  try {
    const result = await apiPost("listCharts");
    const list = Array.isArray(result.result) ? result.result : [];
    const mine = list.find(c => c.id === CHART_ID);

    if (mine && mine.rangeStart && mine.rangeEnd) {
      state.customStart = dateObj(mine.rangeStart);
      state.customEnd = dateObj(mine.rangeEnd);
      state.year = state.customStart.getFullYear();
    }

    const startInput = document.getElementById("chartRangeStart");
    const endInput = document.getElementById("chartRangeEnd");
    if (startInput) startInput.value = mine && mine.rangeStart ? mine.rangeStart : "";
    if (endInput) endInput.value = mine && mine.rangeEnd ? mine.rangeEnd : "";

    /* (추가분) 상단 브랜드 영역에 "Gantt Chart" 대신 이 차트의 실제 이름을 표시 */
    state.chartName =
      (mine && mine.name) ||
      (CHART_ID === "default" ? "기본 차트" : "");
    applyChartNameLabel();

  } catch (error) {
    console.error(error);
    // 못 읽어와도 기존(연도 기준) 동작으로 계속 진행한다.
  }
}

/** 브랜드 영역의 차트 이름 표시를 state.chartName 으로 맞춘다. */
function applyChartNameLabel() {
  const label = document.getElementById("chartNameLabel");
  if (label) {
    label.textContent = state.chartName || "Gantt Chart";
  }
}

/** 상단 브랜드 영역의 차트 이름을 눌러서 수정 -> 시트(Charts 탭)에 저장.
 *  (수정) 브라우저 기본 prompt() 팝업 대신, 작업명을 두 번 눌러 고치는 것과
 *  같은 방식으로 그 자리에서 바로 입력칸으로 바뀌어 수정한다. */
function initChartNameUI() {
  const label = document.getElementById("chartNameLabel");
  if (!label) {
    return;
  }

  function startEdit() {

    if (label.querySelector(".chart-name-edit")) {
      return;
    }

    const original = state.chartName || label.textContent || "";

    label.textContent = "";

    const input = document.createElement("input");

    input.type = "text";
    input.className = "chart-name-edit";
    input.value = original;

    label.appendChild(input);
    input.focus();
    input.select();

    let done = false;

    async function finish(save) {

      if (done) {
        return;
      }

      done = true;

      const value = input.value.trim();

      if (save && value && value !== original) {

        label.textContent = value;

        try {
          await apiPost("updateChart", { data: { id: CHART_ID, name: value } });
          state.chartName = value;
          showToast("차트 이름을 저장했습니다.");
        } catch (error) {
          label.textContent = original;
          showToast(error.message || "이름을 저장하지 못했습니다.", true, 0);
        }

      } else {

        label.textContent = original;
      }
    }

    input.addEventListener("blur", () => finish(true));

    input.addEventListener("keydown", event => {

      event.stopPropagation();

      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        done = true;
        label.textContent = original;
      }
    });

    input.addEventListener("click", event => event.stopPropagation());
  }

  label.addEventListener("click", startEdit);

  label.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      startEdit();
    }
  });
}

function initChartRangeUI() {
  const saveBtn = document.getElementById("chartRangeSaveBtn");
  const clearBtn = document.getElementById("chartRangeClearBtn");
  const startInput = document.getElementById("chartRangeStart");
  const endInput = document.getElementById("chartRangeEnd");

  if (saveBtn) {
    saveBtn.addEventListener("click", () => withBusy(saveBtn, "저장 중…", async () => {
      const startVal = startInput ? startInput.value : "";
      const endVal = endInput ? endInput.value : "";

      if (!startVal || !endVal) {
        showToast("시작일과 종료일을 모두 입력하세요.", true);
        return;
      }
      if (endVal < startVal) {
        showToast("종료일은 시작일보다 빠를 수 없습니다.", true);
        return;
      }

      try {
        await apiPost("updateChart", {
          data: { id: CHART_ID, rangeStart: startVal, rangeEnd: endVal }
        });
        state.customStart = dateObj(startVal);
        state.customEnd = dateObj(endVal);
        state.year = state.customStart.getFullYear();
        resetRange();
        render();
        showToast("표시 기간을 저장했습니다.");
      } catch (error) {
        showToast(error.message || "저장하지 못했습니다.", true, 0);
      }
    }));
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => withBusy(clearBtn, "전환 중…", async () => {
      try {
        await apiPost("updateChart", {
          data: { id: CHART_ID, rangeStart: "", rangeEnd: "" }
        });
        state.customStart = null;
        state.customEnd = null;
        state.year = new Date().getFullYear();
        if (startInput) startInput.value = "";
        if (endInput) endInput.value = "";
        resetRange();
        render();
        showToast("연도 보기로 전환했습니다.");
      } catch (error) {
        showToast(error.message || "전환하지 못했습니다.", true, 0);
      }
    }));
  }
}
/* ▲▲▲ 멀티 차트: 커스텀 표시 기간 (추가분) 끝 ▲▲▲ */


/* =========================================================
 * INITIALIZE
 * ========================================================= */

if (IS_SHELL_MODE) {

  /* ===== 멀티 차트 (추가분): 주소에 ?chart= 가 없으면, 기존 단일 차트
     화면(#chartSingleView)은 숨기고 관리 틀(#shellView)만 켠다.
     기존 초기화(checkVersions/setupDrag/resetRange/loadData)는
     실행하지 않는다 — 어차피 화면에 안 보이고, 그 대신 아래
     initShell()이 이 틀 전용 로직을 돈다. ===== */
  const singleView = document.getElementById("chartSingleView");
  if (singleView) singleView.style.display = "none";

  const shellView = document.getElementById("shellView");
  if (shellView) shellView.style.display = "";

  initShell();

} else {

  checkVersions();

  setupDrag();

  initChartRangeUI();
  initChartNameUI();

  /* (추가분) 이 차트의 저장된 커스텀 표시 기간을 먼저 읽어온 뒤에
     범위를 초기화하고 데이터를 불러온다. 커스텀 기간이 없으면
     state는 전혀 안 바뀌므로 기존과 완전히 동일하게 동작한다. */
  (async () => {
    await loadChartRangeMeta();

    /* 현재 연도(또는 커스텀 기간)의 전체 범위로 초기화 */
    resetRange();

    /* 데이터 불러오기 */
    loadData();
  })();
}
