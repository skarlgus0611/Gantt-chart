/* (요청사항) 마감 알림 메일 — 누구에게, 언제 보낼지 고르고 내용을 만든다.
   Firestore·발송과 떨어진 순수 함수라 test-digest.js 로 바로 확인할 수 있다.

   언제 (진행률 100% 이거나 "지연 확인"(overdueAck)을 누른 작업은 보내지 않음)
   - 마감 전: D-30 · D-15 · D-7 · D-4 · D-1 · 당일
   - 지연   : 1 · 4 · 7일째, 그 뒤로는 일주일마다(14 · 21 · 28 …일째) 끝날 때까지
   사이트 안 알림(종 버튼)은 사이트가 직접 계산하므로 여기서는 다루지 않는다.

   누구에게: 담당자가 정해져 있고(이메일) 이 사이트에 가입한(users 문서) 경우 그 담당자만.
   그 밖의 경우(담당자 없음 · 이메일 없음 · 미가입), notify.email 을 끈 사람에게는 보내지 않는다.

   (요청사항) 일정 메일 — 위 마감 알림과 따로, 본인이 정한 주기마다 일정 전체를 한 통으로.
   users/{uid}.notify.digest = { on, every: 숫자, unit: "d"|"w"|"m", scope: "mine"|"charts", since: "YYYY-MM-DD" }
   (없거나 on 이 false 면 꺼짐). 설정한 다음 날 첫 메일, 그 뒤 주기마다.
   scope "mine" = 내가 담당인 작업, "charts" = 내가 소유·참여한 차트의 모든 작업.
   (요청사항) 마감이 아니라 "앞으로 할 일"에 맞춘다: 오늘 기준으로 아직 안 끝난 기간의 작업만
   (진행 중 + 앞으로 시작). 이미 마감이 지난 작업은 마감 알림 메일이 맡는다. 완료(100%)는 빼고. */

const MAIL_DAYS_BEFORE = [30, 15, 7, 4, 1, 0];
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

function addDaysKey(key, days) {
  const t = keyToUtc(key);
  return t === null ? null : new Date(t + days * 86400000).toISOString().slice(0, 10);
}

/* 달 단위: 같은 날짜(그 달에 없으면 말일) */
function addMonthsKey(key, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
  if (!m) return null;
  const total = Number(m[1]) * 12 + Number(m[2]) - 1 + months;
  const y = Math.floor(total / 12);
  const mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, mo, Math.min(Number(m[3]), last))).toISOString().slice(0, 10);
}

const DIGEST_UNITS = { d: 1, w: 7 };

/* 일정 메일을 오늘 보내는 날인가 — 설정한 다음 날이 첫날, 그 뒤 주기마다 */
function isDigestDay(digest, todayKey) {
  if (!digest || !digest.since || digest.on === false) return false;
  const every = Math.floor(Number(digest.every));
  if (!(every >= 1)) return false;
  const first = addDaysKey(digest.since, 1);
  const diff = daysBetween(first, todayKey);
  if (diff === null || diff < 0) return false;
  if (DIGEST_UNITS[digest.unit]) return diff % (every * DIGEST_UNITS[digest.unit]) === 0;
  if (digest.unit !== "m") return false;
  const a = /^(\d{4})-(\d{2})/.exec(first);
  const b = /^(\d{4})-(\d{2})/.exec(todayKey);
  const months = (Number(b[1]) - Number(a[1])) * 12 + Number(b[2]) - Number(a[2]);
  return months >= 0 && months % every === 0 && addMonthsKey(first, months) === todayKey;
}

function digestEveryText(digest) {
  const n = Math.floor(Number(digest.every)) || 1;
  if (digest.unit === "d") return n === 1 ? "매일" : n + "일마다";
  if (digest.unit === "w") return n === 1 ? "매주" : n + "주마다";
  return n === 1 ? "매달" : n + "달마다";
}

function buildDigests({ users, charts, tasksByChart, todayKey }) {
  const out = [];
  (users || []).forEach((user) => {
    const digest = user.notify && user.notify.digest;
    const email = lower(user.email);
    if (!email || !isDigestDay(digest, todayKey)) return;
    const allCharts = digest.scope === "charts";
    const items = [];
    (charts || []).forEach((chart) => {
      if (allCharts && chart.ownerId !== user.uid && !(chart.memberEmails || []).map(lower).includes(email)) return;
      (tasksByChart[chart.id] || []).forEach((task) => {
        const progress = normProgress(task.progress);
        if (progress >= 100 || !task.end) return;
        if (!allCharts && lower(task.ownerEmail) !== email) return;
        const left = daysBetween(todayKey, task.end);
        if (left === null || left < 0) return; // 마감이 지난 작업은 마감 알림 메일에서
        const toStart = task.start ? daysBetween(todayKey, task.start) : null;
        items.push({
          chartName: chart.name || "이름 없는 차트",
          name: task.name || "이름 없는 작업",
          start: task.start || "",
          end: task.end,
          progress,
          owner: task.owner || "",
          left,
          toStart: toStart === null ? 0 : toStart
        });
      });
    });
    if (!items.length) return;
    /* 지금 하는 일 먼저, 그다음 시작이 빠른 순 */
    items.sort((a, b) => Math.max(0, a.toStart) - Math.max(0, b.toStart) || a.left - b.left);
    out.push({ email, name: user.name || "", scope: allCharts ? "charts" : "mine", every: digestEveryText(digest), items });
  });
  return out;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 메일: 그날 보낼 작업을 한 통에 묶어서 — 차트별로 한 줄씩, D-표시만 크고 굵게 색으로 */
function dLabel(left) {
  if (left === null || left === undefined) return "—";
  return left < 0 ? "D+" + (-left) : left === 0 ? "D-day" : "D-" + left;
}

function dColor(left) {
  if (left === null || left === undefined) return "#94a3b8";
  return left < 0 ? "#dc2626" : left === 0 ? "#ea580c" : left === 1 ? "#d97706" : left <= 7 ? "#0f766e" : "#64748b";
}

function dTint(left) {
  if (left === null || left === undefined) return "#f4f4f5";
  return left < 0 ? "#fee2e2" : left === 0 ? "#ffedd5" : left === 1 ? "#fef3c7" : left <= 7 ? "#dcf1ea" : "#eef1f5";
}

function shortDate(key) {
  const m = String(key).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? m[1] + "." + m[2] : String(key);
}

const MAIL_FONT = "font-family:-apple-system,'Pretendard','Malgun Gothic',sans-serif;";

/* 메일 틀 — 맨 위 단계별 색 타일, 아래는 차트별로 한 줄씩 [D-표시] 작업명 · 종료일 · 진행률 */
function mailHtml({ title, tiles, items, siteUrl, footer, showOwner, showRange }) {
  const byChart = new Map();
  items.forEach((i) => {
    if (!byChart.has(i.chartName)) byChart.set(i.chartName, []);
    byChart.get(i.chartName).push(i);
  });
  const rows = Array.from(byChart.entries()).map(([chartName, list]) =>
    '<tr><td colspan="3" style="padding:16px 0 4px;font-size:11.5px;color:#71717a;font-weight:700">' + escapeHtml(chartName) + "</td></tr>" +
    list.map((i) => {
      const when = showRange && i.start ? shortDate(i.start) + "–" + shortDate(i.end) : (i.end ? shortDate(i.end) : "날짜 없음");
      const meta = (showOwner && i.owner ? escapeHtml(i.owner) + " · " : "") + when + " · " + i.progress + "%";
      return '<tr style="border-top:1px solid #ececec">' +
        '<td style="padding:8px 10px 8px 0;width:1%;white-space:nowrap;font-size:18px;font-weight:800;letter-spacing:-.3px;color:' + dColor(i.left) + '">' + dLabel(i.left) + "</td>" +
        '<td style="padding:8px 0;font-size:14px;color:#18181b">' + escapeHtml(i.name) + "</td>" +
        '<td style="padding:8px 0 8px 8px;width:1%;white-space:nowrap;text-align:right;font-size:12px;color:#a1a1aa">' + meta + "</td></tr>";
    }).join("")
  ).join("");

  /* 맨 위: 단계별 타일 — 색 바탕에 큰 숫자, 아래 작은 D-표시 */
  const stats = '<table role="presentation" style="width:100%;border-collapse:collapse;margin-top:10px;table-layout:fixed"><tr>' +
    tiles.map((g, k) =>
      '<td style="padding:0 ' + (k === tiles.length - 1 ? 0 : 6) + 'px 0 0"><div style="padding:10px 4px 8px;border-radius:12px;background:' + dTint(g.left) + ';text-align:center">' +
        '<div style="font-size:24px;line-height:1;font-weight:800;color:' + dColor(g.left) + '">' + g.n + "</div>" +
        '<div style="margin-top:5px;font-size:12px;font-weight:700;color:' + dColor(g.left) + '">' + g.short + "</div></div></td>").join("") +
    "</tr></table>";
  return '<div style="max-width:560px;margin:0 auto;padding:16px;' + MAIL_FONT + 'color:#27272a">' +
      '<div style="padding-bottom:14px;border-bottom:1px solid #e4e4e7"><div style="font-size:13px;font-weight:700;color:#0f766e">' + escapeHtml(title) + "</div>" + stats + "</div>" +
      '<table role="presentation" style="width:100%;border-collapse:collapse">' + rows + "</table>" +
      '<p style="margin:20px 0 8px"><a href="' + escapeHtml(siteUrl) + '" style="display:inline-block;padding:9px 18px;border-radius:999px;background:#0f766e;color:#fff;text-decoration:none;font-weight:700;font-size:13px">간트차트 열기</a></p>' +
      '<p style="margin:0;font-size:11px;color:#a1a1aa">' + escapeHtml(footer) + "</p></div>";
}

function mailText(summary, items, siteUrl) {
  return summary + "\n\n" +
    items.map((i) => "- " + dLabel(i.left) + "  " + i.name + " (" + i.chartName + ", " + (i.end || "날짜 없음") + ", " + i.progress + "%)").join("\n") + "\n\n" + siteUrl;
}

function renderMail(notice, siteUrl) {
  const groups = [
    ["지연", "D+", -1, (i) => i.left < 0],
    ["오늘 마감", "D-day", 0, (i) => i.left === 0],
    ["내일 마감", "D-1", 1, (i) => i.left === 1],
    ["4일 뒤 마감", "D-4", 4, (i) => i.left === 4],
    ["일주일 뒤 마감", "D-7", 7, (i) => i.left === 7],
    ["15일 뒤 마감", "D-15", 15, (i) => i.left === 15],
    ["30일 뒤 마감", "D-30", 30, (i) => i.left === 30]
  ];
  const tiles = groups.map(([label, short, left, test]) => ({ label, short, left, n: notice.items.filter(test).length })).filter((g) => g.n);
  const summary = tiles.map((g) => g.label + " " + g.n + "건").join(" · ");
  return {
    subject: "[간트차트] " + summary,
    html: mailHtml({ title: "간트차트 마감 알림", tiles, items: notice.items, siteUrl, footer: "완료하거나 [지연 확인]을 누르면 그만 보내요 · 메일 끄기: 사이트의 종 버튼" }),
    text: mailText(summary, notice.items, siteUrl)
  };
}

/* 일정 메일: 끝나지 않은 작업 전체 — 지연 · 7일 안 · 그 뒤 · 날짜 없음 */
/* 일정 메일: 앞으로 할 일 — 진행 중 · 7일 안 시작 · 그 뒤 시작 */
function renderDigest(digest, siteUrl) {
  const groups = [
    ["진행 중", "진행 중", 0, (i) => i.toStart <= 0],
    ["7일 안 시작", "7일 안 시작", 7, (i) => i.toStart > 0 && i.toStart <= 7],
    ["그 뒤 시작", "그 뒤 시작", 30, (i) => i.toStart > 7]
  ];
  const tiles = groups.map(([label, short, left, test]) => ({ label, short, left, n: digest.items.filter(test).length })).filter((g) => g.n);
  const whose = digest.scope === "charts" ? "내 차트" : "내 작업";
  const summary = whose + " " + digest.items.length + "건 · " + tiles.map((g) => g.label + " " + g.n).join(" · ");
  return {
    subject: "[간트차트] 앞으로 할 일 · " + summary,
    html: mailHtml({
      title: "간트차트 앞으로 할 일 · " + whose + " · " + digest.every, tiles, items: digest.items, siteUrl,
      showOwner: digest.scope === "charts", showRange: true,
      footer: "오늘부터 할 일만 보여 줘요(완료 · 마감 지난 작업 제외) · 주기 바꾸기·끄기: 사이트의 종 버튼"
    }),
    text: mailText(summary, digest.items, siteUrl)
  };
}

module.exports = { buildNotices, renderMail, buildDigests, renderDigest, isDigestDay, seoulTodayKey, daysBetween, isMailDay };
