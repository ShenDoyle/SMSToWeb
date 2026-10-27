# Vercel 배포 튜토리얼

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

SMSToWeb을 Vercel(Edge Function + Turso 데이터베이스)에 배포합니다. 무료 할당량으로 개인 사용에 충분하며 전체 약 15분입니다.

**이 디렉터리의 파일**: `api/[[...route]].js`(엔트리), `app.js`(코어 애플리케이션), `db.js`(Turso 어댑터 계층), `schema.sql`(테이블 생성), `vercel.json`(예약 작업 설정 포함).

---

## 원클릭 배포(권장)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

**먼저 아래 2단계(Turso 데이터베이스 생성)를 마쳐 연결 정보를 확보한 뒤** 버튼을 누르는 것을 권장합니다: Vercel이 이 플랫폼 하위 디렉터리를 당신의 저장소로 클론하고 프로젝트를 생성하며, 안내에 따라 `RECEIVE_TOKEN`(푸시 인증 시크릿, 직접 만든 긴 임의 문자열)과 Turso의 URL / Token을 채우면 배포됩니다. 배포 성공 후 **반드시 3단계의 테이블 생성 SQL을 한 번 실행하세요**(Vercel은 자동 테이블 생성이 불가), 그렇지 않으면 페이지를 열어도 데이터가 없습니다.

---

## 준비물

1. GitHub 계정 하나(Vercel은 GitHub 저장소로 배포)
2. Vercel 계정 하나([가입入口](https://vercel.com/signup), GitHub으로 바로 로그인)

## 1단계: 코드 저장소 준비

1. 프로젝트 GitHub 저장소를 열고 오른쪽 위 **Fork** 클릭(또는 직접 Push한 자신의 저장소 사용)
2. Fork가 끝나면 자유롭게 수정 가능한 프로젝트 사본이 생깁니다

## 2단계: Turso 데이터베이스 생성

Turso는 SQLite 호환 데이터베이스를 제공합니다(무료 할당량: 데이터베이스 100개, 저장소 5GB, 매월 5억 행 읽기).

1. [turso.tech](https://turso.tech)를 열고 **Start for free now** 클릭, GitHub으로 로그인
2. 콘솔 진입 → **Create Database**(데이터베이스 생성):
   - Name: `sms-gateway`
   - Location: 가까운 리전 선택(예: Singapore / Hong Kong)
   - Type: Free
3. 생성 후 데이터베이스 상세 페이지 진입:
   - **Database URL**(`libsql://sms-gateway-xxxx.turso.io` 형태) 기록
   - **Create Token**(또는 Turso Platform Tokens) 클릭으로 접근 토큰 생성, **즉시 복사·저장**(한 번만 표시됨)
4. 테이블 구조 초기화: 데이터베이스 상세 페이지 → **Console**(웹 SQL 콘솔) → 이 디렉터리의 [`schema.sql`](../../../platforms/vercel/schema.sql) 전체를 붙여넣기 → 실행 → 성공 메시지 확인(`messages`와 `devices` 두 테이블 생성)

> Turso CLI도 가능: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## 3단계: 저장소를 Vercel로 가져오기

1. [vercel.com](https://vercel.com) 로그인 → **Add New → Project**
2. **Import Git Repository** 목록에서 Fork한 저장소를 찾아 **Import** 클릭
3. 설정 페이지에서 **Root Directory**(루트 디렉터리)를 펼쳐 `platforms/vercel` 선택
   — Vercel이 디렉터리 내의 `vercel.json`과 `api/` 디렉터리를 자동 인식하므로 다른 설정 불필요
4. 아직 Deploy를 누르지 말고, 먼저 4단계의 환경 변수 설정(같은 페이지의 **Environment Variables** 영역에서 추가)

## 4단계: 환경 변수 설정

배포 설정 페이지의 **Environment Variables**에서 하나씩 추가(이후 Project → Settings에서도 변경 가능):

| 이름 | 값 | 설명 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | 2단계에서 기록한 URL |
| `TURSO_AUTH_TOKEN` | (2단계의 토큰) | 한 번만 표시되는 그 값 |
| `RECEIVE_TOKEN` | 직접 만든 긴 임의 문자열 | 푸시 인증, 예시 값 사용 금지 |
| `ENABLE_AUTH` | `false` | 로그인 필요 시 `true` |
| `ADMIN_PASSWORD` | 직접 만든 비밀번호 | `ENABLE_AUTH="true"`일 때만 필요 |
| `SESSION_SECRET` | 고엔트로피 임의 값(≥32자 임의 문자열) | `ENABLE_AUTH="true"`일 때만 필요; 비밀번호와 독립, 다른 플랫폼과 각각 별도 값; 누락 시 로그인/인증 fail-closed, 교체 후 기존 세션 전부 무효 |
| `RETENTION_DAYS` | `30` | 데이터 보존 일수 |
| `CRON_SECRET` | **RECEIVE_TOKEN과 같은 값** | Vercel Cron이 /api/cron 호출 시 자동으로 `Bearer $CRON_SECRET` 첨부 |
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

전부 채운 뒤 **Deploy** 클릭, 약 1분 대기 후 배포 완료.

## 5단계: 배포 검증

1. 배포 완료 페이지에서 **Continue to Dashboard** 클릭, 상단에 할당된 도메인(`https://xxx.vercel.app` 형태) 기록
2. 브라우저로 해당 도메인을 열면 관리 페이지가 보여야 함(기본 "短信网关"; 로그인을 켰다면 먼저 로그인 페이지)
3. 푸시 API 검증(`<도메인>`과 `<시크릿>`을 당신 것으로 교체):

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel 部署成功\"}"
```

`{"success":true,...}`가 반환되면 연결 성공이며, 웹페이지에 이 메시지가 즉시 나타나야 합니다.

## 6단계: 휴대폰 및 기기 연동

[멀티플랫폼 연동 배포 가이드](./DEPLOYMENT.md)대로 안드로이드 SmsForwarder(SMS는 `/api/receive` 사용)와 각 기기 알림 푸시(`/api/push` 사용)를 설정하고, 도메인은 당신의 `xxx.vercel.app`(또는 바인딩한 커스텀 도메인)을 사용하세요.

커스텀 도메인 바인딩: Project → **Settings → Domains** → Add, 안내에 따라 도메인 DNS에 CNAME 레코드 하나 추가 — 대상 값은 Domains 페이지에 표시되는 것 기준(Vercel은 프로젝트마다 전용 `xxxxxx.vercel-dns.com` 주소를 할당).

## 주의 사항 및 자주 묻는 질문

- **예약 정리**: `vercel.json`이 매일 UTC 17:00(베이징 01:00)에 `/api/cron`을 호출해 만료 데이터를 정리하도록 구성되어 있습니다. Vercel Cron은 자동으로 `Authorization: Bearer $CRON_SECRET`을 붙이므로 `CRON_SECRET`은 반드시 `RECEIVE_TOKEN`과 일치해야 함
- **Hobby(무료) 플랜 제한**: cron은 하루 1회만 지원(이 프로젝트는 정확히 하루 1회라 충족; 실제 트리거 시각은 설정된 시간대 내에서 다소 떠돌 수 있으며 정상 현상); Edge 함수는 **25초 내에 응답을 시작해야** 하며(이후 300초 스트리밍 가능), 관리 페이지 롱 폴링 `/api/wait`가 정확히 25초 대기하므로 경계에 걸림 — 일찍 잘리더라도 프런트엔드 폴링 루프가 자동 재시도하여 **기능에는 영향 없음**, 새 메시지 알림만 약간 늦음
- **Edge Runtime**: 엔트리가 `runtime = "edge"`를 선언, 콜드 스타트가 빠르고 전 세계 엣지 노드에서 실행
- **배포 실패 점검**: 대부분 환경 변수 누락 — `TURSO_*`가 없으면 500과 "config error"; Root Directory가 `platforms/vercel`로 올바르게 선택됐는지 확인
- **코드 갱신**: Fork한 저장소에 push하면 Vercel이 자동 재배포
