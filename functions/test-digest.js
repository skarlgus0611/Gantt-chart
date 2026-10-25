/* node functions/test-digest.js — 받는 사람·작업 고르기와 메일 내용 확인 */
const assert = require("assert");
const { buildDigests, renderDigestEmail, seoulTodayKey } = require("./digest");

const users = [
  { uid: "u1", email: "Me@Example.com", name: "남기현", notify: { email: true } },
  { uid: "u2", email: "ji@example.com", name: "김지수" },
  { uid: "u3", email: "off@example.com", name: "끈사람", notify: { email: false } }
];
const charts = [
  { id: "c1", name: "기본 차트", ownerEmail: "me@example.com" },
  { id: "c2", name: "남의 차트", ownerEmail: "stranger@example.com" }
];
const tasksByChart = {
  c1: [
    { name: "지연 담당없음", end: "2026-10-20", progress: 40 },
    { name: "오늘 지수", end: "2026-10-25", progress: 10, ownerEmail: "ji@example.com", owner: "김지수" },
    { name: "3일 뒤 나", end: "2026-10-28", progress: 0, ownerEmail: "me@example.com" },
    { name: "4일 뒤", end: "2026-10-29", progress: 0, ownerEmail: "me@example.com" },
    { name: "끝난 작업", end: "2026-10-01", progress: 100 },
    { name: "끈 사람", end: "2026-10-24", progress: 0, ownerEmail: "off@example.com" }
  ],
  c2: [
    { name: "가입 안 한 소유자", end: "2026-10-24", progress: 0 },
    { name: "남의 차트지만 내 담당", end: "2026-10-24", progress: 50, ownerEmail: "ME@example.com" }
  ]
};

const digests = buildDigests({ users, charts, tasksByChart, todayKey: "2026-10-25" });
const me = digests.find((d) => d.email === "me@example.com");
const ji = digests.find((d) => d.email === "ji@example.com");
assert.strictEqual(digests.length, 2, "받는 사람은 나와 지수 둘");
assert.deepStrictEqual(me.items.map((i) => i.name), ["지연 담당없음", "남의 차트지만 내 담당", "3일 뒤 나"]);
assert.deepStrictEqual(me.items.map((i) => i.kind), ["overdue", "overdue", "soon"]);
assert.strictEqual(me.items[0].days, 5);
assert.deepStrictEqual(ji.items.map((i) => i.kind), ["today"]);

const mail = renderDigestEmail(me, "https://example.com/");
assert.strictEqual(mail.subject, "[간트차트] 지연 2 · 3일 이내 마감 1");
assert.ok(mail.html.includes("지연 5일") && mail.html.includes("D-3"));
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(seoulTodayKey()));
console.log("ok —", mail.subject);
