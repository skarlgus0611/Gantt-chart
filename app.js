/* Firebase 전환판 (app2.js) — 데이터 저장소를 구글 드라이브/Apps Script에서
 * Firestore로 옮기는 작업. index2.html에서 type="module"로 불러온다.
 * UI/렌더링 코드는 원본 app.js와 동일하게 유지하고, 저장소를 부르는
 * 부분(로그인, 작업/카테고리/차트 CRUD, 공유 멤버십 관련 함수)만
 * 교체했다. 개인 차트와 공유 차트는 이제 같은 Firestore 컬렉션
 * (charts/{chartId})을 쓴다 — apiGet/apiPost/apiPostForChart ->
 * coreApiPost(action, chartId, data) 하나로 통합. */
import * as fb from "./firebase/firebase-core.js?v=2026-10-24-design-v96"; /* 버전을 붙여 예전 파일이 캐시에 남지 않게 */

/* =========================================================
 * 간트차트 app.js  (v3, 2026-10-18-share15)
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

/* ===== 멀티 차트 (추가분) =====
   주소에 ?chart=아이디 가 있으면: 이 창은 "그 차트 하나"를 보여주는
   기존 화면 그대로 동작한다(없으면 'default' = 기존 Tasks/Categories).
   주소에 ?chart= 가 전혀 없으면: 이 창은 "여러 차트를 쌓아 보여주는 틀(shell)"
   역할을 한다 (아래 SHELL 섹션 참고). */
const CHART_PARAM = new URLSearchParams(window.location.search).get("chart");
const IS_SHELL_MODE = CHART_PARAM === null;
const CHART_ID = CHART_PARAM || "default";

/* (디자인 추가분) 모음(셸) 페이지의 차트 박스 안 iframe으로 떠 있을 때는
   바깥 카드와 이어져 보이도록 배경을 흰색으로 바꾸기 위한 표시만 단다. */
try {
  if (window.self !== window.top) {
    document.documentElement.classList.add("is-embedded");
  }
} catch (error) {
  document.documentElement.classList.add("is-embedded");
}

/* (버그 수정, share12) 아래 4개는 원래 파일 뒤쪽(공유 기능 추가분)에
   선언돼 있었는데, 로그인이 이미 되어 있는 상태로 페이지를 열면
   initShell()이 스크립트 실행 중에 곧바로 shellLoadCharts()를 불러서
   그 안에서 shareFetch/apiPost가 이 const들을 "선언되기도 전에" 참조해
   버렸다(TDZ ReferenceError). 그래서 공유 차트 목록이 초기 로딩에서
   깨지고, 공유 버튼을 눌러도 아래에 차트가 안 생기는 것처럼 보였다.
   CHART_ID 바로 다음으로 옮겨서 스크립트 맨 앞에서 먼저 초기화되게
   한다(의존 관계: CHART_ID -> 이 4개). */
const SHARE_SERVER_URL = "https://script.google.com/macros/s/AKfycbzxw0R18Bg9O-RoPeJFxXeXqxRmrwcWL3nn_0wjYIkGisAhlKNTVAXETwwaQgw0jS2VZQ/exec";
const SHARED_CHART_PREFIX = "shared:";
const IS_SHARED_CHART = CHART_ID.indexOf(SHARED_CHART_PREFIX) === 0;
const SHARED_CHART_ID = IS_SHARED_CHART ? CHART_ID.slice(SHARED_CHART_PREFIX.length) : "";

/* (Firebase 전환) 개인/공유 차트가 이제 같은 Firestore 컬렉션(charts)을
   쓰므로, action 이름을 "ForChart" 접미사로 따로 구분할 필요가 없어졌다.
   예전 CHART_ACTION_MAP(기존 액션 이름 -> 차트별 액션 이름)은 삭제. */

const DEFAULT_COLOR = "#3b82f6";

/* 주 단위 날짜 라벨을 보여 주려면 한 주 칸이 최소 이만큼(px) 필요하다.
   1년 전체를 화면 폭에 맞추면 이보다 좁아져서 월 라벨만 보인다. */

/* 세 파일(index.html / app.js / style.css)이 같은 버전인지 화면 맨 아래에 표시한다.
   파일을 새로 올렸는데 예전 파일이 뜨는 경우(브라우저 캐시, 일부만 교체)를
   바로 알아볼 수 있다. 파일을 고칠 때마다 세 곳의 버전을 같이 올린다. */
const APP_VERSION = "2026-10-24-design-v96";


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
  chartHeight: 420,

  /* (디자인 추가분) 접어 둔 카테고리 id 목록("기타"는 ""). 이 브라우저에만 기억한다. */
  collapsedGroups: loadCollapsedGroups(),

  /* (조직 관리 3단계) 담당자별 보기. null 이면 전체 */
  ownerFilter: loadOwnerFilter()
};

function collapsedStorageKey() {
  return "ganttCollapsed:" + CHART_ID;
}

function loadCollapsedGroups() {
  try {
    const list = JSON.parse(localStorage.getItem(collapsedStorageKey()) || "[]");
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

function toggleGroupCollapsed(groupId) {
  const list = state.collapsedGroups;
  const index = list.indexOf(groupId);
  if (index >= 0) list.splice(index, 1);
  else list.push(groupId);
  try { localStorage.setItem(collapsedStorageKey(), JSON.stringify(list)); } catch (error) { /* 무시 */ }
  render();
}


/* =========================================================
 * API  (Google 로그인 + 사용자 개인 DB "JSON 파일", Apps Script 미사용)
 *
 * - "키" 대신 Google 계정으로 로그인한다.
 * - 로그인하면 이 계정의 '내 드라이브'에서 이 앱이 전에 만들어 둔
 *   DB 파일(JSON 하나)을 찾는다. 없으면 새로 만든다(빈 양식).
 * - 구글 시트(Sheets API)는 전혀 쓰지 않는다 — 그래서 구글 로그인 동의
 *   화면에 "모든 스프레드시트" 같은 넓은 권한이 뜨지 않는다. 대신
 *   드라이브 권한(drive.file) 하나만 쓰는데, 이 권한은 "이 앱이 만든
 *   파일"에만 묶여 있어서 사용자 드라이브의 다른 파일은 절대 못 건든다.
 * - 캘린더 기능(차트별 전용 캘린더 생성/삭제, 작업 자동 동기화)을 위해
 *   calendar 권한도 같이 받는다.
 * - 그 뒤로는 사용자 자신의 OAuth 토큰으로 Google Drive/Calendar API를
 *   직접 호출한다. 개발자 계정/Apps Script는 전혀 거치지 않고,
 *   그 어떤 접근 권한도 갖지 않는다(완전 격리).
 * - 토큰/DB파일ID는 localStorage에 저장해서, 이 사이트를 연 모든 탭/창과
 *   멀티 차트 보기의 iframe들이 전부 같은 로그인을 그대로 공유해서 쓴다.
 *   로그인 버튼도 맨 위(멀티 차트 화면)에 하나만 둔다.
 * ========================================================= */

const GOOGLE_CLIENT_ID =
  "967392989937-6eo5phg627gi95ftiqeenafgienko4uf.apps.googleusercontent.com";
const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/drive.file " +
  "https://www.googleapis.com/auth/calendar " +
  /* (공유 기능 추가분) 공유 서버가 "이 토큰이 누구 이메일인지" 확인할 수
     있어야 해서 이메일 조회 범위만 추가한다. 기존 두 권한은 그대로. */
  "https://www.googleapis.com/auth/userinfo.email " +
  /* (요청사항) 로그인한 계정의 프로필 사진을 보여주기 위한 범위 추가.
     기존 권한들은 그대로 둔다. */
  "https://www.googleapis.com/auth/userinfo.profile";

const DB_PROP_KEY = "ganttDbJson";
const DB_PROP_VALUE = "v1";
const DB_FILE_NAME = "간트차트 DB.json";
const DB_MIME_TYPE = "application/json";

const LIMITS = { name: 200, memo: 5000, target: 200, owner: 100, category: 100 };

const DRIVE_BASE = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";
const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

/* (Firebase 전환, app2.js) 로그인은 Firebase Auth(구글 로그인 + 캘린더
   scope)로 바뀐다. fbUser가 로그인 상태를 나타내고, accessToken은
   이제 "구글 캘린더 API 호출용 토큰"만 의미한다(드라이브는 더 이상
   안 씀 — 데이터는 Firestore에 저장되고, Firestore 접근 권한은
   Firebase Auth 세션 자체로 처리되므로 별도 토큰이 필요 없다). */
let fbUser = null;
let accessToken = ""; // 캘린더 API 전용 토큰

function setLoginButtonsUi() {
  document.querySelectorAll(".gantt-login-btn").forEach((btn) => {
    btn.textContent = fbUser ? "로그아웃" : "Google 로그인";
    btn.classList.toggle("is-logged-in", !!fbUser);
    btn.title = fbUser ? "Google 계정에서 로그아웃합니다" : "Google 계정으로 로그인합니다";
  });

  const avatar = document.getElementById("mcUserAvatar");
  if (avatar) {
    if (fbUser && fbUser.photoURL) {
      avatar.src = fbUser.photoURL;
      avatar.title = fbUser.email || "";
      avatar.classList.remove("hidden");
    } else {
      avatar.classList.add("hidden");
      avatar.src = "";
    }
  }

  /* (디자인 추가분) 사진이 없는 계정은 이름 글자 동그라미로 대신 보여준다. */
  const initial = document.getElementById("mcUserInitial");
  if (initial) {
    const showInitial = !!fbUser && !fbUser.photoURL;
    initial.textContent = showInitial ? shellPersonInitial(fbUser.displayName || fbUser.email, true) : "";
    initial.title = fbUser ? (fbUser.email || "") : "";
    initial.classList.toggle("hidden", !showInitial);
  }
}

function onGoogleLoginSuccess() {
  if (IS_SHELL_MODE) {
    if (typeof shellLoadCharts === "function") {
      shellLoadCharts();
    }
  } else if (typeof loadData === "function") {
    loadData();
  }
}

async function handleLoginButtonClick() {
  if (fbUser) {
    if (confirm("Google 계정에서 로그아웃하시겠습니까?")) {
      await fb.signOutUser();
    }
    return;
  }

  try {
    await fb.signIn();
  } catch (error) {
    if (typeof showToast === "function") {
      showToast("Google 로그인에 실패했습니다.");
    }
  }
}

/* (Firebase Auth 세션 변화 구독 — 이 리스너가 사실상 예전 initGoogleAuth의
   콜백 역할을 한다. 앱 로그인(=Firestore 접근)은 Firebase SDK가 알아서
   유지/갱신해주므로, 예전처럼 1시간마다 다시 로그인할 필요가
   없어진다. */
fb.onAuthChange((user) => {
  const wasLoggedIn = !!fbUser;
  fbUser = user;
  if (!user) {
    accessToken = "";
  }
  setLoginButtonsUi();

  if (user && !wasLoggedIn) {
    onGoogleLoginSuccess();
  } else if (!user && wasLoggedIn) {
    if (IS_SHELL_MODE) {
      shellChartsCache = [];
      if (typeof shellRenderList === "function") shellRenderList();
      shellCloseBellMenu();
      shellRefreshBell();
    } else {
      stopLiveSync();
      state.tasks = [];
      state.categories = [];
      if (typeof render === "function") render();
    }
    if (typeof showToast === "function") showToast("로그아웃했습니다.");
  }
});

/* 캘린더 기능(캘린더 생성/삭제, 이벤트 동기화)에만 쓰는 호출.
   캘린더 scope 토큰은 로그인할 때 같이 받아둔 걸 쓰고, 끝나있으면
   그때 다시 fb.signIn()으로 한 번 더 받아온다(앱 로그인 자체는 안
   끊긴 채로, 캘린더 권한만 다시 받는 것). */
async function googleFetch(url, opts = {}) {
  if (!accessToken) {
    accessToken = fb.getCalendarAccessToken();
  }
  if (!accessToken) {
    throw new Error("캘린더 기능을 쓰려면 다시 로그인해주세요.");
  }

  let response;

  try {
    response = await fetch(url, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers || {}),
        Authorization: "Bearer " + accessToken
      }
    });
  } catch (error) {
    throw new Error("Google 서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요.");
  }

  if (response.status === 401) {
    accessToken = "";
    try {
      const refreshed = await fb.signIn();
      accessToken = refreshed.calendarAccessToken;
      if (accessToken) {
        return googleFetch(url, opts);
      }
    } catch (error) {
      // 아래에서 공통 에러로 처리
    }
    throw new Error("캘린더 권한이 만료됐습니다. 다시 로그인해주세요.");
  }

  if (response.status === 204) {
    return null;
  }

  let body = null;

  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }

  if (!response.ok) {
    const msg = (body && body.error && body.error.message) || (response.status + " 오류");
    const err = new Error(msg);
    err.status = response.status;
    throw err;
  }

  return body;
}

/* ----- 검증/유틸 (기존 로직 그대로) ----- */

function strLimited(v, max, label) {
  const s = String(v === undefined || v === null ? "" : v);

  if (s.length > max) {
    throw new Error(label + "은(는) " + max + "자를 넘을 수 없습니다.");
  }

  return s;
}

function isRealDateStr(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));
}

function normProgress(v) {
  if (v === undefined || v === null || v === "") {
    return 0;
  }

  let num = Number(String(v).replace("%", "").trim());

  if (isNaN(num)) {
    return 0;
  }

  if (num > 0 && num < 1) {
    num *= 100;
  }

  return Math.max(0, Math.min(100, Math.round(num)));
}

function validColorStr(v) {
  const s = String(v || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : "";
}

function newRowId() {
  if (window.crypto && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }

  return (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12);
}

/* 드래그로 저장한 순서(order)대로 정렬한다. Firestore는 문서 ID 순으로
   돌려주기 때문에, 정렬하지 않으면 끌어서 바꾼 순서가 다시 불러올 때
   원래대로 돌아간다. order가 없는 옛 문서는 받은 순서 그대로 뒤에 둔다. */
function sortBySavedOrder(list) {
  return list
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const ao = Number.isFinite(Number(a.item.order)) ? Number(a.item.order) : Infinity;
      const bo = Number.isFinite(Number(b.item.order)) ? Number(b.item.order) : Infinity;
      if (ao !== bo) return ao < bo ? -1 : 1;
      return a.index - b.index;
    })
    .map(entry => entry.item);
}

function resolveTasksAndCats(bucket) {
  bucket = {
    tasks: sortBySavedOrder(bucket.tasks || []),
    categories: sortBySavedOrder(bucket.categories || [])
  };

  const catMap = {};
  bucket.categories.forEach((c) => {
    catMap[c.id] = c;
  });

  const tasks = bucket.tasks.map((t) => {
    const cat = catMap[t.categoryId];

    return {
      id: t.id,
      categoryId: t.categoryId || "",
      name: t.name || "",
      catName: cat ? cat.name : "",
      color: validColorStr(t.color) || (cat ? validColorStr(cat.color) || DEFAULT_COLOR : DEFAULT_COLOR),
      start: t.start || "",
      end: t.end || "",
      progress: normProgress(t.progress),
      memo: t.memo || "",
      target: t.target || "",
      owner: t.owner || "",
      ownerEmail: t.ownerEmail || "",
      overdueAck: !!t.overdueAck,
      endChangedAt: Number(t.endChangedAt) || 0,
      updated: t.updated || ""
    };
  });

  const categories = bucket.categories.map((c) => ({
    id: c.id,
    name: c.name || "",
    color: validColorStr(c.color) || DEFAULT_COLOR
  }));

  return { tasks, categories };
}

function applyTaskFields(base, data, cats) {
  const t = {
    name: base.name, categoryId: base.categoryId, start: base.start, end: base.end,
    progress: base.progress, color: base.color, memo: base.memo,
    target: base.target, owner: base.owner,
    /* (조직 관리 3단계) 조직원 목록에서 고른 담당자면 그 사람 이메일. 직접 적은 이름이면 "" */
    ownerEmail: base.ownerEmail || ""
  };

  const has = (k) => data[k] !== undefined && data[k] !== null;

  if (has("name")) {
    t.name = strLimited(data.name, LIMITS.name, "작업명").trim();
  }
  if (!t.name) {
    throw new Error("작업명을 입력해주세요.");
  }

  if (has("categoryId")) {
    const id = String(data.categoryId).trim();
    if (id && !cats.some((c) => c.id === id)) {
      throw new Error("존재하지 않는 카테고리입니다.");
    }
    t.categoryId = id;
  }

  if (has("start")) {
    t.start = String(data.start).trim();
  }
  if (has("end")) {
    t.end = String(data.end).trim();
  }
  if (!isRealDateStr(t.start) || !isRealDateStr(t.end)) {
    throw new Error("날짜는 2026-09-25 같은 형식의 올바른 날짜여야 합니다.");
  }
  if (t.end < t.start) {
    throw new Error("종료일은 시작일보다 빠를 수 없습니다.");
  }

  if (has("progress")) {
    t.progress = normProgress(data.progress);
  }

  if (has("color")) {
    const raw = String(data.color).trim();
    if (raw && !validColorStr(raw)) {
      throw new Error("색상은 #RRGGBB 형식이어야 합니다.");
    }
    t.color = raw;
  }

  if (has("memo")) {
    t.memo = strLimited(data.memo, LIMITS.memo, "메모");
  }
  if (has("target")) {
    t.target = strLimited(data.target, LIMITS.target, "대상처");
  }
  if (has("owner")) {
    t.owner = strLimited(data.owner, LIMITS.owner, "담당자");
  }
  if (has("ownerEmail")) {
    const email = String(data.ownerEmail).trim().toLowerCase();
    t.ownerEmail = email && /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 200 ? email : "";
  } else if (has("owner") && t.owner !== base.owner) {
    /* 담당자 이름만 바뀌었으면 예전 이메일 연결은 끊는다 */
    t.ownerEmail = "";
  }
  if (!String(t.owner || "").trim()) {
    /* (요청사항) 이메일만 적었으면 이메일 앞부분을 이름으로 */
    t.owner = t.ownerEmail ? t.ownerEmail.split("@")[0] : "";
  }

  /* (요청사항) 종료일을 바꿀 때마다 시각을 남긴다 → 같은 날짜로 되돌아와도 사이트 안 알림이 새로 뜬다.
     (버그 수정) 완료(100%)했던 작업의 진행률을 다시 낮춘 때도 마찬가지 — 완료 전에 [확인]·[지연 확인]을
     눌러 뒀어도 다시 알린다 */
  const reopened = normProgress(base.progress) >= 100 && normProgress(t.progress) < 100;
  if (t.end !== base.end || reopened) {
    t.endChangedAt = Date.now();
  }

  /* (요청사항) 지연 확인: 누르면 그 작업의 지연 알림을 멈춘다. 종료일을 바꾸거나 완료를 되돌리면 다시 알린다 */
  t.overdueAck = !!base.overdueAck;
  if (has("overdueAck")) {
    t.overdueAck = !!data.overdueAck;
  } else if (t.end !== base.end || reopened) {
    t.overdueAck = false;
  }

  return t;
}

function cleanCategory(data, base) {
  const has = (k) => data[k] !== undefined && data[k] !== null;

  const name = has("name") ? strLimited(data.name, LIMITS.category, "카테고리명").trim() : base.name;
  if (!name) {
    throw new Error("카테고리명을 입력해주세요.");
  }

  let color = base.color;
  if (has("color")) {
    const raw = String(data.color).trim();
    if (raw && !validColorStr(raw)) {
      throw new Error("색상은 #RRGGBB 형식이어야 합니다.");
    }
    color = raw || DEFAULT_COLOR;
  }

  return { name, color };
}

/* ----- Calendar: 차트별 전용 캘린더 생성/삭제 + 작업 자동 동기화 ----- */

function addOneDay(ymd) {
  const d = new Date(ymd + "T00:00:00");
  d.setDate(d.getDate() + 1);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

function calEventDescription(task) {
  const lines = [];
  if (task.memo) lines.push("메모: " + memoPlainText(task.memo));
  if (task.target) lines.push("대상처: " + task.target);
  if (task.owner) lines.push("담당자: " + task.owner);
  lines.push("진행률: " + (normProgress(task.progress)) + "%");
  return lines.join("\n");
}

async function calCreateCalendar(summary) {
  const res = await googleFetch(CALENDAR_BASE + "/calendars", {
    method: "POST",
    body: JSON.stringify({ summary })
  });
  return res.id;
}

async function calDeleteCalendar(calendarId) {
  await googleFetch(CALENDAR_BASE + "/calendars/" + encodeURIComponent(calendarId), {
    method: "DELETE"
  });
}

async function calCreateEvent(calendarId, task) {
  const res = await googleFetch(
    CALENDAR_BASE + "/calendars/" + encodeURIComponent(calendarId) + "/events",
    {
      method: "POST",
      body: JSON.stringify({
        summary: task.name,
        description: calEventDescription(task),
        start: { date: task.start },
        end: { date: addOneDay(task.end) }
      })
    }
  );
  return res.id;
}

async function calUpdateEvent(calendarId, eventId, task) {
  await googleFetch(
    CALENDAR_BASE + "/calendars/" + encodeURIComponent(calendarId) + "/events/" + encodeURIComponent(eventId),
    {
      method: "PATCH",
      body: JSON.stringify({
        summary: task.name,
        description: calEventDescription(task),
        start: { date: task.start },
        end: { date: addOneDay(task.end) }
      })
    }
  );
}

async function calDeleteEvent(calendarId, eventId) {
  try {
    await googleFetch(
      CALENDAR_BASE + "/calendars/" + encodeURIComponent(calendarId) + "/events/" + encodeURIComponent(eventId),
      { method: "DELETE" }
    );
  } catch (error) {
    // 이미 지워졌거나 없는 이벤트면 무시한다.
  }
}

/* 작업을 저장할 때 연결된 캘린더가 있으면 같은 동작 안에서 바로 같이 반영한다.
   (따로 "캘린더 업데이트" 버튼 없이도, 작업을 고치는 순간 캘린더도 같이 바뀐다)
   캘린더 쪽 호출이 실패해도 작업 저장 자체는 실패시키지 않고 콘솔에만 남긴다. */
/* (Firebase 전환) 예전엔 메모리에 있는 task 객체에 calendarEventId를
   바로 써 넣고 나중에 writeDb() 한 번으로 같이 저장했는데, Firestore는
   문서 단위라 이벤트를 만든 뒤 updateTask로 한 번 더 써줘야 한다. */
async function syncCalendarOnCreate(chart, chartId, taskId, task) {
  if (!chart || !chart.calendarId) {
    return;
  }
  try {
    const eventId = await calCreateEvent(chart.calendarId, task);
    await fb.updateTask(chartId, taskId, { calendarEventId: eventId });
  } catch (error) {
    console.error(error);
  }
}

async function syncCalendarOnUpdate(chart, chartId, taskId, task) {
  if (!chart || !chart.calendarId) {
    return;
  }
  try {
    if (task.calendarEventId) {
      await calUpdateEvent(chart.calendarId, task.calendarEventId, task);
    } else {
      const eventId = await calCreateEvent(chart.calendarId, task);
      await fb.updateTask(chartId, taskId, { calendarEventId: eventId });
    }
  } catch (error) {
    console.error(error);
  }
}

async function syncCalendarOnDelete(chart, task) {
  if (!chart || !chart.calendarId || !task || !task.calendarEventId) {
    return;
  }
  try {
    await calDeleteEvent(chart.calendarId, task.calendarEventId);
  } catch (error) {
    console.error(error);
  }
}

/* ----- CSV 내보내기 (JSON → CSV, 보기/분석용 다운로드) ----- */

function csvEscape(v) {
  const s = String(v === undefined || v === null ? "" : v);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCsvForBucket(bucket) {
  const resolved = resolveTasksAndCats(bucket);
  const headers = ["작업명", "카테고리", "시작일", "종료일", "진행률(%)", "메모", "대상처", "담당자"];
  const rows = [headers.map(csvEscape).join(",")];

  resolved.tasks.forEach((t) => {
    rows.push([
      csvEscape(t.name), csvEscape(t.catName), csvEscape(t.start), csvEscape(t.end),
      csvEscape(t.progress), csvEscape(t.memo), csvEscape(t.target), csvEscape(t.owner)
    ].join(","));
  });

  // 맨 앞 BOM: 엑셀(윈도우)에서 한글이 깨지지 않도록.
  return "﻿" + rows.join("\r\n");
}

/* 전체 차트를 한 번에 CSV 하나로 내보낸다. 맨 앞에 "차트" 열을 추가해서
   어느 차트의 작업인지 구분한다. (차트 박스마다 따로 누르지 않아도 되도록)
   (Firebase 전환) 소유한 차트 + 공유로 들어간 차트 모두 Firestore에서
   한 번에 가져와서 합친다. */
async function buildCsvForAllCharts() {
  const headers = ["차트", "작업명", "카테고리", "시작일", "종료일", "진행률(%)", "메모", "대상처", "담당자"];
  const rows = [headers.map(csvEscape).join(",")];

  if (!fbUser) {
    return "﻿" + rows.join("\r\n");
  }

  const charts = await fbGetAllMyCharts();
  const sorted = charts.slice().sort((a, b) => (a.order || 0) - (b.order || 0));

  for (const chart of sorted) {
    const [tasks, categories] = await Promise.all([
      fb.getTasksOnce(chart.id), fb.getCategoriesOnce(chart.id)
    ]);
    const resolved = resolveTasksAndCats({ tasks, categories });

    resolved.tasks.forEach((t) => {
      rows.push([
        csvEscape(chart.name), csvEscape(t.name), csvEscape(t.catName), csvEscape(t.start), csvEscape(t.end),
        csvEscape(t.progress), csvEscape(t.memo), csvEscape(t.target), csvEscape(t.owner)
      ].join(","));
    });
  }

  return "﻿" + rows.join("\r\n");
}

/* ----- 요청 처리 (Firebase 전환) -----
 * 예전엔 개인 차트(Drive JSON 통째로 읽고/쓰기)와 공유 차트(ShareServer.gs
 * 왕복)가 서로 다른 저장소를 썼기 때문에 apiGet/apiPost를 통째로 다시
 * 선언해서 분기했다. 이제는 둘 다 같은 Firestore charts 컬렉션을 쓰므로,
 * "지금 보고 있는 차트가 어떤 chartId인지"만 다르고 나머지 동작은
 * 완전히 똑같다 — coreApiPost 하나로 통합한다. */

/* 멤버 맵은 "제거" 시에도 그 이메일 키가 null 값으로 남아있을 수 있어서
   (removeMember가 updateDoc으로 null만 써 넣으므로), 키 개수가 아니라
   "null이 아닌 멤버가 있는지"로 공유 여부를 판단한다. 수락 전(pending)
   초대도 공유로 쳐서, 초대를 보내는 즉시 공유 중 상태로 보이게 한다
   (옛 UX와 동일). */
function hasAnyMembers(chart) {
  const members = (chart && chart.members) || {};
  /* (조직 관리 2단계) 조직(원)에게 공유한 차트도 공유 중으로 본다 */
  return Object.keys(members).some((email) => members[email]) ||
    ((chart && chart.orgIds) || []).length > 0;
}

/* =========================================================
 * (조직 관리 2단계) 조직을 통한 차트 접근
 *  - [기존 권한] 게스트→뷰어, 참여자→편집자, 관리자·소유자→관리자
 *  - 차트마다·조직원마다 덮어쓴 권한(overrides)이 있으면 그것을 쓴다.
 *  - 직접 초대받은 권한과 조직을 통한 권한 중 높은 쪽이 내 권한.
 *  보안 규칙(firebase/firestore.rules)도 같은 계산을 한다.
 * ========================================================= */
const ORG_TO_CHART_ROLE = { guest: "viewer", member: "editor", admin: "admin", owner: "admin" };
const CHART_ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const CHART_ROLE_LABEL = { viewer: "뷰어", editor: "편집자", admin: "관리자", owner: "소유자" };
let myOrgMembershipsCache = null;

async function fbMyOrgMemberships(force) {
  if (!fbUser || typeof fb.getMyOrgMemberships !== "function") return [];
  if (!myOrgMembershipsCache || force) {
    try {
      myOrgMembershipsCache = await fb.getMyOrgMemberships(String(fbUser.email || "").toLowerCase());
    } catch (error) {
      console.warn("조직 정보를 불러오지 못했습니다(보안 규칙 확인 필요):", error);
      myOrgMembershipsCache = [];
    }
  }
  return myOrgMembershipsCache;
}

function higherChartRole(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return (CHART_ROLE_RANK[a] || 0) >= (CHART_ROLE_RANK[b] || 0) ? a : b;
}

/* 한 조직원(email, 조직 권한 orgRole)이 이 차트에서 갖는 권한. 공유 대상이 아니면 "" */
function chartOrgShareRole(chart, orgId, email, orgRole) {
  const share = ((chart && chart.orgShares) || {})[orgId];
  if (!share) return "";
  const key = String(email || "").toLowerCase();
  if (!share.all && !(share.picked || {})[key]) return "";
  return (share.overrides || {})[key] || ORG_TO_CHART_ROLE[orgRole] || "viewer";
}

function chartOrgRole(chart, memberships) {
  if (!fbUser || !chart) return "";
  const email = String(fbUser.email || "").toLowerCase();
  let best = "";
  /* 보안 규칙이 앞 3개 조직까지만 확인하므로 화면도 똑같이 */
  ((chart.orgIds || []).slice(0, 3)).forEach((orgId) => {
    const membership = (memberships || []).find((m) => m.orgId === orgId && m.status === "accepted");
    if (membership) best = higherChartRole(best, chartOrgShareRole(chart, orgId, email, membership.role));
  });
  return best;
}

function chartManualRole(chart) {
  if (!fbUser || !chart) return "";
  /* 이메일은 소문자로 저장한다. 예전에 그대로 저장된 항목도 찾는다 */
  const members = chart.members || {};
  const entry = members[String(fbUser.email || "").toLowerCase()] || members[fbUser.email];
  return entry && entry.status === "accepted" ? (entry.role || "viewer") : "";
}

function chartMyRole(chart, memberships) {
  if (!fbUser || !chart) return "";
  if (chart.ownerId === fbUser.uid) return "owner";
  return higherChartRole(chartManualRole(chart), chartOrgRole(chart, memberships));
}

/* 내가 속한 조직에 공유된 차트들 (직접 공유·소유 차트와 겹치는 것은 뺀다) */
async function fbGetOrgSharedCharts(knownIds) {
  if (!fbUser || typeof fb.getOrgChartIndex !== "function") return [];
  const memberships = (await fbMyOrgMemberships(true)).filter((m) => m.status === "accepted");
  const indexLists = await Promise.all(memberships.map((m) =>
    fb.getOrgChartIndex(m.orgId).catch((error) => {
      console.warn("조직 차트 목록을 불러오지 못했습니다:", error);
      return [];
    })
  ));
  const ids = Array.from(new Set(indexLists.flat().map((entry) => entry.chartId || entry.id)))
    .filter((id) => id && !knownIds.has(id));
  /* 고른 조직원에게만 공유된 차트는 다른 조직원이 열 수 없다 → 조용히 뺀다 */
  const charts = await Promise.all(ids.map((id) => fb.getChartOnce(id).catch(() => null)));
  return charts.filter((chart) => chart && chartOrgRole(chart, memberships));
}

async function fbGetAllMyCharts() {
  const base = await fb.getChartsOnce(fbUser.uid, fbUser.email);
  const extra = await fbGetOrgSharedCharts(new Set(base.map((c) => c.id)));
  return base.concat(extra);
}

function fbListPersonalCharts(charts) {
  return charts
    .filter((c) => fbUser && c.ownerId === fbUser.uid && !hasAnyMembers(c))
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((c) => ({
      id: c.id, name: c.name || "", rangeStart: c.rangeStart || "", rangeEnd: c.rangeEnd || "",
      hidden: !!c.hidden, order: c.order || 0, hasCalendar: !!c.calendarId
    }));
}

/* (성능) shellLoadCharts()가 "개인 차트 목록"과 "공유 차트 목록"을 거의
   동시에 요청하는데, 둘 다 사실은 같은 Firestore 조회(getChartsOnce)
   결과를 서로 다르게 나눠 쓰는 것뿐이다. 두 요청이 겹치는 아주 짧은
   순간에는 새로 조회하지 않고 이미 날아간 요청 하나를 같이 기다려서,
   같은 데이터를 두 번 읽는 것을 피한다. */
let chartsOnceInFlight = null;
function fbGetChartsOnceShared() {
  if (!fbUser) return Promise.resolve([]);
  if (!chartsOnceInFlight) {
    chartsOnceInFlight = fbGetAllMyCharts().finally(() => {
      chartsOnceInFlight = null;
    });
  }
  return chartsOnceInFlight;
}

async function fbListMyPersonalCharts() {
  if (!fbUser) return [];
  const charts = await fbGetChartsOnceShared();
  return fbListPersonalCharts(charts);
}

function validateChartMetaFields(data, base) {
  const has = (k) => data[k] !== undefined && data[k] !== null;
  const fields = {};

  if (has("name")) {
    const name = strLimited(data.name, LIMITS.name, "차트 이름").trim();
    if (!name) {
      throw new Error("차트 이름을 입력해주세요.");
    }
    fields.name = name;
  }

  const rangeStart = has("rangeStart") ? String(data.rangeStart).trim() : base.rangeStart;
  const rangeEnd = has("rangeEnd") ? String(data.rangeEnd).trim() : base.rangeEnd;

  if (has("rangeStart")) {
    if (rangeStart && !isRealDateStr(rangeStart)) {
      throw new Error("표시 시작일 형식이 올바르지 않습니다.");
    }
    fields.rangeStart = rangeStart;
  }
  if (has("rangeEnd")) {
    if (rangeEnd && !isRealDateStr(rangeEnd)) {
      throw new Error("표시 종료일 형식이 올바르지 않습니다.");
    }
    fields.rangeEnd = rangeEnd;
  }
  if (rangeStart && rangeEnd && rangeEnd < rangeStart) {
    throw new Error("표시 종료일은 시작일보다 빠를 수 없습니다.");
  }

  if (has("hidden")) {
    fields.hidden = !!data.hidden;
  }
  if (has("order")) {
    fields.order = Number(data.order) || 0;
  }

  return fields;
}

/* (성능) chart 메타(특히 calendarId)는 작업 하나 고칠 때마다 매번
   다시 읽지 않고, 이 페이지가 켜져 있는 동안만 잠깐 기억해둔다.
   addCalendarToChart/removeCalendarFromChart/updateChart처럼 chart
   문서가 실제로 바뀌는 액션에서만 캐시를 지워서 다음 읽기 때 새로
   받아오게 한다. (여러 탭에서 동시에 캘린더를 추가/삭제하는 건
   원래도 드문 경우라, 이 정도 캐시로 인한 아주 짧은 지연은 감수한다.) */
const chartMetaCache = {};

async function getChartMetaCached(chartId) {
  if (!chartMetaCache[chartId]) {
    chartMetaCache[chartId] = fb.getChartOnce(chartId);
  }
  return chartMetaCache[chartId];
}

function invalidateChartMetaCache(chartId) {
  delete chartMetaCache[chartId];
}

async function coreApiPost(action, chartId, body = {}) {
  switch (action) {
    case "load":
    case "loadChart": {
      const [tasks, categories] = await Promise.all([
        fb.getTasksOnce(chartId), fb.getCategoriesOnce(chartId)
      ]);
      /* (마이그레이션, 1회성) Rules를 get() 없는 새 버전으로 바꾸기 전엔
         기존 작업/카테고리 문서에 ownerId/memberEmails 복사값이 없다.
         이 차트를 여는 시점에 한 번 조용히 채워 넣는다 — 이미 채워져
         있으면(마이그레이션 끝났으면) 아무 일도 안 하고 그냥 지나간다.
         Rules를 새 버전으로 바꾸기 *전에* app2.js를 먼저 올려서 이
         자동 채우기가 한 번씩 돌게 한 다음에 Rules를 바꿔야 안전하다. */
      const needsAclStamp = tasks.some((t) => t.ownerId === undefined) || categories.some((c) => c.ownerId === undefined);
      if (needsAclStamp) {
        try {
          const chartForStamp = await getChartMetaCached(chartId);
          if (chartForStamp) {
            await fb.restampChartAcl(chartId, chartForStamp.ownerId, chartForStamp.memberEmails || []);
          }
        } catch (error) {
          console.error("ACL 마이그레이션 실패(다음에 다시 시도됨):", error);
        }
      }
      return { ok: true, data: resolveTasksAndCats({ tasks, categories }) };
    }

    case "create": {
      /* (성능) 서로 의존 관계가 없는 읽기(카테고리 목록 검증용, 작업
         개수 - 순서 계산용, 차트 메타 - 캘린더 확인용)를 순서대로 기다리지
         않고 동시에 보낸다. */
      const [cats, existingTasks, chart] = await Promise.all([
        fb.getCategoriesOnce(chartId), fb.getTasksOnce(chartId), getChartMetaCached(chartId)
      ]);
      const t = applyTaskFields(
        { name: "", categoryId: "", start: "", end: "", progress: 0, color: "", memo: "", target: "", owner: "", ownerEmail: "" },
        body.data || {}, cats
      );
      const ref = await fb.createTask(chartId, { ...t, order: existingTasks.length },
        { ownerId: chart ? chart.ownerId : fbUser && fbUser.uid, memberEmails: chart ? (chart.memberEmails || []) : [] });
      await syncCalendarOnCreate(chart, chartId, ref.id, t);
      return { ok: true, result: ref.id };
    }

    case "update": {
      const data = body.data || {};
      const [task, cats, chart] = await Promise.all([
        fb.getTaskOnce(chartId, String(data.id)), fb.getCategoriesOnce(chartId), getChartMetaCached(chartId)
      ]);
      if (!task) {
        throw new Error("해당 작업을 찾을 수 없습니다.");
      }
      const t = applyTaskFields(task, data, cats);
      await fb.updateTask(chartId, task.id, t);
      await syncCalendarOnUpdate(chart, chartId, task.id, { ...t, calendarEventId: task.calendarEventId });
      return { ok: true, result: null };
    }

    case "delete": {
      const [task, chart] = await Promise.all([
        fb.getTaskOnce(chartId, String(body.id)), getChartMetaCached(chartId)
      ]);
      if (!task) {
        throw new Error("삭제할 작업을 찾을 수 없습니다.");
      }
      await fb.deleteTask(chartId, task.id);
      await syncCalendarOnDelete(chart, task);
      return { ok: true, result: null };
    }

    case "reorder":
      await fb.reorderTasks(chartId, body.ids || []);
      return { ok: true, result: null };

    case "createCategory": {
      const data = body.data || {};
      const c = cleanCategory(
        { name: data.name === undefined ? "새 카테고리" : data.name, color: data.color },
        { name: "새 카테고리", color: DEFAULT_COLOR }
      );
      const [existingCats, chartForCat] = await Promise.all([
        fb.getCategoriesOnce(chartId), getChartMetaCached(chartId)
      ]);
      const ref = await fb.createCategory(chartId, { ...c, order: existingCats.length },
        { ownerId: chartForCat ? chartForCat.ownerId : fbUser && fbUser.uid, memberEmails: chartForCat ? (chartForCat.memberEmails || []) : [] });
      return { ok: true, result: ref.id };
    }

    case "updateCategory": {
      const data = body.data || {};
      const cat = await fb.getCategoryOnce(chartId, String(data.id));
      if (!cat) {
        throw new Error("카테고리를 찾을 수 없습니다.");
      }
      const c = cleanCategory(data, { name: cat.name, color: validColorStr(cat.color) || DEFAULT_COLOR });
      await fb.updateCategory(chartId, cat.id, c);
      return { ok: true, result: null };
    }

    case "deleteCategory":
      await fb.deleteCategory(chartId, String(body.id));
      return { ok: true, result: null };

    case "reorderCategories":
      await fb.reorderCategories(chartId, body.ids || []);
      return { ok: true, result: null };

    case "listCharts": {
      const result = await fbListMyPersonalCharts();
      return { ok: true, result };
    }

    case "createChart": {
      const data = body.data || {};
      const name = strLimited(data.name === undefined ? "새 차트" : data.name, LIMITS.name, "차트 이름").trim() || "새 차트";
      const fields = validateChartMetaFields(data, { rangeStart: "", rangeEnd: "" });
      if (!fbUser) {
        throw new Error("로그인이 필요합니다.");
      }
      const ref = await fb.createChart(fbUser.uid, fbUser.email, name);
      if (fields.rangeStart !== undefined || fields.rangeEnd !== undefined) {
        await fb.updateChartMeta(ref.id, fields);
      }
      const result = {
        id: ref.id, name, rangeStart: fields.rangeStart || "", rangeEnd: fields.rangeEnd || "",
        hidden: false, order: 0
      };
      /* (성능 개선) 차트 추가/삭제/이름변경 직후 화면에 쓰려고 클라이언트가
         전체 목록을 다시 받아오는 왕복을 또 보냈는데, 여기서 만든 최신
         목록을 같은 응답에 실어서 그 중복 왕복을 없앤다. */
      return { ok: true, result, charts: await fbListMyPersonalCharts() };
    }

    /* (Firebase 전환으로 단순해진 점) 예전엔 "공유 해제 후 개인 차트로
     * 되돌리기" 할 때 새 차트를 만들어 데이터를 전부 복사해야 했지만,
     * 이제는 같은 Firestore 문서를 그대로 쓰므로 멤버만 비우면 끝난다
     * (shareFetch의 revokeAllSharing 참고). 이 액션은 "다른 데이터로
     * 새 차트를 만들기" 용도로만 남겨둔다(당장 UI에서 쓰는 곳은 없지만
     * 호환을 위해 유지). */
    case "createChartWithData": {
      if (!fbUser) {
        throw new Error("로그인이 필요합니다.");
      }
      const data = body.data || {};
      const name = strLimited(data.name === undefined ? "새 차트" : data.name, LIMITS.name, "차트 이름").trim() || "새 차트";
      const fields = validateChartMetaFields(data, { rangeStart: "", rangeEnd: "" });
      const ref = await fb.createChart(fbUser.uid, fbUser.email, name);
      if (fields.rangeStart !== undefined || fields.rangeEnd !== undefined) {
        await fb.updateChartMeta(ref.id, fields);
      }

      /* 새로 만드는 차트라 아직 멤버가 없다 — ownerId/memberEmails 복사값은
         소유자만, 멤버는 빈 배열로 찍어둔다(성능/Rules 수정 참고). */
      const newChartAcl = { ownerId: fbUser.uid, memberEmails: [] };

      const catIdMap = {};
      let catOrder = 0;
      for (const cat of body.categories || []) {
        const catRef = await fb.createCategory(ref.id, { name: cat.name, color: cat.color, order: catOrder++ }, newChartAcl);
        catIdMap[cat.id] = catRef.id;
      }

      let taskOrder = 0;
      for (const t of body.tasks || []) {
        await fb.createTask(ref.id, {
          name: t.name, categoryId: catIdMap[t.categoryId] || "",
          start: t.start, end: t.end, progress: t.progress, color: t.color,
          memo: t.memo, target: t.target, owner: t.owner, ownerEmail: t.ownerEmail || "", order: taskOrder++
        }, newChartAcl);
      }

      const result = {
        id: ref.id, name, rangeStart: fields.rangeStart || "", rangeEnd: fields.rangeEnd || "",
        hidden: false, order: 0
      };
      return { ok: true, result };
    }

    case "updateChart": {
      const data = body.data || {};
      /* (버그 수정) 고칠 차트는 data.id가 먼저다. 예전엔 chartId를 먼저 써서,
         모음(셸) 페이지의 "차트 관리"에서 숨기기/이름 저장을 누르면 셸의
         CHART_ID("default")를 고치려다 권한 오류가 났다. */
      const targetId = data.id || chartId;
      const chart = await fb.getChartOnce(targetId);
      if (!chart) {
        throw new Error("차트를 찾을 수 없습니다.");
      }
      const fields = validateChartMetaFields(data, chart);
      if (Object.keys(fields).length) {
        await fb.updateChartMeta(targetId, fields);
        invalidateChartMetaCache(targetId);
      }
      return { ok: true, result: null, charts: await fbListMyPersonalCharts() };
    }

    case "deleteChart": {
      const id = body.id || chartId;
      if (!id) {
        throw new Error("삭제할 차트를 찾을 수 없습니다.");
      }
      const chart = await fb.getChartOnce(id);
      if (!chart) {
        throw new Error("삭제할 차트를 찾을 수 없습니다.");
      }
      if (chart.calendarId) {
        try {
          await calDeleteCalendar(chart.calendarId);
        } catch (error) {
          console.error(error);
        }
      }
      /* (조직 관리 2단계) 조직 목록 문서부터 정리 — 차트가 먼저 없어지면 규칙이 확인을 못 한다 */
      if ((chart.orgIds || []).length && typeof fb.removeChartOrgIndexes === "function") {
        try {
          await fb.removeChartOrgIndexes(id, chart.orgIds);
        } catch (error) {
          console.error(error);
        }
      }
      await fb.deleteChart(id);
      invalidateChartMetaCache(id);
      return { ok: true, result: null, charts: await fbListMyPersonalCharts() };
    }

    case "addCalendarToChart": {
      const chart = await fb.getChartOnce(chartId);
      if (!chart) {
        throw new Error("차트를 찾을 수 없습니다.");
      }
      if (chart.calendarId) {
        return { ok: true, result: { already: true } };
      }
      const calendarId = await calCreateCalendar(chart.name + " - 간트차트");
      const tasks = await fb.getTasksOnce(chartId);
      for (const task of tasks) {
        try {
          const eventId = await calCreateEvent(calendarId, task);
          await fb.updateTask(chartId, task.id, { calendarEventId: eventId });
        } catch (error) {
          console.error(error);
        }
      }
      await fb.updateChartMeta(chartId, { calendarId });
      invalidateChartMetaCache(chartId);
      return { ok: true, result: { already: false } };
    }

    case "removeCalendarFromChart": {
      const chart = await fb.getChartOnce(chartId);
      if (!chart) {
        throw new Error("차트를 찾을 수 없습니다.");
      }
      if (!chart.calendarId) {
        return { ok: true, result: { missing: true } };
      }
      try {
        await calDeleteCalendar(chart.calendarId);
      } catch (error) {
        /* (버그 수정, 문제 1) 404(이미 없음)일 때만 "이미 지워진 걸로 치고"
           계속 진행하고, 그 외 오류는 그대로 사용자에게 보여주고
           calendarId도 그대로 둬서 다시 시도할 수 있게 한다. */
        if (error.status !== 404) {
          throw error;
        }
        console.error(error);
      }
      await fb.updateChartMeta(chartId, { calendarId: "" });
      invalidateChartMetaCache(chartId);
      const tasks = await fb.getTasksOnce(chartId);
      for (const task of tasks) {
        if (task.calendarEventId) {
          await fb.updateTask(chartId, task.id, { calendarEventId: "" });
        }
      }
      return { ok: true, result: { missing: false } };
    }

    case "exportChartCsv": {
      const [tasks, categories] = await Promise.all([
        fb.getTasksOnce(chartId), fb.getCategoriesOnce(chartId)
      ]);
      return { ok: true, result: buildCsvForBucket({ tasks, categories }) };
    }

    default:
      throw new Error("알 수 없는 action입니다: " + action);
  }
}

async function apiGet() {
  const chartId = IS_SHARED_CHART ? SHARED_CHART_ID : CHART_ID;
  const result = await coreApiPost("loadChart", chartId, {});

  /* (성능 수정) 예전엔 "shared:" 접두사가 붙은 URL(?chart=shared:X)로
     열렸을 때만 역할을 확인했다. 이제 셸 화면이 개인/공유 박스 전부
     접두사 없는 같은 chartId로 iframe을 여니(아래 shellRenderList 참고,
     박스 상태가 바뀌어도 iframe을 다시 로드하지 않기 위해), 이 체크도
     접두사와 상관없이 "내가 소유자가 아닌 차트"면 항상 하도록 바꾼다. */
  if (fbUser) {
    const chart = await getChartMetaCached(chartId);
    if (chart && chart.ownerId !== fbUser.uid) {
      /* (조직 관리 2단계) 조직을 통한 권한도 함께 본다 */
      const memberships = (chart.orgIds || []).length ? await fbMyOrgMemberships() : [];
      const role = chartMyRole(chart, memberships) || "viewer";
      if (role === "viewer") {
        document.body.classList.add("shared-viewer-readonly");
      }
    }
  }

  return result.data;
}

/* (디자인 추가분) "마지막 저장" 시각. 읽기만 하는 요청은 빼고, 저장이
   성공하면 localStorage에 적어 둔다. 같은 사이트의 셸 페이지와 iframe들이
   모두 같은 값을 보고, 셸은 storage 이벤트로 바로 알아챈다. */
const READ_ONLY_ACTIONS = ["load", "loadChart", "listCharts", "exportChartCsv"];
const LAST_SAVED_KEY = "ganttLastSavedAt";

function markSaved(action) {
  if (READ_ONLY_ACTIONS.includes(action)) return;
  try { localStorage.setItem(LAST_SAVED_KEY, String(Date.now())); } catch (error) { /* 무시 */ }
  if (IS_SHELL_MODE && typeof shellUpdatePageSub === "function") shellUpdatePageSub();
}

async function apiPost(action, data = {}) {
  const chartId = IS_SHARED_CHART ? SHARED_CHART_ID : CHART_ID;
  const result = await coreApiPost(action, chartId, data);
  markSaved(action);
  return result;
}

/* 멀티 차트 화면에서 "지금 보고 있는 차트(CHART_ID)"가 아니라, 차트 박스마다
   있는 캘린더 추가/삭제·CSV 내보내기 버튼이 그 박스의 차트 하나만 골라서
   쓰는 용도. apiPost처럼 CHART_ID를 자동으로 끼워 넣지 않는다. */
async function apiPostForChart(action, chartId, data = {}) {
  const result = await coreApiPost(action, chartId, data);
  markSaved(action);
  return result;
}


/* =========================================================
 * TOAST / BUSY
 * ========================================================= */

let toastTimer = null;


/* (버그 수정) 알림 상자 위치:
   - 모음(셸) 페이지: #toast 는 숨겨진 단일 차트 화면 안에 있어서 안 보였다 → #mcToast 사용
   - 카드 안 iframe: 키 큰 iframe의 맨 아래(화면 밖)에 떠서 안 보였다 → 부모(셸)에게 넘겨 띄운다 */
function isEmbeddedChart() {
  return !IS_SHELL_MODE && document.documentElement.classList.contains("is-embedded");
}

function postToastToParent(data) {
  try {
    window.parent.postMessage({ type: "gantt:toast", ...data }, window.location.origin);
    return true;
  } catch (error) {
    return false;
  }
}

function showToast(message, isError = false, duration = 2500) {

  if (isEmbeddedChart() && postToastToParent({ message, isError, duration })) {
    return;
  }

  const toast = document.getElementById(IS_SHELL_MODE ? "mcToast" : "toast");

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

  if (isEmbeddedChart() && postToastToParent({ hide: true })) {
    return;
  }

  const toast = document.getElementById(IS_SHELL_MODE ? "mcToast" : "toast");

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

  /* (디자인 추가분) 버튼 안에 아이콘(svg)이 있으므로 글자만이 아니라
     내용 전체를 기억했다가 그대로 되돌린다. */
  const original = button ? button.innerHTML : "";

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
      button.innerHTML = original;
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

    /* (요청사항) 처음 한 번 불러온 뒤로는 실시간 반영 */
    if (fbUser) startLiveSync();

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
 * (요청사항) 실시간 반영
 *  - 처음 불러온 뒤 이 차트의 작업·카테고리를 Firestore 에서 지켜보다가
 *    다른 사람(또는 다른 탭)이 바꾸면 새로고침 없이 바로 다시 그린다
 *  - 화면을 누르고 끄는 중(막대·순서·기간 조절)에는 기다렸다가 손을 뗀 뒤 반영
 *  - 내용이 지금 화면과 같으면(내가 방금 저장한 것 등) 다시 그리지 않는다
 * ========================================================= */
let liveSyncUnsubs = [];
let livePointerHeld = false;

document.addEventListener("pointerdown", () => { livePointerHeld = true; }, true);
["pointerup", "pointercancel"].forEach((type) => {
  document.addEventListener(type, () => { livePointerHeld = false; }, true);
});

function stopLiveSync() {
  liveSyncUnsubs.forEach((unsub) => { try { unsub(); } catch (e) { /* 무시 */ } });
  liveSyncUnsubs = [];
}

function startLiveSync() {
  if (IS_SHELL_MODE || liveSyncUnsubs.length || typeof fb.listenTasks !== "function") return;
  const chartId = IS_SHARED_CHART ? SHARED_CHART_ID : CHART_ID;
  const latest = { tasks: null, categories: null };
  let timer = null;

  const apply = () => {
    timer = null;
    if (!latest.tasks || !latest.categories) return;
    if (livePointerHeld || state.draggingTaskId || document.body.classList.contains("is-dragging")) {
      timer = setTimeout(apply, 400);
      return;
    }
    const data = resolveTasksAndCats({ tasks: latest.tasks, categories: latest.categories });
    if (JSON.stringify([data.tasks, data.categories]) === JSON.stringify([state.tasks, state.categories])) return;
    state.tasks = data.tasks;
    state.categories = data.categories;
    render();
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(apply, 250);
  };
  const stop = (error) => {
    console.warn("실시간 반영을 멈춥니다:", error && error.message);
    stopLiveSync();
  };

  liveSyncUnsubs = [
    fb.listenTasks(chartId, (tasks) => { latest.tasks = tasks; schedule(); }, stop),
    fb.listenCategories(chartId, (categories) => { latest.categories = categories; schedule(); }, stop)
  ];
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


/* (버그 수정) 오늘이 지금 창(연도 또는 지정한 표시 기간)의 몇 번째 날인지.
   창 밖이면 null. 예전엔 "그 해의 몇 번째 날"(dayOfYear)을 써서, 표시
   기간을 지정하면 오늘 버튼·오늘 선이 엉뚱한 곳을 가리켰다. */
function todayWindowDay() {
  const now = new Date();
  const day = dayOffsetFromYearStart(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  return day >= 0 && day < windowTotalDays() ? day : null;
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


/* (요청사항) 막대 위 글씨가 바탕색에 묻히지 않게: 흰 글씨와 진한 글씨 중
   실제 바탕과 명암 대비가 더 큰 쪽을 고른다(WCAG 대비 계산). */
function relativeLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const channel = value => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function barTextStyle(backgroundHex) {
  const bg = validHex(backgroundHex) || DEFAULT_COLOR;
  const lum = relativeLuminance(bg);
  const dark = "#111827";
  const whiteContrast = 1.05 / (lum + 0.05);
  const darkContrast = (lum + 0.05) / (relativeLuminance(dark) + 0.05);
  return whiteContrast >= darkContrast
    ? "color:#ffffff;text-shadow:0 1px 2px rgba(0,0,0,.35)"
    : "color:" + dark + ";text-shadow:0 1px 0 rgba(255,255,255,.35)";
}


/* =========================================================
 * RENDER
 * ========================================================= */

function render() {

  updateOwnerFilterButton(); /* (조직 관리 3단계) */

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
  fitChartHeightToRows();
  applyGanttHeight();
  computeRowScale();

  renderTaskColumn();
  renderTimeline();
  updateRangeLabel();
  renderRangeMonths();

  if (hSlider) hSlider.layout();
  if (vSlider) vSlider.layout();

  if (isYearPickerOpen()) {
    renderYearPicker();
  }

  if (state.scrollToToday) {
    state.scrollToToday = false;
    scrollTimelineToToday();
  }

  syncRowHeightSlider();
  postStatsToParent();
}


/* (디자인 추가분) 모음(셸) 페이지 카드 머리·사이드바에 보여줄 요약값을
   부모에게 알려준다: 평균 진행률, 카테고리 목록, 지금 보이는 기간. */
function postStatsToParent() {

  if (IS_SHELL_MODE || window.parent === window) {
    return;
  }

  const tasks = state.tasks || [];
  const avg = tasks.length
    ? Math.round(tasks.reduce((sum, t) => sum + (Math.max(0, Math.min(100, Number(t.progress) || 0))), 0) / tasks.length)
    : null;

  try {
    window.parent.postMessage({
      type: "gantt:stats",
      chartId: CHART_ID,
      avgProgress: avg,
      categories: (state.categories || []).map(c => ({ name: c.name, color: validHex(c.color) || DEFAULT_COLOR })),
      groups: sidebarTaskGroups(),
      windowStart: dateKey(getYearStart()),
      windowEnd: dateKey(getYearEnd()),
      windowDays: windowTotalDays(),
      custom: !!state.customStart,
      year: state.year,
      taskYears: taskYearsList(),
      readonly: document.body.classList.contains("shared-viewer-readonly"),
      /* (요청사항) 담당자별 보기 버튼을 카드 머리로 옮겨서, 목록·고른 사람도 함께 보낸다 */
      ownerPeople: ownerFilterPeople().map(p => ({ kind: p.kind, value: p.value, label: p.label, count: p.count, me: !!p.me })),
      ownerFilter: state.ownerFilter || null,
      taskCount: tasks.length,
      /* (요청사항) 마감 알림: 지연·임박 작업 */
      dueTasks: tasks.map((t) => ({ t, due: taskNoticeStage(t) })).filter((x) => x.due).map(({ t, due }) => ({
        id: t.id, name: t.name, end: t.end, progress: normProgress(t.progress),
        owner: t.owner || "", ownerEmail: t.ownerEmail || "", stage: due.stage, kind: due.kind, days: due.days, label: due.label,
        endChangedAt: Number(t.endChangedAt) || 0
      }))
    }, window.location.origin);
  } catch (error) {
    // 교차 출처 등 예외적인 경우만 조용히 무시.
  }
}


/* (요청사항) 큰 연도 버튼을 카드 머리의 기간 알약으로 옮기면서, 연도 선택창의
   "일정 있음" 점을 그리기 위해 일정이 걸쳐 있는 연도 목록도 함께 보낸다. */
function taskYearsList() {

  const years = new Set();

  (state.tasks || []).forEach(task => {
    if (!task.start || !task.end) return;
    const from = Number(String(task.start).slice(0, 4));
    const to = Number(String(task.end).slice(0, 4));
    if (!from || !to || to < from || to - from > 50) return;
    for (let year = from; year <= to; year++) years.add(year);
  });

  return Array.from(years).sort((x, y) => x - y);
}


/* (요청사항) 사이드바 카테고리 목록용: 카테고리 순서대로, 그 카테고리의 작업
   전부(보이는 기간과 상관없이, 끌어서 정한 순서). 카테고리 없는 작업은 맨 아래 "기타". */
function sidebarTaskGroups() {

  const tasks = state.tasks || [];
  const categoryIds = new Set((state.categories || []).map(c => c.id));

  const groups = (state.categories || []).map(category => ({
    id: category.id,
    name: category.name,
    color: validHex(category.color) || DEFAULT_COLOR,
    tasks: tasks
      .filter(task => task.categoryId === category.id)
      .map(task => ({ id: task.id, name: task.name }))
  }));

  const others = tasks.filter(task => !categoryIds.has(task.categoryId));

  if (others.length) {
    groups.push({
      id: "",
      name: "기타",
      color: "#a1a1aa",
      tasks: others.map(task => ({ id: task.id, name: task.name }))
    });
  }

  return groups;
}


/* (디자인 추가분) 행 높이 슬라이더 = 차트 전체 높이(state.chartHeight).
   아래쪽 높이 손잡이와 같은 값을 다루므로 기능은 그대로다. */
const MIN_CHART_HEIGHT = 160;
const MAX_CHART_HEIGHT = 1400;

function rowHeightSliderMax() {
  const natural = 52 + (state.rowsTotal || 0) * MAX_ROW_SCALE;
  return Math.max(MIN_CHART_HEIGHT + 1, Math.min(MAX_CHART_HEIGHT, natural));
}

/* (디자인 추가분) 사용자가 높이를 직접 바꾸기 전까지는, 줄이 적으면 차트
   높이를 내용에 딱 맞춘다(아래 빈 공간이 생기지 않게). 줄이 많으면 예전처럼
   420px 안에 맞춰 줄이 촘촘해진다. */
const DEFAULT_CHART_HEIGHT = 420;

function fitChartHeightToRows() {
  if (state.chartHeightTouched) return;
  state.chartHeight = Math.max(
    MIN_CHART_HEIGHT,
    Math.min(DEFAULT_CHART_HEIGHT, 52 + (state.rowsTotal || 0))
  );
}

function syncRowHeightSlider() {
  const slider = document.getElementById("rowHeightSlider");
  if (!slider) return;
  const max = rowHeightSliderMax();
  const ratio = (state.chartHeight - MIN_CHART_HEIGHT) / (max - MIN_CHART_HEIGHT);
  slider.value = String(Math.round(Math.max(0, Math.min(1, ratio)) * 100));
  slider.style.setProperty("--progress", slider.value + "%");
}


/* 오늘이 보이도록 가로 스크롤 */
function scrollTimelineToToday() {

  const timeline = document.getElementById("timeline");

  const inner =
    timeline && timeline.querySelector(".timeline-inner");

  if (!timeline || !inner) {
    return;
  }

  const day = todayWindowDay();

  if (day === null || day < state.rangeStart || day > state.rangeEnd) {
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
        task.end >= yearStart &&
        /* (조직 관리 3단계) 담당자별 보기 */
        taskMatchesOwnerFilter(task, state.ownerFilter)
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

      /* 작업이 아예 없는 카테고리만 빈 상태로 보여 준다.
         (담당자별로 볼 때는 그 사람 작업이 없는 카테고리는 숨긴다) */
      if (!usedCategoryIds.has(category.id) && !state.ownerFilter) {
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

    /* (디자인 추가분) 접은 카테고리는 아래 작업 줄을 그리지 않는다. */
    if (state.collapsedGroups.includes(group.id)) {
      return;
    }

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

/* (요청사항) 차트를 늘려도 카테고리 줄은 이 높이(px)까지만 커진다.
   줄일 때는 작업 줄과 같은 비율로 줄고, 늘릴 때 남는 높이는 작업 줄이 나눠 갖는다. */
const MAX_CATEGORY_ROW_HEIGHT = 36;

function computeRowScale() {

  const width = Math.max(1, state.rowEnd - state.rowStart);

  const available = Math.max(1, state.chartHeight - 52);

  state.rowScale = Math.min(available / width, MAX_ROW_SCALE);

  /* 고른 구간 안에서 카테고리·작업 줄이 차지하는 "자연 높이"(경계 줄은 보이는 만큼만) */
  let categoryUnits = 0;
  let taskUnits = 0;

  selectedRowsWithCum().forEach(r => {
    const visible = Math.max(0, Math.min(r.end, state.rowEnd) - Math.max(r.start, state.rowStart));
    if (r.row.kind === "category") categoryUnits += visible;
    else taskUnits += visible;
  });

  const categoryScale = Math.min(state.rowScale, MAX_CATEGORY_ROW_HEIGHT / CATEGORY_ROW_HEIGHT);

  state.categoryRowScale = categoryScale;
  state.taskRowScale = state.rowScale;

  if (categoryScale < state.rowScale && taskUnits > 0) {
    state.taskRowScale = Math.min(
      MAX_ROW_SCALE,
      Math.max(0, available - categoryUnits * categoryScale) / taskUnits
    );
  }
}

/* 줄 종류별 배율 */
function rowScaleOf(row) {
  if (row.kind === "category") return state.categoryRowScale || state.rowScale;
  return state.taskRowScale || state.rowScale;
}


/* 화면에 보이는 첫 줄의 위쪽 끝을, 창의 맨 위(0px)에 맞추기 위해
   안쪽 콘텐츠를 위로 밀어 올리는 양(뷰포트 안에서, 배율 적용 후). */
function rowsOffset(rows) {

  if (!rows.length) {
    return 0;
  }

  return (state.rowStart - rows[0].start) * rowScaleOf(rows[0].row);
}


/* 각 줄의 실제(배율 적용) 표시 높이. 누적 반올림으로 오차가 쌓이지
   않게 한다. */
function scaledRowHeights(rows) {

  const heights = [];
  let cumulative = 0;

  rows.forEach(r => {

    cumulative += rowHeightOf(r.row) * rowScaleOf(r.row);

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

  /* (요청사항) 카드 안 차트에서는 왼쪽 위 빈칸에 [작업 | 카테고리] 추가 알약.
     원래 버튼(#addTaskBtn·#addCategoryBtn)을 눌러 기존 동작을 그대로 쓴다. */
  if (isEmbeddedChart()) {
    header.textContent = "";
    header.appendChild(buildTaskAddPill());
  }

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
      applyCategoryTint(category, group.color); /* (디자인 추가분) 카테고리 줄 전체를 그 카테고리 색으로 옅게 물들인다 */


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


      /* (디자인 추가분) 카테고리 접기/펼치기 */
      if (!group.empty) {

        const collapsed = state.collapsedGroups.includes(group.id);
        const toggle = document.createElement("button");

        toggle.type = "button";
        toggle.className = "category-toggle";
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", group.name + (collapsed ? " 펼치기" : " 접기"));
        toggle.title = collapsed ? "펼치기" : "접기";
        toggle.innerHTML =
          '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';

        toggle.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          toggleGroupCollapsed(group.id);
        });

        category.appendChild(toggle);
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


      /* (디자인 추가분) 카테고리 이름 옆에 작업 개수 배지 */
      if (!group.empty) {

        const count = document.createElement("span");

        count.className = "category-count";
        count.textContent = String(group.tasks.length);

        category.appendChild(count);
      }


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

      ${ownerBadgeHtml(task, group)}

      <div
        class="task-name"
        title="두 번 눌러 이름 수정"
      >${escapeHtml(task.name)}</div>

      ${dueChipHtml(task)}
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


/* (디자인 추가분) 카테고리 색을 흰색/검정과 섞은 옅은·진한 색들.
   CSS color-mix()로 하면 캡처 도구(html2canvas)가 그 색을 못 읽어서
   캡처가 실패하므로, 여기서 미리 계산한 hex 값을 CSS 변수로 넘긴다. */
function mixHex(hex, otherHex, ratio) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(otherHex.slice(1), 16);
  const channel = shift => Math.round(((a >> shift) & 255) * ratio + ((b >> shift) & 255) * (1 - ratio));
  return "#" + [16, 8, 0].map(shift => channel(shift).toString(16).padStart(2, "0")).join("");
}

function categoryTintVars(color) {
  const c = validHex(color) || DEFAULT_COLOR;
  return {
    "--cat-color": c,
    "--cat-bg": mixHex(c, "#ffffff", 0.10),
    "--cat-text": mixHex(c, "#18181b", 0.55),
    "--cat-badge-bg": mixHex(c, "#ffffff", 0.18),
    "--cat-badge-text": mixHex(c, "#18181b", 0.80),
    "--cat-soft-bg": mixHex(c, "#ffffff", 0.30),
    "--cat-soft-text": mixHex(c, "#18181b", 0.60)
  };
}

function applyCategoryTint(el, color) {
  Object.entries(categoryTintVars(color)).forEach(([key, value]) => el.style.setProperty(key, value));
}

function categoryTintStyle(color) {
  return Object.entries(categoryTintVars(color)).map(([key, value]) => key + ":" + value).join(";");
}


/* (디자인 추가분) 담당자가 적혀 있으면 이름 첫 글자를 카테고리 색 동그라미로 */
function ownerBadgeHtml(task, group) {

  const owner = String(task.owner || "").trim();

  if (!owner) {
    return "";
  }

  const color = validHex(group.color) || DEFAULT_COLOR;

  return `<span
        class="owner-badge"
        style="${categoryTintStyle(color)}"
        title="담당자: ${escapeHtml(owner)}"
        aria-hidden="true"
      >${escapeHtml(Array.from(owner)[0])}</span>`;
}


/* =========================================================
 * (조직 관리 3단계) 담당자를 조직원 중에서 고르기
 *  - 담당자 칸을 누르면 아래에 사람 목록이 뜬다.
 *    · 이 차트가 공유된 조직의 공유 대상 조직원만 (아래 fetchAssigneeCandidates)
 *  - 고르면 이름이 들어가고 이메일(ownerEmail)도 함께 저장된다.
 *  - 목록에 없는 사람은 지금처럼 이름을 그대로 적으면 된다.
 * ========================================================= */
let assigneeCandidatesPromise = null;

function assigneeChartId() {
  return IS_SHARED_CHART ? SHARED_CHART_ID : CHART_ID;
}

async function fetchAssigneeCandidates() {
  if (!fbUser) return [];

  /* (요청사항) 이 차트를 공유한 조직의 "공유 대상" 조직원만 고를 수 있다.
     - 조직 전체 공유: 그 조직의 조직원 모두
     - 조직원 선택 공유: 고른 조직원만 (+ 그 조직에 속한 차트 소유자)
     조직원이 아닌 사람(이메일로만 공유받은 사람·외부 업체 등)은 이름을 직접 적는다. */
  const chart = await getChartMetaCached(assigneeChartId()).catch(() => null);
  if (!chart) return [];
  const memberships = (await fbMyOrgMemberships()).filter((m) => m.status === "accepted");
  /* 조직원 목록은 그 조직원만 읽을 수 있다 */
  const orgIds = (chart.orgIds || []).filter((orgId) => memberships.some((m) => m.orgId === orgId));
  const ownerEmail = String(chart.ownerEmail || "").toLowerCase();

  const byEmail = new Map();
  const rosters = await Promise.all(orgIds.map((orgId) =>
    typeof fb.getOrgMembers === "function"
      ? fb.getOrgMembers(orgId).then((list) => ({ orgId, list })).catch(() => ({ orgId, list: [] }))
      : { orgId, list: [] }
  ));
  rosters.forEach(({ orgId, list }) => {
    const share = (chart.orgShares || {})[orgId] || {};
    list
      .filter((member) => member.status === "accepted")
      .filter((member) => share.all || (share.picked || {})[member.email] || member.email === ownerEmail)
      .forEach((member) => {
        const email = String(member.email || "").toLowerCase();
        if (!byEmail.has(email)) {
          byEmail.set(email, { email, name: member.name || "", title: member.title || "", orgName: member.orgName || "" });
        }
      });
  });

  const myEmail = String(fbUser.email || "").toLowerCase();
  if (byEmail.has(myEmail)) byEmail.get(myEmail).me = true;

  return Array.from(byEmail.values()).sort((a, b) => {
    if (a.email === myEmail) return -1;
    if (b.email === myEmail) return 1;
    return (a.name || a.email).localeCompare(b.name || b.email, "ko");
  });
}

function loadAssigneeCandidates() {
  if (!assigneeCandidatesPromise) {
    assigneeCandidatesPromise = fetchAssigneeCandidates().catch((error) => {
      console.warn("담당자 목록을 불러오지 못했습니다:", error);
      assigneeCandidatesPromise = null;
      return [];
    });
  }
  return assigneeCandidatesPromise;
}

function assigneeDisplayName(person) {
  return person.name || person.email;
}

/* 직접 적은 이름이 목록의 한 사람과 정확히 같으면 그 사람으로 연결한다 */
function assigneeMatchByName(candidates, text) {
  const value = String(text || "").trim();
  if (!value) return null;
  const hits = candidates.filter((person) => assigneeDisplayName(person) === value || person.email === value.toLowerCase());
  return hits.length === 1 ? hits[0] : null;
}

const ASSIGNEE_ICON_USER = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M5 20a7 7 0 0 1 14 0"></path></svg>';
const ASSIGNEE_ICON_PENCIL = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"></path></svg>';

let assigneeMenu = null;
let assigneeMenuInput = null;
let assigneeMenuActive = 0;

function closeAssigneeMenu() {
  if (assigneeMenu) assigneeMenu.remove();
  assigneeMenu = null;
  assigneeMenuInput = null;
}

/* (요청사항) 담당자 = 이름 + 이메일. 이메일 칸은 이름 칸 id 에 Email 을 붙인 것 */
function assigneeEmailInput(input) {
  return input ? document.getElementById(input.id + "Email") : null;
}

function setAssigneeEmail(input, email, auto) {
  const field = assigneeEmailInput(input);
  if (!field) return;
  field.value = email || "";
  field.dataset.auto = auto ? "1" : "0";
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function chooseAssignee(input, person) {
  input.value = assigneeDisplayName(person);
  input.dataset.ownerEmail = person.email;
  setAssigneeEmail(input, person.email, true);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  closeAssigneeMenu();
}

async function openAssigneeMenu(input, typed) {
  if (input.disabled || input.readOnly) return;
  const candidates = await loadAssigneeCandidates();
  if (document.activeElement !== input) return;

  const query = input.value.trim().toLowerCase();
  const chosen = input.dataset.ownerEmail || "";
  /* 칸을 막 눌렀을 때는 이미 적힌 이름과 상관없이 모두 보여 준다 */
  const showAll = !typed || !query || candidates.some((person) => person.email === chosen && assigneeDisplayName(person).toLowerCase() === query);
  const list = showAll ? candidates : candidates.filter((person) =>
    [person.name, person.email, person.title, person.orgName].some((field) => String(field || "").toLowerCase().includes(query))
  );
  const exact = candidates.some((person) => assigneeDisplayName(person).toLowerCase() === query);

  if (!assigneeMenu) {
    assigneeMenu = document.createElement("div");
    assigneeMenu.className = "assignee-menu";
    assigneeMenu.setAttribute("role", "listbox");
    /* 누르는 동안 입력칸 포커스를 잃지 않게 */
    assigneeMenu.addEventListener("mousedown", (event) => event.preventDefault());
    document.body.appendChild(assigneeMenu);
  }
  assigneeMenuInput = input;
  assigneeMenuActive = Math.max(0, list.findIndex((person) => person.email === chosen));
  assigneeMenu.innerHTML = "";

  if (!candidates.length) {
    const empty = document.createElement("div");
    empty.className = "assignee-empty";
    empty.innerHTML = ASSIGNEE_ICON_USER + "<span>이 차트를 조직에 공유하면 그 조직원 중에서 고를 수 있어요. 외부 인원은 이름을 그대로 적어 주세요.</span>";
    assigneeMenu.appendChild(empty);
  }

  list.forEach((person, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "assignee-item" + (person.email === chosen ? " selected" : "") + (index === assigneeMenuActive ? " active" : "");
    item.setAttribute("role", "option");
    const initial = Array.from(assigneeDisplayName(person))[0] || "?";
    item.innerHTML =
      '<span class="assignee-avatar" style="background:' + mcPersonColor(person.email) + '">' + escapeHtml(initial) + "</span>" +
      '<span class="assignee-text"><span class="assignee-name">' + escapeHtml(assigneeDisplayName(person)) + "</span>" +
      '<span class="assignee-sub">' + escapeHtml([person.title, person.name ? person.email : person.orgName].filter(Boolean).join(" · ")) + "</span></span>" +
      (person.me ? '<span class="assignee-me">나</span>' : "");
    item.addEventListener("click", () => chooseAssignee(input, person));
    assigneeMenu.appendChild(item);
  });

  if (typed && query && !exact) {
    const free = document.createElement("div");
    free.className = "assignee-free";
    free.innerHTML = ASSIGNEE_ICON_PENCIL + "<span>목록에 없으면 \"" + escapeHtml(input.value.trim()) + "\" 그대로 저장돼요</span>";
    assigneeMenu.appendChild(free);
  }

  if (!assigneeMenu.children.length) {
    closeAssigneeMenu();
    return;
  }

  const rect = input.getBoundingClientRect();
  const width = Math.max(rect.width, 260);
  assigneeMenu.style.width = width + "px";
  assigneeMenu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
  const below = window.innerHeight - rect.bottom;
  const height = Math.min(assigneeMenu.scrollHeight, 280);
  assigneeMenu.style.top = (below < height + 12 && rect.top > below ? rect.top - height - 6 : rect.bottom + 6) + "px";
}

function moveAssigneeActive(step) {
  if (!assigneeMenu) return;
  const items = Array.from(assigneeMenu.querySelectorAll(".assignee-item"));
  if (!items.length) return;
  assigneeMenuActive = (assigneeMenuActive + step + items.length) % items.length;
  items.forEach((item, index) => item.classList.toggle("active", index === assigneeMenuActive));
  items[assigneeMenuActive].scrollIntoView({ block: "nearest" });
}

const ASSIGNEE_INPUT_IDS = ["taskOwner", "detailOwner"];

/* 새 작업 창: 이메일을 직접 고치면 자동으로 채운 값이 아닌 것으로 */
document.addEventListener("input", (event) => {
  if (event.target && event.target.id === "taskOwnerEmail" && event.isTrusted) event.target.dataset.auto = "0";
});

document.addEventListener("focusin", (event) => {
  const input = event.target;
  if (!input || !ASSIGNEE_INPUT_IDS.includes(input.id)) return;
  openAssigneeMenu(input);
});

document.addEventListener("focusout", (event) => {
  if (event.target === assigneeMenuInput) closeAssigneeMenu();
});

document.addEventListener("input", (event) => {
  const input = event.target;
  if (!input || !ASSIGNEE_INPUT_IDS.includes(input.id) || !event.isTrusted) return;
  /* 손으로 고치면 예전 연결은 끊고, 목록의 이름과 똑같으면 그 사람으로 다시 잇는다 */
  input.dataset.ownerEmail = "";
  const emailField = assigneeEmailInput(input);
  if (emailField && emailField.dataset.auto === "1") setAssigneeEmail(input, "", false);
  loadAssigneeCandidates().then((candidates) => {
    const match = assigneeMatchByName(candidates, input.value);
    if (match) {
      input.dataset.ownerEmail = match.email;
      if (emailField && !emailField.value) setAssigneeEmail(input, match.email, true);
    }
  });
  openAssigneeMenu(input, true);
});

document.addEventListener("keydown", (event) => {
  if (!assigneeMenu || event.target !== assigneeMenuInput) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveAssigneeActive(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    const active = assigneeMenu.querySelector(".assignee-item.active");
    if (active) {
      event.preventDefault();
      active.click();
    }
  } else if (event.key === "Escape") {
    event.stopPropagation();
    closeAssigneeMenu();
  }
}, true);

window.addEventListener("resize", closeAssigneeMenu);
document.addEventListener("scroll", (event) => {
  if (assigneeMenu && !assigneeMenu.contains(event.target)) closeAssigneeMenu();
}, true);


/* =========================================================
 * (조직 관리 3단계) 담당자별 보기
 *  - "작업 추가" 줄 오른쪽 [담당자: 전체 ▾] 에서 사람을 고르면 그 사람 작업만 보인다.
 *  - 고른 사람은 이 차트·이 브라우저에 기억한다.
 *  - 보는 동안에는 순서 끌기를 잠시 막는다(가려진 작업 순서가 꼬이지 않게).
 * ========================================================= */
function ownerFilterStorageKey() {
  return "ganttOwnerFilter:" + CHART_ID;
}

function loadOwnerFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(ownerFilterStorageKey()) || "null");
    return saved && saved.kind ? saved : null;
  } catch (error) {
    return null;
  }
}

function saveOwnerFilter(filter) {
  try {
    if (filter) localStorage.setItem(ownerFilterStorageKey(), JSON.stringify(filter));
    else localStorage.removeItem(ownerFilterStorageKey());
  } catch (error) {
    // 무시
  }
}

/* 작업의 담당자를 한 사람 단위로: 이메일이 있으면 이메일, 없으면 적힌 이름 */
function taskOwnerKey(task) {
  if (task.ownerEmail) return "email:" + task.ownerEmail;
  const name = String(task.owner || "").trim();
  return name ? "name:" + name : "none";
}

function taskMatchesOwnerFilter(task, filter) {
  if (!filter) return true;
  if (filter.kind === "none") return !String(task.owner || "").trim();
  if (filter.kind === "email") {
    return task.ownerEmail === filter.value ||
      (!task.ownerEmail && !!filter.label && String(task.owner || "").trim() === filter.label);
  }
  return !task.ownerEmail && String(task.owner || "").trim() === filter.value;
}

function ownerFilterPeople() {
  const people = new Map();
  (state.tasks || []).forEach((task) => {
    const key = taskOwnerKey(task);
    const entry = people.get(key) || {
      key,
      kind: key === "none" ? "none" : key.split(":")[0],
      value: key === "none" ? "" : key.slice(key.indexOf(":") + 1),
      label: key === "none" ? "담당자 없음" : String(task.owner || "").trim() || task.ownerEmail,
      count: 0
    };
    entry.count += 1;
    people.set(key, entry);
  });

  /* 이메일로 고른 사람과 같은 이름을 손으로 적은 작업은 한 사람으로 합친다 */
  const list = Array.from(people.values());
  list.filter((p) => p.kind === "email").forEach((person) => {
    const twin = list.find((p) => p.kind === "name" && p.value === person.label);
    if (twin) {
      person.count += twin.count;
      twin.merged = true;
    }
  });

  const myEmail = fbUser ? String(fbUser.email || "").toLowerCase() : "";
  return list
    .filter((p) => !p.merged)
    .map((p) => ({ ...p, me: p.kind === "email" && p.value === myEmail }))
    .sort((a, b) => {
      if (a.me !== b.me) return a.me ? -1 : 1;
      if ((a.kind === "none") !== (b.kind === "none")) return a.kind === "none" ? 1 : -1;
      return a.label.localeCompare(b.label, "ko");
    });
}

const OWNER_FILTER_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"></circle><path d="M3 20a6 6 0 0 1 12 0"></path><path d="M16 4.5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-3.5-4.8"></path></svg>';
const OWNER_FILTER_CARET = '<svg class="owner-filter-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';

function updateOwnerFilterButton() {
  const button = document.getElementById("ownerFilterBtn");
  if (!button) return;
  const filter = state.ownerFilter;
  button.classList.toggle("active", !!filter);
  button.innerHTML = OWNER_FILTER_ICON +
    '<span class="owner-filter-label">' + (filter ? escapeHtml(filter.label) + "의 작업" : "담당자별 보기") + "</span>" +
    (filter ? '<span class="owner-filter-clear" role="button" aria-label="전체 보기" title="전체 보기">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></span>'
      : OWNER_FILTER_CARET);
}

function setOwnerFilter(filter) {
  state.ownerFilter = filter;
  saveOwnerFilter(filter);
  closeOwnerFilterMenu();
  render();
}

let ownerFilterMenu = null;

function closeOwnerFilterMenu() {
  if (ownerFilterMenu) ownerFilterMenu.remove();
  ownerFilterMenu = null;
}

/* opts 는 카드 머리(셸)에서 열 때만: iframe 이 보내 준 목록·고른 사람과, 고르면 할 일 */
function openOwnerFilterMenu(button, opts = {}) {
  if (ownerFilterMenu) {
    closeOwnerFilterMenu();
    return;
  }
  const people = opts.people || ownerFilterPeople();
  const filter = "filter" in opts ? opts.filter : state.ownerFilter;
  const total = "total" in opts ? opts.total : (state.tasks || []).length;
  const pick = opts.onPick
    ? (value) => { closeOwnerFilterMenu(); opts.onPick(value); }
    : setOwnerFilter;

  const menu = document.createElement("div");
  menu.className = "owner-filter-menu";
  menu.setAttribute("role", "menu");

  const addItem = (label, sub, count, isActive, onClick, avatarHtml) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "owner-filter-item" + (isActive ? " selected" : "");
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(isActive));
    item.innerHTML = avatarHtml +
      '<span class="assignee-text"><span class="assignee-name">' + escapeHtml(label) + "</span>" +
      (sub ? '<span class="assignee-sub">' + escapeHtml(sub) + "</span>" : "") + "</span>" +
      (count !== null ? '<span class="owner-filter-count">' + count + "</span>" : "") +
      (isActive ? '<svg class="owner-filter-check" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>' : "");
    item.addEventListener("click", onClick);
    menu.appendChild(item);
  };

  addItem("전체", "모든 담당자", total, !filter, () => pick(null),
    '<span class="assignee-avatar owner-filter-all">' + OWNER_FILTER_ICON + "</span>");

  if (people.length) menu.appendChild(Object.assign(document.createElement("div"), { className: "owner-filter-sep" }));

  people.forEach((person) => {
    const isActive = !!filter && filter.kind === person.kind && filter.value === person.value;
    const avatar = person.kind === "none"
      ? '<span class="assignee-avatar owner-filter-none">–</span>'
      : '<span class="assignee-avatar" style="background:' + mcPersonColor(person.kind === "email" ? person.value : person.label) + '">' +
        escapeHtml(Array.from(person.label)[0] || "?") + "</span>";
    const sub = person.kind === "email" ? person.value : (person.kind === "name" ? "직접 적은 이름" : "");
    addItem(person.label + (person.me ? " (나)" : ""), sub, person.count, isActive,
      () => pick({ kind: person.kind, value: person.value, label: person.label }), avatar);
  });

  document.body.appendChild(menu);
  const rect = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) + "px";
  const height = menu.offsetHeight;
  menu.style.top = (rect.top > height + 12 && window.innerHeight - rect.bottom < height + 12
    ? rect.top - height - 6 : rect.bottom + 6) + "px";
  ownerFilterMenu = menu;
}

const TASK_ADD_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h9M4 12h6M4 18h9"></path><path d="M18 9v8M14 13h8"></path></svg>';
const CATEGORY_ADD_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"></path><path d="M12 11v6M9 14h6"></path></svg>';

function buildTaskAddPill() {
  const pill = document.createElement("div");
  pill.className = "task-add-pill";
  const add = (icon, label, title, targetId) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-add-pill-btn";
    button.title = title;
    button.innerHTML = icon + "<span>" + label + "</span>";
    button.addEventListener("click", () => {
      const target = document.getElementById(targetId);
      if (target) target.click();
    });
    return button;
  };
  pill.appendChild(add(TASK_ADD_ICON, "작업", "작업 추가", "addTaskBtn"));
  pill.appendChild(Object.assign(document.createElement("span"), { className: "task-add-pill-sep" }));
  pill.appendChild(add(CATEGORY_ADD_ICON, "카테고리", "카테고리 추가", "addCategoryBtn"));
  return pill;
}

function initOwnerFilter() {
  /* (요청사항) 카드 안 차트에서는 담당자별 보기 버튼이 카드 머리(셸)에 있다 */
  if (isEmbeddedChart()) return;
  const actions = document.querySelector(".add-actions");
  if (!actions || document.getElementById("ownerFilterBtn")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.id = "ownerFilterBtn";
  button.className = "owner-filter-btn";
  button.title = "담당자별로 작업 보기";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (event.target.closest(".owner-filter-clear")) {
      setOwnerFilter(null);
      return;
    }
    openOwnerFilterMenu(button);
  });
  actions.appendChild(button);
  updateOwnerFilterButton();
}

document.addEventListener("click", (event) => {
  if (ownerFilterMenu && !ownerFilterMenu.contains(event.target)) closeOwnerFilterMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOwnerFilterMenu();
});
window.addEventListener("resize", closeOwnerFilterMenu);
window.addEventListener("scroll", (event) => {
  if (ownerFilterMenu && !ownerFilterMenu.contains(event.target)) closeOwnerFilterMenu();
}, true);


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

  /* 세로 그리드는 renderDayGrid 가 하루 너비에 맞춰 그린다(아래). */


  /* 주 헤더 */
  renderWeekHeader(inner, visibleDays, dayWidth);


  /* 세로 창: 왼쪽 목록과 정확히 같은 규칙으로 보인다. */
  const viewport = document.createElement("div");

  viewport.className = "rows-viewport";
  viewport.style.height = Math.max(1, state.chartHeight - 52) + "px";

  inner.appendChild(viewport);

  /* 월별 뒷배경 (흰색 / 옅은 회백색 번갈아) - 세로 창 안에 고정 */
  renderMonthBands(viewport, dayWidth);

  /* (요청사항) 하루 단위 세로 그리드: 촘촘해지면 2일·1주·2주·1달로 점점 줄인다 */
  renderDayGrid(viewport, visibleDays, dayWidth);

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
      applyCategoryTint(categoryRow, item.group.color); /* (디자인 추가분) */

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

/* =========================================================
 * DAY GRID (요청사항)
 *
 * 세로 그리드 간격을 하루 너비(px)에 따라 고른다.
 *   1일 → 2일 → 1주(월요일) → 2주 → 1달(1일)
 * 줄 사이가 GRID_MIN_GAP px 보다 좁아지면 다음 단계로 넘어가서, 기간이
 * 길어져도 선이 거슬릴 만큼 빽빽해지지 않는다. 머리글 날짜 눈금은 글자
 * 폭이 필요하므로 더 넉넉한 간격(LABEL_MIN_GAP)으로 같은 단계를 고른다.
 * ========================================================= */

const GRID_STEPS = [1, 2, 7, 14];
const GRID_MIN_GAP = 12;
const DAY_LABEL_MIN_GAP = 22;
const DATE_LABEL_MIN_GAP = 40;

function pickGridStep(dayWidth, forLabels = false) {

  for (const step of GRID_STEPS) {

    const needed = !forLabels
      ? GRID_MIN_GAP
      : (step <= 2 ? DAY_LABEL_MIN_GAP : DATE_LABEL_MIN_GAP);

    if (step * dayWidth >= needed) {
      return step;
    }
  }

  return "month";
}

/* 보이는 구간(0 ~ visibleDays-1) 안에서 눈금이 서는 날(구간 시작 기준 n번째 날).
   1일·2일: 매일/매달 1일부터 2일마다, 1주·2주: 월요일, 1달: 매달 1일.
   첫 칸(0)은 늘 포함한다(머리글 칸이 빈틈없이 이어지도록). */
function gridTickDays(visibleDays, step) {

  const ticks = [0];

  for (let offset = 1; offset < visibleDays; offset++) {

    const date = dateFromYearDay(state.rangeStart + offset);

    let on;

    if (step === 1) {
      on = true;
    } else if (step === 2) {
      on = (date.getDate() - 1) % 2 === 0;
    } else if (step === 7 || step === 14) {
      on = date.getDay() === 1 &&
        (step === 7 || Math.floor(dayOffsetFromYearStart(date) / 7) % 2 === 0);
    } else {
      on = date.getDate() === 1;
    }

    if (on) {
      ticks.push(offset);
    }
  }

  return ticks;
}

function renderDayGrid(container, visibleDays, dayWidth) {

  const layer = document.createElement("div");

  layer.className = "day-grid";

  const step = pickGridStep(dayWidth);

  /* 매일 그릴 만큼 넓으면 주말 칸을 옅게 칠한다 */
  if (step === 1) {
    for (let offset = 0; offset < visibleDays; offset++) {
      const weekday = dateFromYearDay(state.rangeStart + offset).getDay();
      if (weekday === 0 || weekday === 6) {
        const shade = document.createElement("div");
        shade.className = "day-grid-weekend";
        shade.style.left = (offset * dayWidth) + "px";
        shade.style.width = dayWidth + "px";
        layer.appendChild(shade);
      }
    }
  }

  gridTickDays(visibleDays, step).forEach(offset => {

    if (offset === 0) {
      return;
    }

    const date = dateFromYearDay(state.rangeStart + offset);

    const line = document.createElement("div");

    line.className =
      "day-grid-line" +
      (date.getDate() === 1 ? " month" : date.getDay() === 1 ? " week" : "");

    line.style.left = (offset * dayWidth) + "px";

    layer.appendChild(line);
  });

  container.appendChild(layer);
}


function renderWeekHeader(inner, visibleDays, dayWidth) {

  const header = document.createElement("div");

  header.className = "week-header";


  /* 1행: 월 */
  const monthRow = document.createElement("div");

  monthRow.className = "month-row";

  const monthColumns = [];

  /* (요청사항) 기간이 해를 넘어가면 1월 칸에 연도를 붙이고 경계선을 긋는다 */
  const segments = monthSegments();
  const segYear = (y) => (y === undefined ? state.year : y);
  const multiYear = segments.length > 0 && segYear(segments[0].year) !== segYear(segments[segments.length - 1].year);

  segments.forEach(({ month, year, from, to }, index) => {

    const width = (to - from + 1) * dayWidth;

    const cell = document.createElement("div");

    const now = new Date();

    cell.className =
      "month-cell" + (month % 2 === 1 ? " alt" : "") +
      ((year === undefined ? state.year : year) === now.getFullYear() &&
       month === now.getMonth() ? " current" : "");

    cell.title =
      `${year === undefined ? state.year : year}-${String(month + 1).padStart(2, "0")}`;

    /* 칸이 좁으면 '9월' 대신 '9', 더 좁으면 글자를 생략.
       (요청사항) 양 끝의 잘린 달은 '7'처럼 반쪽 글자가 어색해서, 좁으면 아예 비운다 */
    const isEdge = index === 0 || index === segments.length - 1;
    cell.textContent =
      width >= 40 ? `${month + 1}월`
      : width >= 14 && !isEdge ? String(month + 1)
      : "";

    if (multiYear && month === 0 && index > 0) {
      cell.classList.add("year-start");
      const y = segYear(year);
      /* 넓으면 "2027년 1월", 보통이면 "’27 1월", 좁으면 연도만 "’27" */
      const yearLabel = width >= 84 ? y + "년" : "’" + String(y).slice(2);
      if (width >= 56) {
        cell.innerHTML = '<span class="month-year">' + yearLabel + "</span>" + (month + 1) + "월";
      } else if (width >= 26) {
        cell.innerHTML = '<span class="month-year month-year-only">' + yearLabel + "</span>";
      }
    }

    monthRow.appendChild(cell);

    monthColumns.push(width + "px");
  });

  monthRow.style.gridTemplateColumns = monthColumns.join(" ");

  header.appendChild(monthRow);


  /* 2행: 날짜 눈금 (요청사항)
     세로 그리드와 같은 규칙으로 간격을 고른다. 칸이 넓으면 매일(날짜 숫자,
     주말은 색), 좁아지면 2일 → 1주 → 2주마다 "월/일", 더 좁으면 줄을 숨기고
     월 줄만 보인다. (헤더 높이는 늘 같아서 오늘 선·배경 위치가 어긋나지 않는다) */
  const labelStep = pickGridStep(dayWidth, true);

  const showWeekLabels = labelStep !== "month";

  const weekRow = document.createElement("div");

  weekRow.className = "week-row" + (showWeekLabels ? "" : " compact");

  const weekColumns = [];

  const ticks = showWeekLabels ? gridTickDays(visibleDays, labelStep) : [0];

  ticks.forEach((offset, i) => {

    const next = i + 1 < ticks.length ? ticks[i + 1] : visibleDays;

    const days = next - offset;

    const date = dateFromYearDay(state.rangeStart + offset);

    const end = dateFromYearDay(state.rangeStart + next - 1);

    const cell = document.createElement("div");

    cell.className = "week-cell";
    cell.title = days > 1 ? `${dateKey(date)} ~ ${dateKey(end)}` : dateKey(date);

    /* 구간 맨 앞처럼 잘린 좁은 칸은 글자가 잘려 보이므로 비워 둔다 */
    const roomy = days * dayWidth >= (labelStep <= 2 ? DAY_LABEL_MIN_GAP : DATE_LABEL_MIN_GAP) - 2;

    if (showWeekLabels && roomy) {

      if (labelStep <= 2) {
        /* 매일·2일 눈금: 날짜 숫자만. 달이 바뀌는 날은 "월/일" */
        cell.textContent = date.getDate() === 1
          ? `${date.getMonth() + 1}/1`
          : String(date.getDate());

        const weekday = date.getDay();
        if (labelStep === 1 && (weekday === 0 || weekday === 6)) {
          cell.classList.add(weekday === 0 ? "sun" : "sat");
        }
      } else {
        cell.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
      }

      if (dateKey(date) === dateKey(new Date())) {
        cell.classList.add("today");
      }
    }

    weekRow.appendChild(cell);

    weekColumns.push((days * dayWidth) + "px");
  });

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

/* =========================================================
 * (요청사항) 지연 작업 · 마감 임박
 *  - 지연: 종료일이 지났는데 진행률이 100% 가 아님
 *  - 임박: 오늘부터 3일 안에 끝나야 하는데 아직 100% 가 아님
 * ========================================================= */
/* (요청사항) 알림 단계 — 사이트 안: D-15 · D-7 · D-1 · 당일 · 지연(확인 전까지)
   메일(서버 예약 작업, 매일 오전 8시): D-15 · D-7 · D-1 · 당일 · D+1 · D+4 · D+7 · 그 뒤 일주일마다. 완료·지연 확인이면 끝 */
const DUE_NOTICE_DAYS = 15;
const DUE_SOON_DAYS = 2;

function daysBetweenKeys(fromKey, toKey) {
  const a = dateObj(fromKey);
  const b = dateObj(toKey);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

function taskDueStatus(task) {
  if (!task || !task.end || normProgress(task.progress) >= 100) return null;
  const left = daysBetweenKeys(dateKey(new Date()), task.end);
  if (left === null) return null;
  if (left < 0) {
    return task.overdueAck
      ? { kind: "overdue-ack", days: -left, label: "지연 확인됨" }
      : { kind: "overdue", days: -left, label: "지연 " + (-left) + "일" };
  }
  if (left <= DUE_SOON_DAYS) return { kind: "due-soon", days: left, label: left === 0 ? "오늘 마감" : "D-" + left };
  if (left === DUE_NOTICE_DAYS) return { kind: "upcoming", days: left, label: "D-" + left };
  return null;
}

/* (요청사항) 사이트 안 알림의 단계: D-15 에 생기고, D-2·1·당일·지연 때 단계가 바뀐다.
   종 버튼에서 [확인]을 누를 때까지 남아 있다(확인은 단계마다 따로) */
/* (요청사항) 사이트 안 알림 단계: D-15 · D-7 · D-1 · 당일 · 지연(D+1 부터 완료·지연 확인 전까지).
   단계가 바뀌면 새 알림, 같은 단계 안에서는 [확인] 전까지 그대로 남는다 */
function taskNoticeStage(task) {
  if (!task || !task.end || normProgress(task.progress) >= 100) return null;
  const left = daysBetweenKeys(dateKey(new Date()), task.end);
  if (left === null || left > DUE_NOTICE_DAYS) return null;
  if (left < 0) return task.overdueAck ? null : { stage: "overdue", kind: "overdue", days: -left, label: "지연 " + (-left) + "일" };
  const label = left === 0 ? "오늘 마감" : "D-" + left;
  if (left === 0) return { stage: "d0", kind: "due-soon", days: left, label };
  if (left === 1) return { stage: "d1", kind: "due-soon", days: left, label };
  if (left <= 7) return { stage: "d7", kind: "upcoming", days: left, label };
  return { stage: "d15", kind: "upcoming", days: left, label };
}

/* =========================================================
 * (요청사항) 담당자와 알림 받는 사람
 *  - 담당자 = 이름 + 이메일
 *  - 알림은 담당자가 정해져 있고(이메일) 이 사이트에 가입한 경우에만 그 담당자에게 간다
 *  - 그 밖의 경우(담당자 없음 · 이메일 없음 · 미가입)는 아무에게도 안 간다
 *  - 담당자 본인은 권한과 상관없이 [완료]·[지연 확인], 뷰어도 "내가 할게요"
 * ========================================================= */
function myEmailLower() {
  return fbUser ? String(fbUser.email || "").toLowerCase() : "";
}

function myDisplayName() {
  return fbUser ? (fbUser.displayName || myEmailLower().split("@")[0]) : "";
}

function canEditChartHere() {
  return !document.body.classList.contains("shared-viewer-readonly");
}

function isMyTask(task) {
  return !!task && !!task.ownerEmail && task.ownerEmail.toLowerCase() === myEmailLower();
}

function assigneeEmailValue(id) {
  const field = document.getElementById(id);
  const email = field ? field.value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function selfAssignButtonHtml(task) {
  if (!fbUser) return "";
  if (isMyTask(task)) return '<button type="button" class="assignee-self" id="selfAssignBtn" data-self="off">나 빼기</button>';
  /* 남(이메일 있는 담당자)의 작업은 편집자 이상만 바꿀 수 있다 */
  if (task.ownerEmail && !canEditChartHere()) return "";
  return '<button type="button" class="assignee-self" id="selfAssignBtn" data-self="on">내가 할게요</button>';
}

function canFinishTask(task) {
  return canEditChartHere() || isMyTask(task);
}

/* (요청사항) 끝나지 않은 모든 작업에 남은 날 칩: 지연(빨강) · D-2~당일(주황) · D-15~3(초록빛 회색) · 그 뒤(옅은 회색) */
function dueChipHtml(task) {
  if (!task || !task.end || normProgress(task.progress) >= 100) return "";
  const left = daysBetweenKeys(dateKey(new Date()), task.end);
  if (left === null) return "";
  let kind;
  let label;
  if (left < 0) {
    kind = task.overdueAck ? "overdue-ack" : "overdue";
    label = task.overdueAck ? "지연 확인됨" : "지연 " + (-left) + "일";
  } else if (left <= DUE_SOON_DAYS) {
    kind = "due-soon";
    label = left === 0 ? "오늘 마감" : "D-" + left;
  } else {
    kind = left <= DUE_NOTICE_DAYS ? "upcoming" : "later";
    label = "D-" + left;
  }
  const title = "종료일 " + task.end + (left < 0 ? " · " + (-left) + "일 지남" : left === 0 ? " · 오늘 마감" : " · " + left + "일 남음");
  return '<span class="due-chip due-chip-' + kind + '" title="' + escapeHtml(title) + '">' + escapeHtml(label) + "</span>";
}

/* (요청사항) 남은 날은 "오늘" 기준이라, 사이트를 켜 둔 채 날짜가 바뀌면 다시 그린다
   (1분마다 확인 + 탭으로 돌아왔을 때). 다시 그리면 카드 머리 종 버튼에도 바로 전해진다 */
let dueDayShown = dateKey(new Date());

function refreshIfDayChanged() {
  const today = dateKey(new Date());
  if (today === dueDayShown) return;
  dueDayShown = today;
  if (!IS_SHELL_MODE && (state.tasks || []).length) render();
}

if (!IS_SHELL_MODE) {
  setInterval(refreshIfDayChanged, 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshIfDayChanged();
  });
}

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

  const due = taskDueStatus(task);
  bar.className = "task-bar" + (due && (due.kind === "overdue" || due.kind === "due-soon") ? " is-" + due.kind : "");

  /* (디자인 변경) 막대는 줄 가운데에 놓인 얇은 알약 모양이다. */
  applyBarGeometry(bar, rowHeight || TASK_ROW_HEIGHT);

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

  /* % 글씨는 막대 오른쪽 끝에 놓인다. 진행률이 거의 다 찼으면 그 자리는
     흰빛이 덧씌워진 부분이라, 실제로 글씨 뒤에 깔리는 색으로 대비를 계산한다. */
  const textBackground = progress >= 85
    ? mixHex(color, "#ffffff", isLightColor(color) ? 0.5 : 0.7)
    : color;

  bar.innerHTML = `
    <div
      class="task-progress"
      style="width:${progress}%"
    ></div>

    <div class="task-bar-text" style="${barTextStyle(textBackground)}">
      <span class="task-bar-name">${escapeHtml(task.name)}</span>
      <span class="task-bar-pct">${progress}%</span>
    </div>
  `;

  bar.addEventListener("click", event => {

    event.stopPropagation();

    /* 꾹 눌러 옮긴 직후 따라오는 클릭은 상세창을 열지 않는다. */
    if (bar.dataset.justDragged === "1") {
      bar.dataset.justDragged = "";
      return;
    }

    showTaskDetail(task.id);
  });

  row.appendChild(bar);


  /* (요청사항) 꾹 눌러(1초) 띄운 뒤 좌우로 끌어 일정 옮기기 */
  enableBarLongPressMove(bar, row, task, visibleDays);
}


/* =========================================================
 * 막대 꾹 눌러 옮기기 (요청사항)
 *
 * - 막대를 1초 누르고 있으면(누르는 동안 막대가 차오름) 떠오른 상태가 된다.
 * - 떠오른 채로 좌우로 끌면 하루 단위로 움직이고, 막대 아래에 새 시작~끝
 *   날짜가 작게 뜬다. 손을 떼면 시작일·종료일을 같은 일수만큼 옮겨 저장한다
 *   (기간 길이는 그대로).
 * - 1초 전에 손을 떼면 평소처럼 클릭(상세창), 1초 전에 움직이면 취소.
 * - 끄는 중 Esc 를 누르면 원래 자리로 돌아간다. 뷰어(읽기 전용)는 안 된다.
 * ========================================================= */

const BAR_LONG_PRESS_MS = 1000;
const BAR_PRESS_MOVE_TOLERANCE = 6;

function shortDateLabel(date) {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function enableBarLongPressMove(bar, row, task, visibleDays) {

  /* 휴대폰에서 꾹 누르면 뜨는 메뉴/글자 선택을 막는다. */
  bar.addEventListener("contextmenu", event => event.preventDefault());

  bar.addEventListener("pointerdown", startEvent => {

    if (startEvent.button !== 0) return;
    if (document.body.classList.contains("shared-viewer-readonly")) return;

    const start = dateObj(task.start);
    const end = dateObj(task.end);

    if (!start || !end) return;

    const startX = startEvent.clientX;
    const startY = startEvent.clientY;
    const dayWidth = row.clientWidth / Math.max(1, visibleDays);

    let floating = false;
    let shiftDays = 0;
    let dateTip = null;

    bar.classList.add("pressing");

    const pressTimer = setTimeout(() => {

      floating = true;

      bar.classList.remove("pressing");
      bar.classList.add("floating");
      document.body.classList.add("is-bar-moving");

      try { bar.setPointerCapture(startEvent.pointerId); } catch (error) { /* 무시 */ }

      dateTip = document.createElement("div");
      dateTip.className = "task-bar-dates";
      dateTip.style.left = bar.style.left;
      dateTip.style.top = `calc(${bar.style.top} + ${bar.style.height} + 3px)`;
      row.appendChild(dateTip);

      updateTip();
    }, BAR_LONG_PRESS_MS);

    function shifted(date) {
      const copy = new Date(date);
      copy.setDate(copy.getDate() + shiftDays);
      return copy;
    }

    function updateTip() {
      const offset = shiftDays * dayWidth;
      bar.style.setProperty("--drag-x", offset + "px");
      if (dateTip) {
        dateTip.style.transform = `translateX(${offset}px)`;
        dateTip.textContent = `${shortDateLabel(shifted(start))} ~ ${shortDateLabel(shifted(end))}`;
      }
    }

    function onMove(event) {

      if (!floating) {
        /* 1초가 되기 전에 움직이면 꾹 누르기가 아니다(스크롤 등) → 취소 */
        if (Math.abs(event.clientX - startX) > BAR_PRESS_MOVE_TOLERANCE ||
            Math.abs(event.clientY - startY) > BAR_PRESS_MOVE_TOLERANCE) {
          finish(false);
        }
        return;
      }

      event.preventDefault();

      const next = Math.round((event.clientX - startX) / dayWidth);

      if (next !== shiftDays) {
        shiftDays = next;
        updateTip();
      }
    }

    function onKey(event) {
      if (event.key === "Escape" && floating) {
        shiftDays = 0;
        finish(false);
      }
    }

    function cleanup() {
      clearTimeout(pressTimer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      bar.classList.remove("pressing", "floating");
      bar.style.removeProperty("--drag-x");
      document.body.classList.remove("is-bar-moving");
      if (dateTip) dateTip.remove();
    }

    async function finish(save) {

      const wasFloating = floating;
      const days = shiftDays;

      cleanup();

      if (!wasFloating) return;

      /* 떠오른 뒤에 손을 뗐으면 뒤따르는 클릭으로 상세창이 열리지 않게 */
      bar.dataset.justDragged = "1";
      setTimeout(() => { bar.dataset.justDragged = ""; }, 400);

      if (!save || days === 0) return;

      const newStart = dateKey(shifted(start));
      const newEnd = dateKey(shifted(end));

      /* 바로 옮겨 보이게 한 뒤 저장한다. 실패하면 서버 기준으로 되돌린다. */
      task.start = newStart;
      task.end = newEnd;
      renderTimeline();

      try {
        await apiPost("update", { data: { id: task.id, start: newStart, end: newEnd } });
        showToast(`'${task.name}' 일정을 ${newStart} ~ ${newEnd}(으)로 옮겼습니다.`);
        await loadData(false);
      } catch (error) {
        alert("일정 저장 실패\n" + error.message);
        await loadData(false);
      }
    }

    function onUp() { finish(true); }
    function onCancel() { finish(false); }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  });
}


/* 줄 높이에 맞춰 막대(알약) 높이와 세로 위치를 정한다.
   화면과 캡처가 같은 규칙을 쓴다. */
function applyBarGeometry(bar, rowHeight) {

  /* (요청사항) 막대를 살짝 두껍게: 기본 줄(48px)에서 27px */
  const barHeight =
    Math.max(14, Math.min(32, Math.round(rowHeight * 0.56)));

  bar.style.top = Math.round((rowHeight - barHeight) / 2) + "px";
  bar.style.height = barHeight + "px";
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

  /* 오늘이 지금 창(연도 또는 지정한 표시 기간) 밖이면 그리지 않는다. */
  const todayDay = todayWindowDay();

  if (
    todayDay === null ||
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


  const taskColor = validHex(task.color) || DEFAULT_COLOR;
  const progress = Math.max(0, Math.min(100, Number(task.progress) || 0));

  const icon = path =>
    `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;

  /* 막대 색 견본: 카테고리 기본색 + 자주 쓰는 색 */
  const category = state.categories.find(item => item.id === task.categoryId);
  const swatches = Array.from(new Set([
    (category && validHex(category.color)) || "",
    "#0F766E", "#3B82F6", "#8B5CF6", "#F43F5E", "#F59E0B", "#10B981", "#64748B"
  ].filter(Boolean).map(c => c.toUpperCase()))).slice(0, 8);

  /* (디자인 변경) 글자 위주 대신: 큰 제목, 아이콘 속성 줄, 진행률 원형 그래프, 색 견본 */
  panel.innerHTML = `

    <div class="detail-layout">

      <div class="detail-main">

        <div class="detail-title">
          <span class="detail-swatch" id="detailHeadSwatch" style="background:${escapeAttr(taskColor)}"></span>
          <input id="detailName" class="detail-name-input" value="${escapeAttr(task.name)}" aria-label="작업명" placeholder="작업명">
          <button id="closeDetail" type="button" class="detail-close" aria-label="닫기">${icon('<path d="M6 6l12 12M18 6 6 18"></path>')}</button>
        </div>

        <div class="detail-props">

          <label class="detail-prop">
            <span class="detail-prop-key">${icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>')}카테고리</span>
            <span class="detail-prop-val">
              <select id="detailCategory" class="detail-chip-select">${categoryOptions}</select>
            </span>
          </label>

          <div class="detail-prop">
            <span class="detail-prop-key">${icon('<rect x="3.5" y="4.5" width="17" height="16" rx="3"></rect><path d="M3.5 9.5h17M9 2.5v3M15 2.5v3"></path>')}기간</span>
            <span class="detail-prop-val detail-dates">
              <input id="detailStart" type="date" value="${escapeAttr(task.start)}" aria-label="시작일">
              <span class="detail-dates-arrow" aria-hidden="true">→</span>
              <input id="detailEnd" type="date" value="${escapeAttr(task.end)}" aria-label="종료일">
              <span class="detail-days" id="detailHeadRange"></span>
            </span>
          </div>

          <label class="detail-prop">
            <span class="detail-prop-key">${icon('<circle cx="12" cy="8" r="3.5"></circle><path d="M5 20a7 7 0 0 1 14 0"></path>')}담당자</span>
            <span class="detail-prop-val detail-owner">
              <span class="detail-owner-avatar" id="detailOwnerAvatar" aria-hidden="true"></span>
              <input id="detailOwner" value="${escapeAttr(task.owner)}" placeholder="이름">
              <input id="detailOwnerEmail" class="assignee-email" type="email" value="${escapeAttr(task.ownerEmail || "")}" placeholder="이메일 (알림 받으려면 입력)" data-auto="0">
              ${selfAssignButtonHtml(task)}
            </span>
          </label>

          <label class="detail-prop">
            <span class="detail-prop-key">${icon('<path d="M4 20V8l8-4 8 4v12"></path><path d="M9 20v-6h6v6"></path>')}대상처</span>
            <span class="detail-prop-val">
              <input id="detailTarget" value="${escapeAttr(task.target)}" placeholder="비어 있음">
            </span>
          </label>

        </div>

        <!-- (요청사항) 메모란 = 메모 보드와 같은 편집기, 자동 저장. 아래 숨은 칸은 [저장]이 함께 보낼 값 -->
        <div id="detailMemoEditor" class="detail-memo-ed"></div>
        <textarea id="detailMemo" class="hidden" aria-hidden="true" tabindex="-1">${escapeHtml(task.memo)}</textarea>

      </div>

      <aside class="detail-side">

        <div class="detail-ring" id="detailRing" style="--progress-color:${escapeAttr(taskColor)}">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <circle class="detail-ring-track" cx="60" cy="60" r="50"></circle>
            <circle class="detail-ring-fill" id="detailRingFill" cx="60" cy="60" r="50"></circle>
          </svg>
          <div class="detail-ring-label">
            <span class="detail-ring-num" id="detailRingNum">${progress}</span><span class="detail-ring-pct">%</span>
            <span class="detail-ring-caption">진행률</span>
          </div>
        </div>

        <div class="detail-progress">
          <input id="detailProgressRange" class="progress-range" type="range" min="0" max="100" step="5" value="${progress}" aria-label="진행률 슬라이더" style="--progress-color:${escapeAttr(taskColor)};--progress:${progress}%">
          <input id="detailProgress" class="progress-num-input" type="number" min="0" max="100" value="${progress}" aria-label="진행률(%)">
        </div>

        <div class="detail-colors">
          <span class="detail-side-key">막대 색상</span>
          <div class="detail-swatches">
            ${swatches.map(c => `<button type="button" class="detail-swatch-btn" data-color="${c}" style="--sw:${c};background:${c}" aria-label="색 ${c}" title="${c}"></button>`).join("")}
            <label class="detail-swatch-custom" title="직접 고르기">
              <input id="detailColor" type="color" value="${escapeAttr(taskColor)}" aria-label="막대 색상 직접 고르기">
              ${icon('<path d="M12 5v14M5 12h14"></path>')}
            </label>
          </div>
        </div>

      </aside>

    </div>


    <div class="detail-actions">

      <button id="deleteTaskBtn" type="button" class="detail-delete">
        ${icon('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path>')}
        삭제
      </button>

      <span class="detail-actions-spacer"></span>

      <!-- (요청사항) [지연 확인 | 완료] 한 알약 — 지연 확인은 지연된 작업에만 -->
      <div class="detail-pill detail-pill-status${canFinishTask(task) ? "" : " hidden"}">
        ${canFinishTask(task) && taskDueStatus(task) && taskDueStatus(task).kind === "overdue"
          ? `<button id="ackOverdueBtn" type="button" class="detail-ack" title="확인하면 이 작업의 지연 알림을 멈춰요">${icon('<path d="M12 8v5M12 16h.01"></path><circle cx="12" cy="12" r="9"></circle>')}지연 확인</button>`
          : ""}
        ${canFinishTask(task) ? `<button id="completeTaskBtn" type="button" class="detail-complete" ${normProgress(task.progress) >= 100 ? "disabled" : ""} title="진행률을 100%로 바꾸고 알림을 멈춰요">${icon('<path d="m5 12 5 5 9-10"></path>')}${normProgress(task.progress) >= 100 ? "완료됨" : "완료"}</button>` : ""}
      </div>

      <!-- (요청사항) [취소 | 저장] 한 알약 -->
      <div class="detail-pill detail-pill-main">
        <button id="cancelDetailBtn" type="button">취소</button>
        <button id="saveDetailBtn" class="primary" type="button">저장</button>
      </div>

    </div>

  `;


  const RING_LENGTH = 2 * Math.PI * 50;

  /* 입력을 바꾸면 색 점·카테고리 칩·기간 일수·담당자 동그라미·진행률 그래프가 바로 따라 바뀐다. */
  const refreshDetailHead = () => {

    const categoryId = document.getElementById("detailCategory").value;
    const start = document.getElementById("detailStart").value;
    const end = document.getElementById("detailEnd").value;
    const color = document.getElementById("detailColor").value;
    const owner = document.getElementById("detailOwner").value.trim();

    const selected = state.categories.find(item => item.id === categoryId);
    applyCategoryTint(document.getElementById("detailCategory"), selected ? selected.color : "#a1a1aa");

    const startDate = dateObj(start);
    const endDate = dateObj(end);
    const days = document.getElementById("detailHeadRange");
    days.textContent =
      startDate && endDate && endDate >= startDate
        ? (Math.round((endDate - startDate) / 86400000) + 1) + "일"
        : "";

    const avatar = document.getElementById("detailOwnerAvatar");
    avatar.textContent = owner ? Array.from(owner)[0] : "";
    avatar.classList.toggle("empty", !owner);

    document.getElementById("detailHeadSwatch").style.background = color;
    document.getElementById("detailRing").style.setProperty("--progress-color", color);
    document.getElementById("detailProgressRange").style.setProperty("--progress-color", color);

    markSelectedSwatch(panel, color);
  };

  /* (조직 관리 3단계) 조직원 목록에서 고른 담당자의 이메일 */
  document.getElementById("detailOwner").dataset.ownerEmail = task.ownerEmail || "";

  ["detailName", "detailCategory", "detailStart", "detailEnd", "detailColor", "detailOwner"].forEach(fieldId => {
    const field = document.getElementById(fieldId);
    field.addEventListener("input", refreshDetailHead);
    field.addEventListener("change", refreshDetailHead);
  });

  panel.querySelectorAll(".detail-swatch-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.getElementById("detailColor").value = btn.dataset.color.toLowerCase();
      refreshDetailHead();
    });
  });

  mountDetailMemo(task);

  const progressRange = document.getElementById("detailProgressRange");
  const progressNumber = document.getElementById("detailProgress");

  const syncProgress = value => {
    const clamped = Math.max(0, Math.min(100, Number(value) || 0));
    progressRange.value = String(clamped);
    progressRange.style.setProperty("--progress", clamped + "%");
    document.getElementById("detailRingNum").textContent = String(clamped);
    document.getElementById("detailRingFill").style.strokeDasharray =
      (RING_LENGTH * clamped / 100) + " " + RING_LENGTH;
    return clamped;
  };

  progressRange.addEventListener("input", () => {
    progressNumber.value = String(syncProgress(progressRange.value));
  });

  progressNumber.addEventListener("input", () => syncProgress(progressNumber.value));

  syncProgress(progress);
  refreshDetailHead();

  const cancelButton = document.getElementById("cancelDetailBtn");

  if (cancelButton) {
    cancelButton.onclick = () => {
      panel.classList.add("hidden");
      state.selectedTask = null;
    };
  }


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

  /* (요청사항) 완료: 진행률 100% 로 저장 → 이 작업 알림은 더 없음 */
  const completeButton = document.getElementById("completeTaskBtn");

  if (completeButton) {
    completeButton.onclick = () => {
      /* 편집 권한이 없는 담당자(뷰어)는 진행률만 100% 로 */
      if (!canEditChartHere()) {
        quickTaskUpdate(completeButton, task.id, { progress: 100 }, "완료했어요. 이 작업 알림은 더 오지 않아요.");
        return;
      }
      const progressInput = document.getElementById("detailProgress");
      if (progressInput) progressInput.value = 100;
      saveTaskDetail(task.id);
    };
  }

  /* (요청사항) 담당자: 이메일 칸 · 내가 할게요 / 나 빼기 */
  const ownerEmailField = document.getElementById("detailOwnerEmail");
  if (ownerEmailField) {
    ownerEmailField.addEventListener("input", (event) => {
      if (event.isTrusted) ownerEmailField.dataset.auto = "0";
    });
  }

  const selfButton = document.getElementById("selfAssignBtn");

  if (selfButton) {
    selfButton.onclick = (event) => {
      event.preventDefault();
      const on = selfButton.dataset.self === "on";
      quickTaskUpdate(selfButton, task.id,
        on ? { owner: myDisplayName(), ownerEmail: myEmailLower() } : { owner: "", ownerEmail: "" },
        on ? "이 작업의 담당자가 되었어요. 마감 알림을 받아요." : "담당자에서 빠졌어요.");
    };
  }

  /* (요청사항) 지연 확인: 지연 알림만 멈춘다(작업 내용은 그대로) */
  const ackButton = document.getElementById("ackOverdueBtn");

  if (ackButton) {
    ackButton.onclick = () => quickTaskUpdate(ackButton, task.id, { overdueAck: true }, "지연을 확인했어요. 이 작업의 지연 알림을 멈춥니다.");
  }

  /* 화면 아래쪽에 열리므로 보이는 위치로 스크롤한다. */
  if (typeof panel.scrollIntoView === "function") {
    panel.scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  }
}


/* 작업의 몇 칸만 바로 저장 (완료 · 지연 확인 · 내가 할게요). 뷰어도 규칙이 허용하는 칸만 바뀐다 */
function quickTaskUpdate(button, id, fields, message) {
  return withBusy(button, "저장 중…", async () => {
    try {
      await apiPost("update", { data: { id, ...fields } });
      await loadData(false);
      showTaskDetail(id);
      showToast(message);
    } catch (error) {
      alert("저장 실패\n" + error.message);
    }
  });
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

    owner: document.getElementById("detailOwner").value,

    ownerEmail: assigneeEmailValue("detailOwnerEmail")
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

  if (typeof refreshTaskSheet === "function") refreshTaskSheet();
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
  setFieldValue("taskOwnerEmail", "");
  {
    const ownerInput = document.getElementById("taskOwner");
    if (ownerInput) ownerInput.dataset.ownerEmail = "";
  }

  const colorInput = document.getElementById("taskColor");

  if (colorInput) {
    colorInput.dataset.touched = "0";
  }

  syncTaskColor();
  refreshTaskSheet();

  const modal = document.getElementById("taskModal");

  if (modal) {
    modal.classList.remove("hidden");
  }

  const nameInput = document.getElementById("taskName");
  if (nameInput) nameInput.focus();
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

          owner: document.getElementById("taskOwner").value,

          ownerEmail: assigneeEmailValue("taskOwnerEmail")
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

  refreshCategorySheet();

  const modal = document.getElementById("categoryModal");

  if (modal) {
    modal.classList.remove("hidden");
  }

  const nameInput = document.getElementById("categoryName");
  if (nameInput) nameInput.focus();
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

    /* (조직 관리 3단계) 담당자별로 보는 중에는 가려진 작업 순서가 꼬이지 않게 막는다 */
    if (state.ownerFilter) {
      event.preventDefault();
      showToast("담당자별로 보는 중에는 순서를 바꿀 수 없어요. '전체'로 돌린 뒤 옮겨 주세요.", true);
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
    `${dateKey(dateFromYearDay(state.rangeEnd))} · ` +
    `${state.rangeEnd - state.rangeStart + 1}일`;
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

    if (opts.afterLayout) opts.afterLayout();
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

  /* (요청사항) 끝을 끄는 중(is-resizing)·가운데를 끄는 중(is-moving)을 표시해
     CSS 가 "끝을 잡으면 가운데가 옅어지는" 모양을 그린다. */
  function drag(onMove, kind) {

    const stateClass = kind === "end" ? "is-resizing" : "is-moving";
    container.classList.add(stateClass);

    function move(event) {
      onMove(event);
      layout();
      opts.onChange();
    }

    function up() {
      container.classList.remove(stateClass);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  handleA.addEventListener("pointerdown", event => {

    event.preventDefault();

    drag(e2 => {

      const value = unitAt(pos(e2));
      const [, end] = opts.getRange();

      opts.setRange(Math.min(value, end), end);
    }, "end");
  });

  handleB.addEventListener("pointerdown", event => {

    event.preventDefault();

    drag(e2 => {

      const value = unitAt(pos(e2));
      const [start] = opts.getRange();

      opts.setRange(start, Math.max(value, start));
    }, "end");
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
    }, "move");
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
 * CAPTURE  (지금 화면에 보이는 차트를 그대로 이미지로 저장)
 *
 * (요청사항) 예전엔 화면 밖에 기간 전체를 원래 크기로 따로 그려서
 * 찍었다. 이제는 화면의 차트(.gantt)를 그대로 찍는다 — 확대한 기간,
 * 세로로 고른 줄, 접은 카테고리, 오늘 선이 화면과 똑같이 나온다.
 * 세로 표시 범위 슬라이더(조작용 손잡이)만 이미지에서 뺀다.
 * ========================================================= */

async function captureChart() {

  const button = document.getElementById("captureBtn");

  const gantt = document.querySelector("#chartSingleView .gantt");

  if (typeof html2canvas === "undefined") {
    alert("캡처 기능을 불러오지 못했습니다. 인터넷 연결을 확인하세요.");
    return;
  }

  if (!gantt) {
    return;
  }

  await withBusy(button, "캡처 중…", async () => {

    try {

      const canvas = await html2canvas(gantt, {
        backgroundColor: "#ffffff",
        scale: 2,
        ignoreElements: element => element.id === "vRangeSlider",
        /* (요청사항) 캡처 이미지에서만 알약 안에 작업 제목을 보여준다(화면은 그대로) */
        onclone: clonedDoc => {
          const clonedGantt = clonedDoc.querySelector("#chartSingleView .gantt");
          if (clonedGantt) clonedGantt.classList.add("capturing");
        }
      });

      const from = dateKey(dateFromYearDay(state.rangeStart));
      const to = dateKey(dateFromYearDay(state.rangeEnd));

      const link = document.createElement("a");

      // 한글 파일명은 일부 브라우저/환경에서 저장 시 깨지거나
      // "download"로만 저장되는 경우가 있어, 영문+숫자로 안전하게 만든다.
      link.download = "gantt-chart-" + from + "_" + to + ".png";
      link.href = canvas.toDataURL("image/png");
      link.click();

      showToast("화면에 보이는 차트(" + from + " ~ " + to + ")를 저장했습니다.");

    } catch (error) {

      alert("캡처 실패\n" + error.message);
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

    /* 표시 기간을 지정했으면 그 기간은 그대로 두고, 연도 보기일 때만
       올해로 옮긴다. */
    if (!state.customStart) {
      state.year = today.getFullYear();
    }

    const day = todayWindowDay();

    if (day === null) {
      showToast("오늘(" + dateKey(today) + ")은 이 차트의 표시 기간 밖입니다. 기간을 바꾸거나 '연도 보기로'를 눌러 주세요.", true, 4000);
      return;
    }

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


/* =========================================================
 * (디자인 추가분) 작업 추가 / 카테고리 창의 보기 좋은 입력들
 *  - 색 견본 동그라미를 누르면 실제 색 입력(type=color)에 값을 넣는다
 *  - 진행률 슬라이더 ↔ 숫자 칸 연동
 *  - 카테고리 칩 색, 기간 일수, 카테고리 미리보기를 바로 갱신
 * ========================================================= */

/* 색 견본 선택 표시.
   - auto 가 참이면 "카테고리 색" 버튼만 선택(작업 추가 창에서 색을 직접 안 고른 상태)
   - 견본에 없는 색이면 "+"(직접 고르기) 동그라미를 그 색으로 채워 선택 표시 */
function markSelectedSwatch(container, color, auto = false) {
  const value = String(color).toLowerCase();
  let matched = false;

  container.querySelectorAll(".detail-swatch-btn").forEach(btn => {
    const on = !auto && btn.dataset.color.toLowerCase() === value;
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-pressed", String(on));
    matched = matched || on;
  });

  const autoBtn = container.querySelector(".detail-swatch-auto");
  if (autoBtn) {
    autoBtn.classList.toggle("selected", auto);
    autoBtn.setAttribute("aria-pressed", String(auto));
  }

  const custom = container.querySelector(".detail-swatch-custom");
  if (custom) {
    const own = !auto && !matched;
    custom.classList.toggle("has-color", own);
    custom.classList.toggle("selected", own);
    custom.style.setProperty("--sw", own ? color : "transparent");
    custom.title = own ? "직접 고른 색 " + String(color).toUpperCase() + " (눌러서 바꾸기)" : "직접 고르기";
  }
}

function periodDaysLabel(start, end) {
  const startDate = dateObj(start);
  const endDate = dateObj(end);
  return startDate && endDate && endDate >= startDate
    ? (Math.round((endDate - startDate) / 86400000) + 1) + "일"
    : "";
}

function setProgressFill(range, value, color) {
  range.style.setProperty("--progress", value + "%");
  if (color) range.style.setProperty("--progress-color", color);
}

function refreshTaskSheet() {
  const modal = document.getElementById("taskModal");
  if (!modal) return;

  const colorInput = document.getElementById("taskColor");
  const color = colorInput.value;
  const categoryId = document.getElementById("taskCategory").value;
  const category = state.categories.find(item => item.id === categoryId);
  const auto = colorInput.dataset.touched !== "1";

  const autoDot = document.getElementById("taskColorAutoDot");
  if (autoDot) autoDot.style.background = categoryColorOf(categoryId);

  applyCategoryTint(document.getElementById("taskCategory"), category ? category.color : "#a1a1aa");
  document.getElementById("taskDays").textContent =
    periodDaysLabel(document.getElementById("taskStart").value, document.getElementById("taskEnd").value);

  const range = document.getElementById("taskProgressRange");
  range.value = String(Math.max(0, Math.min(100, Number(document.getElementById("taskProgress").value) || 0)));
  setProgressFill(range, range.value, color);

  markSelectedSwatch(modal, color, auto);
}

function refreshCategorySheet() {
  const modal = document.getElementById("categoryModal");
  if (!modal) return;

  const color = document.getElementById("categoryColor").value;
  const name = document.getElementById("categoryName").value.trim();

  applyCategoryTint(document.getElementById("categoryPreview"), color);
  applyCategoryTint(document.getElementById("categoryPreviewBarRow"), color);
  document.getElementById("categoryPreviewName").textContent = name || "새 카테고리";

  markSelectedSwatch(modal, color);
}

/* "카테고리 색" 버튼: 직접 고른 색을 버리고 카테고리 기본색으로 되돌린다. */
document.querySelectorAll(".detail-swatch-auto[data-auto-for]").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.autoFor);
    if (!input) return;
    input.dataset.touched = "0";
    syncTaskColor();
    refreshTaskSheet();
  });
});

document.querySelectorAll(".detail-swatch-btn[data-for]").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.for);
    if (!input) return;
    input.value = btn.dataset.color.toLowerCase();
    /* "input" 이벤트를 내서 직접 고른 색으로 기록되게 한다(작업 추가 창의 touched). */
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
});

["taskCategory", "taskStart", "taskEnd", "taskColor", "taskProgress"].forEach(id => {
  const field = document.getElementById(id);
  if (!field) return;
  field.addEventListener("input", refreshTaskSheet);
  field.addEventListener("change", refreshTaskSheet);
});

const taskProgressRange = document.getElementById("taskProgressRange");

if (taskProgressRange) {
  taskProgressRange.addEventListener("input", () => {
    setFieldValue("taskProgress", taskProgressRange.value);
    refreshTaskSheet();
  });
}

["categoryName", "categoryColor"].forEach(id => {
  const field = document.getElementById(id);
  if (field) field.addEventListener("input", refreshCategorySheet);
});


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


/* 확대/축소(좌우) + 표시 범위(상하) 슬라이더 */
let hSlider = null;
let vSlider = null;

/* 표시 기간 슬라이더의 양 끝 여백(손잡이 계산과 달 눈금이 같은 값을 쓴다) */
/* (요청사항) 양 끝 손잡이가 이제 구간 안쪽 반원이라 잘릴 일이 없다 → 여백 없이
   구간이 띠의 둥근 끝과 정확히 겹치게 한다. */
const H_SLIDER_INSET = 0;

hSlider = buildRangeSlider(document.getElementById("hRangeSlider"), {
  orientation: "h",
  inset: H_SLIDER_INSET,
  getTotal: () => windowTotalDays(),
  getRange: () => [state.rangeStart, state.rangeEnd],
  setRange: (start, end) => {
    state.rangeStart = start;
    state.rangeEnd = end;
  },
  onChange: () => {
    renderTimeline();
    updateRangeLabel();
    showRangeTip(0); /* 끄는 동안 날짜가 막대를 따라 보인다 */
  },
  afterLayout: () => markCoveredMonths()
});

/* (요청사항) 표시 기간 날짜는 늘 보여 주지 않고, 가로 막대에 마우스를 올리거나
   한 번 눌렀을 때만 막대 위에 잠깐 띄운다. 끄는 동안에는 계속 따라 보인다. */
let rangeTipTimer = 0;

function rangeTipEl() {
  const rail = document.querySelector(".h-rail");
  if (!rail) return null;
  let tip = rail.querySelector(".range-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "range-tip";
    tip.setAttribute("role", "status");
    rail.appendChild(tip);
  }
  return tip;
}

function showRangeTip(hideAfterMs) {
  const tip = rangeTipEl();
  const slider = document.getElementById("hRangeSlider");
  const bar = slider && slider.querySelector(".range-bar");
  if (!tip || !bar) return;
  tip.textContent =
    `${dateKey(dateFromYearDay(state.rangeStart))} ~ ${dateKey(dateFromYearDay(state.rangeEnd))} · ` +
    `${state.rangeEnd - state.rangeStart + 1}일`;
  tip.classList.add("visible");
  /* 막대 가운데 위에, 띠 밖으로 나가지 않게 */
  const railWidth = slider.offsetWidth;
  const center = bar.offsetLeft + bar.offsetWidth / 2;
  const half = tip.offsetWidth / 2;
  tip.style.left = Math.max(half, Math.min(railWidth - half, center)) + "px";
  clearTimeout(rangeTipTimer);
  if (hideAfterMs) rangeTipTimer = setTimeout(hideRangeTip, hideAfterMs);
}

function hideRangeTip() {
  clearTimeout(rangeTipTimer);
  const tip = document.querySelector(".h-rail .range-tip");
  if (tip) tip.classList.remove("visible");
}

function initRangeTip() {
  const slider = document.getElementById("hRangeSlider");
  if (!slider) return;
  const isBarOrEnd = (target) => target && target.closest && target.closest(".range-bar, .range-handle");
  slider.addEventListener("pointerover", (event) => {
    if (event.pointerType === "mouse" && isBarOrEnd(event.target)) showRangeTip(0);
  });
  slider.addEventListener("pointerout", (event) => {
    if (event.pointerType !== "mouse" || !isBarOrEnd(event.target)) return;
    if (slider.classList.contains("is-moving") || slider.classList.contains("is-resizing")) return;
    if (!isBarOrEnd(event.relatedTarget)) rangeTipTimer = setTimeout(hideRangeTip, 400);
  });
  /* 터치(한 번 누름)나 끌기 시작: 몇 초간 보여 준다 */
  slider.addEventListener("pointerdown", (event) => {
    if (isBarOrEnd(event.target)) showRangeTip(event.pointerType === "mouse" ? 0 : 2500);
  });
  window.addEventListener("pointerup", (event) => {
    if (!document.querySelector(".h-rail .range-tip.visible")) return;
    const touch = event.pointerType !== "mouse";
    /* 마우스가 막대 위에 그대로 있으면 계속 보이고, 아니면 잠시 뒤 사라진다 (터치는 2.5초) */
    if (touch || !slider.querySelector(".range-bar:hover, .range-handle:hover")) {
      clearTimeout(rangeTipTimer);
      rangeTipTimer = setTimeout(hideRangeTip, touch ? 2500 : 1500);
    }
  });
}

initRangeTip();

/* (요청사항) 진한 막대 아래 깔린 달 이름은 흰 글씨로 (막대가 옅어지면 CSS 가 초록으로) */
function markCoveredMonths() {
  const container = document.getElementById("hRangeSlider");
  if (!container) return;
  const bar = container.querySelector(".range-bar");
  if (!bar) return;
  const left = bar.offsetLeft;
  const right = left + bar.offsetWidth;
  container.querySelectorAll(".range-month").forEach((month) => {
    const center = month.offsetLeft + month.offsetWidth / 2 + (month.parentElement ? month.parentElement.offsetLeft : 0);
    month.classList.toggle("covered", center >= left && center <= right);
  });
}

/* (디자인 추가분) 표시 기간 슬라이더 = 미니 타임라인: 지금 창(연도 또는
   지정 기간)의 달 눈금을 슬라이더 바탕에 깔아서, 고른 구간 상자가 몇 월을
   덮고 있는지 바로 보이게 한다. */
function renderRangeMonths() {

  const container = document.getElementById("hRangeSlider");

  if (!container) {
    return;
  }

  let layer = container.querySelector(".range-months");

  if (!layer) {
    layer = document.createElement("div");
    layer.className = "range-months";
    layer.setAttribute("aria-hidden", "true");
    container.insertBefore(layer, container.firstChild.nextSibling);
  }

  const now = new Date();

  /* (요청사항) 양 끝 잘린 달은 글자를 숨기고, 해가 바뀌는 1월은 연도로 표시 */
  const months = windowMonths();
  const multiYear = months.length > 0 && months[0].year !== months[months.length - 1].year;
  layer.innerHTML = months.map(({ year, month, days }, index) => {
    const current = year === now.getFullYear() && month === now.getMonth();
    const isEdge = index === 0 || index === months.length - 1;
    const yearStart = multiYear && month === 0 && index > 0;
    const label = isEdge && days < 12 ? "" : yearStart ? "’" + String(year).slice(2) : (month + 1) + "月";
    return `<span class="range-month${current ? " current" : ""}${yearStart ? " year-start" : ""}" style="flex-grow:${days}">${label}</span>`;
  }).join("");

  markCoveredMonths();
}


/* 차트 전체 높이 손잡이: .gantt 맨 아래를 끌면 세로로 늘고 준다. */
const heightHandle = document.getElementById("chartHeightHandle");

if (heightHandle) {

  heightHandle.addEventListener("pointerdown", event => {

    event.preventDefault();

    /* (요청사항) 행 높이 슬라이더 대신 이 손잡이로 높이를 조절한다.
       차트 박스(iframe) 밖으로 마우스가 나가도 계속 따라오게 붙잡는다. */
    try { heightHandle.setPointerCapture(event.pointerId); } catch (error) { /* 무시 */ }
    heightHandle.classList.add("dragging");

    const startY = event.clientY;
    const startHeight = state.chartHeight;

    state.chartHeightTouched = true;

    function move(e2) {

      /* 행 높이 슬라이더와 같은 범위: 줄이 가장 넓을 때까지만 늘린다 */
      state.chartHeight = Math.max(
        MIN_CHART_HEIGHT,
        Math.min(rowHeightSliderMax(), startHeight + (e2.clientY - startY))
      );

      applyGanttHeight();
      computeRowScale();
      renderTaskColumn();
      renderTimeline();
      syncRowHeightSlider();
      /* 세로 띠가 차트 높이를 따라 늘고 줄 때 초록 막대도 같이 맞춘다 */
      if (vSlider) vSlider.layout();
    }

    function up() {
      heightHandle.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  });
}


const rowHeightSlider = document.getElementById("rowHeightSlider");

if (rowHeightSlider) {

  rowHeightSlider.addEventListener("input", () => {

    const ratio = Number(rowHeightSlider.value) / 100;

    state.chartHeightTouched = true;
    rowHeightSlider.style.setProperty("--progress", rowHeightSlider.value + "%");

    state.chartHeight = Math.round(
      MIN_CHART_HEIGHT + (rowHeightSliderMax() - MIN_CHART_HEIGHT) * ratio
    );

    applyGanttHeight();
    computeRowScale();
    renderTaskColumn();
    renderTimeline();
  });
}


vSlider = buildRangeSlider(document.getElementById("vRangeSlider"), {
  orientation: "v",
  /* (요청사항) 끝마개가 띠 안쪽에 그려지므로 여백 없이 띠 끝과 맞춘다 */
  inset: 0,
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

/* (버그 수정) 화면이 혼자 계속 왔다갔다 하던 문제:
   - 예전엔 창 크기가 바뀌면 0.15초 뒤에야 다시 그려서, 그 사이 타임라인이
     잠깐 넘쳐 가로 스크롤바가 생겼다 사라졌다. 그 높이 변화가 바깥 페이지
     스크롤바를 켰다 껐다 하며 폭을 또 바꾸는 반복이 생겼다.
   - iframe 높이만 바뀌어도(폭은 그대로) resize 가 와서 쓸데없이 다시 그렸다.
   이제 타임라인 "폭"이 실제로 바뀔 때만, 다음 그리기 프레임에 바로 다시 그린다. */
let lastTimelineWidth = 0;
let timelineResizeFrame = 0;

function rerenderIfTimelineWidthChanged() {

  const timeline = document.getElementById("timeline");

  if (!timeline) {
    return;
  }

  const width = timeline.clientWidth;

  if (width === lastTimelineWidth) {
    return;
  }

  lastTimelineWidth = width;

  cancelAnimationFrame(timelineResizeFrame);

  timelineResizeFrame = requestAnimationFrame(() => {
    renderTimeline();
    if (hSlider) hSlider.layout();
  });
}

if (!IS_SHELL_MODE) {

  const timelineEl = document.getElementById("timeline");

  if (timelineEl && "ResizeObserver" in window) {
    new ResizeObserver(rerenderIfTimelineWidthChanged).observe(timelineEl);
  } else {
    window.addEventListener("resize", rerenderIfTimelineWidthChanged);
  }
}


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
 * 기존 함수(request, apiPost, showToast, handleLoginButtonClick 등)를
 * 그대로 재사용하고, 새 함수만 추가한다. 기존 간트차트 로직은
 * 전혀 호출하지 않는다 (그 쪽은 그대로 숨겨 둘 뿐).
 * ========================================================= */

let shellChartsCache = [];


async function shellLoadCharts() {
  try {
    /* (성능 개선) 개인 차트 목록(apiPost("listCharts"), Drive 왕복)과
       공유 차트 목록(shareFetch("listMySharedCharts"), Apps Script 왕복)은
       서로 아무 관련이 없는 별도 요청인데, 예전에는 await를 두 번 나눠 써서
       하나가 끝나야 다음 게 시작되는 "순차 대기"가 되어 있었다. 둘 다
       동시에 보내서 더 오래 걸리는 쪽 시간만 기다리면 되게 바꾼다. */
    const personalPromise = apiPost("listCharts");

    /* (공유 기능 추가분) 내가 수락한 공유 차트도 같이 불러와서 합친다.
       공유 서버가 아직 설정 안 돼 있거나 로그인 전이면 조용히 빈 목록으로 둔다
       (개인 차트 목록 불러오기는 그것과 상관없이 항상 그대로 동작). */
    const sharedPromise = (fbUser && typeof shareFetch === "function")
      ? shareFetch("listMySharedCharts", {}).catch((error) => {
          console.error(error);
          // 공유 목록을 못 가져와도 개인 차트 목록은 그대로 보여준다.
          return [];
        })
      : Promise.resolve([]);

    /* (요청사항) "＋ 새 차트" / "차트 공유받기" 버튼 배지에 쓸 "아직
       수락 안 한 초대 개수"도 같이 받아온다(독립적인 조회라 병렬로). */
    const invitesPromise = (fbUser && typeof shareFetch === "function")
      ? shareFetch("listMyInvites", {}).catch((error) => {
          console.error(error);
          return [];
        })
      : Promise.resolve([]);

    const [result, list, invites] = await Promise.all([personalPromise, sharedPromise, invitesPromise]);
    updateInviteBadges((invites || []).length);

    const personal = (Array.isArray(result.result) ? result.result : []).map((c) => ({ ...c, shared: false }));
    /* (성능 수정) id에 "shared:" 접두사를 더 이상 붙이지 않는다. 접두사가
       붙으면, 차트를 공유/해제할 때마다 (개인 ↔ 공유 전환으로) id가
       바뀌어서 shellRenderList가 그 차트의 박스를 "새 차트"로 착각해
       박스/iframe을 통째로 지우고 새로 만들었다 — iframe이 다시 만들어질
       때마다 그 안에서 Firebase를 처음부터 새로 켜야 해서(로그인 상태
       확인, 연결 등) 공유 전환·해제가 유독 느렸던 가장 큰 원인이다.
       이제 접두사 없는 같은 chartId를 그대로 써서, 상태가 바뀌어도
       shellRenderList가 같은 박스로 인식하고 iframe은 그대로 둔 채
       버튼 영역만 바꿔 끼운다(아래 shellRenderList 참고). */
    const shared = (Array.isArray(list) ? list : []).map((c) => ({
      id: c.chartId,
      chartId: c.chartId,
      name: c.name,
      rangeStart: c.rangeStart || "",
      rangeEnd: c.rangeEnd || "",
      hidden: !!c.hidden,
      order: 999999,
      hasCalendar: false,
      shared: true,
      role: c.role,
      viaOrgOnly: !!c.viaOrgOnly,
      orgNames: c.orgNames || [],
      orgIds: c.orgIds || [],
      ownerEmail: c.ownerEmail,
      members: Array.isArray(c.members) ? c.members : []
    }));

    shellChartsCache = personal.concat(shared);
    shellRenderList();
    shellBroadcastRefreshToIframes();
    obInitShell((invites || []).length); /* (요청사항) 처음 로그인한 회원에게만 첫 화면 안내 */
    shellInitBellProfile(); /* (요청사항) 마감 알림 메일 받는 사람 목록 */
    shellRefreshBell();
    bellFetchTasks(true);
    shellOrgRefreshBadge(); /* (조직 관리 1단계) 받은 조직 초대 수 배지 — 실패해도 다른 기능에 영향 없음 */
    shellRefreshCalButtons(); /* 캘린더 추가/삭제 버튼 상태 */
  } catch (error) {
    console.error(error);
    showToast(error.message || "차트 목록을 불러오지 못했습니다.", true, 0);
  }
}

/* (버그 수정) "관리" 모달 등 부모(셸) 쪽에서 차트 메타(이름/표시기간)가
   바뀌었을 수 있을 때, 지금 떠 있는 모든 차트 박스의 iframe에게 자기
   메타를 다시 읽으라고 알려준다 — 안 그러면 iframe 안의 이름/표시기간
   표시가 새로고침 전까지 예전 값에 머물러 있는다("위아래 연동 안 됨"). */
function shellBroadcastRefreshToIframes() {
  document.querySelectorAll("#mcChartList iframe").forEach((iframe) => {
    try {
      if (iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: "gantt:refreshMeta" }, window.location.origin);
      }
    } catch (error) {
      // 교차 출처 등 예외적인 경우만 조용히 무시.
    }
  });
}

/* (성능 수정) 박스 헤더의 액션 버튼 영역(공유/캘린더/CSV/나가기 등)을
   만드는 부분을 별도 함수로 뺐다. 전엔 이 블록이 박스를 "새로 만들 때만"
   실행됐는데, 이제 공유 id에 접두사를 안 붙여서(shellLoadCharts/
   shellApplySharedChartsList 쪽 주석 참고) 같은 박스가 공유 상태만 바뀐
   채로 유지되므로, 아래 shellRenderList에서 상태가 바뀐 기존 박스에도
   이 함수를 다시 호출해 버튼 영역만 교체한다(iframe은 그대로 둔다). */
/* (디자인 추가분) 차트 박스 머리 버튼에 쓰는 선 아이콘들 */
const MC_ICONS = {
  upload: '<path d="M12 15V3m0 0 4 4m-4-4-4 4"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>',
  sheet: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"></rect><path d="M3.5 9h17M3.5 14.5h17M9.5 9v11.5"></path>',
  download: '<path d="M12 3v12m0 0 4-4m-4 4-4-4"></path><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"></path>',
  calAdd: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"></rect><path d="M3.5 9.5h17M9 2.5v3M15 2.5v3"></path><path d="M12 13v5M9.5 15.5h5"></path>',
  calRemove: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"></rect><path d="M3.5 9.5h17M9 2.5v3M15 2.5v3"></path><path d="M9.8 13.5l4.4 4.4M14.2 13.5l-4.4 4.4"></path>',
  share: '<circle cx="18" cy="5" r="2.5"></circle><circle cx="6" cy="12" r="2.5"></circle><circle cx="18" cy="19" r="2.5"></circle><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"></path>',
  users: '<circle cx="9" cy="8" r="3.2"></circle><path d="M3 20a6 6 0 0 1 12 0"></path><path d="M16 4.5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-3.5-4.8"></path>',
  leave: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"></path><path d="M10 17l-5-5 5-5M5 12h11"></path>',
  reload: '<path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"></path><path d="M3 21v-5h5"></path>',
  /* (요청사항) 전체 보기: 양쪽 끝까지 펼치기 |← →| */
  full: '<path d="M3.5 5v14M20.5 5v14"></path><path d="M7.5 12h9"></path><path d="m10 9-3 3 3 3M14 9l3 3-3 3"></path>',
  /* (요청사항) 오늘 전후 보기: 오늘 선을 가운데 두고 앞뒤로 */
  today: '<path d="M12 3.5v17"></path><circle cx="12" cy="3.5" r="1.4" fill="currentColor" stroke="none"></circle><path d="m7.5 9-3.5 3 3.5 3M16.5 9l3.5 3-3.5 3"></path>',
  capture: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-1.8h7l1 1.8h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5z"></path><circle cx="12" cy="12.5" r="3.4"></circle>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>',
  check: '<path d="m5 12 5 5 9-10"></path>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>',
  eyeOff: '<path d="M3 3l18 18"></path><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.8 0 3.3-.5 4.6-1.2"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path>',
  close: '<path d="M6 6l12 12M18 6 6 18"></path>'
};

/* =========================================================
 * (디자인 추가분) 글자만 있는 버튼에 작은 선 아이콘을 앞에 붙인다.
 *  - 버튼 글자(정확히 같은 것)만 보고 고르므로, 모르는 글자는 그대로 둔다.
 *  - 이미 아이콘(svg)이 있는 버튼, 처리 중(…) 글자는 건드리지 않는다.
 *  - 나중에 생기는 버튼(창·메뉴)도 화면이 바뀔 때마다 한 번에 훑는다.
 * ========================================================= */
const AUTO_BTN_ICON_PATHS = {
  x: '<path d="M6 6l12 12M18 6 6 18"></path>',
  check: '<path d="m5 12 5 5 9-10"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path>',
  pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"></path><path d="m14 7 3 3"></path>',
  calendar: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"></rect><path d="M3.5 9.5h17M8 3v3M16 3v3"></path>',
  today: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"></rect><path d="M3.5 9.5h17M8 3v3M16 3v3"></path><circle cx="12" cy="15" r="1.6" fill="currentColor" stroke="none"></circle>',
  users: '<circle cx="9" cy="8" r="3.2"></circle><path d="M3 20a6 6 0 0 1 12 0"></path><path d="M16 4.5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-3.5-4.8"></path>',
  leave: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"></path><path d="M10 17l-5-5 5-5M5 12h11"></path>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"></path>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"></path><path d="M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z"></path>',
  login: '<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"></path><path d="M9 17l5-5-5-5M14 12H3"></path>'
};

const AUTO_BTN_ICON_BY_LABEL = {
  "취소": "x", "거절": "x",
  "저장": "check", "확인": "check", "닫기": "check", "수락": "check",
  "추가": "plus", "조직 만들기": "plus", "새로운 차트 만들기": "plus",
  "삭제": "trash",
  "이름 바꾸기": "pencil",
  "표시 기간 설정": "calendar", "연도 보기로": "calendar",
  "올해로 이동": "today",
  "공유 권한/사용자 설정": "users", "공유 구성원 보기": "users",
  "공유 차트 나가기": "leave", "로그아웃": "leave",
  "넘기기": "swap",
  "차트 공유받기": "inbox",
  "Google 로그인": "login"
};

function autoButtonLabel(button) {
  /* 버튼 바로 안의 글자만 (배지 숫자 등 안쪽 요소는 뺀다) */
  return Array.from(button.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent)
    .join("")
    .trim();
}

function decorateTextButtons(root) {
  (root || document).querySelectorAll("button").forEach((button) => {
    if (button.querySelector("svg")) return;
    const icon = AUTO_BTN_ICON_BY_LABEL[autoButtonLabel(button)];
    if (!icon) return;
    const svg = '<svg class="mc-auto-ico" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      AUTO_BTN_ICON_PATHS[icon] + "</svg>";
    button.insertAdjacentHTML("afterbegin", svg);
    button.classList.add("has-auto-ico");
  });
}

let autoIconFrame = 0;
function scheduleDecorateTextButtons() {
  if (autoIconFrame) return;
  autoIconFrame = requestAnimationFrame(() => {
    autoIconFrame = 0;
    decorateTextButtons(document);
  });
}

if (typeof MutationObserver === "function") {
  const startAutoIcons = () => {
    decorateTextButtons(document);
    new MutationObserver(scheduleDecorateTextButtons).observe(document.body, { childList: true, subtree: true });
  };
  if (document.body) startAutoIcons();
  else document.addEventListener("DOMContentLoaded", startAutoIcons);
}

/* (디자인 추가분) 사람 동그라미 색: 이메일마다 늘 같은 색 */
const MC_PERSON_COLORS = ["#a78bfa", "#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#2dd4bf", "#fb7185"];

function mcPersonColor(key) {
  let hash = 0;
  Array.from(String(key || "")).forEach(ch => { hash = (hash * 31 + ch.codePointAt(0)) >>> 0; });
  return MC_PERSON_COLORS[hash % MC_PERSON_COLORS.length];
}

function mcAvatarEl(nameOrEmail) {
  const avatar = document.createElement("span");
  avatar.className = "mc-row-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.style.background = mcPersonColor(nameOrEmail);
  avatar.textContent = shellPersonInitial(nameOrEmail);
  return avatar;
}

/* 공유 멤버 한 줄: 동그라미 + 이메일 + (대기중) + 권한 칩 */
function mcMemberRowEl(member) {
  const row = document.createElement("div");
  row.className = "mc-share-member-row";

  row.appendChild(mcAvatarEl(member.email));

  const text = document.createElement("span");
  text.className = "mc-row-text";
  const email = document.createElement("span");
  email.className = "mc-row-title";
  email.textContent = member.email;
  text.appendChild(email);
  if (member.status === "pending") {
    const sub = document.createElement("span");
    sub.className = "mc-row-sub";
    sub.textContent = "초대 수락 대기중";
    text.appendChild(sub);
  }
  row.appendChild(text);

  const role = document.createElement("span");
  role.className = "mc-role-chip mc-role-" + member.role;
  role.textContent = { owner: "소유자", admin: "관리자", editor: "편집자", viewer: "뷰어" }[member.role] || member.role;
  row.appendChild(role);

  return row;
}

function mcIconSvg(name) {
  return '<svg class="mc-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    MC_ICONS[name] + "</svg>";
}

/* 아이콘 + 글자 버튼. iconOnly면 글자는 툴팁/스크린리더용으로만 쓴다. */
function mcActionButton(icon, label, iconOnly) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "mc-btn mc-btn-ghost" + (iconOnly ? " mc-btn-icon" : "");
  if (iconOnly) {
    btn.innerHTML = mcIconSvg(icon);
    btn.setAttribute("aria-label", label);
    btn.title = label;
  } else {
    btn.innerHTML = mcIconSvg(icon) + "<span>" + escapeHtml(label) + "</span>";
  }
  return btn;
}

/* 캘린더 추가/삭제처럼 짝을 이루는 아이콘 버튼을 회색 알약 하나로 묶는다. */
function mcButtonGroup(buttons) {
  const group = document.createElement("div");
  group.className = "mc-btn-group";
  buttons.forEach((btn) => group.appendChild(btn));
  return group;
}

/* (디자인 추가분) 차트 iframe 안의 기존 버튼을 카드 머리에서 누르기 위한 명령 전달.
   iframe은 받은 명령대로 자기 화면의 원래 버튼을 눌러서 기존 동작을 그대로 쓴다. */
function shellSendCommand(box, message) {
  const iframe = box.querySelector("iframe");
  if (!iframe || !iframe.contentWindow) return;
  try {
    iframe.contentWindow.postMessage({ type: "gantt:command", ...message }, window.location.origin);
  } catch (error) {
    // 교차 출처 등 예외적인 경우만 조용히 무시.
  }
}

/* 이름 첫 글자(한글 세 글자 이름이면 뒤 두 글자) — 프로필 동그라미용 */
function shellPersonInitial(nameOrEmail, long) {
  const raw = String(nameOrEmail || "").trim();
  const base = raw.includes("@") ? raw.split("@")[0] : raw;
  const chars = Array.from(base);
  if (!chars.length) return "?";
  if (long && /^[가-힣]{2,4}$/.test(base)) return chars.slice(-2).join("");
  return chars[0].toUpperCase();
}

function shellMyName() {
  return fbUser ? (fbUser.displayName || fbUser.email || "") : "";
}

/* 공유 버튼 안 겹친 동그라미: 나 + 같이 보는 사람 수(+N) */
function shellShareAvatarsHtml(chart) {
  const me = String((fbUser && fbUser.email) || "").toLowerCase();
  const others = chart.shared
    ? Array.from(new Set((chart.members || []).concat(chart.ownerEmail ? [chart.ownerEmail] : [])))
      .filter((email) => email && email.toLowerCase() !== me)
    : [];

  let html = '<span class="mc-avatar-stack" aria-hidden="true">' +
    '<span class="mc-avatar mc-avatar-me">' + escapeHtml(Array.from(shellPersonInitial(shellMyName() || "나", true))[0]) + "</span>";
  if (others.length) {
    html += '<span class="mc-avatar mc-avatar-other" title="' + escapeAttr(others.join(", ")) + '">+' + others.length + "</span>";
  }
  return html + "</span>";
}

/* ---- 카드 머리의 ⋯ 메뉴 / 표시 기간 창 (화면에 하나씩만 띄운다) ---- */
let shellOpenPopover = null;

function shellClosePopover() {
  if (shellOpenPopover) {
    shellOpenPopover.remove();
    shellOpenPopover = null;
  }
}

function shellPlacePopover(pop, anchor, alignRight) {
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  const width = pop.offsetWidth;
  let left = alignRight ? rect.right - width : rect.left;
  left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
  pop.style.left = (left + window.scrollX) + "px";
  pop.style.top = (rect.bottom + 6 + window.scrollY) + "px";
  shellOpenPopover = pop;
}

document.addEventListener("click", (event) => {
  if (shellOpenPopover && !shellOpenPopover.contains(event.target) && !event.target.closest("[data-popover-anchor]")) {
    shellClosePopover();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") shellClosePopover();
});

function shellCanEdit(chart) {
  if (chart.role === "viewer") return false;
  const stats = shellStats[chart.id];
  return !(stats && stats.readonly);
}

function shellOpenMoreMenu(chart, box, anchor) {
  const wasOpen = shellOpenPopover && shellOpenPopover.dataset.for === "menu:" + chart.id;
  shellClosePopover();
  if (wasOpen) return;

  const menu = document.createElement("div");
  menu.className = "mc-popover mc-menu";
  menu.dataset.for = "menu:" + chart.id;
  menu.setAttribute("role", "menu");

  const add = (label, onClick, danger) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mc-menu-item" + (danger ? " mc-menu-item-danger" : "");
    item.setAttribute("role", "menuitem");
    item.textContent = label;
    item.addEventListener("click", () => {
      shellClosePopover();
      onClick();
    });
    menu.appendChild(item);
  };

  if (shellCanEdit(chart)) {
    add("이름 바꾸기", () => shellStartRename(chart, box));
  }

  if (chart.shared && (chart.role === "owner" || chart.role === "admin")) {
    add("공유 권한/사용자 설정", () => shellOpenShareModal(chart.chartId, chart.name, true, chart.role));
  }

  if (chart.shared && chart.role !== "owner") {
    add("공유 구성원 보기", () => shellOpenMembersModal(chart.chartId));
    /* (조직 관리 2단계) 조직을 통해 들어온 차트는 조직에서 나가면 함께 빠진다 */
    if (!chart.viaOrgOnly) {
      add("공유 차트 나가기", () => shellHandleLeaveShared(chart.chartId, chart.name), true);
    }
  }

  if (!menu.children.length) {
    add("공유 구성원 보기", () => shellOpenMembersModal(chart.chartId));
  }

  shellPlacePopover(menu, anchor, true);
}

/* 기간 알약을 누르면 뜨는 "표시 기간(이 차트만)" 창.
   저장/연도 보기로는 iframe 안의 원래 버튼이 그대로 처리한다. */
function shellOpenRangePopover(chart, box, anchor) {
  if (!anchor) return;
  const wasOpen = shellOpenPopover && shellOpenPopover.dataset.for === "range:" + chart.id;
  shellClosePopover();
  if (wasOpen) return;

  const stats = shellStats[chart.id] || {};
  const custom = stats.custom !== undefined ? stats.custom : !!(chart.rangeStart && chart.rangeEnd);
  const canEdit = shellCanEdit(chart);
  /* 기간 보기에서 연도로 돌아가는 건 저장이 필요해서 편집 권한이 있어야 한다 */
  const showYears = !custom || canEdit;
  if (!showYears) return;

  const pop = document.createElement("div");
  pop.className = "mc-popover mc-range-pop";
  pop.dataset.for = "range:" + chart.id;

  /* (요청사항) 차트 가운데 있던 큰 연도 버튼·연도 선택창을 이 창 위쪽으로 옮겼다 */
  const thisYear = new Date().getFullYear();
  const currentYear = Number(stats.year) || thisYear;
  const taskYears = new Set(stats.taskYears || []);
  let pageStart = currentYear - 5;

  const yearSection = document.createElement("div");
  yearSection.className = "mc-yp";

  const renderYears = () => {
    const years = Array.from({ length: 12 }, (_, i) => pageStart + i);
    yearSection.innerHTML =
      '<div class="mc-range-pop-title">연도 보기</div>' +
      '<div class="mc-yp-head">' +
        '<button type="button" class="mc-yp-nav" data-page="-1" aria-label="이전 연도 목록">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg></button>' +
        '<span class="mc-yp-range">' + years[0] + " – " + years[11] + "</span>" +
        '<button type="button" class="mc-yp-nav" data-page="1" aria-label="다음 연도 목록">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"></path></svg></button>' +
      "</div>" +
      '<div class="mc-yp-grid" role="listbox" aria-label="연도">' +
        years.map((year) => {
          const selected = !custom && year === currentYear;
          return '<button type="button" role="option" class="mc-yp-year' +
            (selected ? " selected" : "") +
            (year === thisYear ? " this-year" : "") +
            (taskYears.has(year) ? " has-tasks" : "") +
            '" data-year="' + year + '" aria-selected="' + selected + '">' + year + "</button>";
        }).join("") +
      "</div>" +
      '<div class="mc-yp-foot">' +
        '<button type="button" class="mc-btn mc-btn-ghost mc-yp-today">올해로 이동</button>' +
        '<span class="mc-yp-legend"><i></i>일정 있음</span>' +
      "</div>";
  };

  const pickYear = (year) => {
    shellSendCommand(box, { cmd: "setYear", year });
    shellClosePopover();
  };

  yearSection.addEventListener("click", (event) => {
    const nav = event.target.closest(".mc-yp-nav");
    if (nav) {
      pageStart += Number(nav.dataset.page) * 12;
      renderYears();
      return;
    }
    const yearBtn = event.target.closest(".mc-yp-year");
    if (yearBtn) {
      pickYear(Number(yearBtn.dataset.year));
      return;
    }
    if (event.target.closest(".mc-yp-today")) pickYear(thisYear);
  });

  if (showYears) {
    renderYears();
    pop.appendChild(yearSection);
  }

  if (canEdit) {
    const rangeSection = document.createElement("div");
    rangeSection.className = "mc-range-pop-section";
    rangeSection.innerHTML =
      '<div class="mc-range-pop-title">표시 기간(이 차트만)</div>' +
      '<div class="mc-range-pop-row">' +
        '<label class="mc-visually-hidden" for="mcRangePopStart">표시 시작일</label>' +
        '<input id="mcRangePopStart" type="date">' +
        '<span class="mc-range-pop-sep">~</span>' +
        '<label class="mc-visually-hidden" for="mcRangePopEnd">표시 종료일</label>' +
        '<input id="mcRangePopEnd" type="date">' +
      "</div>" +
      '<p class="mc-range-pop-hint">이 차트만 이 기간으로 보입니다. 위에서 연도를 고르거나 "연도 보기로"를 누르면 연도 단위로 돌아갑니다.</p>' +
      '<div class="mc-range-pop-actions">' +
        (custom ? '<button type="button" class="mc-btn mc-btn-ghost" data-act="clear">연도 보기로</button>' : "") +
        '<button type="button" class="mc-btn mc-btn-ghost" data-act="cancel">취소</button>' +
        '<button type="button" class="mc-btn mc-btn-primary" data-act="save">저장</button>' +
      "</div>";
    pop.appendChild(rangeSection);

    const startInput = rangeSection.querySelector("#mcRangePopStart");
    const endInput = rangeSection.querySelector("#mcRangePopEnd");
    startInput.value = chart.rangeStart || stats.windowStart || "";
    endInput.value = chart.rangeEnd || stats.windowEnd || "";

    rangeSection.querySelector('[data-act="cancel"]').addEventListener("click", shellClosePopover);

    rangeSection.querySelector('[data-act="save"]').addEventListener("click", () => {
      if (!startInput.value || !endInput.value) {
        showToast("시작일과 종료일을 모두 입력하세요.", true);
        return;
      }
      if (endInput.value < startInput.value) {
        showToast("종료일은 시작일보다 빠를 수 없습니다.", true);
        return;
      }
      shellSendCommand(box, { cmd: "setRange", start: startInput.value, end: endInput.value });
      shellClosePopover();
    });

    const clearBtn = rangeSection.querySelector('[data-act="clear"]');
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        shellSendCommand(box, { cmd: "clearRange" });
        shellClosePopover();
      });
    }
  }

  shellPlacePopover(pop, anchor, false);
  const focusTarget = pop.querySelector(".mc-yp-year.selected") || pop.querySelector("#mcRangePopStart");
  if (focusTarget) focusTarget.focus();
}

/* 카드 머리의 차트 이름을 눌러 그 자리에서 수정 (iframe 안에서 고치던 것과 같은 저장) */
function shellStartRename(chart, box) {
  const nameEl = box.querySelector(".mc-chart-box-name");
  if (!nameEl || nameEl.querySelector("input") || !shellCanEdit(chart)) return;

  const original = chart.name || "";
  nameEl.textContent = "";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "chart-name-edit mc-chart-name-edit";
  input.value = original;
  input.maxLength = 200;
  nameEl.appendChild(input);
  input.focus();
  input.select();

  let done = false;

  async function finish(save) {
    if (done) return;
    done = true;
    const value = input.value.trim();
    nameEl.textContent = save && value ? value : original;
    if (!save || !value || value === original) return;

    try {
      await apiPostForChart("updateChart", chart.id, { data: { id: chart.id, name: value } });
      invalidateChartMetaCache(chart.id);
      chart.name = value;
      showToast("차트 이름을 저장했습니다.");
      shellLoadCharts();
    } catch (error) {
      nameEl.textContent = original;
      showToast(error.message || "이름을 저장하지 못했습니다.", true, 0);
    }
  }

  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); input.blur(); }
    else if (event.key === "Escape") { event.preventDefault(); done = true; nameEl.textContent = original; }
  });
}

/* (요청사항) 카드 머리 오른쪽 버튼 다시 정리:
   [새로고침 · 캡처 · 캘린더(추가/삭제 하나로)]  [업로드 | 다운로드]  [공유]
   - 캡처 · 업/다운로드 · 공유만 테마색, 나머지는 흰색
   - ⋯ 버튼은 없앰 (이름 바꾸기는 제목을 누르면 됨)
   - 오늘 전후 보기 · 전체 보기는 제목 옆 기간 알약 쪽으로 옮김(shellBuildDateToolsEl) */
function shellBuildActionsEl(chart, box) {
  const actions = document.createElement("div");
  actions.className = "mc-chart-box-actions";

  const tool = (icon, label, cmd) => {
    const btn = mcActionButton(icon, label, true);
    btn.addEventListener("click", () => shellSendCommand(box, { cmd }));
    return btn;
  };

  const captureBtn = tool("capture", "이미지로 캡처", "capture");
  captureBtn.classList.add("mc-btn-capture");

  /* 캘린더: 이 차트의 캘린더가 있으면 삭제 버튼, 없으면 추가 버튼 하나만 */
  const calBtn = mcActionButton("calAdd", "캘린더에 추가", true);
  calBtn.classList.add("mc-cal-toggle");
  calBtn.dataset.chartId = chart.id;
  calBtn.addEventListener("click", () => withBusy(calBtn, "", async () => {
    const current = shellFindChart(chart.id) || chart;
    if (shellChartHasCalendar(current)) {
      if (current.shared) await shellHandleSharedCalendarRemove(current.chartId);
      else await shellHandleCalendarRemove(current.id);
    } else {
      if (current.shared) await shellHandleSharedCalendarAdd(current.chartId);
      else await shellHandleCalendarAdd(current.id);
    }
  }).then(shellRefreshCalButtons)); /* 처리 중 표시가 풀린 뒤 추가↔삭제 모양을 맞춘다 */

  const toolGroup = mcButtonGroup([
    tool("reload", "새로고침", "reload"),
    captureBtn,
    calBtn
  ]);
  /* (요청사항) 새로고침·캡처·캘린더는 날짜 알약 안, 세로선 뒤로 */
  toolGroup.classList.add("mc-chart-tools", "mc-date-tools", "mc-tools-extra");
  shellUseQuickTips(toolGroup);
  /* 폰에서 살짝 누르면 잠깐 초록색으로 (마우스는 :hover 로 처리) */
  toolGroup.addEventListener("pointerdown", (event) => {
    const btn = event.target.closest(".mc-btn");
    if (!btn || event.pointerType === "mouse") return;
    btn.classList.add("mc-touched");
    setTimeout(() => btn.classList.remove("mc-touched"), 450);
  });
  actions.toolGroup = toolGroup;

  /* (요청사항) 담당자별 보기: 차트 안 왼쪽 위에서 카드 머리로 */
  const ownerBtn = document.createElement("button");
  ownerBtn.type = "button";
  ownerBtn.className = "mc-btn mc-chart-tools mc-owner-btn";
  ownerBtn.title = "담당자별로 작업 보기";
  ownerBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const stats = shellStats[chart.id] || {};
    if (event.target.closest(".owner-filter-clear")) {
      shellSendCommand(box, { cmd: "setOwnerFilter", filter: null });
      return;
    }
    openOwnerFilterMenu(ownerBtn, {
      people: stats.ownerPeople || [],
      filter: stats.ownerFilter || null,
      total: stats.taskCount || 0,
      onPick: (filter) => shellSendCommand(box, { cmd: "setOwnerFilter", filter })
    });
  });
  actions.appendChild(ownerBtn);

  /* CSV 업로드 | 다운로드 (한 알약 안에 따로) */
  const uploadBtn = mcActionButton("upload", "업로드", false);
  uploadBtn.classList.add("mc-csv-upload");
  uploadBtn.title = "CSV 파일의 작업을 이 차트에 추가합니다 (기존 작업은 그대로)";
  uploadBtn.addEventListener("click", () => shellPickCsvForChart(shellFindChart(chart.id) || chart, box, uploadBtn));

  const downloadBtn = mcActionButton("download", "다운로드", false);
  downloadBtn.title = "이 차트의 작업을 CSV 파일로 받습니다";
  downloadBtn.addEventListener("click", () => chart.shared
    ? shellHandleSharedExportCsv(chart.chartId, box)
    : shellHandleExportCsv(chart.id, box));

  /* (요청사항) 업로드 | 다운로드 | 공유 를 알약 하나로, 세로선으로 구분 */
  const csvGroup = mcButtonGroup([uploadBtn, downloadBtn]);
  csvGroup.classList.add("mc-btn-group-text", "mc-csv-group");
  actions.appendChild(csvGroup);

  const shareBtn = document.createElement("button");
  shareBtn.type = "button";
  shareBtn.className = "mc-btn mc-btn-ghost mc-btn-pill mc-share-btn" + (chart.shared ? " mc-share-on" : "");
  shareBtn.innerHTML = shellShareAvatarsHtml(chart) + "<span>공유</span>";
  if (!chart.shared) {
    shareBtn.title = "이 차트를 다른 구글 계정과 공유합니다";
    shareBtn.addEventListener("click", () => withBusy(shareBtn, "공유 설정 중…", () => shellStartSharing(chart.id, chart.name)));
  } else if (chart.role === "owner" || chart.role === "admin") {
    shareBtn.title = "공유 중 — 공유 권한/사용자 설정";
    shareBtn.addEventListener("click", () => shellOpenShareModal(chart.chartId, chart.name, true, chart.role));
  } else {
    shareBtn.title = "공유 중 — 공유 구성원 보기";
    shareBtn.addEventListener("click", () => shellOpenMembersModal(chart.chartId));
  }
  csvGroup.appendChild(shareBtn);
  csvGroup.classList.toggle("mc-share-glow", !!chart.shared);

  setTimeout(shellRefreshCalButtons, 0);
  setTimeout(() => shellRefreshOwnerButton(chart.id), 0);
  return actions;
}

/* 제목 옆 기간 알약 바로 뒤: 오늘 전후 보기 · 전체 보기 (흰색) */
/* 카드 머리 담당자 버튼 모양: iframe 이 알려 준 "고른 사람"에 맞춘다 */
function shellRefreshOwnerButton(chartId) {
  const box = document.getElementById("mc-chart-anchor-" + chartId);
  const button = box && box.querySelector(".mc-owner-btn");
  if (!button) return;
  const filter = (shellStats[chartId] || {}).ownerFilter || null;
  const key = filter ? filter.kind + ":" + filter.value : "";
  if (button.dataset.filterKey === key && button.childElementCount) return;
  button.dataset.filterKey = key;
  button.classList.toggle("active", !!filter);
  if (filter) {
    const label = filter.kind === "none" ? "담당자 없음" : filter.label;
    const avatar = filter.kind === "none"
      ? '<span class="mc-owner-avatar mc-owner-avatar-none">–</span>'
      : '<span class="mc-owner-avatar" style="background:' + mcPersonColor(filter.kind === "email" ? filter.value : filter.label) + '">' +
        escapeHtml(Array.from(label)[0] || "?") + "</span>";
    button.innerHTML = avatar + "<span>담당자: " + escapeHtml(label) + "</span>" +
      '<span class="owner-filter-clear" role="button" aria-label="전체 보기" title="전체 보기">' +
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></span>';
  } else {
    button.innerHTML = OWNER_FILTER_ICON + "<span>담당자별 보기</span>" + OWNER_FILTER_CARET;
  }
}

/* (요청사항) 아이콘만 있는 버튼은 마우스를 올리면 바로 이름표가 뜨게
   (브라우저 기본 title 은 늦게 뜨고 작아서 data-tip 으로 바꾼다) */
function shellUseQuickTips(group) {
  group.querySelectorAll(".mc-btn").forEach((btn) => {
    btn.dataset.tip = btn.getAttribute("aria-label") || btn.title || "";
    btn.removeAttribute("title");
  });
}

function shellBuildDateToolsEl(box) {
  const tool = (icon, label, cmd) => {
    const btn = mcActionButton(icon, label, true);
    btn.addEventListener("click", () => {
      shellSendCommand(box, { cmd });
      group.querySelectorAll(".mc-btn").forEach((b) => b.classList.toggle("mc-btn-active", b === btn));
    });
    return btn;
  };
  const todayBtn = tool("today", "오늘 전후 보기", "today");
  todayBtn.classList.add("mc-btn-active");
  const group = mcButtonGroup([todayBtn, tool("full", "전체 보기", "full")]);
  group.classList.add("mc-chart-tools", "mc-date-tools");
  shellUseQuickTips(group);
  group.addEventListener("pointerdown", (event) => {
    const btn = event.target.closest(".mc-btn");
    if (!btn || event.pointerType === "mouse") return;
    btn.classList.add("mc-touched");
    setTimeout(() => btn.classList.remove("mc-touched"), 450);
  });
  return group;
}

/* ---- 캘린더 추가/삭제 버튼 상태 ---- */
function shellChartHasCalendar(chart) {
  if (!chart) return false;
  if (chart.shared) {
    const info = sharedCalLoadInfo(chart.chartId || chart.id);
    return !!(info && info.calendarId);
  }
  return !!chart.hasCalendar;
}

function shellRefreshCalButtons() {
  document.querySelectorAll(".mc-cal-toggle").forEach((btn) => {
    if (btn.disabled) return; // 처리 중이면 끝난 뒤 다시 맞춘다
    const chart = shellFindChart(btn.dataset.chartId);
    const has = shellChartHasCalendar(chart);
    const label = has ? "캘린더에서 삭제" : "캘린더에 추가";
    btn.innerHTML = mcIconSvg(has ? "calRemove" : "calAdd");
    btn.setAttribute("aria-label", label);
    btn.removeAttribute("title");
    btn.dataset.tip = has ? "구글 캘린더에서 삭제" : "구글 캘린더에 추가";
    btn.classList.toggle("mc-cal-on", has);
  });
}

/* =========================================================
 * (요청사항) CSV·엑셀(.xlsx) 업로드: 파일의 작업을 이 차트에 "그냥 추가"
 *  - UTF-8 로 읽고, 한글이 깨지면 EUC-KR(엑셀 CSV)로 다시 읽는다
 *  - 큰따옴표 안의 쉼표·줄바꿈 지원
 *  - 첫 줄 제목으로 열을 찾는다(순서 무관)
 *  - 날짜·진행률을 다듬고, 없는 카테고리는 새로 만든다
 *  - 넣기 전에 몇 개를 추가하는지 확인받는다
 * ========================================================= */
function csvParse(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => String(c).trim() !== "")) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => String(c).trim() !== "")) rows.push(row);
  return rows;
}

async function csvReadFileText(file) {
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("�")) {
    try {
      text = new TextDecoder("euc-kr").decode(buffer);
    } catch (error) {
      /* 이 브라우저가 EUC-KR 을 모르면 UTF-8 그대로 */
    }
  }
  return text.replace(/^﻿/, "");
}

/* ---- 엑셀(.xlsx) 읽기: 라이브러리 없이 zip 을 풀어 첫 번째 시트를 줄·칸 배열로 ----
 *  - .xlsx 는 zip 안의 XML 파일 묶음이라 브라우저 기본 기능(DecompressionStream, DOMParser)으로 충분하다
 *  - 날짜 칸은 엑셀 일련번호로 오지만 csvNormalizeDate 가 이미 처리한다 */
async function xlsxUnzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("엑셀 파일을 열 수 없어요. (.xlsx 형식인지 확인해 주세요)");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count && view.getUint32(pos, true) === 0x02014b50; n++) {
    const method = view.getUint16(pos + 10, true);
    const size = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    entries[name] = { method, size, local };
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return async (name) => {
    const entry = entries[name];
    if (!entry) return null;
    const start = entry.local + 30 + view.getUint16(entry.local + 26, true) + view.getUint16(entry.local + 28, true);
    const data = bytes.subarray(start, start + entry.size);
    if (entry.method === 0) return new TextDecoder().decode(data);
    if (entry.method !== 8) throw new Error("이 엑셀 파일의 압축 방식은 읽을 수 없어요.");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Response(stream).text();
  };
}

function xlsxXml(text) {
  return text ? new DOMParser().parseFromString(text, "application/xml") : null;
}

function xlsxColumnIndex(ref) {
  const letters = String(ref || "").replace(/[^A-Z]/gi, "").toUpperCase();
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

function xlsxText(node) {
  /* 일본어 후리가나(rPh) 같은 보조 글자는 빼고 <t> 만 이어 붙인다 */
  return Array.from(node.getElementsByTagNameNS("*", "t"))
    .filter((t) => !t.parentNode || t.parentNode.localName !== "rPh")
    .map((t) => t.textContent)
    .join("");
}

async function xlsxReadRows(file) {
  const read = await xlsxUnzip(await file.arrayBuffer());

  /* 첫 번째 시트의 실제 파일 경로 찾기 (못 찾으면 sheet1.xml) */
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = xlsxXml(await read("xl/workbook.xml"));
  const rels = xlsxXml(await read("xl/_rels/workbook.xml.rels"));
  const firstSheet = workbook && workbook.getElementsByTagNameNS("*", "sheet")[0];
  if (firstSheet && rels) {
    const relId = firstSheet.getAttribute("r:id") ||
      firstSheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const rel = Array.from(rels.getElementsByTagNameNS("*", "Relationship")).find((r) => r.getAttribute("Id") === relId);
    if (rel) {
      const target = rel.getAttribute("Target") || "";
      sheetPath = target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, "");
    }
  }

  const sharedDoc = xlsxXml(await read("xl/sharedStrings.xml"));
  const shared = sharedDoc ? Array.from(sharedDoc.getElementsByTagNameNS("*", "si")).map(xlsxText) : [];

  const sheet = xlsxXml(await read(sheetPath));
  if (!sheet) throw new Error("엑셀 파일에서 시트를 찾지 못했어요.");

  const rows = [];
  Array.from(sheet.getElementsByTagNameNS("*", "row")).forEach((rowNode) => {
    const row = [];
    let next = 0;
    Array.from(rowNode.getElementsByTagNameNS("*", "c")).forEach((cell) => {
      const ref = cell.getAttribute("r");
      const index = ref ? xlsxColumnIndex(ref) : next;
      next = index + 1;
      const type = cell.getAttribute("t");
      const v = cell.getElementsByTagNameNS("*", "v")[0];
      const raw = v ? v.textContent : "";
      let value;
      if (type === "s") value = shared[Number(raw)] || "";
      else if (type === "inlineStr") value = xlsxText(cell);
      else if (type === "d") value = raw.slice(0, 10);
      else value = raw;
      while (row.length < index) row.push("");
      row[index] = value;
    });
    if (row.some((c) => String(c).trim() !== "")) rows.push(row);
  });
  return rows;
}

const CSV_HEADER_ALIASES = {
  name: ["작업명", "작업", "이름", "업무명", "업무"],
  category: ["카테고리", "분류"],
  start: ["시작일", "시작", "시작 날짜"],
  end: ["종료일", "종료", "마감", "마감일", "끝"],
  progress: ["진행률(%)", "진행률", "진행"],
  owner: ["담당자", "담당"],
  ownerEmail: ["담당자 이메일", "담당자이메일", "이메일"],
  memo: ["메모", "비고"],
  target: ["대상처", "대상"]
};

function csvNormalizeDate(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  /* 엑셀이 날짜를 숫자로 바꾼 경우 (1900-01-00 기준 일련번호) */
  if (/^\d{5}(\.\d+)?$/.test(raw)) {
    const serial = Math.floor(Number(raw));
    const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    return date.toISOString().slice(0, 10);
  }
  let m = raw.match(/^(\d{4})[-./\s]+(\d{1,2})[-./\s]+(\d{1,2})\.?$/);
  if (!m) m = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) m = raw.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

function csvNormalizeProgress(value) {
  const raw = String(value || "").trim().replace(/%$/, "").trim();
  if (!raw) return 0;
  let n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n < 1 && raw.includes(".")) n = n * 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function csvBuildImport(rows, existingCategories) {
  if (!rows.length) throw new Error("파일에 내용이 없어요.");
  const header = rows[0].map((h) => String(h || "").trim());
  const col = {};
  Object.keys(CSV_HEADER_ALIASES).forEach((key) => {
    const index = header.findIndex((h) => CSV_HEADER_ALIASES[key].includes(h));
    if (index >= 0) col[key] = index;
  });
  if (col.name === undefined || col.start === undefined || col.end === undefined) {
    throw new Error("첫 줄에 '작업명', '시작일', '종료일' 제목이 있어야 해요. (이 앱에서 다운로드한 파일 형식)");
  }

  const get = (row, key) => (col[key] === undefined ? "" : String(row[col[key]] || "").trim());
  const known = new Set((existingCategories || []).map((c) => c.name));
  const newCategories = [];
  const tasks = [];
  const skipped = [];

  rows.slice(1).forEach((row, i) => {
    const line = i + 2;
    const name = get(row, "name");
    if (!name) { skipped.push(line + "번째 줄: 작업명 없음"); return; }
    const start = csvNormalizeDate(get(row, "start"));
    const end = csvNormalizeDate(get(row, "end"));
    if (!start || !end) { skipped.push(line + "번째 줄: 날짜 형식 오류"); return; }
    if (end < start) { skipped.push(line + "번째 줄: 종료일이 시작일보다 빠름"); return; }
    const category = get(row, "category");
    if (category && category !== "기타" && !known.has(category)) {
      known.add(category);
      newCategories.push(category);
    }
    tasks.push({
      name: name.slice(0, 200),
      category: category === "기타" ? "" : category,
      start, end,
      progress: csvNormalizeProgress(get(row, "progress")),
      owner: get(row, "owner").slice(0, 100),
      ownerEmail: get(row, "ownerEmail"),
      memo: get(row, "memo"),
      target: get(row, "target").slice(0, 200)
    });
  });
  return { tasks, newCategories, skipped };
}

function shellPickCsvForChart(chart, box, button) {
  if (!shellCanEdit(chart)) {
    showToast("이 차트를 편집할 권한이 없어서 업로드할 수 없어요.", true);
    return;
  }
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (file) withBusy(button, "불러오는 중…", () => shellImportCsvToChart(chart, box, file));
  });
  input.click();
}

async function shellImportCsvToChart(chart, box, file) {
  const chartId = chart.id;
  try {
    const fileName = String(file.name || "").toLowerCase();
    if (fileName.endsWith(".xls")) throw new Error("예전 엑셀(.xls) 파일은 읽을 수 없어요. 엑셀에서 .xlsx 또는 CSV 로 다시 저장해 주세요.");
    const rows = fileName.endsWith(".xlsx") ? await xlsxReadRows(file) : csvParse(await csvReadFileText(file));
    const categories = await fb.getCategoriesOnce(chartId);
    const plan = csvBuildImport(rows, categories);

    if (!plan.tasks.length) {
      showToast("추가할 작업이 없어요." + (plan.skipped.length ? " (" + plan.skipped.slice(0, 3).join(", ") + ")" : ""), true, 0);
      return;
    }

    const lines = ["'" + chart.name + "' 차트에 작업 " + plan.tasks.length + "개를 추가할까요? (기존 작업은 그대로예요)"];
    if (plan.newCategories.length) lines.push("새 카테고리 " + plan.newCategories.length + "개: " + plan.newCategories.join(", "));
    if (plan.skipped.length) {
      lines.push("건너뛰는 줄 " + plan.skipped.length + "개:");
      plan.skipped.slice(0, 5).forEach((s) => lines.push(" · " + s));
      if (plan.skipped.length > 5) lines.push(" · 그 밖에 " + (plan.skipped.length - 5) + "개");
    }
    if (!confirm(lines.join("\n"))) return;

    /* 카테고리 먼저 (이름 → id) */
    const categoryIds = {};
    categories.forEach((c) => { categoryIds[c.name] = c.id; });
    for (const name of plan.newCategories) {
      const res = await apiPostForChart("createCategory", chartId, { data: { name } });
      categoryIds[name] = res.result;
    }

    let added = 0;
    for (const task of plan.tasks) {
      try {
        await apiPostForChart("create", chartId, {
          data: {
            name: task.name,
            categoryId: task.category ? (categoryIds[task.category] || "") : "",
            start: task.start,
            end: task.end,
            progress: task.progress,
            memo: task.memo,
            target: task.target,
            owner: task.owner,
            ownerEmail: task.ownerEmail
          }
        });
        added++;
      } catch (error) {
        console.error(error);
      }
    }

    shellSendCommand(box, { cmd: "reload" });
    showToast("작업 " + added + "개를 추가했어요." + (added < plan.tasks.length ? " (" + (plan.tasks.length - added) + "개 실패)" : ""), added < plan.tasks.length);
  } catch (error) {
    console.error(error);
    showToast(error.message || "파일을 불러오지 못했어요.", true, 0);
  }
}

function shellSharedStateKey(chart) {
  return (chart.shared ? "1" : "0") + ":" + (chart.role || "") + ":" +
    (chart.members || []).join(",") + ":" + (chart.orgNames || []).join(",") + ":" + shellMyName();
}

/* ---- 차트 iframe이 알려준 요약값(평균 진행률·카테고리·보이는 기간) ---- */
const shellStats = {};
let shellActiveChartId = "";

/* (요청사항) 기간 글자를 짧게: 같은 해면 "2026. 1.1 – 12.31", 해를 넘으면 "26.7.20 – 28.1.27".
   며칠인지는 마우스를 올리면 뜨는 설명(title)으로 */
function shellShortRange(start, end) {
  const parse = (key) => {
    const m = String(key || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? { y: m[1], m: Number(m[2]), d: Number(m[3]) } : null;
  };
  const a = parse(start);
  const b = parse(end);
  if (!a || !b) return (start || "") + " ~ " + (end || "");
  if (a.y === b.y) return a.y + ". " + a.m + "." + a.d + " – " + b.m + "." + b.d;
  return a.y.slice(2) + "." + a.m + "." + a.d + " – " + b.y.slice(2) + "." + b.m + "." + b.d;
}

function shellRangeLabel(chart) {
  const stats = shellStats[chart.id];
  if (stats && stats.windowStart) {
    return shellShortRange(stats.windowStart, stats.windowEnd);
  }
  if (chart.rangeStart && chart.rangeEnd) {
    return shellShortRange(chart.rangeStart, chart.rangeEnd);
  }
  return "";
}

function shellApplyStats(chartId) {
  const chart = shellFindChart(chartId);
  const stats = shellStats[chartId];
  const box = document.getElementById("mc-chart-anchor-" + chartId);
  if (!chart || !stats) return;

  if (box) {
    const rangeBtn = box.querySelector(".mc-chart-box-range");
    rangeBtn.textContent = shellRangeLabel(chart);
    rangeBtn.title = stats.windowStart
      ? stats.windowStart + " ~ " + stats.windowEnd + " · " + stats.windowDays + "일 (눌러서 연도·표시 기간 설정)"
      : "연도·표시 기간 설정";
    const avg = box.querySelector(".mc-chart-box-avg");
    avg.textContent = stats.avgProgress === null ? "" : "평균 진행률 " + stats.avgProgress + "%";
    box.classList.toggle("mc-chart-box-readonly", !shellCanEdit(chart));
    shellRefreshOwnerButton(chartId);
  }

  const pct = document.querySelector('.mc-sidebar-item[data-chart-id="' + CSS.escape(chartId) + '"] .mc-sidebar-item-pct');
  if (pct) pct.textContent = stats.avgProgress === null ? "" : stats.avgProgress + "%";

  shellRenderSidebarTree(chartId);
}

/* =========================================================
 * (요청사항) 사이드바: 차트마다 그 아래에 카테고리 목록
 *  - ▸ 삼각형 + 색 동그라미 + 카테고리 이름 + 작업 수
 *  - 펼치면 그 카테고리의 작업(카테고리 안 번호 + 제목)이 아래에 나오고,
 *    아래쪽 카테고리·차트는 그만큼 밀려 내려간다(보통 흐름).
 *  - 처음엔 모두 접힘, 펼친 상태는 이 브라우저에 기억한다.
 *  - 작업을 누르면 그 차트의 상세창(막대를 누른 것과 같은 창)이 열린다.
 * ========================================================= */
const SIDE_TREE_OPEN_KEY = "mcSideTreeOpen";

function shellSideTreeOpenSet() {
  try {
    const list = JSON.parse(localStorage.getItem(SIDE_TREE_OPEN_KEY) || "[]");
    return new Set(Array.isArray(list) ? list : []);
  } catch (error) {
    return new Set();
  }
}

function shellSaveSideTreeOpenSet(set) {
  try { localStorage.setItem(SIDE_TREE_OPEN_KEY, JSON.stringify(Array.from(set))); } catch (error) { /* 무시 */ }
}

function shellRenderSidebarTree(chartId) {
  const tree = document.querySelector('.mc-side-tree[data-chart-id="' + CSS.escape(chartId) + '"]');
  const stats = shellStats[chartId];
  if (!tree) return;

  tree.innerHTML = "";

  const groups = (stats && stats.groups) || [];
  const open = shellSideTreeOpenSet();

  groups.forEach((group) => {
    const key = chartId + ":" + group.id;
    const isOpen = open.has(key);

    const head = document.createElement("button");
    head.type = "button";
    head.className = "mc-side-cat";
    head.setAttribute("aria-expanded", String(isOpen));
    head.title = group.name + (isOpen ? " 접기" : " 펼치기");

    const caret = document.createElement("span");
    caret.className = "mc-side-caret";
    caret.setAttribute("aria-hidden", "true");
    caret.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l10 7-10 7z"></path></svg>';
    head.appendChild(caret);

    const dot = document.createElement("span");
    dot.className = "mc-side-cat-dot";
    dot.style.background = group.color;
    head.appendChild(dot);

    const name = document.createElement("span");
    name.className = "mc-side-cat-name";
    name.textContent = group.name;
    head.appendChild(name);

    const count = document.createElement("span");
    count.className = "mc-side-cat-count";
    count.textContent = String(group.tasks.length);
    head.appendChild(count);

    head.addEventListener("click", () => {
      const set = shellSideTreeOpenSet();
      if (set.has(key)) set.delete(key); else set.add(key);
      shellSaveSideTreeOpenSet(set);
      shellRenderSidebarTree(chartId);
    });

    tree.appendChild(head);

    if (!isOpen) return;

    const list = document.createElement("div");
    list.className = "mc-side-tasks";

    if (!group.tasks.length) {
      const empty = document.createElement("span");
      empty.className = "mc-side-task-empty";
      empty.textContent = "작업 없음";
      list.appendChild(empty);
    }

    group.tasks.forEach((task, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "mc-side-task";
      item.title = task.name;

      const num = document.createElement("span");
      num.className = "mc-side-task-num";
      num.textContent = (index + 1) + ".";
      item.appendChild(num);

      const title = document.createElement("span");
      title.className = "mc-side-task-name";
      title.textContent = task.name;
      item.appendChild(title);

      item.addEventListener("click", () => shellOpenTaskFromSidebar(chartId, task.id));
      list.appendChild(item);
    });

    tree.appendChild(list);
  });
}

/* 사이드바 작업 → 그 차트 박스를 펼치고(접혀 있으면) 상세창을 연다.
   상세창이 열리면 iframe 쪽에서 그 창이 보이도록 화면을 옮긴다. */
function shellOpenTaskFromSidebar(chartId, taskId) {
  const box = document.getElementById("mc-chart-anchor-" + chartId);
  if (!box) return;

  const wasCollapsed = box.classList.contains("mc-chart-box-collapsed");
  if (wasCollapsed) {
    box.classList.remove("mc-chart-box-collapsed");
    const toggle = box.querySelector(".mc-chart-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
  }

  setTimeout(() => shellSendCommand(box, { cmd: "openTask", taskId }), wasCollapsed ? 80 : 0);
}

/* "총 N개 · 마지막 저장 …" */
function shellUpdatePageSub() {
  const sub = document.getElementById("mcChartCount");
  if (!sub) return;
  /* (조직 관리 4단계) 조직으로 볼 때는 그 조직에 공유된 차트 수 */
  const count = shellChartsCache.filter((c) => !c.hidden && shellChartInScope(c)).length;
  let text = (shellScopeOrgId ? "공유된 차트 " : "총 ") + count + "개";
  try {
    const savedAt = Number(localStorage.getItem(LAST_SAVED_KEY));
    if (savedAt) {
      text += " · 마지막 저장 " + new Date(savedAt).toLocaleString("ko-KR", {
        year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit"
      });
    }
  } catch (error) { /* 무시 */ }
  sub.textContent = text;
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
    const stateKey = shellSharedStateKey(chart);

    if (!box) {
      box = document.createElement("div");
      box.className = "mc-chart-box";
      box.id = "mc-chart-anchor-" + chart.id; /* (사이드바 추가분) 사이드바 클릭 시 이 박스로 바로 이동시키기 위한 앵커 */
      box.dataset.chartId = chart.id;
      box.dataset.sharedState = stateKey;
      if (chart.shared) box.classList.add("mc-chart-box-shared");

      const head = document.createElement("div");
      head.className = "mc-chart-box-head";

      /* (추가분) 접기/펼치기 토글. 화살표 방향은 aria-expanded 값을 보고 CSS가 돌린다. */
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "mc-chart-toggle";
      toggle.setAttribute("aria-expanded", "true");
      toggle.title = "접기/펼치기";
      toggle.setAttribute("aria-label", "접기/펼치기");
      toggle.innerHTML =
        '<svg class="mc-chart-toggle-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>';
      head.appendChild(toggle);

      const headInfo = document.createElement("div");
      headInfo.className = "mc-chart-box-headinfo";

      /* (디자인 추가분) 이름을 누르면 그 자리에서 이름 수정 */
      const name = document.createElement("h2");
      name.className = "mc-chart-box-name";
      name.title = "눌러서 이 차트 이름 수정";
      name.addEventListener("click", () => shellStartRename(shellFindChart(chart.id) || chart, box));
      headInfo.appendChild(name);

      /* (디자인 추가분) 기간 알약을 누르면 표시 기간 설정 창 */
      const range = document.createElement("button");
      range.type = "button";
      range.className = "mc-chart-box-range";
      range.title = "연도·표시 기간 설정";
      range.dataset.popoverAnchor = "1";
      range.addEventListener("click", () => shellOpenRangePopover(shellFindChart(chart.id) || chart, box, range));

      /* (요청사항) 날짜 관련(기간 · 오늘 전후 보기 · 전체 보기)은 알약 하나에 */
      const datePill = document.createElement("div");
      datePill.className = "mc-date-pill";
      datePill.appendChild(range);
      datePill.appendChild(shellBuildDateToolsEl(box));
      headInfo.appendChild(datePill);

      /* 접혔을 때만 보이는 평균 진행률 */
      const avg = document.createElement("span");
      avg.className = "mc-chart-box-avg";
      headInfo.appendChild(avg);

      head.appendChild(headInfo);

      const actions = shellBuildActionsEl(chart, box);
      datePill.appendChild(actions.toolGroup);
      head.appendChild(actions);

      box.appendChild(head);

      toggle.addEventListener("click", () => {
        const collapsed = box.classList.toggle("mc-chart-box-collapsed");
        toggle.setAttribute("aria-expanded", String(!collapsed));
      });

      const wrap = document.createElement("div");
      wrap.className = "mc-chart-iframe-wrap";

      const iframe = document.createElement("iframe");
      /* (중요, 버그 수정) 이 박스 안도 Firestore로 동작하도록 index.html?chart= 를 연다. */
      /* (버그 수정) 차트 박스 안 화면 주소에 버전을 붙인다. 안 그러면 브라우저가
         예전 index.html 을 기억해 두고 써서, 새로 올린 디자인이 박스 안에만
         반영되지 않았다(강력 새로고침으로도 안 풀리는 경우가 있었다). */
      iframe.src = "index.html?chart=" + encodeURIComponent(chart.id) + "&v=" + encodeURIComponent(APP_VERSION);
      iframe.setAttribute("scrolling", "no");
      iframe.title = chart.name + " 차트";
      iframe.addEventListener("load", () => shellAutoResize(iframe));

      wrap.appendChild(iframe);
      box.appendChild(wrap);

      root.appendChild(box);
    } else if (box.dataset.sharedState !== stateKey) {
      /* (성능 수정) 공유 상태가 바뀐 "기존" 박스 — 박스/iframe은 그대로 두고
         헤더의 버튼 영역과 mc-chart-box-shared 클래스만 새로 교체한다. */
      box.dataset.sharedState = stateKey;
      box.classList.toggle("mc-chart-box-shared", !!chart.shared);
      const oldActions = box.querySelector(".mc-chart-box-actions");
      const newActions = shellBuildActionsEl(chart, box);
      const oldTools = box.querySelector(".mc-tools-extra");
      if (oldTools) oldTools.replaceWith(newActions.toolGroup);
      if (oldActions) {
        oldActions.replaceWith(newActions);
      } else {
        const head = box.querySelector(".mc-chart-box-head");
        if (head) head.appendChild(newActions);
      }
    }

    const nameEl = box.querySelector(".mc-chart-box-name");
    if (!nameEl.querySelector("input")) nameEl.textContent = chart.name;
    box.querySelector(".mc-chart-box-range").textContent = shellRangeLabel(chart);
  });

  Object.keys(existing).forEach((id) => {
    if (!seen[id]) existing[id].remove();
  });

  if (!visible.some((c) => c.id === shellActiveChartId)) {
    shellActiveChartId = visible.length ? visible[0].id : "";
  }

  shellRenderSidebar(visible); /* (사이드바 추가분) */
  visible.forEach((chart) => shellApplyStats(chart.id));
  shellUpdatePageSub();

  shellApplySearch();
  shellApplyScope(); /* (조직 관리 4단계) 개인 ↔ 조직 전환 */
}

/* (디자인 추가분) 차트 검색: 이름에 검색어가 들어간 차트 박스/사이드바 항목만 보인다.
   목록 데이터는 건드리지 않고 화면 표시만 거른다. */
function shellApplySearch() {
  const input = document.getElementById("mcSearch");
  const query = input ? input.value.trim().toLowerCase() : "";

  shellChartsCache.forEach((chart) => {
    const match = !query || String(chart.name || "").toLowerCase().includes(query);
    const box = document.getElementById("mc-chart-anchor-" + chart.id);
    if (box) box.classList.toggle("mc-search-miss", !match);
  });

  document.querySelectorAll("#shellView .mc-sidebar-list .mc-sidebar-item").forEach((item) => {
    const match = !query || String(item.title || "").toLowerCase().includes(query);
    (item.closest(".mc-sidebar-entry") || item).classList.toggle("mc-search-miss", !match);
  });
}

/* ▼▼▼ 접이식 사이드바 (추가분) ▼▼▼
   왼쪽 사이드바에 지금 보이는 차트 목록을 나열하고, 클릭하면 아래
   해당 차트 박스로 스크롤 이동한다. 데이터는 shellRenderList가 이미
   들고 있는 목록(visible)을 그대로 재사용하므로 별도 조회가 없다. */
/* 남이 공유해 준 차트(내가 소유자가 아닌 공유 차트) */
function shellIsReceivedChart(chart) {
  return !!chart.shared && chart.role !== "owner";
}

function shellRenderSidebar(visible) {
  const list = document.getElementById("mcSidebarList");
  if (!list) return;

  /* (디자인 추가분) 공유받은 차트는 "공유받은 차트" 칸에 따로 모은다. */
  const sharedList = document.getElementById("mcSidebarSharedList");
  const sharedSection = document.getElementById("mcSidebarSharedSection");

  list.innerHTML = "";
  if (sharedList) sharedList.innerHTML = "";
  if (sharedSection) {
    sharedSection.classList.toggle("hidden", !sharedList || !visible.some(shellIsReceivedChart));
  }

  visible.forEach((chart) => {
    const received = shellIsReceivedChart(chart);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mc-sidebar-item" + (received ? " mc-sidebar-item-shared" : "");
    item.classList.toggle("active", chart.id === shellActiveChartId);
    item.dataset.chartId = chart.id;
    item.title = chart.name;

    /* 내 차트는 점, 공유받은 차트는 소유자 첫 글자 동그라미 */
    const dot = document.createElement("span");
    dot.className = "mc-sidebar-item-dot";
    if (received) {
      dot.textContent = shellPersonInitial(chart.ownerEmail);
      dot.setAttribute("aria-hidden", "true");
    }
    item.appendChild(dot);

    /* (디자인 추가분) 사이드바를 접었을 때는 점 대신 이름 첫 글자 타일로 보인다. */
    const initial = document.createElement("span");
    initial.className = "mc-sidebar-item-initial";
    initial.setAttribute("aria-hidden", "true");
    initial.textContent = Array.from(String(chart.name || "?").trim() || "?")[0];
    item.appendChild(initial);

    const name = document.createElement("span");
    name.className = "mc-sidebar-item-name";
    name.textContent = chart.name;
    item.appendChild(name);

    /* 평균 진행률 (차트 iframe이 알려주면 채워진다) */
    const pct = document.createElement("span");
    pct.className = "mc-sidebar-item-pct";
    if (!received) item.appendChild(pct);

    item.addEventListener("click", () => {
      shellActiveChartId = chart.id;
      document.querySelectorAll(".mc-sidebar-item.active").forEach((el) => el.classList.remove("active"));
      item.classList.add("active");

      const target = document.getElementById("mc-chart-anchor-" + chart.id);
      if (!target) return;
      target.classList.remove("mc-chart-box-collapsed");
      const toggle = target.querySelector(".mc-chart-toggle");
      if (toggle) {
        toggle.setAttribute("aria-expanded", "true");
      }
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    /* (요청사항) 차트 이름 아래에 그 차트의 카테고리 목록 */
    const entry = document.createElement("div");
    entry.className = "mc-sidebar-entry";
    entry.appendChild(item);

    const tree = document.createElement("div");
    tree.className = "mc-side-tree";
    tree.dataset.chartId = chart.id;
    entry.appendChild(tree);

    (received && sharedList ? sharedList : list).appendChild(entry);
  });
}

/* =========================================================
 * ▼▼▼ 조직 관리 (1단계) ▼▼▼
 * 사이드바 "조직원 관리" → 조직 만들기, 조직원 초대(이메일·이름·직급·권한),
 * 초대 수락/거절, 권한·이름·직급 수정, 내보내기, 나가기, 소유권 넘기기,
 * 조직 이름 변경·삭제. 기존 차트/공유 기능과는 데이터가 따로라 서로 영향이 없다.
 *
 * 권한(높은 순): 소유자 > 관리자 > 참여자 > 게스트
 *  - 게스트: 보기만
 *  - 참여자: 초대(참여자 이하로), 게스트 권한 수정(참여자 이하로). 추방 불가
 *  - 관리자: 초대·추방, 이름·직급 수정, 자기보다 낮은 사람 권한 수정(관리자 이하로)
 *  - 소유자: 전부 + 조직 이름 변경·삭제·소유권 넘기기
 * 같은 규칙을 서버 쪽 firebase/firestore.rules 에서도 검사한다.
 * ========================================================= */

const ORG_ROLE_LABEL = { owner: "소유자", admin: "관리자", member: "참여자", guest: "게스트" };
const ORG_INVITABLE_ROLES = ["guest", "member", "admin"];

function orgRank(role) {
  return role === "owner" ? 3 : role === "admin" ? 2 : role === "member" ? 1 : 0;
}

/* 내가 초대하거나 바꿔 줄 수 있는 권한: 맨 아래부터 내 권한까지(소유자는 관리자까지) */
function orgAssignableRoles(myRole) {
  return ORG_INVITABLE_ROLES.filter((role) => orgRank(role) <= Math.min(orgRank(myRole), 2));
}

function orgCanInvite(myRole) {
  return orgRank(myRole) >= 1;
}

/* 권한 수정: 게스트 제외, 나보다 낮은 사람만 */
function orgCanChangeRole(myRole, target) {
  return orgRank(myRole) >= 1 && orgRank(target.role) < orgRank(myRole);
}

/* 이름·직급 수정: 소유자는 모두, 관리자는 자기보다 낮은 사람과 자기 자신 */
function orgCanEditInfo(myRole, target, isSelf) {
  if (myRole === "owner") return true;
  return myRole === "admin" && (isSelf || orgRank(target.role) < orgRank(myRole));
}

/* 내보내기: 관리자 이상, 나보다 낮은 사람만 */
function orgCanKick(myRole, target) {
  return orgRank(myRole) >= 2 && orgRank(target.role) < orgRank(myRole);
}

const orgState = {
  memberships: [],      // 내 문서들(수락 + 대기)
  selectedOrgId: "",
  members: [],          // 고른 조직의 조직원
  creating: false
};

function orgMyEmail() {
  return fbUser ? String(fbUser.email || "").toLowerCase() : "";
}

function orgEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* (디자인 추가분) 조직 창에서 글자 옆에 붙이는 작은 선 아이콘 */
const ORG_ICONS = {
  users: '<circle cx="9" cy="8" r="3.2"></circle><path d="M3 20a6 6 0 0 1 12 0"></path><path d="M16 4.5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-3.5-4.8"></path>',
  userPlus: '<circle cx="9" cy="8" r="3.2"></circle><path d="M3 20a6 6 0 0 1 12 0"></path><path d="M19 8v6M16 11h6"></path>',
  user: '<circle cx="12" cy="8" r="3.5"></circle><path d="M5 20a7 7 0 0 1 14 0"></path>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="m4 7 8 6 8-6"></path>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"></rect><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3"></path>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2.5"></rect><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12.5h18"></path>',
  clock: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path>',
  crown: '<path d="M4 18h16l-1.5-10-4.5 4-2-6-2 6-4.5-4z"></path>',
  shield: '<path d="M12 3 5 6v5.5c0 4.2 2.9 7.8 7 9.5 4.1-1.7 7-5.3 7-9.5V6z"></path>',
  pencil: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z"></path><path d="m14 7 3 3"></path>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>',
  check: '<path d="m5 12 5 5 9-10"></path>',
  x: '<path d="M6 6l12 12M18 6 6 18"></path>',
  info: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 11v5M12 8h.01"></path>',
  send: '<path d="M21 3 10 14"></path><path d="M21 3 14 21l-4-7-7-4z"></path>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"></path>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"></path>',
  leave: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"></path><path d="M10 17l-5-5 5-5M5 12h11"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>'
};

const ORG_ROLE_ICON = { owner: "crown", admin: "shield", member: "pencil", guest: "eye" };

function orgIcon(name, size = 14) {
  const span = orgEl("span", "mc-org-ico");
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + (ORG_ICONS[name] || "") + "</svg>";
  return span;
}

/* 아이콘 + 글자 */
function orgLabel(icon, text, className) {
  const span = orgEl("span", "mc-org-label" + (className ? " " + className : ""));
  span.appendChild(orgIcon(icon));
  span.appendChild(orgEl("span", "", text));
  return span;
}

function orgRoleChip(role) {
  const chip = orgEl("span", "mc-role-chip mc-role-" + (role === "member" ? "editor" : role === "guest" ? "viewer" : role));
  chip.appendChild(orgIcon(ORG_ROLE_ICON[role] || "user", 12));
  chip.appendChild(orgEl("span", "", ORG_ROLE_LABEL[role] || role));
  return chip;
}

function orgShowError(error, fallback) {
  console.error(error);
  const denied = error && (error.code === "permission-denied" || /permission/i.test(error.message || ""));
  showToast(denied
    ? "권한이 없어서 하지 못했습니다. (조직 보안 규칙이 아직 적용되지 않았다면 firebase/firestore.rules 를 Firebase 콘솔에 붙여 넣어 주세요)"
    : (error && error.message) || fallback, true, denied ? 6000 : 0);
}

function orgUpdateBadge() {
  const badge = document.getElementById("mcOrgBadge");
  if (!badge) return;
  const pending = orgState.memberships.filter((m) => m.status === "pending").length;
  badge.textContent = pending > 99 ? "99+" : String(pending);
  badge.classList.toggle("hidden", pending === 0);
}

/* 사이드바 배지용: 조용히 내 초대 수만 확인한다(실패해도 다른 기능에 영향 없음) */
async function shellOrgRefreshBadge() {
  if (!fbUser || typeof fb.getMyOrgMemberships !== "function") return;
  try {
    orgState.memberships = await fb.getMyOrgMemberships(orgMyEmail());
    orgUpdateBadge();
  } catch (error) {
    console.warn("조직 정보를 불러오지 못했습니다(보안 규칙 확인 필요):", error);
  }
}

async function shellOpenOrgModal() {
  if (!fbUser) {
    showToast("먼저 Google 로그인을 해주세요.", true);
    return;
  }
  shellOpenModal("mcOrgModal");
  await shellOrgLoad();
}

async function shellOrgLoad() {
  try {
    orgState.memberships = await fb.getMyOrgMemberships(orgMyEmail());
  } catch (error) {
    orgShowError(error, "조직 목록을 불러오지 못했습니다.");
    orgState.memberships = [];
  }
  orgUpdateBadge();

  const accepted = orgState.memberships.filter((m) => m.status === "accepted");
  if (!accepted.some((m) => m.orgId === orgState.selectedOrgId)) {
    orgState.selectedOrgId = accepted.length ? accepted[0].orgId : "";
  }
  if (!accepted.length) orgState.creating = true;

  shellOrgRenderSide();
  await shellOrgLoadMembers();
}

async function shellOrgLoadMembers() {
  orgState.members = [];
  if (orgState.selectedOrgId && !orgState.creating) {
    try {
      orgState.members = await fb.getOrgMembers(orgState.selectedOrgId);
    } catch (error) {
      orgShowError(error, "조직원 목록을 불러오지 못했습니다.");
    }
  }
  orgState.members.sort((a, b) =>
    (orgRank(b.role) - orgRank(a.role)) ||
    ((a.status === "pending") - (b.status === "pending")) ||
    String(a.name || a.email).localeCompare(String(b.name || b.email), "ko"));
  shellOrgRenderMain();
}

/* 조직마다 늘 같은 색의 아이콘 */
function orgAvatarEl(orgId, name, size) {
  const avatar = orgEl("span", "mc-org-avatar" + (size === "lg" ? " lg" : ""), Array.from(String(name || "?").trim() || "?")[0]);
  avatar.style.background = mcPersonColor(orgId);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

/* 권한별로 할 수 있는 일 (초대할 때 고른 권한 아래에 한 줄로 보여 줌) */
const ORG_ROLE_HELP = {
  guest: "조직원 정보만 볼 수 있어요. 차트 공유 시 뷰어.",
  member: "조직원을 초대하고 게스트 권한을 바꿀 수 있어요. 차트 공유 시 편집자.",
  admin: "초대·내보내기, 이름·직급 수정, 낮은 권한 변경까지 할 수 있어요. 차트 공유 시 관리자."
};

function shellOrgRenderSide() {
  const invites = document.getElementById("mcOrgInvites");
  const list = document.getElementById("mcOrgList");
  if (!invites || !list) return;

  /* 받은 초대: 조직 이름과 초대한 사람만 보인다 */
  invites.innerHTML = "";
  const pending = orgState.memberships.filter((m) => m.status === "pending");
  if (pending.length) {
    const inviteTitle = orgEl("div", "mc-org-side-title");
    inviteTitle.appendChild(orgLabel("mail", "받은 초대 " + pending.length));
    invites.appendChild(inviteTitle);
    pending.forEach((m) => {
      const card = orgEl("div", "mc-org-invite");
      const top = orgEl("div", "mc-org-invite-top");
      top.appendChild(orgAvatarEl(m.orgId, m.orgName));
      const text = orgEl("div", "mc-org-invite-text");
      text.appendChild(orgEl("div", "mc-org-invite-name", m.orgName || "(이름 없는 조직)"));
      const from = orgEl("div", "mc-org-invite-from");
      from.appendChild(orgIcon("send", 12));
      from.appendChild(orgEl("span", "", (m.invitedByName || m.invitedByEmail || "누군가") + "님이 초대했어요"));
      text.appendChild(from);
      const roleLine = orgEl("div", "mc-org-invite-role");
      roleLine.appendChild(orgEl("span", "", "받을 권한"));
      roleLine.appendChild(orgRoleChip(m.role));
      text.appendChild(roleLine);
      top.appendChild(text);
      card.appendChild(top);

      const actions = orgEl("div", "mc-org-invite-actions");
      const accept = orgEl("button", "mc-btn mc-btn-primary");
      accept.type = "button";
      accept.appendChild(orgIcon("check"));
      accept.appendChild(orgEl("span", "", "수락"));
      accept.addEventListener("click", () => withBusy(accept, "처리 중…", async () => {
        try {
          await fb.acceptOrgInvite(m.orgId, orgMyEmail());
          showToast("'" + (m.orgName || "조직") + "'에 들어왔습니다.");
          orgState.selectedOrgId = m.orgId;
          orgState.creating = false;
          await shellOrgLoad();
          shellLoadCharts(); /* (조직 관리 2단계) 조직을 통해 공유된 차트 목록도 바뀐다 */
        } catch (error) {
          orgShowError(error, "수락하지 못했습니다.");
        }
      }));
      const decline = orgEl("button", "mc-btn mc-btn-ghost");
      decline.type = "button";
      decline.appendChild(orgIcon("x"));
      decline.appendChild(orgEl("span", "", "거절"));
      decline.addEventListener("click", () => withBusy(decline, "처리 중…", async () => {
        if (!confirm("'" + (m.orgName || "조직") + "' 초대를 거절할까요?")) return;
        try {
          await fb.removeOrgMembership(m.orgId, orgMyEmail());
          showToast("초대를 거절했습니다.");
          await shellOrgLoad();
        } catch (error) {
          orgShowError(error, "거절하지 못했습니다.");
        }
      }));
      actions.appendChild(accept);
      actions.appendChild(decline);
      card.appendChild(actions);
      invites.appendChild(card);
    });
  }

  /* 내 조직(수락한 것) */
  list.innerHTML = "";
  const accepted = orgState.memberships.filter((m) => m.status === "accepted");
  if (!accepted.length) {
    const empty = orgEl("div", "mc-org-empty-side");
    empty.appendChild(orgLabel("building", "아직 속한 조직이 없어요."));
    list.appendChild(empty);
  }
  accepted.forEach((m) => {
    const item = orgEl("button", "mc-org-item");
    item.type = "button";
    item.classList.toggle("active", !orgState.creating && m.orgId === orgState.selectedOrgId);
    item.appendChild(orgAvatarEl(m.orgId, m.orgName));
    const text = orgEl("span", "mc-org-item-text");
    text.appendChild(orgEl("span", "mc-org-item-name", m.orgName || "(이름 없는 조직)"));
    const roleText = orgEl("span", "mc-org-item-role");
    roleText.appendChild(orgIcon(ORG_ROLE_ICON[m.role] || "user", 11));
    roleText.appendChild(orgEl("span", "", ORG_ROLE_LABEL[m.role] || m.role));
    text.appendChild(roleText);
    item.appendChild(text);
    item.addEventListener("click", async () => {
      orgState.selectedOrgId = m.orgId;
      orgState.creating = false;
      shellOrgRenderSide();
      await shellOrgLoadMembers();
    });
    list.appendChild(item);
  });
}

function shellOrgRenderMain() {
  const main = document.getElementById("mcOrgMain");
  if (!main) return;
  main.innerHTML = "";

  if (orgState.creating || !orgState.selectedOrgId) {
    main.appendChild(shellOrgCreateForm());
    return;
  }

  const myEmail = orgMyEmail();
  const me = orgState.members.find((m) => m.email === myEmail);
  const membership = orgState.memberships.find((m) => m.orgId === orgState.selectedOrgId);
  const myRole = (me && me.role) || (membership && membership.role) || "guest";
  const orgName = (membership && membership.orgName) || (me && me.orgName) || "";
  const acceptedMembers = orgState.members.filter((m) => m.status === "accepted");
  const pendingMembers = orgState.members.filter((m) => m.status === "pending");

  /* --- 머리: 아이콘 · 이름 · 요약 / 초대 · ⋯ --- */
  const head = orgEl("div", "mc-org-head");
  head.appendChild(orgAvatarEl(orgState.selectedOrgId, orgName, "lg"));

  const titleWrap = orgEl("div", "mc-org-title-wrap");
  if (myRole === "owner") {
    const nameInput = orgEl("input", "mc-org-name-input");
    nameInput.type = "text";
    nameInput.value = orgName;
    nameInput.maxLength = 100;
    nameInput.setAttribute("aria-label", "조직 이름");
    nameInput.title = "눌러서 조직 이름 바꾸기";
    const saveName = async () => {
      const value = nameInput.value.trim();
      if (!value || value === orgName) { nameInput.value = orgName; return; }
      try {
        await fb.renameOrganization(orgState.selectedOrgId, value, orgState.members.map((m) => m.email));
        showToast("조직 이름을 바꿨습니다.");
        await shellOrgLoad();
      } catch (error) {
        nameInput.value = orgName;
        orgShowError(error, "이름을 바꾸지 못했습니다.");
      }
    };
    nameInput.addEventListener("keydown", (event) => { if (event.key === "Enter") nameInput.blur(); });
    nameInput.addEventListener("blur", saveName);
    titleWrap.appendChild(nameInput);
  } else {
    titleWrap.appendChild(orgEl("h3", "mc-org-name", orgName));
  }

  const meta = orgEl("div", "mc-org-meta");
  const roleStat = orgEl("span", "mc-org-stat");
  roleStat.appendChild(orgEl("span", "", "내 권한"));
  roleStat.appendChild(orgRoleChip(myRole));
  meta.appendChild(roleStat);
  meta.appendChild(orgLabel("users", "조직원 " + acceptedMembers.length + "명", "mc-org-stat"));
  if (pendingMembers.length) meta.appendChild(orgLabel("clock", "초대 대기 " + pendingMembers.length + "명", "mc-org-stat warn"));
  titleWrap.appendChild(meta);
  head.appendChild(titleWrap);

  const headActions = orgEl("div", "mc-org-head-actions");
  let invitePanel = null;
  if (orgCanInvite(myRole)) {
    const inviteBtn = orgEl("button", "mc-btn mc-btn-primary");
    inviteBtn.type = "button";
    inviteBtn.appendChild(orgIcon("userPlus", 15));
    inviteBtn.appendChild(orgEl("span", "", "조직원 초대"));
    inviteBtn.addEventListener("click", () => {
      if (!invitePanel) return;
      invitePanel.classList.toggle("hidden");
      if (!invitePanel.classList.contains("hidden")) {
        const first = invitePanel.querySelector("input");
        if (first) first.focus();
      }
    });
    headActions.appendChild(inviteBtn);
  }

  /* 위험한 동작은 ⋯ 메뉴 안에 */
  const moreBtn = mcActionButton("more", "조직 메뉴", true);
  moreBtn.dataset.popoverAnchor = "1";
  moreBtn.addEventListener("click", () => shellOrgOpenMenu(moreBtn, myRole, orgName, main));
  headActions.appendChild(moreBtn);
  head.appendChild(headActions);
  main.appendChild(head);

  /* 소유권 넘기기 패널 (⋯ 메뉴에서 연다) */
  const transferBox = orgEl("div", "mc-org-panel hidden");
  transferBox.id = "mcOrgTransfer";
  main.appendChild(transferBox);

  /* --- 초대 카드 (버튼으로 펼침) --- */
  if (orgCanInvite(myRole)) {
    invitePanel = shellOrgInviteForm(myRole, orgName);
    invitePanel.classList.add("hidden");
    main.appendChild(invitePanel);
  }

  /* --- 조직원 / 초대 대기 --- */
  const section = (title, count, members, emptyText, icon) => {
    const wrap = orgEl("div", "mc-org-section");
    const heading = orgEl("div", "mc-org-section-head");
    heading.appendChild(orgLabel(icon, title, "mc-org-section-title"));
    heading.appendChild(orgEl("span", "mc-org-section-count", String(count)));
    wrap.appendChild(heading);

    if (!members.length) {
      const empty = orgEl("div", "mc-org-section-empty");
      empty.appendChild(orgLabel(icon, emptyText));
      wrap.appendChild(empty);
      return wrap;
    }

    const table = orgEl("div", "mc-org-table");
    const cols = orgEl("div", "mc-org-row mc-org-row-head");
    ["이름", "직급", "권한", ""].forEach((label) => cols.appendChild(orgEl("span", "", label)));
    table.appendChild(cols);
    members.forEach((member) => table.appendChild(shellOrgMemberRow(member, myRole, myEmail)));
    wrap.appendChild(table);
    return wrap;
  };

  main.appendChild(section("조직원", acceptedMembers.length, acceptedMembers, "아직 조직원이 없어요.", "users"));
  if (pendingMembers.length) {
    main.appendChild(section("초대 대기", pendingMembers.length, pendingMembers, "", "clock"));
  }
}

/* ⋯ 메뉴: 소유자 — 소유권 넘기기 · 조직 삭제 / 그 외 — 조직 나가기 */
function shellOrgOpenMenu(anchor, myRole, orgName, main) {
  const wasOpen = shellOpenPopover && shellOpenPopover.dataset.for === "org-menu";
  shellClosePopover();
  if (wasOpen) return;

  const menu = orgEl("div", "mc-popover mc-menu");
  menu.dataset.for = "org-menu";
  menu.setAttribute("role", "menu");

  const add = (label, onClick, danger, icon) => {
    const item = orgEl("button", "mc-menu-item mc-menu-item-icon" + (danger ? " mc-menu-item-danger" : ""));
    item.appendChild(orgIcon(icon || "info"));
    item.appendChild(orgEl("span", "", label));
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => { shellClosePopover(); onClick(); });
    menu.appendChild(item);
  };

  if (myRole === "owner") {
    add("소유권 넘기기", () => shellOrgToggleTransfer(main), false, "crown");
    add("조직 삭제", async () => {
      if (!confirm("'" + orgName + "' 조직을 삭제할까요? 조직원 목록과 초대가 모두 사라지며 되돌릴 수 없습니다.")) return;
      try {
        await fb.deleteOrganization(orgState.selectedOrgId, orgState.members.map((m) => m.email));
        showToast("조직을 삭제했습니다.");
        orgState.selectedOrgId = "";
        await shellOrgLoad();
        shellLoadCharts(); /* (조직 관리 2단계) 조직을 통해 공유된 차트 목록도 바뀐다 */
      } catch (error) {
        orgShowError(error, "삭제하지 못했습니다.");
      }
    }, true, "trash");
  } else {
    add("조직 나가기", async () => {
      if (!confirm("'" + orgName + "' 조직에서 나갈까요?")) return;
      try {
        await fb.removeOrgMembership(orgState.selectedOrgId, orgMyEmail());
        showToast("조직에서 나갔습니다.");
        orgState.selectedOrgId = "";
        await shellOrgLoad();
        shellLoadCharts(); /* (조직 관리 2단계) 조직을 통해 공유된 차트 목록도 바뀐다 */
      } catch (error) {
        orgShowError(error, "나가지 못했습니다.");
      }
    }, true, "leave");
  }

  shellPlacePopover(menu, anchor, true);
}

function shellOrgCreateForm() {
  const box = orgEl("form", "mc-org-create");
  const icon = orgEl("div", "mc-org-create-icon");
  icon.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ORG_ICONS.building + "</svg>";
  box.appendChild(icon);
  box.appendChild(orgEl("h3", "mc-org-name", "새 조직 만들기"));
  box.appendChild(orgEl("p", "mc-org-create-sub", "조직을 만들면 내가 소유자가 됩니다. 한 사람이 조직을 여러 개 만들 수 있어요."));

  const field = (label, input, icon) => {
    const wrap = orgEl("label", "mc-org-field");
    wrap.appendChild(orgLabel(icon, label));
    wrap.appendChild(input);
    return wrap;
  };
  const nameInput = orgEl("input");
  nameInput.type = "text"; nameInput.maxLength = 100; nameInput.required = true;
  nameInput.placeholder = "예: 디자인팀, 졸업 프로젝트";
  const myName = orgEl("input");
  myName.type = "text"; myName.maxLength = 50;
  myName.value = (fbUser && fbUser.displayName) || "";
  myName.placeholder = "조직에서 보일 내 이름";
  const myTitle = orgEl("input");
  myTitle.type = "text"; myTitle.maxLength = 50;
  myTitle.placeholder = "예: 팀장 (선택)";

  box.appendChild(field("조직 이름", nameInput, "building"));
  const row = orgEl("div", "mc-org-field-row");
  row.appendChild(field("내 이름", myName, "user"));
  row.appendChild(field("내 직급", myTitle, "briefcase"));
  box.appendChild(row);

  const actions = orgEl("div", "mc-org-create-actions");
  if (orgState.memberships.some((m) => m.status === "accepted")) {
    const cancel = orgEl("button", "mc-btn mc-btn-ghost", "취소");
    cancel.type = "button";
    cancel.addEventListener("click", async () => {
      orgState.creating = false;
      shellOrgRenderSide();
      await shellOrgLoadMembers();
    });
    actions.appendChild(cancel);
  }
  const submit = orgEl("button", "mc-btn mc-btn-primary", "조직 만들기");
  submit.type = "submit";
  actions.appendChild(submit);
  box.appendChild(actions);

  box.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(submit, "만드는 중…", async () => {
      const name = nameInput.value.trim();
      if (!name) { showToast("조직 이름을 입력하세요.", true); return; }
      try {
        const orgId = await fb.createOrganization(name, {
          uid: fbUser.uid, email: orgMyEmail(), name: myName.value.trim(), title: myTitle.value.trim()
        });
        showToast("'" + name + "' 조직을 만들었습니다.");
        orgState.selectedOrgId = orgId;
        orgState.creating = false;
        await shellOrgLoad();
      } catch (error) {
        orgShowError(error, "조직을 만들지 못했습니다.");
      }
    });
  });

  setTimeout(() => nameInput.focus(), 0);
  return box;
}

/* 초대 카드: 이메일 · 이름 · 직급 + 권한(버튼으로 고르고 설명 한 줄) */
function shellOrgInviteForm(myRole, orgName) {
  const form = orgEl("form", "mc-org-panel mc-org-invite-form");
  form.appendChild(orgLabel("userPlus", "조직원 초대", "mc-org-panel-title"));

  const grid = orgEl("div", "mc-org-invite-grid");
  const field = (label, input, wide, icon) => {
    const wrap = orgEl("label", "mc-org-field" + (wide ? " wide" : ""));
    wrap.appendChild(orgLabel(icon, label));
    wrap.appendChild(input);
    return wrap;
  };
  const email = orgEl("input");
  email.type = "email"; email.required = true; email.placeholder = "name@gmail.com";
  const name = orgEl("input");
  name.type = "text"; name.maxLength = 50; name.placeholder = "예: 김지수";
  const title = orgEl("input");
  title.type = "text"; title.maxLength = 50; title.placeholder = "예: 디자이너";
  grid.appendChild(field("구글 계정 이메일", email, true, "mail"));
  grid.appendChild(field("이름", name, false, "user"));
  grid.appendChild(field("직급", title, false, "briefcase"));
  form.appendChild(grid);

  /* 권한: 버튼 묶음 */
  const roleWrap = orgEl("div", "mc-org-field wide");
  roleWrap.appendChild(orgLabel("shield", "조직 권한"));
  const seg = orgEl("div", "mc-org-seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-label", "조직 권한");
  const help = orgEl("p", "mc-org-role-help");
  let selectedRole = orgAssignableRoles(myRole).includes("member") ? "member" : "guest";
  const paint = () => {
    seg.querySelectorAll("button").forEach((btn) => {
      const on = btn.dataset.role === selectedRole;
      btn.classList.toggle("on", on);
      btn.setAttribute("aria-checked", String(on));
    });
    help.innerHTML = "";
    help.appendChild(orgIcon("info", 13));
    help.appendChild(orgEl("span", "", ORG_ROLE_HELP[selectedRole] || ""));
  };
  orgAssignableRoles(myRole).forEach((role) => {
    const btn = orgEl("button");
    btn.appendChild(orgIcon(ORG_ROLE_ICON[role], 13));
    btn.appendChild(orgEl("span", "", ORG_ROLE_LABEL[role]));
    btn.type = "button";
    btn.dataset.role = role;
    btn.setAttribute("role", "radio");
    btn.addEventListener("click", () => { selectedRole = role; paint(); });
    seg.appendChild(btn);
  });
  roleWrap.appendChild(seg);
  roleWrap.appendChild(help);
  form.appendChild(roleWrap);
  paint();

  const foot = orgEl("div", "mc-org-panel-foot");
  foot.appendChild(orgEl("span", "mc-org-hint", "수락해야 조직원이 돼요. 수락 전에는 조직 이름과 초대한 사람만 보여요."));
  const cancel = orgEl("button", "mc-btn mc-btn-ghost", "취소");
  cancel.type = "button";
  cancel.addEventListener("click", () => form.classList.add("hidden"));
  const submit = orgEl("button", "mc-btn mc-btn-primary");
  submit.appendChild(orgIcon("send"));
  submit.appendChild(orgEl("span", "", "초대 보내기"));
  submit.type = "submit";
  foot.appendChild(cancel);
  foot.appendChild(submit);
  form.appendChild(foot);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    withBusy(submit, "초대 중…", async () => {
      const value = email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { showToast("이메일 형식을 확인해 주세요.", true); return; }
      if (orgState.members.some((m) => m.email === value)) { showToast("이미 조직원이거나 초대한 사람입니다.", true); return; }
      try {
        await fb.inviteOrgMember(orgState.selectedOrgId, orgName,
          { email: value, name: name.value.trim(), title: title.value.trim(), role: selectedRole },
          { email: orgMyEmail(), name: (fbUser && fbUser.displayName) || "" });
        showToast(value + " 님을 초대했습니다.");
        await shellOrgLoadMembers();
      } catch (error) {
        orgShowError(error, "초대하지 못했습니다.");
      }
    });
  });

  return form;
}

function shellOrgMemberRow(member, myRole, myEmail) {
  const isSelf = member.email === myEmail;
  const pending = member.status === "pending";
  const row = orgEl("div", "mc-org-row" + (pending ? " is-pending" : "") + (isSelf ? " is-self" : ""));

  const save = async (fields) => {
    try {
      await fb.updateOrgMember(orgState.selectedOrgId, member.email, fields);
      showToast("저장했습니다.");
      await shellOrgLoadMembers();
    } catch (error) {
      orgShowError(error, "저장하지 못했습니다.");
      await shellOrgLoadMembers();
    }
  };
  const editableInfo = orgCanEditInfo(myRole, member, isSelf);
  const infoInput = (value, field, placeholder, className) => {
    const input = orgEl("input", "mc-org-inline " + className);
    input.type = "text"; input.maxLength = 50; input.value = value || ""; input.placeholder = placeholder;
    input.setAttribute("aria-label", (member.name || member.email) + " " + placeholder);
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") input.blur(); });
    input.addEventListener("change", () => save({ [field]: input.value.trim() }));
    return input;
  };

  /* 이름 칸: 동그라미 + 이름 + 이메일 */
  const who = orgEl("div", "mc-org-who");
  who.appendChild(mcAvatarEl(member.name || member.email));
  const text = orgEl("div", "mc-org-who-text");
  const nameLine = orgEl("div", "mc-org-who-line");
  if (editableInfo) {
    nameLine.appendChild(infoInput(member.name, "name", "이름", "mc-org-member-name"));
  } else {
    nameLine.appendChild(orgEl("span", "mc-org-member-name", member.name || member.email.split("@")[0]));
  }
  text.appendChild(nameLine);
  const emailLine = orgEl("div", "mc-org-who-line");
  emailLine.appendChild(orgEl("span", "mc-org-member-email", member.email));
  if (pending && member.invitedByName) {
    const by = orgEl("span", "mc-org-invited-by");
    by.appendChild(orgIcon("send", 11));
    by.appendChild(orgEl("span", "", member.invitedByName + "님이 초대"));
    emailLine.appendChild(by);
  }
  if (isSelf) emailLine.appendChild(orgEl("span", "mc-org-me", "나"));
  text.appendChild(emailLine);
  who.appendChild(text);
  row.appendChild(who);

  /* 직급 */
  if (editableInfo) {
    row.appendChild(infoInput(member.title, "title", "직급 입력", "mc-org-member-title"));
  } else {
    const titleCell = orgEl("span", "mc-org-member-title" + (member.title ? "" : " empty"));
    titleCell.appendChild(orgIcon("briefcase", 12));
    titleCell.appendChild(orgEl("span", "", member.title || "직급 없음"));
    row.appendChild(titleCell);
  }

  /* 권한: 바꿀 수 있으면 칩 모양 선택 상자, 아니면 칩 */
  if (!isSelf && orgCanChangeRole(myRole, member)) {
    const select = orgEl("select", "mc-org-role-select mc-role-" + (member.role === "member" ? "editor" : member.role === "guest" ? "viewer" : member.role));
    select.setAttribute("aria-label", (member.name || member.email) + " 권한");
    orgAssignableRoles(myRole).forEach((r) => {
      const option = orgEl("option", "", ORG_ROLE_LABEL[r]);
      option.value = r;
      select.appendChild(option);
    });
    select.value = member.role;
    select.addEventListener("change", () => save({ role: select.value }));
    /* 선택 상자 안에는 그림을 못 넣으므로 칩 모양 틀 안 왼쪽에 아이콘을 겹쳐 둔다 */
    const pick = orgEl("span", "mc-org-role-pick");
    pick.appendChild(orgIcon(ORG_ROLE_ICON[member.role], 12));
    pick.appendChild(select);
    row.appendChild(pick);
  } else {
    const chipCell = orgEl("span", "mc-org-role-cell");
    chipCell.appendChild(orgRoleChip(member.role));
    row.appendChild(chipCell);
  }

  /* 내보내기 / 초대 취소 (마우스를 올리면 보임) */
  const actionCell = orgEl("span", "mc-org-row-action");
  if (!isSelf && orgCanKick(myRole, member)) {
    const kick = mcActionButton(pending ? "close" : "leave", pending ? "초대 취소" : "내보내기", true);
    kick.classList.add("mc-row-danger");
    kick.addEventListener("click", () => withBusy(kick, "", async () => {
      const label = member.name || member.email;
      if (!confirm(pending ? label + " 님 초대를 취소할까요?" : label + " 님을 조직에서 내보낼까요?")) return;
      try {
        await fb.removeOrgMembership(orgState.selectedOrgId, member.email);
        showToast(pending ? "초대를 취소했습니다." : "내보냈습니다.");
        await shellOrgLoadMembers();
      } catch (error) {
        orgShowError(error, "처리하지 못했습니다.");
      }
    }));
    actionCell.appendChild(kick);
  }
  row.appendChild(actionCell);

  return row;
}

/* 소유권 넘기기: 수락한 조직원 중에서 고른다. 나는 관리자가 된다. */
function shellOrgToggleTransfer(main) {
  const box = main.querySelector("#mcOrgTransfer");
  if (!box) return;
  if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }

  box.innerHTML = "";
  box.classList.add("mc-org-panel-warn");
  const candidates = orgState.members.filter((m) => m.status === "accepted" && m.email !== orgMyEmail());
  box.appendChild(orgLabel("crown", "소유권 넘기기", "mc-org-panel-title"));
  if (!candidates.length) {
    box.appendChild(orgEl("p", "mc-org-hint", "넘겨받을 수 있는 조직원(수락한 사람)이 없습니다."));
  } else {
    box.appendChild(orgEl("p", "mc-org-hint", "넘기면 그 사람이 소유자가 되고, 나는 관리자가 됩니다."));
    const row = orgEl("div", "mc-org-panel-foot");
    const select = orgEl("select", "mc-org-select");
    select.setAttribute("aria-label", "새 소유자");
    candidates.forEach((m) => {
      const option = orgEl("option", "", (m.name || m.email) + " (" + m.email + ")");
      option.value = m.email;
      select.appendChild(option);
    });
    const cancel = orgEl("button", "mc-btn mc-btn-ghost", "취소");
    cancel.type = "button";
    cancel.addEventListener("click", () => box.classList.add("hidden"));
    const go = orgEl("button", "mc-btn mc-btn-primary", "넘기기");
    go.type = "button";
    go.addEventListener("click", () => withBusy(go, "처리 중…", async () => {
      if (!confirm(select.value + " 님에게 소유권을 넘길까요? 되돌리려면 그 사람이 다시 넘겨줘야 합니다.")) return;
      try {
        await fb.transferOrgOwnership(orgState.selectedOrgId, orgMyEmail(), select.value);
        showToast("소유권을 넘겼습니다.");
        await shellOrgLoad();
      } catch (error) {
        orgShowError(error, "넘기지 못했습니다.");
      }
    }));
    row.appendChild(select);
    row.appendChild(cancel);
    row.appendChild(go);
    box.appendChild(row);
  }
  box.classList.remove("hidden");
}
/* ▲▲▲ 조직 관리 (1단계) 끝 ▲▲▲ */


/* =========================================================
 * (조직 관리 4단계) 사이드바 개인 ↔ 조직 전환
 *  - 사이드바 맨 위 버튼에서 "개인(모든 차트)" 또는 조직 하나를 고른다.
 *  - 조직을 고르면 그 조직에 공유된 차트만 목록·사이드바에 보이고,
 *    머리에 조직 이름과 [조직 현황] 버튼이 나온다.
 *  - 차트 박스(iframe)는 지우지 않고 숨기기만 해서 전환이 바로 된다.
 *  - 고른 보기는 이 브라우저에 기억한다.
 * ========================================================= */
const SHELL_SCOPE_KEY = "mcScopeOrgId";
let shellScopeOrgId = "";
try { shellScopeOrgId = localStorage.getItem(SHELL_SCOPE_KEY) || ""; } catch (error) { /* 무시 */ }

function shellScopeOrgs() {
  const list = myOrgMembershipsCache || orgState.memberships || [];
  return list.filter((m) => m.status === "accepted");
}

function shellScopeOrg() {
  return shellScopeOrgId ? shellScopeOrgs().find((m) => m.orgId === shellScopeOrgId) || null : null;
}

function shellChartInScope(chart) {
  return !shellScopeOrgId || (chart.orgIds || []).includes(shellScopeOrgId);
}

function shellSetScope(orgId) {
  shellScopeOrgId = orgId || "";
  try {
    if (shellScopeOrgId) localStorage.setItem(SHELL_SCOPE_KEY, shellScopeOrgId);
    else localStorage.removeItem(SHELL_SCOPE_KEY);
  } catch (error) { /* 무시 */ }
  shellClosePopover();
  shellApplyScope();
  window.scrollTo({ top: 0 });
}

const WS_ICON_USER = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M5 20a7 7 0 0 1 14 0"></path></svg>';
const WS_ICON_CARET = '<svg class="mc-ws-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5M7 9l5-5 5 5"></path></svg>';

function shellScopeChartCount(orgId) {
  return shellChartsCache.filter((c) => !c.hidden && (!orgId || (c.orgIds || []).includes(orgId))).length;
}

function shellApplyScope() {
  /* 고른 조직에서 나갔거나 조직이 지워졌으면 개인으로 */
  if (shellScopeOrgId && (myOrgMembershipsCache || orgState.memberships.length) && !shellScopeOrg()) {
    shellScopeOrgId = "";
    try { localStorage.removeItem(SHELL_SCOPE_KEY); } catch (error) { /* 무시 */ }
  }
  const org = shellScopeOrg();

  shellChartsCache.forEach((chart) => {
    const inScope = shellChartInScope(chart);
    const box = document.getElementById("mc-chart-anchor-" + chart.id);
    if (box) box.classList.toggle("mc-scope-miss", !inScope);
    const item = document.querySelector('.mc-sidebar-item[data-chart-id="' + CSS.escape(chart.id) + '"]');
    if (item) (item.closest(".mc-sidebar-entry") || item).classList.toggle("mc-scope-miss", !inScope);
  });

  /* 사이드바 칸에 보이는 차트가 하나도 없으면 칸째로 숨긴다(조직 보기일 때만) */
  ["mcSidebarMySection", "mcSidebarSharedSection"].forEach((id) => {
    const section = document.getElementById(id);
    if (!section) return;
    const visible = Array.from(section.querySelectorAll(".mc-sidebar-item[data-chart-id]"))
      .some((item) => !(item.closest(".mc-sidebar-entry") || item).classList.contains("mc-scope-miss"));
    section.classList.toggle("mc-scope-section-empty", !!org && !visible);
  });

  /* 페이지 머리 */
  const title = document.getElementById("mcPageTitle");
  if (title) {
    title.innerHTML = "";
    if (org) {
      title.appendChild(orgAvatarEl(org.orgId, org.orgName));
      title.appendChild(document.createTextNode(org.orgName || "(이름 없는 조직)"));
    } else {
      title.textContent = "내 차트";
    }
    title.classList.toggle("mc-page-title-org", !!org);
  }
  const overviewBtn = document.getElementById("mcOrgOverviewBtn");
  if (overviewBtn) overviewBtn.classList.toggle("hidden", !org);

  const count = shellScopeChartCount(shellScopeOrgId);
  const empty = document.getElementById("mcScopeEmpty");
  if (empty) {
    empty.classList.toggle("hidden", !org || count > 0);
    if (org && !count) {
      empty.innerHTML = "";
      empty.appendChild(orgIcon("building", 22));
      empty.appendChild(orgEl("strong", "", "이 조직에 공유된 차트가 아직 없어요"));
      empty.appendChild(orgEl("span", "", "차트 머리의 [공유] → [조직 전체] 또는 [조직원 선택]으로 공유하면 여기에 모여요."));
    }
  }
  const mcEmpty = document.getElementById("mcEmpty");
  if (mcEmpty && org) mcEmpty.classList.add("hidden");

  shellUpdatePageSub();
  shellRenderScopeSwitch();
}

function shellRenderScopeSwitch() {
  const button = document.getElementById("mcWsSwitch");
  if (!button) return;
  const org = shellScopeOrg();
  button.innerHTML = "";

  if (org) {
    button.appendChild(orgAvatarEl(org.orgId, org.orgName));
  } else {
    const me = orgEl("span", "mc-ws-avatar mc-ws-avatar-me");
    me.innerHTML = WS_ICON_USER;
    button.appendChild(me);
  }
  const text = orgEl("span", "mc-ws-text");
  text.appendChild(orgEl("span", "mc-ws-label", org ? "조직" : "개인"));
  text.appendChild(orgEl("span", "mc-ws-name", org ? (org.orgName || "(이름 없는 조직)") : "모든 차트"));
  button.appendChild(text);
  button.insertAdjacentHTML("beforeend", WS_ICON_CARET);
  button.classList.toggle("mc-ws-org", !!org);
  button.title = org ? (org.orgName + " 조직의 차트만 보는 중") : "개인: 모든 차트";
}

function shellOpenScopeMenu(anchor) {
  const wasOpen = shellOpenPopover && shellOpenPopover.dataset.for === "scope-menu";
  shellClosePopover();
  if (wasOpen) return;

  const menu = orgEl("div", "mc-popover mc-menu mc-ws-menu");
  menu.dataset.for = "scope-menu";
  menu.setAttribute("role", "menu");

  const addItem = (avatar, name, sub, active, onClick) => {
    const item = orgEl("button", "mc-ws-item" + (active ? " active" : ""));
    item.type = "button";
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(active));
    item.appendChild(avatar);
    const text = orgEl("span", "mc-ws-text");
    text.appendChild(orgEl("span", "mc-ws-name", name));
    text.appendChild(orgEl("span", "mc-ws-sub", sub));
    item.appendChild(text);
    if (active) item.appendChild(orgIcon("check", 15));
    item.addEventListener("click", onClick);
    menu.appendChild(item);
  };

  const me = orgEl("span", "mc-ws-avatar mc-ws-avatar-me");
  me.innerHTML = WS_ICON_USER;
  addItem(me, "개인", "모든 차트 " + shellScopeChartCount("") + "개", !shellScopeOrgId, () => shellSetScope(""));

  const orgs = shellScopeOrgs();
  menu.appendChild(orgEl("div", "mc-ws-menu-title", "조직"));
  if (!orgs.length) {
    menu.appendChild(orgEl("div", "mc-ws-menu-empty", "아직 속한 조직이 없어요."));
  }
  orgs.forEach((m) => {
    addItem(orgAvatarEl(m.orgId, m.orgName), m.orgName || "(이름 없는 조직)",
      (ORG_ROLE_LABEL[m.role] || "") + " · 공유된 차트 " + shellScopeChartCount(m.orgId) + "개",
      shellScopeOrgId === m.orgId, () => shellSetScope(m.orgId));
  });

  const manage = orgEl("button", "mc-menu-item mc-menu-item-icon mc-ws-manage");
  manage.type = "button";
  manage.appendChild(orgIcon("users"));
  manage.appendChild(orgEl("span", "", "조직원 관리"));
  manage.addEventListener("click", () => { shellClosePopover(); shellOpenOrgModal(); });
  menu.appendChild(manage);

  shellPlacePopover(menu, anchor, false);
}


/* =========================================================
 * (조직 관리 4단계) 조직 현황
 *  - 이 조직에 공유된(내가 볼 수 있는) 차트의 작업을 모아서
 *    전체 진행률 · 차트별 진행 · 조직원별 맡은 작업을 보여 준다.
 *  - 엑셀(CSV)로 한 번에 내보낼 수 있다.
 * ========================================================= */
let orgOverviewData = null;

function ovTaskStatus(task, today) {
  if ((Number(task.progress) || 0) >= 100) return "done";
  if (task.end && task.end < today) return "late";
  if (task.start && task.start > today) return "todo";
  return "doing";
}

const OV_STATUS_LABEL = { done: "완료", late: "지연", doing: "진행 중", todo: "예정" };

function ovAverage(tasks) {
  if (!tasks.length) return null;
  return Math.round(tasks.reduce((sum, t) => sum + Math.max(0, Math.min(100, Number(t.progress) || 0)), 0) / tasks.length);
}

async function shellLoadOrgOverview(orgId) {
  const org = shellScopeOrgs().find((m) => m.orgId === orgId);
  const charts = shellChartsCache.filter((c) => (c.orgIds || []).includes(orgId));
  const [roster, chartData] = await Promise.all([
    fb.getOrgMembers(orgId).then((list) => list.filter((m) => m.status === "accepted")).catch(() => []),
    Promise.all(charts.map(async (chart) => {
      try {
        const [tasks, categories] = await Promise.all([fb.getTasksOnce(chart.id), fb.getCategoriesOnce(chart.id)]);
        return { chart, ...resolveTasksAndCats({ tasks, categories }) };
      } catch (error) {
        console.warn(error);
        return { chart, tasks: [], categories: [], failed: true };
      }
    }))
  ]);

  const today = dateKey(new Date());
  const allTasks = [];
  chartData.forEach((entry) => {
    entry.tasks.forEach((task) => {
      allTasks.push({ ...task, chartId: entry.chart.id, chartName: entry.chart.name, status: ovTaskStatus(task, today) });
    });
  });

  /* 담당자 → 조직원 연결: 고른 이메일이 우선, 없으면 이름이 같은 조직원 */
  const memberOf = (task) => {
    if (task.ownerEmail) return roster.find((m) => m.email === task.ownerEmail) || null;
    const name = String(task.owner || "").trim();
    if (!name) return null;
    const hits = roster.filter((m) => (m.name || "") === name);
    return hits.length === 1 ? hits[0] : null;
  };

  const people = roster.map((member) => ({ member, tasks: [] }));
  const outside = [];
  const unassigned = [];
  allTasks.forEach((task) => {
    const member = memberOf(task);
    if (member) people.find((p) => p.member.email === member.email).tasks.push(task);
    else if (String(task.owner || "").trim()) outside.push(task);
    else unassigned.push(task);
    task.isMember = !!member;
  });

  people.sort((a, b) => b.tasks.length - a.tasks.length || (a.member.name || a.member.email).localeCompare(b.member.name || b.member.email, "ko"));

  return { org, orgId, charts: chartData, allTasks, people, outside, unassigned, today };
}

function ovStatCard(icon, label, value, sub, tone) {
  const card = orgEl("div", "mc-ov-stat" + (tone ? " mc-ov-stat-" + tone : ""));
  const head = orgEl("div", "mc-ov-stat-head");
  head.appendChild(orgIcon(icon, 15));
  head.appendChild(orgEl("span", "", label));
  card.appendChild(head);
  card.appendChild(orgEl("div", "mc-ov-stat-value", value));
  if (sub) card.appendChild(orgEl("div", "mc-ov-stat-sub", sub));
  return card;
}

function ovProgressBar(pct, color) {
  const bar = orgEl("span", "mc-ov-bar");
  const fill = orgEl("span", "mc-ov-bar-fill");
  fill.style.width = (pct || 0) + "%";
  if (color) fill.style.background = color;
  bar.appendChild(fill);
  return bar;
}

function ovStatusChips(tasks) {
  const wrap = orgEl("span", "mc-ov-chips");
  ["late", "doing", "done"].forEach((status) => {
    const n = tasks.filter((t) => t.status === status).length;
    if (!n) return;
    wrap.appendChild(orgEl("span", "mc-ov-chip mc-ov-chip-" + status, OV_STATUS_LABEL[status] + " " + n));
  });
  return wrap;
}

function ovTaskList(tasks) {
  const list = orgEl("div", "mc-ov-tasks");
  tasks
    .slice()
    .sort((a, b) => (a.status === "late" ? -1 : 0) - (b.status === "late" ? -1 : 0) || String(a.end).localeCompare(String(b.end)))
    .forEach((task) => {
      const row = orgEl("div", "mc-ov-task");
      const dot = orgEl("span", "mc-ov-task-dot");
      dot.style.background = task.color || "#a1a1aa";
      row.appendChild(dot);
      const text = orgEl("span", "mc-ov-task-text");
      text.appendChild(orgEl("span", "mc-ov-task-name", task.name));
      text.appendChild(orgEl("span", "mc-ov-task-sub", task.chartName + " · " + task.start + " ~ " + task.end + (task.owner && !task.isMember ? " · " + task.owner : "")));
      row.appendChild(text);
      row.appendChild(orgEl("span", "mc-ov-chip mc-ov-chip-" + task.status, OV_STATUS_LABEL[task.status]));
      row.appendChild(orgEl("span", "mc-ov-task-pct", (Number(task.progress) || 0) + "%"));
      list.appendChild(row);
    });
  return list;
}

/* 조직원 한 줄: 누르면 그 사람 작업 목록이 펼쳐진다 */
function ovPersonRow(avatar, name, sub, tasks, extraChip) {
  const wrap = orgEl("div", "mc-ov-person");
  const row = orgEl("button", "mc-ov-person-row");
  row.type = "button";
  row.setAttribute("aria-expanded", "false");
  row.disabled = !tasks.length;
  row.appendChild(avatar);
  const text = orgEl("span", "mc-ov-person-text");
  const nameLine = orgEl("span", "mc-ov-person-name", name);
  if (extraChip) nameLine.appendChild(extraChip);
  text.appendChild(nameLine);
  text.appendChild(orgEl("span", "mc-ov-person-sub", sub));
  row.appendChild(text);

  const right = orgEl("span", "mc-ov-person-right");
  right.appendChild(ovStatusChips(tasks));
  const avg = ovAverage(tasks);
  const pctWrap = orgEl("span", "mc-ov-person-pct");
  pctWrap.appendChild(ovProgressBar(avg));
  pctWrap.appendChild(orgEl("span", "mc-ov-pct-num", tasks.length ? avg + "%" : "–"));
  right.appendChild(pctWrap);
  right.appendChild(orgEl("span", "mc-ov-count", tasks.length + "개"));
  row.appendChild(right);
  wrap.appendChild(row);

  if (tasks.length) {
    let list = null;
    row.addEventListener("click", () => {
      const open = row.getAttribute("aria-expanded") !== "true";
      row.setAttribute("aria-expanded", String(open));
      if (open && !list) {
        list = ovTaskList(tasks);
        wrap.appendChild(list);
      }
      if (list) list.classList.toggle("hidden", !open);
    });
  }
  return wrap;
}

function shellRenderOrgOverview(data) {
  const body = document.getElementById("mcOvBody");
  const title = document.getElementById("mcOvTitle");
  body.innerHTML = "";
  title.innerHTML = "";
  title.appendChild(orgAvatarEl(data.orgId, data.org ? data.org.orgName : "조직"));
  const titleText = orgEl("span", "mc-ov-title-text");
  titleText.appendChild(orgEl("span", "", (data.org ? data.org.orgName : "조직") + " 현황"));
  titleText.appendChild(orgEl("span", "mc-ov-title-sub", "조직원 " + data.people.length + "명 · 오늘 " + data.today));
  title.appendChild(titleText);

  /* 1) 요약 숫자 */
  const all = data.allTasks;
  const avg = ovAverage(all);
  const done = all.filter((t) => t.status === "done").length;
  const late = all.filter((t) => t.status === "late").length;
  const stats = orgEl("div", "mc-ov-stats");
  stats.appendChild(ovStatCard("building", "공유된 차트", data.charts.length + "개", null));
  stats.appendChild(ovStatCard("check", "전체 작업", all.length + "개", "완료 " + done + "개", null));
  const avgCard = ovStatCard("users", "평균 진행률", avg === null ? "–" : avg + "%", null, "accent");
  avgCard.appendChild(ovProgressBar(avg));
  stats.appendChild(avgCard);
  stats.appendChild(ovStatCard("clock", "지연된 작업", late + "개", "끝날 날짜가 지났는데 100%가 아닌 작업", late ? "danger" : null));
  body.appendChild(stats);

  if (!data.charts.length) {
    const empty = orgEl("div", "mc-share-empty");
    empty.appendChild(orgIcon("info", 15));
    empty.appendChild(orgEl("span", "", "이 조직에 공유된 차트가 아직 없어요. 차트의 [공유] → [조직 전체]로 공유하면 여기에 모여요."));
    body.appendChild(empty);
  }

  const grid = orgEl("div", "mc-ov-grid");

  /* 2) 차트별 진행 */
  const chartsCol = orgEl("section", "mc-ov-section");
  chartsCol.appendChild(orgLabel("building", "차트별 진행", "mc-ov-section-title"));
  data.charts.forEach((entry) => {
    const tasks = data.allTasks.filter((t) => t.chartId === entry.chart.id);
    const row = orgEl("button", "mc-ov-chart-row");
    row.type = "button";
    row.title = "이 차트로 이동";
    const name = orgEl("span", "mc-ov-chart-name", entry.chart.name);
    row.appendChild(name);
    const right = orgEl("span", "mc-ov-person-right");
    right.appendChild(ovStatusChips(tasks));
    const avgChart = ovAverage(tasks);
    const pctWrap = orgEl("span", "mc-ov-person-pct");
    pctWrap.appendChild(ovProgressBar(avgChart));
    pctWrap.appendChild(orgEl("span", "mc-ov-pct-num", tasks.length ? avgChart + "%" : "–"));
    right.appendChild(pctWrap);
    right.appendChild(orgEl("span", "mc-ov-count", tasks.length + "개"));
    row.appendChild(right);
    row.addEventListener("click", () => {
      shellCloseModal("mcOrgOverviewModal");
      const box = document.getElementById("mc-chart-anchor-" + entry.chart.id);
      if (box) box.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    chartsCol.appendChild(row);
  });
  grid.appendChild(chartsCol);

  /* 3) 조직원별 작업 */
  const peopleCol = orgEl("section", "mc-ov-section");
  peopleCol.appendChild(orgLabel("users", "조직원별 작업", "mc-ov-section-title"));
  const myEmail = orgMyEmail();
  data.people.forEach(({ member, tasks }) => {
    const avatar = mcAvatarEl(member.name || member.email);
    peopleCol.appendChild(ovPersonRow(avatar, member.name || member.email,
      [member.title, member.email].filter(Boolean).join(" · "), tasks,
      member.email === myEmail ? orgEl("span", "assignee-me", "나") : orgRoleChip(member.role)));
  });
  if (data.outside.length) {
    const avatar = orgEl("span", "mc-row-avatar mc-ov-avatar-muted");
    avatar.appendChild(orgIcon("briefcase", 15));
    peopleCol.appendChild(ovPersonRow(avatar, "외부 인원", "조직원이 아닌 담당자(직접 적은 이름)", data.outside));
  }
  if (data.unassigned.length) {
    const avatar = orgEl("span", "mc-row-avatar mc-ov-avatar-muted", "–");
    peopleCol.appendChild(ovPersonRow(avatar, "담당자 없음", "아직 담당자를 정하지 않은 작업", data.unassigned));
  }
  grid.appendChild(peopleCol);
  body.appendChild(grid);

  /* 4) 내보내기 */
  const foot = orgEl("div", "mc-ov-foot");
  foot.appendChild(orgEl("span", "mc-ov-foot-note", "내가 볼 수 있는 차트만 모았어요."));
  const exportBtn = orgEl("button", "mc-btn mc-btn-primary");
  exportBtn.type = "button";
  exportBtn.innerHTML = mcIconSvg("download") + "<span>엑셀로 내보내기</span>";
  exportBtn.disabled = !all.length;
  exportBtn.addEventListener("click", () => shellExportOrgOverview(data));
  foot.appendChild(exportBtn);
  body.appendChild(foot);
}

function shellExportOrgOverview(data) {
  const headers = ["차트", "카테고리", "작업명", "담당자", "담당자 이메일", "구분", "시작일", "종료일", "진행률(%)", "상태", "메모", "대상처"];
  const rows = [headers.map(csvEscape).join(",")];
  data.allTasks.forEach((t) => {
    rows.push([
      t.chartName, t.catName, t.name, t.owner, t.ownerEmail,
      t.isMember ? "조직원" : (String(t.owner || "").trim() ? "외부" : "담당자 없음"),
      t.start, t.end, t.progress, OV_STATUS_LABEL[t.status], t.memo, t.target
    ].map(csvEscape).join(","));
  });
  const name = String((data.org && data.org.orgName) || "조직").replace(/[\\/:*?"<>|]/g, "_");
  downloadTextFile("조직현황_" + name + "_" + data.today + ".csv", "﻿" + rows.join("\r\n"), "text/csv;charset=utf-8");
}

async function shellOpenOrgOverview(orgId) {
  if (!orgId) return;
  const body = document.getElementById("mcOvBody");
  body.innerHTML = "";
  body.appendChild(orgEl("div", "mc-share-loading", "현황을 모으는 중…"));
  document.getElementById("mcOvTitle").textContent = "조직 현황";
  shellOpenModal("mcOrgOverviewModal");
  try {
    orgOverviewData = await shellLoadOrgOverview(orgId);
    shellRenderOrgOverview(orgOverviewData);
  } catch (error) {
    body.innerHTML = "";
    orgShowError(error, "조직 현황을 불러오지 못했습니다.");
  }
}

function initShellScope() {
  const switchBtn = document.getElementById("mcWsSwitch");
  if (switchBtn) switchBtn.addEventListener("click", () => shellOpenScopeMenu(switchBtn));
  const overviewBtn = document.getElementById("mcOrgOverviewBtn");
  if (overviewBtn) overviewBtn.addEventListener("click", () => shellOpenOrgOverview(shellScopeOrgId));
  shellRenderScopeSwitch();
}

function shellInitSidebarToggle() {
  const toggleBtn = document.getElementById("mcSidebarToggle");
  const addBtn = document.getElementById("mcSidebarAddBtn");
  const shellView = document.getElementById("shellView");
  if (!toggleBtn || !shellView) return;

  let collapsed = false;
  try { collapsed = localStorage.getItem("mcSidebarCollapsed") === "1"; } catch (error) { /* 무시 */ }
  shellView.classList.toggle("mc-sidebar-collapsed", collapsed);

  toggleBtn.addEventListener("click", () => {
    collapsed = !collapsed;
    shellView.classList.toggle("mc-sidebar-collapsed", collapsed);
    try { localStorage.setItem("mcSidebarCollapsed", collapsed ? "1" : "0"); } catch (error) { /* 무시 */ }
  });

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const mainAddBtn = document.getElementById("mcAddBtn");
      if (mainAddBtn) mainAddBtn.click();
    });
  }

  /* (조직 관리 1단계) 사이드바 "조직원 관리" */
  const orgBtn = document.getElementById("mcSidebarOrgBtn");
  if (orgBtn) orgBtn.addEventListener("click", shellOpenOrgModal);

  /* (요청사항) 사이드바 "메모 보드" */
  shellInitMemoBoard();

  const orgNewBtn = document.getElementById("mcOrgNewBtn");
  if (orgNewBtn) {
    orgNewBtn.addEventListener("click", () => {
      orgState.creating = true;
      shellOrgRenderSide();
      shellOrgRenderMain();
    });
  }

  /* (디자인 추가분) 사이드바 아래 "차트 관리"는 상단 "차트 관리" 버튼과 같은 동작 */
  const manageBtn = document.getElementById("mcSidebarManageBtn");
  if (manageBtn) {
    manageBtn.addEventListener("click", () => {
      const mainManageBtn = document.getElementById("mcManageBtn");
      if (mainManageBtn) mainManageBtn.click();
    });
  }

  const search = document.getElementById("mcSearch");
  if (search) search.addEventListener("input", shellApplySearch);
}
/* ▲▲▲ 접이식 사이드바 (추가분) 끝 ▲▲▲ */

/* (추가분) 캘린더 연동 + CSV 내보내기: 차트 박스 위 버튼들의 동작. */

function shellFindChart(chartId) {
  return shellChartsCache.find((c) => c.id === chartId) || null;
}

function shellShowInfo(message) {
  const box = document.getElementById("mcInfoModalMessage");
  if (box) box.textContent = message;
  shellOpenModal("mcInfoModal");
}

let pendingCalDeleteChartId = "";

function shellConfirmCalDelete(chartId, chartName) {
  if (typeof pendingSharedCalDeleteChartId !== "undefined") pendingSharedCalDeleteChartId = ""; // (공유 기능 추가분) 섞임 방지
  pendingCalDeleteChartId = chartId;
  const box = document.getElementById("mcCalConfirmMessage");
  if (box) box.textContent = "정말 \"" + chartName + "\" 차트를 캘린더에서 삭제하시겠습니까?";
  shellOpenModal("mcCalConfirmModal");
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shellHandleExportCsv(chartId, box) {
  try {
    const res = await apiPostForChart("exportChartCsv", chartId);
    const name = (box && box.querySelector(".mc-chart-box-name") && box.querySelector(".mc-chart-box-name").textContent) || "차트";
    downloadTextFile(name + ".csv", res.result, "text/csv;charset=utf-8");
  } catch (error) {
    showToast(error.message || "내보내지 못했습니다.", true, 0);
  }
}

async function shellHandleCalendarAdd(chartId) {
  try {
    await shellLoadCharts();
  } catch (error) {
    // 무시하고 지금 캐시로 진행
  }

  const chart = shellFindChart(chartId);

  if (chart && chart.hasCalendar) {
    shellShowInfo("해당 차트가 이미 존재합니다!");
    return;
  }

  try {
    await apiPostForChart("addCalendarToChart", chartId);
    showToast("캘린더에 추가했습니다.");
    await shellLoadCharts();
  } catch (error) {
    showToast(error.message || "추가하지 못했습니다.", true, 0);
  }
}

async function shellHandleCalendarRemove(chartId) {
  try {
    await shellLoadCharts();
  } catch (error) {
    // 무시하고 지금 캐시로 진행
  }

  const chart = shellFindChart(chartId);

  if (!chart || !chart.hasCalendar) {
    shellShowInfo("해당 차트가 존재하지 않습니다!");
    return;
  }

  shellConfirmCalDelete(chartId, chart.name);
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

/* (성능 개선) 차트 관리 박스에서 이름 변경/숨기기/삭제/추가를 한 뒤,
   예전에는 매번 shellLoadCharts()를 다시 불러서 개인 차트 전체 DB를
   한 번 더 통째로 받아오고, 아무 상관 없는 공유 차트 목록까지 다시
   조회했다. 이제 각 액션의 응답에 이미 들어있는 최신 개인 차트 목록을
   그대로 반영하고, 공유 차트 쪼(shellChartsCache 안의 shared 항목)은
   그대로 둬서 불필요한 왕복을 없앤다. */
function shellApplyPersonalChartsList(charts) {
  if (!Array.isArray(charts)) {
    return;
  }
  const personal = charts.map((c) => ({ ...c, shared: false }));
  const shared = shellChartsCache.filter((c) => c.shared);
  shellChartsCache = personal.concat(shared);
  shellRenderList();
  shellBroadcastRefreshToIframes();
}

function shellRenderManageRows() {
  const root = document.getElementById("mcManageRows");
  root.innerHTML = "";

  /* 목록을 다시 받아 그린다. 공유 차트는 개인 차트 목록 응답에 없으므로 전체를 다시 불러온다. */
  const afterChange = async (chart, res) => {
    if (chart.shared) {
      await shellLoadCharts();
    } else {
      shellApplyPersonalChartsList(res.charts);
    }
    shellRenderManageRows();
  };

  shellChartsCache.forEach((chart) => {
    const row = document.createElement("div");
    row.className = "mc-manage-row" + (chart.hidden ? " is-hidden" : "");

    /* (버그 수정) 남이 공유해 준 차트는 내 것이 아니라서 이름 바꾸기·숨기기·삭제가
       권한 오류로 실패했다. 여기서는 이름과 "공유받음" 표시, 나가기만 보여준다. */
    if (shellIsReceivedChart(chart)) {
      const tile = document.createElement("span");
      tile.className = "mc-manage-tile";
      tile.setAttribute("aria-hidden", "true");
      tile.textContent = Array.from(String(chart.name || "?").trim() || "?")[0];
      row.appendChild(tile);

      const name = document.createElement("span");
      name.className = "mc-manage-name";
      name.textContent = chart.name;
      row.appendChild(name);

      const badge = document.createElement("span");
      badge.className = "mc-manage-badge mc-manage-badge-shared";
      badge.textContent = "공유받음";
      badge.title = (chart.ownerEmail || "") + "님이 공유한 차트";
      row.appendChild(badge);

      /* (조직 관리 2단계) 조직을 통해서만 받은 차트는 조직에서 나가면 함께 빠진다 */
      if (!chart.viaOrgOnly) {
        const leaveBtn = mcActionButton("leave", "공유 차트 나가기", true);
        leaveBtn.classList.add("mc-row-danger");
        leaveBtn.addEventListener("click", async () => {
          await shellHandleLeaveShared(chart.chartId, chart.name);
          shellRenderManageRows();
        });
        row.appendChild(leaveBtn);
      }

      root.appendChild(row);
      return;
    }

    /* (디자인 추가분) 차트 이름 첫 글자 타일 */
    const tile = document.createElement("span");
    tile.className = "mc-manage-tile";
    tile.setAttribute("aria-hidden", "true");
    tile.textContent = Array.from(String(chart.name || "?").trim() || "?")[0];
    row.appendChild(tile);

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = chart.name;
    nameInput.maxLength = 200;
    nameInput.setAttribute("aria-label", "차트 이름");
    row.appendChild(nameInput);

    if (chart.hidden) {
      const badge = document.createElement("span");
      badge.className = "mc-manage-badge";
      badge.textContent = "숨김";
      row.appendChild(badge);
    }

    const saveBtn = mcActionButton("check", "이름 저장", false);
    saveBtn.classList.add("mc-manage-save");
    /* 이름을 고쳤을 때만 저장 버튼이 보인다. Enter로도 저장. */
    const syncSaveVisible = () => {
      saveBtn.classList.toggle("is-dirty", nameInput.value.trim() !== chart.name);
    };
    nameInput.addEventListener("input", syncSaveVisible);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); saveBtn.click(); }
    });
    saveBtn.addEventListener("click", () => withBusy(saveBtn, "저장 중…", async () => {
      const newName = nameInput.value.trim();
      if (!newName) { showToast("이름을 입력하세요.", true); return; }
      try {
        const res = await apiPostForChart("updateChart", chart.id, { data: { id: chart.id, name: newName } });
        showToast("이름을 바꿨습니다.");
        await afterChange(chart, res);
      } catch (error) {
        showToast(error.message || "변경하지 못했습니다.", true, 0);
      }
    }));
    row.appendChild(saveBtn);

    const toggleBtn = mcActionButton(chart.hidden ? "eyeOff" : "eye", chart.hidden ? "보이기" : "숨기기", true);
    toggleBtn.addEventListener("click", () => withBusy(toggleBtn, "변경 중…", async () => {
      try {
        const res = await apiPostForChart("updateChart", chart.id, { data: { id: chart.id, hidden: !chart.hidden } });
        showToast(chart.hidden ? "다시 보이게 했습니다." : "숨겼습니다.");
        await afterChange(chart, res);
      } catch (error) {
        showToast(error.message || "변경하지 못했습니다.", true, 0);
      }
    }));
    row.appendChild(toggleBtn);

    {
      // (요청사항) 기본 차트도 다른 차트와 똑같이 삭제 버튼을 보여준다.
      const delBtn = mcActionButton("trash", "삭제", true);
      delBtn.classList.add("mc-row-danger");
      delBtn.addEventListener("click", () => withBusy(delBtn, "삭제 중…", async () => {
        if (!confirm('"' + chart.name + '" 차트를 완전히 삭제할까요? 이 차트의 모든 데이터가 함께 삭제되며 되돌릴 수 없습니다.')) {
          return;
        }
        try {
          const res = await apiPostForChart("deleteChart", chart.id, { id: chart.id });
          showToast("삭제했습니다.");
          await afterChange(chart, res);
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

  shellInitSidebarToggle(); /* (사이드바 추가분) */
  initShellScope(); /* (조직 관리 4단계) 개인 ↔ 조직 전환 */

  document.getElementById("mcAddBtn").addEventListener("click", () => {
    /* (공유 기능 추가분) 바로 "새 차트" 입력창을 띄우던 것을, 먼저
       "새로운 차트 만들기 / 차트 공유받기" 선택 박스를 거치도록 바꿈.
       "새로운 차트 만들기"를 누르면 기존과 완전히 동일한 입력창이 뜬다. */
    if (typeof shellOpenNewOrShareModal === "function") {
      shellOpenNewOrShareModal();
    } else {
      document.getElementById("mcAddName").value = "";
      shellOpenModal("mcAddModal");
    }
  });

  document.getElementById("mcAddSaveBtn").addEventListener("click", () => withBusy(
    document.getElementById("mcAddSaveBtn"), "추가 중…", async () => {
      const name = document.getElementById("mcAddName").value.trim();
      if (!name) { showToast("차트 이름을 입력하세요.", true); return; }
      try {
        const res = await apiPost("createChart", { data: { name } });
        shellCloseModal("mcAddModal");
        showToast("차트를 추가했습니다.");
        shellApplyPersonalChartsList(res.charts);
      } catch (error) {
        showToast(error.message || "추가하지 못했습니다.", true, 0);
      }
    }
  ));

  document.getElementById("mcManageBtn").addEventListener("click", () => {
    /* (성능 개선) 박스를 열 때마다 전체 목록을 새로 받아올 때까지
       기다리게 하지 않고, 이미 화면에 있는 캐시로 먼저 즉시 열고
       최신화는 뒤에서 조용히 받아와 반영한다. */
    shellRenderManageRows();
    shellOpenModal("mcManageModal");
    shellLoadCharts().then(shellRenderManageRows).catch(() => {});
  });

  const mcKeyBtn = document.getElementById("mcKeyBtn");
  if (mcKeyBtn) {
    mcKeyBtn.classList.add("gantt-login-btn");
    mcKeyBtn.addEventListener("click", handleLoginButtonClick);
  }
  setLoginButtonsUi();

  document.getElementById("mcReloadBtn").addEventListener("click", () => {
    shellLoadCharts();
  });

  const mcExportAllBtn = document.getElementById("mcExportAllBtn");
  if (mcExportAllBtn) {
    mcExportAllBtn.addEventListener("click", () => withBusy(
      mcExportAllBtn, "내보내는 중…", async () => {
        try {
          const csv = await buildCsvForAllCharts();
          downloadTextFile("간트차트_전체.csv", csv, "text/csv;charset=utf-8");
        } catch (error) {
          showToast(error.message || "내보내지 못했습니다.", true, 0);
        }
      }
    ));
  }

  const mcCalConfirmDeleteBtn = document.getElementById("mcCalConfirmDeleteBtn");
  if (mcCalConfirmDeleteBtn) {
    mcCalConfirmDeleteBtn.addEventListener("click", () => withBusy(
      mcCalConfirmDeleteBtn, "삭제 중…", async () => {
        const chartId = pendingCalDeleteChartId;
        shellCloseModal("mcCalConfirmModal");
        if (!chartId) return;

        try {
          await apiPostForChart("removeCalendarFromChart", chartId);
          showToast("캘린더에서 삭제했습니다.");
          await shellLoadCharts();
        } catch (error) {
          showToast(error.message || "삭제하지 못했습니다.", true, 0);
        }
      }
    ));
  }

  shellLoadCharts();
}
/* ▲▲▲ 멀티 차트 SHELL (추가분) 끝 ▲▲▲ */


/* =========================================================
 * ▼▼▼ 멀티 차트: 이 차트의 커스텀 표시 기간 (추가분) ▼▼▼
 * ========================================================= */

/** 이 차트(CHART_ID)의 저장된 표시 기간을 서버에서 읽어 state에 반영하고,
 *  입력칸도 채워 둔다. 설정된 게 없으면 아무것도 안 바뀐다(기존 동작 그대로). */
async function loadChartRangeMeta() {
  let rangeChanged = false;
  try {
    /* (버그 수정) 예전엔 "listCharts"(개인 소유이면서 공유 안 된 차트만
       돌려줌)에서 이 차트를 찾았는데, 지금 보고 있는 차트가 공유
       중이면 그 목록에 아예 없어서 이름/표시기간을 못 찾았다 — 그래서
       공유 차트를 열면 이름이 "Gantt Chart"로 보이고, 표시기간도
       새로고침하면 사라지는 것처럼 보였다. 차트 자신의 ID로 직접
       문서를 읽으면 개인/공유 상관없이 항상 맞게 찾는다. */
    const mine = await getChartMetaCached(CHART_ID);

    const before = state.customStart ? dateKey(state.customStart) + "~" + dateKey(state.customEnd) : "";

    if (mine && mine.rangeStart && mine.rangeEnd) {
      state.customStart = dateObj(mine.rangeStart);
      state.customEnd = dateObj(mine.rangeEnd);
      state.year = state.customStart.getFullYear();
    } else if (mine && state.customStart) {
      /* (버그 수정) 다른 곳에서 표시 기간을 지웠으면 연도 보기로 돌아간다. */
      state.customStart = null;
      state.customEnd = null;
      state.year = new Date().getFullYear();
    }

    rangeChanged =
      before !== (state.customStart ? dateKey(state.customStart) + "~" + dateKey(state.customEnd) : "");

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
  return rangeChanged;
}

/* (버그 수정) 이 화면이 모음(셸) 페이지 안의 iframe으로 떠 있을 때,
   이름/표시기간을 바꾸면 부모 페이지의 박스 머리글도 같이 바뀌어야
   한다("위아래 연동"). 예전엔 window.parent.shellLoadCharts()를 직접
   불렀는데, app2.js가 <script type="module">로 열려서 최상위 함수가
   window에 안 걸리기 때문에(모듈 스코프는 전역이 아님) 이 호출은 항상
   조용히 실패하고 있었다(같은 출처인데도). postMessage는 모듈 스코프와
   무관하게 항상 동작하므로 이걸로 바꾼다. */
function notifyParentMetaChanged() {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "gantt:chartMetaChanged", chartId: CHART_ID }, window.location.origin);
    }
  } catch (error) {
    // 교차 출처 등 예외적인 경우만 조용히 무시.
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
          notifyParentMetaChanged();

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

/* "연도 보기로" 전환 뒤 보여 줄 연도 (카드 머리에서 연도를 골랐을 때만) */
let pendingYearAfterClear = 0;

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
        notifyParentMetaChanged();
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
        state.year = pendingYearAfterClear || new Date().getFullYear();
        if (startInput) startInput.value = "";
        if (endInput) endInput.value = "";
        resetRange();
        render();
        showToast("연도 보기로 전환했습니다.");
        notifyParentMetaChanged();
      } catch (error) {
        showToast(error.message || "전환하지 못했습니다.", true, 0);
      } finally {
        pendingYearAfterClear = 0;
      }
    }));
  }
}

/* (디자인 추가분) 셸의 카드 머리에서 온 명령 처리 */
function handleParentCommand(data) {

  const click = id => {
    const button = document.getElementById(id);
    if (button && !button.disabled) button.click();
  };

  switch (data.cmd) {
    case "reload": click("reloadBtn"); break;
    case "full": click("fullBtn"); break;
    case "today": click("todayBtn"); break;
    case "capture": click("captureBtn"); break;
    case "setOwnerFilter": {
      const f = data.filter;
      setOwnerFilter(f && f.kind ? { kind: String(f.kind), value: String(f.value || ""), label: String(f.label || "") } : null);
      break;
    }
    case "openTask": {
      /* (요청사항) 사이드바에서 작업을 누르면 막대를 누른 것과 같은 상세창 */
      if (state.tasks.some(task => task.id === data.taskId)) {
        showTaskDetail(data.taskId);
      }
      break;
    }
    case "setRange": {
      const startInput = document.getElementById("chartRangeStart");
      const endInput = document.getElementById("chartRangeEnd");
      if (startInput) startInput.value = data.start || "";
      if (endInput) endInput.value = data.end || "";
      click("chartRangeSaveBtn");
      break;
    }
    case "clearRange": click("chartRangeClearBtn"); break;
    case "setYear": {
      /* (요청사항) 카드 머리의 기간 알약에서 연도를 고르면 그 해 연도 보기로 */
      const year = Number(data.year);
      if (!year) break;
      if (state.customStart) {
        pendingYearAfterClear = year;
        click("chartRangeClearBtn");
      } else if (year !== state.year) {
        changeYear(year - state.year);
      }
      break;
    }
    default: break;
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
  /* (버그 수정) 차트 박스 안의 iframe(개별 차트 화면)에서 이름/표시기간을
     바꾸면, 거기서 postMessage로 알려준다(notifyParentMetaChanged 참고).
     받으면 목록을 다시 불러와서 박스 머리글에 바로 반영한다. */
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === "gantt:chartMetaChanged") {
      shellLoadCharts();
    }
    /* (버그 수정) 차트 iframe 안의 알림을 이 페이지 아래쪽에 대신 띄운다. */
    if (event.data && event.data.type === "gantt:toast") {
      if (event.data.hide) hideToast();
      else showToast(String(event.data.message || ""), !!event.data.isError, Number(event.data.duration) || 0);
    }
    /* (디자인 추가분) 차트 iframe이 보내는 요약값(평균 진행률·카테고리·기간) */
    if (event.data && event.data.type === "gantt:stats" && event.data.chartId) {
      shellStats[event.data.chartId] = event.data;
      shellApplyStats(event.data.chartId);
      shellRefreshBell();
      bellRefetchChart(event.data.chartId);
    }
  });
  /* (디자인 추가분) iframe에서 저장하면 "마지막 저장" 시각을 바로 바꾼다. */
  window.addEventListener("storage", (event) => {
    if (event.key === LAST_SAVED_KEY) shellUpdatePageSub();
  });
  /* (공유 기능 추가분) */
  if (typeof initShareUi === "function") initShareUi();
  /* (Firebase 전환) 예전 refreshUserAvatar()는 삭제됐다 — 로그인
     상태(프로필 사진 포함)는 이제 fb.onAuthChange 리스너가 Firebase
     세션을 확인하는 즉시 setLoginButtonsUi()를 불러서 반영하므로,
     여기서 따로 또 부를 필요가 없다(불렀다간 삭제된 함수라 에러만 남).
     initShell()이 이미 setLoginButtonsUi()를 한 번 호출해 두므로
     로그인 전 상태도 바로 올바르게 보인다. */

} else {

  checkVersions();

  setupDrag();
  initOwnerFilter(); /* (조직 관리 3단계) 담당자별 보기 */

  initChartRangeUI();
  initChartNameUI();
  /* (버그 수정) 반대 방향: 모음(셸) 페이지의 "관리" 모달에서 이름을
     바꾸는 등, 부모 쪽에서 메타가 바뀌었을 때 이 iframe이 알림을
     받으면(shellLoadCharts 쪽에서 쏴줌) 자기 이름/표시기간을 다시
     읽어온다. */
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data && event.data.type === "gantt:refreshMeta") {
      /* (버그 수정) 표시 기간이 바뀌었으면 바로 다시 그린다(예전엔 값만 바꾸고 안 그렸다). */
      loadChartRangeMeta().then(changed => {
        if (changed) {
          resetRange();
          state.scrollToToday = true;
          render();
        }
      });
    }

    /* (디자인 추가분) 카드 머리(셸)에 있는 버튼들이 보내는 명령.
       이 화면의 기존 버튼을 그대로 눌러서 기존 동작을 그대로 쓴다. */
    if (event.data && event.data.type === "gantt:command") {
      handleParentCommand(event.data);
    }
  });
  /* (공유 기능 추가분) 공유 차트인데 내 권한이 "뷰어"면, 수정 관련
     버튼/핸들을 숨긴다 (서버는 이미 막아주지만, 화면도 맞춰줌). */
  if (typeof initSharedViewerReadonly === "function") initSharedViewerReadonly();

  /* (추가분) 이 차트의 저장된 커스텀 표시 기간을 먼저 읽어온 뒤에
     범위를 초기화하고 데이터를 불러온다. 커스텀 기간이 없으면
     state는 전혀 안 바뀌므로 기존과 완전히 동일하게 동작한다. */
  (async () => {
    await loadChartRangeMeta();

    /* 현재 연도(또는 커스텀 기간)의 전체 범위로 초기화 */
    resetRange();

    /* 데이터 불러오기 → 그 뒤로는 실시간 반영 */
    loadData();
  })();
}

/* =========================================================
 * ▼▼▼ 공유 기능 (Firebase 전환판) ▼▼▼
 * ---------------------------------------------------------
 * (중요) 개인 차트와 공유 차트가 이제 같은 Firestore charts/{chartId}
 * 문서를 쓴다. 작업/카테고리 CRUD는 위쪽 apiGet/apiPost/coreApiPost가
 * IS_SHARED_CHART 여부에 따라 chartId만 CHART_ID ↔ SHARED_CHART_ID로
 * 바꿔서 그대로 처리하므로, 이 블록에서 apiGet/apiPost를 다시 정의하지
 * 않는다(예전 Drive+ShareServer.gs 2중 구조 때는 꼭 필요했던 것).
 * 여기 남은 shareFetch는 "멤버십"(초대/수락/거절/공유해제/멤버 목록)
 * 전용 — SHARE_SERVER_URL(Apps Script)은 더 이상 쓰지 않는다.
 * ========================================================= */

/* (share12, 이제는 역사적 기록) SHARE_SERVER_URL / SHARED_CHART_PREFIX /
   IS_SHARED_CHART / SHARED_CHART_ID 는 파일 맨 앞(CHART_ID 선언 바로 다음)으로 옮겼다.
   TDZ 버그 수정 이유는 그쪽 주석 참고. */

/* (Firebase 전환) 개인 차트와 공유 차트가 이제 같은 Firestore
   charts/{chartId} 문서를 쓰므로, 작업/카테고리 CRUD는 위쪽의 apiGet/
   apiPost(coreApiPost)가 그대로 처리한다(IS_SHARED_CHART일 때는
   SHARED_CHART_ID를 쓰도록 이미 분기돼 있다). 여기 남은 shareFetch는
   "멤버십"(초대/수락/거절/공유해제/멤버 목록) 전용으로만 쓰인다 —
   예전 ShareServer.gs 왕복을 Firestore 문서 업데이트로 바꾼 것. */

function shareMembersShape(chart) {
  const members = Object.keys((chart && chart.members) || {})
    .filter((email) => chart.members[email])
    .map((email) => ({
      email, role: chart.members[email].role, status: chart.members[email].status
    }));
  return { members, ownerEmail: (chart && chart.ownerEmail) || "" };
}

async function fbListMyInvites(email) {
  if (!email) return [];
  const list = await fb.getInvitesOnce(email);
  return list.map((c) => ({ chartId: c.id, chartName: c.name || "", ownerEmail: c.ownerEmail || "" }));
}

async function fbListMySharedCharts() {
  if (!fbUser) return [];
  const all = await fbGetChartsOnceShared();
  const memberships = myOrgMembershipsCache || [];
  return all
    .filter((c) => (c.ownerId === fbUser.uid && hasAnyMembers(c)) || c.ownerId !== fbUser.uid)
    .map((c) => ({
      chartId: c.id, name: c.name || "", rangeStart: c.rangeStart || "", rangeEnd: c.rangeEnd || "",
      role: chartMyRole(c, memberships) || "viewer",
      /* (조직 관리 2단계) 조직을 통해서만 들어온 차트는 "나가기" 대신 조직에서 나가야 한다 */
      viaOrgOnly: c.ownerId !== fbUser.uid && !chartManualRole(c) && !!chartOrgRole(c, memberships),
      orgNames: (c.orgIds || []).map((orgId) => ((c.orgShares || {})[orgId] || {}).orgName || "").filter(Boolean),
      orgIds: (c.orgIds || []).slice(),
      ownerEmail: c.ownerEmail || "",
      /* (버그 수정) 내가 소유한 공유 차트는 "숨기기"가 먹도록 숨김 값을 넘긴다. */
      hidden: c.ownerId === fbUser.uid && !!c.hidden,
      /* (디자인 추가분) 공유 버튼에 "+N" 동그라미를 띄우기 위한 멤버 이메일 목록 */
      members: Object.keys(c.members || {}).filter((email) => c.members[email])
    }));
}

async function shareFetch(action, params = {}) {
  if (!fbUser) {
    throw new Error("로그인이 필요합니다. 'Google 로그인' 버튼을 눌러주세요.");
  }
  const chartId = params.chartId;

  switch (action) {
    case "listMySharedCharts":
      return await fbListMySharedCharts();

    case "listMyInvites":
      return await fbListMyInvites(fbUser.email);

    case "respondInvite": {
      await fb.respondInvite(chartId, fbUser.email, !!params.accept);
      invalidateChartMetaCache(chartId);
      const invites = await fbListMyInvites(fbUser.email);
      const sharedCharts = await fbListMySharedCharts();
      return { invites, sharedCharts };
    }

    case "shareChart": {
      await fb.inviteMember(chartId, params.targetEmail, params.role);
      invalidateChartMetaCache(chartId);
      const chart = await fb.getChartOnce(chartId);
      if (!chart) throw new Error("차트를 찾을 수 없습니다.");
      return shareMembersShape(chart);
    }

    case "unshareMember":
      /* removeMember가 memberEmails 변경에 맞춰 작업/카테고리의 ACL
         복사값도 같이 재조정한다(firebase-core.js 참고). */
      await fb.removeMember(chartId, params.targetEmail);
      invalidateChartMetaCache(chartId);
      return { ok: true };

    case "getSharedChartMembers": {
      const chart = await fb.getChartOnce(chartId);
      if (!chart) throw new Error("차트를 찾을 수 없습니다.");
      return shareMembersShape(chart);
    }

    case "getSharedChartData": {
      const chart = await fb.getChartOnce(chartId);
      if (!chart) throw new Error("차트를 찾을 수 없습니다.");
      const [tasks, categories] = await Promise.all([
        fb.getTasksOnce(chartId), fb.getCategoriesOnce(chartId)
      ]);
      const resolved = resolveTasksAndCats({ tasks, categories });
      const myRole = chartMyRole(chart, await fbMyOrgMemberships()) || "viewer";
      return {
        name: chart.name || "", rangeStart: chart.rangeStart || "", rangeEnd: chart.rangeEnd || "",
        tasks: resolved.tasks, categories: resolved.categories, myRole
      };
    }

    case "updateSharedChartMeta":
      await fb.updateChartMeta(chartId, {
        name: params.name, rangeStart: params.rangeStart, rangeEnd: params.rangeEnd
      });
      return { ok: true };

    case "revokeAllSharing":
      /* (단순해진 점) 새 차트로 복사할 필요 없이, 이 차트의 멤버만
         전부 비우면 바로 "개인 전용" 상태로 돌아간다. revokeAllSharing이
         멤버를 비우는 것과 작업/카테고리의 ACL 복사값 재조정을 한 번에
         처리한다(firebase-core.js 참고). */
      await fb.revokeAllSharing(chartId);
      /* (조직 관리 2단계) 조직으로 준 공유도 함께 해제 */
      {
        const chart = await fb.getChartOnce(chartId);
        for (const orgId of ((chart && chart.orgIds) || [])) {
          await fb.unshareChartFromOrg(chartId, orgId);
        }
      }
      invalidateChartMetaCache(chartId);
      return { ok: true };

    case "leaveSharedChart":
      await fb.removeMember(chartId, fbUser.email);
      invalidateChartMetaCache(chartId);
      return { ok: true };

    default:
      throw new Error("지원하지 않는 공유 기능입니다: " + action);
  }
}

/* =========================================================
 * 공유 UI (멀티 차트 화면)
 * ========================================================= */

let shareModalChartId = "";
let shareModalIsExisting = false;

function shellRenderShareMembersList(members, ownerEmail, canManage, chartId) {
  const box = document.getElementById("mcShareMemberList");
  if (!box) return;
  box.innerHTML = "";

  members.forEach((m) => {
    const row = mcMemberRowEl(m);

    if (canManage && m.role !== "owner") {
      const delBtn = mcActionButton("close", "공유 해제", true);
      delBtn.classList.add("mc-row-danger");
      delBtn.addEventListener("click", () => withBusy(delBtn, "삭제 중…", async () => {
        try {
          await shareFetch("unshareMember", { chartId, targetEmail: m.email });
          showToast("공유를 해제했습니다.");
          const found = shellChartsCache.find((c) => c.shared && c.chartId === chartId);
          shellOpenShareModal(chartId, document.getElementById("mcShareChartName").textContent, true, found ? found.role : "admin");
        } catch (error) {
          showToast(error.message || "삭제하지 못했습니다.", true, 0);
        }
      }));
      row.appendChild(delBtn);
    }

    box.appendChild(row);
  });
}

/* (요청사항) "공유" 버튼을 누르는 순간 바로 이메일 입력을 요구하던 것을
   없애고, 버튼을 누르면 먼저 (멤버 없이) 공유 상태로만 전환한 뒤, 그
   차트의 공유 모달 안에서 사용자를 추가/수정하게 한다. 전환과 멤버
   추가를 한 번에 묶어서 하면, 추가 후 화면 갱신이 "전체 새로고침"
   없이는 반영이 안 되는 문제가 있었는데, 분리하면 멤버 추가 쪽은
   이미 빨라진 inline 갱신 경로를 그대로 타게 된다. */
/* (Firebase 전환으로 단순해진 점) 예전엔 "공유로 전환"할 때 개인 Drive
   데이터를 공유 서버로 복사하고 개인 차트를 지워야 했지만, 이제는 같은
   Firestore 문서를 그대로 쓰므로 복사/삭제가 전혀 필요 없다. 그냥 공유
   모달을 "아직 공유되지 않은 차트" 상태로 열어서, 사용자가 이메일을
   추가하는 순간(shellHandleShareAdd) 처음으로 멤버가 생기며 공유 차트로
   보이게 된다. */
async function shellStartSharing(chartId, chartName) {
  await shellOpenShareModal(chartId, chartName, false, "owner");
}

async function shellOpenShareModal(chartId, chartName, alreadyShared, myRole) {
  shareModalChartId = chartId;
  shareModalIsExisting = !!alreadyShared;

  document.getElementById("mcShareChartName").textContent = chartName || "";
  document.getElementById("mcShareEmail").value = "";
  const roleSel = document.getElementById("mcShareRole");
  if (roleSel) roleSel.value = "viewer";

  const revokeBtn = document.getElementById("mcShareRevokeBtn");

  if (alreadyShared) {
    try {
      const info = await shareFetch("getSharedChartMembers", { chartId });
      shellRenderShareMembersList(info.members, info.ownerEmail, true, chartId);
      // "나만 보기로 전환"은 소유자만 할 수 있다 (관리자는 멤버 추가/삭제만).
      if (revokeBtn) revokeBtn.classList.toggle("hidden", myRole !== "owner");
    } catch (error) {
      showToast(error.message || "멤버 목록을 불러오지 못했습니다.", true, 0);
    }
  } else {
    const box = document.getElementById("mcShareMemberList");
    if (box) box.innerHTML = "<div class=\"mc-hint\">아직 공유되지 않은 차트입니다. 이메일·조직원·조직을 추가하면 공유가 시작됩니다.</div>";
    if (revokeBtn) revokeBtn.classList.add("hidden"); // 아직 공유 전이라 해제할 게 없음
  }

  /* (조직 관리 2단계) 조직원 선택 · 조직 전체 탭과 조직 공유 목록 */
  shellShareSetTab("email");
  const orgList = document.getElementById("mcShareOrgList");
  if (orgList) orgList.innerHTML = "";
  shareOrgState.chart = null;
  shellShareOrgRefresh();

  shellOpenModal("mcShareModal");
}

async function shellHandleShareAdd() {
  const email = document.getElementById("mcShareEmail").value.trim();
  const role = document.getElementById("mcShareRole").value;
  const chartId = shareModalChartId;

  if (!email) { showToast("이메일을 입력하세요.", true); return; }

  try {
    /* (Firebase 전환으로 단순해진 점) 처음 초대하든 추가로 초대하든
       Firestore 쪽은 이 차트 문서의 members 맵에 한 명 더하는 것으로
       완전히 동일하다 — 데이터를 다른 곳으로 옮길 필요가 없다. */
    const shareRes = await shareFetch("shareChart", { chartId, targetEmail: email, role });
    showToast("공유를 추가했습니다.");
    document.getElementById("mcShareEmail").value = "";
    shellRenderShareMembersList(shareRes.members, shareRes.ownerEmail, true, chartId);

    if (!shareModalIsExisting) {
      shareModalIsExisting = true;
      /* (성능 수정) 개인→공유 전환 때문에 차트 목록 전체를 다시 긁어오던
         것을, 이 차트 하나만 캐시에서 "공유 중" 상태로 바꿔주는 걸로
         대체한다 — id가 더 이상 안 바뀌니(shellLoadCharts 주석 참고)
         박스/iframe도 그대로 유지된 채 헤더 버튼만 바뀐다. */
      const entry = shellChartsCache.find((c) => c.id === chartId);
      if (entry) {
        entry.shared = true;
        entry.chartId = chartId;
        entry.role = "owner";
        shellRenderList();
      } else {
        // 캐시에 없는 경우(드묾)만 안전하게 전체 새로고침.
        await shellLoadCharts();
      }
    }
  } catch (error) {
    showToast(error.message || "공유하지 못했습니다.", true, 0);
  }
}

async function shellHandleRevokeAllSharing() {
  const chartId = shareModalChartId;
  if (!chartId) return;

  try {
    /* (Firebase 전환으로 단순해진 점) 데이터를 새 차트로 복사했다가
       예전 공유 차트를 지우는 과정 없이, 이 차트 문서의 멤버만 전부
       비우면 바로 개인 전용 차트로 돌아간다(같은 chartId 그대로). */
    await shareFetch("revokeAllSharing", { chartId });

    shellCloseModal("mcShareModal");
    showToast("공유를 해제하고 개인 차트로 되돌렸습니다.");

    /* (성능 수정) 여기서도 전체 차트 목록을 다시 받아오지 않고, 이
       차트 하나만 캐시에서 "개인 전용" 상태로 바꾼다. id는 그대로라
       박스/iframe이 유지된다. */
    const entry = shellChartsCache.find((c) => c.id === chartId);
    if (entry) {
      entry.shared = false;
      delete entry.role;
      delete entry.ownerEmail;
      shellRenderList();
    } else {
      await shellLoadCharts();
    }
  } catch (error) {
    showToast(error.message || "공유 해제에 실패했습니다.", true, 0);
  }
}

/* =========================================================
 * (조직 관리 2단계) 공유 창: 조직원 선택 · 조직 전체 · 조직으로 공유한 목록
 *  - 이메일 직접 초대(기존)는 그대로 두고, 탭 두 개를 더했다.
 *  - 조직으로 준 권한은 차트 members 에 적지 않고 orgShares 에 적는다.
 *    (보안 규칙이 조직 소속을 그때그때 확인 → 나가거나 내보내지면 바로 끊김)
 * ========================================================= */
const shareOrgState = { chart: null, memberships: [], rosters: {}, picked: new Set() };


function shellShareSetTab(tab) {
  document.querySelectorAll("#mcShareModal .mc-share-tab").forEach((btn) => {
    const on = btn.dataset.shareTab === tab;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("#mcShareModal [data-share-pane]").forEach((pane) => {
    pane.classList.toggle("hidden", pane.dataset.sharePane !== tab);
  });
}

/* 이 차트를 조직에 공유할 수 있는 조직: 수락한 조직 중 참여자 이상 */
function shareOrgSelectable() {
  return shareOrgState.memberships.filter((m) => m.status === "accepted" && orgRank(m.role) >= 1);
}

async function shareOrgRoster(orgId) {
  if (!shareOrgState.rosters[orgId]) {
    shareOrgState.rosters[orgId] = fb.getOrgMembers(orgId)
      .then((list) => list.filter((m) => m.status === "accepted"))
      .catch((error) => {
        console.warn(error);
        return null; // 이 조직원이 아니면 목록을 못 읽는다
      });
  }
  return shareOrgState.rosters[orgId];
}

function shareOrgShareOf(orgId) {
  return ((shareOrgState.chart && shareOrgState.chart.orgShares) || {})[orgId] || null;
}

function shareOrgFillSelect(select, orgs, keep) {
  const previous = keep ? select.value : "";
  select.innerHTML = "";
  orgs.forEach((m) => {
    const option = document.createElement("option");
    option.value = m.orgId;
    option.textContent = m.orgName || "(이름 없는 조직)";
    select.appendChild(option);
  });
  if (previous && orgs.some((m) => m.orgId === previous)) select.value = previous;
}

function shareOrgEmptyNote(text) {
  const note = orgEl("div", "mc-share-empty");
  note.appendChild(orgIcon("info", 15));
  note.appendChild(orgEl("span", "", text));
  return note;
}

const SHARE_NO_ORG_TEXT = "공유할 수 있는 조직이 없어요. 사이드바 [조직원 관리]에서 조직을 만들거나, 참여자 이상인 조직이 있어야 해요.";

async function shellShareOrgRefresh() {
  const chartId = shareModalChartId;
  if (!chartId || typeof fb.getOrgChartIndex !== "function") return;
  try {
    const [chart, memberships] = await Promise.all([fb.getChartOnce(chartId), fbMyOrgMemberships(true)]);
    if (chartId !== shareModalChartId) return;
    shareOrgState.chart = chart;
    shareOrgState.memberships = memberships;
    shareOrgState.rosters = {};
    shareOrgState.picked = new Set();
  } catch (error) {
    console.error(error);
    return;
  }

  /* 조직으로만 공유한 차트면 "아직 공유되지 않은 차트" 안내를 지운다 */
  const manualList = document.getElementById("mcShareMemberList");
  if (manualList && manualList.querySelector(".mc-hint") && ((shareOrgState.chart || {}).orgIds || []).length) {
    manualList.innerHTML = "";
  }

  const orgs = shareOrgSelectable();
  shareOrgFillSelect(document.getElementById("mcSharePickOrg"), orgs, true);
  shareOrgFillSelect(document.getElementById("mcShareAllOrg"), orgs, true);

  const allPane = document.querySelector('#mcShareModal [data-share-pane="org"]');
  allPane.classList.toggle("mc-share-pane-empty", !orgs.length);
  const oldNote = allPane.querySelector(".mc-share-empty");
  if (oldNote) oldNote.remove();
  if (!orgs.length) allPane.prepend(shareOrgEmptyNote(SHARE_NO_ORG_TEXT));

  await Promise.all([shellShareRenderPick(), shellShareRenderOrgList()]);
}

/* ---- 조직원 선택 탭 ---- */
/* "N명 추가" 버튼: 아이콘은 두고 글자만 바꾼다 */
function shellShareSyncPickButton() {
  const button = document.getElementById("mcSharePickBtn");
  const count = document.getElementById("mcSharePickCount");
  const n = shareOrgState.picked.size;
  button.disabled = !n;
  const label = button.querySelector("span");
  if (label) label.textContent = n ? n + "명 추가" : "추가";
  count.textContent = n ? n + "명 선택" : "";
}

async function shellShareRenderPick() {
  const pane = document.querySelector('#mcShareModal [data-share-pane="pick"]');
  const select = document.getElementById("mcSharePickOrg");
  const list = document.getElementById("mcSharePickList");
  const orgs = shareOrgSelectable();

  pane.classList.toggle("mc-share-pane-empty", !orgs.length);
  list.innerHTML = "";
  shareOrgState.picked = new Set();
  const syncButton = shellShareSyncPickButton;
  syncButton();

  if (!orgs.length) {
    list.appendChild(shareOrgEmptyNote(SHARE_NO_ORG_TEXT));
    return;
  }

  const orgId = select.value;
  const share = shareOrgShareOf(orgId);
  if (share && share.all) {
    list.appendChild(shareOrgEmptyNote("이미 이 조직 전체에 공유하고 있어요. 아래 목록에서 사람마다 권한을 바꿀 수 있어요."));
    return;
  }

  list.appendChild(orgEl("div", "mc-share-loading", "불러오는 중…"));
  const roster = await shareOrgRoster(orgId);
  if (select.value !== orgId) return;
  list.innerHTML = "";

  const chart = shareOrgState.chart || {};
  const me = orgMyEmail();
  const owner = String(chart.ownerEmail || "").toLowerCase();
  const already = (share && share.picked) || {};
  const candidates = (roster || []).filter((m) => m.email !== me && m.email !== owner && !already[m.email]);

  if (!candidates.length) {
    list.appendChild(shareOrgEmptyNote(roster && roster.length > 1
      ? "이 조직의 조직원은 모두 이미 공유받았어요."
      : "고를 수 있는 조직원이 없어요."));
    return;
  }

  candidates.forEach((member) => {
    const item = orgEl("label", "mc-share-pick-item");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.addEventListener("change", () => {
      if (box.checked) shareOrgState.picked.add(member.email);
      else shareOrgState.picked.delete(member.email);
      item.classList.toggle("checked", box.checked);
      syncButton();
    });
    item.appendChild(box);
    item.appendChild(mcAvatarEl(member.name || member.email));
    const text = orgEl("span", "mc-row-text");
    text.appendChild(orgEl("span", "mc-row-title", member.name || member.email));
    text.appendChild(orgEl("span", "mc-row-sub", (member.title ? member.title + " · " : "") + member.email));
    item.appendChild(text);
    item.appendChild(orgRoleChip(member.role));
    const arrow = orgEl("span", "mc-share-map-arrow");
    arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>';
    item.appendChild(arrow);
    const chartRole = ORG_TO_CHART_ROLE[member.role] || "viewer";
    item.appendChild(orgEl("span", "mc-role-chip mc-role-" + chartRole, CHART_ROLE_LABEL[chartRole]));
    list.appendChild(item);
  });
}

/* 처음 공유하는 순간 차트 박스를 "공유 중"으로 (shellHandleShareAdd 와 같은 처리) */
async function shellShareMarkShared(chartId) {
  if (shareModalIsExisting) return;
  shareModalIsExisting = true;
  const revokeBtn = document.getElementById("mcShareRevokeBtn");
  if (revokeBtn) revokeBtn.classList.remove("hidden");
  const entry = shellChartsCache.find((c) => c.id === chartId);
  if (entry) {
    entry.shared = true;
    entry.chartId = chartId;
    entry.role = "owner";
    shellRenderList();
  } else {
    await shellLoadCharts();
  }
}

function shareOrgCheckLimit(orgId) {
  const ids = (shareOrgState.chart && shareOrgState.chart.orgIds) || [];
  if (!ids.includes(orgId) && ids.length >= (fb.ORG_SHARE_LIMIT || 3)) {
    showToast("한 차트는 조직 " + (fb.ORG_SHARE_LIMIT || 3) + "곳까지 공유할 수 있어요.", true);
    return false;
  }
  return true;
}

function shareOrgMeta() {
  const chart = shareOrgState.chart || {};
  return {
    chartName: chart.name || document.getElementById("mcShareChartName").textContent || "",
    ownerEmail: chart.ownerEmail || "",
    sharedByEmail: orgMyEmail()
  };
}

function shareOrgName(orgId) {
  const membership = shareOrgState.memberships.find((m) => m.orgId === orgId);
  return (membership && membership.orgName) || "";
}

async function shellShareAddPicked() {
  const chartId = shareModalChartId;
  const orgId = document.getElementById("mcSharePickOrg").value;
  const emails = Array.from(shareOrgState.picked);
  if (!chartId || !orgId || !emails.length) return;
  if (!shareOrgCheckLimit(orgId)) return;

  try {
    const share = shareOrgShareOf(orgId);
    if (share) {
      const picked = { ...(share.picked || {}) };
      emails.forEach((email) => { picked[email] = true; });
      await fb.updateChartOrgShare(chartId, orgId, { picked });
    } else {
      const picked = {};
      emails.forEach((email) => { picked[email] = true; });
      await fb.shareChartToOrg(chartId, orgId, { orgName: shareOrgName(orgId), all: false, picked }, shareOrgMeta());
    }
    invalidateChartMetaCache(chartId);
    showToast(emails.length + "명에게 공유했습니다.");
    await shellShareMarkShared(chartId);
    await shellShareOrgRefresh();
  } catch (error) {
    orgShowError(error, "공유하지 못했습니다.");
  }
}

async function shellShareAddWholeOrg() {
  const chartId = shareModalChartId;
  const orgId = document.getElementById("mcShareAllOrg").value;
  if (!chartId || !orgId) return;
  if (!shareOrgCheckLimit(orgId)) return;

  try {
    const share = shareOrgShareOf(orgId);
    if (share && share.all) {
      showToast("이미 이 조직 전체에 공유하고 있어요.");
      return;
    }
    if (share) {
      await fb.updateChartOrgShare(chartId, orgId, { all: true });
    } else {
      await fb.shareChartToOrg(chartId, orgId, { orgName: shareOrgName(orgId), all: true }, shareOrgMeta());
    }
    invalidateChartMetaCache(chartId);
    showToast("'" + (shareOrgName(orgId) || "조직") + "' 전체에 공유했습니다.");
    await shellShareMarkShared(chartId);
    await shellShareOrgRefresh();
  } catch (error) {
    orgShowError(error, "공유하지 못했습니다.");
  }
}

/* ---- 조직으로 공유한 목록 (조직마다 카드 하나) ---- */
async function shellShareRenderOrgList() {
  const box = document.getElementById("mcShareOrgList");
  if (!box) return;
  box.innerHTML = "";

  const chart = shareOrgState.chart || {};
  const orgIds = chart.orgIds || [];
  if (!orgIds.length) return;

  box.appendChild(orgLabel("building", "조직으로 공유", "mc-share-org-title"));

  for (const orgId of orgIds) {
    const share = shareOrgShareOf(orgId) || {};
    const myMembership = shareOrgState.memberships.find((m) => m.orgId === orgId && m.status === "accepted");
    const orgName = (myMembership && myMembership.orgName) || share.orgName || "(조직)";

    const card = orgEl("div", "mc-share-org-card");
    const head = orgEl("div", "mc-share-org-head");
    head.appendChild(orgAvatarEl(orgId, orgName));
    const headText = orgEl("div", "mc-row-text");
    headText.appendChild(orgEl("span", "mc-row-title", orgName));
    const pickedCount = Object.keys(share.picked || {}).length;
    headText.appendChild(share.all
      ? orgLabel("users", "조직 전체 · 나중에 들어오는 조직원 포함", "mc-row-sub")
      : orgLabel("user", "고른 조직원 " + pickedCount + "명", "mc-row-sub"));
    head.appendChild(headText);

    const removeBtn = mcActionButton("close", "이 조직 공유 해제", true);
    removeBtn.classList.add("mc-row-danger");
    removeBtn.addEventListener("click", () => withBusy(removeBtn, "해제 중…", async () => {
      if (!confirm("'" + orgName + "' 조직 공유를 해제할까요? 이 조직을 통해 보던 사람은 더 이상 볼 수 없어요.")) return;
      try {
        await fb.unshareChartFromOrg(shareModalChartId, orgId);
        invalidateChartMetaCache(shareModalChartId);
        showToast("조직 공유를 해제했습니다.");
        await shellShareOrgRefresh();
      } catch (error) {
        orgShowError(error, "해제하지 못했습니다.");
      }
    }));
    head.appendChild(removeBtn);
    card.appendChild(head);

    const body = orgEl("div", "mc-share-org-body");
    card.appendChild(body);
    box.appendChild(card);

    const roster = myMembership ? await shareOrgRoster(orgId) : null;
    if (!roster) {
      body.appendChild(shareOrgEmptyNote("이 조직의 조직원만 사람별 목록을 볼 수 있어요."));
      continue;
    }

    const owner = String(chart.ownerEmail || "").toLowerCase();
    const included = roster.filter((m) => m.email !== owner && (share.all || (share.picked || {})[m.email]));
    if (!included.length) {
      body.appendChild(shareOrgEmptyNote(share.all ? "아직 다른 조직원이 없어요." : "고른 조직원이 없어요. 위 [조직원 선택]에서 추가하세요."));
      continue;
    }

    included.forEach((member) => body.appendChild(shellShareOrgMemberRow(orgId, share, member)));
  }
}

function shellShareOrgMemberRow(orgId, share, member) {
  const row = orgEl("div", "mc-share-member-row mc-share-org-member");
  row.appendChild(mcAvatarEl(member.name || member.email));
  const text = orgEl("span", "mc-row-text");
  text.appendChild(orgEl("span", "mc-row-title", member.name || member.email));
  text.appendChild(orgEl("span", "mc-row-sub", (member.title ? member.title + " · " : "") + member.email));
  row.appendChild(text);
  row.appendChild(orgRoleChip(member.role));

  const base = ORG_TO_CHART_ROLE[member.role] || "viewer";
  const override = (share.overrides || {})[member.email] || "";
  const select = document.createElement("select");
  select.className = "mc-share-org-role";
  select.setAttribute("aria-label", (member.name || member.email) + " 이 차트 권한");
  [["", "기존 권한 · " + CHART_ROLE_LABEL[base]], ["viewer", "뷰어"], ["editor", "편집자"], ["admin", "관리자"]].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
  select.value = override;
  const paint = () => {
    select.dataset.role = select.value || base;
    select.classList.toggle("is-override", !!select.value);
  };
  paint();
  select.addEventListener("change", async () => {
    const value = select.value;
    select.disabled = true;
    try {
      await fb.setChartOrgOverride(shareModalChartId, orgId, member.email, value);
      share.overrides = { ...(share.overrides || {}) };
      if (value) share.overrides[member.email] = value; else delete share.overrides[member.email];
      invalidateChartMetaCache(shareModalChartId);
      paint();
      showToast((member.name || member.email) + " 님의 권한을 " + (value ? CHART_ROLE_LABEL[value] : "기존 권한") + "(으)로 바꿨습니다.");
    } catch (error) {
      select.value = override;
      paint();
      orgShowError(error, "권한을 바꾸지 못했습니다.");
    } finally {
      select.disabled = false;
    }
  });
  row.appendChild(select);

  if (!share.all) {
    const removeBtn = mcActionButton("close", "이 사람 공유 해제", true);
    removeBtn.classList.add("mc-row-danger");
    removeBtn.addEventListener("click", () => withBusy(removeBtn, "해제 중…", async () => {
      try {
        await fb.setChartOrgPicked(shareModalChartId, orgId, member.email, false);
        invalidateChartMetaCache(shareModalChartId);
        showToast("공유를 해제했습니다.");
        await shellShareOrgRefresh();
      } catch (error) {
        orgShowError(error, "해제하지 못했습니다.");
      }
    }));
    row.appendChild(removeBtn);
  }
  return row;
}

/* 공유 구성원 보기(뷰어·편집자용 창)에도 조직 공유를 한 줄씩 */
async function shellAppendOrgSharesToMembersList(chartId, box) {
  try {
    const chart = await fb.getChartOnce(chartId);
    ((chart && chart.orgIds) || []).forEach((orgId) => {
      const share = (chart.orgShares || {})[orgId] || {};
      const row = orgEl("div", "mc-share-member-row");
      row.appendChild(orgAvatarEl(orgId, share.orgName || "조직"));
      const text = orgEl("span", "mc-row-text");
      text.appendChild(orgEl("span", "mc-row-title", share.orgName || "(조직)"));
      text.appendChild(orgEl("span", "mc-row-sub", share.all ? "조직 전체 · 기존 권한" : "고른 조직원 " + Object.keys(share.picked || {}).length + "명"));
      row.appendChild(text);
      row.appendChild(orgLabel("building", "조직", "mc-role-chip mc-role-org"));
      box.appendChild(row);
    });
  } catch (error) {
    console.warn(error);
  }
}

function initShareOrgUi() {
  document.querySelectorAll("#mcShareModal .mc-share-tab").forEach((btn) => {
    btn.addEventListener("click", () => shellShareSetTab(btn.dataset.shareTab));
  });
  const pickOrg = document.getElementById("mcSharePickOrg");
  if (pickOrg) pickOrg.addEventListener("change", shellShareRenderPick);
  const pickBtn = document.getElementById("mcSharePickBtn");
  /* withBusy 가 끝나며 예전 글자·활성 상태로 되돌리므로, 끝난 뒤 다시 맞춘다 */
  if (pickBtn) pickBtn.addEventListener("click", () => withBusy(pickBtn, "공유 중…", shellShareAddPicked).then(shellShareSyncPickButton));
  const allBtn = document.getElementById("mcShareAllBtn");
  if (allBtn) allBtn.addEventListener("click", () => withBusy(allBtn, "공유 중…", shellShareAddWholeOrg));
}

async function shellOpenMembersModal(chartId) {
  try {
    const info = await shareFetch("getSharedChartMembers", { chartId });
    const box = document.getElementById("mcMembersList");
    box.innerHTML = "";

    const list = [{ email: info.ownerEmail, role: "owner", status: "accepted" }].concat(
      info.members.filter((m) => m.role !== "owner")
    );

    list.forEach((m) => {
      box.appendChild(mcMemberRowEl(m));
    });
    await shellAppendOrgSharesToMembersList(chartId, box);

    shellOpenModal("mcMembersModal");
  } catch (error) {
    showToast(error.message || "멤버 목록을 불러오지 못했습니다.", true, 0);
  }
}

async function shellHandleLeaveShared(chartId, chartName) {
  if (!confirm("\"" + chartName + "\" 공유 차트에서 나가시겠습니까?")) return;

  try {
    await shareFetch("leaveSharedChart", { chartId });
    showToast("공유 차트에서 나갔습니다.");
    await shellLoadCharts();
  } catch (error) {
    showToast(error.message || "나가지 못했습니다.", true, 0);
  }
}

/* ----- 새 차트 만들기 / 공유받기 선택 박스 + 공유받기(초대) 화면 ----- */

function shellOpenNewOrShareModal() {
  shellOpenModal("mcNewOrShareModal");
}

/* (성능 개선) 공유 받은 초대를 "수락"했을 때, 예전엔 응답을 받은 뒤에도
   초대 목록 재조회(listMyInvites) + 전체 차트 목록 새로고침
   (listCharts + listMySharedCharts)까지 왕복 3번을 더 보내서, Apps
   Script 호출이 순서대로 쌓여 5초 넘게 걸리는 일이 있었다. 이제
   respondInvite 응답에 최신 초대 목록과 공유 차트 목록이 같이 오므로,
   그 자리에서 화면만 바로 갱신한다 (개인 차트 목록은 수락/거절로 바뀌는
   게 없으니 건드릴 필요도 없다). */
/* (요청사항) "＋ 새 차트" 버튼, "차트 공유받기" 버튼 오른쪽 위에 아직
   수락하지 않은 초대 개수를 빨간 배지로 띄운다. 초대 목록을 다시 그릴
   때마다(최초 로딩, 수락/거절 직후) 항상 같이 호출해서 두 배지를
   같은 숫자로 맞춘다. */
function updateInviteBadges(count) {
  const n = Number(count) || 0;
  [document.getElementById("mcAddBtnBadge"), document.getElementById("mcReceiveBtnBadge")].forEach((badge) => {
    if (!badge) return;
    badge.textContent = n > 99 ? "99+" : String(n);
    badge.classList.toggle("hidden", n <= 0);
  });
}

function shellRenderInvitesList(invites) {
  updateInviteBadges((invites || []).length);

  const box = document.getElementById("mcInvitesList");
  if (!box) return;

  if (!invites || !invites.length) {
    box.innerHTML = "<div class=\"mc-hint\">공유받은 차트가 없습니다.</div>";
    return;
  }

  box.innerHTML = "";
  invites.forEach((inv) => {
    const row = document.createElement("div");
    row.className = "mc-invite-row";

    row.appendChild(mcAvatarEl(inv.ownerEmail));

    const text = document.createElement("span");
    text.className = "mc-row-text";
    const title = document.createElement("span");
    title.className = "mc-row-title";
    title.textContent = inv.chartName;
    const sub = document.createElement("span");
    sub.className = "mc-row-sub";
    sub.textContent = inv.ownerEmail + "님이 공유했어요";
    text.appendChild(title);
    text.appendChild(sub);
    row.appendChild(text);

    const acceptBtn = document.createElement("button");
    acceptBtn.type = "button";
    acceptBtn.className = "mc-btn mc-btn-primary";
    acceptBtn.textContent = "수락";
    acceptBtn.addEventListener("click", () => withBusy(acceptBtn, "처리 중…", async () => {
      try {
        const res = await shareFetch("respondInvite", { chartId: inv.chartId, accept: true });
        showToast("수락했습니다.");
        shellRenderInvitesList(res.invites);
        shellApplySharedChartsList(res.sharedCharts);
      } catch (error) {
        showToast(error.message || "처리하지 못했습니다.", true, 0);
      }
    }));

    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "mc-btn mc-btn-ghost";
    rejectBtn.textContent = "거절";
    rejectBtn.addEventListener("click", () => withBusy(rejectBtn, "처리 중…", async () => {
      try {
        const res = await shareFetch("respondInvite", { chartId: inv.chartId, accept: false });
        showToast("거절했습니다.");
        shellRenderInvitesList(res.invites);
      } catch (error) {
        showToast(error.message || "처리하지 못했습니다.", true, 0);
      }
    }));

    row.appendChild(acceptBtn);
    row.appendChild(rejectBtn);
    box.appendChild(row);
  });
}

/* (공유 기능 추가분, 그대로) 초대함을 처음 열 때는 서버에서 직접 받아와야 하니
   fetch 버전은 남겨두고, 내부적으로 위 렌더 함수를 재사용한다. */
async function shellRenderInvites() {
  const box = document.getElementById("mcInvitesList");
  if (!box) return;

  if (!fbUser) {
    box.innerHTML = "<div class=\"mc-hint\">먼저 Google 로그인을 해주세요.</div>";
    return;
  }

  try {
    const invites = await shareFetch("listMyInvites", {});
    shellRenderInvitesList(invites);
  } catch (error) {
    box.innerHTML = "<div class=\"mc-hint\">" + (error.message || "불러오지 못했습니다.") + "</div>";
  }
}

/* shellLoadCharts()의 공유 목록 매핑과 같은 모양 — 초대 수락 직후
   개인 차트 목록은 그대로 두고 공유 차트 목록만 갈아끼운다. */
function shellApplySharedChartsList(sharedList) {
  if (!Array.isArray(sharedList)) {
    return;
  }
  const shared = sharedList.map((c) => ({
    id: c.chartId, // (성능 수정) 접두사 없이 그대로 — shellLoadCharts 쪽 주석 참고
    chartId: c.chartId,
    name: c.name,
    rangeStart: c.rangeStart || "",
    rangeEnd: c.rangeEnd || "",
    hidden: !!c.hidden,
    order: 999999,
    hasCalendar: false,
    shared: true,
    role: c.role,
    viaOrgOnly: !!c.viaOrgOnly,
    orgNames: c.orgNames || [],
    orgIds: c.orgIds || [],
    ownerEmail: c.ownerEmail,
    members: Array.isArray(c.members) ? c.members : []
  }));
  const personal = shellChartsCache.filter((c) => !c.shared);
  shellChartsCache = personal.concat(shared);
  shellRenderList();
  shellBroadcastRefreshToIframes();
}

function initShareUi() {
  if (typeof initSharedCalendarUi === "function") initSharedCalendarUi();

  const newChartOptBtn = document.getElementById("mcNewOrShareNewBtn");
  if (newChartOptBtn) {
    newChartOptBtn.addEventListener("click", () => {
      shellCloseModal("mcNewOrShareModal");
      document.getElementById("mcAddName").value = "";
      shellOpenModal("mcAddModal");
    });
  }

  const receiveOptBtn = document.getElementById("mcNewOrShareReceiveBtn");
  if (receiveOptBtn) {
    receiveOptBtn.addEventListener("click", () => {
      shellCloseModal("mcNewOrShareModal");
      shellRenderInvites();
      shellOpenModal("mcInvitesModal");
    });
  }

  const shareAddBtn = document.getElementById("mcShareAddBtn");
  if (shareAddBtn) {
    shareAddBtn.addEventListener("click", () => withBusy(shareAddBtn, "처리 중…", shellHandleShareAdd));
  }

  initShareOrgUi(); /* (조직 관리 2단계) */

  const revokeBtn = document.getElementById("mcShareRevokeBtn");
  if (revokeBtn) {
    revokeBtn.addEventListener("click", () => {
      if (confirm("정말 공유를 전부 해제하고 개인 차트로 되돌리시겠습니까?")) {
        withBusy(revokeBtn, "해제 중…", shellHandleRevokeAllSharing);
      }
    });
  }
}
/* ▲▲▲ 공유 기능 (추가분) 끝 ▲▲▲ */


/* =========================================================
 * ▼▼▼ 공유 차트 캘린더/CSV + 뷰어 읽기전용 (추가분) ▼▼▼
 * ---------------------------------------------------------
 * 공유 차트의 캘린더는 "보는 사람 각자" 자기 계정에 따로 만든다(결정 6).
 * 그 캘린더 정보(캘린더 ID, 작업별 이벤트 ID)는 서버가 아니라
 * 이 브라우저의 localStorage에만 저장한다 — 어차피 "나만의" 정보이고,
 * 다른 사람과 공유될 필요가 없는 정보라서 서버 데이터 구조를 안 건드린다.
 * ========================================================= */

function sharedCalStorageKey(chartId) {
  return "gantt_shared_cal_" + chartId;
}

function sharedCalLoadInfo(chartId) {
  try {
    const raw = localStorage.getItem(sharedCalStorageKey(chartId));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

function sharedCalSaveInfo(chartId, info) {
  try {
    localStorage.setItem(sharedCalStorageKey(chartId), JSON.stringify(info));
  } catch (error) {
    // localStorage 실패해도 캘린더 자체는 이미 만들어졌으니 조용히 넘어감
  }
}

function sharedCalClearInfo(chartId) {
  try {
    localStorage.removeItem(sharedCalStorageKey(chartId));
  } catch (error) {
    // 무시
  }
}

async function shellHandleSharedCalendarAdd(chartId) {
  const existing = sharedCalLoadInfo(chartId);
  if (existing && existing.calendarId) {
    shellShowInfo("해당 차트가 이미 존재합니다!");
    return;
  }

  try {
    const data = await shareFetch("getSharedChartData", { chartId });
    const calendarId = await calCreateCalendar(data.name + " - 간트차트");

    const eventMap = {};
    for (const t of data.tasks || []) {
      try {
        eventMap[t.id] = await calCreateEvent(calendarId, t);
      } catch (error) {
        console.error(error);
      }
    }

    sharedCalSaveInfo(chartId, { calendarId, eventMap });
    showToast("캘린더에 추가했습니다.");
  } catch (error) {
    showToast(error.message || "추가하지 못했습니다.", true, 0);
  }
}

async function shellHandleSharedCalendarRemove(chartId) {
  const existing = sharedCalLoadInfo(chartId);
  if (!existing || !existing.calendarId) {
    shellShowInfo("해당 차트가 존재하지 않습니다!");
    return;
  }

  const chart = shellChartsCache.find((c) => c.shared && c.chartId === chartId);
  pendingCalDeleteChartId = ""; // 개인 차트 쪽 대기값과 섞이지 않게 비워둔다
  pendingSharedCalDeleteChartId = chartId;
  const box = document.getElementById("mcCalConfirmMessage");
  if (box) box.textContent = "정말 \"" + (chart ? chart.name : "") + "\" 차트를 캘린더에서 삭제하시겠습니까?";
  shellOpenModal("mcCalConfirmModal");
}

let pendingSharedCalDeleteChartId = "";

async function shellHandleSharedExportCsv(chartId, box) {
  try {
    const data = await shareFetch("getSharedChartData", { chartId });

    const headers = ["작업명", "카테고리", "시작일", "종료일", "진행률(%)", "메모", "대상처", "담당자"];
    const rows = [headers.map(csvEscape).join(",")];
    (data.tasks || []).forEach((t) => {
      rows.push([
        csvEscape(t.name), csvEscape(t.catName), csvEscape(t.start), csvEscape(t.end),
        csvEscape(t.progress), csvEscape(t.memo), csvEscape(t.target), csvEscape(t.owner)
      ].join(","));
    });
    const csv = "﻿" + rows.join("\r\n");

    const name = (box && box.querySelector(".mc-chart-box-name") && box.querySelector(".mc-chart-box-name").textContent) || "공유차트";
    downloadTextFile(name + ".csv", csv, "text/csv;charset=utf-8");
  } catch (error) {
    showToast(error.message || "내보내지 못했습니다.", true, 0);
  }
}

/* mcCalConfirmDeleteBtn은 개인 차트 캘린더 삭제에도 쓰이는 버튼이라,
   공유 차트 삭제 요청인지(pendingSharedCalDeleteChartId) 먼저 확인하고
   처리한 뒤, 아니면 기존 개인 차트 로직(initShell 안의 원래 리스너)이
   그대로 처리하게 둔다 — 두 리스너가 같은 버튼에 같이 붙어서 순서대로 실행됨. */
function initSharedCalendarUi() {
  const btn = document.getElementById("mcCalConfirmDeleteBtn");
  if (!btn) return;

  btn.addEventListener("click", () => withBusy(btn, "삭제 중…", async () => {
    const chartId = pendingSharedCalDeleteChartId;
    if (!chartId) return; // 개인 차트 쪽 요청이면 여기서는 아무것도 안 함

    pendingSharedCalDeleteChartId = "";
    shellCloseModal("mcCalConfirmModal");

    const info = sharedCalLoadInfo(chartId);
    if (info && info.calendarId) {
      try {
        await calDeleteCalendar(info.calendarId);
      } catch (error) {
        /* (버그 수정, 문제 1) 개인 차트 쪽과 같은 이유로, 404(이미 없음)가
           아닌 실제 실패는 그대로 알려주고 로컬 정보도 지우지 않아서
           다시 시도할 수 있게 한다. */
        if (error.status !== 404) {
          console.error(error);
          showToast(error.message || "캘린더에서 삭제하지 못했습니다.", true, 0);
          return;
        }
        console.error(error);
      }
    }
    sharedCalClearInfo(chartId);
    showToast("캘린더에서 삭제했습니다.");
    shellRefreshCalButtons();
  }));
}

/* =========================================================
 * 공유 차트 뷰어(읽기 전용) 화면 처리
 * ========================================================= */

async function initSharedViewerReadonly() {
  /* (성능 개선) 역할 판단은 이제 sharedLoadChart()가 getSharedChartData
     응답의 myRole로 바로 처리한다(아래 loadData() 호출 때 같이 됨). 이
     함수는 기존에 initShell 쪽에서 부르던 호출 지점과의 호환을 위해
     남겨두되, 더 이상 별도의 서버 왕복을 만들지 않는다. */
  return;
}
/* ▲▲▲ 공유 차트 캘린더/CSV + 뷰어 읽기전용 (추가분) 끝 ▲▲▲ */


/* =========================================================
 * (요청사항) 메모 편집기 + 메모 보드
 *  - 작업 메모란이 곧 스티커 메모. 서식은 간단한 표기로 memo 글자에 그대로 저장한다
 *      # 제목 · - 목록 · 1. 번호 · - [ ] / - [x] 체크 · --- 구분선
 *      **굵게** · *기울임* · ++밑줄++ · ~~취소선~~ · {c:red}글자색{/c} · ==형광펜== · {m:green}형광펜{/m} · [글](https://…)
 *    예전 메모(그냥 글자)는 그대로 보인다
 *  - 상세창 메모란과 사이드바 "메모 보드" 모두 이 편집기. 입력을 멈추면 자동 저장
 * ========================================================= */
const MEMO_COLORS = { red: "#dc2626", orange: "#ea580c", green: "#16a34a", blue: "#2563eb", gray: "#71717a" };
const MEMO_MARKS = { yellow: "#fde68a", green: "#bbf7d0", pink: "#fbcfe8", blue: "#bfdbfe" };
const MEMO_SAVE_DELAY = 1000;

function memoSafeUrl(url) {
  const u = String(url || "").trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : "";
}

function memoInlineToHtml(text) {
  /* 링크는 먼저 떼어 두고(주소에 특수문자가 있어도 안전하게) 나머지를 이스케이프 */
  const links = [];
  let s = String(text || "").replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const safe = memoSafeUrl(url);
    if (!safe) return m;
    links.push('<a href="' + escapeAttr(safe) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + "</a>");
    return "\u0000" + (links.length - 1) + "\u0000";
  });
  s = escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\*([^*\n]+?)\*/g, "<i>$1</i>")
    .replace(/\+\+(.+?)\+\+/g, "<u>$1</u>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/==(.+?)==/g, '<mark data-m="yellow" style="background:' + MEMO_MARKS.yellow + '">$1</mark>')
    .replace(/\{c:(\w+)\}(.*?)\{\/c\}/g, (m, k, t) => MEMO_COLORS[k] ? '<span data-c="' + k + '" style="color:' + MEMO_COLORS[k] + '">' + t + "</span>" : t)
    .replace(/\{m:(\w+)\}(.*?)\{\/m\}/g, (m, k, t) => MEMO_MARKS[k] ? '<mark data-m="' + k + '" style="background:' + MEMO_MARKS[k] + '">' + t + "</mark>" : t);
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => links[Number(i)] || "");
}

function memoMdToHtml(md) {
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  const line = (html) => html || "<br>";
  String(md || "").replace(/\r\n?/g, "\n").split("\n").forEach((raw) => {
    let m;
    if ((m = /^- \[( |x|X)\] ?(.*)$/.exec(raw))) {
      closeList();
      out.push('<div class="memo-ck' + (m[1] === " " ? "" : " on") + '">' + line(memoInlineToHtml(m[2])) + "</div>");
    } else if ((m = /^[-*] (.*)$/.exec(raw)) || (m = /^\d+[.)] (.*)$/.exec(raw))) {
      const tag = /^\d/.test(raw) ? "ol" : "ul";
      if (list !== tag) { closeList(); out.push("<" + tag + ">"); list = tag; }
      out.push("<li>" + line(memoInlineToHtml(m[1])) + "</li>");
    } else {
      closeList();
      if ((m = /^#{1,3} (.*)$/.exec(raw))) out.push("<h3>" + line(memoInlineToHtml(m[1])) + "</h3>");
      else if (/^-{3,}$/.test(raw.trim())) out.push("<hr>");
      else out.push("<div>" + line(memoInlineToHtml(raw)) + "</div>");
    }
  });
  closeList();
  return out.join("");
}

/* 검색 · 구글 캘린더 설명 등에 쓰는 표기 없는 글자 */
function memoPlainText(md) {
  return String(md || "")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/\{\/?[cm](:\w+)?\}/g, "")
    .replace(/\*\*|\+\+|~~|==/g, "")
    .replace(/^#{1,3} /gm, "")
    .replace(/^- \[( |x|X)\] /gm, (m, x) => (x === " " ? "[ ] " : "[v] "));
}

function memoColorKey(map, value) {
  const v = String(value || "").replace(/\s/g, "").toLowerCase();
  if (!v || v === "transparent" || v === "rgba(0,0,0,0)") return "";
  return Object.keys(map).find((key) => {
    const hex = map[key];
    const rgb = "rgb(" + [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",") + ")";
    return v === hex || v === rgb;
  }) || "";
}

function memoInlineMd(node) {
  let s = "";
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { s += n.nodeValue.replace(/ /g, " ").replace(/\n/g, " "); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName;
    if (tag === "BR") { s += "\n"; return; }
    let inner = memoInlineMd(n);
    if (!inner.trim()) { s += inner; return; }
    const st = n.style || {};
    const deco = String(st.textDecorationLine || st.textDecoration || "");
    if (tag === "A") {
      const url = memoSafeUrl(n.getAttribute("href"));
      s += url ? "[" + inner + "](" + url + ")" : inner;
      return;
    }
    if (tag === "B" || tag === "STRONG" || /bold|[6-9]00/.test(st.fontWeight)) inner = "**" + inner + "**";
    if (tag === "I" || tag === "EM" || st.fontStyle === "italic") inner = "*" + inner + "*";
    if (tag === "U" || /underline/.test(deco)) inner = "++" + inner + "++";
    if (tag === "S" || tag === "STRIKE" || tag === "DEL" || /line-through/.test(deco)) inner = "~~" + inner + "~~";
    const color = (n.dataset && n.dataset.c) || memoColorKey(MEMO_COLORS, st.color || n.getAttribute("color"));
    if (MEMO_COLORS[color]) inner = "{c:" + color + "}" + inner + "{/c}";
    const mark = (n.dataset && n.dataset.m) || memoColorKey(MEMO_MARKS, st.backgroundColor);
    if (MEMO_MARKS[mark]) inner = mark === "yellow" ? "==" + inner + "==" : "{m:" + mark + "}" + inner + "{/m}";
    s += inner;
  });
  return s;
}

function memoHtmlToMd(root) {
  const lines = [];
  const textOf = (el) => memoInlineMd(el).replace(/\n$/, "");
  const blockTags = /^(DIV|P|H[1-6]|UL|OL|LI|HR|BLOCKQUOTE|PRE)$/;
  const walk = (parent) => {
    let loose = null; // 블록 밖에 바로 있는 글자 · 굵게 등은 한 줄로 모은다
    const flush = () => {
      if (loose) { textOf(loose).split("\n").forEach((l) => lines.push(l)); loose = null; }
    };
    Array.from(parent.childNodes).forEach((n) => {
      if (n.nodeType === 1 && blockTags.test(n.tagName)) {
        flush();
        const tag = n.tagName;
        if (tag === "HR") lines.push("---");
        else if (/^H[1-6]$/.test(tag)) lines.push("# " + textOf(n).replace(/\n/g, " "));
        else if (tag === "UL" || tag === "OL") {
          let i = 1;
          n.querySelectorAll("li").forEach((li) => {
            const own = li.cloneNode(true);
            own.querySelectorAll("ul,ol").forEach((sub) => sub.remove());
            lines.push((tag === "OL" ? i++ + ". " : "- ") + textOf(own).replace(/\n/g, " "));
          });
        } else if (n.classList.contains("memo-ck")) {
          lines.push("- [" + (n.classList.contains("on") ? "x" : " ") + "] " + textOf(n).replace(/\n/g, " "));
        } else if (Array.from(n.children).some((c) => blockTags.test(c.tagName))) {
          walk(n);
        } else {
          textOf(n).split("\n").forEach((l) => lines.push(l));
        }
      } else {
        if (!loose) loose = document.createElement("div");
        loose.appendChild(n.cloneNode(true));
      }
    });
    flush();
  };
  walk(root);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

const MEMO_ICON = {
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M14 5h-4M14 19h-4M14 5l-4 14"/>',
  underline: '<path d="M7 5v6a5 5 0 0 0 10 0V5M5 20h14"/>',
  strike: '<path d="M5 12h14M16 7.5C15.4 6 14 5 12 5c-2.5 0-4 1.3-4 3 0 1.4 1 2.3 2.6 3M8 16.5c.6 1.5 2 2.5 4 2.5 2.5 0 4-1.3 4-3 0-.6-.2-1.2-.5-1.6"/>',
  head: '<path d="M6 5v14M18 5v14M6 12h12"/>',
  ul: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
  ol: '<path d="M10 6h10M10 12h10M10 18h10M4 5h1.5v4M4 9h3M4 14.5c0-.8.7-1.5 1.5-1.5S7 13.7 7 14.5c0 1.5-3 2-3 4h3"/>',
  ck: '<rect x="3.5" y="4.5" width="6" height="6" rx="1.5"/><path d="m4.8 7.6 1.4 1.4 2.3-2.6M13 7.5h7.5M13 16.5h7.5"/><rect x="3.5" y="13.5" width="6" height="6" rx="1.5"/>',
  color: '<path d="M5 19 12 4l7 15M8 13h8"/>',
  mark: '<path d="m14 5 5 5-8 8H6v-5z"/><path d="M4 21h16"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  hr: '<path d="M4 12h16"/>',
  date: '<rect x="3.5" y="4.5" width="17" height="16" rx="3"/><path d="M3.5 9.5h17M8 3v3M16 3v3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  note: '<path d="M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v9l-6 6H5a1 1 0 0 1-1-1z"/><path d="M14 20v-5a1 1 0 0 1 1-1h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'
};

function memoIcon(name, size = 16) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MEMO_ICON[name] + "</svg>";
}

/* 편집기 하나 만들기: { el, body, getMd, setStatus } — onChange(md) 는 입력할 때마다 */
function memoCreateEditor({ md = "", readonly = false, onChange = null, compact = false, placeholder = "메모를 적어 보세요" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "memo-ed" + (compact ? " memo-ed-compact" : "") + (readonly ? " is-readonly" : "");
  const btn = (cmd, icon, title) => '<button type="button" class="memo-tb" data-cmd="' + cmd + '" title="' + title + '" aria-label="' + title + '">' + memoIcon(icon) + "</button>";
  const sep = '<i class="memo-sep"></i>';
  const tools = compact
    ? [btn("bold", "bold", "굵게 (Ctrl+B)"), btn("italic", "italic", "기울임 (Ctrl+I)"), btn("underline", "underline", "밑줄 (Ctrl+U)"), btn("strike", "strike", "취소선"), sep,
      btn("head", "head", "제목"), btn("ul", "ul", "글머리 목록"), btn("ck", "ck", "체크리스트"), sep,
      btn("color", "color", "글자색"), btn("mark", "mark", "형광펜"), btn("link", "link", "링크"), sep, btn("undo", "undo", "되돌리기")]
    : [btn("bold", "bold", "굵게 (Ctrl+B)"), btn("italic", "italic", "기울임 (Ctrl+I)"), btn("underline", "underline", "밑줄 (Ctrl+U)"), btn("strike", "strike", "취소선"), sep,
      btn("head", "head", "제목"), btn("ul", "ul", "글머리 목록"), btn("ol", "ol", "번호 목록"), btn("ck", "ck", "체크리스트"), sep,
      btn("color", "color", "글자색"), btn("mark", "mark", "형광펜"), sep,
      btn("link", "link", "링크"), btn("hr", "hr", "구분선"), '<button type="button" class="memo-tb memo-tb-text" data-cmd="date" title="오늘 날짜 넣기">' + memoIcon("date", 15) + "오늘</button>", sep,
      btn("undo", "undo", "되돌리기"), btn("redo", "redo", "다시 하기")];
  wrap.innerHTML = (readonly ? "" : '<div class="memo-bar">' + tools.join("") + '<span class="memo-status"></span></div>') +
    '<div class="memo-body"' + (readonly ? "" : ' contenteditable="true"') + ' data-placeholder="' + escapeAttr(placeholder) + '" spellcheck="false"></div>';
  const body = wrap.querySelector(".memo-body");
  body.innerHTML = memoMdToHtml(md);
  const status = wrap.querySelector(".memo-status");

  const refreshEmpty = () => body.classList.toggle("is-empty", !body.textContent.trim() && !body.querySelector("hr,li,.memo-ck"));
  const changed = () => {
    refreshEmpty();
    if (onChange) onChange(memoHtmlToMd(body));
  };
  refreshEmpty();

  /* 지금 커서가 있는 줄(편집기 바로 아래 블록) */
  const currentBlock = () => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let n = sel.anchorNode;
    if (!n || !body.contains(n)) return null;
    while (n && n.parentNode !== body) n = n.parentNode;
    return n;
  };
  const placeCaret = (el, atEnd = false) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(!atEnd);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  /* 블록 밖 맨 글자는 div 로 감싸서 줄 단위로 다루기 쉽게 */
  const wrapLoose = () => {
    let block = currentBlock();
    if (block && block.nodeType === 3) {
      const div = document.createElement("div");
      body.insertBefore(div, block);
      div.appendChild(block);
      placeCaret(div, true);
      block = div;
    }
    return block;
  };
  const exec = (cmd, value = null, css = false) => {
    try { document.execCommand("styleWithCSS", false, css); } catch (error) { /* 무시 */ }
    document.execCommand(cmd, false, value);
  };
  const toggleCheck = () => {
    let block = wrapLoose();
    if (!block) return;
    if (block.tagName === "UL" || block.tagName === "OL") {
      exec(block.tagName === "UL" ? "insertUnorderedList" : "insertOrderedList");
      block = wrapLoose();
      if (!block) return;
    }
    if (block.nodeType !== 1) return;
    if (block.classList.contains("memo-ck")) {
      block.classList.remove("memo-ck", "on");
    } else {
      if (block.tagName !== "DIV") {
        const div = document.createElement("div");
        div.innerHTML = block.innerHTML || "<br>";
        block.replaceWith(div);
        block = div;
        placeCaret(div, true);
      }
      block.classList.add("memo-ck");
    }
  };

  let popover = null;
  const closePopover = () => { if (popover) { popover.remove(); popover = null; } };
  const openSwatches = (button, kind) => {
    const wasOpen = popover && popover.dataset.kind === kind;
    closePopover();
    if (wasOpen) return;
    const map = kind === "color" ? MEMO_COLORS : MEMO_MARKS;
    popover = document.createElement("div");
    popover.className = "memo-pop";
    popover.dataset.kind = kind;
    popover.innerHTML = Object.keys(map).map((key) =>
      '<button type="button" class="memo-sw' + (kind === "mark" ? " is-mark" : "") + '" data-sw="' + key + '" style="--sw:' + map[key] + '" title="' + key + '"></button>').join("") +
      '<button type="button" class="memo-sw memo-sw-none" data-sw="" title="없애기">' + memoIcon("x", 12) + "</button>";
    wrap.appendChild(popover);
    const b = button.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    popover.style.left = b.left - w.left + "px";
    popover.style.top = b.bottom - w.top + 4 + "px";
    popover.addEventListener("mousedown", (event) => event.preventDefault());
    popover.addEventListener("click", (event) => {
      const sw = event.target.closest("[data-sw]");
      if (!sw) return;
      const key = sw.dataset.sw;
      if (kind === "color") exec("foreColor", key ? MEMO_COLORS[key] : "#27272a", true);
      else exec("hiliteColor", key ? MEMO_MARKS[key] : "transparent", true);
      closePopover();
      changed();
    });
  };

  const run = (cmd, button) => {
    body.focus();
    if (cmd === "bold" || cmd === "italic" || cmd === "underline") exec(cmd);
    else if (cmd === "strike") exec("strikeThrough");
    else if (cmd === "head") {
      const block = wrapLoose();
      exec("formatBlock", block && block.tagName === "H3" ? "div" : "h3");
    } else if (cmd === "ul") exec("insertUnorderedList");
    else if (cmd === "ol") exec("insertOrderedList");
    else if (cmd === "ck") toggleCheck();
    else if (cmd === "color" || cmd === "mark") { openSwatches(button, cmd); return; }
    else if (cmd === "link") {
      const url = memoSafeUrl(prompt("링크 주소 (https://…)", "https://"));
      if (!url) return;
      const sel = window.getSelection();
      if (sel && sel.isCollapsed) exec("insertHTML", '<a href="' + escapeAttr(url) + '">' + escapeHtml(url) + "</a>");
      else exec("createLink", url);
    } else if (cmd === "hr") exec("insertHorizontalRule");
    else if (cmd === "date") {
      const d = new Date();
      exec("insertText", (d.getMonth() + 1) + "/" + d.getDate() + " ");
    } else if (cmd === "undo" || cmd === "redo") exec(cmd);
    closePopover();
    changed();
  };

  if (!readonly) {
    const bar = wrap.querySelector(".memo-bar");
    bar.addEventListener("mousedown", (event) => { if (event.target.closest(".memo-tb")) event.preventDefault(); });
    bar.addEventListener("click", (event) => {
      const button = event.target.closest(".memo-tb");
      if (button) run(button.dataset.cmd, button);
    });
    body.addEventListener("input", (event) => {
      /* 빠른 입력: 줄 맨 앞에 "- " · "1. " · "[] " · "# " 를 치면 목록 · 체크 · 제목으로 */
      if (event.inputType === "insertText" && event.data === " ") {
        const block = currentBlock();
        const text = block ? block.textContent.replace(/ /g, " ") : "";
        const shortcut = { "- ": "ul", "* ": "ul", "1. ": "ol", "[] ": "ck", "[ ] ": "ck", "# ": "head" }[text];
        if (shortcut && block && (block.nodeType === 3 || (block.tagName === "DIV" && !block.classList.contains("memo-ck")))) {
          let target = block;
          if (block.nodeType === 3) { target = document.createElement("div"); body.replaceChild(target, block); }
          target.innerHTML = "<br>";
          placeCaret(target);
          run(shortcut);
          return;
        }
      }
      /* 체크 줄에서 Enter 로 만든 새 줄은 체크 안 된 상태로 */
      if (event.inputType === "insertParagraph") {
        const block = currentBlock();
        if (block && block.nodeType === 1 && block.classList.contains("memo-ck")) block.classList.remove("on");
      }
      changed();
    });
    body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        const block = currentBlock();
        /* 빈 체크 줄에서 Enter 면 체크 목록에서 나온다 */
        if (block && block.nodeType === 1 && block.classList.contains("memo-ck") && !block.textContent.trim()) {
          event.preventDefault();
          block.classList.remove("memo-ck", "on");
          changed();
        }
      }
      if (event.key === "Backspace") {
        const block = currentBlock();
        const sel = window.getSelection();
        if (block && block.nodeType === 1 && block.classList.contains("memo-ck") && sel.isCollapsed && sel.anchorOffset === 0 &&
          (sel.anchorNode === block || sel.anchorNode === block.firstChild)) {
          event.preventDefault();
          block.classList.remove("memo-ck", "on");
          changed();
        }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault(); // 브라우저 "페이지 저장" 대신 아무것도 안 함(자동 저장)
      }
    });
    /* 붙여넣기는 글자만 — 다른 곳의 서식 · 스크립트가 섞이지 않게 */
    body.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = (event.clipboardData || window.clipboardData).getData("text/plain");
      exec("insertText", text);
    });
    body.addEventListener("click", (event) => {
      const link = event.target.closest("a");
      if (link && (event.ctrlKey || event.metaKey)) window.open(link.href, "_blank", "noopener");
    });
    document.addEventListener("mousedown", (event) => {
      if (popover && !popover.contains(event.target) && !event.target.closest(".memo-tb")) closePopover();
    });
  }

  /* 체크 상자 누르기(왼쪽 상자 부분) — 보기 전용이면 안 바뀜 */
  body.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".memo-ck");
    if (!item || !body.contains(item)) return;
    if (event.clientX - item.getBoundingClientRect().left > 24) return;
    event.preventDefault();
    if (readonly) return;
    item.classList.toggle("on");
    changed();
  });

  return {
    el: wrap,
    body,
    getMd: () => memoHtmlToMd(body),
    setMd: (value) => { body.innerHTML = memoMdToHtml(value); refreshEmpty(); },
    setStatus: (text, kind = "") => {
      if (!status) return;
      status.textContent = text;
      status.className = "memo-status" + (kind ? " is-" + kind : "");
    }
  };
}

/* 자동 저장 묶음: 입력을 멈추고 MEMO_SAVE_DELAY 뒤 save(md) — flush() 로 바로 저장 */
function memoAutosaver(initialMd, save, onState) {
  let saved = String(initialMd || "");
  let pending = null;
  let timer = null;
  const run = async () => {
    timer = null;
    const md = pending;
    pending = null;
    if (md === null || md === saved) return;
    if (md.length > LIMITS.memo) { onState("over", md.length); return; }
    onState("saving", md.length);
    try {
      await save(md);
      saved = md;
      onState("saved", md.length);
    } catch (error) {
      onState("error", md.length, error);
    }
  };
  return {
    change(md) {
      pending = md;
      onState(md.length > LIMITS.memo ? "over" : "typing", md.length);
      clearTimeout(timer);
      timer = setTimeout(run, MEMO_SAVE_DELAY);
    },
    flush() {
      if (timer) { clearTimeout(timer); return run(); }
      return Promise.resolve();
    },
    cancel() {
      clearTimeout(timer);
      timer = null;
      pending = null;
    }
  };
}

function memoStateText(state, length) {
  const count = length.toLocaleString() + " / " + LIMITS.memo.toLocaleString();
  if (state === "over") return [LIMITS.memo.toLocaleString() + "자를 넘어서 저장하지 않았어요", "error"];
  if (state === "saving") return ["저장 중…", ""];
  if (state === "saved") return ["저장됨 · " + count, "ok"];
  if (state === "error") return ["저장 실패 — 다시 입력하면 다시 저장해요", "error"];
  return [count, ""];
}

/* 상세창 메모란 (카드 안 차트): 같은 편집기 + 자동 저장 */
function mountDetailMemo(task) {
  const host = document.getElementById("detailMemoEditor");
  const field = document.getElementById("detailMemo");
  if (!host || !field) return;
  const readonly = !canEditChartHere();
  let editor = null;
  const saver = memoAutosaver(task.memo || "", (md) => apiPost("update", { data: { id: task.id, memo: md } }), (state, length) => {
    const [text, kind] = memoStateText(state, length);
    if (editor) editor.setStatus(text, kind);
  });
  editor = memoCreateEditor({
    md: task.memo || "",
    readonly,
    compact: true,
    placeholder: readonly ? "메모 없음" : "메모 추가… (자동 저장)",
    onChange: (md) => {
      field.value = md; // 상세창 [저장]도 같은 값을 보낸다
      saver.change(md);
    }
  });
  host.replaceChildren(editor.el);
}

/* ---------- 사이드바 "메모 보드" (셸) ---------- */
const memoBoard = { mine: true, query: "", data: {}, unsubs: [], timer: null, pop: null, selected: new Set() };

function memoPastel(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
  const n = parseInt(m ? m[1] : "3b82f6", 16);
  return "rgb(" + [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k))).join(",") + ")";
}

function memoTaskColor(task, cats) {
  const cat = (cats || []).find((c) => c.id === task.categoryId);
  return validColorStr(task.color) || (cat && validColorStr(cat.color)) || DEFAULT_COLOR;
}

function memoDueText(task) {
  if (normProgress(task.progress) >= 100) return { text: "완료", late: false };
  if (!task.end) return { text: "", late: false };
  const left = daysBetweenKeys(dateKey(new Date()), task.end);
  if (left === null) return { text: "", late: false };
  return { text: left < 0 ? "D+" + (-left) : left === 0 ? "D-day" : "D-" + left, late: left < 0 };
}

function memoShortDate(key) {
  const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(key || ""));
  return m ? m[1] + "." + m[2] : "";
}

function memoBoardCharts() {
  return (shellChartsCache || []).slice().sort((a, b) => (a.shared === b.shared ? (a.order || 0) - (b.order || 0) : a.shared ? 1 : -1));
}

function memoBoardStop() {
  memoBoard.unsubs.forEach((stop) => { try { stop(); } catch (error) { /* 무시 */ } });
  memoBoard.unsubs = [];
}

function memoBoardSchedule() {
  clearTimeout(memoBoard.timer);
  memoBoard.timer = setTimeout(memoBoardRender, 120);
}

function shellOpenMemoBoard() {
  if (!fbUser) {
    showToast("먼저 Google 로그인을 해주세요.", true);
    return;
  }
  shellOpenModal("mcMemoModal");
  memoBoardStop();
  memoBoard.data = {};
  memoBoardRender();
  /* 열어 둔 동안 실시간 반영: 차트에서 메모를 저장하면 바로 보드에 */
  memoBoardCharts().forEach((chart) => {
    const entry = { tasks: null, cats: [] };
    memoBoard.data[chart.id] = entry;
    if (typeof fb.listenTasks !== "function") return;
    memoBoard.unsubs.push(fb.listenTasks(chart.id, (tasks) => { entry.tasks = tasks; memoBoardSchedule(); }, () => { entry.tasks = []; memoBoardSchedule(); }));
    memoBoard.unsubs.push(fb.listenCategories(chart.id, (cats) => { entry.cats = cats; memoBoardSchedule(); }, () => {}));
  });
}

function shellCloseMemoBoard() {
  memoClosePop();
  memoBoard.selected.clear();
  memoBoardStop();
  shellCloseModal("mcMemoModal");
}

function memoBoardTasks(chartId) {
  const entry = memoBoard.data[chartId];
  return (entry && entry.tasks) || [];
}

function memoBoardRender() {
  const board = document.getElementById("mcMemoBoard");
  if (!board) return;
  const q = memoBoard.query.trim().toLowerCase();
  let total = 0;
  let loading = false;
  const html = memoBoardCharts().map((chart) => {
    const entry = memoBoard.data[chart.id];
    if (!entry || entry.tasks === null) { loading = true; return ""; }
    const cats = (entry.cats || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    const catIds = new Set(cats.map((c) => c.id));
    const tasks = entry.tasks.filter((t) => String(t.memo || "").trim() &&
      (!memoBoard.mine || isMyTask(t)) &&
      (!q || (String(t.name || "") + " " + memoPlainText(t.memo)).toLowerCase().includes(q)));
    if (!tasks.length) return "";
    total += tasks.length;
    const groups = cats.map((c) => ({ id: c.id, name: c.name || "카테고리", color: c.color })).concat([{ id: "", name: "기타", color: "#a1a1aa" }]);
    const sections = groups.map((g) => {
      const list = tasks.filter((t) => (catIds.has(t.categoryId) ? t.categoryId : "") === g.id)
        .sort((a, b) => String(a.start || "9999").localeCompare(String(b.start || "9999")) || String(a.name || "").localeCompare(String(b.name || "")));
      if (!list.length) return "";
      return '<div class="mc-memo-cat"><em style="background:' + escapeAttr(validColorStr(g.color) || "#a1a1aa") + '"></em>' + escapeHtml(g.name) + "<small>" + list.length + "</small></div>" +
        '<div class="mc-memo-row">' + list.map((t) => memoNoteHtml(chart, t, cats)).join("") + "</div>";
    }).join("");
    return '<section class="mc-memo-chart"><h3>' + escapeHtml(chart.name || "이름 없는 차트") + "<i>" + tasks.length + "</i></h3>" + sections + "</section>";
  }).join("");
  const count = document.getElementById("mcMemoCount");
  if (count) count.textContent = "메모 " + total + "개";
  memoSelectionBar();
  board.innerHTML = html || '<div class="mc-memo-empty">' + memoIcon("note", 30) + "<b>" + (loading ? "불러오는 중…" : q ? "찾는 메모가 없어요" : memoBoard.mine ? "내가 담당인 작업에 메모가 없어요" : "메모가 있는 작업이 없어요") + "</b>" +
    (loading || q ? "" : "<span>작업 상세창 메모란이나 오른쪽 위 + 로 메모를 써 보세요</span>") + "</div>";
}

function memoNoteHtml(chart, task, cats) {
  const color = memoTaskColor(task, cats);
  const due = memoDueText(task);
  const selected = memoBoard.selected.has(chart.id + "/" + task.id);
  return '<button type="button" class="mc-memo-note' + (selected ? " is-selected" : "") + '" data-chart="' + escapeAttr(chart.id) + '" data-task="' + escapeAttr(task.id) + '" aria-pressed="' + selected + '" style="--paper:' + memoPastel(color, 0.8) + ";--ink:" + memoPastel(color, -0.5) + '">' +
    '<span class="mc-memo-note-check" aria-hidden="true">' + memoIcon("check", 13) + "</span>" +
    "<b>" + escapeHtml(task.name || "이름 없는 작업") + "</b>" +
    '<span class="mc-memo-note-body">' + memoMdToHtml(task.memo) + "</span>" +
    '<span class="mc-memo-note-foot"><span>' + (task.start ? "시작 " + memoShortDate(task.start) : "") + "</span>" +
    '<span class="' + (due.late ? "is-late" : "") + '">' + due.text + "</span></span></button>";
}

function memoClosePop() {
  const pop = memoBoard.pop;
  if (!pop) return Promise.resolve();
  memoBoard.pop = null;
  const done = pop.saver ? pop.saver.flush() : Promise.resolve();
  pop.el.remove();
  return done;
}

/* 포스트잇을 누르면 크게 펼쳐서 편집 */
function memoOpenEditor(chartId, taskId) {
  memoClosePop();
  const chart = (shellChartsCache || []).find((c) => c.id === chartId);
  const entry = memoBoard.data[chartId];
  const task = memoBoardTasks(chartId).find((t) => t.id === taskId);
  if (!chart || !task) return;
  const cats = (entry && entry.cats) || [];
  const cat = cats.find((c) => c.id === task.categoryId);
  const color = memoTaskColor(task, cats);
  const due = memoDueText(task);
  const readonly = !shellCanEdit(chart);
  const modal = document.querySelector("#mcMemoModal .mc-memo-modal");

  const el = document.createElement("div");
  el.className = "mc-memo-pop-dim";
  el.innerHTML = '<div class="mc-memo-pop" role="dialog" aria-label="메모 편집" style="--paper:' + memoPastel(color, 0.82) + ";--ink:" + memoPastel(color, -0.55) + '">' +
    '<div class="mc-memo-pop-head"><div class="mc-memo-pop-title"><h4>' + escapeHtml(task.name || "이름 없는 작업") +
      (due.text ? ' <span class="mc-memo-due' + (due.late ? " is-late" : "") + '">' + due.text + "</span>" : "") + "</h4>" +
      "<p>" + [chart.name, cat ? cat.name : "기타", task.start && task.end ? memoShortDate(task.start) + " – " + memoShortDate(task.end) : "", task.owner].filter(Boolean).map(escapeHtml).join(" · ") + "</p></div>" +
      '<button type="button" class="mc-memo-pop-btn" data-act="open">' + memoIcon("open", 15) + "작업 열기</button>" +
      '<button type="button" class="mc-memo-pop-btn mc-memo-pop-x" data-act="close" aria-label="닫기">' + memoIcon("x", 16) + "</button></div>" +
    '<div class="mc-memo-pop-ed"></div>' +
    /* (요청사항) 자동 저장이라 안내 글씨는 빼고, 저장이 안 될 때만 알린다 */
    '<div class="mc-memo-pop-foot">' +
      (readonly ? '<span class="mc-memo-pop-state">보기 전용</span>' : '<button type="button" class="mc-memo-pop-btn mc-memo-pop-del" data-act="delete">' + memoIcon("trash", 15) + "삭제</button>") +
      '<span class="mc-memo-pop-state" data-state></span>' +
      '<button type="button" class="mc-memo-pop-btn" data-act="close">닫기</button></div></div>';
  modal.appendChild(el);
  const state = el.querySelector("[data-state]");
  const pop = { el, saver: null };
  if (!readonly) {
    pop.saver = memoAutosaver(task.memo || "", (md) => apiPostForChart("update", chartId, { data: { id: task.id, memo: md } }), (s, length) => {
      const [text, kind] = memoStateText(s, length);
      state.textContent = kind === "error" ? text : "";
      state.className = "mc-memo-pop-state" + (kind === "error" ? " is-error" : "");
    });
  }
  const editor = memoCreateEditor({ md: task.memo || "", readonly, onChange: (md) => pop.saver && pop.saver.change(md) });
  el.querySelector(".mc-memo-pop-ed").appendChild(editor.el);
  memoBoard.pop = pop;
  el.addEventListener("click", (event) => {
    const act = event.target.closest("[data-act]");
    if (event.target === el || (act && act.dataset.act === "close")) { memoClosePop(); return; }
    if (act && act.dataset.act === "delete") {
      memoDeleteMemos([{ chartId, taskId }], () => { if (pop.saver) pop.saver.cancel(); });
      return;
    }
    if (act && act.dataset.act === "open") {
      memoClosePop().finally(() => {
        shellCloseMemoBoard();
        shellOpenTaskFromNotice(chartId, taskId);
      });
    }
  });
  if (!readonly) setTimeout(() => {
    editor.body.focus();
    const range = document.createRange();
    range.selectNodeContents(editor.body);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, 30);
}

/* + 메모 쓰기: 메모 없는 작업을 골라 새로 쓰기 (편집할 수 있는 차트만) */
function memoOpenPicker() {
  memoClosePop();
  const groups = memoBoardCharts().filter(shellCanEdit).map((chart) => {
    const list = memoBoardTasks(chart.id).filter((t) => !String(t.memo || "").trim() && (!memoBoard.mine || isMyTask(t)))
      .sort((a, b) => String(a.start || "9999").localeCompare(String(b.start || "9999")));
    return list.length ? { chart, list } : null;
  }).filter(Boolean);
  const modal = document.querySelector("#mcMemoModal .mc-memo-modal");
  const el = document.createElement("div");
  el.className = "mc-memo-pop-dim";
  el.innerHTML = '<div class="mc-memo-pick" role="dialog" aria-label="메모 쓸 작업 고르기"><div class="mc-memo-pop-head"><div class="mc-memo-pop-title"><h4>어느 작업에 메모를 쓸까요?</h4><p>메모가 없는 ' + (memoBoard.mine ? "내 " : "") + "작업</p></div>" +
    '<button type="button" class="mc-memo-pop-btn mc-memo-pop-x" data-act="close" aria-label="닫기">' + memoIcon("x", 16) + "</button></div>" +
    '<div class="mc-memo-pick-list">' + (groups.length ? groups.map((g) => '<div class="mc-memo-pick-chart">' + escapeHtml(g.chart.name || "") + "</div>" +
      g.list.map((t) => {
        /* (요청사항) 작업마다 그 작업 색(포스트잇이 될 색)을 앞에 */
        const color = memoTaskColor(t, (memoBoard.data[g.chart.id] || {}).cats);
        return '<button type="button" class="mc-memo-pick-item" data-chart="' + escapeAttr(g.chart.id) + '" data-task="' + escapeAttr(t.id) + '">' +
          '<i class="mc-memo-pick-sw" style="--paper:' + memoPastel(color, 0.75) + ";--ink:" + escapeAttr(color) + '"></i><b>' + escapeHtml(t.name || "이름 없는 작업") + "</b><span>" + (t.start ? memoShortDate(t.start) + " – " + memoShortDate(t.end) : "") + "</span></button>";
      }).join("")).join("")
      : '<div class="mc-memo-empty"><b>메모를 쓸 수 있는 작업이 없어요</b></div>') + "</div></div>";
  modal.appendChild(el);
  memoBoard.pop = { el, saver: null };
  el.addEventListener("click", (event) => {
    const item = event.target.closest(".mc-memo-pick-item");
    if (item) { memoOpenEditor(item.dataset.chart, item.dataset.task); return; }
    if (event.target === el || event.target.closest('[data-act="close"]')) memoClosePop();
  });
}

/* 메모 지우기(작업은 그대로, 메모란만 비운다) — 여러 개를 한 번에 */
async function memoDeleteMemos(targets, beforeSave) {
  const list = targets.filter(({ chartId }) => {
    const chart = (shellChartsCache || []).find((c) => c.id === chartId);
    return chart && shellCanEdit(chart);
  });
  const skipped = targets.length - list.length;
  if (!list.length) {
    showToast("편집 권한이 없는 차트의 메모라 지울 수 없어요.", true);
    return;
  }
  const question = list.length === 1 ? "이 메모를 지울까요?" : "메모 " + list.length + "개를 지울까요?";
  if (!confirm(question + "\n작업은 그대로 두고 메모만 지워요." + (skipped ? "\n(편집 권한이 없는 " + skipped + "개는 빼고)" : ""))) return;
  if (beforeSave) beforeSave();
  let failed = 0;
  for (const { chartId, taskId } of list) {
    try {
      await apiPostForChart("update", chartId, { data: { id: taskId, memo: "" } });
    } catch (error) {
      failed++;
    }
  }
  if (memoBoard.pop) { memoBoard.pop.saver = null; memoClosePop(); }
  memoBoard.selected.clear();
  memoBoardRender();
  showToast(failed ? "메모 " + failed + "개를 지우지 못했어요." : "메모 " + (list.length - failed) + "개를 지웠어요.", !!failed);
}

/* 여러 개 고르기: 폰은 꾹(0.5초), 데스크탑은 1초 누르면 고르기 시작 · 고르는 중에는 눌러서 더하거나 빼기 */
function memoInitSelection(modal) {
  const board = modal.querySelector("#mcMemoBoard");
  let hold = null;
  let suppressClick = false;
  const cancelHold = () => { if (hold) { clearTimeout(hold.timer); hold = null; } };
  const toggle = (note) => {
    const key = note.dataset.chart + "/" + note.dataset.task;
    if (memoBoard.selected.has(key)) memoBoard.selected.delete(key);
    else memoBoard.selected.add(key);
    note.classList.toggle("is-selected", memoBoard.selected.has(key));
    note.setAttribute("aria-pressed", String(memoBoard.selected.has(key)));
    memoSelectionBar();
  };
  board.addEventListener("pointerdown", (event) => {
    const note = event.target.closest(".mc-memo-note");
    if (!note || (event.pointerType === "mouse" && event.button !== 0)) return;
    cancelHold();
    hold = {
      note, x: event.clientX, y: event.clientY,
      timer: setTimeout(() => {
        hold = null;
        suppressClick = true;
        toggle(note);
        if (navigator.vibrate) navigator.vibrate(15);
      }, event.pointerType === "mouse" ? 1000 : 500)
    };
  });
  board.addEventListener("pointermove", (event) => {
    if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > 8) cancelHold();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((type) => board.addEventListener(type, cancelHold));
  board.addEventListener("contextmenu", (event) => { if (event.target.closest(".mc-memo-note")) event.preventDefault(); });
  board.addEventListener("click", (event) => {
    const note = event.target.closest(".mc-memo-note");
    if (!note) return;
    if (suppressClick) { suppressClick = false; return; }
    if (memoBoard.selected.size) toggle(note);
    else memoOpenEditor(note.dataset.chart, note.dataset.task);
  });
}

function memoSelectionBar() {
  const modal = document.querySelector("#mcMemoModal .mc-memo-modal");
  if (!modal) return;
  const count = memoBoard.selected.size;
  modal.classList.toggle("is-selecting", count > 0);
  let bar = modal.querySelector(".mc-memo-selbar");
  if (!count) { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "mc-memo-selbar";
    modal.appendChild(bar);
    bar.addEventListener("click", (event) => {
      const act = event.target.closest("[data-sel]");
      if (!act) return;
      if (act.dataset.sel === "clear") {
        memoBoard.selected.clear();
        memoBoardRender();
      } else {
        memoDeleteMemos(Array.from(memoBoard.selected).map((key) => {
          const [chartId, taskId] = key.split("/");
          return { chartId, taskId };
        }));
      }
    });
  }
  /* 선택 해제 | 삭제 를 한 알약으로 */
  bar.innerHTML = '<b>' + count + "개 선택</b>" +
    '<span class="mc-memo-selpill"><button type="button" data-sel="clear">선택 해제</button>' +
    '<button type="button" class="is-del" data-sel="delete">' + memoIcon("trash", 15) + "삭제</button></span>";
}

function shellInitMemoBoard() {
  const open = document.getElementById("mcSidebarMemoBtn");
  if (open) open.addEventListener("click", shellOpenMemoBoard);
  const modal = document.getElementById("mcMemoModal");
  if (!modal) return;
  modal.querySelectorAll("[data-close]").forEach((btn) => btn.addEventListener("click", () => { memoClosePop(); memoBoardStop(); memoBoard.selected.clear(); }));
  modal.querySelector("#mcMemoScope").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-scope]");
    if (!btn) return;
    memoBoard.mine = btn.dataset.scope === "mine";
    modal.querySelectorAll("#mcMemoScope [data-scope]").forEach((b) => b.classList.toggle("on", b === btn));
    memoBoardRender();
  });
  modal.querySelector("#mcMemoSearch").addEventListener("input", (event) => {
    memoBoard.query = event.target.value;
    memoBoardRender();
  });
  modal.querySelector("#mcMemoAdd").addEventListener("click", memoOpenPicker);
  memoInitSelection(modal);
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || modal.classList.contains("hidden")) return;
    if (memoBoard.pop) memoClosePop();
    else if (memoBoard.selected.size) { memoBoard.selected.clear(); memoBoardRender(); }
    else shellCloseMemoBoard();
  });
}


/* =========================================================
 * (요청사항) 첫 화면 안내 (온보딩)
 *  - 이 사이트에 처음 로그인한 회원에게만: 환영 창 → 7단계 짚어 주는 안내
 *    (1 작업 추가 · 2 기간 · 3 공유 · 4 조직원 관리 · 5 캡처·구글 캘린더 · 6 CSV 업로드·다운로드 · 7 메일 알림)
 *  - 그 뒤 작업 수정·공유·차트 만들기·차트 관리·조직원 관리 창을 처음 열 때 그 창에서 한 번씩 안내
 *  - 모든 안내는 회색 "건너뛰기"로 바로 끌 수 있다
 *  - "봤음" 표시는 Firestore users/{uid} 에 저장(다른 기기에서도 다시 안 뜸),
 *    이 브라우저에도 같이 적어 둔다(규칙이 아직 없거나 iframe 안에서 빨리 보려고)
 *  - 이미 차트가 있거나 받은 초대가 있는 기존 회원은 처음부터 모두 "봤음"으로 둔다
 * ========================================================= */
const OB_KEYS = ["welcome", "tour", "task", "share", "newChart", "manage", "org"];
let obFlags = null;
let obShellStarted = false;

function obCacheKey() {
  return "ganttOnboarding:" + (fbUser ? fbUser.uid : "");
}

function obReadCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(obCacheKey()) || "null");
    return saved && typeof saved === "object" ? saved : null;
  } catch (error) {
    return null;
  }
}

function obWriteCache(flags) {
  try { localStorage.setItem(obCacheKey(), JSON.stringify(flags)); } catch (error) { /* 무시 */ }
}

function obFlagsNow() {
  return obFlags || obReadCache();
}

function obSeen(key) {
  const flags = obFlagsNow();
  return !flags || !!flags[key]; // 표시를 모르면(로그인 전 등) 안내하지 않는다
}

function obMark(keys) {
  if (!fbUser) return;
  /* 셸과 카드 안 차트가 각자 적으니, 이 브라우저에 적힌 최신 값과 합친다 */
  const flags = { ...(obFlags || {}), ...(obReadCache() || {}) };
  [].concat(keys).forEach((key) => { flags[key] = true; });
  obFlags = flags;
  obWriteCache(flags);
  if (typeof fb.mergeUserOnboarding === "function") {
    fb.mergeUserOnboarding(fbUser.uid, flags).catch((error) => console.warn("안내 표시 저장 실패:", error && error.message));
  }
}

function obMarkAll() {
  obMark(OB_KEYS);
}

/* 셸: 차트 목록을 처음 받은 뒤 한 번 */
async function obInitShell(inviteCount) {
  if (!fbUser || obShellStarted) return;
  obShellStarted = true;
  let flags = obReadCache();
  let remoteKnown = false;
  try {
    const profile = typeof fb.getUserProfile === "function" ? await fb.getUserProfile(fbUser.uid) : null;
    if (profile && profile.onboarding) {
      flags = { ...profile.onboarding, ...(flags || {}) };
      remoteKnown = true;
    }
  } catch (error) {
    console.warn("안내 표시를 읽지 못했습니다(이 브라우저 기록만 씁니다):", error && error.message);
  }

  if (!flags) {
    const existing = (shellChartsCache || []).length > 0 || inviteCount > 0;
    obFlags = {};
    if (existing) {
      obMarkAll();
      return;
    }
  } else {
    obFlags = flags;
    obWriteCache(flags);
    if (!remoteKnown) obMark([]); // 이 브라우저에만 있던 표시를 계정에도 올려 둔다
  }

  if (!obSeen("welcome")) obShowWelcome();
  else if (!obSeen("tour")) obStartTour();
}

const OB_ICON = {
  hand: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 11V6.5a1.5 1.5 0 0 1 3 0V11M10 10V4.5a1.5 1.5 0 0 1 3 0V10M13 10V5.5a1.5 1.5 0 0 1 3 0V11M16 11V8.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-2.7L3.5 15a1.5 1.5 0 0 1 2.5-1.6L7 15"></path></svg>',
  bars: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h8M7 12h10M10 18h8"></path></svg>',
  drag: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4"></path></svg>',
  team: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2"></circle><path d="M3 20a6 6 0 0 1 12 0"></path><path d="M16 4.5a3 3 0 0 1 0 6M21 20a5 5 0 0 0-3.5-4.8"></path></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8h.01"></path></svg>'
};

function obFirstName() {
  const name = String((fbUser && fbUser.displayName) || "").trim();
  if (!name) return String((fbUser && fbUser.email) || "").split("@")[0];
  /* 한글 세 글자 이름이면 성을 빼고 부른다 (남기현 → 기현) */
  return /^[가-힣]{3}$/.test(name) ? name.slice(1) : name;
}

function obShowWelcome() {
  if (document.getElementById("obWelcome")) return;
  const wrap = document.createElement("div");
  wrap.id = "obWelcome";
  wrap.className = "ob-dim";
  wrap.innerHTML =
    '<div class="ob-card" role="dialog" aria-modal="true" aria-labelledby="obWelcomeTitle">' +
      '<div class="ob-hero"><i style="left:58%;top:24px;width:150px"></i><i style="left:66%;top:52px;width:120px"></i>' +
        '<i style="left:60%;top:80px;width:190px"></i><i style="left:76%;top:108px;width:110px"></i>' +
        '<div class="ob-wave">' + OB_ICON.hand + "</div>" +
        '<h2 id="obWelcomeTitle">' + escapeHtml(obFirstName()) + " 님, 반가워요!</h2>" +
        "<p>긴 일정도 한눈에. 1분이면 첫 차트를 만들 수 있어요.</p></div>" +
      '<div class="ob-body"><div class="ob-steps">' +
        '<div class="ob-step"><div class="ob-step-ic">' + OB_ICON.bars + "</div><div><b>작업을 막대로 그려요</b><span>시작일·종료일만 넣으면 달력 위에 막대가 생겨요</span></div><div class=\"ob-step-n\">1</div></div>" +
        '<div class="ob-step"><div class="ob-step-ic">' + OB_ICON.drag + "</div><div><b>끌어서 기간을 바꿔요</b><span>막대 끝을 끌면 날짜가, 가운데를 끌면 일정이 옮겨져요</span></div><div class=\"ob-step-n\">2</div></div>" +
        '<div class="ob-step"><div class="ob-step-ic">' + OB_ICON.team + "</div><div><b>팀과 함께 봐요</b><span>이메일이나 조직으로 공유하면 실시간으로 같이 봐요</span></div><div class=\"ob-step-n\">3</div></div>" +
      "</div>" +
      '<div class="ob-actions"><button type="button" class="ob-btn ob-pri" data-ob="sample">예시 차트로 시작하기</button>' +
        '<button type="button" class="ob-btn ob-sec" data-ob="blank">빈 차트로 시작</button></div>' +
      '<button type="button" class="ob-skip" data-ob="skip">건너뛰기</button></div></div>';
  document.body.appendChild(wrap);

  wrap.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-ob]");
    if (!button) return;
    const kind = button.dataset.ob;
    if (kind === "skip") {
      obMark(["welcome", "tour"]);
      wrap.remove();
      return;
    }
    wrap.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    button.textContent = "만드는 중…";
    try {
      if (kind === "sample") await obCreateSampleChart();
      else if (!(shellChartsCache || []).some((c) => !c.shared)) {
        const res = await apiPost("createChart", { data: { name: "내 첫 차트" } });
        shellApplyPersonalChartsList(res.charts);
      }
    } catch (error) {
      console.error(error);
      showToast(error.message || "차트를 만들지 못했어요.", true, 0);
    }
    obMark("welcome");
    wrap.remove();
    obStartTour();
  });
}

/* 예시 차트: 오늘을 가운데 두고 지난 일·진행 중·앞으로 할 일이 섞이게 */
async function obCreateSampleChart() {
  const res = await apiPost("createChart", { data: { name: "예시 차트" } });
  const chartId = res.result && res.result.id;
  if (!chartId) throw new Error("예시 차트를 만들지 못했어요.");
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return dateKey(d);
  };
  const cats = [["기획", "#0f766e"], ["디자인", "#e11d48"], ["개발", "#2563eb"]];
  const catIds = {};
  for (const [name, color] of cats) {
    const r = await apiPostForChart("createCategory", chartId, { data: { name, color } });
    catIds[name] = r.result;
  }
  const tasks = [
    ["요구사항 정리", "기획", -40, -12, 100],
    ["일정 계획 세우기", "기획", -15, 10, 60],
    ["화면 시안 만들기", "디자인", -5, 25, 30],
    ["기능 개발", "개발", 10, 60, 0],
    ["테스트·출시", "개발", 55, 80, 0]
  ];
  for (const [name, cat, from, to, progress] of tasks) {
    await apiPostForChart("create", chartId, {
      data: { name, categoryId: catIds[cat] || "", start: day(from), end: day(to), progress }
    });
  }
  shellApplyPersonalChartsList(res.charts);
}

/* ---------- 짚어 주는 안내 (7단계) ---------- */
let obTourState = null;

function obFirstBox() {
  return document.querySelector("#mcChartList .mc-chart-box:not(.mc-chart-box-collapsed), .mc-chart-box:not(.mc-chart-box-collapsed)");
}

function obVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function obTourSteps() {
  const box = () => obFirstBox();
  const inFrame = (selector) => () => {
    const b = box();
    const iframe = b && b.querySelector("iframe");
    const doc = iframe && iframe.contentDocument;
    const el = doc && doc.querySelector(selector);
    return el ? { el, frame: iframe } : null;
  };
  const inBox = (selector) => () => {
    const b = box();
    const el = b && b.querySelector(selector);
    return el ? { el } : null;
  };
  const byId = (id) => () => {
    const el = document.getElementById(id);
    return el ? { el } : null;
  };
  return [
    { targets: [inFrame(".task-add-pill")], title: "작업 추가",
      points: ["**작업 이름**과 **기간**을 넣으면 달력에 막대가 생겨요", "**카테고리**로 작업을 묶을 수 있어요"] },
    { targets: [inBox(".mc-date-pill")], title: "보이는 기간",
      points: ["날짜를 눌러 **연도 · 기간**을 골라요", "옆 버튼으로 **오늘 전후**나 **전체**를 바로 봐요"] },
    { targets: [inBox(".mc-share-btn")], title: "팀과 공유",
      points: ["**이메일 · 조직**으로 공유해 실시간으로 함께 봐요", "**뷰어** 보기만 · **편집자** 수정 · **관리자** 공유 설정까지"] },
    { targets: [byId("mcSidebarOrgBtn")], title: "조직 관리",
      points: ["회사 · 팀 단위로 **조직**을 만들고 조직원을 초대해요", "차트를 **조직 전체**나 **고른 사람**에게 한 번에 공유해요", "조직에서 나가면 그 차트는 바로 **안 보여요**"] },
    { targets: [inBox(".mc-btn-capture"), inBox(".mc-cal-toggle")], title: "캡처 · 구글 캘린더",
      points: ["**카메라** — 차트를 이미지로 저장", "**달력** — 이 차트 전용 구글 캘린더에 작업이 일정으로 들어가요"] },
    { targets: [inBox(".mc-csv-upload"), () => {
        const b = box();
        const up = b && b.querySelector(".mc-csv-upload");
        const el = up && up.nextElementSibling;
        return el ? { el } : null;
      }], title: "엑셀(CSV) 올리기 · 받기",
      points: ["**업로드** — 엑셀 · CSV 파일의 작업을 이 차트에 추가", "**다운로드** — 작업 목록을 파일로 받기"] },
    { targets: [byId("mcBellBtn")], title: "마감 알림 · 메일",
      points: ["종 버튼에서 **마감이 다가오는 작업**을 봐요", "내 작업은 **D-15 · D-7 · D-1 · 당일 · 지연** 때 메일로", "종 안에서 **일정 메일** 주기도 정할 수 있어요"] }
  ];
}

function obStartTour() {
  if (obTourState || obSeen("tour")) return;
  let tries = 0;
  const wait = () => {
    const box = obFirstBox();
    const iframe = box && box.querySelector("iframe");
    const ready = iframe && iframe.contentDocument && iframe.contentDocument.querySelector(".task-add-pill");
    if (ready || tries > 40) {
      obRunTour(obTourSteps(), () => obMark("tour"));
      return;
    }
    tries++;
    setTimeout(wait, 250);
  };
  window.scrollTo({ top: 0 });
  wait();
}

/* (요청사항) 안내 글은 긴 문단 대신 짧은 줄 목록으로 — points 가 없으면 text 를 문장마다 나눈다.
   **굵게** 로 감싼 말만 강조 */
function obPointsHtml(item) {
  const points = item.points || String(item.text || "").split(/(?<=[요다]\.)\s+/).filter(Boolean);
  return '<ul class="ob-points">' + points.map((line) =>
    "<li>" + escapeHtml(line.replace(/\.$/, "")).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>") + "</li>").join("") + "</ul>";
}

/* 안내 틀: steps = [{ targets: [() => ({ el, frame? })], title, points | text }]
   카드 안 차트(iframe)에서 부를 때는 바깥 화면(부모)에 깔아서 화면 전체를 덮는다 */
function obHostWindow() {
  try {
    if (!IS_SHELL_MODE && window.parent !== window && window.parent.document) return window.parent;
  } catch (error) { /* 다른 출처면 자기 창 */ }
  return window;
}

function obRunTour(steps, onEnd) {
  if (obTourState) return;
  const win = obHostWindow();
  obTourState = { steps, index: 0, onEnd, win, frame: win === window ? null : window.frameElement };
  obRenderTourStep();
}

function obEndTour() {
  const tour = obTourState;
  if (!tour) return;
  obTourState = null;
  const layer = tour.win.document.getElementById("obTour");
  if (layer) layer.remove();
  tour.win.removeEventListener("resize", obRenderTourStep);
  if (tour.onEnd) tour.onEnd();
}

function obRectOf(target) {
  const r = target.el.getBoundingClientRect();
  const frame = target.frame || (obTourState && obTourState.frame);
  if (!frame) return { x: r.left, y: r.top, w: r.width, h: r.height };
  const f = frame.getBoundingClientRect();
  return { x: f.left + r.left, y: f.top + r.top, w: r.width, h: r.height };
}

/* (요청사항) 강조 상자가 겹치거나 붙어 있으면 바깥 테두리를 하나로 합친다 */
function obMergeRects(rects) {
  const out = [];
  rects.forEach((rect) => {
    let r = { ...rect };
    for (let i = 0; i < out.length; i++) {
      const o = out[i];
      const touch = r.x <= o.x + o.w + 2 && o.x <= r.x + r.w + 2 && r.y <= o.y + o.h + 2 && o.y <= r.y + r.h + 2;
      if (touch) {
        const x = Math.min(r.x, o.x);
        const y = Math.min(r.y, o.y);
        r = { x, y, w: Math.max(r.x + r.w, o.x + o.w) - x, h: Math.max(r.y + r.h, o.y + o.h) - y };
        out.splice(i, 1);
        i = -1;
      }
    }
    out.push(r);
  });
  return out;
}

function obRenderTourStep() {
  const tour = obTourState;
  if (!tour) return;
  const win = tour.win;
  const hostDoc = win.document;
  const live = (step) => step.targets.map((fn) => fn()).filter((t) => t && obVisible(t.el));
  /* 화면에 없는 단계(폰에서 숨은 사이드바, 아직 없는 조직 등)는 건너뛴다 */
  while (tour.index < tour.steps.length && !live(tour.steps[tour.index]).length) tour.index++;
  if (tour.index >= tour.steps.length) {
    obEndTour();
    return;
  }
  const step = tour.steps[tour.index];
  const targets = live(step);
  const total = tour.steps.length;

  /* 창 안에서 스크롤해야 보이는 곳이면 먼저 보이게 */
  try { targets[0].el.scrollIntoView({ block: "nearest" }); } catch (error) { /* 무시 */ }
  let first = obRectOf(targets[0]);
  if (first.y < 8 || first.y + first.h > win.innerHeight - 8) {
    win.scrollBy(0, first.y - Math.max(80, (win.innerHeight - first.h) / 2));
  }

  let layer = hostDoc.getElementById("obTour");
  if (!layer) {
    layer = hostDoc.createElement("div");
    layer.id = "obTour";
    layer.className = "ob-tour";
    hostDoc.body.appendChild(layer);
    layer.addEventListener("click", (event) => {
      const button = event.target.closest("[data-ob]");
      const current = obTourState;
      if (!button || !current) return;
      if (button.dataset.ob === "skip") { obEndTour(); return; }
      current.index++;
      if (current.index >= current.steps.length) obEndTour();
      else obRenderTourStep();
    });
    win.addEventListener("resize", obRenderTourStep);
  }

  const pad = 6;
  const rects = obMergeRects(targets.map(obRectOf).map((r) => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 })));
  const holes = rects.map((r) => '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" rx="14" fill="black"></rect>').join("");
  const rings = rects.map((r) => '<div class="ob-ring" style="left:' + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + 'px"></div>').join("");
  const dots = tour.steps.map((s, i) => '<i class="' + (i === tour.index ? "on" : "") + '"></i>').join("");
  const last = tour.index === total - 1;

  layer.innerHTML =
    '<svg class="ob-mask" width="100%" height="100%"><defs><mask id="obTourMask"><rect width="100%" height="100%" fill="white"></rect>' + holes +
    '</mask></defs><rect width="100%" height="100%" fill="rgba(15,23,22,.45)" mask="url(#obTourMask)"></rect></svg>' + rings +
    '<div class="ob-tip" role="dialog" aria-live="polite"><div class="ob-tip-st">' + (tour.index + 1) + " / " + total + "</div>" +
      "<h4>" + escapeHtml(step.title) + "</h4>" + obPointsHtml(step) +
      '<div class="ob-tip-row"><div class="ob-dots">' + dots + "</div>" +
      '<button type="button" class="ob-tip-skip" data-ob="skip">건너뛰기</button>' +
      '<button type="button" class="ob-tip-next" data-ob="next">' + (last ? (step.lastLabel || "시작하기") : "다음") + "</button></div></div>";

  /* 말풍선 위치: 첫 표시 아래(자리가 없으면 위, 그것도 없으면 옆), 화면 밖으로 안 나가게 */
  const tip = layer.querySelector(".ob-tip");
  const anchor = rects[0];
  const tipW = tip.offsetWidth;
  const tipH = tip.offsetHeight;
  const fitsBelow = anchor.y + anchor.h + 14 + tipH < win.innerHeight - 8;
  const fitsAbove = anchor.y - tipH - 14 > 8;
  let left = Math.max(12, Math.min(anchor.x + anchor.w / 2 - 44, win.innerWidth - tipW - 12));
  let top;
  tip.classList.remove("ob-tip-up", "ob-tip-side");
  if (fitsBelow) {
    top = anchor.y + anchor.h + 14;
  } else if (fitsAbove) {
    top = anchor.y - tipH - 14;
    tip.classList.add("ob-tip-up");
  } else {
    /* 큰 영역: 옆에, 그래도 안 되면 영역 안쪽 아래에 */
    tip.classList.add("ob-tip-side");
    top = Math.max(12, Math.min(anchor.y + 12, win.innerHeight - tipH - 12));
    left = anchor.x + anchor.w + 14 + tipW < win.innerWidth ? anchor.x + anchor.w + 14
      : anchor.x - tipW - 14 > 0 ? anchor.x - tipW - 14
      : Math.max(12, Math.min(anchor.x + anchor.w - tipW - 12, win.innerWidth - tipW - 12));
  }
  tip.style.left = left + "px";
  tip.style.top = top + "px";
  const arrowX = Math.max(18, Math.min(anchor.x + anchor.w / 2 - left - 7, tipW - 32));
  tip.style.setProperty("--ob-arrow-x", arrowX + "px");
}

/* ---------- 작업 수정 · 조직원 관리 창: 처음 열 때 단계별 안내 ---------- */
function obTaskSteps() {
  const panel = document.getElementById("detailPanel");
  const pick = (selector, closest) => () => {
    let el = panel && panel.querySelector(selector);
    if (el && closest) el = el.closest(closest) || el;
    return el ? { el } : null;
  };
  return [
    { targets: [pick("#detailName")], title: "작업 이름",
      text: "제목을 눌러 바로 고칠 수 있어요. 왼쪽 동그라미는 막대 색이에요." },
    { targets: [pick("#detailCategory", ".detail-prop")], title: "카테고리",
      text: "작업을 어느 묶음에 넣을지 골라요. 카테고리를 바꾸면 차트에서 그 묶음 아래로 옮겨져요." },
    { targets: [pick("#detailStart", ".detail-prop")], title: "기간",
      text: "시작일과 종료일을 고르면 옆에 며칠인지 보여요. 차트에서 막대를 끌거나 막대 끝을 끌어도 바뀌어요." },
    { targets: [pick("#detailOwner", ".detail-prop")], title: "담당자",
      text: "이름과 이메일을 적거나 조직원 목록에서 골라요. 이메일이 있어야 그 사람이 마감 알림을 받아요. '내가 할게요'로 나를 담당자로 넣을 수도 있어요." },
    { targets: [pick(".detail-side")], title: "진행률과 막대 색",
      text: "숫자를 넣거나 막대를 끌어 진행률을 정해요. 아래에서 이 작업만의 막대 색을 고를 수도 있어요." },
    { targets: [pick("#saveDetailBtn"), pick("#cancelDetailBtn")], title: "저장",
      text: "다 고쳤으면 저장을 눌러요. 공유된 사람들 화면에도 바로 반영돼요. 왼쪽 아래 삭제로 작업을 지울 수 있어요.", lastLabel: "알겠어요" }
  ];
}

function obOrgSteps() {
  const modal = document.getElementById("mcOrgModal");
  const pick = (selector) => () => {
    const el = modal && modal.querySelector(selector);
    return el && el.childElementCount !== 0 || (el && el.tagName === "BUTTON") ? { el } : null;
  };
  return [
    { targets: [pick("#mcOrgInvites")], title: "받은 초대",
      text: "다른 사람이 나를 조직에 초대하면 여기에 떠요. 수락하면 그 조직에 공유된 차트를 함께 볼 수 있어요." },
    { targets: [pick("#mcOrgNewBtn")], title: "새 조직 만들기",
      text: "회사·팀·동아리처럼 함께 일하는 단위로 조직을 만들어요. 만든 사람이 소유자가 돼요." },
    { targets: [pick("#mcOrgList")], title: "내 조직",
      text: "내가 속한 조직이 모두 보여요. 눌러서 오른쪽에 조직원과 권한을 띄워요." },
    { targets: [pick(".mc-org-head-actions")], title: "조직원 초대",
      text: "이메일로 조직원을 초대하고 역할을 정해요. ⋯ 버튼에서 조직 이름 바꾸기·소유자 넘기기·나가기를 할 수 있어요." },
    { targets: [pick(".mc-org-section")], title: "조직원과 역할(권한)",
      text: "역할은 게스트·참여자·관리자예요. 차트를 조직에 공유하면 게스트는 뷰어, 참여자는 편집자, 관리자는 관리자 권한으로 보고, 차트마다 사람별로 바꿀 수도 있어요." },
    { targets: [() => {
        const sections = modal ? modal.querySelectorAll(".mc-org-section") : [];
        return sections[1] ? { el: sections[1] } : null;
      }], title: "초대 대기",
      text: "아직 수락하지 않은 사람이에요. 수락하기 전까지는 조직에 공유된 차트를 볼 수 없어요.", lastLabel: "알겠어요" }
  ];
}

function obStartPanelTour(key) {
  if (obSeen(key) || obTourState) return;
  const steps = key === "task" ? obTaskSteps() : obOrgSteps();
  let tries = 0;
  const wait = () => {
    const ready = steps.some((s) => s.targets.some((fn) => { const t = fn(); return t && obVisible(t.el); }));
    if (!ready && tries++ < 16) { setTimeout(wait, 200); return; }
    if (!ready) return;
    obMark(key); // 한 번만: 시작한 순간 본 것으로
    obRunTour(steps, null);
  };
  setTimeout(wait, 150);
}

/* ---------- 창을 처음 열 때 한 번씩 안내 ---------- */
const OB_INLINE_TIPS = {
  share: { title: "공유하는 법", text: "이메일 탭은 구글 계정으로 한 명씩 초대해요. 조직원 선택·조직 전체 탭은 내 조직 사람들에게 한 번에 공유해요. 권한은 뷰어(보기만)·편집자(수정)·관리자(공유 설정까지) 중에서 고를 수 있어요." },
  newChart: { title: "차트 만드는 법", text: "이름만 정하면 빈 차트가 생겨요. 표시 기간과 작업은 만든 뒤 차트 안에서 바로 정하면 돼요. 엑셀 파일이 있으면 만든 뒤 업로드로 작업을 한 번에 넣을 수 있어요." },
  manage: { title: "차트 관리하는 법", text: "여기서 차트 순서를 바꾸고, 이름을 고치고, 화면에서 숨길 수 있어요. 차트 삭제는 만든 사람(소유자)만 할 수 있어요. 오른쪽 위 버튼으로 모든 차트를 엑셀로 한 번에 받을 수도 있어요." },
};

function obShowInlineTip(container, key) {
  if (!container || obSeen(key) || container.querySelector(".ob-inline")) return;
  const tip = OB_INLINE_TIPS[key];
  if (!tip) return;
  obMark(key); // 한 번만: 띄운 순간 본 것으로
  const box = document.createElement("div");
  box.className = "ob-inline";
  box.innerHTML = '<div class="ob-inline-ic">' + OB_ICON.info + "</div>" +
    '<div class="ob-inline-text"><b>' + escapeHtml(tip.title) + "</b>" + obPointsHtml(tip) +
    '<div class="ob-inline-row"><button type="button" class="ob-inline-ok">알겠어요</button>' +
    '<button type="button" class="ob-inline-skip">건너뛰기</button></div></div>';
  box.querySelector(".ob-inline-ok").addEventListener("click", () => box.remove());
  box.querySelector(".ob-inline-skip").addEventListener("click", () => {
    obMarkAll(); // 건너뛰기: 남은 안내도 모두 그만
    box.remove();
  });
  const head = container.querySelector(":scope > .mc-modal-head, :scope > h2, :scope > .modal-header, :scope > .detail-header");
  if (head) head.after(box);
  else container.prepend(box);
}

function obWatchOpen(element, key, containerOf) {
  if (!element) return;
  const check = () => {
    if (element.classList.contains("hidden")) return;
    if (key === "task" || key === "org") {
      obStartPanelTour(key);
      return;
    }
    setTimeout(() => obShowInlineTip(containerOf(element), key), 0);
  };
  new MutationObserver(check).observe(element, { attributes: true, attributeFilter: ["class"] });
}

function obInitInlineTips() {
  const modal = (id) => document.getElementById(id);
  const inner = (el) => el.querySelector(".mc-modal");
  if (IS_SHELL_MODE) {
    obWatchOpen(modal("mcShareModal"), "share", inner);
    obWatchOpen(modal("mcAddModal"), "newChart", inner);
    obWatchOpen(modal("mcManageModal"), "manage", inner);
    obWatchOpen(modal("mcOrgModal"), "org", inner);
  } else {
    obWatchOpen(modal("detailPanel"), "task", (el) => el.firstElementChild ? el : el);
  }
}

obInitInlineTips();


/* =========================================================
 * (요청사항) 마감 알림 — 사이트 안 알림(A) + 매일 아침 메일 받기 설정(C)
 *  - 카드 안 차트들이 보내 준 지연·임박 작업을 모아 오른쪽 위 종 버튼에 개수로
 *  - 목록에서 누르면 그 차트로 가서 작업 상세 창을 연다
 *  - "내 담당만": 담당자가 나(이메일 또는 내 이름)인 작업만
 *  - 메일 받기 설정은 users/{uid}.notify.email (기본 켜짐). 실제 발송은 functions/ 의 예약 작업
 * ========================================================= */
let bellMenu = null;
let bellMineOnly = true; /* (요청사항) 기본은 "나에게 온 알림" */
let bellProfile = null;
let bellProfileState = "idle"; // idle | loading | ready | error

/* (요청사항) 나에게 온 알림 = 내가 담당자인 작업 */
function bellIsMine(task) {
  return !!fbUser && isMyTask(task);
}

/* (버그 수정) 종 버튼이 카드 안 차트가 보내 주는 요약값에만 기대면, 그 전달이 빠졌을 때
   차트에는 "오늘 마감·D-1" 칩이 보여도 종 버튼에는 안 떴다.
   → 종 버튼이 Firestore 에서 작업을 직접 읽어 계산하고(5분마다 · 종 버튼을 열 때),
     차트가 보내 주는 최신 값이 있으면 그걸 우선 쓴다 */
const bellTaskCache = {};
let bellFetching = null;
let bellFetchedAt = 0;

function bellDueOf(task) {
  const due = taskNoticeStage(task);
  return due ? {
    id: task.id, name: task.name || "", end: task.end, progress: normProgress(task.progress),
    owner: task.owner || "", ownerEmail: String(task.ownerEmail || "").toLowerCase(),
    stage: due.stage, kind: due.kind, days: due.days, label: due.label,
    endChangedAt: Number(task.endChangedAt) || 0
  } : null;
}

function bellFetchTasks(force) {
  if (!IS_SHELL_MODE || !fbUser || typeof fb.getTasksOnce !== "function") return Promise.resolve();
  if (bellFetching) return bellFetching;
  if (!force && Date.now() - bellFetchedAt < 5 * 60 * 1000) return Promise.resolve();
  bellFetching = (async () => {
    for (const chart of shellChartsCache || []) {
      try {
        const tasks = await fb.getTasksOnce(chart.id);
        bellTaskCache[chart.id] = tasks.map(bellDueOf).filter(Boolean);
      } catch (error) {
        /* 내용을 볼 수 없는 차트(초대 대기 등)는 건너뛴다 */
      }
    }
    bellFetchedAt = Date.now();
  })().finally(() => {
    bellFetching = null;
    shellRefreshBell();
  });
  return bellFetching;
}

/* 차트가 바뀌었다고 알려 오면(요약값 도착) 그 차트만 잠시 뒤 다시 읽어, 완료·수정이 바로 반영되게 */
const bellChartTimers = {};

function bellRefetchChart(chartId) {
  if (!IS_SHELL_MODE || !fbUser || typeof fb.getTasksOnce !== "function") return;
  clearTimeout(bellChartTimers[chartId]);
  bellChartTimers[chartId] = setTimeout(async () => {
    try {
      const tasks = await fb.getTasksOnce(chartId);
      bellTaskCache[chartId] = tasks.map(bellDueOf).filter(Boolean);
      shellRefreshBell();
    } catch (error) { /* 무시 */ }
  }, 1500);
}

function bellCollect() {
  const items = [];
  (shellChartsCache || []).forEach((chart) => {
    const stats = shellStats[chart.id];
    const fromChart = (stats && stats.dueTasks) || [];
    const seen = new Set(fromChart.map((task) => task.id));
    fromChart.concat((bellTaskCache[chart.id] || []).filter((task) => !seen.has(task.id)))
      .forEach((task) => items.push({ ...task, chartId: chart.id, chartName: chart.name }));
  });
  const order = { overdue: 0, "due-soon": 1, upcoming: 2 };
  return items.sort((a, b) => {
    if (a.kind !== b.kind) return (order[a.kind] ?? 3) - (order[b.kind] ?? 3);
    return a.kind === "overdue" ? b.days - a.days : a.days - b.days;
  });
}

/* (요청사항) 사이트 안 알림은 [확인]을 누를 때까지 남는다. 확인 기록은 users/{uid}.noticeAcks 에
   (다른 기기에서도 다시 안 뜨게) + 이 브라우저에도. 종료일이 바뀌면 새 알림으로 본다 */
/* 같은 작업·같은 단계라도 종료일을 다시 바꿨으면(endChangedAt) 다른 알림 */
function bellNoticeKey(task) {
  return task.chartId + ":" + task.id + ":" + task.stage + ":" + task.end + ":" + (Number(task.endChangedAt) || 0);
}

function bellAckCacheKey() {
  return "ganttNoticeAcks:" + (fbUser ? fbUser.uid : "");
}

function bellAcks() {
  let local = {};
  try { local = JSON.parse(localStorage.getItem(bellAckCacheKey()) || "{}") || {}; } catch (error) { local = {}; }
  return { ...((bellProfile && bellProfile.noticeAcks) || {}), ...local };
}

function bellAck(items) {
  if (!fbUser || !items.length) return;
  const today = dateKey(new Date());
  const added = {};
  items.forEach((t) => { added[bellNoticeKey(t)] = today; });
  const merged = { ...bellAcks(), ...added };
  try { localStorage.setItem(bellAckCacheKey(), JSON.stringify(merged)); } catch (error) { /* 무시 */ }
  bellProfile = { ...(bellProfile || {}), noticeAcks: { ...((bellProfile && bellProfile.noticeAcks) || {}), ...added } };
  if (typeof fb.mergeUserProfile === "function") {
    fb.mergeUserProfile(fbUser.uid, { noticeAcks: added }).catch((error) => console.warn("알림 확인 저장 실패:", error && error.message));
  }
  shellRefreshBell();
}

/* 확인하지 않은 알림 (전체 / 내 담당) */
function bellOpenItems(mineOnly = bellMineOnly) {
  const acks = bellAcks();
  const items = bellCollect().filter((t) => !acks[bellNoticeKey(t)]);
  return mineOnly ? items.filter(bellIsMine) : items;
}

function shellRefreshBell() {
  if (!IS_SHELL_MODE) return;
  const button = document.getElementById("mcBellBtn");
  const badge = document.getElementById("mcBellBadge");
  if (!button || !badge) return;
  button.classList.toggle("hidden", !fbUser);
  const counted = bellOpenItems(true); /* 배지는 언제나 "나에게 온 알림"만 */
  badge.textContent = counted.length > 99 ? "99+" : String(counted.length);
  badge.classList.toggle("hidden", !counted.length);
  badge.classList.toggle("mc-bell-badge-soon", !counted.some((t) => t.kind === "overdue"));
  button.title = counted.length ? "마감 알림 " + counted.length + "개" : "마감 알림";
  if (bellMenu) shellRenderBellMenu();
}

function shellCloseBellMenu() {
  if (bellMenu) bellMenu.remove();
  bellMenu = null;
  bellDigestEdit = null;
}

function shellOpenTaskFromNotice(chartId, taskId) {
  shellCloseBellMenu();
  const box = document.getElementById("mc-chart-anchor-" + chartId);
  if (!box) return;
  if (box.classList.contains("mc-chart-box-collapsed")) {
    const toggle = box.querySelector(".mc-chart-toggle");
    if (toggle) toggle.click();
  }
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  setTimeout(() => shellSendCommand(box, { cmd: "openTask", taskId }), 450);
}

const BELL_ICON = {
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 8v5M12 16h.01"></path><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>',
  clock: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>',
  cal: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="16" rx="3"></rect><path d="M3.5 9.5h17M8 3v3M16 3v3"></path></svg>',
  check: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>',
  mail: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="m4 7 8 6 8-6"></path></svg>',
  bell: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"></path><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"></path></svg>',
  up: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 2 9 8H1z" fill="currentColor"></path></svg>',
  down: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8 1 2h8z" fill="currentColor"></path></svg>',
  done: '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m8 12 3 3 5-6"></path></svg>'
};

/* (요청사항) 일정 메일 — 마감 알림과 따로, 정한 주기마다 일정 전체를 메일로.
   users/{uid}.notify.digest = { on, every, unit: "d"|"w"|"m", scope: "mine"|"charts", since }
   켜고 끄기는 토글(꺼도 고른 주기는 기억). 알약: 매일 · 3일 · 1주일 · 직접 설정, 누르면 바로 저장.
   직접 설정은 알약이 [숫자 ▲▼][일|주|달][✓] 로 바뀌고 ✓ 를 누르면 저장 (켜진 직접 설정을 다시 누르면 고치기) */
const BELL_DIGEST_PRESETS = [["1d", 1, "d", "매일"], ["3d", 3, "d", "3일"], ["1w", 1, "w", "1주일"]];
const BELL_DIGEST_MAX = { d: 99, w: 52, m: 12 };
let bellDigestEdit = null;

function bellDigestText(digest) {
  const n = digest.every;
  if (digest.unit === "d") return n === 1 ? "매일" : n + "일마다";
  if (digest.unit === "w") return n === 1 ? "매주" : n + "주마다";
  return n === 1 ? "매달" : n + "달마다";
}

function bellDigestPreset(digest) {
  return digest ? BELL_DIGEST_PRESETS.find(([, every, unit]) => digest.every === every && digest.unit === unit) : null;
}

function bellSeoulToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function bellDigestOn(digest) {
  return !!digest && digest.on !== false && digest.every >= 1;
}

function bellDigestHtml(digest, off) {
  const on = bellDigestOn(digest);
  const preset = bellDigestPreset(digest);
  /* (요청사항) 낱개 알약 대신 "나에게 | 전체" 처럼 한 줄로 붙은 칸 — 칸 너비는 같게, 왼쪽에 이름표 */
  const seg = (cells) => '<div class="mc-bell-seg mc-bell-seg-fill">' + cells.join("") + "</div>";
  const row = (label, control) => '<div class="mc-bell-opt"><span class="mc-bell-opt-label">' + label + "</span>" + control + "</div>";
  let cycle;
  if (bellDigestEdit) {
    const e = bellDigestEdit;
    cycle = '<div class="mc-bell-pill-edit">' +
      '<span class="mc-bell-num">' + e.every + "</span>" +
      '<span class="mc-bell-step"><button type="button" data-step="1" aria-label="늘리기">' + BELL_ICON.up + '</button><button type="button" data-step="-1" aria-label="줄이기">' + BELL_ICON.down + "</button></span>" +
      '<span class="mc-bell-units">' + [["d", "일"], ["w", "주"], ["m", "달"]].map(([u, label]) =>
        '<button type="button" data-unit="' + u + '" class="' + (e.unit === u ? "on" : "") + '">' + label + "</button>").join("") + "</span>" +
      '<button type="button" class="mc-bell-pill-ok" data-digest-ok aria-label="저장" title="저장">' + BELL_ICON.check + "</button></div>";
  } else {
    const customOn = digest && !preset;
    const short = customOn ? digest.every + ({ d: "일", w: "주", m: "달" }[digest.unit] || "") : "직접";
    cycle = seg(BELL_DIGEST_PRESETS.map(([key, , , label]) =>
      '<button type="button" class="' + (preset && preset[0] === key ? "on" : "") + '" data-digest="' + key + '"' + off + ">" + label + "</button>")
      .concat('<button type="button" class="' + (customOn ? "on" : "") + '" data-digest="custom"' + off + ' title="직접 설정">' + short + "</button>"));
  }
  const body = !on ? "" : '<div class="mc-bell-digest-body">' +
    row("주기", cycle) +
    row("받을 작업", seg([
      '<button type="button" data-digest-scope="mine" class="' + (digest.scope !== "charts" ? "on" : "") + '">내 작업</button>',
      '<button type="button" data-digest-scope="charts" class="' + (digest.scope === "charts" ? "on" : "") + '">내 차트 전체</button>'
    ])) + "</div>";
  return '<div class="mc-bell-digest">' +
      '<label class="mc-bell-switch-row"><span class="mc-bell-switch-ic">' + BELL_ICON.cal + "</span>" +
        '<span class="mc-bell-switch-text"><b>일정 메일</b><i>' + (on ? bellDigestText(digest) + " · 아침 8시" : "정한 주기마다 전체 일정") + "</i></span>" +
        '<input type="checkbox" class="mc-bell-switch" id="mcBellDigest"' + (on ? " checked" : "") + off + "></label>" +
      body +
    "</div>";
}

async function bellSaveDigest(next) {
  if (!fbUser) return;
  try {
    await fb.mergeUserProfile(fbUser.uid, { notify: { digest: next } });
    bellProfile = { ...(bellProfile || {}), notify: { ...((bellProfile && bellProfile.notify) || {}), digest: next } };
    bellDigestEdit = null;
    showToast(bellDigestOn(next)
      ? bellDigestText(next) + " 아침 8시에 " + (next.scope === "charts" ? "내 차트 전체" : "내 작업") + " 일정을 메일로 보내 드릴게요."
      : "일정 메일을 끕니다.");
  } catch (error) {
    showToast(error.message || "설정을 저장하지 못했어요.", true, 0);
  }
  if (bellMenu) shellRenderBellMenu();
}

/* 알림창 클릭 중 일정 메일 부분 — 처리했으면 true */
function bellHandleDigestClick(target) {
  const digest = (bellProfile && bellProfile.notify && bellProfile.notify.digest) || null;
  const scope = (digest && digest.scope) || "mine";
  const pill = target.closest("[data-digest]");
  if (pill) {
    const key = pill.dataset.digest;
    const preset = BELL_DIGEST_PRESETS.find(([k]) => k === key);
    const current = bellDigestPreset(digest);
    if (preset) {
      bellDigestEdit = null;
      if (!current || current[0] !== key) bellSaveDigest({ on: true, every: preset[1], unit: preset[2], scope, since: bellSeoulToday() });
      else shellRenderBellMenu();
    } else {
      bellDigestEdit = digest && !current ? { every: digest.every, unit: digest.unit } : { every: 2, unit: "d" };
      shellRenderBellMenu();
    }
    return true;
  }
  if (!bellDigestEdit) {
    const scopeBtn = target.closest("[data-digest-scope]");
    if (scopeBtn && digest && scopeBtn.dataset.digestScope !== scope) {
      bellSaveDigest({ ...digest, scope: scopeBtn.dataset.digestScope });
      return true;
    }
    return !!scopeBtn;
  }
  const step = target.closest("[data-step]");
  const unit = target.closest("[data-unit]");
  if (step || unit) {
    const e = bellDigestEdit;
    if (unit) e.unit = unit.dataset.unit;
    if (step) e.every += Number(step.dataset.step);
    e.every = Math.max(1, Math.min(BELL_DIGEST_MAX[e.unit], e.every));
    shellRenderBellMenu();
    return true;
  }
  if (target.closest("[data-digest-ok]")) {
    bellSaveDigest({ on: true, every: bellDigestEdit.every, unit: bellDigestEdit.unit, scope, since: bellSeoulToday() });
    return true;
  }
  return false;
}

/* (요청사항) 글자 위주였던 알림창을 그림 위주로:
   왼쪽 색 타일에 남은 날(크게) · 이름 한 줄 · 아래 줄은 담당자 동그라미 + 차트 + 진행률 막대 ·
   오른쪽 회색 체크 = 확인. 메일 설정은 오른쪽 위 버튼 안으로 */
function shellRenderBellMenu() {
  const menu = bellMenu;
  if (!menu) return;
  const items = bellOpenItems();
  /* (요청사항) 지연이 많아도 급한 마감이 먼저 보이게: 마감 임박 → 다가오는 마감 → 지연 */
  const groups = [
    ["due-soon", "마감 임박", BELL_ICON.clock],
    ["upcoming", "다가오는 마감", BELL_ICON.cal],
    ["overdue", "지연", BELL_ICON.alert]
  ];

  const tile = (t) => {
    /* (요청사항) 한 줄만: "D-6" · "D-day" · 지연은 "D+3" */
    const text = t.kind === "overdue" ? "D+" + t.days : t.days === 0 ? "D-day" : "D-" + t.days;
    return '<span class="mc-bell-tile mc-bell-tile-' + t.kind + '"><b>' + text + "</b></span>";
  };
  const who = (t) => {
    const name = t.owner || "";
    return name
      ? '<span class="mc-bell-who" style="background:' + mcPersonColor(t.ownerEmail || name) + '" title="' + escapeHtml(name) + '">' + escapeHtml(Array.from(name)[0]) + "</span>"
      : '<span class="mc-bell-who mc-bell-who-none" title="담당자 없음">–</span>';
  };

  const list = groups.map(([kind, title, icon]) => {
    const rows = items.filter((t) => t.kind === kind);
    if (!rows.length) return "";
    return '<div class="mc-bell-sec"><div class="mc-bell-sec-title mc-bell-' + kind + '">' + icon + "<span>" + title + "</span><em>" + rows.length + "</em></div>" +
      rows.map(bellRow).join("") + "</div>";
  }).join("");

  function bellRow(t) {
    return '<div class="mc-bell-item">' +
          '<button type="button" class="mc-bell-open" data-chart="' + escapeHtml(t.chartId) + '" data-task="' + escapeHtml(t.id) + '">' +
            tile(t) +
            '<span class="mc-bell-item-text"><b>' + escapeHtml(t.name) + "</b>" +
              '<span class="mc-bell-meta">' + who(t) + '<span class="mc-bell-chart">' + escapeHtml(t.chartName) + "</span>" +
                '<span class="mc-bell-prog" title="진행률 ' + t.progress + '%"><i style="width:' + t.progress + '%"></i></span></span></span>' +
          "</button>" +
          '<button type="button" class="mc-bell-ack" data-key="' + escapeHtml(bellNoticeKey(t)) + '" aria-label="확인" title="확인 (알림에서 지우기)">' + BELL_ICON.check + "</button>" +
        "</div>";
  }

  const notify = (bellProfile && bellProfile.notify) || {};
  const emailOn = notify.email !== false;
  const off = bellProfileState !== "ready" ? " disabled" : "";
  const toggle = (id, on, icon, title, sub) =>
    '<label class="mc-bell-switch-row"><span class="mc-bell-switch-ic">' + icon + "</span>" +
      '<span class="mc-bell-switch-text"><b>' + title + "</b><i>" + sub + "</i></span>" +
      '<input type="checkbox" class="mc-bell-switch" id="' + id + '"' + (on ? " checked" : "") + off + "></label>";
  /* (요청사항) 설정은 접지 않고 항상 보이게 */
  const settings = bellProfileState === "error"
    ? '<div class="mc-bell-settings mc-bell-mail-off">알림 설정을 불러오지 못했어요. (보안 규칙 확인 필요)</div>'
    : '<div class="mc-bell-settings">' +
        toggle("mcBellMail", emailOn, BELL_ICON.mail, "마감 알림 메일", "D-15 · 7 · 1 · 당일 · 지연 시") +
        bellDigestHtml(notify.digest || null, off) +
      "</div>";

  menu.innerHTML =
    '<div class="mc-bell-head"><b>마감 알림</b>' +
      '<div class="mc-bell-seg"><button type="button" data-bell-scope="mine" class="' + (bellMineOnly ? "on" : "") + '">나에게</button>' +
      '<button type="button" data-bell-scope="all" class="' + (!bellMineOnly ? "on" : "") + '">전체</button></div>' +
    "</div>" +
    settings +
    '<div class="mc-bell-list">' +
      (items.length ? list : '<div class="mc-bell-empty">' + BELL_ICON.done + "<span>확인할 알림이 없어요</span></div>") +
    "</div>" +
    (items.length ? '<button type="button" class="mc-bell-ack-all">' + BELL_ICON.check + "모두 확인</button>" : "");
}

function shellOpenBellMenu(button) {
  if (bellMenu) {
    shellCloseBellMenu();
    return;
  }
  const menu = document.createElement("div");
  menu.className = "mc-bell-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", "마감 알림");
  bellMenu = menu;
  shellRenderBellMenu();
  document.body.appendChild(menu);
  bellFetchTasks(false);
  const rect = button.getBoundingClientRect();
  menu.style.top = rect.bottom + 8 + "px";
  menu.style.left = Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8)) + "px";

  menu.addEventListener("click", (event) => {
    event.stopPropagation();
    const scope = event.target.closest("[data-bell-scope]");
    if (scope) {
      bellMineOnly = scope.dataset.bellScope === "mine";
      shellRefreshBell();
      return;
    }
    const ack = event.target.closest(".mc-bell-ack");
    if (ack) {
      const target = bellOpenItems().find((t) => bellNoticeKey(t) === ack.dataset.key);
      if (target) bellAck([target]);
      return;
    }
    if (bellHandleDigestClick(event.target)) return;
    if (event.target.closest(".mc-bell-ack-all")) {
      const open = bellOpenItems();
      /* (요청사항) 안 보이던 알림까지 지워지지 않게 한 번 더 묻는다 */
      if (!confirm("알림 " + open.length + "개를 모두 확인할까요?")) return;
      bellAck(open);
      return;
    }
    const item = event.target.closest(".mc-bell-open");
    if (item) shellOpenTaskFromNotice(item.dataset.chart, item.dataset.task);
  });
  menu.addEventListener("change", async (event) => {
    if (!fbUser) return;
    const input = event.target;
    const on = input.checked;
    const setNotify = (fields) => {
      bellProfile = { ...(bellProfile || {}), notify: { ...((bellProfile && bellProfile.notify) || {}), ...fields } };
    };
    if (input.id === "mcBellDigest") {
      /* 켜면 기억해 둔 주기(처음이면 1주일)로, 오늘부터 다시 센다 */
      const digest = (bellProfile && bellProfile.notify && bellProfile.notify.digest) || {};
      const base = digest.every >= 1 ? digest : { every: 1, unit: "w", scope: "mine" };
      bellDigestEdit = null;
      await bellSaveDigest({ ...base, on, since: on ? bellSeoulToday() : (base.since || bellSeoulToday()) });
      return;
    }
    try {
      if (input.id === "mcBellMail") {
        await fb.mergeUserProfile(fbUser.uid, { notify: { email: on } });
        setNotify({ email: on });
        showToast(on ? "마감 15일 전 · 7일 전 · 1일 전 · 당일, 지연되면 1·4·7일째와 그 뒤 매주 메일로 알려 드릴게요." : "마감 알림 메일을 끕니다.");
      }
    } catch (error) {
      input.checked = !on;
      showToast(error.message || "설정을 저장하지 못했어요.", true, 0);
    } finally {
      input.disabled = false;
    }
  });
}

/* 로그인한 사람의 메일 주소·이름을 users/{uid} 에 적어 둔다(메일 받는 사람 목록용).
   처음이면 메일 받기를 켜 둔다 */
async function shellInitBellProfile() {
  if (!IS_SHELL_MODE || !fbUser || bellProfileState !== "idle" || typeof fb.mergeUserProfile !== "function") return;
  bellProfileState = "loading";
  try {
    const profile = typeof fb.getUserProfile === "function" ? await fb.getUserProfile(fbUser.uid) : null;
    const fields = { email: String(fbUser.email || "").toLowerCase(), name: fbUser.displayName || "" };
    if (!profile || !profile.notify || profile.notify.email === undefined) fields.notify = { email: true };
    await fb.mergeUserProfile(fbUser.uid, fields);
    /* (요청사항) 다른 사람이 나를 담당자로 적으면 "가입한 사람"으로 보이게 */
    if (typeof fb.registerMyEmail === "function") {
      fb.registerMyEmail(fbUser.uid, fields.email).catch((error) => console.warn("가입 이메일 표시 실패:", error && error.message));
    }
    bellProfile = { ...(profile || {}), ...fields };
    bellProfileState = "ready";
  } catch (error) {
    console.warn("메일 알림 설정을 불러오지 못했습니다:", error && error.message);
    bellProfileState = "error";
  }
  if (bellMenu) shellRenderBellMenu();
}

/* 예전에 켜 둔 웹 푸시(서비스 워커)는 이제 쓰지 않으니 정리한다 */
if (IS_SHELL_MODE && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((list) => list.forEach((reg) => {
      const url = (reg.active || reg.installing || reg.waiting || {}).scriptURL || "";
      if (url.includes("firebase-messaging-sw.js")) reg.unregister();
    }))
    .catch(() => {});
}

if (IS_SHELL_MODE) {
  const bellButton = document.getElementById("mcBellBtn");
  if (bellButton) {
    bellButton.addEventListener("click", (event) => {
      event.stopPropagation();
      shellOpenBellMenu(bellButton);
    });
  }
  document.addEventListener("click", (event) => {
    if (bellMenu && !bellMenu.contains(event.target)) shellCloseBellMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") shellCloseBellMenu();
  });
  window.addEventListener("resize", shellCloseBellMenu);
  setInterval(() => bellFetchTasks(false), 5 * 60 * 1000);
}
