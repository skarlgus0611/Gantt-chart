/* (요청사항) 마감 알림 메일 — 누구에게 무엇을 보낼지 고르고 메일 내용을 만든다.
   Firestore·메일 발송과 떨어진 순수 함수라 test-digest.js 로 바로 확인할 수 있다.

   받는 사람
   - 담당자를 조직원 목록에서 고른 작업(ownerEmail 있음) → 그 담당자
   - 담당자가 없거나 이름만 적은 작업 → 차트 소유자
   - 이 사이트에 로그인한 적이 있고(users 문서) 메일 받기를 끄지 않은 사람만

   보내는 작업: 진행률 100% 미만이고, 종료일이 지났거나(지연) 오늘부터 3일 안(임박) */

const SOON_DAYS = 3;

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

function buildDigests({ users, charts, tasksByChart, todayKey, soonDays = SOON_DAYS }) {
  const allowed = new Map();
  (users || []).forEach((u) => {
    const email = String(u.email || "").trim().toLowerCase();
    if (!email) return;
    if (u.notify && u.notify.email === false) return;
    allowed.set(email, u);
  });

  const byEmail = new Map();
  (charts || []).forEach((chart) => {
    (tasksByChart[chart.id] || []).forEach((task) => {
      const progress = normProgress(task.progress);
      if (progress >= 100 || !task.end) return;
      const left = daysBetween(todayKey, task.end);
      if (left === null || left > soonDays) return;
      const to = String(task.ownerEmail || "").trim().toLowerCase() || String(chart.ownerEmail || "").trim().toLowerCase();
      if (!to || !allowed.has(to)) return;
      if (!byEmail.has(to)) byEmail.set(to, []);
      byEmail.get(to).push({
        chartName: chart.name || "이름 없는 차트",
        name: task.name || "이름 없는 작업",
        end: task.end,
        progress,
        owner: task.owner || "",
        kind: left < 0 ? "overdue" : left === 0 ? "today" : "soon",
        days: Math.abs(left)
      });
    });
  });

  const order = { overdue: 0, today: 1, soon: 2 };
  return Array.from(byEmail.entries()).map(([email, items]) => ({
    email,
    name: (allowed.get(email) || {}).name || "",
    items: items.sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === "overdue" ? b.days - a.days : a.days - b.days))
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderDigestEmail(digest, siteUrl) {
  const groups = [
    ["overdue", "지연", "#b91c1c", "#fee2e2"],
    ["today", "오늘 마감", "#b45309", "#fef3c7"],
    ["soon", "3일 이내 마감", "#0f766e", "#e3f2ed"]
  ];
  const count = (kind) => digest.items.filter((i) => i.kind === kind).length;
  const summary = groups.filter(([kind]) => count(kind)).map(([kind, label]) => label + " " + count(kind)).join(" · ");
  const subject = "[간트차트] " + summary;
  const chip = (item) => item.kind === "overdue" ? "지연 " + item.days + "일" : item.kind === "today" ? "오늘 마감" : "D-" + item.days;

  const sections = groups.map(([kind, label, color, bg]) => {
    const list = digest.items.filter((i) => i.kind === kind);
    if (!list.length) return "";
    return '<h3 style="margin:22px 0 8px;font-size:14px;color:' + color + '">' + label + " " + list.length + "</h3>" +
      list.map((i) =>
        '<div style="padding:10px 12px;margin-bottom:6px;border-radius:10px;background:#f8faf9">' +
          '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:' + bg + ";color:" + color + ';font-size:12px;font-weight:700">' + chip(i) + "</span> " +
          '<b style="font-size:14px;color:#18181b">' + escapeHtml(i.name) + "</b>" +
          '<div style="margin-top:4px;font-size:12px;color:#71717a">' + escapeHtml(i.chartName) + " · 종료일 " + escapeHtml(i.end) + " · 진행률 " + i.progress + "%" +
            (i.owner ? " · 담당 " + escapeHtml(i.owner) : "") + "</div></div>").join("");
  }).join("");

  const hello = digest.name ? escapeHtml(digest.name) + " 님, " : "";
  const html =
    '<div style="max-width:560px;margin:0 auto;padding:24px;font-family:-apple-system,\'Pretendard\',\'Malgun Gothic\',sans-serif;color:#27272a">' +
      '<div style="padding:18px 20px;border-radius:14px;background:#0f766e;color:#fff"><b style="font-size:17px">마감 알림</b>' +
        '<div style="margin-top:4px;font-size:13px;opacity:.85">' + hello + "오늘 챙길 작업이에요. " + escapeHtml(summary) + "</div></div>" +
      sections +
      '<p style="margin-top:24px"><a href="' + escapeHtml(siteUrl) + '" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#0f766e;color:#fff;text-decoration:none;font-weight:700;font-size:13px">간트차트 열기</a></p>' +
      '<p style="font-size:11.5px;color:#a1a1aa">이 메일을 그만 받으려면 사이트 오른쪽 위 종 버튼에서 "메일로 받기"를 끄세요.</p></div>';

  const text = "마감 알림 — " + summary + "\n\n" +
    digest.items.map((i) => "- [" + chip(i) + "] " + i.name + " (" + i.chartName + ", 종료일 " + i.end + ", " + i.progress + "%)").join("\n") +
    "\n\n" + siteUrl;

  return { subject, html, text };
}

module.exports = { buildDigests, renderDigestEmail, seoulTodayKey, daysBetween, SOON_DAYS };
