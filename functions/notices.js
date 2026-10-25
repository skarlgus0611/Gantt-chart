/* (요청사항) 마감 알림 한 번 돌리기 — Firestore 를 읽어 오늘 보낼 메일·웹 푸시를 보낸다.
   두 곳에서 같은 코드를 쓴다
   - run-daily.js : GitHub Actions 가 매일 오전 9시(서울)에 실행 (Firebase 무료 요금제로 가능)
   - index.js     : Firebase Cloud Functions 예약 작업 (Blaze 요금제일 때)
   dryRun 이면 실제로 보내지 않고 무엇을 보낼지만 기록한다. */
const nodemailer = require("nodemailer");
const { buildNotices, renderMail, renderPush, seoulTodayKey } = require("./digest");

async function runDailyNotices(admin, { smtpUser, smtpPass, siteUrl, log = console, dryRun = false, todayKey = seoulTodayKey() }) {
  const db = admin.firestore();
  const [usersSnap, chartsSnap] = await Promise.all([db.collection("users").get(), db.collection("charts").get()]);
  const users = usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const charts = chartsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const tasksByChart = {};
  for (const chart of charts) {
    const snap = await db.collection("charts").doc(chart.id).collection("tasks").where("progress", "<", 100).get();
    tasksByChart[chart.id] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  const { mails, pushes } = buildNotices({ users, charts, tasksByChart, todayKey });
  log.info("오늘(" + todayKey + ") 메일 " + mails.length + "명 · 푸시 " + pushes.length + "명");

  /* 메일 */
  let mailed = 0;
  if (mails.length && (dryRun || !smtpUser || !smtpPass)) {
    mails.forEach((m) => log.info("[메일 " + (dryRun ? "미리보기" : "건너뜀: Gmail 설정 없음") + "] " + m.email + " · " + renderMail(m, siteUrl).subject));
  } else if (mails.length) {
    const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: smtpUser, pass: smtpPass } });
    for (const notice of mails) {
      const mail = renderMail(notice, siteUrl);
      try {
        await transporter.sendMail({
          from: { name: "간트차트 알림", address: smtpUser },
          to: notice.email, subject: mail.subject, html: mail.html, text: mail.text
        });
        mailed++;
      } catch (error) {
        log.error("메일 발송 실패 " + notice.email + ": " + (error && error.message));
      }
    }
  }

  /* 웹 푸시: 사람마다 한 통으로 묶어서, 끊긴 토큰은 지운다 */
  let pushed = 0;
  for (const notice of pushes) {
    const { title, body } = renderPush(notice);
    if (dryRun) {
      log.info("[푸시 미리보기] " + notice.email + " · " + title);
      continue;
    }
    const res = await admin.messaging().sendEachForMulticast({
      tokens: notice.tokens,
      notification: { title, body },
      webpush: { fcmOptions: { link: siteUrl }, notification: { tag: "gantt-due", renotify: true } }
    });
    pushed += res.successCount;
    const dead = notice.tokens.filter((token, i) => {
      const code = res.responses[i].error && res.responses[i].error.code;
      return code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token";
    });
    if (dead.length) {
      await db.collection("users").doc(notice.uid).update({ pushTokens: admin.firestore.FieldValue.arrayRemove(...dead) });
    }
  }
  log.info("보냄: 메일 " + mailed + "통 · 푸시 " + pushed + "건");
  return { mails: mails.length, pushes: pushes.length, mailed, pushed };
}

module.exports = { runDailyNotices };
