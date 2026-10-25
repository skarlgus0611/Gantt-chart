# 마감 알림 메일 (매일 아침 8시)

`dailyDueDigest` 는 매일 아침 8시(서울)에 지연·3일 이내 마감 작업을 담당자에게 메일로 보내요.

- 담당자를 조직원 목록에서 고른 작업 → 그 담당자에게
- 담당자가 없거나 이름만 적은 작업 → 차트 소유자에게
- 사이트에 한 번 이상 로그인했고, 종 버튼에서 "메일로 받기"를 끄지 않은 사람만 받아요

## 처음 한 번 배포하기

1. **Firebase 요금제를 Blaze(종량제)로** — Firebase 콘솔 → 왼쪽 아래 요금제 → 업그레이드.
   사용량이 적으면 실제 요금은 거의 0원이에요. Google Cloud 콘솔 → 결제 → 예산 및 알림에서 예산 알림(예: 1,000원)을 걸어 두면 안심돼요.
2. **보내는 Gmail 계정의 앱 비밀번호 만들기** — 그 Google 계정 → 보안 → 2단계 인증 켜기 → "앱 비밀번호"에서 16자리 비밀번호 만들기.
3. **PC 준비** — Node.js 20 설치 후 터미널에서
   ```
   npm install -g firebase-tools
   firebase login
   ```
4. **이 저장소 폴더에서**
   ```
   cd functions
   npm install
   cd ..
   firebase functions:secrets:set SMTP_USER    # 보내는 Gmail 주소 입력
   firebase functions:secrets:set SMTP_PASS    # 2번의 앱 비밀번호 입력
   firebase deploy --only functions
   ```
5. **바로 한 번 보내 보기** — Google Cloud 콘솔 → Cloud Scheduler → `firebase-schedule-dailyDueDigest-...` → "강제 실행".

`firebase deploy --only functions` 는 함수만 올려요. 보안 규칙은 지금처럼 콘솔에 붙여넣으면 돼요.

## 확인용

```
node functions/test-digest.js
```
