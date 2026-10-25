/* (요청사항) GitHub Actions 가 매일 실행하는 마감 알림 — Firebase 무료 요금제(Spark)로도 된다.
   환경 변수
     FIREBASE_SERVICE_ACCOUNT : Firebase 콘솔 → 프로젝트 설정 → 서비스 계정 → "새 비공개 키 생성" JSON 내용
     SMTP_USER, SMTP_PASS     : 알림 메일을 보낼 메일 주소와 앱 비밀번호 (없으면 메일만 건너뜀)
     SMTP_HOST, SMTP_PORT     : Gmail 이 아니면 보내는 메일 서버 (네이버: smtp.naver.com, 465)
     SITE_URL                 : 알림을 누르면 열 사이트 (기본: GitHub Pages 주소)
     DRY_RUN=1                : 보내지 않고 무엇을 보낼지만 출력 */
const admin = require("firebase-admin");
const { runDailyNotices } = require("./notices");

const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
if (raw) {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
} else {
  admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || "gantt-chart-e06b8" }); // 에뮬레이터 확인용
}

const log = { info: (...a) => console.log(...a), error: (...a) => console.error(...a) };

runDailyNotices(admin, {
  smtpUser: process.env.SMTP_USER || "",
  smtpPass: (process.env.SMTP_PASS || "").replace(/\s+/g, ""),
  smtpHost: process.env.SMTP_HOST || "",
  smtpPort: process.env.SMTP_PORT || "",
  siteUrl: process.env.SITE_URL || "https://skarlgus0611.github.io/Gantt-chart/",
  dryRun: process.env.DRY_RUN === "1",
  todayKey: process.env.TODAY || undefined,
  log
}).then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
