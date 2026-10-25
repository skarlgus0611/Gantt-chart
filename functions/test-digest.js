/* node functions/test-digest.js — 누구에게 언제 무엇을 보내는지 확인 */
const assert = require("assert");
const { buildNotices, renderMail, renderPush, seoulTodayKey } = require("./digest");

const users = [
  { uid: "u1", email: "Me@Example.com", name: "남기현", notify: { email: true, push: true }, pushTokens: ["t1"] },
  { uid: "u2", email: "ji@example.com", name: "김지수", notify: { email: true } },
  { uid: "u3", email: "off@example.com", name: "끈사람", notify: { email: false, push: false }, pushTokens: ["t3"] }
];
const charts = [{ id: "c1", name: "기본 차트", ownerEmail: "me@example.com" }];
/* 오늘 2026-10-25 기준 */
const at = (name, end, extra = {}) => ({ name, end, progress: 0, ownerEmail: "me@example.com", ...extra });
const tasksByChart = {
  c1: [
    at("D-15", "2026-11-09"),
    at("D-8", "2026-11-02"),
    at("D-7", "2026-11-01"),
    at("D-2", "2026-10-27"),
    at("D-1", "2026-10-26"),
    at("당일", "2026-10-25"),
    at("D+1 지연 첫날", "2026-10-24"),
    at("D+2 지연", "2026-10-23"),
    at("D+1 지연 확인함", "2026-10-24", { overdueAck: true }),
    at("D+5 지연 확인함", "2026-10-20", { overdueAck: true }),
    at("D-1 완료", "2026-10-26", { progress: 100 }),
    at("D-7 지수", "2026-11-01", { ownerEmail: "ji@example.com" }),
    at("D-1 담당없음", "2026-10-26", { ownerEmail: "" }),
    at("D-1 미가입", "2026-10-26", { ownerEmail: "new@example.com" }),
    at("D-1 끈 사람", "2026-10-26", { ownerEmail: "off@example.com" })
  ]
};

const { mails, pushes } = buildNotices({ users, charts, tasksByChart, todayKey: "2026-10-25" });
const names = (list, email) => (list.find((x) => x.email === email) || { items: [] }).items.map((i) => i.name);
assert.deepStrictEqual(mails.map((m) => m.email).sort(), ["ji@example.com", "me@example.com"]);
assert.deepStrictEqual(names(mails, "me@example.com"), ["D+1 지연 첫날", "D-1", "D-7"], "메일: D-7 · D-1 · 지연 첫날만");
assert.deepStrictEqual(names(mails, "ji@example.com"), ["D-7 지수"]);
assert.deepStrictEqual(pushes.map((p) => p.email), ["me@example.com"], "푸시는 켠 사람만");
assert.deepStrictEqual(names(pushes, "me@example.com"), ["D+2 지연", "D+1 지연 첫날", "D-1"], "푸시: D-1 · 지연(확인 전) 매일");

const push = renderPush(pushes[0]);
assert.strictEqual(push.title, "마감 알림 · 지연 2 · 곧 마감 1");
const mail = renderMail(mails.find((m) => m.email === "me@example.com"), "https://example.com/");
assert.strictEqual(mail.subject, "[간트차트] 지연 1건 · 내일 마감 1건 · 일주일 뒤 마감 1건");
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(seoulTodayKey()));
console.log("ok —", push.title, "|", mail.subject);
