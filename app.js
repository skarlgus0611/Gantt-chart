const API_URL =
  "https://script.google.com/macros/s/AKfycbx33KL-l94mz08Q8rWJHYrGUXyipmxrm02z3Y26OR20V9q5V2diZRFIzvyFpqio-0Jg8Q/exec";

const EDIT_KEY =
  "21cb42f7a0ea44838dea501764474553";


let state = {

  tasks: [],

  categories: [],

  year:
    new Date().getFullYear(),

  rangeStart: 0,

  rangeEnd: 364,

  selectedTask: null,

  draggingTaskId: null

};


/* =================================================
 * API
 * ================================================= */

async function apiGet() {

  const response =
    await fetch(
      API_URL +
      "?api=1&key=" +
      encodeURIComponent(
        EDIT_KEY
      )
    );

  const result =
    await response.json();

  if (!result.ok) {
    throw new Error(
      result.error ||
      "API 오류"
    );
  }

  return result.data;
}


async function apiPost(
  action,
  data = {}
) {

  const response =
    await fetch(
      API_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "text/plain;charset=utf-8"
        },

        body:
          JSON.stringify({

            action,

            key:
              EDIT_KEY,

            ...data

          })

      }
    );

  const result =
    await response.json();

  if (!result.ok) {

    throw new Error(
      result.error ||
      "저장 실패"
    );

  }

  return result;
}


/* =================================================
 * 초기화
 * ================================================= */

async function loadData() {

  try {

    const data =
      await apiGet();

    state.tasks =
      data.tasks || [];

    state.categories =
      data.categories || [];

    render();

  } catch (error) {

    console.error(error);

    alert(
      "데이터를 불러오지 못했습니다.\n" +
      error.message
    );

  }

}


/* =================================================
 * 날짜
 * ================================================= */

function dateObj(
  value
) {

  const [
    y,
    m,
    d
  ] =
    value
      .split("-")
      .map(Number);

  return new Date(
    y,
    m - 1,
    d
  );

}


function dateKey(
  date
) {

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


function dayOfYear(
  date
) {

  const start =
    new Date(
      date.getFullYear(),
      0,
      1
    );

  return Math.floor(
    (
      date - start
    ) /
    86400000
  );

}


function daysInYear(
  year
) {

  return (
    new Date(
      year + 1,
      0,
      1
    ) -
    new Date(
      year,
      0,
      1
    )
  ) /
  86400000;

}


/* =================================================
 * Render
 * ================================================= */

function render() {

  document
    .getElementById(
      "yearTitle"
    )
    .textContent =
    state.year;

  renderTaskColumn();

  renderTimeline();

}


/* =================================================
 * 작업 왼쪽
 * ================================================= */

function renderTaskColumn() {

  const column =
    document.getElementById(
      "taskColumn"
    );

  column.innerHTML = "";

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


  const grouped =
    groupTasks();


  grouped.forEach(group => {

    const cat =
      document.createElement(
        "div"
      );

    cat.className =
      "category-label";

    cat.textContent =
      group.name;

    column.appendChild(
      cat
    );


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

  });

}


/* =================================================
 * 카테고리 그룹
 * ================================================= */

function groupTasks() {

  const groups = [];

  state.categories.forEach(
    category => {

      groups.push({

        id:
          category.id,

        name:
          category.name,

        tasks:
          state.tasks.filter(
            task =>
              task.categoryId ===
              category.id
          )

      });

    }
  );


  const uncategorized =
    state.tasks.filter(
      task =>
        !state.categories.some(
          c =>
            c.id ===
            task.categoryId
        )
    );


  if (
    uncategorized.length
  ) {

    groups.push({

      id: "",

      name: "기타",

      tasks:
        uncategorized

    });

  }


  return groups;
}


/* =================================================
 * Timeline
 * ================================================= */

function renderTimeline() {

  const timeline =
    document.getElementById(
      "timeline"
    );

  timeline.innerHTML = "";


  const inner =
    document.createElement(
      "div"
    );

  inner.className =
    "timeline-inner";


  const totalDays =
    daysInYear(
      state.year
    );


  const visibleDays =
    Math.max(
      1,
      state.rangeEnd -
      state.rangeStart +
      1
    );


  const width =
    Math.max(
      900,
      visibleDays * 8
    );

  inner.style.width =
    width + "px";


  const weekWidth =
    width /
    Math.ceil(
      visibleDays / 7
    );

  inner.style
    .setProperty(
      "--week-width",
      weekWidth + "px"
    );


  renderWeekHeader(
    inner,
    totalDays,
    visibleDays,
    width
  );


  const groups =
    groupTasks();


  groups.forEach(
    group => {

      const catRow =
        document.createElement(
          "div"
        );

      catRow.className =
        "timeline-category";

      inner.appendChild(
        catRow
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


  renderTodayLine(
    inner,
    totalDays,
    visibleDays,
    width
  );


  timeline.appendChild(
    inner
  );

}


/* =================================================
 * 주 헤더
 * ================================================= */

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
      end.getDate() +
      6
    );


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


/* =================================================
 * Task bar
 * ================================================= */

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
    dateObj(
      task.start
    );

  const end =
    dateObj(
      task.end
    );


  const startDay =
    dayOfYear(start);

  const endDay =
    dayOfYear(end);


  const visibleStart =
    state.rangeStart;

  const visibleEnd =
    state.rangeEnd;


  if (
    endDay <
    visibleStart ||
    startDay >
    visibleEnd
  ) {
    return;
  }


  const clippedStart =
    Math.max(
      startDay,
      visibleStart
    );

  const clippedEnd =
    Math.min(
      endDay,
      visibleEnd
    );


  const left =
    (
      clippedStart -
      visibleStart
    ) /
    visibleDays *
    100;


  const width =
    (
      clippedEnd -
      clippedStart +
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


  bar.innerHTML = `

    <div
      class="task-progress"
      style="width:${task.progress}%"
    ></div>

    <div class="task-bar-text">

      ${escapeHtml(task.name)}

      &nbsp;

      ${task.progress}%

    </div>

  `;


  bar.addEventListener(
    "click",
    () => {

      showTaskDetail(
        task.id
      );

    }
  );


  row.appendChild(
    bar
  );

}


/* =================================================
 * 오늘 표시
 * ================================================= */

function renderTodayLine(
  inner,
  totalDays,
  visibleDays,
  width
) {

  const today =
    new Date();

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
      visibleDays
    ) *
    100 +
    "%";


  inner.appendChild(
    line
  );

}


/* =================================================
 * 상세정보
 * ================================================= */

function showTaskDetail(
  id
) {

  const task =
    state.tasks.find(
      t =>
        t.id === id
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


  panel.classList.remove(
    "hidden"
  );


  const categoryOptions =
    state.categories
      .map(
        cat => `
          <option
            value="${escapeAttr(cat.id)}"
            ${
              cat.id ===
              task.categoryId
                ? "selected"
                : ""
            }
          >
            ${escapeHtml(cat.name)}
          </option>
        `
      )
      .join("");


  panel.innerHTML = `

    <div class="detail-title">

      <h2>
        ${escapeHtml(task.name)}
      </h2>

      <button
        id="closeDetail"
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
          value="${task.start}"
        >

      </div>


      <div class="detail-item">

        <span>종료일</span>

        <input
          id="detailEnd"
          type="date"
          value="${task.end}"
        >

      </div>


      <div class="detail-item">

        <span>진행률</span>

        <input
          id="detailProgress"
          type="number"
          min="0"
          max="100"
          value="${task.progress}"
        >

      </div>


      <div class="detail-item">

        <span>막대 색상</span>

        <input
          id="detailColor"
          type="color"
          value="${task.color || "#3B82F6"}"
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
      >
        삭제
      </button>

      <button
        id="saveDetailBtn"
        class="primary"
      >
        저장
      </button>

    </div>

  `;


  document
    .getElementById(
      "closeDetail"
    )
    .onclick =
    () => {

      panel.classList.add(
        "hidden"
      );

    };


  document
    .getElementById(
      "saveDetailBtn"
    )
    .onclick =
    () => saveTaskDetail(
      task.id
    );


  document
    .getElementById(
      "deleteTaskBtn"
    )
    .onclick =
    () => deleteTask(
      task.id
    );

}


/* =================================================
 * 작업 수정 저장
 * ================================================= */

async function saveTaskDetail(
  id
) {

  try {

    const data = {

      id,

      name:
        document
          .getElementById(
            "detailName"
          )
          .value,

      categoryId:
        document
          .getElementById(
            "detailCategory"
          )
          .value,

      start:
        document
          .getElementById(
            "detailStart"
          )
          .value,

      end:
        document
          .getElementById(
            "detailEnd"
          )
          .value,

      progress:
        document
          .getElementById(
            "detailProgress"
          )
          .value,

      color:
        document
          .getElementById(
            "detailColor"
          )
          .value,

      memo:
        document
          .getElementById(
            "detailMemo"
          )
          .value,

      target:
        document
          .getElementById(
            "detailTarget"
          )
          .value,

      owner:
        document
          .getElementById(
            "detailOwner"
          )
          .value

    };


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


    showTaskDetail(
      id
    );


  } catch (error) {

    alert(
      "저장 실패\n" +
      error.message
    );

  }

}


/* =================================================
 * 작업 삭제
 * ================================================= */

async function deleteTask(
  id
) {

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


    document
      .getElementById(
        "detailPanel"
      )
      .classList.add(
        "hidden"
      );


    await loadData();


  } catch (error) {

    alert(
      "삭제 실패\n" +
      error.message
    );

  }

}


/* =================================================
 * 작업 추가
 * ================================================= */

function openTaskModal() {

  const select =
    document.getElementById(
      "taskCategory"
    );


  select.innerHTML =
    state.categories
      .map(
        cat => `
          <option value="${cat.id}">
            ${escapeHtml(cat.name)}
          </option>
        `
      )
      .join("");


  const today =
    new Date();

  const todayString =
    dateKey(today);


  document
    .getElementById(
      "taskStart"
    )
    .value =
    todayString;


  document
    .getElementById(
      "taskEnd"
    )
    .value =
    todayString;


  document
    .getElementById(
      "taskName"
    )
    .value = "";


  document
    .getElementById(
      "taskProgress"
    )
    .value = 0;


  document
    .getElementById(
      "taskMemo"
    )
    .value = "";


  document
    .getElementById(
      "taskTarget"
    )
    .value = "";


  document
    .getElementById(
      "taskOwner"
    )
    .value = "";


  document
    .getElementById(
      "taskModal"
    )
    .classList.remove(
      "hidden"
    );

}


async function saveNewTask() {

  const name =
    document
      .getElementById(
        "taskName"
      )
      .value
      .trim();


  if (!name) {

    alert(
      "작업명을 입력해주세요."
    );

    return;

  }


  const start =
    document
      .getElementById(
        "taskStart"
      )
      .value;


  const end =
    document
      .getElementById(
        "taskEnd"
      )
      .value;


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
            document
              .getElementById(
                "taskCategory"
              )
              .value,

          start,

          end,

          progress:
            document
              .getElementById(
                "taskProgress"
              )
              .value,

          color:
            document
              .getElementById(
                "taskColor"
              )
              .value,

          memo:
            document
              .getElementById(
                "taskMemo"
              )
              .value,

          target:
            document
              .getElementById(
                "taskTarget"
              )
              .value,

          owner:
            document
              .getElementById(
                "taskOwner"
              )
              .value

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


/* =================================================
 * Category 추가
 * ================================================= */

function openCategoryModal() {

  document
    .getElementById(
      "categoryName"
    )
    .value = "";


  document
    .getElementById(
      "categoryModal"
    )
    .classList.remove(
      "hidden"
    );

}


async function saveNewCategory() {

  const name =
    document
      .getElementById(
        "categoryName"
      )
      .value
      .trim();


  if (!name) {

    alert(
      "카테고리명을 입력해주세요."
    );

    return;

  }


  const color =
    document
      .getElementById(
        "categoryColor"
      )
      .value;


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


/* =================================================
 * Drag & Drop
 * ================================================= */

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

            element.setPointerCapture(
              event.pointerId
            );

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


      const cards =
        [
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
    async event => {

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
                t => t.id
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
      t =>
        t.id === fromId
    );


  const toIndex =
    state.tasks.findIndex(
      t =>
        t.id === toId
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


/* =================================================
 * Zoom range
 * ================================================= */

function updateRange() {

  let min =
    Number(
      document
        .getElementById(
          "rangeMin"
        )
        .value
    );


  let max =
    Number(
      document
        .getElementById(
          "rangeMax"
        )
        .value
    );


  if (
    min >= max
  ) {

    if (
      this &&
      this.id ===
      "rangeMin"
    ) {

      min =
        max - 1;

    } else {

      max =
        min + 1;

    }

  }


  state.rangeStart =
    min;

  state.rangeEnd =
    max;


  renderTimeline();

}


/* =================================================
 * 연도
 * ================================================= */

document
  .getElementById(
    "prevYear"
  )
  .onclick =
  () => {

    state.year--;

    resetRange();

    render();

  };


document
  .getElementById(
    "nextYear"
  )
  .onclick =
  () => {

    state.year++;

    resetRange();

    render();

  };


function resetRange() {

  const days =
    daysInYear(
      state.year
    );

  state.rangeStart =
    0;

  state.rangeEnd =
    days - 1;


  document
    .getElementById(
      "rangeMin"
    )
    .max =
    days - 1;

  document
    .getElementById(
      "rangeMax"
    )
    .max =
    days - 1;


  document
    .getElementById(
      "rangeMin"
    )
    .value = 0;

  document
    .getElementById(
      "rangeMax"
    )
    .value =
    days - 1;

}


/* =================================================
 * 오늘
 * ================================================= */

document
  .getElementById(
    "todayBtn"
  )
  .onclick =
  () => {

    const today =
      new Date();


    state.year =
      today.getFullYear();


    const day =
      dayOfYear(
        today
      );


    const start =
      Math.max(
        0,
        day - 30
      );


    const end =
      Math.min(
        daysInYear(
          state.year
        ) - 1,
        day + 30
      );


    state.rangeStart =
      start;

    state.rangeEnd =
      end;


    document
      .getElementById(
        "rangeMin"
      )
      .max =
      daysInYear(
        state.year
      ) - 1;


    document
      .getElementById(
        "rangeMax"
      )
      .max =
      daysInYear(
        state.year
      ) - 1;


    document
      .getElementById(
        "rangeMin"
      )
      .value =
      start;


    document
      .getElementById(
        "rangeMax"
      )
      .value =
      end;


    render();

  };


/* =================================================
 * 모달
 * ================================================= */

function closeModal(
  id
) {

  document
    .getElementById(
      id
    )
    .classList.add(
      "hidden"
    );

}


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


document
  .getElementById(
    "addTaskBtn"
  )
  .onclick =
  openTaskModal;


document
  .getElementById(
    "saveTaskBtn"
  )
  .onclick =
  saveNewTask;


document
  .getElementById(
    "addCategoryBtn"
  )
  .onclick =
  openCategoryModal;


document
  .getElementById(
    "saveCategoryBtn"
  )
  .onclick =
  saveNewCategory;


document
  .getElementById(
    "reloadBtn"
  )
  .onclick =
  loadData;


document
  .getElementById(
    "rangeMin"
  )
  .addEventListener(
    "input",
    updateRange
  );


document
  .getElementById(
    "rangeMax"
  )
  .addEventListener(
    "input",
    updateRange
  );


/* =================================================
 * HTML escape
 * ================================================= */

function escapeHtml(
  value
) {

  return String(value || "")
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


/* =================================================
 * 시작
 * ================================================= */

resetRange();

loadData();
