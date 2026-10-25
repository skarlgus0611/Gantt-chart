/* (요청사항) 마감 알림 메일 한 번 돌리기 — Firestore 를 읽어 오늘 보낼 메일을 보낸다.
   두 곳에서 같은 코드를 쓴다
   - run-daily.js : GitHub Actions 가 매일 오전 8시(서울)에 실행 (Firebase 무료 요금제로 가능)
   - index.js     : Firebase Cloud Functions 예약 작업 (Blaze 요금제일 때)
   dryRun 이면 실제로 보내지 않고 무엇을 보낼지만 기록한다. */
const nodemailer = require("nodemailer");
const { buildNotices, renderMail, seoulTodayKey } = require("./digest");

/* 보내는 메일 서버: 비우면 Gmail, 네이버 등은 SMTP_HOST 로 (예: smtp.naver.com) */
function mailTransport(smtpUser, smtpPass, smtpHost, smtpPort) {
  if (!smtpHost) return nodemailer.createTransport({ service: "gmail", auth: { user: smtpUser, pass: smtpPass } });
  const port = Number(smtpPort) || 465;
  return nodemailer.createTransport({ host: smtpHost, port, secure: port === 465, auth: { user: smtpUser, pass: smtpPass } });
}

async function runDailyNotices(admin, { smtpUser, smtpPass, smtpHost = "", smtpPort = "", siteUrl, log = console, dryRun = false, todayKey = seoulTodayKey() }) {
  const db = admin.firestore();
  const [usersSnap, chartsSnap] = await Promise.all([db.collection("users").get(), db.collection("charts").get()]);
  const users = usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  const charts = chartsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const tasksByChart = {};
  for (const chart of charts) {
    const snap = await db.collection("charts").doc(chart.id).collection("tasks").where("progress", "<", 100).get();
    tasksByChart[chart.id] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  const { mails } = buildNotices({ users, charts, tasksByChart, todayKey });
  log.info("오늘(" + todayKey + ") 메일 " + mails.length + "명");

  /* 메일 */
  let mailed = 0;
  if (mails.length && (dryRun || !smtpUser || !smtpPass)) {
    mails.forEach((m) => log.info("[메일 " + (dryRun ? "미리보기" : "건너뜀: Gmail 설정 없음") + "] " + m.email + " · " + renderMail(m, siteUrl).subject));
  } else if (mails.length) {
    const transporter = mailTransport(smtpUser, smtpPass, smtpHost, smtpPort);
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

  log.info("보냄: 메일 " + mailed + "통");
  return { mails: mails.length, mailed };
}

module.exports = { runDailyNotices };
