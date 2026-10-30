/* node functions/test-digest.js — 누구에게 언제 메일을 보내는지 확인 */
const assert = require("assert");
const { buildNotices, renderMail, buildDigests, renderDigest, isDigestDay, seoulTodayKey, isMailDay } = require("./digest");

/* 보내는 날: D-30 · D-15 · D-7 · D-4 · D-1 · 당일, 지연 1 · 4 · 7 · 14 · 21 … */
const sendDays = [];
for (let left = 40; left >= -30; left--) if (isMailDay(left, false)) sendDays.push(left);
assert.deepStrictEqual(sendDays, [30, 15, 7, 4, 1, 0, -1, -4, -7, -14, -21, -28]);
assert.strictEqual(isMailDay(-4, true), false, "지연 확인 누르면 안 보냄");
assert.strictEqual(isMailDay(-3, false), false, "지연 3일째는 안 보냄");
assert.strictEqual(isMailDay(1, true), true, "마감 전 알림은 지연 확인과 상관없음");

const users = [
  { uid: "u1", email: "Me@Example.com", name: "남기현", notify: { email: true } },
  { uid: "u2", email: "ji@example.com", name: "김지수" },
  { uid: "u3", email: "off@example.com", name: "끈사람", notify: { email: false } }
];
const charts = [{ id: "c1", name: "기본 차트", ownerEmail: "me@example.com" }];
/* 오늘 2026-10-25 기준 */
const at = (name, end, extra = {}) => ({ name, end, progress: 0, ownerEmail: "me@example.com", ...extra });
const tasksByChart = {
  c1: [
    at("D-30", "2026-11-24"),
    at("D-15", "2026-11-09"),
    at("D-4", "2026-10-29"),
    at("D-8 (안 보냄)", "2026-11-02"),
    at("D-7", "2026-11-01"),
    at("D-2 (안 보냄)", "2026-10-27"),
    at("D-1", "2026-10-26"),
    at("당일", "2026-10-25"),
    at("지연 1일", "2026-10-24"),
    at("지연 2일 (안 보냄)", "2026-10-23"),
    at("지연 3일 (안 보냄)", "2026-10-22"),
    at("지연 4일", "2026-10-21"),
    at("지연 7일", "2026-10-18"),
    at("지연 14일", "2026-10-11"),
    at("지연 10일 (안 보냄)", "2026-10-15"),
    at("지연 4일 확인함 (안 보냄)", "2026-10-21", { overdueAck: true }),
    at("D-1 완료 (안 보냄)", "2026-10-26", { progress: 100 }),
    at("D-7 지수", "2026-11-01", { ownerEmail: "ji@example.com" }),
    at("D-1 담당없음 (안 보냄)", "2026-10-26", { ownerEmail: "" }),
    at("D-1 미가입 (안 보냄)", "2026-10-26", { ownerEmail: "new@example.com" }),
    at("D-1 메일 끈 사람 (안 보냄)", "2026-10-26", { ownerEmail: "off@example.com" })
  ]
};

const { mails } = buildNotices({ users, charts, tasksByChart, todayKey: "2026-10-25" });
const names = (email) => (mails.find((m) => m.email === email) || { items: [] }).items.map((i) => i.name);
assert.deepStrictEqual(mails.map((m) => m.email).sort(), ["ji@example.com", "me@example.com"]);
assert.deepStrictEqual(names("me@example.com"), ["지연 14일", "지연 7일", "지연 4일", "지연 1일", "당일", "D-1", "D-4", "D-7", "D-15", "D-30"]);
assert.deepStrictEqual(names("ji@example.com"), ["D-7 지수"]);

const mail = renderMail(mails.find((m) => m.email === "me@example.com"), "https://example.com/");
assert.strictEqual(mail.subject, "[간트차트] 마감 10건 · 지연 4 · 오늘 1 · 내일 1 · 다가옴 4");
assert.ok(mail.html.includes("10월 25일 (일)") && mail.html.includes(">마감 10건<"));
assert.ok(mail.html.includes(">D+14<") && mail.html.includes(">D-day<") && mail.html.includes(">D-30<"));
assert.ok(mail.html.indexOf("● 지연") < mail.html.indexOf("● 오늘 · 내일") && mail.html.indexOf("● 오늘 · 내일") < mail.html.indexOf("● 다가옴"));
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(seoulTodayKey()));

/* 일정 메일 — 설정한 다음 날이 첫날, 그 뒤 주기마다 */
const days = (digest, from, count) => {
  const out = [];
  for (let i = 0; i < count; i++) {
    const key = new Date(Date.UTC(2026, 9, 25) + i * 86400000).toISOString().slice(0, 10);
    if (isDigestDay(digest, key)) out.push(key.slice(5));
  }
  return out;
};
assert.deepStrictEqual(days({ every: 1, unit: "d", since: "2026-10-25" }, 0, 4), ["10-26", "10-27", "10-28"]);
assert.deepStrictEqual(days({ every: 3, unit: "d", since: "2026-10-25" }, 0, 11), ["10-26", "10-29", "11-01", "11-04"]);
assert.deepStrictEqual(days({ every: 1, unit: "w", since: "2026-10-25" }, 0, 16), ["10-26", "11-02", "11-09"]);
assert.deepStrictEqual(days({ every: 2, unit: "w", since: "2026-10-25" }, 0, 30), ["10-26", "11-09", "11-23"]);
assert.strictEqual(isDigestDay({ every: 1, unit: "m", since: "2026-10-25" }, "2026-11-26"), true);
assert.strictEqual(isDigestDay({ every: 1, unit: "m", since: "2026-10-25" }, "2026-11-25"), false);
assert.strictEqual(isDigestDay({ every: 1, unit: "m", since: "2027-01-30" }, "2027-02-28"), true, "달에 없는 날은 말일");
assert.strictEqual(isDigestDay({ every: 2, unit: "m", since: "2026-10-25" }, "2026-11-26"), false);
assert.strictEqual(isDigestDay({ every: 2, unit: "m", since: "2026-10-25" }, "2026-12-26"), true);
assert.strictEqual(isDigestDay(null, "2026-10-26"), false);
assert.strictEqual(isDigestDay({ on: false, every: 1, unit: "d", since: "2026-10-25" }, "2026-10-26"), false, "토글 끄면 안 보냄");

const dUsers = [
  { uid: "u1", email: "me@example.com", name: "남기현", notify: { email: false, digest: { every: 1, unit: "d", scope: "mine", since: "2026-10-24" } } },
  { uid: "u2", email: "ji@example.com", name: "김지수", notify: { digest: { every: 1, unit: "d", scope: "charts", since: "2026-10-24" } } },
  { uid: "u3", email: "no@example.com", notify: { digest: { every: 3, unit: "d", scope: "charts", since: "2026-10-24" } } }
];
const dCharts = [{ id: "c1", name: "기본 차트", ownerId: "u1", memberEmails: ["ji@example.com"] }, { id: "c2", name: "남의 차트", ownerId: "u9" }];
const dTasks = {
  c1: [
    at("내 지연", "2026-10-20"),
    at("내 날짜없음", ""),
    at("내 완료", "2026-10-30", { progress: 100 }),
    at("내 진행 중", "2026-11-10", { start: "2026-10-01" }),
    at("내 다음주 시작", "2026-11-20", { start: "2026-10-29" }),
    at("내 오늘 마감", "2026-10-25", { start: "2026-10-20" }),
    at("지수 작업", "2026-12-01", { start: "2026-11-15", ownerEmail: "ji@example.com", owner: "김지수" })
  ],
  c2: [at("남의 차트 내 작업", "2026-11-01", { start: "2026-11-01" })]
};
const digests = buildDigests({ users: dUsers, charts: dCharts, tasksByChart: dTasks, todayKey: "2026-10-25" });
assert.deepStrictEqual(digests.map((d) => d.email), ["me@example.com", "ji@example.com"], "3일 주기는 오늘 아님, 기본 메일 끈 것과 상관없음");
/* 앞으로 할 일만: 지연 · 날짜 없음 · 완료는 빼고, 진행 중 먼저 → 시작 빠른 순 */
assert.deepStrictEqual(digests[0].items.map((i) => i.name), ["내 오늘 마감", "내 진행 중", "내 다음주 시작", "남의 차트 내 작업"]);
assert.deepStrictEqual(digests[1].items.map((i) => i.name), ["내 오늘 마감", "내 진행 중", "내 다음주 시작", "지수 작업"], "참여한 차트 전체");
const dMail = renderDigest(digests[1], "https://example.com/");
assert.strictEqual(dMail.subject, "[간트차트] 앞으로 할 일 4건 · 내 차트");
assert.ok(dMail.html.includes("김지수 · 11.15 – 12.1") && dMail.html.includes("11.15 시작") && dMail.html.includes("오늘 마감"));
assert.ok(dMail.html.includes("● 진행 중") && dMail.html.includes("● 곧 시작"));
assert.ok(!renderDigest(digests[0], "https://example.com/").html.includes("남기현 ·"), "내 작업은 담당자 안 붙임");
console.log("ok —", mail.subject, "/", dMail.subject);
