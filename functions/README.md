# 마감 알림 (서버)

`dailyDueNotices` 는 매일 오전 9시(서울)에 한 번 돌아요.

| 언제 | 어떻게 |
|---|---|
| D-15 | 사이트 안 알림 (종 버튼, 그날만) — 서버 없이 사이트에서 바로 |
| D-7 | 메일 (그날만) |
| D-2 · D-1 · 당일 | 사이트 안 + 웹 푸시 (그날만) |
| 지연 | [지연 확인]을 누르기 전까지 하루 한 번 웹 푸시 |
| 완료(100%) | 아무 알림도 없음 |

**누가 받나**
- **담당자가 정해져 있고(이메일) 이 사이트에 가입한 경우에만** 그 담당자에게 보내요
- 그 밖의 경우(담당자 없음 · 이메일 없음 · 미가입)는 아무에게도 안 보내요
- 메일·푸시는 종 버튼 설정에서 각각 켜고 끌 수 있어요 (메일 기본 켜짐, 푸시는 직접 켜야 함)

## 처음 한 번 준비하기

1. **웹 푸시 키** — Firebase 콘솔 → 프로젝트 설정 → 클라우드 메시징 → 웹 푸시 인증서 → "키 쌍 생성".
   나온 공개 키를 `firebase/firebase-core.js` 의 `FCM_VAPID_KEY = ""` 따옴표 안에 넣어요. (이건 공개해도 되는 키예요)
2. **Firebase 요금제를 Blaze(종량제)로** — Firebase 콘솔 → 왼쪽 아래 요금제 → 업그레이드.
   사용량이 적으면 실제 요금은 거의 0원이에요. Google Cloud 콘솔 → 결제 → 예산 및 알림에서 예산 알림(예: 1,000원)을 걸어 두면 안심돼요.
3. **보내는 Gmail 계정의 앱 비밀번호** — 그 Google 계정 → 보안 → 2단계 인증 켜기 → "앱 비밀번호"에서 16자리 비밀번호 만들기.
4. **PC 준비** — Node.js 20 설치 후 터미널에서
   ```
   npm install -g firebase-tools
   firebase login
   ```
5. **이 저장소 폴더에서**
   ```
   cd functions
   npm install
   cd ..
   firebase functions:secrets:set SMTP_USER    # 보내는 Gmail 주소 입력
   firebase functions:secrets:set SMTP_PASS    # 3번의 앱 비밀번호 입력
   firebase deploy --only functions
   ```
6. **바로 한 번 돌려 보기** — Google Cloud 콘솔 → Cloud Scheduler → `firebase-schedule-dailyDueNotices-...` → "강제 실행".

`firebase deploy --only functions` 는 함수만 올려요. 보안 규칙은 지금처럼 콘솔에 붙여넣으면 돼요.

## 아이폰

아이폰·아이패드 사파리는 사이트를 **홈 화면에 추가**해서 연 경우에만 웹 푸시를 받을 수 있어요(iOS 16.4 이상). 앱을 만들면 앱 푸시로 바꿀 예정이에요.

## 확인용

```
node functions/test-digest.js
```
