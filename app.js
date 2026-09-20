const API_URL =
  "https://script.google.com/macros/s/AKfycbx33KL-l94mz08Q8rWJHYrGUXyipmxrm02z3Y26OR20V9q5V2diZRFIzvyFpqio-0Jg8Q/exec";

const EDIT_KEY =
  "21cb42f7a0ea44838dea501764474553";


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
  draggingTaskId: null
};


/* =========================================================
 * API
 * ========================================================= */

async function apiGet() {
  const response = await fetch(
    API_URL +
    "?api=1&key=" +
    encodeURIComponent(EDIT_KEY)
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      result.error || "API 오류"
    );
  }

  return result.data;
}


async function apiPost(action, data = {}) {
  const response = await fetch(
    API_URL,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "text/plain;charset=utf-8"
      },

      body: JSON.stringify({
        action,
        key: EDIT_KEY,
        ...data
      })
    }
  );

  const result = await response.json();

  if (!result.ok) {
    throw new Error(
      result.error || "저장 실패"
    );
  }

  return result;
}


/* =========================================================
 * DATA LOAD
 * ========================================================= */

async function loadData() {
  try {
    const data = await apiGet();

    state.tasks =
      Array.isArray(data.tasks)
        ? data.tasks
        : [];

    state.categories =
      Array.isArray(data.categories)
        ? data.categories
        : [];

    render();

  } catch (error) {
    console.error(error);

    alert(
      "데이터를 불러오지 못했습니다.\n" +
      error.message
    );
  }
}


/* =========================================================
 * DATE
 * ========================================================= */

function dateObj(value) {
  if (!value) return null;

  const [
    y,
    m,
    d
  ] = String(value)
    .split("-")
    .map(Number);

  return new Date(
    y,
    m - 1,
    d
  );
}


function dateKey(date) {
  return [
    date.getFullYear(),

    String(
      date.getMonth() + 1
    ).padStart(2, "0"),

    String(
      date.getDate()
    ).padStart(2, "0")

  ].join("-");
}


function dayOfYear(date) {
  const start =
    new Date(
      date.getFullYear(),
      0,
      1
    );

  return Math.floor(
    (
      date.getTime() -
      start.getTime()
    ) /
    86400000
  );
}


function daysInYear(year) {
  return (
    new Date(
      year + 1,
      0,
      1
    ).getTime() -
    new Date(
      year,
      0,
      1
    ).getTime()
  ) / 86400000;
}


/*
 * 선택된 연도의 1월 1일
 */
function getYearStart() {
  return new Date(
    state.year,
    0,
    1
  );
}


/*
 * 선택된 연도의 12월 31일
 */
function getYearEnd() {
  return new Date(
    state.year,
    11,
    31
  );
}


/*
 * 선택된 연도 1월 1일부터 몇 번째 날인지
 */
function dayOffsetFromYearStart(date) {
  const start = getYearStart();

  return Math.floor(
    (
      date.getTime() -
      start.getTime()
    ) /
    86400000
  );
}


/* =========================================================
 * RENDER
 * ========================================================= */

function render() {

  const yearTitle =
    document.getElementById(
      "yearTitle"
    );

  if (yearTitle) {
    yearTitle.textContent =
      state.year;
  }

  renderTaskColumn();
  renderTimeline();

  // 폰트/레이아웃 계산이 끝난 다음 한 번 더 맞춘다.
  requestAnimationFrame(() => {
    syncGanttRows();

    requestAnimationFrame(() => {
      syncGanttRows();
    });

    setTimeout(
      syncGanttRows,
      100
    );
  });
}


/* =========================================================
 * TASK / CATEGORY GROUP
 *
 * 핵심:
 *
 * 1. 선택한 연도에 걸쳐 있는 작업만 표시
 *
 *    시작일 <= 선택연도 12/31
 *    &&
 *    종료일 >= 선택연도 1/1
 *
 * 2. 전년도부터 이어진 작업은 가장 위
 *
 * 3. 그런 작업이 있는 카테고리도 가장 위
 *
 * 4. 다른 연도에만 존재하는 카테고리는 숨김
 *
 * 5. 삭제된 카테고리의 작업은 "기타"
 * ========================================================= */

function groupTasks() {

  const yearStart =
    `${state.year}-01-01`;

  const yearEnd =
    `${state.year}-12-31`;


  /*
   * 선택한 연도에 실제로 걸쳐 있는 작업만 가져온다.
   *
   * 예:
   *
   * 2025-12-20 ~ 2026-01-20
   * → 2025에도 표시
   * → 2026에도 표시
   *
   * 2025-01-01 ~ 2025-12-31
   * → 2026에는 표시하지 않음
   */
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


  /*
   * 전년도부터 현재 연도로 넘어온 작업
   */
  function isContinuing(task) {
    return (
      task.start < yearStart &&
      task.end >= yearStart
    );
  }


  const groups = [];


  /*
   * 카테고리 순서 자체는
   * Categories 시트의 순서를 기본적으로 유지한다.
   *
   * 단,
   * 전년도에서 이어진 작업이 하나라도 있는
   * 카테고리는 최상단으로 이동한다.
   */
  state.categories.forEach(
    category => {

      const tasks =
        visibleTasks.filter(
          task =>
            task.categoryId ===
            category.id
        );

      if (!tasks.length) {
        return;
      }


      const continuing =
        tasks.filter(
          isContinuing
        );

      const newTasks =
        tasks.filter(
          task =>
            !isContinuing(task)
        );


      groups.push({
        id: category.id,

        name: category.name,

        tasks: [
          ...continuing,
          ...newTasks
        ],

        hasContinuing:
          continuing.length > 0
      });
    }
  );


  /*
   * 카테고리 안에서
   * 이어진 작업이 있는 카테고리를 위로
   */
  groups.sort(
    (a, b) => {

      if (
        a.hasContinuing !==
        b.hasContinuing
      ) {
        return a.hasContinuing
          ? -1
          : 1;
      }

      return 0;
    }
  );


  /*
   * 카테고리가 삭제된 작업
   *
   * → 기타
   */
  const uncategorized =
    visibleTasks.filter(
      task =>
        !state.categories.some(
          category =>
            category.id ===
            task.categoryId
        )
    );


  if (uncategorized.length) {

    const continuing =
      uncategorized.filter(
        isContinuing
      );

    const newTasks =
      uncategorized.filter(
        task =>
          !isContinuing(task)
      );


    groups.push({
      id: "",

      name: "기타",

      tasks: [
        ...continuing,
        ...newTasks
      ],

      hasContinuing:
        continuing.length > 0
    });


    /*
     * 기타도 이어진 작업이 있으면
     * 최상단으로 올린다.
     */
    groups.sort(
      (a, b) => {

        if (
          a.hasContinuing !==
          b.hasContinuing
        ) {
          return a.hasContinuing
            ? -1
            : 1;
        }

        return 0;
      }
    );
  }


  return groups;
}


/* =========================================================
 * LEFT TASK COLUMN
 * ========================================================= */

function renderTaskColumn() {

  const column =
    document.getElementById(
      "taskColumn"
    );

  if (!column) {
    return;
  }


  column.innerHTML = "";


  /*
   * Header
   */
  const header =
    document.createElement(
      "div"
    );

  header.className =
    "task-header";

  header.textContent =
    "작업";

  column.appendChild(
    header
  );


  const groups =
    groupTasks();


  groups.forEach(
    group => {

      /*
       * Category row
       */
      const category =
        document.createElement(
          "div"
        );

      category.className =
        "category-label";


      /*
       * 카테고리 이름 + 삭제 버튼
       */
      const name =
        document.createElement(
          "span"
        );

      name.className =
        "category-label-name";

      name.textContent =
        group.name;


      category.appendChild(
        name
      );


      /*
       * "기타"는 실제 카테고리가 아니므로
       * 삭제 버튼을 만들지 않는다.
       */
      if (group.id) {

        const deleteButton =
          document.createElement(
            "button"
          );

        deleteButton.type =
          "button";

        deleteButton.className =
          "category-delete-btn";

        deleteButton.textContent =
          "×";

        deleteButton.title =
          "카테고리 삭제";

        deleteButton.setAttribute(
          "aria-label",
          group.name +
          " 카테고리 삭제"
        );


        /*
         * CSS가 없어도 버튼이
         * 기본 UI를 망가뜨리지 않도록
         * 최소한의 스타일을 직접 넣는다.
         */
        deleteButton.style.flex =
          "0 0 auto";

        deleteButton.style.width =
          "24px";

        deleteButton.style.height =
          "24px";

        deleteButton.style.padding =
          "0";

        deleteButton.style.margin =
          "0";

        deleteButton.style.border =
          "0";

        deleteButton.style.background =
          "transparent";

        deleteButton.style.cursor =
          "pointer";

        deleteButton.style.fontSize =
          "18px";

        deleteButton.style.lineHeight =
          "1";

        deleteButton.style.color =
          "inherit";


        deleteButton.addEventListener(
          "click",
          event => {

            event.preventDefault();
            event.stopPropagation();

            deleteCategory(
              group.id,
              group.name
            );
          }
        );


        category.style.display =
          "flex";

        category.style.alignItems =
          "center";

        category.style.justifyContent =
          "space-between";

        category.style.gap =
          "8px";


        category.appendChild(
          deleteButton
        );
      }


      column.appendChild(
        category
      );


      /*
       * Tasks
       */
      group.tasks.forEach(
        task => {

          const card =
            document.createElement(
              "div"
            );

          card.className =
            "task-card";

          card.dataset.id =
            task.id;


          card.innerHTML = `
            <div class="task-name">
              ${escapeHtml(task.name)}
            </div>
          `;


          setupTaskDrag(
            card,
            task
          );


          card.addEventListener(
            "click",
            () => {

              if (
                state.draggingTaskId
              ) {
                return;
              }

              showTaskDetail(
                task.id
              );
            }
          );


          column.appendChild(
            card
          );
        }
      );
    }
  );
}


/* =========================================================
 * TIMELINE
 * ========================================================= */

function renderTimeline() {

  const timeline =
    document.getElementById(
      "timeline"
    );

  if (!timeline) {
    return;
  }


  timeline.innerHTML =
    "";


  const inner =
    document.createElement(
      "div"
    );

  inner.className =
    "timeline-inner";


  /*
   * 화면은 반드시 선택된 한 해만 사용
   */
  const totalDays =
    daysInYear(
      state.year
    );


  /*
   * range 역시 선택 연도 안에서만 움직인다.
   */
  state.rangeStart =
    Math.max(
      0,
      Math.min(
        state.rangeStart,
        totalDays - 1
      )
    );

  state.rangeEnd =
    Math.max(
      state.rangeStart,
      Math.min(
        state.rangeEnd,
        totalDays - 1
      )
    );


  const visibleDays =
    state.rangeEnd -
    state.rangeStart +
    1;


  const width =
    Math.max(
      900,
      visibleDays * 8
    );


  inner.style.width =
    width + "px";


  const weekCount =
    Math.ceil(
      visibleDays / 7
    );


  const weekWidth =
    width /
    weekCount;


  inner.style.setProperty(
    "--week-width",
    weekWidth + "px"
  );


  /*
   * 주 헤더
   */
  renderWeekHeader(
    inner,
    totalDays,
    visibleDays,
    width
  );


  /*
   * Category + Task rows
   */
  const groups =
    groupTasks();


  groups.forEach(
    group => {

      const categoryRow =
        document.createElement(
          "div"
        );

      categoryRow.className =
        "timeline-category";


      inner.appendChild(
        categoryRow
      );


      group.tasks.forEach(
        task => {

          const row =
            document.createElement(
              "div"
            );

          row.className =
            "timeline-task-row";


          renderTaskBar(
            row,
            task,
            totalDays,
            visibleDays
          );


          inner.appendChild(
            row
          );
        }
      );
    }
  );


  /*
   * 오늘 선
   */
  renderTodayLine(
    inner,
    totalDays,
    visibleDays,
    width
  );


  timeline.appendChild(
    inner
  );


  requestAnimationFrame(
    syncGanttRows
  );
}


/* =========================================================
 * WEEK HEADER
 * ========================================================= */

function renderWeekHeader(
  inner,
  totalDays,
  visibleDays,
  width
) {

  const header =
    document.createElement(
      "div"
    );

  header.className =
    "week-header";


  const weeks =
    Math.ceil(
      visibleDays / 7
    );


  header.style.gridTemplateColumns =
    `repeat(${weeks}, minmax(34px, 1fr))`;


  for (
    let i = 0;
    i < weeks;
    i++
  ) {

    const absoluteDay =
      state.rangeStart +
      i * 7;


    if (
      absoluteDay >=
      totalDays
    ) {
      break;
    }


    const date =
      new Date(
        state.year,
        0,
        1
      );


    date.setDate(
      date.getDate() +
      absoluteDay
    );


    const end =
      new Date(date);


    end.setDate(
      end.getDate() + 6
    );


    /*
     * 연도 밖으로 넘어가는
     * 주 헤더는 12/31까지만 의미가 있도록
     * title을 조정한다.
     */
    const yearEnd =
      getYearEnd();

    if (end > yearEnd) {
      end.setTime(
        yearEnd.getTime()
      );
    }


    const cell =
      document.createElement(
        "div"
      );

    cell.className =
      "week-cell";


    cell.textContent =
      `${date.getMonth() + 1}/${date.getDate()}`;


    cell.title =
      `${dateKey(date)} ~ ${dateKey(end)}`;


    header.appendChild(
      cell
    );
  }


  inner.appendChild(
    header
  );
}


/* =========================================================
 * TASK BAR
 *
 * 중요:
 *
 * 날짜가 여러 해에 걸쳐 있어도
 * 현재 선택한 연도에 맞춰 잘라서 표시한다.
 *
 * 예:
 *
 * 2025-12-20 ~ 2026-01-20
 *
 * 2025 화면:
 * 12/20 ~ 12/31
 *
 * 2026 화면:
 * 01/01 ~ 01/20
 * ========================================================= */

function renderTaskBar(
  row,
  task,
  totalDays,
  visibleDays
) {

  if (
    !task.start ||
    !task.end
  ) {
    return;
  }


  const start =
    dateObj(task.start);

  const end =
    dateObj(task.end);


  if (!start || !end) {
    return;
  }


  const yearStart =
    getYearStart();

  const yearEnd =
    getYearEnd();


  /*
   * 현재 연도와 전혀 겹치지 않으면
   * 표시하지 않는다.
   */
  if (
    end < yearStart ||
    start > yearEnd
  ) {
    return;
  }


  /*
   * 현재 연도 안에서 잘라낸다.
   */
  const visibleStartDate =
    start < yearStart
      ? yearStart
      : start;


  const visibleEndDate =
    end > yearEnd
      ? yearEnd
      : end;


  let startDay =
    dayOffsetFromYearStart(
      visibleStartDate
    );


  let endDay =
    dayOffsetFromYearStart(
      visibleEndDate
    );


  /*
   * 현재 확대 범위 안에서 다시 잘라낸다.
   */
  if (
    endDay <
    state.rangeStart ||
    startDay >
    state.rangeEnd
  ) {
    return;
  }


  startDay =
    Math.max(
      startDay,
      state.rangeStart
    );


  endDay =
    Math.min(
      endDay,
      state.rangeEnd
    );


  const left =
    (
      startDay -
      state.rangeStart
    ) /
    visibleDays *
    100;


  const width =
    (
      endDay -
      startDay +
      1
    ) /
    visibleDays *
    100;


  const bar =
    document.createElement(
      "div"
    );

  bar.className =
    "task-bar";


  bar.style.left =
    left + "%";

  bar.style.width =
    width + "%";


  bar.style.background =
    task.color ||
    "#3B82F6";


  const progress =
    Math.max(
      0,
      Math.min(
        100,
        Number(task.progress) || 0
      )
    );


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


  bar.addEventListener(
    "click",
    event => {

      event.stopPropagation();

      showTaskDetail(
        task.id
      );
    }
  );


  row.appendChild(
    bar
  );
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

  const today =
    new Date();


  /*
   * 현재 선택한 연도와 다르면
   * 오늘 선을 그리지 않는다.
   */
  if (
    today.getFullYear() !==
    state.year
  ) {
    return;
  }


  const todayDay =
    dayOfYear(today);


  if (
    todayDay <
    state.rangeStart ||
    todayDay >
    state.rangeEnd
  ) {
    return;
  }


  const line =
    document.createElement(
      "div"
    );

  line.className =
    "today-line";


  line.style.left =
    (
      (
        todayDay -
        state.rangeStart
      ) /
      visibleDays *
      100
    ) + "%";


  inner.appendChild(
    line
  );
}


/* =========================================================
 * LEFT / RIGHT ROW HEIGHT SYNC
 *
 * 왼쪽:
 *
 * task-header
 * category-label
 * task-card
 * category-label
 * task-card
 *
 * 오른쪽:
 *
 * week-header
 * timeline-category
 * timeline-task-row
 * timeline-category
 * timeline-task-row
 *
 * 순서대로 1:1 대응시킨다.
 * ========================================================= */

function getOuterHeight(el) {
  const rect = el.getBoundingClientRect();
  const style = window.getComputedStyle(el);

  const marginTop = parseFloat(style.marginTop) || 0;
  const marginBottom = parseFloat(style.marginBottom) || 0;

  return rect.height + marginTop + marginBottom;
}


function syncGanttRows() {
  const taskColumn = document.querySelector(".task-column");
  const timelineInner = document.querySelector(".timeline-inner");

  if (!taskColumn || !timelineInner) return;

  const leftRows = Array.from(
    taskColumn.children
  ).filter(el =>
    el.classList.contains("category-label") ||
    el.classList.contains("task-card")
  );

  const rightRows = Array.from(
    timelineInner.children
  ).filter(el =>
    el.classList.contains("timeline-category") ||
    el.classList.contains("timeline-task-row")
  );

  const count = Math.min(
    leftRows.length,
    rightRows.length
  );

  for (let i = 0; i < count; i++) {
    const left = leftRows[i];
    const right = rightRows[i];

    const height = getOuterHeight(left);

    left.style.height = `${height}px`;
    right.style.height = `${height}px`;

    left.style.minHeight = `${height}px`;
    right.style.minHeight = `${height}px`;

    left.style.maxHeight = `${height}px`;
    right.style.maxHeight = `${height}px`;
  }
}

/* =========================================================
 * TASK DETAIL
 * ========================================================= */

function showTaskDetail(id) {

  const task =
    state.tasks.find(
      item =>
        item.id === id
    );


  if (!task) {
    return;
  }


  state.selectedTask =
    id;


  const panel =
    document.getElementById(
      "detailPanel"
    );


  if (!panel) {
    return;
  }


  panel.classList.remove(
    "hidden"
  );


  /*
   * 카테고리가 삭제된 작업도
   * 상세창에서 "기타"로 볼 수 있게 한다.
   */
  const categoryOptions = [

    `
      <option value="">
        기타
      </option>
    `,

    ...state.categories.map(
      category => `
        <option
          value="${escapeAttr(category.id)}"
          ${
            category.id ===
            task.categoryId
              ? "selected"
              : ""
          }
        >
          ${escapeHtml(category.name)}
        </option>
      `
    )

  ].join("");


  panel.innerHTML = `

    <div class="detail-title">

      <h2>
        ${escapeHtml(task.name)}
      </h2>

      <button
        id="closeDetail"
        type="button"
      >
        ×
      </button>

    </div>


    <div class="detail-grid">

      <div class="detail-item">

        <span>작업명</span>

        <input
          id="detailName"
          value="${escapeAttr(task.name)}"
        >

      </div>


      <div class="detail-item">

        <span>카테고리</span>

        <select
          id="detailCategory"
        >
          ${categoryOptions}
        </select>

      </div>


      <div class="detail-item">

        <span>시작일</span>

        <input
          id="detailStart"
          type="date"
          value="${escapeAttr(task.start)}"
        >

      </div>


      <div class="detail-item">

        <span>종료일</span>

        <input
          id="detailEnd"
          type="date"
          value="${escapeAttr(task.end)}"
        >

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
          value="${escapeAttr(
            task.color || "#3B82F6"
          )}"
        >

      </div>


      <div class="detail-item">

        <span>대상처</span>

        <input
          id="detailTarget"
          value="${escapeAttr(task.target)}"
        >

      </div>


      <div class="detail-item">

        <span>담당자</span>

        <input
          id="detailOwner"
          value="${escapeAttr(task.owner)}"
        >

      </div>

    </div>


    <div class="detail-memo">

      <span>메모</span>

      <textarea
        id="detailMemo"
      >${escapeHtml(task.memo)}</textarea>

    </div>


    <div class="detail-actions">

      <button
        id="deleteTaskBtn"
        type="button"
      >
        삭제
      </button>

      <button
        id="saveDetailBtn"
        class="primary"
        type="button"
      >
        저장
      </button>

    </div>

  `;


  const closeButton =
    document.getElementById(
      "closeDetail"
    );

  if (closeButton) {
    closeButton.onclick =
      () => {

        panel.classList.add(
          "hidden"
        );

      };
  }


  const saveButton =
    document.getElementById(
      "saveDetailBtn"
    );

  if (saveButton) {
    saveButton.onclick =
      () =>
        saveTaskDetail(
          task.id
        );
  }


  const deleteButton =
    document.getElementById(
      "deleteTaskBtn"
    );

  if (deleteButton) {
    deleteButton.onclick =
      () =>
        deleteTask(
          task.id
        );
  }
}


/* =========================================================
 * SAVE TASK DETAIL
 * ========================================================= */

async function saveTaskDetail(id) {

  try {

    const data = {

      id,

      name:
        document.getElementById(
          "detailName"
        ).value.trim(),

      categoryId:
        document.getElementById(
          "detailCategory"
        ).value,

      start:
        document.getElementById(
          "detailStart"
        ).value,

      end:
        document.getElementById(
          "detailEnd"
        ).value,

      progress:
        document.getElementById(
          "detailProgress"
        ).value,

      color:
        document.getElementById(
          "detailColor"
        ).value,

      memo:
        document.getElementById(
          "detailMemo"
        ).value,

      target:
        document.getElementById(
          "detailTarget"
        ).value,

      owner:
        document.getElementById(
          "detailOwner"
        ).value
    };


    if (!data.name) {

      alert(
        "작업명을 입력해주세요."
      );

      return;
    }


    if (
      !data.start ||
      !data.end
    ) {

      alert(
        "시작일과 종료일을 입력해주세요."
      );

      return;
    }


    if (
      data.start >
      data.end
    ) {

      alert(
        "종료일은 시작일보다 빠를 수 없습니다."
      );

      return;
    }


    await apiPost(
      "update",
      {
        data
      }
    );


    await loadData();


    /*
     * 삭제/수정 후에도
     * 상세창을 다시 보여준다.
     */
    showTaskDetail(id);


  } catch (error) {

    alert(
      "저장 실패\n" +
      error.message
    );
  }
}


/* =========================================================
 * DELETE TASK
 * ========================================================= */

async function deleteTask(id) {

  if (
    !confirm(
      "이 작업을 삭제할까요?"
    )
  ) {
    return;
  }


  try {

    await apiPost(
      "delete",
      {
        id
      }
    );


    state.selectedTask =
      null;


    const panel =
      document.getElementById(
        "detailPanel"
      );


    if (panel) {
      panel.classList.add(
        "hidden"
      );
    }


    await loadData();


  } catch (error) {

    alert(
      "삭제 실패\n" +
      error.message
    );
  }
}


/* =========================================================
 * DELETE CATEGORY
 *
 * 백엔드의 deleteCategory가
 * 카테고리 행만 삭제하므로
 * 해당 카테고리의 작업은 삭제되지 않는다.
 *
 * → 이후 화면에서는 "기타"로 표시된다.
 * ========================================================= */

async function deleteCategory(
  id,
  name
) {

  if (!id) {
    return;
  }


  const confirmed =
    confirm(
      `"${name}" 카테고리를 삭제할까요?\n\n` +
      "카테고리에 속해 있던 작업은 삭제되지 않고 " +
      "'기타'로 남습니다."
    );


  if (!confirmed) {
    return;
  }


  try {

    await apiPost(
      "deleteCategory",
      {
        id
      }
    );


    /*
     * 삭제된 카테고리를 선택 중이었다면
     * 상세창을 닫는다.
     */
    const selected =
      state.tasks.find(
        task =>
          task.id ===
          state.selectedTask
      );


    if (
      selected &&
      selected.categoryId === id
    ) {

      const panel =
        document.getElementById(
          "detailPanel"
        );

      if (panel) {
        panel.classList.add(
          "hidden"
        );
      }

      state.selectedTask =
        null;
    }


    await loadData();


  } catch (error) {

    alert(
      "카테고리 삭제 실패\n" +
      error.message
    );
  }
}


/* =========================================================
 * ADD TASK
 * ========================================================= */

function openTaskModal() {

  const select =
    document.getElementById(
      "taskCategory"
    );


  if (select) {

    select.innerHTML =
      `
        <option value="">
          기타
        </option>
      ` +
      state.categories
        .map(
          category => `
            <option
              value="${escapeAttr(category.id)}"
            >
              ${escapeHtml(category.name)}
            </option>
          `
        )
        .join("");
  }


  const today =
    new Date();

  const todayString =
    dateKey(today);


  const taskStart =
    document.getElementById(
      "taskStart"
    );

  if (taskStart) {
    taskStart.value =
      todayString;
  }


  const taskEnd =
    document.getElementById(
      "taskEnd"
    );

  if (taskEnd) {
    taskEnd.value =
      todayString;
  }


  const taskName =
    document.getElementById(
      "taskName"
    );

  if (taskName) {
    taskName.value = "";
  }


  const taskProgress =
    document.getElementById(
      "taskProgress"
    );

  if (taskProgress) {
    taskProgress.value = 0;
  }


  const taskMemo =
    document.getElementById(
      "taskMemo"
    );

  if (taskMemo) {
    taskMemo.value = "";
  }


  const taskTarget =
    document.getElementById(
      "taskTarget"
    );

  if (taskTarget) {
    taskTarget.value = "";
  }


  const taskOwner =
    document.getElementById(
      "taskOwner"
    );

  if (taskOwner) {
    taskOwner.value = "";
  }


  const modal =
    document.getElementById(
      "taskModal"
    );

  if (modal) {
    modal.classList.remove(
      "hidden"
    );
  }
}


async function saveNewTask() {

  const name =
    document.getElementById(
      "taskName"
    ).value.trim();


  if (!name) {

    alert(
      "작업명을 입력해주세요."
    );

    return;
  }


  const start =
    document.getElementById(
      "taskStart"
    ).value;


  const end =
    document.getElementById(
      "taskEnd"
    ).value;


  if (
    !start ||
    !end
  ) {

    alert(
      "시작일과 종료일을 입력해주세요."
    );

    return;
  }


  if (
    start > end
  ) {

    alert(
      "종료일은 시작일보다 빠를 수 없습니다."
    );

    return;
  }


  try {

    await apiPost(
      "create",
      {
        data: {

          name,

          categoryId:
            document.getElementById(
              "taskCategory"
            ).value,

          start,

          end,

          progress:
            document.getElementById(
              "taskProgress"
            ).value,

          color:
            document.getElementById(
              "taskColor"
            ).value,

          memo:
            document.getElementById(
              "taskMemo"
            ).value,

          target:
            document.getElementById(
              "taskTarget"
            ).value,

          owner:
            document.getElementById(
              "taskOwner"
            ).value
        }
      }
    );


    closeModal(
      "taskModal"
    );


    await loadData();


  } catch (error) {

    alert(
      "작업 추가 실패\n" +
      error.message
    );
  }
}


/* =========================================================
 * ADD CATEGORY
 * ========================================================= */

function openCategoryModal() {

  const name =
    document.getElementById(
      "categoryName"
    );

  if (name) {
    name.value = "";
  }


  const modal =
    document.getElementById(
      "categoryModal"
    );

  if (modal) {
    modal.classList.remove(
      "hidden"
    );
  }
}


async function saveNewCategory() {

  const name =
    document.getElementById(
      "categoryName"
    ).value.trim();


  if (!name) {

    alert(
      "카테고리명을 입력해주세요."
    );

    return;
  }


  const color =
    document.getElementById(
      "categoryColor"
    ).value;


  try {

    await apiPost(
      "createCategory",
      {
        data: {
          name,
          color
        }
      }
    );


    closeModal(
      "categoryModal"
    );


    await loadData();


  } catch (error) {

    alert(
      "카테고리 추가 실패\n" +
      error.message
    );
  }
}


/* =========================================================
 * DRAG & DROP
 * ========================================================= */

function setupTaskDrag(
  element,
  task
) {

  let timer = null;

  let dragging = false;


  element.addEventListener(
    "pointerdown",
    event => {

      if (
        event.button !== 0
      ) {
        return;
      }


      timer =
        setTimeout(
          () => {

            dragging = true;

            state.draggingTaskId =
              task.id;


            element.classList.add(
              "long-pressing"
            );


            try {
              element.setPointerCapture(
                event.pointerId
              );
            } catch (error) {
              // 일부 브라우저에서는
              // capture가 실패할 수 있다.
            }

          },
          450
        );
    }
  );


  element.addEventListener(
    "pointermove",
    event => {

      if (!dragging) {
        return;
      }


      element.classList.add(
        "dragging"
      );


      const cards = [
        ...document.querySelectorAll(
          ".task-card"
        )
      ];


      const target =
        cards.find(
          card => {

            if (
              card ===
              element
            ) {
              return false;
            }


            const rect =
              card.getBoundingClientRect();


            return (
              event.clientY >
              rect.top &&
              event.clientY <
              rect.bottom
            );
          }
        );


      if (target) {

        const targetId =
          target.dataset.id;


        reorderLocal(
          task.id,
          targetId
        );


        render();
      }
    }
  );


  element.addEventListener(
    "pointerup",
    async () => {

      clearTimeout(
        timer
      );


      if (!dragging) {
        return;
      }


      dragging = false;


      element.classList.remove(
        "dragging",
        "long-pressing"
      );


      try {

        await apiPost(
          "reorder",
          {
            ids:
              state.tasks.map(
                task =>
                  task.id
              )
          }
        );


      } catch (error) {

        alert(
          "순서 저장 실패\n" +
          error.message
        );


        await loadData();
      }


      setTimeout(
        () => {

          state.draggingTaskId =
            null;

        },
        100
      );
    }
  );


  element.addEventListener(
    "pointercancel",
    () => {

      clearTimeout(
        timer
      );


      dragging = false;


      element.classList.remove(
        "dragging",
        "long-pressing"
      );


      state.draggingTaskId =
        null;
    }
  );
}


function reorderLocal(
  fromId,
  toId
) {

  if (
    fromId ===
    toId
  ) {
    return;
  }


  const fromIndex =
    state.tasks.findIndex(
      task =>
        task.id ===
        fromId
    );


  const toIndex =
    state.tasks.findIndex(
      task =>
        task.id ===
        toId
    );


  if (
    fromIndex === -1 ||
    toIndex === -1
  ) {
    return;
  }


  const [
    moved
  ] =
    state.tasks.splice(
      fromIndex,
      1
    );


  state.tasks.splice(
    toIndex,
    0,
    moved
  );
}


/* =========================================================
 * ZOOM RANGE
 *
 * 연도는 넘어가지 않는다.
 * range는 선택된 연도 안에서만 움직인다.
 * ========================================================= */

function updateRange() {

  const minElement =
    document.getElementById(
      "rangeMin"
    );

  const maxElement =
    document.getElementById(
      "rangeMax"
    );


  if (
    !minElement ||
    !maxElement
  ) {
    return;
  }


  let min =
    Number(
      minElement.value
    );


  let max =
    Number(
      maxElement.value
    );


  const totalDays =
    daysInYear(
      state.year
    );


  min =
    Math.max(
      0,
      Math.min(
        min,
        totalDays - 1
      )
    );


  max =
    Math.max(
      0,
      Math.min(
        max,
        totalDays - 1
      )
    );


  /*
   * 최소/최대가 같아지는 것을 방지
   */
  if (min >= max) {

    if (
      document.activeElement ===
      minElement
    ) {

      min =
        Math.max(
          0,
          max - 1
        );

    } else {

      max =
        Math.min(
          totalDays - 1,
          min + 1
        );
    }
  }


  state.rangeStart =
    min;

  state.rangeEnd =
    max;


  minElement.value =
    min;

  maxElement.value =
    max;


  renderTimeline();


  requestAnimationFrame(
    syncGanttRows
  );
}


/* =========================================================
 * RESET RANGE
 * ========================================================= */

function resetRange() {

  const days =
    daysInYear(
      state.year
    );


  state.rangeStart =
    0;

  state.rangeEnd =
    days - 1;


  const min =
    document.getElementById(
      "rangeMin"
    );

  const max =
    document.getElementById(
      "rangeMax"
    );


  if (min) {

    min.min = 0;

    min.max =
      days - 1;

    min.value = 0;
  }


  if (max) {

    max.min = 0;

    max.max =
      days - 1;

    max.value =
      days - 1;
  }
}


/* =========================================================
 * YEAR
 * ========================================================= */

function changeYear(
  amount
) {

  state.year +=
    amount;


  /*
   * 연도를 바꾸면
   * 반드시 새 연도 전체를 기본 화면으로 한다.
   */
  resetRange();


  /*
   * 선택한 연도에 존재하지 않는
   * 작업/카테고리는 groupTasks()에서 자동으로 숨겨진다.
   */
  render();
}


/* 이전 연도 */
const prevYear =
  document.getElementById(
    "prevYear"
  );

if (prevYear) {

  prevYear.onclick =
    () => {
      changeYear(-1);
    };
}


/* 다음 연도 */
const nextYear =
  document.getElementById(
    "nextYear"
  );

if (nextYear) {

  nextYear.onclick =
    () => {
      changeYear(1);
    };
}


/* =========================================================
 * TODAY
 * ========================================================= */

const todayBtn =
  document.getElementById(
    "todayBtn"
  );


if (todayBtn) {

  todayBtn.onclick =
    () => {

      const today =
        new Date();


      state.year =
        today.getFullYear();


      const day =
        dayOfYear(
          today
        );


      const totalDays =
        daysInYear(
          state.year
        );


      /*
       * 오늘 전후 30일
       * 단, 현재 연도를 절대로 벗어나지 않는다.
       */
      const start =
        Math.max(
          0,
          day - 30
        );


      const end =
        Math.min(
          totalDays - 1,
          day + 30
        );


      state.rangeStart =
        start;

      state.rangeEnd =
        end;


      const rangeMin =
        document.getElementById(
          "rangeMin"
        );

      const rangeMax =
        document.getElementById(
          "rangeMax"
        );


      if (rangeMin) {

        rangeMin.min = 0;

        rangeMin.max =
          totalDays - 1;

        rangeMin.value =
          start;
      }


      if (rangeMax) {

        rangeMax.min = 0;

        rangeMax.max =
          totalDays - 1;

        rangeMax.value =
          end;
      }


      render();
    };
}


/* =========================================================
 * MODAL
 * ========================================================= */

function closeModal(id) {

  const modal =
    document.getElementById(
      id
    );


  if (!modal) {
    return;
  }


  modal.classList.add(
    "hidden"
  );
}


/*
 * data-close가 있는 버튼
 */
document
  .querySelectorAll(
    "[data-close]"
  )
  .forEach(
    button => {

      button.addEventListener(
        "click",
        () => {

          closeModal(
            button.dataset.close
          );
        }
      );
    }
  );


/*
 * 작업 추가
 */
const addTaskBtn =
  document.getElementById(
    "addTaskBtn"
  );

if (addTaskBtn) {

  addTaskBtn.onclick =
    openTaskModal;
}


const saveTaskBtn =
  document.getElementById(
    "saveTaskBtn"
  );

if (saveTaskBtn) {

  saveTaskBtn.onclick =
    saveNewTask;
}


/*
 * 카테고리 추가
 */
const addCategoryBtn =
  document.getElementById(
    "addCategoryBtn"
  );

if (addCategoryBtn) {

  addCategoryBtn.onclick =
    openCategoryModal;
}


const saveCategoryBtn =
  document.getElementById(
    "saveCategoryBtn"
  );

if (saveCategoryBtn) {

  saveCategoryBtn.onclick =
    saveNewCategory;
}


/*
 * 새로고침
 */
const reloadBtn =
  document.getElementById(
    "reloadBtn"
  );

if (reloadBtn) {

  reloadBtn.onclick =
    loadData;
}


/*
 * 확대/축소 범위
 */
const rangeMin =
  document.getElementById(
    "rangeMin"
  );

if (rangeMin) {

  rangeMin.addEventListener(
    "input",
    updateRange
  );
}


const rangeMax =
  document.getElementById(
    "rangeMax"
  );

if (rangeMax) {

  rangeMax.addEventListener(
    "input",
    updateRange
  );
}


/* =========================================================
 * ESC
 * ========================================================= */

document.addEventListener(
  "keydown",
  event => {

    if (
      event.key !==
      "Escape"
    ) {
      return;
    }


    /*
     * 작업 추가 모달
     */
    const taskModal =
      document.getElementById(
        "taskModal"
      );

    if (
      taskModal &&
      !taskModal.classList.contains(
        "hidden"
      )
    ) {

      taskModal.classList.add(
        "hidden"
      );

      return;
    }


    /*
     * 카테고리 추가 모달
     */
    const categoryModal =
      document.getElementById(
        "categoryModal"
      );

    if (
      categoryModal &&
      !categoryModal.classList.contains(
        "hidden"
      )
    ) {

      categoryModal.classList.add(
        "hidden"
      );

      return;
    }


    /*
     * 상세 패널
     */
    const detailPanel =
      document.getElementById(
        "detailPanel"
      );

    if (
      detailPanel &&
      !detailPanel.classList.contains(
        "hidden"
      )
    ) {

      detailPanel.classList.add(
        "hidden"
      );

      state.selectedTask =
        null;
    }
  }
);


/* =========================================================
 * WINDOW RESIZE
 *
 * 창 크기/폰트 등이 바뀌면
 * 좌우 높이를 다시 맞춘다.
 * ========================================================= */

window.addEventListener(
  "resize",
  () => {

    requestAnimationFrame(
      syncGanttRows
    );
  }
);


/* =========================================================
 * HTML ESCAPE
 * ========================================================= */

function escapeHtml(
  value
) {

  return String(
    value ?? ""
  )

    .replace(
      /&/g,
      "&amp;"
    )

    .replace(
      /</g,
      "&lt;"
    )

    .replace(
      />/g,
      "&gt;"
    )

    .replace(
      /"/g,
      "&quot;"
    )

    .replace(
      /'/g,
      "&#039;"
    );
}


function escapeAttr(
  value
) {

  return escapeHtml(
    value
  );
}


/* =========================================================
 * INITIALIZE
 * ========================================================= */

/*
 * 현재 연도의 전체 범위로 초기화
 */
resetRange();


/*
 * 데이터 불러오기
 */
loadData();
