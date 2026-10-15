const API_URL =
  "https://script.google.com/macros/s/AKfycbyexenF9ADWlQ3kBxOEPZ3g9pjb6v9BBUs0uQDc60AW2CMQCsPQipkGVNtMEQ5BGNhGEw/exec";

const EDIT_KEY =
  "21cb42f7a0ea44838dea501764474553";

const CHART_STORAGE = "gantt_last_chart_id";


/* =========================================================
 * STATE
 * ========================================================= */

let state = {
  // 차트 목록 / 현재 선택된 차트
  charts: [],
  chartId: null,
  chart: null,

  tasks: [],
  categories: [],

  // 화면에 보여줄 전체 날짜 구간 (차트에 설정된 범위, 없으면 올해 1/1~12/31)
  viewStart: null, // Date
  viewEnd: null,    // Date

  // viewStart 기준 0-based day offset. 확대/축소(줌) 윈도우.
  rangeStart: 0,
  rangeEnd: 364,

  selectedTask: null,
  draggingTaskId: null
};


/* =========================================================
 * API
 * ========================================================= */

async function apiPost(action, data = {}) {
  const response = await fetch(
    API_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "text/plain;charset=utf-8"
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
    throw new Error(result.error || "저장 실패");
  }

  return result;
}


/* =========================================================
 * CHART LIST
 * ========================================================= */

async function loadChartList() {
  const res = await apiPost("listCharts");

  state.charts = Array.isArray(res.result) ? res.result : [];

  return state.charts;
}


function visibleCharts() {
  return state.charts.filter(chart => !chart.hidden);
}


function pickInitialChartId(charts) {
  const saved = localStorage.getItem(CHART_STORAGE);

  if (saved && charts.some(chart => chart.id === saved && !chart.hidden)) {
    return saved;
  }

  const visible = charts.filter(chart => !chart.hidden);

  if (visible.length) {
    return visible[0].id;
  }

  return charts.length ? charts[0].id : null;
}


/* =========================================================
 * DATE
 * ========================================================= */

function dateObj(value) {
  if (!value) return null;

  const [y, m, d] = String(value).split("-").map(Number);

  return new Date(y, m - 1, d);
}


function dateKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}


function addDays(date, amount) {
  const d = new Date(date);
  d.setDate(d.getDate() + amount);
  return d;
}


function daysBetween(start, end) {
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}


/*
 * 화면에 표시 가능한 전체 구간(state.viewStart ~ state.viewEnd)
 * 기준으로 며칠째인지 반환한다. (기존의 "연중 몇 번째 날"을 대체)
 */
function dayOffsetFromViewStart(date) {
  return Math.floor((date.getTime() - state.viewStart.getTime()) / 86400000);
}


function totalViewDays() {
  return daysBetween(state.viewStart, state.viewEnd);
}


/*
 * 선택된 차트의 설정을 기준으로 기본 표시 구간을 계산한다.
 *  - 차트에 표시 시작일/종료일이 모두 설정되어 있으면 그 구간
 *  - 아니면 현재 연도 1/1 ~ 12/31
 */
function defaultViewRange(chart) {

  if (chart && chart.rangeStart && chart.rangeEnd) {

    const start = dateObj(chart.rangeStart);
    const end = dateObj(chart.rangeEnd);

    if (start && end && start <= end) {
      return { start, end };
    }
  }

  const year = new Date().getFullYear();

  return {
    start: new Date(year, 0, 1),
    end: new Date(year, 11, 31)
  };
}


/* =========================================================
 * RENDER
 * ========================================================= */

function render() {

  renderRangeTitle();
  renderChartSelect();

  renderTaskColumn();
  renderTimeline();

  // 폰트/레이아웃 계산이 끝난 다음 한 번 더 맞춘다.
  requestAnimationFrame(() => {
    syncGanttRows();

    requestAnimationFrame(() => {
      syncGanttRows();
    });

    setTimeout(syncGanttRows, 100);
  });
}


function renderRangeTitle() {

  const title = document.getElementById("yearTitle");

  if (!title || !state.viewStart || !state.viewEnd) {
    return;
  }

  const sameYear =
    state.viewStart.getFullYear() === state.viewEnd.getFullYear() &&
    state.viewStart.getMonth() === 0 &&
    state.viewStart.getDate() === 1 &&
    state.viewEnd.getMonth() === 11 &&
    state.viewEnd.getDate() === 31;

  if (sameYear) {
    title.textContent = String(state.viewStart.getFullYear());
  } else {
    title.textContent =
      dateKey(state.viewStart) + " ~ " + dateKey(state.viewEnd);
  }
}


function renderChartSelect() {

  const select = document.getElementById("chartSelect");

  if (!select) {
    return;
  }

  const visible = visibleCharts();

  select.innerHTML = visible
    .map(chart => `
      <option
        value="${escapeAttr(chart.id)}"
        ${chart.id === state.chartId ? "selected" : ""}
      >
        ${escapeHtml(chart.name)}
      </option>
    `)
    .join("");

  // 현재 선택된 차트가 숨김 상태라 목록에 없다면 보여준다.
  if (
    state.chart &&
    state.chart.hidden &&
    !visible.some(chart => chart.id === state.chartId)
  ) {

    const option = document.createElement("option");
    option.value = state.chartId;
    option.selected = true;
    option.textContent = state.chart.name + " (숨김)";

    select.appendChild(option);
  }
}


/* =========================================================
 * TASK / CATEGORY GROUP
 * ========================================================= */

function groupTasks() {

  const viewStartKey = dateKey(state.viewStart);
  const viewEndKey = dateKey(state.viewEnd);


  /*
   * 현재 표시 구간에 실제로 걸쳐 있는 작업만 가져온다.
   */
  const visibleTasks =
    state.tasks.filter(task => {

      if (!task.start || !task.end) {
        return false;
      }

      return (
        task.start <= viewEndKey &&
        task.end >= viewStartKey
      );
    });


  /*
   * 구간 시작 이전부터 이어진 작업
   */
  function isContinuing(task) {
    return (
      task.start < viewStartKey &&
      task.end >= viewStartKey
    );
  }


  const groups = [];


  state.categories.forEach(
    category => {

      const tasks =
        visibleTasks.filter(
          task => task.categoryId === category.id
        );

      if (!tasks.length) {
        return;
      }

      const continuing = tasks.filter(isContinuing);
      const newTasks = tasks.filter(task => !isContinuing(task));

      groups.push({
        id: category.id,
        name: category.name,
        tasks: [...continuing, ...newTasks],
        hasContinuing: continuing.length > 0
      });
    }
  );


  groups.sort(
    (a, b) => {
      if (a.hasContinuing !== b.hasContinuing) {
        return a.hasContinuing ? -1 : 1;
      }
      return 0;
    }
  );


  const uncategorized =
    visibleTasks.filter(
      task =>
        !state.categories.some(category => category.id === task.categoryId)
    );


  if (uncategorized.length) {

    const continuing = uncategorized.filter(isContinuing);
    const newTasks = uncategorized.filter(task => !isContinuing(task));

    groups.push({
      id: "",
      name: "기타",
      tasks: [...continuing, ...newTasks],
      hasContinuing: continuing.length > 0
    });

    groups.sort(
      (a, b) => {
        if (a.hasContinuing !== b.hasContinuing) {
          return a.hasContinuing ? -1 : 1;
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

  const column = document.getElementById("taskColumn");

  if (!column) {
    return;
  }

  column.innerHTML = "";

  const header = document.createElement("div");
  header.className = "task-header";
  header.textContent = "작업";
  column.appendChild(header);

  const groups = groupTasks();

  groups.forEach(
    group => {

      const category = document.createElement("div");
      category.className = "category-label";

      const name = document.createElement("span");
      name.className = "category-label-name";
      name.textContent = group.name;

      category.appendChild(name);

      if (group.id) {

        const deleteButton = document.createElement("button");

        deleteButton.type = "button";
        deleteButton.className = "category-delete-btn";
        deleteButton.textContent = "×";
        deleteButton.title = "카테고리 삭제";
        deleteButton.setAttribute("aria-label", group.name + " 카테고리 삭제");

        deleteButton.style.flex = "0 0 auto";
        deleteButton.style.width = "24px";
        deleteButton.style.height = "24px";
        deleteButton.style.padding = "0";
        deleteButton.style.margin = "0";
        deleteButton.style.border = "0";
        deleteButton.style.background = "transparent";
        deleteButton.style.cursor = "pointer";
        deleteButton.style.fontSize = "18px";
        deleteButton.style.lineHeight = "1";
        deleteButton.style.color = "inherit";

        deleteButton.addEventListener(
          "click",
          event => {
            event.preventDefault();
            event.stopPropagation();
            deleteCategory(group.id, group.name);
          }
        );

        category.style.display = "flex";
        category.style.alignItems = "center";
        category.style.justifyContent = "space-between";
        category.style.gap = "8px";

        category.appendChild(deleteButton);
      }

      column.appendChild(category);

      group.tasks.forEach(
        task => {

          const card = document.createElement("div");
          card.className = "task-card";
          card.dataset.id = task.id;

          card.innerHTML = `
            <div class="task-name">
              ${escapeHtml(task.name)}
            </div>
          `;

          setupTaskDrag(card, task);

          card.addEventListener(
            "click",
            () => {
              if (state.draggingTaskId) {
                return;
              }
              showTaskDetail(task.id);
            }
          );

          column.appendChild(card);
        }
      );
    }
  );
}


/* =========================================================
 * TIMELINE
 * ========================================================= */

function renderTimeline() {

  const timeline = document.getElementById("timeline");

  if (!timeline) {
    return;
  }

  timeline.innerHTML = "";

  const inner = document.createElement("div");
  inner.className = "timeline-inner";

  const totalDays = totalViewDays();

  state.rangeStart = Math.max(0, Math.min(state.rangeStart, totalDays - 1));
  state.rangeEnd = Math.max(state.rangeStart, Math.min(state.rangeEnd, totalDays - 1));

  const visibleDays = state.rangeEnd - state.rangeStart + 1;

  const width = Math.max(900, visibleDays * 8);

  inner.style.width = width + "px";

  const weekCount = Math.ceil(visibleDays / 7);
  const weekWidth = width / weekCount;

  inner.style.setProperty("--week-width", weekWidth + "px");

  renderWeekHeader(inner, totalDays, visibleDays, width);

  const groups = groupTasks();

  groups.forEach(
    group => {

      const categoryRow = document.createElement("div");
      categoryRow.className = "timeline-category";
      inner.appendChild(categoryRow);

      group.tasks.forEach(
        task => {

          const row = document.createElement("div");
          row.className = "timeline-task-row";

          renderTaskBar(row, task, totalDays, visibleDays);

          inner.appendChild(row);
        }
      );
    }
  );

  renderTodayLine(inner, totalDays, visibleDays, width);

  timeline.appendChild(inner);

  requestAnimationFrame(syncGanttRows);
}


/* =========================================================
 * WEEK HEADER
 * ========================================================= */

function renderWeekHeader(inner, totalDays, visibleDays, width) {

  const header = document.createElement("div");
  header.className = "week-header";

  const weeks = Math.ceil(visibleDays / 7);

  header.style.gridTemplateColumns = `repeat(${weeks}, minmax(34px, 1fr))`;

  for (let i = 0; i < weeks; i++) {

    const absoluteDay = state.rangeStart + i * 7;

    if (absoluteDay >= totalDays) {
      break;
    }

    const date = addDays(state.viewStart, absoluteDay);
    const end = addDays(date, 6);

    if (end > state.viewEnd) {
      end.setTime(state.viewEnd.getTime());
    }

    const cell = document.createElement("div");
    cell.className = "week-cell";

    cell.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
    cell.title = `${dateKey(date)} ~ ${dateKey(end)}`;

    header.appendChild(cell);
  }

  inner.appendChild(header);
}


/* =========================================================
 * TASK BAR
 * ========================================================= */

function renderTaskBar(row, task, totalDays, visibleDays) {

  if (!task.start || !task.end) {
    return;
  }

  const start = dateObj(task.start);
  const end = dateObj(task.end);

  if (!start || !end) {
    return;
  }

  const viewStart = state.viewStart;
  const viewEnd = state.viewEnd;

  if (end < viewStart || start > viewEnd) {
    return;
  }

  const visibleStartDate = start < viewStart ? viewStart : start;
  const visibleEndDate = end > viewEnd ? viewEnd : end;

  let startDay = dayOffsetFromViewStart(visibleStartDate);
  let endDay = dayOffsetFromViewStart(visibleEndDate);

  if (endDay < state.rangeStart || startDay > state.rangeEnd) {
    return;
  }

  startDay = Math.max(startDay, state.rangeStart);
  endDay = Math.min(endDay, state.rangeEnd);

  const left = (startDay - state.rangeStart) / visibleDays * 100;
  const width = (endDay - startDay + 1) / visibleDays * 100;

  const bar = document.createElement("div");
  bar.className = "task-bar";

  bar.style.left = left + "%";
  bar.style.width = width + "%";
  bar.style.background = task.color || "#3B82F6";

  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));

  bar.innerHTML = `
    <div class="task-progress" style="width:${progress}%"></div>
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
      showTaskDetail(task.id);
    }
  );

  row.appendChild(bar);
}


/* =========================================================
 * TODAY LINE
 * ========================================================= */

function renderTodayLine(inner, totalDays, visibleDays, width) {

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (today < state.viewStart || today > state.viewEnd) {
    return;
  }

  const todayDay = dayOffsetFromViewStart(today);

  if (todayDay < state.rangeStart || todayDay > state.rangeEnd) {
    return;
  }

  const line = document.createElement("div");
  line.className = "today-line";

  line.style.left =
    ((todayDay - state.rangeStart) / visibleDays * 100) + "%";

  inner.appendChild(line);
}


/* =========================================================
 * LEFT / RIGHT ROW HEIGHT SYNC
 * ========================================================= */

function syncGanttRows() {

  const left = document.getElementById("taskColumn");
  const timeline = document.getElementById("timeline");

  if (!left || !timeline) {
    return;
  }

  const inner = timeline.querySelector(".timeline-inner");

  if (!inner) {
    return;
  }

  const leftHeader = left.querySelector(".task-header");
  const rightHeader = inner.querySelector(".week-header");

  if (leftHeader && rightHeader) {

    leftHeader.style.boxSizing = "border-box";
    rightHeader.style.boxSizing = "border-box";

    leftHeader.style.height = "";
    leftHeader.style.minHeight = "";
    leftHeader.style.maxHeight = "";

    rightHeader.style.height = "";
    rightHeader.style.minHeight = "";
    rightHeader.style.maxHeight = "";

    const height = Math.max(
      leftHeader.getBoundingClientRect().height,
      rightHeader.getBoundingClientRect().height
    );

    if (height > 0) {
      [leftHeader, rightHeader].forEach(element => {
        element.style.height = height + "px";
        element.style.minHeight = height + "px";
        element.style.maxHeight = height + "px";
      });
    }
  }

  const leftRows = [...left.children].filter(
    element =>
      element.classList.contains("category-label") ||
      element.classList.contains("task-card")
  );

  const rightRows = [...inner.children].filter(
    element =>
      element.classList.contains("timeline-category") ||
      element.classList.contains("timeline-task-row")
  );

  if (leftRows.length !== rightRows.length) {
    console.warn("Gantt row count mismatch:", leftRows.length, rightRows.length);
    return;
  }

  leftRows.forEach(element => {
    element.style.boxSizing = "border-box";
    element.style.verticalAlign = "top";
  });

  rightRows.forEach(element => {
    element.style.boxSizing = "border-box";
    element.style.verticalAlign = "top";
  });

  leftRows.forEach(
    (leftRow, index) => {

      const rightRow = rightRows[index];

      leftRow.style.height = "";
      leftRow.style.minHeight = "";
      leftRow.style.maxHeight = "";

      rightRow.style.height = "";
      rightRow.style.minHeight = "";
      rightRow.style.maxHeight = "";

      const leftHeight = leftRow.getBoundingClientRect().height;
      const rightHeight = rightRow.getBoundingClientRect().height;

      const height = Math.max(leftHeight, rightHeight);

      if (height <= 0) {
        return;
      }

      leftRow.style.height = height + "px";
      leftRow.style.minHeight = height + "px";
      leftRow.style.maxHeight = height + "px";

      rightRow.style.height = height + "px";
      rightRow.style.minHeight = height + "px";
      rightRow.style.maxHeight = height + "px";
    }
  );
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
      <button id="closeDetail" type="button">×</button>
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
        <input id="detailProgress" type="number" min="0" max="100" value="${Number(task.progress) || 0}">
      </div>

      <div class="detail-item">
        <span>막대 색상</span>
        <input id="detailColor" type="color" value="${escapeAttr(task.color || "#3B82F6")}">
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
    closeButton.onclick = () => { panel.classList.add("hidden"); };
  }

  const saveButton = document.getElementById("saveDetailBtn");
  if (saveButton) {
    saveButton.onclick = () => saveTaskDetail(task.id);
  }

  const deleteButton = document.getElementById("deleteTaskBtn");
  if (deleteButton) {
    deleteButton.onclick = () => deleteTask(task.id);
  }
}


/* =========================================================
 * SAVE TASK DETAIL
 * ========================================================= */

async function saveTaskDetail(id) {

  try {

    const data = {
      id,
      name: document.getElementById("detailName").value.trim(),
      categoryId: document.getElementById("detailCategory").value,
      start: document.getElementById("detailStart").value,
      end: document.getElementById("detailEnd").value,
      progress: document.getElementById("detailProgress").value,
      color: document.getElementById("detailColor").value,
      memo: document.getElementById("detailMemo").value,
      target: document.getElementById("detailTarget").value,
      owner: document.getElementById("detailOwner").value
    };

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

    await apiPost("update", { chartId: state.chartId, data });

    await loadChartData(state.chartId, { keepView: true });

    showTaskDetail(id);

  } catch (error) {
    alert("저장 실패\n" + error.message);
  }
}


/* =========================================================
 * DELETE TASK
 * ========================================================= */

async function deleteTask(id) {

  if (!confirm("이 작업을 삭제할까요?")) {
    return;
  }

  try {

    await apiPost("delete", { chartId: state.chartId, id });

    state.selectedTask = null;

    const panel = document.getElementById("detailPanel");
    if (panel) {
      panel.classList.add("hidden");
    }

    await loadChartData(state.chartId, { keepView: true });

  } catch (error) {
    alert("삭제 실패\n" + error.message);
  }
}


/* =========================================================
 * DELETE CATEGORY
 * ========================================================= */

async function deleteCategory(id, name) {

  if (!id) {
    return;
  }

  const confirmed = confirm(
    `"${name}" 카테고리를 삭제할까요?\n\n` +
    "카테고리에 속해 있던 작업은 삭제되지 않고 '기타'로 남습니다."
  );

  if (!confirmed) {
    return;
  }

  try {

    await apiPost("deleteCategory", { chartId: state.chartId, id });

    const selected = state.tasks.find(task => task.id === state.selectedTask);

    if (selected && selected.categoryId === id) {

      const panel = document.getElementById("detailPanel");
      if (panel) {
        panel.classList.add("hidden");
      }

      state.selectedTask = null;
    }

    await loadChartData(state.chartId, { keepView: true });

  } catch (error) {
    alert("카테고리 삭제 실패\n" + error.message);
  }
}


/* =========================================================
 * ADD TASK
 * ========================================================= */

function openTaskModal() {

  const select = document.getElementById("taskCategory");

  if (select) {
    select.innerHTML =
      `<option value="">기타</option>` +
      state.categories
        .map(category => `
          <option value="${escapeAttr(category.id)}">
            ${escapeHtml(category.name)}
          </option>
        `)
        .join("");
  }

  const today = new Date();
  const todayString = dateKey(today);

  const taskStart = document.getElementById("taskStart");
  if (taskStart) taskStart.value = todayString;

  const taskEnd = document.getElementById("taskEnd");
  if (taskEnd) taskEnd.value = todayString;

  const taskName = document.getElementById("taskName");
  if (taskName) taskName.value = "";

  const taskProgress = document.getElementById("taskProgress");
  if (taskProgress) taskProgress.value = 0;

  const taskMemo = document.getElementById("taskMemo");
  if (taskMemo) taskMemo.value = "";

  const taskTarget = document.getElementById("taskTarget");
  if (taskTarget) taskTarget.value = "";

  const taskOwner = document.getElementById("taskOwner");
  if (taskOwner) taskOwner.value = "";

  const modal = document.getElementById("taskModal");
  if (modal) modal.classList.remove("hidden");
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

  try {

    await apiPost("create", {
      chartId: state.chartId,
      data: {
        name,
        categoryId: document.getElementById("taskCategory").value,
        start,
        end,
        progress: document.getElementById("taskProgress").value,
        color: document.getElementById("taskColor").value,
        memo: document.getElementById("taskMemo").value,
        target: document.getElementById("taskTarget").value,
        owner: document.getElementById("taskOwner").value
      }
    });

    closeModal("taskModal");

    await loadChartData(state.chartId, { keepView: true });

  } catch (error) {
    alert("작업 추가 실패\n" + error.message);
  }
}


/* =========================================================
 * ADD CATEGORY
 * ========================================================= */

function openCategoryModal() {

  const name = document.getElementById("categoryName");
  if (name) name.value = "";

  const modal = document.getElementById("categoryModal");
  if (modal) modal.classList.remove("hidden");
}


async function saveNewCategory() {

  const name = document.getElementById("categoryName").value.trim();

  if (!name) {
    alert("카테고리명을 입력해주세요.");
    return;
  }

  const color = document.getElementById("categoryColor").value;

  try {

    await apiPost("createCategory", {
      chartId: state.chartId,
      data: { name, color }
    });

    closeModal("categoryModal");

    await loadChartData(state.chartId, { keepView: true });

  } catch (error) {
    alert("카테고리 추가 실패\n" + error.message);
  }
}


/* =========================================================
 * CHART CREATE / DELETE / HIDE / RANGE SETTING
 * ========================================================= */

function openChartModal() {

  const name = document.getElementById("chartName");
  if (name) name.value = "";

  const start = document.getElementById("chartRangeStart");
  if (start) start.value = "";

  const end = document.getElementById("chartRangeEnd");
  if (end) end.value = "";

  const modal = document.getElementById("chartModal");
  if (modal) modal.classList.remove("hidden");
}


async function saveNewChart() {

  const name = document.getElementById("chartName").value.trim();

  if (!name) {
    alert("차트 이름을 입력해주세요.");
    return;
  }

  const rangeStart = document.getElementById("chartRangeStart").value;
  const rangeEnd = document.getElementById("chartRangeEnd").value;

  if ((rangeStart && !rangeEnd) || (!rangeStart && rangeEnd)) {
    alert("표시 시작일과 종료일을 함께 입력하거나, 둘 다 비워두세요.");
    return;
  }

  if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
    alert("표시 종료일은 시작일보다 빠를 수 없습니다.");
    return;
  }

  try {

    const res = await apiPost("createChart", {
      data: { name, rangeStart, rangeEnd }
    });

    closeModal("chartModal");

    await loadChartList();

    await switchChart(res.result);

    renderChartManageList();

  } catch (error) {
    alert("차트 추가 실패\n" + error.message);
  }
}


/*
 * 차트 전환: 데이터 + 기본 표시 구간을 새로 불러온다.
 */
async function switchChart(chartId) {

  if (!chartId) {
    return;
  }

  state.chartId = chartId;

  localStorage.setItem(CHART_STORAGE, chartId);

  await loadChartData(chartId, { keepView: false });
}


async function loadChartData(chartId, options = {}) {

  try {

    const res = await apiPost("load", { chartId });
    const data = res.result || {};

    state.chart = data.chart || null;
    state.chartId = data.chart ? data.chart.id : chartId;

    state.tasks = Array.isArray(data.tasks) ? data.tasks : [];
    state.categories = Array.isArray(data.categories) ? data.categories : [];

    if (!options.keepView || !state.viewStart || !state.viewEnd) {
      const range = defaultViewRange(state.chart);
      state.viewStart = range.start;
      state.viewEnd = range.end;
      resetRange();
    }

    render();

  } catch (error) {
    console.error(error);
    alert("데이터를 불러오지 못했습니다.\n" + error.message);
  }
}


/*
 * 전체 초기 로드: 차트 목록을 먼저 불러온 뒤
 * 마지막으로 보던 차트(또는 첫 번째로 보이는 차트)를 연다.
 */
async function loadData() {

  try {

    const charts = await loadChartList();

    if (!charts.length) {
      renderChartSelect();
      renderRangeTitle();
      alert("차트가 없습니다. 새 차트를 추가해주세요.");
      return;
    }

    const chartId = pickInitialChartId(charts);

    await switchChart(chartId);

  } catch (error) {
    console.error(error);
    alert("데이터를 불러오지 못했습니다.\n" + error.message);
  }
}


/*
 * 차트 관리 모달: 전체 차트(숨김 포함) 목록 + 숨기기/보이기/삭제/범위수정
 */
function openChartManageModal() {

  renderChartManageList();

  const modal = document.getElementById("chartManageModal");
  if (modal) modal.classList.remove("hidden");
}


function renderChartManageList() {

  const list = document.getElementById("chartManageList");

  if (!list) {
    return;
  }

  if (!state.charts.length) {
    list.innerHTML = `<div class="chart-manage-empty">차트가 없습니다.</div>`;
    return;
  }

  list.innerHTML = state.charts
    .map(chart => {

      const rangeText =
        chart.rangeStart && chart.rangeEnd
          ? `${chart.rangeStart} ~ ${chart.rangeEnd}`
          : "기본 (올해 전체)";

      return `
        <div class="chart-manage-row" data-chart-id="${escapeAttr(chart.id)}">

          <div class="chart-manage-info">
            <div class="chart-manage-name">
              ${escapeHtml(chart.name)}
              ${chart.hidden ? '<span class="chart-hidden-badge">숨김</span>' : ""}
            </div>
            <div class="chart-manage-range">${escapeHtml(rangeText)}</div>
          </div>

          <div class="chart-manage-actions">

            <button type="button" data-action="edit">범위 수정</button>

            <button type="button" data-action="toggle-hidden">
              ${chart.hidden ? "보이기" : "숨기기"}
            </button>

            <button type="button" data-action="delete" class="danger">삭제</button>

          </div>

        </div>
      `;
    })
    .join("");

  list.querySelectorAll(".chart-manage-row").forEach(row => {

    const chartId = row.dataset.chartId;

    row.querySelector('[data-action="toggle-hidden"]').onclick =
      () => toggleChartHidden(chartId);

    row.querySelector('[data-action="delete"]').onclick =
      () => deleteChartConfirm(chartId);

    row.querySelector('[data-action="edit"]').onclick =
      () => openChartEditForm(row, chartId);
  });
}


function openChartEditForm(row, chartId) {

  const chart = state.charts.find(c => c.id === chartId);
  if (!chart) return;

  const existing = row.querySelector(".chart-manage-edit-form");
  if (existing) {
    existing.remove();
    return;
  }

  const form = document.createElement("div");
  form.className = "chart-manage-edit-form";

  form.innerHTML = `
    <label>
      이름
      <input type="text" class="edit-name" value="${escapeAttr(chart.name)}">
    </label>

    <label>
      표시 시작일
      <input type="date" class="edit-start" value="${escapeAttr(chart.rangeStart)}">
    </label>

    <label>
      표시 종료일
      <input type="date" class="edit-end" value="${escapeAttr(chart.rangeEnd)}">
    </label>

    <div class="chart-manage-edit-actions">
      <button type="button" class="edit-clear">범위 초기화</button>
      <button type="button" class="edit-save primary">저장</button>
    </div>
  `;

  row.appendChild(form);

  form.querySelector(".edit-clear").onclick = () => {
    form.querySelector(".edit-start").value = "";
    form.querySelector(".edit-end").value = "";
  };

  form.querySelector(".edit-save").onclick = async () => {

    const name = form.querySelector(".edit-name").value.trim();
    const rangeStart = form.querySelector(".edit-start").value;
    const rangeEnd = form.querySelector(".edit-end").value;

    if (!name) {
      alert("차트 이름을 입력해주세요.");
      return;
    }

    if ((rangeStart && !rangeEnd) || (!rangeStart && rangeEnd)) {
      alert("표시 시작일과 종료일을 함께 입력하거나, 둘 다 비워두세요.");
      return;
    }

    if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
      alert("표시 종료일은 시작일보다 빠를 수 없습니다.");
      return;
    }

    try {

      await apiPost("updateChart", {
        data: { chartId, name, rangeStart, rangeEnd }
      });

      await loadChartList();

      renderChartManageList();
      renderChartSelect();

      if (chartId === state.chartId) {
        // 현재 보고 있는 차트의 범위가 바뀌었을 수 있으니 다시 불러온다.
        await loadChartData(chartId, { keepView: false });
      }

    } catch (error) {
      alert("차트 수정 실패\n" + error.message);
    }
  };
}


async function toggleChartHidden(chartId) {

  const chart = state.charts.find(c => c.id === chartId);
  if (!chart) return;

  try {

    await apiPost("updateChart", {
      data: { chartId, hidden: !chart.hidden }
    });

    await loadChartList();

    renderChartManageList();
    renderChartSelect();

    // 현재 보고 있던 차트를 숨겼고, 보이는 차트가 하나라도 있다면 전환한다.
    if (chartId === state.chartId && !chart.hidden) {

      const visible = visibleCharts();

      if (visible.length) {
        await switchChart(visible[0].id);
      }
    }

  } catch (error) {
    alert("숨김 상태 변경 실패\n" + error.message);
  }
}


async function deleteChartConfirm(chartId) {

  const chart = state.charts.find(c => c.id === chartId);
  if (!chart) return;

  const confirmed = confirm(
    `"${chart.name}" 차트를 삭제할까요?\n\n` +
    "이 차트의 모든 작업과 카테고리가 영구적으로 삭제되며 되돌릴 수 없습니다."
  );

  if (!confirmed) {
    return;
  }

  try {

    await apiPost("deleteChart", { chartId });

    await loadChartList();

    renderChartManageList();
    renderChartSelect();

    if (chartId === state.chartId) {

      if (state.charts.length) {
        await switchChart(pickInitialChartId(state.charts));
      } else {
        state.chartId = null;
        state.chart = null;
        state.tasks = [];
        state.categories = [];
        render();
        alert("모든 차트가 삭제되었습니다. 새 차트를 추가해주세요.");
      }
    }

  } catch (error) {
    alert("차트 삭제 실패\n" + error.message);
  }
}


/* =========================================================
 * DRAG & DROP
 * ========================================================= */

function setupTaskDrag(element, task) {

  let timer = null;
  let dragging = false;

  element.addEventListener(
    "pointerdown",
    event => {

      if (event.button !== 0) {
        return;
      }

      timer = setTimeout(
        () => {

          dragging = true;
          state.draggingTaskId = task.id;

          element.classList.add("long-pressing");

          try {
            element.setPointerCapture(event.pointerId);
          } catch (error) {
            // 일부 브라우저에서는 capture가 실패할 수 있다.
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

      element.classList.add("dragging");

      const cards = [...document.querySelectorAll(".task-card")];

      const target = cards.find(card => {

        if (card === element) {
          return false;
        }

        const rect = card.getBoundingClientRect();

        return (
          event.clientY > rect.top &&
          event.clientY < rect.bottom
        );
      });

      if (target) {

        const targetId = target.dataset.id;

        reorderLocal(task.id, targetId);

        render();
      }
    }
  );

  element.addEventListener(
    "pointerup",
    async () => {

      clearTimeout(timer);

      if (!dragging) {
        return;
      }

      dragging = false;

      element.classList.remove("dragging", "long-pressing");

      try {

        await apiPost("reorder", {
          chartId: state.chartId,
          ids: state.tasks.map(task => task.id)
        });

      } catch (error) {

        alert("순서 저장 실패\n" + error.message);

        await loadChartData(state.chartId, { keepView: true });
      }

      setTimeout(() => { state.draggingTaskId = null; }, 100);
    }
  );

  element.addEventListener(
    "pointercancel",
    () => {

      clearTimeout(timer);

      dragging = false;

      element.classList.remove("dragging", "long-pressing");

      state.draggingTaskId = null;
    }
  );
}


function reorderLocal(fromId, toId) {

  if (fromId === toId) {
    return;
  }

  const fromIndex = state.tasks.findIndex(task => task.id === fromId);
  const toIndex = state.tasks.findIndex(task => task.id === toId);

  if (fromIndex === -1 || toIndex === -1) {
    return;
  }

  const [moved] = state.tasks.splice(fromIndex, 1);

  state.tasks.splice(toIndex, 0, moved);
}


/* =========================================================
 * ZOOM RANGE
 *
 * state.viewStart ~ state.viewEnd 안에서만 움직인다.
 * ========================================================= */

function updateRange() {

  const minElement = document.getElementById("rangeMin");
  const maxElement = document.getElementById("rangeMax");

  if (!minElement || !maxElement) {
    return;
  }

  let min = Number(minElement.value);
  let max = Number(maxElement.value);

  const totalDays = totalViewDays();

  min = Math.max(0, Math.min(min, totalDays - 1));
  max = Math.max(0, Math.min(max, totalDays - 1));

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

  requestAnimationFrame(syncGanttRows);
}


/* =========================================================
 * RESET RANGE (현재 표시 구간 전체를 보여준다)
 * ========================================================= */

function resetRange() {

  const days = totalViewDays();

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
 * PAGE (이전/다음)
 *
 * 현재 표시 구간 길이만큼 통째로 앞/뒤로 이동한다.
 * (과거의 "연도 이동"을 일반화한 것)
 * ========================================================= */

function changePage(amount) {

  const length = totalViewDays();

  state.viewStart = addDays(state.viewStart, length * amount);
  state.viewEnd = addDays(state.viewEnd, length * amount);

  resetRange();
  render();
}


const prevYear = document.getElementById("prevYear");
if (prevYear) {
  prevYear.onclick = () => { changePage(-1); };
}

const nextYear = document.getElementById("nextYear");
if (nextYear) {
  nextYear.onclick = () => { changePage(1); };
}


/* =========================================================
 * TODAY
 * ========================================================= */

const todayBtn = document.getElementById("todayBtn");

if (todayBtn) {

  todayBtn.onclick = () => {

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 오늘이 현재 표시 구간 밖이라면, 구간 길이를 유지한 채 오늘을 중심으로 이동
    if (today < state.viewStart || today > state.viewEnd) {

      const length = totalViewDays();
      const half = Math.floor(length / 2);

      state.viewStart = addDays(today, -half);
      state.viewEnd = addDays(state.viewStart, length - 1);
    }

    const totalDays = totalViewDays();
    const day = dayOffsetFromViewStart(today);

    const start = Math.max(0, day - 30);
    const end = Math.min(totalDays - 1, day + 30);

    state.rangeStart = start;
    state.rangeEnd = end;

    const rangeMin = document.getElementById("rangeMin");
    const rangeMax = document.getElementById("rangeMax");

    if (rangeMin) {
      rangeMin.min = 0;
      rangeMin.max = totalDays - 1;
      rangeMin.value = start;
    }

    if (rangeMax) {
      rangeMax.min = 0;
      rangeMax.max = totalDays - 1;
      rangeMax.value = end;
    }

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


document
  .querySelectorAll("[data-close]")
  .forEach(button => {
    button.addEventListener(
      "click",
      () => { closeModal(button.dataset.close); }
    );
  });


/*
 * 작업 추가
 */
const addTaskBtn = document.getElementById("addTaskBtn");
if (addTaskBtn) { addTaskBtn.onclick = openTaskModal; }

const saveTaskBtn = document.getElementById("saveTaskBtn");
if (saveTaskBtn) { saveTaskBtn.onclick = saveNewTask; }


/*
 * 카테고리 추가
 */
const addCategoryBtn = document.getElementById("addCategoryBtn");
if (addCategoryBtn) { addCategoryBtn.onclick = openCategoryModal; }

const saveCategoryBtn = document.getElementById("saveCategoryBtn");
if (saveCategoryBtn) { saveCategoryBtn.onclick = saveNewCategory; }


/*
 * 차트 추가 / 관리
 */
const addChartBtn = document.getElementById("addChartBtn");
if (addChartBtn) { addChartBtn.onclick = openChartModal; }

const saveChartBtn = document.getElementById("saveChartBtn");
if (saveChartBtn) { saveChartBtn.onclick = saveNewChart; }

const manageChartBtn = document.getElementById("manageChartBtn");
if (manageChartBtn) { manageChartBtn.onclick = openChartManageModal; }

const chartSelect = document.getElementById("chartSelect");
if (chartSelect) {
  chartSelect.addEventListener("change", () => {
    switchChart(chartSelect.value);
  });
}


/*
 * 새로고침
 */
const reloadBtn = document.getElementById("reloadBtn");
if (reloadBtn) {
  reloadBtn.onclick = () => loadChartData(state.chartId, { keepView: true });
}


/*
 * 확대/축소 범위
 */
const rangeMin = document.getElementById("rangeMin");
if (rangeMin) { rangeMin.addEventListener("input", updateRange); }

const rangeMax = document.getElementById("rangeMax");
if (rangeMax) { rangeMax.addEventListener("input", updateRange); }


/* =========================================================
 * ESC
 * ========================================================= */

document.addEventListener(
  "keydown",
  event => {

    if (event.key !== "Escape") {
      return;
    }

    const taskModal = document.getElementById("taskModal");
    if (taskModal && !taskModal.classList.contains("hidden")) {
      taskModal.classList.add("hidden");
      return;
    }

    const categoryModal = document.getElementById("categoryModal");
    if (categoryModal && !categoryModal.classList.contains("hidden")) {
      categoryModal.classList.add("hidden");
      return;
    }

    const chartModal = document.getElementById("chartModal");
    if (chartModal && !chartModal.classList.contains("hidden")) {
      chartModal.classList.add("hidden");
      return;
    }

    const chartManageModal = document.getElementById("chartManageModal");
    if (chartManageModal && !chartManageModal.classList.contains("hidden")) {
      chartManageModal.classList.add("hidden");
      return;
    }

    const detailPanel = document.getElementById("detailPanel");
    if (detailPanel && !detailPanel.classList.contains("hidden")) {
      detailPanel.classList.add("hidden");
      state.selectedTask = null;
    }
  }
);


/* =========================================================
 * WINDOW RESIZE
 * ========================================================= */

window.addEventListener(
  "resize",
  () => { requestAnimationFrame(syncGanttRows); }
);


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

loadData();
