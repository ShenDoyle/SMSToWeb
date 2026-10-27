# 셀프호스팅 배포 튜토리얼(Fly.io / Railway / VPS / 로컬)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

SMSToWeb을 Docker 컨테이너로 셀프호스팅합니다. 상주 프로세스, 함수 실행 시간 제한 없음, 롱 폴링 실시간성 최고이며, 서버를 보유했거나 Fly.io / Railway에 배포하고 싶은 사용자에게 적합합니다(무료 할당량은 아래 "플랫폼 안내" 참조).

**이 디렉터리의 파일**: `server.mjs`(Node 18+ 의존성 없는 엔트리, 내장 매일 정리 포함), `app.js`(코어 애플리케이션), `db.js`(Turso / 로컬 SQLite 듀얼 모드 어댑터 계층), `schema.sql`(테이블 생성), `Dockerfile`, `package.json`.

---

## 준비물

- Fly.io 또는 Railway 계정(또는 Docker가 있는 어떤 VPS든)
- 데이터베이스는 여전히 Turso(SQLite 호환)를 사용하며, 아래 1단계에서 일괄 준비합니다

## 1단계: Turso 데이터베이스 생성

1. [turso.tech](https://turso.tech)를 열고 **Start for free now** 클릭, GitHub으로 로그인
2. 콘솔 진입 → **Create Database**:
   - Name: `sms-gateway`
   - Location: 서버와 가까운 리전 선택
   - Type: Free
3. 생성 후 데이터베이스 상세 페이지 진입:
   - **Database URL**(`libsql://sms-gateway-xxxx.turso.io` 형태) 기록
   - **Create Token** 클릭으로 접근 토큰 생성, **즉시 복사·저장**(한 번만 표시됨)
4. 테이블 구조 초기화: 데이터베이스 상세 페이지 → **Console** → 이 디렉터리의 [`schema.sql`](../../../platforms/node/schema.sql) 전체를 붙여넣기 → 실행 → 성공 메시지 확인

> CLI 방식: `turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`.

## 방식 A: Fly.io

1. 로컬에 flyctl 설치([공식 설치 안내](https://fly.io/docs/flyctl/install/)) 후 `fly auth login`
2. 이 디렉터리에서 실행:

```bash
cd platforms/node
fly launch                 # 按提示创建应用：区域自选；询问数据库时选 No（我们用 Turso）
fly secrets set TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io TURSO_AUTH_TOKEN=<你的令牌> RECEIVE_TOKEN=<你的密钥>
fly secrets set ENABLE_AUTH=true ADMIN_PASSWORD=<你的密码>     # 可选
fly deploy
fly status                 # 记下分配的域名 https://<app>.fly.dev
```

3. 검증: 브라우저로 `https://<app>.fly.dev`를 열면 관리 페이지가 보여야 함; 푸시 테스트:

```
curl "https://<app>.fly.dev/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Fly 部署成功\"}"
```

4. 커스텀 도메인: `fly certs add sms.你的域名.com`, 안내에 따라 DNS 추가(A 레코드 또는 CNAME)

## 방식 B: Railway

1. [railway.app](https://railway.app) 로그인 → **New Project → Deploy from GitHub repo**, Fork한 저장소 선택
2. 서비스 설정 **Settings → Root Directory**: `platforms/node`(Railway가 Dockerfile을 자동 인식하고 빌드)
3. **Variables** 패널에서 환경 변수 추가(아래 공통 표 참조; `PORT`는 플랫폼이 자동 주입하며 코드가 이미 대응됨)
4. **Settings → Public Networking → Generate Domain**으로 공개 도메인 생성
5. 검증은 위와 동일(당신의 Railway 도메인으로 교체)

## 방식 C: 임의 VPS(Docker)

```bash
# 上传本目录到服务器后
cd platforms/node
docker build -t smstoweb .
docker run -d --name smstoweb --restart unless-stopped -p 8787:8787 \
  -e TURSO_DATABASE_URL=libsql://sms-gateway-xxxx.turso.io \
  -e TURSO_AUTH_TOKEN=<你的令牌> \
  -e RECEIVE_TOKEN=<你的密钥> \
  smstoweb
# 验证
curl "http://127.0.0.1:8787/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"content\":\"VPS 部署成功\"}"
```

Caddy/Nginx 역프록시로 HTTPS를 추가하는 것을 권장합니다. Docker 없이 `node server.mjs`로 직접 실행도 가능합니다(Node 18+ 필요, npm 의존성 0; 로컬 SQLite 모드는 Node 22.13+ 필요).

## 환경 변수(세 방식 공통)

| 이름 | 값 | 설명 |
|---|---|---|
| `SQLITE_PATH`(선택) | 예: `/data/data.db` | **로컬 SQLite 모드**: 설정하면 외부 데이터베이스 불필요, 데이터를 로컬 파일에 저장(Node 22.13+ 필요, 첫 시작 시 자동 테이블 생성; Turso와 택1이며 설정 시 우선) |
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | Turso 모드: 1단계에서 기록한 URL |
| `TURSO_AUTH_TOKEN` | (1단계의 토큰) | Turso 모드: 한 번만 표시되는 그 값 |
| `RECEIVE_TOKEN` | 직접 만든 긴 임의 문자열 | 푸시 인증, 예시 값 사용 금지 |
| `ENABLE_AUTH` | `false` | 로그인 필요 시 `true`(**보안상 강력 권장**: 관리 페이지는 SMS 인증 코드 등 민감한 내용을 담으며, 기본 무로그인은 도메인만 알면 모든 메시지를 볼 수 있다는 뜻) |
| `ADMIN_PASSWORD` | 직접 만든 비밀번호 | `ENABLE_AUTH="true"`일 때만 필요 |
| `SESSION_SECRET` | 고엔트로피 임의 값(≥32자 임의 문자열) | `ENABLE_AUTH="true"`일 때만 필요; 비밀번호와 독립; 누락 시 로그인/인증 fail-closed, 교체 후 기존 세션 전부 무효 |
| `RETENTION_DAYS` | `30` | 데이터 보존 일수 |
| `PORT` | 기본 `8787` | 보통 설정 불필요(Railway가 자동 주입) |
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

## 휴대폰 및 기기 연동

[멀티플랫폼 연동 배포 가이드](./DEPLOYMENT.md)대로 안드로이드 SmsForwarder와 각 기기 알림 푸시를 설정하고, 도메인은 당신의 서비스 주소를 사용하세요.

## 주의 사항 및 자주 묻는 질문

- **예약 정리**: 프로세스에 매일 UTC 17:00(베이징 01:00) 자동 정리가 내장되어 설정 불필요. 플랫폼 스케줄러(Fly Machines Cron / Railway Cron)로 `GET /api/cron?token=<RECEIVE_TOKEN>`을 호출하게 바꿀 수도 있으며, 둘 중 택1
- **상주 프로세스의 장점**: 함수 실행 시간 상한이 없어 `/api/wait` 롱 폴링이 Cloudflare Worker와 같은 경험, 실시간성 최고
- **무료 할당량**: Fly.io는 더 이상 무료 할당량이 없음(신규 계정 7일 / 2 VM시간 체험뿐, 카드 등록 시 종량 과금 전환, 미량 사용은 비용 매우 낮음); Railway는 일회성 $5 체험 크레딧(30일 유효), Hobby 플랜은 $5/월에 동액 사용 크레딧 포함 — 장기 제로 비용은 Cloudflare 메인 버전이 최선
- **데이터 백업**: Turso 모드에서는 데이터가 모두 Turso에 있어 서버를 바꿔도 환경 변수만 다시 설정하면 데이터 무손실; 로컬 SQLite 모드는 `SQLITE_PATH` 파일을 주기적으로 백업하면 됩니다
- **로그인 보호**: 로그인 엔드포인트에는 속도 제한 내장 — 같은 IP 연속 5회 실패 시 10분 잠금(메모리 상태, 프로세스 재시작 시 초기화)
- **http 배포 로그인**: 내부망 IP / TLS 없는 http 접근에서도 바로 로그인 가능(cookie 자동 다운그레이드, Secure 강제 없음), Alook 등 브라우저 로그인 후 리다이렉트 정상
- **로그 점검**: `fly logs` / Railway Deployments → Logs / `docker logs smstoweb`
