/* node functions/test-digest.js — 누구에게 언제 메일을 보내는지 확인 */
const assert = require("assert");
const { buildNotices, renderMail, seoulTodayKey, isMailDay } = require("./digest");

/* 보내는 날: D-15 · D-7 · D-1 · 당일, 지연 1 · 4 · 7 · 14 · 21 … */
const sendDays = [];
for (let left = 20; left >= -30; left--) if (isMailDay(left, false)) sendDays.push(left);
assert.deepStrictEqual(sendDays, [15, 7, 1, 0, -1, -4, -7, -14, -21, -28]);
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
    at("D-15", "2026-11-09"),
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
assert.deepStrictEqual(names("me@example.com"), ["지연 14일", "지연 7일", "지연 4일", "지연 1일", "당일", "D-1", "D-7", "D-15"]);
assert.deepStrictEqual(names("ji@example.com"), ["D-7 지수"]);

const mail = renderMail(mails.find((m) => m.email === "me@example.com"), "https://example.com/");
assert.strictEqual(mail.subject, "[간트차트] 지연 4건 · 오늘 마감 1건 · 내일 마감 1건 · 일주일 뒤 마감 1건 · 15일 뒤 마감 1건");
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(seoulTodayKey()));
console.log("ok —", mail.subject);
