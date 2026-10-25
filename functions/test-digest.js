/* node functions/test-digest.js — 누구에게 언제 무엇을 보내는지 확인 */
const assert = require("assert");
const { buildNotices, renderMail, renderPush, seoulTodayKey } = require("./digest");

const users = [
  { uid: "u1", email: "Me@Example.com", name: "남기현", notify: { email: true, push: true }, pushTokens: ["t1"] },
  { uid: "u2", email: "ji@example.com", name: "김지수", notify: { email: true } },
  { uid: "u3", email: "off@example.com", name: "끈사람", notify: { email: false, push: false }, pushTokens: ["t3"] }
];
const charts = [
  { id: "c1", name: "기본 차트", ownerEmail: "me@example.com" },
  { id: "c2", name: "남의 차트", ownerEmail: "stranger@example.com" }
];
const today = "2026-10-25";
const tasksByChart = {
  c1: [
    { name: "D-7 나", end: "2026-11-01", progress: 30 },
    { name: "D-7 지수", end: "2026-11-01", progress: 0, ownerEmail: "ji@example.com" },
    { name: "D-8", end: "2026-11-02", progress: 0 },
    { name: "D-2", end: "2026-10-27", progress: 0 },
    { name: "D-1", end: "2026-10-26", progress: 0 },
    { name: "당일", end: "2026-10-25", progress: 50 },
    { name: "D-3 (아무것도 없음)", end: "2026-10-28", progress: 0 },
    { name: "지연", end: "2026-10-20", progress: 40 },
    { name: "지연 확인함", end: "2026-10-20", progress: 40, overdueAck: true },
    { name: "완료", end: "2026-10-20", progress: 100 },
    { name: "끈 사람 D-7", end: "2026-11-01", progress: 0, ownerEmail: "off@example.com" },
    { name: "끈 사람 지연", end: "2026-10-01", progress: 0, ownerEmail: "off@example.com" }
  ],
  c2: [
    { name: "가입 안 한 소유자 D-7", end: "2026-11-01", progress: 0 },
    { name: "남의 차트 내 담당 당일", end: "2026-10-25", progress: 0, ownerEmail: "ME@example.com" }
  ]
};

const { mails, pushes } = buildNotices({ users, charts, tasksByChart, todayKey: today });
assert.deepStrictEqual(mails.map((m) => m.email).sort(), ["ji@example.com", "me@example.com"]);
assert.deepStrictEqual(mails.find((m) => m.email === "me@example.com").items.map((i) => i.name), ["D-7 나"]);
assert.strictEqual(pushes.length, 1, "푸시는 켠 사람(나)만");
assert.deepStrictEqual(pushes[0].items.map((i) => i.name), ["지연", "당일", "남의 차트 내 담당 당일", "D-1", "D-2"]);
assert.deepStrictEqual(pushes[0].tokens, ["t1"]);

const push = renderPush(pushes[0]);
assert.strictEqual(push.title, "마감 알림 · 지연 1 · 오늘 마감 2 · 곧 마감 2");
assert.ok(push.body.startsWith("[지연 5일] 지연\n[오늘 마감] 당일"));
assert.ok(push.body.endsWith("외 1건"));
const mail = renderMail(mails[0], "https://example.com/");
assert.ok(mail.subject.startsWith("[간트차트] 일주일 뒤 마감"));
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(seoulTodayKey()));
console.log("ok —", push.title, "|", mail.subject);
