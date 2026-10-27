# Deno Deploy 배포 튜토리얼

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

SMSToWeb을 Deno Deploy(Deno 네이티브 런타임 + Turso 데이터베이스)에 배포합니다. Cloudflare Worker와 의미론이 가장 가깝고, 무료 플랜은 매월 100만 요청이며, 전체 약 15분입니다.

> 플랫폼 안내: Deno Deploy는 신세대 플랫폼으로 업그레이드되었으며 콘솔은 [console.deno.com](https://console.deno.com)입니다(구버전 dash.deno.com은 서비스 종료), CI와 유사한 Git 빌드 모델을 채택합니다.

**이 디렉터리의 파일**: `main.js`(엔트리, `Deno.serve`와 내장 `Deno.cron` 예약 정리 포함), `app.js`(코어 애플리케이션), `db.js`(Turso 어댑터 계층), `schema.sql`(테이블 생성).

---

## 준비물

1. GitHub 계정 하나
2. Deno Deploy 계정 하나([가입入口](https://console.deno.com), GitHub으로 바로 로그인)

## 1단계: 코드 저장소 준비

1. 프로젝트 GitHub 저장소를 열고 오른쪽 위 **Fork** 클릭(또는 직접 Push한 자신의 저장소 사용)

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
4. 테이블 구조 초기화: 데이터베이스 상세 페이지 → **Console** → 이 디렉터리의 [`schema.sql`](../../../platforms/deno/schema.sql) 전체를 붙여넣기 → 실행 → 성공 메시지 확인

> Turso CLI도 가능: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## 3단계: Deno Deploy에서 앱 생성 후 저장소 연결

1. [console.deno.com](https://console.deno.com) 로그인 → **+ New App**(새 앱) 클릭
2. **GitHub 저장소에서 배포** 선택, 승인 후 Fork한 저장소 선택
3. 빌드 구성(Build Configuration):
   - **런타임 작업 디렉터리**(Runtime working directory): `platforms/deno`
   - **Entrypoint**(엔트리 파일): `main.js`
4. 먼저 환경 변수 추가(4단계 참조), 그다음 첫 배포 트리거
5. 배포 완료 후 GitHub 저장소에 push하면 자동 재빌드됩니다

## 4단계: 환경 변수 설정

앱 **Settings → Environment Variables**에서 하나씩 추가(앱 생성 시 설정 페이지에서 추가해도 됨):

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

저장 후 자동 재배포가 적용될 때까지 대기합니다.

## 5단계: 배포 검증

1. 할당된 도메인(`https://<앱이름>.<조직이름>.deno.net` 형태) 기록
2. 브라우저로 해당 도메인을 열면 관리 페이지가 보여야 함(기본 "短信网关"; 로그인을 켰다면 먼저 로그인 페이지)
3. 푸시 API 검증:

```
curl "https://<域名>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Deno Deploy 部署成功\"}"
```

`{"success":true,...}`가 반환되면 연결 성공이며, 웹페이지에 이 메시지가 즉시 나타나야 합니다.

## 6단계: 휴대폰 및 기기 연동

[멀티플랫폼 연동 배포 가이드](./DEPLOYMENT.md)대로 안드로이드 SmsForwarder와 각 기기 알림 푸시를 설정하고, 도메인은 당신의 `xxx.deno.net`을 사용하세요.

커스텀 도메인: 조직의 **Domains** 탭에서 도메인을 추가하고 앱에 할당, 안내에 따라 도메인 DNS에 CNAME(또는 A 레코드)과 검증 레코드를 추가하면 HTTPS 인증서는 자동 발급됩니다.

## 주의 사항 및 자주 묻는 질문

- **예약 정리**: `Deno.cron`은 배포 시 자동 등록됩니다(매일 UTC 17:00 = 베이징 01:00), 추가 설정도 불필요하고 수동 트리거 테스트도 불가 — 검증은 Turso 데이터가 예정대로 줄어드는지로 확인
- **무료 할당량**: 매월 100만 요청, Active CPU 10시간, 20GiB 아웃바운드 트래픽, 개인 사용에 충분
- **롱 폴링**: Deno Deploy에는 엄격한 단일 요청 시간 상한이 없어 `/api/wait` 25초 롱 폴링이 잘 동작; 인스턴스가 유휴 상태면 플랫폼이 회수·재시작할 수 있으나(중단된 롱 폴링은 프런트엔드가 자동 재시도) 실시간성은 Worker 버전과 거의 동일
- **배포 실패 점검**: Entrypoint는 반드시 `main.js`, 런타임 작업 디렉터리는 반드시 `platforms/deno`; `TURSO_*` 환경 변수가 없으면 500 "config error"
- **코드 갱신**: GitHub 저장소에 push하면 자동 재배포
