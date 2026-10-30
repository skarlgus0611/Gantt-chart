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
      email, name: byEmail.get(email).name || "", todayKey, items: items.sort((a, b) => a.left - b.left)
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
    out.push({ email, name: user.name || "", scope: allCharts ? "charts" : "mine", every: digestEveryText(digest), todayKey, items });
  });
  return out;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* 메일 공통 — D-표시 색 · 바탕 */
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

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function shortDate(key) {
  const m = String(key).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? Number(m[1]) + "." + Number(m[2]) : String(key);
}

function weekday(key) {
  const d = keyToUtc(key);
  return d === null ? "" : WEEKDAYS[new Date(d).getUTCDay()];
}

function longDate(key) {
  const m = String(key).match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? Number(m[1]) + "월 " + Number(m[2]) + "일 (" + weekday(key) + ")" : "";
}

const MAIL_FONT = "font-family:-apple-system,'Pretendard','Malgun Gothic',sans-serif;";
const C_TEAL = "#0f766e";
const C_GRAY = "#64748b";
const TABLE = 'role="presentation" style="width:100%;border-collapse:collapse"';

function progressBar(p, color) {
  return "<table " + TABLE + "><tr><td>" +
    '<div style="height:5px;border-radius:9px;background:#eef0ef;overflow:hidden"><div style="width:' + p + "%;height:5px;background:" + color + ';border-radius:9px"></div></div></td>' +
    '<td style="width:34px;text-align:right;font-size:11px;font-weight:700;color:#71717a">' + p + "%</td></tr></table>";
}

function section(title, color, n) {
  return '<tr><td style="padding:14px 2px 8px;font-size:12.5px;font-weight:800;color:' + color + '">● ' + escapeHtml(title) + ' <span style="color:#a1a1aa">' + n + "</span></td></tr>";
}

function cardMeta(i, when, showOwner) {
  return escapeHtml(i.chartName) + (showOwner && i.owner ? " · " + escapeHtml(i.owner) : "") + " · " + when;
}

/* 마감 메일 카드: 왼쪽 색 띠 · D-표시 · 작업명 · 차트 · 마감일 · 진행률 */
function deadlineCard(i) {
  const c = dColor(i.left);
  const when = i.left === 0 ? "오늘" : shortDate(i.end) + " (" + weekday(i.end) + ")";
  return '<tr><td style="padding:0 0 8px"><div style="border-radius:14px;background:#fff;border:1px solid #eceeed;overflow:hidden"><table ' + TABLE + "><tr>" +
    '<td style="width:5px;background:' + c + '"></td>' +
    '<td style="width:64px;padding:12px 0 12px 12px;vertical-align:top"><div style="padding:4px 0;width:58px;text-align:center;border-radius:10px;background:' + dTint(i.left) + ";color:" + c + ';font-size:14px;font-weight:800">' + dLabel(i.left) + "</div></td>" +
    '<td style="padding:11px 14px 12px 10px"><div style="font-size:14.5px;font-weight:700;color:#18181b;line-height:1.35">' + escapeHtml(i.name) + "</div>" +
    '<div style="margin:3px 0 7px;font-size:11.5px;color:#8b8b94">' + cardMeta(i, when) + "</div>" + progressBar(i.progress, c) + "</td></tr></table></div></td></tr>";
}

/* 일정 메일 카드: 작업명 · 오른쪽에 마감/시작 · 차트 · 기간 · 진행률 */
function digestCard(i, showOwner) {
  const started = i.toStart <= 0;
  const right = started ? (i.left === 0 ? "오늘 마감" : dLabel(i.left)) : shortDate(i.start) + " 시작";
  const rc = started ? dColor(i.left) : i.toStart <= 7 ? C_TEAL : C_GRAY;
  const when = (i.start ? shortDate(i.start) + " – " : "") + shortDate(i.end);
  return '<tr><td style="padding:0 0 8px"><div style="border-radius:14px;background:#fff;border:1px solid #eceeed;padding:12px 14px">' +
    "<table " + TABLE + '><tr><td style="font-size:14.5px;font-weight:700;color:#18181b">' + escapeHtml(i.name) + "</td>" +
    '<td style="padding-left:8px;text-align:right;white-space:nowrap;font-size:12px;font-weight:800;color:' + rc + '">' + right + "</td></tr></table>" +
    '<div style="margin:3px 0 7px;font-size:11.5px;color:#8b8b94">' + cardMeta(i, when, showOwner) + "</div>" +
    progressBar(i.progress, started ? dColor(i.left) : C_GRAY) + "</div></td></tr>";
}

/* 메일 틀 — 청록 머리(날짜 · 한 줄 제목) · 본문 · 열기 버튼 · 한 줄 꼬리말 */
function mailHtml({ todayKey, title, under, body, siteUrl, footer }) {
  return '<div style="max-width:560px;margin:0 auto;background:#f6f7f7;' + MAIL_FONT + 'color:#27272a;padding-bottom:24px">' +
    '<div style="padding:22px 20px ' + (under ? 34 : 22) + 'px;background:' + C_TEAL + ';border-radius:0 0 22px 22px;color:#fff">' +
      "<table " + TABLE + '><tr><td style="font-size:12px;font-weight:700;color:#d5ece8">▤ 간트차트</td><td style="text-align:right;font-size:12px;color:#d5ece8">' + longDate(todayKey) + "</td></tr></table>" +
      '<div style="margin-top:14px;font-size:21px;font-weight:800;line-height:1.35">' + escapeHtml(title) + "</div></div>" +
    (under || "") +
    '<div style="padding:4px 14px 0">' + body +
      '<a href="' + escapeHtml(siteUrl) + '" style="display:block;margin:18px 0 0;padding:14px;border-radius:14px;background:' + C_TEAL + ';color:#fff;text-align:center;font-weight:800;font-size:14px;text-decoration:none">간트차트 열기</a>' +
      '<div style="margin:18px 4px 0;padding-top:14px;border-top:1px solid #eceeed;font-size:11.5px;line-height:1.6;color:#a1a1aa">' + escapeHtml(footer) + "</div>" +
    "</div></div>";
}

function mailText(summary, items, siteUrl) {
  return summary + "\n\n" +
    items.map((i) => "- " + dLabel(i.left) + "  " + i.name + " (" + i.chartName + ", " + (i.end || "날짜 없음") + ", " + i.progress + "%)").join("\n") + "\n\n" + siteUrl;
}

function groupRows(groups, items, card) {
  return groups.map(([title, color, test]) => {
    const list = items.filter(test);
    return list.length ? section(title, color, list.length) + list.map(card).join("") : "";
  }).join("");
}

function renderMail(notice, siteUrl) {
  const items = notice.items;
  const chips = [
    ["지연", -1, (i) => i.left < 0],
    ["오늘", 0, (i) => i.left === 0],
    ["내일", 1, (i) => i.left === 1],
    ["다가옴", 7, (i) => i.left > 1]
  ].map(([label, left, test]) => ({ label, left, n: items.filter(test).length })).filter((g) => g.n);
  const under = '<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:6px 0;margin:-16px 0 0;padding:0 14px"><tr>' +
    chips.map((g) => '<td style="background:#fff;border-radius:14px;box-shadow:0 6px 16px -10px rgba(0,0,0,.35);text-align:center;padding:10px 2px 8px">' +
      '<div style="font-size:20px;font-weight:800;color:' + dColor(g.left) + '">' + g.n + "</div>" +
      '<div style="font-size:11px;font-weight:700;color:' + dColor(g.left) + ';margin-top:2px">' + g.label + "</div></td>").join("") +
    "</tr></table>";
  const body = "<table " + TABLE + ">" + groupRows([
    ["지연", dColor(-1), (i) => i.left < 0],
    ["오늘 · 내일", dColor(0), (i) => i.left === 0 || i.left === 1],
    ["다가옴", C_TEAL, (i) => i.left > 1]
  ], items, deadlineCard) + "</table>";
  const summary = "마감 " + items.length + "건 · " + chips.map((g) => g.label + " " + g.n).join(" · ");
  return {
    subject: "[간트차트] " + summary,
    html: mailHtml({ todayKey: notice.todayKey, title: "마감 " + items.length + "건", under, body, siteUrl,
      footer: "[작업 끝냄] · [지연 알림 끄기]로 그만 받기 · 메일 끄기: 종 버튼" }),
    text: mailText(summary, items, siteUrl)
  };
}

/* 일정 메일: 앞으로 할 일 — 7일 칸(마감 · 시작 수) · 진행 중 · 곧 시작 */
function weekStrip(todayKey, items) {
  const cells = [0, 1, 2, 3, 4, 5, 6].map((k) => {
    const key = addDaysKey(todayKey, k);
    const ends = items.filter((i) => i.end === key).length;
    const starts = items.filter((i) => i.start === key).length;
    const on = k === 0;
    const note = (n, label, color) => n ? '<div style="font-size:9.5px;font-weight:800;margin-top:3px;color:' + (on ? "#fff" : color) + '">' + label + " " + n + "</div>" : "";
    return '<td style="vertical-align:top;text-align:center;padding:8px 0 7px;border-radius:12px;' + (on ? "background:" + C_TEAL + ";color:#fff" : "background:#fff;color:#3f3f46") + '">' +
      '<div style="font-size:10.5px;font-weight:700">' + weekday(key) + "</div>" +
      '<div style="font-size:15px;font-weight:800;margin-top:1px">' + Number(key.slice(8)) + "</div>" +
      note(ends, "마감", dColor(-1)) + note(starts, "시작", C_TEAL) + "</td>";
  }).join("");
  return '<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:4px 0;margin-top:14px;table-layout:fixed"><tr>' + cells + "</tr></table>";
}

function renderDigest(digest, siteUrl) {
  const items = digest.items;
  const showOwner = digest.scope === "charts";
  const body = weekStrip(digest.todayKey, items) + "<table " + TABLE + ">" + groupRows([
    ["진행 중", dColor(0), (i) => i.toStart <= 0],
    ["곧 시작", C_TEAL, (i) => i.toStart > 0]
  ], items, (i) => digestCard(i, showOwner)) + "</table>";
  const whose = showOwner ? "내 차트" : "내 작업";
  const title = "앞으로 할 일 " + items.length + "건";
  return {
    subject: "[간트차트] " + title + " · " + whose,
    html: mailHtml({ todayKey: digest.todayKey, title, body, siteUrl, footer: "주기 · 끄기: 종 버튼" }),
    text: mailText(title + " · " + whose, items, siteUrl)
  };
}

module.exports = { buildNotices, renderMail, buildDigests, renderDigest, isDigestDay, seoulTodayKey, daysBetween, isMailDay };
