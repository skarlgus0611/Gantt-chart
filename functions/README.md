# 마감 알림 메일 (서버)

매일 오전 8시(서울)에 한 번, 오늘 보낼 마감 알림 메일을 보내요.

| 언제 | 사이트 안 (종 버튼) | 메일 |
|---|---|---|
| D-15 | ✅ | ✅ |
| D-7 · D-1 · 당일 | ✅ | ✅ |
| 지연 1 · 4 · 7일째 | ✅ | ✅ |
| 그 뒤 지연 14 · 21 · 28 …일째 (매주) | ✅ | ✅ |
| 완료(100%) 또는 [지연 확인] | 알림 끝 | 알림 끝 |

**누가 받나**
- 담당자가 정해져 있고(이메일) 이 사이트에 가입한 경우에만 그 담당자에게 보내요. 그 밖의 경우는 아무에게도 안 보내요.
- 종 버튼 설정에서 메일을 끌 수 있어요 (기본 켜짐).

**일정 메일 (선택, 기본 꺼짐)** — 위 마감 알림과 따로, 본인이 정한 주기마다 끝나지 않은 작업 전체를 한 통으로 보내요.
- 종 버튼 → 설정 → 일정 메일 토글을 켜고 주기를 골라요: 매일 · 3일 · 1주일 · 직접 설정(숫자 + 일/주/달).
- 받을 작업: 내 작업(담당자가 나, 기본) 또는 내 차트 전체(내가 소유·참여한 차트).
- 설정한 다음 날 아침 8시에 첫 메일, 그 뒤 주기마다. 토글을 꺼도 고른 주기는 기억해요.

## 처음 한 번 준비하기 (무료 — GitHub 가 매일 오전 8시에 보냄)

카드 등록(Blaze) 없이 됩니다. GitHub Actions 가 매일 오전 8시(서울)에 `functions/run-daily.js` 를 돌려요
(`.github/workflows/daily-notices.yml`). GitHub 사정으로 수십 분 늦게 올 수 있어요.

1. **Firebase 키** — Firebase 콘솔 → 프로젝트 설정(톱니) → **서비스 계정** 탭 → **새 비공개 키 생성** → JSON 파일이 받아져요.
2. **(메일을 보내려면) Gmail 앱 비밀번호** — 보낼 Gmail 계정 → 보안 → 2단계 인증 켜기 → "앱 비밀번호"에서 16자리 만들기.
3. **GitHub 비밀값** — 저장소 Settings → Secrets and variables → Actions → New repository secret

   | Name | 값 |
   |---|---|
   | `FIREBASE_SERVICE_ACCOUNT` | 1번 JSON 파일 내용 통째로 |
   | `SMTP_USER` | 보낼 Gmail 주소 (메일 안 쓰면 안 넣어도 됨) |
   | `SMTP_PASS` | 16자리 앱 비밀번호 (메일 안 쓰면 안 넣어도 됨) |
   | `SMTP_HOST` | (선택) Gmail 이 아닐 때. 네이버면 `smtp.naver.com` |
   | `SMTP_PORT` | (선택) 네이버면 `465` |

4. **확인** — 저장소 Actions 탭 → **Daily due notices** → **Run workflow**. "미리보기"를 켜면 보내지 않고 누구에게 무엇을 보낼지만 기록에 나와요.

## (선택) Blaze 요금제라면

Firebase Cloud Functions 로도 같은 일을 할 수 있어요(`functions/index.js`). 이 경우 GitHub 예약 실행은 꺼 두세요.
```
npm install -g firebase-tools && firebase login
cd functions && npm install && cd ..
firebase functions:secrets:set SMTP_USER
firebase functions:secrets:set SMTP_PASS
firebase deploy --only functions
```

## 확인용

```
node functions/test-digest.js
```
