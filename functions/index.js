/* (요청사항) 매일 아침 8시(서울) 마감 알림 메일
   - Firebase Cloud Functions(2세대) 예약 작업. 요금제가 Blaze(종량제)여야 배포할 수 있다
   - 메일은 Gmail 계정(앱 비밀번호)으로 보낸다: 비밀값 SMTP_USER, SMTP_PASS
   - 배포 방법은 functions/README.md 참고 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { buildDigests, renderDigestEmail, seoulTodayKey } = require("./digest");

admin.initializeApp();

const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const SITE_URL = defineString("SITE_URL", { default: "https://skarlgus0611.github.io/Gantt-chart/" });

exports.dailyDueDigest = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Asia/Seoul", region: "asia-northeast3", secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
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

    const digests = buildDigests({ users, charts, tasksByChart, todayKey: seoulTodayKey() });
    if (!digests.length) {
      logger.info("보낼 마감 알림이 없습니다.");
      return;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: SMTP_USER.value(), pass: SMTP_PASS.value() }
    });

    let sent = 0;
    for (const digest of digests) {
      const mail = renderDigestEmail(digest, SITE_URL.value());
      try {
        await transporter.sendMail({
          from: { name: "간트차트 알림", address: SMTP_USER.value() },
          to: digest.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text
        });
        sent++;
      } catch (error) {
        logger.error("메일 발송 실패", digest.email, error);
      }
    }
    logger.info("마감 알림 메일 " + sent + "/" + digests.length + "통 보냄");
  }
);
