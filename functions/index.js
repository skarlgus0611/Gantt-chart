/* (요청사항) 마감 알림 — 매일 오전 8시(서울)에 한 번 돈다
   - 메일: D-15 · D-7 · D-1 · 당일, 지연 1 · 4 · 7일째와 그 뒤 매주 (Gmail 앱 비밀번호로 발송: 비밀값 SMTP_USER, SMTP_PASS)
   - Firebase Cloud Functions(2세대) 예약 작업이라 요금제가 Blaze(종량제)여야 배포할 수 있다
   - 배포 방법은 functions/README.md 참고 */
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { runDailyNotices } = require("./notices");

admin.initializeApp();

const SMTP_USER = defineSecret("SMTP_USER");
const SMTP_PASS = defineSecret("SMTP_PASS");
const SITE_URL = defineString("SITE_URL", { default: "https://skarlgus0611.github.io/Gantt-chart/" });

/* Blaze 요금제일 때 쓰는 방법. 무료 요금제면 GitHub Actions(run-daily.js)로 같은 일을 한다 */
exports.dailyDueNotices = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Asia/Seoul", region: "asia-northeast3", secrets: [SMTP_USER, SMTP_PASS], timeoutSeconds: 300 },
  () => runDailyNotices(admin, { smtpUser: SMTP_USER.value(), smtpPass: SMTP_PASS.value(), siteUrl: SITE_URL.value(), log: logger })
);
