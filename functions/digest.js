/* (요청사항) 마감 알림 — 누구에게, 언제, 무엇을 보낼지 고르고 내용을 만든다.
   Firestore·발송과 떨어진 순수 함수라 test-digest.js 로 바로 확인할 수 있다.

   알림 단계 (진행률 100% 인 작업은 어떤 알림도 없음)
   - D-15 ~ : 사이트 안 알림(종 버튼) — 여기서는 다루지 않음
   - D-7    : 메일 한 번
   - D-2, D-1, 당일 : 웹 푸시
   - 지연    : "지연 확인"(overdueAck)을 누르기 전까지 하루 한 번 웹 푸시

   받는 사람
   - 담당자를 조직원 목록에서 고른 작업(ownerEmail 있음) → 그 담당자
   - 담당자가 없거나 이름만 적은 작업 → 차트 소유자
   - 이 사이트에 로그인한 적이 있는 사람(users 문서)만. 메일은 notify.email 을 끄지 않은 사람,
     푸시는 notify.push 를 켜고 푸시 토큰이 있는 사람 */

const MAIL_DAYS_BEFORE = 7;
const PUSH_DAYS_BEFORE = [2, 1, 0];

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
      const to = lower(task.ownerEmail) || lower(chart.ownerEmail);
      const user = byEmail.get(to);
      if (!user) return;

      const item = {
        chartName: chart.name || "이름 없는 차트",
        name: task.name || "이름 없는 작업",
        end: task.end,
        progress,
        owner: task.owner || "",
        left
      };

      if (left === MAIL_DAYS_BEFORE && !(user.notify && user.notify.email === false)) {
        add(mails, to, item);
      }
      const wantsPush = user.notify && user.notify.push === true && Array.isArray(user.pushTokens) && user.pushTokens.length;
      if (wantsPush && (PUSH_DAYS_BEFORE.includes(left) || (left < 0 && !task.overdueAck))) {
        add(pushes, to, item);
      }
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

/* D-7 메일 */
function renderMail(notice, siteUrl) {
  const subject = "[간트차트] 일주일 뒤 마감 " + notice.items.length + "건";
  const hello = notice.name ? escapeHtml(notice.name) + " 님, " : "";
  const rows = notice.items.map((i) =>
    '<div style="padding:10px 12px;margin-bottom:6px;border-radius:10px;background:#f8faf9">' +
      '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#e3f2ed;color:#0f766e;font-size:12px;font-weight:700">D-7</span> ' +
      '<b style="font-size:14px;color:#18181b">' + escapeHtml(i.name) + "</b>" +
      '<div style="margin-top:4px;font-size:12px;color:#71717a">' + escapeHtml(i.chartName) + " · 종료일 " + escapeHtml(i.end) + " · 진행률 " + i.progress + "%</div></div>").join("");
  const html =
    '<div style="max-width:560px;margin:0 auto;padding:24px;font-family:-apple-system,\'Pretendard\',\'Malgun Gothic\',sans-serif;color:#27272a">' +
      '<div style="padding:18px 20px;border-radius:14px;background:#0f766e;color:#fff"><b style="font-size:17px">일주일 뒤 마감</b>' +
        '<div style="margin-top:4px;font-size:13px;opacity:.85">' + hello + "다음 주에 끝나야 하는 작업이에요.</div></div>" +
      '<div style="margin-top:18px">' + rows + "</div>" +
      '<p style="margin-top:22px"><a href="' + escapeHtml(siteUrl) + '" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#0f766e;color:#fff;text-decoration:none;font-weight:700;font-size:13px">간트차트 열기</a></p>' +
      '<p style="font-size:11.5px;color:#a1a1aa">마감 7일 전에 한 번만 보내요. 그만 받으려면 사이트 오른쪽 위 종 버튼에서 메일 받기를 끄세요.</p></div>';
  const text = "일주일 뒤 마감 " + notice.items.length + "건\n\n" +
    notice.items.map((i) => "- " + i.name + " (" + i.chartName + ", 종료일 " + i.end + ", " + i.progress + "%)").join("\n") + "\n\n" + siteUrl;
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

module.exports = { buildNotices, renderMail, renderPush, seoulTodayKey, daysBetween, MAIL_DAYS_BEFORE, PUSH_DAYS_BEFORE };
