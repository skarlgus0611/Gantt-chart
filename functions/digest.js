/* (요청사항) 마감 알림 — 누구에게, 언제, 무엇을 보낼지 고르고 내용을 만든다.
   Firestore·발송과 떨어진 순수 함수라 test-digest.js 로 바로 확인할 수 있다.

   알림 단계 (진행률 100% 인 작업은 어떤 알림도 없음)
   - D-15 : 사이트 안 — 여기서는 다루지 않음
   - D-7  : 사이트 안 + 메일
   - D-1  : 사이트 안 + 메일 + 웹 푸시
   - D+1  : 사이트 안 + 메일 + 웹 푸시 (지연 첫날)
   - D+2~ : 사이트 안 + 웹 푸시 매일 — "지연 확인"(overdueAck) 또는 완료 전까지

   받는 사람: 담당자가 정해져 있고(이메일) 이 사이트에 가입한(users 문서) 경우 그 담당자만.
   그 밖의 경우(담당자 없음 · 이메일 없음 · 미가입)는 아무에게도 보내지 않는다.
   메일은 notify.email 을 끄지 않은 사람, 푸시는 notify.push 를 켜고 푸시 토큰이 있는 사람 */

/* 남은 날(종료일 - 오늘). 음수는 지연 */
const MAIL_DAYS = [7, 1, -1];
const PUSH_DAYS = [1];

function keyToUtc(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function daysBetween(fromKey, toKey) {
  const a = keyToUtc(fromKey);
  const b = keyToUtc(toKey);
  return a === null || b === null ? null : Math.round((b - a) / 86400000);
}

/* 서울 기준 오늘 (YYYY-MM-DD) */
function seoulTodayKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function normProgress(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function buildNotices({ users, charts, tasksByChart, todayKey }) {
  const byEmail = new Map();
  (users || []).forEach((u) => {
    const email = lower(u.email);
    if (email) byEmail.set(email, u);
  });

  const mails = new Map();
  const pushes = new Map();
  const add = (map, key, item) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  };

  (charts || []).forEach((chart) => {
    (tasksByChart[chart.id] || []).forEach((task) => {
      const progress = normProgress(task.progress);
      if (progress >= 100 || !task.end) return;
      const left = daysBetween(todayKey, task.end);
      if (left === null) return;
      const overdueOpen = left < 0 && !task.overdueAck;
      const isMailDay = MAIL_DAYS.includes(left) && (left >= 0 || overdueOpen);
      const isPushDay = PUSH_DAYS.includes(left) || overdueOpen;
      if (!isMailDay && !isPushDay) return;

      /* 담당자가 정해져 있고 가입한 사람일 때만 */
      const email = lower(task.ownerEmail);
      const user = email && byEmail.get(email);
      if (!user) return;
      const item = {
        chartName: chart.name || "이름 없는 차트",
        name: task.name || "이름 없는 작업",
        end: task.end,
        progress,
        owner: task.owner || "",
        left
      };
      if (isMailDay && !(user.notify && user.notify.email === false)) add(mails, email, item);
      const wantsPush = user.notify && user.notify.push === true && Array.isArray(user.pushTokens) && user.pushTokens.length;
      if (isPushDay && wantsPush) add(pushes, email, item);
    });
  });

  const sortItems = (items) => items.sort((a, b) => a.left - b.left);
  return {
    mails: Array.from(mails.entries()).map(([email, items]) => ({ email, name: byEmail.get(email).name || "", items: sortItems(items) })),
    pushes: Array.from(pushes.entries()).map(([email, items]) => {
      const user = byEmail.get(email);
      return { email, uid: user.uid, tokens: user.pushTokens.slice(), items: sortItems(items) };
    })
  };
}

function chipText(left) {
  return left < 0 ? "지연 " + (-left) + "일" : left === 0 ? "오늘 마감" : "D-" + left;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 메일: D-7 · D-1 · 지연 첫날을 한 통에 묶어서 */
function renderMail(notice, siteUrl) {
  const groups = [
    ["지연", (i) => i.left < 0, "#b91c1c", "#fee2e2"],
    ["내일 마감", (i) => i.left === 1, "#b45309", "#fef3c7"],
    ["일주일 뒤 마감", (i) => i.left === 7, "#0f766e", "#e3f2ed"]
  ];
  const summary = groups.map(([label, test]) => [label, notice.items.filter(test).length]).filter(([, n]) => n).map(([label, n]) => label + " " + n + "건").join(" · ");
  const subject = "[간트차트] " + summary;
  const hello = notice.name ? escapeHtml(notice.name) + " 님, " : "";
  const sections = groups.map(([label, test, color, bg]) => {
    const list = notice.items.filter(test);
    if (!list.length) return "";
    return '<h3 style="margin:20px 0 8px;font-size:14px;color:' + color + '">' + label + " " + list.length + "</h3>" +
      list.map((i) =>
        '<div style="padding:10px 12px;margin-bottom:6px;border-radius:10px;background:#f8faf9">' +
          '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:' + bg + ";color:" + color + ';font-size:12px;font-weight:700">' + chipText(i.left) + "</span> " +
          '<b style="font-size:14px;color:#18181b">' + escapeHtml(i.name) + "</b>" +
          '<div style="margin-top:4px;font-size:12px;color:#71717a">' + escapeHtml(i.chartName) + " · 종료일 " + escapeHtml(i.end) + " · 진행률 " + i.progress + "%</div></div>").join("");
  }).join("");
  const html =
    '<div style="max-width:560px;margin:0 auto;padding:24px;font-family:-apple-system,\'Pretendard\',\'Malgun Gothic\',sans-serif;color:#27272a">' +
      '<div style="padding:18px 20px;border-radius:14px;background:#0f766e;color:#fff"><b style="font-size:17px">마감 알림</b>' +
        '<div style="margin-top:4px;font-size:13px;opacity:.85">' + hello + escapeHtml(summary) + "</div></div>" +
      sections +
      '<p style="margin-top:22px"><a href="' + escapeHtml(siteUrl) + '" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#0f766e;color:#fff;text-decoration:none;font-weight:700;font-size:13px">간트차트 열기</a></p>' +
      '<p style="font-size:11.5px;color:#a1a1aa">마감 7일 전 · 1일 전 · 지연 첫날에만 보내요. 그만 받으려면 사이트 오른쪽 위 종 버튼 설정에서 메일을 끄세요.</p></div>';
  const text = summary + "\n\n" +
    notice.items.map((i) => "- [" + chipText(i.left) + "] " + i.name + " (" + i.chartName + ", 종료일 " + i.end + ", " + i.progress + "%)").join("\n") + "\n\n" + siteUrl;
  return { subject, html, text };
}

/* 웹 푸시 한 통에 묶어서: 제목은 가장 급한 것, 내용은 작업 이름들 */
function renderPush(notice) {
  const overdue = notice.items.filter((i) => i.left < 0).length;
  const today = notice.items.filter((i) => i.left === 0).length;
  const soon = notice.items.filter((i) => i.left > 0).length;
  const parts = [];
  if (overdue) parts.push("지연 " + overdue);
  if (today) parts.push("오늘 마감 " + today);
  if (soon) parts.push("곧 마감 " + soon);
  const title = "마감 알림 · " + parts.join(" · ");
  const lines = notice.items.slice(0, 4).map((i) => "[" + chipText(i.left) + "] " + i.name);
  if (notice.items.length > 4) lines.push("외 " + (notice.items.length - 4) + "건");
  return { title, body: lines.join("\n") };
}

module.exports = { buildNotices, renderMail, renderPush, seoulTodayKey, daysBetween, MAIL_DAYS, PUSH_DAYS };
