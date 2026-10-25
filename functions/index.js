/* (요청사항) 마감 알림 — 매일 오전 9시(서울)에 한 번 돈다
   - D-7: 메일 한 번 (Gmail 앱 비밀번호로 발송: 비밀값 SMTP_USER, SMTP_PASS)
   - D-2·D-1·당일, 지연(확인 전까지 하루 한 번): 웹 푸시 (Firebase Cloud Messaging)
   - Firebase Cloud Functions(2세대) 예약 작업이라 요금제가 Blaze(종량제)여야 배포할 수 있다
   - 배포 방법은 functions/README.md 참고 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { buildNotices, renderMail, renderPush, seoulTodayKey } = require("./digest");

admin.initializeApp();

const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const SITE_URL = defineString("SITE_URL", { default: "https://skarlgus0611.github.io/Gantt-chart/" });

exports.dailyDueNotices = onSchedule(
  { schedule: "0 9 * * *", timeZone: "Asia/Seoul", region: "asia-northeast3", secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
  async () => {
    const db = admin.firestore();
    const [usersSnap, chartsSnap] = await Promise.all([db.collection("users").get(), db.collection("charts").get()]);
    const users = usersSnap.docs.map((d) => ({ uid: d.id, ...d.data() }));
    const charts = chartsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const tasksByChart = {};
    for (const chart of charts) {
      const snap = await db.collection("charts").doc(chart.id).collection("tasks").where("progress", "<", 100).get();
      tasksByChart[chart.id] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    }

    const { mails, pushes } = buildNotices({ users, charts, tasksByChart, todayKey: seoulTodayKey() });
    const siteUrl = SITE_URL.value();

    /* D-7 메일 */
    if (mails.length) {
      const transporter = nodemailer.createTransport({ service: "gmail", auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() } });
      let sent = 0;
      for (const notice of mails) {
        const mail = renderMail(notice, siteUrl);
        try {
          await transporter.sendMail({
            from: { name: "간트차트 알림", address: SMTP_USER.value() },
            to: notice.email, subject: mail.subject, html: mail.html, text: mail.text
          });
          sent++;
        } catch (error) {
          logger.error("메일 발송 실패", notice.email, error);
        }
      }
      logger.info("D-7 메일 " + sent + "/" + mails.length + "통");
    }

    /* 웹 푸시: 사람마다 한 통으로 묶어서, 끊긴 토큰은 지운다 */
    let pushed = 0;
    for (const notice of pushes) {
      const { title, body } = renderPush(notice);
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
    logger.info("푸시 " + pushed + "건 (" + pushes.length + "명)");
  }
);
