/* (요청사항) 마감 알림 메일 — 누구에게, 언제 보낼지 고르고 내용을 만든다.
   Firestore·발송과 떨어진 순수 함수라 test-digest.js 로 바로 확인할 수 있다.

   언제 (진행률 100% 이거나 "지연 확인"(overdueAck)을 누른 작업은 보내지 않음)
   - 마감 전: D-15 · D-7 · D-1 · 당일
   - 지연   : 1 · 4 · 7일째, 그 뒤로는 일주일마다(14 · 21 · 28 …일째)
   사이트 안 알림(종 버튼)은 사이트가 직접 계산하므로 여기서는 다루지 않는다.

   누구에게: 담당자가 정해져 있고(이메일) 이 사이트에 가입한(users 문서) 경우 그 담당자만.
   그 밖의 경우(담당자 없음 · 이메일 없음 · 미가입), notify.email 을 끈 사람에게는 보내지 않는다. */

const MAIL_DAYS_BEFORE = [15, 7, 1, 0];
const MAIL_OVERDUE_DAYS = [1, 4, 7];

/* 오늘(남은 날 left, 음수는 지연) 메일을 보내는 날인가 */
function isMailDay(left, overdueAck) {
  if (left >= 0) return MAIL_DAYS_BEFORE.includes(left);
  if (overdueAck) return false;
  const late = -left;
  return MAIL_OVERDUE_DAYS.includes(late) || (late > 7 && late % 7 === 0);
}

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
  (charts || []).forEach((chart) => {
    (tasksByChart[chart.id] || []).forEach((task) => {
      const progress = normProgress(task.progress);
      if (progress >= 100 || !task.end) return;
      const left = daysBetween(todayKey, task.end);
      if (left === null || !isMailDay(left, !!task.overdueAck)) return;

      /* 담당자가 정해져 있고 가입한 사람일 때만 */
      const email = lower(task.ownerEmail);
      const user = email && byEmail.get(email);
      if (!user || (user.notify && user.notify.email === false)) return;

      if (!mails.has(email)) mails.set(email, []);
      mails.get(email).push({
        chartName: chart.name || "이름 없는 차트",
        name: task.name || "이름 없는 작업",
        end: task.end,
        progress,
        owner: task.owner || "",
        left
      });
    });
  });

  return {
    mails: Array.from(mails.entries()).map(([email, items]) => ({
      email, name: byEmail.get(email).name || "", items: items.sort((a, b) => a.left - b.left)
    }))
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 메일: 그날 보낼 작업을 한 통에 묶어서 — 차트별로 한 줄씩, D-표시만 크고 굵게 색으로 */
function dLabel(left) {
  return left < 0 ? "D+" + (-left) : left === 0 ? "D-day" : "D-" + left;
}

function dColor(left) {
  return left < 0 ? "#dc2626" : left === 0 ? "#ea580c" : left === 1 ? "#d97706" : left === 7 ? "#0f766e" : "#64748b";
}

function shortDate(key) {
  const m = String(key).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? m[1] + "." + m[2] : String(key);
}

function renderMail(notice, siteUrl) {
  const groups = [
    ["지연", "D+", -1, (i) => i.left < 0],
    ["오늘 마감", "D-day", 0, (i) => i.left === 0],
    ["내일 마감", "D-1", 1, (i) => i.left === 1],
    ["일주일 뒤 마감", "D-7", 7, (i) => i.left === 7],
    ["15일 뒤 마감", "D-15", 15, (i) => i.left === 15]
  ];
  const counts = groups.map(([label, short, left, test]) => ({ label, short, left, n: notice.items.filter(test).length })).filter((g) => g.n);
  const subject = "[간트차트] " + counts.map((g) => g.label + " " + g.n + "건").join(" · ");
  const font = "font-family:-apple-system,'Pretendard','Malgun Gothic',sans-serif;";

  const byChart = new Map();
  notice.items.forEach((i) => {
    if (!byChart.has(i.chartName)) byChart.set(i.chartName, []);
    byChart.get(i.chartName).push(i);
  });
  const rows = Array.from(byChart.entries()).map(([chartName, list]) =>
    '<tr><td colspan="3" style="padding:16px 0 4px;font-size:11.5px;color:#71717a;font-weight:700">' + escapeHtml(chartName) + "</td></tr>" +
    list.map((i) =>
      '<tr style="border-top:1px solid #ececec">' +
        '<td style="padding:8px 10px 8px 0;width:1%;white-space:nowrap;font-size:18px;font-weight:800;letter-spacing:-.3px;color:' + dColor(i.left) + '">' + dLabel(i.left) + "</td>" +
        '<td style="padding:8px 0;font-size:14px;color:#18181b">' + escapeHtml(i.name) + "</td>" +
        '<td style="padding:8px 0 8px 8px;width:1%;white-space:nowrap;text-align:right;font-size:12px;color:#a1a1aa">' + shortDate(i.end) + " · " + i.progress + "%</td></tr>"
    ).join("")
  ).join("");

  const stats = counts.map((g) =>
    '<span style="display:inline-block;margin:6px 14px 0 0;white-space:nowrap;font-size:19px;font-weight:800;color:' + dColor(g.left) + '">' + g.short +
    ' <span style="font-size:12px;font-weight:700">' + g.n + "건</span></span>").join("");
  const html =
    '<div style="max-width:560px;margin:0 auto;padding:16px;' + font + 'color:#27272a">' +
      '<div style="padding-bottom:12px;border-bottom:2px solid #18181b"><div style="font-size:13px;font-weight:700;color:#0f766e">간트차트 마감 알림</div>' + stats + "</div>" +
      '<table role="presentation" style="width:100%;border-collapse:collapse">' + rows + "</table>" +
      '<p style="margin:20px 0 8px"><a href="' + escapeHtml(siteUrl) + '" style="display:inline-block;padding:9px 18px;border-radius:999px;background:#0f766e;color:#fff;text-decoration:none;font-weight:700;font-size:13px">간트차트 열기</a></p>' +
      '<p style="margin:0;font-size:11px;color:#a1a1aa">완료하거나 [지연 확인]을 누르면 그만 보내요 · 메일 끄기: 종 버튼 → 설정</p></div>';
  const text = counts.map((g) => g.label + " " + g.n + "건").join(" · ") + "\n\n" +
    notice.items.map((i) => "- " + dLabel(i.left) + "  " + i.name + " (" + i.chartName + ", " + i.end + ", " + i.progress + "%)").join("\n") + "\n\n" + siteUrl;
  return { subject, html, text };
}

module.exports = { buildNotices, renderMail, seoulTodayKey, daysBetween, isMailDay };
