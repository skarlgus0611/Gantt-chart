/* =========================================================
 * Firebase 연동 코어 (POC / 1단계)
 * ---------------------------------------------------------
 * 기존 app.js / index.html / ShareServer.gs는 전혀 건드리지 않는다.
 * 이 파일은 새로 Firestore로 옮기는 작업을 테스트해보기 위한
 * 독립 모듈이다. 검증되면 이걸 기준으로 app.js에 통합한다.
 *
 * 데이터 모델:
 *   charts/{chartId}
 *     ownerId, ownerEmail, name, rangeStart, rangeEnd,
 *     hidden, order, calendarId,
 *     members: { "email": { role, status: "pending"|"accepted" } },
 *     memberEmails: ["email", ...]   // status가 accepted인 멤버만(실제 접근 권한 기준)
 *     pendingEmails: ["email", ...]  // 초대 보냈지만 아직 수락 안 한 멤버(초대함 쿼리용)
 *     createdAt
 *   charts/{chartId}/tasks/{taskId}
 *     name, categoryId, start, end, progress, color, memo, target,
 *     owner, calendarEventId, updatedAt
 *   charts/{chartId}/categories/{categoryId}
 *     name, color
 * ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, onSnapshot, query, where, serverTimestamp, arrayUnion, arrayRemove,
  writeBatch
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-firestore.js";

/* (당신 콘솔에서 받은 설정값 그대로) */
const firebaseConfig = {
  apiKey: "AIzaSyDUi_7v5FjyhWWeLD7gfeA92hxlTOPa7d8",
  authDomain: "gantt-chart-e06b8.firebaseapp.com",
  projectId: "gantt-chart-e06b8",
  storageBucket: "gantt-chart-e06b8.firebasestorage.app",
  messagingSenderId: "536820128634",
  appId: "1:536820128634:web:f174b11ad34e41432dd4c3"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

/* ----- 로그인 -----
 * (설계 변경, 문제 3 재해결) 앱 로그인(Firestore 접근)과 캘린더 API
 * 접근 권한을 한 번의 구글 로그인 팝업으로 같이 받는다. 드라이브
 * 권한은 더 이상 필요 없다(데이터가 Firestore로 가므로).
 * Firebase Auth는 세션을 SDK가 알아서 유지/갱신해주므로, 예전처럼
 * "토큰 1시간마다 로그인 버튼을 다시 눌러야" 하는 문제가
 * (캘린더 기능을 안 쓰는 한) 사실상 없어진다. */
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

let lastCalendarAccessToken = "";

export function signIn() {
  const provider = new GoogleAuthProvider();
  provider.addScope(CALENDAR_SCOPE);
  provider.setCustomParameters({ prompt: "select_account" });
  return signInWithPopup(auth, provider).then((result) => {
    const credential = GoogleAuthProvider.credentialFromResult(result);
    lastCalendarAccessToken = (credential && credential.accessToken) || "";
    return { user: result.user, calendarAccessToken: lastCalendarAccessToken };
  });
}

export function signOutUser() {
  lastCalendarAccessToken = "";
  return signOut(auth);
}

export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function getCalendarAccessToken() {
  /* (주의) 이 토큰도 결국 구글 OAuth 토큰이라 1시간 정도면 끝난다.
     캘린더 기능을 실제로 쓸 때만 필요하므로, 끝나있으면 그때
     signIn()을 다시 한번 호출해서 받으면 된다(앱 로그인 자체는
     유지된 채로, 캘린더 권한만 다시 받는 것도 가능 — 2단계에서 다룸). */
  return lastCalendarAccessToken;
}

export function currentUser() {
  return auth.currentUser;
}

/* ----- 차트 ----- */

export function createChart(ownerId, ownerEmail, name) {
  return addDoc(collection(db, "charts"), {
    ownerId, ownerEmail,
    name: name || "새 차트",
    rangeStart: "", rangeEnd: "",
    hidden: false, order: 0, calendarId: "",
    members: {}, memberEmails: [], pendingEmails: [],
    createdAt: serverTimestamp()
  });
}

export function updateChartMeta(chartId, fields) {
  return updateDoc(doc(db, "charts", chartId), fields);
}

export function deleteChart(chartId) {
  return deleteDoc(doc(db, "charts", chartId));
}

/* ----- 공유(초대/멤버) -----
 * 역할 변경이나 멤버 추가는 전부 그 차트 문서 1개만 건드리는
 * updateDoc이라, 예전 ShareServer.gs의 인덱스 파일+락+버전번호
 * 체계 자체가 필요 없어진다. */

export function inviteMember(chartId, email, role) {
  const field = "members." + email;
  return updateDoc(doc(db, "charts", chartId), {
    [field]: { role, status: "pending" },
    pendingEmails: arrayUnion(email)
  });
}

export function respondInvite(chartId, email, accept) {
  const field = "members." + email;
  if (!accept) {
    return updateDoc(doc(db, "charts", chartId), {
      [field]: null,
      pendingEmails: arrayRemove(email)
    });
  }
  return getDoc(doc(db, "charts", chartId)).then((snap) => {
    const data = snap.data() || {};
    const entry = (data.members || {})[email] || { role: "viewer" };
    return updateDoc(doc(db, "charts", chartId), {
      [field]: { role: entry.role, status: "accepted" },
      pendingEmails: arrayRemove(email),
      memberEmails: arrayUnion(email)
    });
  });
}

export function setMemberRole(chartId, email, role) {
  const field = "members." + email + ".role";
  return updateDoc(doc(db, "charts", chartId), { [field]: role });
}

export function removeMember(chartId, email) {
  const field = "members." + email;
  return updateDoc(doc(db, "charts", chartId), {
    [field]: null,
    memberEmails: arrayRemove(email),
    pendingEmails: arrayRemove(email)
  });
}

/* 내 초대함: 아직 수락 안 한 초대가 있는 차트 목록 */
export function listenMyInvites(email, callback) {
  return onSnapshot(
    query(collection(db, "charts"), where("pendingEmails", "array-contains", email)),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function getInvitesOnce(email) {
  const snap = await getDocs(query(collection(db, "charts"), where("pendingEmails", "array-contains", email)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* 내가 소유한 차트 + 내가 멤버로 등록된 차트, 두 번 구독해서 합친다
   (Firestore가 "A이거나 B" 조건을 한 쿼리로 못 하므로). */
export function listenMyCharts(uid, email, callback) {
  let owned = [];
  let shared = [];

  function emit() {
    const byId = {};
    owned.forEach((c) => { byId[c.id] = c; });
    shared.forEach((c) => { byId[c.id] = c; });
    callback(Object.values(byId));
  }

  const unsubOwned = onSnapshot(
    query(collection(db, "charts"), where("ownerId", "==", uid)),
    (snap) => { owned = snap.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }
  );
  const unsubShared = onSnapshot(
    query(collection(db, "charts"), where("memberEmails", "array-contains", email)),
    (snap) => { shared = snap.docs.map((d) => ({ id: d.id, ...d.data() })); emit(); }
  );

  return () => { unsubOwned(); unsubShared(); };
}

export async function getChartOnce(chartId) {
  const snap = await getDoc(doc(db, "charts", chartId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/* ----- 작업(tasks) ----- */

export function listenTasks(chartId, callback) {
  return onSnapshot(collection(db, "charts", chartId, "tasks"), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function getTasksOnce(chartId) {
  const snap = await getDocs(collection(db, "charts", chartId, "tasks"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getTaskOnce(chartId, taskId) {
  const snap = await getDoc(doc(db, "charts", chartId, "tasks", taskId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function createTask(chartId, data) {
  return addDoc(collection(db, "charts", chartId, "tasks"), {
    name: data.name || "", categoryId: data.categoryId || "",
    start: data.start || "", end: data.end || "",
    progress: Number(data.progress) || 0, color: data.color || "",
    memo: data.memo || "", target: data.target || "", owner: data.owner || "",
    order: Number(data.order) || 0,
    calendarEventId: "", updatedAt: serverTimestamp()
  });
}

export function updateTask(chartId, taskId, fields) {
  return updateDoc(doc(db, "charts", chartId, "tasks", taskId), {
    ...fields, updatedAt: serverTimestamp()
  });
}

export function deleteTask(chartId, taskId) {
  return deleteDoc(doc(db, "charts", chartId, "tasks", taskId));
}

/* 드래그로 작업/카테고리 순서를 바꿨을 때: orderedIds 순서대로 order
   필드를 0,1,2... 로 다시 매겨서 한 번의 배치 쓰기로 반영한다. */
export async function reorderTasks(chartId, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => {
    batch.update(doc(db, "charts", chartId, "tasks", id), { order: i });
  });
  return batch.commit();
}

/* ----- 카테고리 ----- */

export function listenCategories(chartId, callback) {
  return onSnapshot(collection(db, "charts", chartId, "categories"), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function getCategoriesOnce(chartId) {
  const snap = await getDocs(collection(db, "charts", chartId, "categories"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getCategoryOnce(chartId, categoryId) {
  const snap = await getDoc(doc(db, "charts", chartId, "categories", categoryId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function createCategory(chartId, data) {
  return addDoc(collection(db, "charts", chartId, "categories"), {
    name: data.name || "새 카테고리", color: data.color || "#4f8ef7",
    order: Number(data.order) || 0
  });
}

export function updateCategory(chartId, categoryId, fields) {
  return updateDoc(doc(db, "charts", chartId, "categories", categoryId), fields);
}

export function deleteCategory(chartId, categoryId) {
  return deleteDoc(doc(db, "charts", chartId, "categories", categoryId));
}

export async function reorderCategories(chartId, orderedIds) {
  const batch = writeBatch(db);
  orderedIds.forEach((id, i) => {
    batch.update(doc(db, "charts", chartId, "categories", id), { order: i });
  });
  return batch.commit();
}

export async function getChartsOnce(uid, email) {
  const [ownedSnap, sharedSnap] = await Promise.all([
    getDocs(query(collection(db, "charts"), where("ownerId", "==", uid))),
    getDocs(query(collection(db, "charts"), where("memberEmails", "array-contains", email)))
  ]);
  const byId = {};
  ownedSnap.docs.forEach((d) => { byId[d.id] = { id: d.id, ...d.data() }; });
  sharedSnap.docs.forEach((d) => { byId[d.id] = { id: d.id, ...d.data() }; });
  return Object.values(byId);
}
