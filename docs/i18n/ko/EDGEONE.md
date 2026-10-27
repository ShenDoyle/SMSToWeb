# Tencent EdgeOne Makers 배포 튜토리얼

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

SMSToWeb을 Tencent EdgeOne Makers(구 EdgeOne Pages, Functions + Turso 데이터베이스)에 배포합니다. 중국 내 접속 경험이 좋고, 전체 약 15분입니다.

**이 디렉터리의 파일**: `functions/index.js`(루트 경로 `/` 전용 엔트리, 전체 로직과 ENV_KEYS 화이트리스트의 단일 소스), `functions/[[default]].js`(나머지 라우트를 받는 폴백, index.js만 re-export하므로 별도 유지 불필요), `app.js`(코어 애플리케이션), `db.js`(Turso 어댑터 계층), `schema.sql`(테이블 생성).

---

## 준비물

1. Tencent Cloud 계정 하나([가입入口](https://cloud.tencent.com), 실명 인증 필요)
2. GitHub 계정 하나(EdgeOne Makers는 Git 저장소에서의 배포 지원)

## 1단계: 코드 저장소 준비

프로젝트 GitHub 저장소를 열고 오른쪽 위 **Fork** 클릭(또는 직접 Push한 자신의 저장소 사용).

## 2단계: Turso 데이터베이스 생성

Turso는 SQLite 호환 데이터베이스를 제공합니다(무료 할당량: 데이터베이스 100개, 저장소 5GB, 매월 5억 행 읽기). EdgeOne Functions에서 외부 인터넷 데이터베이스 접근이 원활합니다.

1. [turso.tech](https://turso.tech)를 열고 **Start for free now** 클릭, GitHub으로 로그인
2. 콘솔 진입 → **Create Database**:
   - Name: `sms-gateway`
   - Location: Singapore / Hong Kong 권장(중국 내 접속 지연 낮음)
   - Type: Free
3. 생성 후 데이터베이스 상세 페이지 진입:
   - **Database URL**(`libsql://sms-gateway-xxxx.turso.io` 형태) 기록
   - **Create Token** 클릭으로 접근 토큰 생성, **즉시 복사·저장**(한 번만 표시됨)
4. 테이블 구조 초기화: 데이터베이스 상세 페이지 → **Console** → 이 디렉터리의 [`schema.sql`](../../../platforms/edgeone/schema.sql) 전체를 붙여넣기 → 실행 → 성공 메시지 확인

> Turso CLI도 가능: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## 3단계: EdgeOne Makers에서 프로젝트 생성

1. Tencent Cloud 콘솔 로그인 → **EdgeOne Makers**(구 "EdgeOne Pages") 검색, 또는 [console.cloud.tencent.com/edgeone/pages](https://console.cloud.tencent.com/edgeone/pages) 접속
2. **프로젝트 생성** → **Git 저장소에서 가져오기** 선택 → GitHub 승인 후 Fork한 저장소 선택
3. 빌드 구성:
   - **루트 디렉터리**: `platforms/edgeone`
   - 프레임워크 프리셋: "프레임워크 없음 / Other" 선택 또는 공백(순수 Functions는 빌드 불필요)
4. 환경 변수 설정 영역에서 먼저 변수 추가(4단계 참조), 그다음 배포 시작 클릭
5. 배포 완료 대기(약 1분), 할당된 기본 도메인(예: `*.edgeone.app`) 기록

## 4단계: 환경 변수 설정

프로젝트 **설정 → 환경 변수**에서 하나씩 추가(Functions는 `onRequest`의 `env` 매개변수로 읽음):

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

저장 후 재배포해야 적용됩니다.

## 5단계: 배포 검증

1. 브라우저로 할당된 도메인을 열면 관리 페이지가 보여야 함(기본 "短信网关"; 로그인을 켰다면 먼저 로그인 페이지)
2. 푸시 API 검증:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"EdgeOne 部署成功\"}"
```

`{"success":true,...}`가 반환되면 연결 성공이며, 웹페이지에 이 메시지가 즉시 나타나야 합니다.

## 6단계: 커스텀 도메인 바인딩(중국 내 접속 권장)

1. 프로젝트 **설정 → 커스텀 도메인** → 당신의 도메인 추가(예: `sms.你的域名.com`)
2. 안내에 따라 도메인 DNS에 EdgeOne이 할당한 주소를 가리키는 CNAME 레코드 추가
3. 도메인은 ICP 등록(비안)을 마쳐야 합니다(Tencent Cloud 중국 노드 요건); 미등록 도메인은 해석이 거부됩니다

## 7단계: 예약 정리 구성(외부 cron)

EdgeOne Makers에는 아직 네이티브 예약 작업이 없으므로, 무료 외부 cron 서비스 하나로 매일 정리 API를 호출합니다:

1. [cron-job.org](https://cron-job.org)에서 가입하고 **Create cronjob**:
   - URL: `https://<당신의도메인>/api/cron?token=<당신의RECEIVE_TOKEN>`
   - Schedule: 매일(예: 베이징 시간 01:00, 즉 UTC 17:00)
2. 저장 후 활성화. 시각이 되면 게이트웨이가 `RETENTION_DAYS`를 초과한 데이터를 자동 삭제합니다

## 휴대폰 및 기기 연동

[멀티플랫폼 연동 배포 가이드](./DEPLOYMENT.md)대로 안드로이드 SmsForwarder와 각 기기 알림 푸시를 설정하고, 도메인은 당신의 EdgeOne 도메인을 사용하세요.

## 주의 사항 및 자주 묻는 질문

- **루트 경로 404(중요, 2026-10 실측)**: EdgeOne Makers의 Functions 라우팅 규칙에서 `[[default]].js` 폴백은 `/foo`, `/api/xxx` 등 루트가 아닌 경로만 매칭하고, **루트 경로 `/`는 `functions/index.js`만 인식**합니다 — 이 파일이 없으면 홈페이지가 플랫폼 기본 404 페이지로 직행합니다(API는 정상). 이 디렉터리에는 이미 `functions/index.js`가 내장되어 해결되어 있습니다(로직과 ENV_KEYS 화이트리스트의 단일 소스, `[[default]].js`는 이를 re-export만 하므로 두 곳에서 유지할 필요 없음)
- **롱 폴링**: Functions 실행 시간 상한이 다소 빡빡하여 `/api/wait`(25초 대기)가 일찍 잘릴 수 있음 — 프런트엔드가 자동 재시도하므로 기능에는 영향 없음
- **배포 실패 점검**: 루트 디렉터리는 반드시 `platforms/edgeone`; `TURSO_*` 환경 변수가 없으면 500 "config error"
- **코드 갱신**: GitHub 저장소에 push하면 자동 재배포
