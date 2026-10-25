/* (요청사항) 마감 알림 메일 — 누구에게, 언제 보낼지 고르고 내용을 만든다.
   Firestore·발송과 떨어진 순수 함수라 test-digest.js 로 바로 확인할 수 있다.

   언제 (진행률 100% 이거나 "지연 확인"(overdueAck)을 누른 작업은 보내지 않음)
   - 마감 전: D-7 · D-1 · 당일
   - 지연   : 1 · 3 · 7일째, 그 뒤로는 일주일마다(14 · 21 · 28 …일째)
   사이트 안 알림(종 버튼)은 사이트가 직접 계산하므로 여기서는 다루지 않는다.

   누구에게: 담당자가 정해져 있고(이메일) 이 사이트에 가입한(users 문서) 경우 그 담당자만.
   그 밖의 경우(담당자 없음 · 이메일 없음 · 미가입), notify.email 을 끈 사람에게는 보내지 않는다. */

const MAIL_DAYS_BEFORE = [7, 1, 0];
const MAIL_OVERDUE_DAYS = [1, 3, 7];

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

function chipText(left) {
  return left < 0 ? "지연 " + (-left) + "일" : left === 0 ? "오늘 마감" : "D-" + left;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 메일: 그날 보낼 작업을 한 통에 묶어서 */
function renderMail(notice, siteUrl) {
  const groups = [
    ["지연", (i) => i.left < 0, "#b91c1c", "#fee2e2"],
    ["오늘 마감", (i) => i.left === 0, "#c2410c", "#ffedd5"],
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
      '<p style="font-size:11.5px;color:#a1a1aa">마감 7일 전 · 1일 전 · 당일, 지연되면 1 · 3 · 7일째와 그 뒤 매주 보내요. 완료하거나 [지연 확인]을 누르면 그만 보내요. 그만 받으려면 사이트 오른쪽 위 종 버튼 설정에서 메일을 끄세요.</p></div>';
  const text = summary + "\n\n" +
    notice.items.map((i) => "- [" + chipText(i.left) + "] " + i.name + " (" + i.chartName + ", 종료일 " + i.end + ", " + i.progress + "%)").join("\n") + "\n\n" + siteUrl;
  return { subject, html, text };
}

module.exports = { buildNotices, renderMail, seoulTodayKey, daysBetween, isMailDay };
