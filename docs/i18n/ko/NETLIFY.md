# Netlify 배포 튜토리얼

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

SMSToWeb을 Netlify(Functions v2 + Turso 데이터베이스)에 배포합니다. 전체 약 15분입니다.

**이 디렉터리의 파일**: `functions/api.mjs`(엔트리, `path: "/*"`로 전체 라우트 캡처), `functions/cron.mjs`(예약 정리 Scheduled Function), `app.js`(코어 애플리케이션), `db.js`(Turso 어댑터 계층), `schema.sql`(테이블 생성), `netlify.toml`(사이트 설정).

---

## 원클릭 배포(권장)

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/ShenDoyle/SMSToWeb)

버튼을 누르면 저장소가 당신의 GitHub으로 클론되고 생성 마법사로 진입합니다. 두 곳만 주의:

1. **빌드 설정의 Base directory에 `platforms/netlify` 입력**(이 플랫폼의 `netlify.toml`이 그 하위 디렉터리에 있으며, 올바르게 채우면 빌드 명령 등이 자동 인계됨); 나머지는 기본값 유지
2. 먼저 아래 2단계(Turso 데이터베이스 생성)를 마쳐 연결 정보를 확보하고, 생성 후 **Site configuration → Environment variables**에서 `RECEIVE_TOKEN` / `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`을 채우고 재배포; 마지막으로 3단계의 테이블 생성 SQL 실행(Netlify는 자동 테이블 생성 불가)

---

## 준비물

1. GitHub 계정 하나
2. Netlify 계정 하나([가입入口](https://app.netlify.com/signup), GitHub으로 바로 로그인)

## 1단계: 코드 저장소 준비

프로젝트 GitHub 저장소를 열고 오른쪽 위 **Fork** 클릭(또는 직접 Push한 자신의 저장소 사용).

## 2단계: Turso 데이터베이스 생성

Turso는 SQLite 호환 데이터베이스를 제공합니다(무료 할당량: 데이터베이스 100개, 저장소 5GB, 매월 5억 행 읽기).

1. [turso.tech](https://turso.tech)를 열고 **Start for free now** 클릭, GitHub으로 로그인
2. 콘솔 진입 → **Create Database**:
   - Name: `sms-gateway`
   - Location: 가까운 리전 선택(예: Singapore / Hong Kong)
   - Type: Free
3. 생성 후 데이터베이스 상세 페이지 진입:
   - **Database URL**(`libsql://sms-gateway-xxxx.turso.io` 형태) 기록
   - **Create Token** 클릭으로 접근 토큰 생성, **즉시 복사·저장**(한 번만 표시됨)
4. 테이블 구조 초기화: 데이터베이스 상세 페이지 → **Console** → 이 디렉터리의 [`schema.sql`](../../../platforms/netlify/schema.sql) 전체를 붙여넣기 → 실행 → 성공 메시지 확인

> Turso CLI도 가능: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## 3단계: 저장소를 Netlify로 가져오기

1. [app.netlify.com](https://app.netlify.com) 로그인 → **Add new project → Import an existing project**
2. **Deploy with GitHub** 선택, 승인 후 목록에서 Fork한 저장소 선택
3. 배포 설정 페이지(Site settings for…):
   - **Base directory**(루트 디렉터리): `platforms/netlify` 입력
   - Build command / Publish directory: 기본값 유지(`netlify.toml`이 디렉터리 안에 있어 자동 적용)
4. 아래 **Show advanced → New variable**을 펼쳐 먼저 환경 변수 추가(4단계 참조), 그다음 **Deploy** 클릭

## 4단계: 환경 변수 설정

배포 설정 페이지의 고급 옵션에서 추가(이후 **Project configuration → Environment variables**에서도 변경 가능):

| 이름 | 값 | 설명 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 2단계에서 기록한 URL |
| `TURSO_AUTH_TOKEN` | (2단계의 토큰) | 한 번만 표시되는 그 값 |
| `RECEIVE_TOKEN` | 직접 만든 긴 임의 문자열 | 푸시 인증, 예시 값 사용 금지 |
| `ENABLE_AUTH` | `false` | 로그인 필요 시 `true` |
| `ADMIN_PASSWORD` | 직접 만든 비밀번호 | `ENABLE_AUTH="true"`일 때만 필요 |
| `SESSION_SECRET` | 고엔트로피 임의 값(≥32자 임의 문자열) | `ENABLE_AUTH="true"`일 때만 필요; 비밀번호와 독립, 다른 플랫폼과 각각 별도 값; 누락 시 로그인/인증 fail-closed, 교체 후 기존 세션 전부 무효 |
| `RETENTION_DAYS` | `30` | 데이터 보존 일수 |
| `FEISHU_WEBHOOK`(선택 `FEISHU_SECRET`) | (선택)Feishu 그룹 봇 웹훅 | 설정 후 새 메시지가 Feishu 그룹으로 자동 전달; 봇 보안 설정에서 "서명 검증" 선택 시 `FEISHU_SECRET` 추가 설정 |
| `WECOM_WEBHOOK` | (선택)WeCom 그룹 봇 웹훅 | 설정 후 새 메시지가 WeCom 그룹으로 자동 전달 |
| `DINGTALK_WEBHOOK` | (선택)DingTalk 그룹 봇 웹훅 | 서명 보안 설정 시 별도 `DINGTALK_SECRET` 필요 |
| `SERVERCHAN_SENDKEY` | (선택)ServerChan SendKey | WeChat 푸시 |
| `PUSHPLUS_TOKEN` | (선택)PushPlus 토큰 | WeChat 푸시 |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | (선택)Telegram Bot | 둘 다 설정해야 유효 |
| `BARK_DEVICE_KEY` | (선택)Bark 기기 Key | 자체 서버는 별도 `BARK_URL`, 기본 공식 |
| `NTFY_URL`(선택 `NTFY_TOKEN`) | (선택)ntfy 토픽 URL | 전체 URL, 예: `https://ntfy.sh/my-sms`; 보호 토픽은 별도 `NTFY_TOKEN`(Token 또는 user:password) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | (선택)Gotify | 서버 주소 + 앱 토큰 |
| `RESEND_API_KEY` + `MAIL_TO` | (선택)이메일(Resend) | 선택 `MAIL_FROM`, 기본 `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS`(선택 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | (선택)범용 웹훅 | 여러 URL은 쉼표 구분; 선택 템플릿으로 본문 커스텀, `GENERIC_WEBHOOK_HEADERS`(JSON 문자열)로 헤더 커스텀 |
| `SITE_NAME` / `SITE_ICON` | (선택) | 사이트 이름 / 아이콘 URL |
| `NOTIFY_LINK` | (선택) | 관리 페이지 홈 주소; 설정하면 모든 알림 채널에 "관리 페이지 열기" 항목 추가, 미설정 시 자동 생략 |

**Deploy** 클릭, 약 1분 대기 후 배포 완료.

## 5단계: 배포 검증

1. 배포 완료 후 사이트 도메인(`https://xxx.netlify.app` 형태) 기록
2. 브라우저로 해당 도메인을 열면 관리 페이지가 보여야 함(기본 "短信网关"; 로그인을 켰다면 먼저 로그인 페이지)
3. 푸시 API 검증:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Netlify 部署成功\"}"
```

`{"success":true,...}`가 반환되면 연결 성공이며, 웹페이지에 이 메시지가 즉시 나타나야 합니다.

## 6단계: 휴대폰 및 기기 연동

[멀티플랫폼 연동 배포 가이드](./DEPLOYMENT.md)대로 안드로이드 SmsForwarder와 각 기기 알림 푸시를 설정하고, 도메인은 당신의 `xxx.netlify.app`를 사용하세요.

커스텀 도메인: **Project configuration → Change site name**(서브도메인 변경) 또는 **Domain management → Add a domain**(자체 도메인, 안내에 따라 DNS 추가).

## 주의 사항 및 자주 묻는 질문

- **예약 정리**: `functions/cron.mjs`는 Netlify Scheduled Function으로 배포 후 자동 등록됩니다(매일 UTC 17:00 = 베이징 01:00), 추가 설정 불필요. 검증: 사이트 **Functions** 페이지에서 `cron` 함수와 그 스케줄 상태 확인 가능
- **함수 실행 시간과 실시간성**: 함수 기본 실행 상한은 현재 60초(모든 플랜 동일)이며, 관리 페이지 롱 폴링 `/api/wait`(25초 대기)를 충분히 기다릴 수 있어 실시간성 양호; 실시간성이 극도로 중요하다면 Cloudflare / 셀프호스팅 버전 권장
- **무료 할당량**: 2025-09부터 신규 계정은 크레딧 과금(Free 플랜 매월 300 크레딧, 함수 사용량은 GB-시간으로 산입), 개인 소량 트래픽에 충분; 기존 계정은 원래 플랜 유지 가능
- **배포 실패 점검**: Base directory는 반드시 `platforms/netlify`; `TURSO_*` 환경 변수가 없으면 500 "config error"; 사이트 **Functions → api → 로그**에서 오류 상세 확인 가능
- **코드 갱신**: GitHub 저장소에 push하면 자동 재배포
