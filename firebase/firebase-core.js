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
  initializeFirestore, collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
  getDoc, getDocs, onSnapshot, query, where, serverTimestamp, arrayUnion, arrayRemove,
  writeBatch, FieldPath, deleteField
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
/* (성능) 학교/기숙사 네트워크, 방화벽, 일부 브라우저 확장이 Firestore의
   기본 실시간 연결 방식(WebChannel/gRPC-Web 스트리밍)을 막으면, SDK가
   훨씬 느린 방식으로 매 요청마다 우회하면서 "모든 동작이 몇 초씩 느려지는"
   증상이 생긴다. getFirestore() 대신 initializeFirestore()에
   experimentalAutoDetectLongPolling을 켜서, 그런 환경을 자동으로
   감지하고 처음부터 안정적인 연결 방식으로 붙게 한다. */
const db = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  useFetchStreams: false
});

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

/* (버그 수정) 공유에 쓰는 이메일은 항상 소문자로 저장·비교한다(보안 규칙도 소문자로 비교). */
function lowerEmail(email) {
  return String(email || "").trim().toLowerCase();
}

/* 멤버가 바뀐 뒤 작업 문서의 복사값을 맞추는 일은 편집 권한이 있어야 성공한다.
   뷰어 본인이 수락하거나 나갈 때는 실패하는데, 읽기 권한은 이제 보안 규칙이
   차트 문서로 확인하므로 실패해도 안전하다 → 오류로 멈추지 않고 넘어간다. */
async function restampQuietly(chartId, ownerId, memberEmails) {
  try {
    await restampChartAcl(chartId, ownerId, memberEmails);
  } catch (error) {
    console.warn("작업 복사값 맞추기를 건너뜀(권한 없음):", error && error.code);
  }
}

/* ----- 차트 ----- */

export function createChart(ownerId, ownerEmail, name) {
  return addDoc(collection(db, "charts"), {
    ownerId, ownerEmail: lowerEmail(ownerEmail),
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

/* (버그 수정) "members." + email 처럼 문자열을 이어붙여서 필드 경로로
   쓰면, Firestore는 그 문자열 안의 "." 를 전부 경로 구분자로 해석한다.
   이메일 자체에 "." 이 있으면(예: "a@gmail.com"의 ".com") 그 지점에서
   또 쪼개져서, "members.a@gmail.com"이 실제로는
   members → "a@gmail" → "com" 처럼 한 단계 더 깊이 들어가 버렸다 —
   그래서 이메일 끝(.com 등)이 날아가고 role이 "undefined"로 보이는
   버그가 생겼다. FieldPath를 쓰면 이메일 문자열 전체를 "한 단계"로
   정확히 취급한다. */
export function inviteMember(chartId, email, role) {
  email = lowerEmail(email);
  return updateDoc(doc(db, "charts", chartId),
    new FieldPath("members", email), { role, status: "pending" },
    "pendingEmails", arrayUnion(email)
  );
}

export async function respondInvite(chartId, email, accept) {
  email = lowerEmail(email);
  const chartRef = doc(db, "charts", chartId);
  if (!accept) {
    return updateDoc(chartRef,
      new FieldPath("members", email), null,
      "pendingEmails", arrayRemove(email)
    );
  }
  const snap = await getDoc(chartRef);
  const data = snap.data() || {};
  const entry = (data.members || {})[email] || { role: "viewer" };
  const newMemberEmails = (data.memberEmails || []).includes(email)
    ? (data.memberEmails || [])
    : (data.memberEmails || []).concat(email);
  await updateDoc(chartRef,
    new FieldPath("members", email), { role: entry.role, status: "accepted" },
    "pendingEmails", arrayRemove(email),
    "memberEmails", arrayUnion(email)
  );
  /* (성능/Rules 수정) memberEmails가 실제로 바뀌는 시점(수락)이라
     이 차트의 작업/카테고리 복사값도 같이 맞춰준다. */
  await restampQuietly(chartId, data.ownerId, newMemberEmails);
}

export function setMemberRole(chartId, email, role) {
  email = lowerEmail(email);
  return updateDoc(doc(db, "charts", chartId), new FieldPath("members", email, "role"), role);
}

export async function removeMember(chartId, email) {
  const raw = String(email || "").trim();
  email = lowerEmail(raw);
  const chartRef = doc(db, "charts", chartId);
  const snap = await getDoc(chartRef);
  const data = snap.data() || {};
  const newMemberEmails = (data.memberEmails || []).filter((e) => e !== email && e !== raw);
  /* 예전에 대문자 섞인 이메일로 저장된 항목도 같이 지운다 */
  const fields = [
    new FieldPath("members", email), null,
    "memberEmails", arrayRemove(email, raw),
    "pendingEmails", arrayRemove(email, raw)
  ];
  if (raw && raw !== email) fields.push(new FieldPath("members", raw), null);
  await updateDoc(chartRef, ...fields);
  /* (성능/Rules 수정) memberEmails가 줄어드는 시점이라 작업/카테고리
     복사값도 같이 맞춰준다 — 안 하면 제거된 사람이 작업 문서에 남아있는
     옛 복사값 때문에 계속 읽을 수 있게 되는 보안 구멍이 생긴다.
     (보안 수정 이후로는 읽기 권한을 차트 문서로 확인하므로, 뷰어 본인이 나갈 때
     이 단계가 권한 때문에 실패해도 안전하다) */
  await restampQuietly(chartId, data.ownerId, newMemberEmails);
}

export async function revokeAllSharing(chartId) {
  const chartRef = doc(db, "charts", chartId);
  const snap = await getDoc(chartRef);
  const data = snap.data() || {};
  await updateDoc(chartRef, { members: {}, memberEmails: [], pendingEmails: [] });
  await restampChartAcl(chartId, data.ownerId, []);
}

/* 내 초대함: 아직 수락 안 한 초대가 있는 차트 목록 */
export function listenMyInvites(email, callback) {
  email = lowerEmail(email);
  return onSnapshot(
    query(collection(db, "charts"), where("pendingEmails", "array-contains", email)),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
  );
}

export async function getInvitesOnce(email) {
  email = lowerEmail(email);
  const snap = await getDocs(query(collection(db, "charts"), where("pendingEmails", "array-contains", email)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* 내가 소유한 차트 + 내가 멤버로 등록된 차트, 두 번 구독해서 합친다
   (Firestore가 "A이거나 B" 조건을 한 쿼리로 못 하므로). */
export function listenMyCharts(uid, email, callback) {
  email = lowerEmail(email);
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

export function listenTasks(chartId, callback, onError) {
  return onSnapshot(collection(db, "charts", chartId, "tasks"), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (error) => { if (onError) onError(error); else console.error(error); });
}

export async function getTasksOnce(chartId) {
  const snap = await getDocs(collection(db, "charts", chartId, "tasks"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getTaskOnce(chartId, taskId) {
  const snap = await getDoc(doc(db, "charts", chartId, "tasks", taskId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/* (성능/Rules 수정) 작업 문서 자체에 ownerId/memberEmails를 "복사"해서
   같이 저장해둔다. 예전엔 Rules가 작업 하나 읽을 때마다 부모 차트
   문서를 get()으로 또 읽어서 권한을 확인했는데, 이게 작업이 N개면
   N번의 숨은 추가 조회가 되어 느렸다. 이제 읽기 권한 체크는 이
   복사값만 보고 바로 판단하므로 get()이 전혀 필요 없다(아래
   firestore.rules 참고). acl은 { ownerId, memberEmails } — 호출하는
   쪽(app2.js)이 그 차트의 현재 값을 그대로 넘겨준다. */
export function createTask(chartId, data, acl = {}) {
  return addDoc(collection(db, "charts", chartId, "tasks"), {
    name: data.name || "", categoryId: data.categoryId || "",
    start: data.start || "", end: data.end || "",
    progress: Number(data.progress) || 0, color: data.color || "",
    memo: data.memo || "", target: data.target || "", owner: data.owner || "",
    order: Number(data.order) || 0,
    calendarEventId: "", updatedAt: serverTimestamp(),
    ownerId: acl.ownerId || "", memberEmails: acl.memberEmails || []
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

export function listenCategories(chartId, callback, onError) {
  return onSnapshot(collection(db, "charts", chartId, "categories"), (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, (error) => { if (onError) onError(error); else console.error(error); });
}

export async function getCategoriesOnce(chartId) {
  const snap = await getDocs(collection(db, "charts", chartId, "categories"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getCategoryOnce(chartId, categoryId) {
  const snap = await getDoc(doc(db, "charts", chartId, "categories", categoryId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function createCategory(chartId, data, acl = {}) {
  return addDoc(collection(db, "charts", chartId, "categories"), {
    name: data.name || "새 카테고리", color: data.color || "#4f8ef7",
    order: Number(data.order) || 0,
    ownerId: acl.ownerId || "", memberEmails: acl.memberEmails || []
  });
}

/* (성능/Rules 수정) 차트의 멤버가 바뀔 때(수락/삭제/전체해제) 그 차트의
   모든 작업·카테고리 문서에 찍혀있는 ownerId/memberEmails 복사값을
   한 번에 다시 맞춘다. 문서가 몇 개든 배치 쓰기 1~2번으로 끝나서(500개
   단위로 쪼갬), "읽을 때마다 N번 느려지는" 문제를 "멤버 바뀔 때만 잠깐"
   으로 옮기는 것 — 멤버 변경은 작업 읽기보다 훨씬 드물게 일어나므로
   전체적으로 훨씬 빠르다. */
export async function restampChartAcl(chartId, ownerId, memberEmails) {
  const [tasksSnap, catsSnap] = await Promise.all([
    getDocs(collection(db, "charts", chartId, "tasks")),
    getDocs(collection(db, "charts", chartId, "categories"))
  ]);
  const refs = tasksSnap.docs.map((d) => d.ref).concat(catsSnap.docs.map((d) => d.ref));
  for (let i = 0; i < refs.length; i += 450) {
    const batch = writeBatch(db);
    refs.slice(i, i + 450).forEach((ref) => batch.update(ref, { ownerId: ownerId || "", memberEmails: memberEmails || [] }));
    await batch.commit();
  }
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
  email = lowerEmail(email);
  const [ownedSnap, sharedSnap] = await Promise.all([
    getDocs(query(collection(db, "charts"), where("ownerId", "==", uid))),
    getDocs(query(collection(db, "charts"), where("memberEmails", "array-contains", email)))
  ]);
  const byId = {};
  ownedSnap.docs.forEach((d) => { byId[d.id] = { id: d.id, ...d.data() }; });
  sharedSnap.docs.forEach((d) => { byId[d.id] = { id: d.id, ...d.data() }; });
  return Object.values(byId);
}

/* =========================================================
 * ▼▼▼ 조직 관리 (1단계, 추가분) ▼▼▼
 * 기존 charts 데이터는 건드리지 않는 별도 컬렉션 2개.
 *
 *   organizations/{orgId}
 *     name, createdBy(uid), ownerEmail, createdAt
 *
 *   orgMemberships/{orgId}__{email}      ← 한 사람 · 한 조직당 문서 1개
 *     orgId, orgName, email(소문자), name, title(직급),
 *     role: "owner" | "admin" | "member" | "guest"   (소유자/관리자/참여자/게스트)
 *     status: "pending" | "accepted",
 *     invitedByEmail, invitedByName, createdAt, acceptedAt, updatedAt
 *
 * 초대받은 사람은 자기 문서만 읽을 수 있어서(보안 규칙) 수락 전에는
 * 조직 이름과 초대한 사람만 보이고, 수락한 뒤에야 조직원 목록을 본다.
 * 권한 검사는 app.js 화면 쪽과 firebase/firestore.rules 양쪽에서 한다.
 * ========================================================= */

export function orgMembershipId(orgId, email) {
  return orgId + "__" + String(email || "").trim().toLowerCase();
}

/* 조직 만들기: 조직 문서 + 만든 사람의 소유자 문서를 한 번에 */
export async function createOrganization(name, owner) {
  const orgRef = doc(collection(db, "organizations"));
  const email = String(owner.email || "").trim().toLowerCase();
  const batch = writeBatch(db);
  batch.set(orgRef, {
    name, createdBy: owner.uid, ownerEmail: email, createdAt: serverTimestamp()
  });
  batch.set(doc(db, "orgMemberships", orgMembershipId(orgRef.id, email)), {
    orgId: orgRef.id, orgName: name, email,
    name: owner.name || "", title: owner.title || "",
    role: "owner", status: "accepted",
    invitedByEmail: email, invitedByName: owner.name || "",
    createdAt: serverTimestamp(), acceptedAt: serverTimestamp()
  });
  await batch.commit();
  return orgRef.id;
}

/* 내가 속한(수락) + 초대받은(대기) 조직 문서들 */
export async function getMyOrgMemberships(email) {
  const snap = await getDocs(query(collection(db, "orgMemberships"),
    where("email", "==", String(email || "").trim().toLowerCase())));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/* 조직원 목록 (수락한 조직원만 읽을 수 있음) */
export async function getOrgMembers(orgId) {
  const snap = await getDocs(query(collection(db, "orgMemberships"), where("orgId", "==", orgId)));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getOrgMembershipOnce(orgId, email) {
  const snap = await getDoc(doc(db, "orgMemberships", orgMembershipId(orgId, email)));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export function inviteOrgMember(orgId, orgName, member, inviter) {
  const email = String(member.email || "").trim().toLowerCase();
  return setDoc(doc(db, "orgMemberships", orgMembershipId(orgId, email)), {
    orgId, orgName, email,
    name: member.name || "", title: member.title || "",
    role: member.role, status: "pending",
    invitedByEmail: String(inviter.email || "").toLowerCase(),
    invitedByName: inviter.name || "",
    createdAt: serverTimestamp()
  });
}

export function acceptOrgInvite(orgId, email) {
  return updateDoc(doc(db, "orgMemberships", orgMembershipId(orgId, email)), {
    status: "accepted", acceptedAt: serverTimestamp()
  });
}

/* 초대 거절 · 조직 나가기 · 내보내기(추방) 모두 문서 삭제 */
export function removeOrgMembership(orgId, email) {
  return deleteDoc(doc(db, "orgMemberships", orgMembershipId(orgId, email)));
}

export function updateOrgMember(orgId, email, fields) {
  return updateDoc(doc(db, "orgMemberships", orgMembershipId(orgId, email)), {
    ...fields, updatedAt: serverTimestamp()
  });
}

export async function getOrganizationOnce(orgId) {
  const snap = await getDoc(doc(db, "organizations", orgId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

/* 이름 바꾸기: 조직 문서 + 조직원 문서들의 orgName(초대받은 사람이 보는 이름) */
export async function renameOrganization(orgId, name, memberEmails) {
  const batch = writeBatch(db);
  batch.update(doc(db, "organizations", orgId), { name });
  memberEmails.forEach((email) => {
    batch.update(doc(db, "orgMemberships", orgMembershipId(orgId, email)), { orgName: name });
  });
  return batch.commit();
}

/* 소유권 넘기기: 받는 사람 → 소유자, 나 → 관리자 */
export function transferOrgOwnership(orgId, fromEmail, toEmail) {
  const batch = writeBatch(db);
  batch.update(doc(db, "orgMemberships", orgMembershipId(orgId, toEmail)), { role: "owner", updatedAt: serverTimestamp() });
  batch.update(doc(db, "orgMemberships", orgMembershipId(orgId, fromEmail)), { role: "admin", updatedAt: serverTimestamp() });
  batch.update(doc(db, "organizations", orgId), { ownerEmail: String(toEmail).toLowerCase() });
  return batch.commit();
}

/* 조직 삭제: 조직원 문서 전부 + 조직 문서 */
export async function deleteOrganization(orgId, memberEmails) {
  const batch = writeBatch(db);
  memberEmails.forEach((email) => batch.delete(doc(db, "orgMemberships", orgMembershipId(orgId, email))));
  batch.delete(doc(db, "organizations", orgId));
  return batch.commit();
}
/* ▲▲▲ 조직 관리 (1단계, 추가분) 끝 ▲▲▲ */


/* =========================================================
 * ▼▼▼ 조직 관리 (2단계, 추가분): 차트를 조직(원)에게 공유 ▼▼▼
 *
 *   charts/{chartId}
 *     orgIds: [orgId, ...]                 ← 최대 3개 (보안 규칙이 앞 3개까지만 확인)
 *     orgShares: {
 *       [orgId]: {
 *         orgName,
 *         all: true|false,                 ← 조직 전체 (나중에 들어온 조직원도 자동 포함)
 *         picked: { email: true },         ← all 이 아니면 고른 조직원만
 *         overrides: { email: "viewer"|"editor"|"admin" }   ← 이 차트에서만 바꾼 권한
 *       }
 *     }
 *   organizations/{orgId}/charts/{chartId}  ← 조직원이 "공유받은 차트"를 찾는 목록
 *     chartId, chartName, ownerEmail, sharedByEmail, sharedAt
 *
 * 조직을 통한 접근은 차트 members 에 이름을 적어 두지 않는다. 보안 규칙이
 * 그때그때 orgMemberships 를 확인하므로, 조직에서 나가거나 내보내지면 그
 * 즉시 접근이 끊기고, 나중에 들어온 조직원은 바로 접근할 수 있다.
 * [기존 권한] 게스트→뷰어, 참여자→편집자, 관리자·소유자→관리자
 * ========================================================= */

export const ORG_SHARE_LIMIT = 3;

export async function shareChartToOrg(chartId, orgId, share, meta) {
  const batch = writeBatch(db);
  batch.update(doc(db, "charts", chartId),
    new FieldPath("orgShares", orgId), {
      orgName: share.orgName || "",
      all: !!share.all,
      picked: share.picked || {},
      overrides: share.overrides || {}
    },
    "orgIds", arrayUnion(orgId)
  );
  batch.set(doc(db, "organizations", orgId, "charts", chartId), {
    chartId,
    chartName: meta.chartName || "",
    ownerEmail: meta.ownerEmail || "",
    sharedByEmail: String(meta.sharedByEmail || "").toLowerCase(),
    sharedAt: serverTimestamp()
  });
  return batch.commit();
}

/* 고른 조직원·권한 덮어쓰기만 바꿀 때 (목록 문서는 그대로) */
export function updateChartOrgShare(chartId, orgId, fields) {
  const args = [];
  Object.keys(fields).forEach((key) => {
    args.push(new FieldPath("orgShares", orgId, key), fields[key]);
  });
  return updateDoc(doc(db, "charts", chartId), ...args);
}

export function setChartOrgOverride(chartId, orgId, email, role) {
  return updateDoc(doc(db, "charts", chartId),
    new FieldPath("orgShares", orgId, "overrides", String(email).toLowerCase()), role ? role : deleteField());
}

export function setChartOrgPicked(chartId, orgId, email, picked) {
  return updateDoc(doc(db, "charts", chartId),
    new FieldPath("orgShares", orgId, "picked", String(email).toLowerCase()), picked ? true : deleteField());
}

export async function unshareChartFromOrg(chartId, orgId) {
  const batch = writeBatch(db);
  batch.update(doc(db, "charts", chartId),
    new FieldPath("orgShares", orgId), deleteField(),
    "orgIds", arrayRemove(orgId)
  );
  batch.delete(doc(db, "organizations", orgId, "charts", chartId));
  return batch.commit();
}

/* 차트를 지우기 전에 조직 목록 문서부터 정리 (차트가 없어지면 규칙이 확인을 못 한다) */
export async function removeChartOrgIndexes(chartId, orgIds) {
  if (!orgIds || !orgIds.length) return;
  const batch = writeBatch(db);
  orgIds.forEach((orgId) => batch.delete(doc(db, "organizations", orgId, "charts", chartId)));
  return batch.commit();
}

export async function getOrgChartIndex(orgId) {
  const snap = await getDocs(collection(db, "organizations", orgId, "charts"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
/* ▲▲▲ 조직 관리 (2단계, 추가분) 끝 ▲▲▲ */

/* ----- (요청사항) 첫 화면 안내: 사용자별 "안내를 봤음" 표시 ----- */
export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

export function mergeUserOnboarding(uid, flags) {
  return setDoc(doc(db, "users", uid), { onboarding: flags, updatedAt: serverTimestamp() }, { merge: true });
}

/* ----- (요청사항) 마감 알림 메일: 받는 사람 목록과 수신 설정 ----- */
export function mergeUserProfile(uid, fields) {
  return setDoc(doc(db, "users", uid), { ...fields, updatedAt: serverTimestamp() }, { merge: true });
}
