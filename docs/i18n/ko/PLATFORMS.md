# 멀티플랫폼 배포 개요

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

SMSToWeb의 여섯 플랫폼(Cloudflare 메인 버전 + 5개 이식 버전)은 모두 이 디렉터리에 있습니다. **각 플랫폼 하위 디렉터리는 완전히 자기완결적**입니다:
코드(엔트리 + 코어 애플리케이션 + 데이터베이스 어댑터 계층) + `schema.sql` + 해당 플랫폼의 상세 배포 튜토리얼(README.md).

| 플랫폼 | 런타임 | 예약 정리 | 상세 튜토리얼 |
|---|---|---|---|
| **Cloudflare**(메인 버전) | Worker + D1 | 플랫폼 cron | [cloudflare/README.md](./CLOUDFLARE.md) |
| Vercel | Edge Function | 플랫폼 cron | [vercel/README.md](./VERCEL.md) |
| Deno Deploy | Deno 네이티브 | `Deno.cron`(내장) | [deno/README.md](./DENO.md) |
| Netlify | Functions v2(Node) | Scheduled Function | [netlify/README.md](./NETLIFY.md) |
| EdgeOne Makers(Tencent) | Functions | 외부 cron이 /api/cron 호출 | [edgeone/README.md](./EDGEONE.md) |
| Fly.io / Railway / VPS | Docker(Node 22) + Turso/로컬 SQLite | 프로세스 내장 | [node/README.md](./NODE.md) |

6개 플랫폼(Cloudflare 포함)은 API 경로, 인증 로직, 메시지 모델, 관리 페이지, 멀티채널 알림 전달, 매일 정리(UTC 17:00)가 완전히 동일하고,
데이터 테이블 구조도 같아서 언제든 서로 마이그레이션할 수 있습니다.

> **원클릭 배포**: Cloudflare / Vercel / Netlify 세 플랫폼 튜토리얼 상단에 공식 원클릭 배포 버튼이 있습니다(Cloudflare 버튼은 데이터베이스·테이블 생성까지 자동으로 처리).
> Deno Deploy, EdgeOne, Docker 셀프호스팅은 아직 공식 버튼이 없으므로 각 플랫폼 튜토리얼대로 진행하면 됩니다.

## 플랫폼 선택 방법

- **제로 비용 + 간편함** → Cloudflare 메인 버전(D1 무료 할당량이 크고, Worker는 시간 제한 문제 없음)
- **여러 플랫폼 경험** → Deno Deploy(Worker와 의미론이 가장 가깝고, 롱 폴링이 거의 잘리지 않음)
- **중국 내 접속 위주** → EdgeOne Makers(커스텀 도메인은 ICP 등록(비안)이 필요하니 주의)
- **서버 보유 / 완전한 통제** → node/(Docker 셀프호스팅)

> **롱 폴링과 플랫폼 타임아웃**: 관리 페이지는 `GET /api/wait`로 새 메시지를 대기하며 기본 최대 25초이고, 환경 변수 `WAIT_MAX_SECONDS`(3–25)로 플랫폼별로 낮출 수 있습니다.
> Netlify Functions의 현재 상한은 60초(엔트리 기본 `WAIT_MAX_SECONDS=8`은 보수적 적응값, 필요 시 상향 가능); Vercel Edge는 `20` 권장; Cloudflare / Deno / Node는 기본값 그대로 두면 됩니다.
> 프런트엔드는 실패 시 **지수 백오프**(2→30초)를 하고 페이지가 다시 보이면 즉시 재요청하므로, 플랫폼이 일찍 잘라도 **기능에는 영향이 없고** 새 메시지 알림만 약간 늦어집니다.

## 공통 준비(비 Cloudflare 플랫폼 공용)

**데이터베이스는 [Turso](https://turso.tech)로 통일**(SQLite 호환, 무료 할당량: 데이터베이스 100개, 저장소 5GB, 매월 5억 행 읽기):

1. [turso.tech](https://turso.tech)를 열고 GitHub으로 로그인
2. **Create Database**: 이름 `sms-gateway`, 리전은 Singapore / Hong Kong 선택, 타입 Free
3. 데이터베이스 상세 페이지에서 **Database URL**(`libsql://sms-gateway-xxxx.turso.io`)을 기록; **Create Token**으로 토큰을 만들고 즉시 저장(한 번만 표시됨)
4. 테이블 구조 초기화: 상세 페이지 **Console**에 각 플랫폼 디렉터리의 `schema.sql` 전체를 붙여넣고 실행(저장소 루트의 `schema.sql`과 동일)

CLI 동등 명령:

```bash
turso auth login
turso db create sms-gateway          # 创建数据库
turso db show sms-gateway --url      # 查看 URL
turso db tokens create sms-gateway   # 创建令牌
turso db shell sms-gateway < schema.sql   # 建表
```

**환경 변수**(각 플랫폼 설정 패널에서 구성, 전체 설명은 각 플랫폼 튜토리얼 참조):

| 변수 | 필수 | 설명 |
|---|---|---|
| `TURSO_DATABASE_URL` | 예 | `libsql://sms-gateway-<조직>.turso.io` |
| `TURSO_AUTH_TOKEN` | 예 | 데이터베이스 접근 토큰 |
| `RECEIVE_TOKEN` | 예 | 푸시 인증 시크릿(연동 URL의 `token=`과 일치) |
| `ENABLE_AUTH` | 아니요 | `"true"`이면 관리 페이지 로그인 필요(**보안상 강력 권장**, 아래 보안 권고 참조); 기본은 로그인 없음 |
| `ADMIN_PASSWORD` | 아니요 | 로그인 비밀번호(`ENABLE_AUTH="true"`일 때 설정; 누락 시 관리 API는 접근을 일괄 거부하고 경고 — 설정 누락으로 허용되지 않음) |
| `SESSION_SECRET` | 로그인 켤 때 필수 | 로그인 세션 서명 시크릿: 고엔트로피 임의 값(≥32자 임의 문자열, 관리자 비밀번호와 독립), 플랫폼별로 각각 별도 값 구성 필요; 누락 시 로그인과 인증은 fail-closed(로그인 500, 관리 API 401), 비밀번호 파생 폴백 없음; 교체 후 기존 세션은 전부 무효화되어 재로그인 필요 |
| `RETENTION_DAYS` | 아니요 | 데이터 보존 일수, 기본 30 |
| `WAIT_MAX_SECONDS` | 아니요 | 롱 폴링 대기 초(3–25, 기본 25); Netlify는 `8`, Vercel Edge는 `20` |
| 알림 채널 변수 | 아니요 | `FEISHU_WEBHOOK`(Feishu) / `WECOM_WEBHOOK`(WeCom) / `DINGTALK_WEBHOOK`(DingTalk, 선택 `DINGTALK_SECRET` 서명) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`(선택 `BARK_URL`) / `NTFY_URL`(선택 `NTFY_TOKEN`) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`(이메일, 선택 `MAIL_FROM`) / `GENERIC_WEBHOOKS`(범용 웹훅, 선택 `GENERIC_WEBHOOK_TEMPLATE` 본문 / `GENERIC_WEBHOOK_HEADERS` 헤더). 설정한 채널만 전달하며 하나도 설정하지 않으면 전달하지 않음; 알림은 내용에 따라 세 가지 상태로 자동 렌더링(🔐 인증 코드 / 💬 SMS / 🔔 알림) |
| `SITE_NAME` / `SITE_ICON` | 아니요 | 사이트 이름 / 아이콘 URL, 미설정 시 기본값 |
| `NOTIFY_LINK` | 아니요 | 관리 페이지 홈 주소; 설정하면 모든 알림 채널에 "관리 페이지 열기" 항목 추가(버튼/링크/click), 미설정 시 자동 생략 |
| `CRON_SECRET`(Vercel 전용) | 아니요 | `RECEIVE_TOKEN`과 같은 값으로 설정, Vercel Cron이 /api/cron을 호출할 때 사용 |
| `SQLITE_PATH`(node 셀프호스팅 전용) | 아니요 | 로컬 SQLite 모드: 설정하면 외부 데이터베이스 불필요(Node 22.13+ 필요, node/README.md 참조) |

> **보안 강력 권장**
> 1. **관리 페이지 로그인 켜기**(`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): 관리 페이지에는 SMS 인증 코드 등 민감한 내용이 있습니다. 기본으로 로그인 없이 열어 두면 도메인만 아는 사람이 모든 메시지를 보고 데이터를 삭제할 수 있습니다. 로그인 엔드포인트에는 속도 제한이 내장되어 있고(IP당 연속 5회 실패 시 10분 잠금), `/api/receive`와 `/api/push`에는 IP당 분당 120회 쓰기 속도 제한이 있습니다(초과 시 429).
> 2. **푸시 토큰을 URL 쿼리로 전달하는 트레이드오프**: SmsForwarder 등 클라이언트와의 호환성을 위해 `/api/receive`와 `/api/push`는 `?token=` 쿼리 파라미터 인증을 지원합니다 — 토큰이 URL에 노출되어 플랫폼 접근 로그, 브라우저 기록에 남을 수 있습니다. 꺼려진다면 POST + 요청 헤더 `Authorization: Bearer <RECEIVE_TOKEN>` 방식으로 전달하세요(두 방식 모두 지원).

## 디렉터리 구조

```
platforms/
├── cloudflare/ # 主版本：worker.js + schema.sql + wrangler.toml + README.md（自包含）
├── vercel/     # api/[[...route]].js + app.js + db.js + schema.sql + vercel.json + README.md
├── netlify/    # functions/{api,cron}.mjs + app.js + db.js + schema.sql + netlify.toml + README.md
├── deno/       # main.js + app.js + db.js + schema.sql + README.md
├── edgeone/    # functions/{[[default]].js,index.js} + app.js + db.js + schema.sql + README.md
├── node/       # server.mjs + app.js + db.js + schema.sql + Dockerfile + package.json + README.md
├── shared/     # app.js / db.js 唯一源（gen_app.py 由此同步到各平台目录）
└── gen_app.py  # 生成器：从 ../src/worker.js 生成 app.js 并同步全部平台（含 cloudflare 独立副本）
```

각 플랫폼 디렉터리는 배포 루트로 단독 사용할 수 있고(Git 배포 시 플랫폼 Root Directory를 해당 하위 디렉터리로 지정), npm 의존성 0, 빌드 불필요입니다. `src/worker.js`가 갱신되면 `python platforms/gen_app.py`로 모든 플랫폼을 한 번에 동기화합니다(CI가 제로 드리프트를 검증하고, `node tests/run.mjs`가 204개 테스트 단언을 커버합니다).

## Cloudflare Worker에서 다른 플랫폼으로 마이그레이션

1. 위 방법대로 Turso 데이터베이스를 준비하고 테이블 생성
2. (선택) 과거 데이터 마이그레이션: CF Dashboard에서 D1 데이터(SQLite 파일)를 내보내고 → `turso db import`로 가져오기(공식 CLI 문서 참조)
3. 대상 플랫폼 README대로 배포하고, 관리 페이지와 /api/push가 정상인지 확인
4. 휴대폰 측과 각 푸시 스크립트의 웹훅 도메인을 새 플랫폼으로 교체
5. 하루이틀 이상 없이 지나간 뒤 구 Worker를 비활성화

## 공통 사항

- API 경로는 전 플랫폼 동일: `/api/receive`, `/api/push`, `/api/messages`(`device_id`/`source`/`range`/`q`/`limit`/`page`/`starred`/`unread` 지원), `/api/messages/star`, `/api/messages/read`, `/api/messages/remove`, `/api/messages/restore`, `/api/messages/clear`, `/api/export`(CSV/JSON), `/api/sources`, `/api/stats`, `/api/phone`(번호 지역), `/api/devices`, `/api/devices/alias`, `/api/devices/merge`, `/api/wait`, `/api/login`, `/api/logout`, `/api/cron`; 그 외 공개 `/manifest.webmanifest`, `/sw.js`
- `/api/cron`은 외부 스케줄러가 정리를 트리거할 때 사용, 인증: `?token=<RECEIVE_TOKEN>` 또는 `Authorization: Bearer <RECEIVE_TOKEN>`
- `/api/receive`와 `/api/push`는 로그인 토글의 영향을 받지 않음
