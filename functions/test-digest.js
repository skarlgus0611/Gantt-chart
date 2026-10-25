/* node functions/test-digest.js — 누구에게 언제 무엇을 보내는지 확인 */
const assert = require("assert");
const { buildNotices, renderMail, renderPush, seoulTodayKey } = require("./digest");

const users = [
  { uid: "u1", email: "Me@Example.com", name: "남기현", notify: { email: true, push: true }, pushTokens: ["t1"] },
  { uid: "u2", email: "ji@example.com", name: "김지수", notify: { email: true } },
  { uid: "u3", email: "off@example.com", name: "끈사람", notify: { email: false, push: false }, pushTokens: ["t3"] }
];
const charts = [{ id: "c1", name: "기본 차트", ownerEmail: "me@example.com" }];
const tasksByChart = {
  c1: [
    { name: "D-7 나", end: "2026-11-01", progress: 30, ownerEmail: "ME@example.com" },
    { name: "D-7 지수", end: "2026-11-01", progress: 0, ownerEmail: "ji@example.com" },
    { name: "D-7 담당없음 (안 보냄)", end: "2026-11-01", progress: 0 },
    { name: "D-7 외부인 (안 보냄)", end: "2026-11-01", progress: 0, owner: "협력사" },
    { name: "D-7 미가입 (안 보냄)", end: "2026-11-01", progress: 0, ownerEmail: "new@example.com" },
    { name: "D-8", end: "2026-11-02", progress: 0, ownerEmail: "me@example.com" },
    { name: "D-2", end: "2026-10-27", progress: 0, ownerEmail: "me@example.com" },
    { name: "D-1", end: "2026-10-26", progress: 0, ownerEmail: "me@example.com" },
    { name: "당일", end: "2026-10-25", progress: 50, ownerEmail: "me@example.com" },
    { name: "D-3", end: "2026-10-28", progress: 0, ownerEmail: "me@example.com" },
    { name: "지연", end: "2026-10-20", progress: 40, ownerEmail: "me@example.com" },
    { name: "지연 확인함", end: "2026-10-20", progress: 40, ownerEmail: "me@example.com", overdueAck: true },
    { name: "완료", end: "2026-10-20", progress: 100, ownerEmail: "me@example.com" },
    { name: "끈 사람 D-7", end: "2026-11-01", progress: 0, ownerEmail: "off@example.com" }
  ]
};

const { mails, pushes } = buildNotices({ users, charts, tasksByChart, todayKey: "2026-10-25" });
const names = (list, email) => (list.find((x) => x.email === email) || { items: [] }).items.map((i) => i.name);
assert.deepStrictEqual(mails.map((m) => m.email).sort(), ["ji@example.com", "me@example.com"]);
assert.deepStrictEqual(names(mails, "me@example.com"), ["D-7 나"]);
assert.deepStrictEqual(names(mails, "ji@example.com"), ["D-7 지수"]);
assert.deepStrictEqual(pushes.map((p) => p.email), ["me@example.com"], "푸시는 켠 사람만");
assert.deepStrictEqual(names(pushes, "me@example.com"), ["지연", "당일", "D-1", "D-2"]);

const push = renderPush(pushes[0]);
assert.strictEqual(push.title, "마감 알림 · 지연 1 · 오늘 마감 1 · 곧 마감 2");
const mail = renderMail(mails[0], "https://example.com/");
assert.ok(mail.subject.startsWith("[간트차트] 일주일 뒤 마감"));
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(seoulTodayKey()));
console.log("ok —", push.title, "|", mail.subject);
