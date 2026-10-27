# Cloudflare 배포 튜토리얼(메인 버전, 전 과정 웹 조작)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

이 프로젝트의 메인 버전입니다: 휴대폰 SMS/알림 → Cloudflare Worker → D1 데이터베이스 → 웹 관리 페이지.
서버 불필요, 무료 할당량 충분, 전 과정이 웹 클릭만으로 완료되며 어떤 도구도 설치할 필요가 없습니다.

이 디렉터리는 **완전히 자기완결적**입니다: [`worker.js`](../../../platforms/cloudflare/worker.js)(배포 소스) + [`schema.sql`](../../../platforms/cloudflare/schema.sql)(테이블 생성 스크립트) + [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml)(CLI 배포용 선택 설정), 저장소의 다른 파일에 의존하지 않습니다. 그 외 플랫폼은 [플랫폼 개요](./PLATFORMS.md)를 참조하세요.

---

## 원클릭 배포(초보자 권장)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

위 버튼을 누르면 Cloudflare가 자동으로 처리합니다: 코드를 당신의 GitHub으로 클론 → **D1 데이터베이스 자동 생성 및 테이블 생성 실행** → 리소스 바인딩 → CI 구성(이후 당신의 저장소에 push할 때마다 자동 재배포) → 라이브. 진행 중 안내에 따라 두 시크릿을 입력합니다:

- `RECEIVE_TOKEN`: 푸시 인증 시크릿, 충분히 긴 임의 문자열을 직접 만드세요(모바일 연동 URL의 `token=`과 일치시킴)
- `ADMIN_PASSWORD`: 관리 페이지 로그인 비밀번호(**설정 강력 권장** — 관리 페이지는 SMS 인증 코드 등 민감한 내용을 담음; `ENABLE_AUTH="true"`인데 누락되면 관리 API는 접근을 일괄 거부하며 무로그인으로 통과되지 않음)
- `SESSION_SECRET`: 로그인 세션 서명 시크릿, **로그인을 켤 때 반드시 설정** — 고엔트로피 임의 값(≥32자 임의 문자열, 예: `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`로 생성), 비밀번호와 완전히 독립; 누락 시 로그인과 인증은 fail-closed(로그인 500, 관리 API 401), 비밀번호 파생으로 폴백하지 않음; 교체 후 모든 기존 세션은 즉시 무효화

> 커스텀 도메인 바인딩(예: `sms.example.com`): 배포 완료 후 Worker → 설정 → 도메인 및 라우트 → 커스텀 도메인 추가.
> 아래의 수동 튜토리얼은 원클릭 흐름을 원하지 않거나 각 단계를 하나씩 이해하며 진행하고 싶은 사용자를 위해 남겨 두었습니다.

## 준비물

1. Cloudflare 계정 하나([가입入口](https://dash.cloudflare.com/sign-up), 무료, 이메일이면 충분)
2. 이 프로젝트의 코드(이 디렉터리의 [`worker.js`](../../../platforms/cloudflare/worker.js)가 붙여넣을 코드 전부)

## 1단계: D1 데이터베이스 생성

1. [dash.cloudflare.com](https://dash.cloudflare.com) 로그인
2. 왼쪽 메뉴 **스토리지 및 데이터베이스 → D1 SQL 데이터베이스**
3. **데이터베이스 생성** 클릭, 이름에 `sms-gateway-db` 입력(나머지 기본값), 생성 클릭
4. 방금 만든 데이터베이스 진입 → **콘솔** 탭
5. 이 디렉터리의 [`schema.sql`](../../../platforms/cloudflare/schema.sql) 전체를 복사해 입력창에 붙여넣고 **실행** 클릭
6. 실행 성공 메시지 확인(`messages`와 `devices` 두 테이블이 생성됨)

## 2단계: Worker 생성 후 코드 붙여넣기

1. 왼쪽 메뉴 **컴퓨팅(Workers) → Workers 및 Pages**
2. **애플리케이션 만들기** 클릭, **Start with Hello World!**(Hello World 템플릿으로 시작) 선택, 이름에 `sms-gateway` 입력, **배포** 클릭(먼저 기본 코드로 배포 성공만 하면 됨)
3. **코드 편집** 클릭, 편집기의 기본 코드를 전부 삭제
4. 이 디렉터리의 [`worker.js`](../../../platforms/cloudflare/worker.js)를 열어 전체 선택·복사 후 편집기에 붙여넣기
5. 오른쪽 위 **배포** 클릭, 배포 성공 메시지 확인

## 3단계: D1 데이터베이스 바인딩

1. Worker 개요 페이지로 돌아가기 → **Bindings(바인딩)** 탭
2. **추가 → D1 데이터베이스** 클릭
3. 변수 이름에 `DB` 입력(반드시 동일해야 함, 대문자), 방금 만든 `sms-gateway-db` 선택
4. **배포/저장** 클릭

## 4단계: 변수와 시크릿 설정

같은 위치의 **설정 → 변수 및 시크릿(Variables and Secrets)**에서 하나씩 추가:

1. **변수 추가**(유형 "텍스트" 선택):
   - 이름 `RETENTION_DAYS`, 값 `30`(90일 보관을 원하면 `90`)
   - 이름 `ENABLE_AUTH`, 값 `false`(**보안상 `true`로 로그인 켜기를 강력 권장**: 관리 페이지는 SMS 인증 코드 등 민감한 내용을 담으므로 무로그인은 도메인을 아는 모든 사람에게 개방하는 것과 같음. Workers Builds로 저장소에 연결해 자동 배포한다면 이 값은 저장소 내 `wrangler.toml`이 우선 — 현재 기본 `true`)
   - 이름 `SITE_NAME`(선택), 값은 커스텀 사이트 이름, 예: `我的短信站`
   - 이름 `SITE_ICON`(선택), 값은 아이콘 URL(`http(s)://`로 시작); 미입력 또는 URL 무효 시 내장 아이콘 자동 사용
   - 이름 `NOTIFY_LINK`(선택), 값은 관리 페이지 홈 주소(`http(s)://`로 시작); 설정하면 모든 알림 채널에 "관리 페이지 열기" 항목 추가
2. **시크릿 추가**(유형 "시크릿/Secret" 선택):
   - 이름 `RECEIVE_TOKEN`, 값은 충분히 긴 임의 문자열을 직접 만든 것(튜토리얼 예시 값은 절대 사용 금지, 길수록 좋음)
   - 이름 `ADMIN_PASSWORD`, 값은 관리 페이지 로그인 비밀번호를 직접 만든 것(`ENABLE_AUTH="true"`일 때만 필요)
   - 이름 `SESSION_SECRET`, 값은 고엔트로피 임의 문자열(≥32자 임의 값, 비밀번호와 독립; `ENABLE_AUTH="true"`일 때만 필요)
3. 추가할 때마다 **배포/저장** 클릭

> 이 값들은 언제 바꿔도 즉시 적용되며 코드를 다시 붙여넣을 필요가 없습니다. `RECEIVE_TOKEN` 변경 후에는 모바일 URL의 `token=`도 함께 갱신하세요.

## 5단계(선택): 알림 전달 채널 구성

새 메시지가 저장된 후 외부 채널로 자동 전달할 수 있습니다. **설정한 채널의 변수만 전달되며, 하나도 설정하지 않으면 전달하지 않습니다.**
같은 "변수 및 시크릿" 페이지에서 해당 변수를 추가하면 됩니다:

| 채널 | 변수 | 설명 |
|---|---|---|
| Feishu 그룹 봇 | `FEISHU_WEBHOOK`(선택 `FEISHU_SECRET`) | 그룹 봇 웹훅 주소; 보안 설정에서 "서명 검증" 선택 시 `FEISHU_SECRET` 추가 설정 |
| WeCom 그룹 봇 | `WECOM_WEBHOOK` | 그룹 봇 웹훅 주소 |
| DingTalk 그룹 봇 | `DINGTALK_WEBHOOK`(선택 `DINGTALK_SECRET`) | 서명 보안 설정 시 `DINGTALK_SECRET` 필요 |
| ServerChan | `SERVERCHAN_SENDKEY` | SendKey(WeChat 푸시) |
| PushPlus | `PUSHPLUS_TOKEN` | 토큰(WeChat 푸시) |
| Telegram Bot | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot 토큰 + 채팅/그룹 ID |
| Bark | `BARK_DEVICE_KEY`(선택 `BARK_URL`) | 자체 서버일 때 `BARK_URL` 설정, 기본 공식 |
| ntfy | `NTFY_URL`(선택 `NTFY_TOKEN`) | 전체 토픽 URL, 예: `https://ntfy.sh/my-sms`; 보호 토픽은 별도 `NTFY_TOKEN`(Token 또는 user:password) |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | 서버 주소(`/message` 제외) + 앱 토큰 |
| 이메일(Resend) | `RESEND_API_KEY` + `MAIL_TO`(선택 `MAIL_FROM`) | `MAIL_FROM` 기본 `onboarding@resend.dev` |
| 범용 웹훅 | `GENERIC_WEBHOOKS`(선택 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`) | 여러 URL은 쉼표 구분; 템플릿으로 본문 커스텀, 헤더는 JSON, 서드파티 API(SMS 게이트웨이 등)가 이렇게 연동 |

각 채널의 신청·획득 절차와 요청 본문 형식은 [멀티플랫폼 연동 배포 가이드 · 알림 전달 채널](./DEPLOYMENT.md)을 참조하세요.
멀티채널 동시 전달이며 한 채널의 실패가 다른 채널과 메시지 저장에 영향을 주지 않습니다; 중복 메시지(`duplicated`)는 중복 전달되지 않습니다.
알림은 내용에 따라 세 가지 상태로 자동 렌더링됩니다(🔐 인증 코드 알림 / 💬 새 SMS / 🔔 기기 알림): 인증 코드는 자동으로 제목에 들어가고 각 플랫폼의 강화 기능을 트리거합니다(Bark 알림 탭 즉시 복사, Bark/ntfy 우선순위 상향, Feishu violet 카드 헤더 등).

## 6단계: 예약 정리 작업 설정

1. Worker → **설정 → 트리거(Triggers) → Cron 트리거**
2. **Cron 트리거 추가** 클릭, `0 17 * * *` 입력, 저장
3. 의미: 매일 UTC 17:00(베이징 시간 새벽 1시)에 보존 일수를 초과한 데이터를 자동 삭제

## 7단계: 도메인 바인딩(선택, 권장)

1. Worker → **설정 → 도메인 및 라우트**
2. **추가 → 커스텀 도메인** 클릭, 서브도메인 하나 입력(예: `sms.你的域名.com`)
3. Cloudflare가 DNS 레코드 생성과 HTTPS 인증서 발급을 자동 처리, 몇 분 내 적용
4. 이후 브라우저에서 `https://sms.你的域名.com`에 바로 접속하면 관리 페이지입니다

> 도메인이 없어도 기본 `https://sms-gateway.<당신의서브도메인>.workers.dev` 주소를 사용할 수 있습니다.

## 8단계: 배포 검증

브라우저로 관리 페이지를 열면 당신의 사이트 이름 페이지가 보여야 합니다(기본 "短信网关", `SITE_NAME`으로 변경 가능; 로그인을 켰다면 먼저 로그인 페이지가 보임). 이어서 수신 API 검증(`<도메인>`과 `<시크릿>`을 당신 것으로 교체):

```
curl "https://<域名>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

`{"success":true,...}`가 반환되면 연결 성공입니다. 이 테스트 SMS는 웹페이지에서 삭제할 수 있습니다.

## 휴대폰 및 각 기기 연동

[멀티플랫폼 연동 배포 가이드](./DEPLOYMENT.md)대로 안드로이드 SmsForwarder와 각 기기 알림 푸시를 설정하고, API 도메인을 당신의 Worker 주소로 바꾸면 됩니다.

## CLI 배포(대안, wrangler 설치를 아는 사람용)

이 디렉터리에서(`wrangler.toml` 포함, `main`이 이미 이 디렉터리의 `worker.js`를 가리킴) 실행:

```bash
npm install wrangler        # 官方推荐项目内安装；全局 npm install -g wrangler 亦可
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # 仅开登录时需要
npx wrangler secret put SESSION_SECRET   # 仅开登录时需要（高熵随机值，与密码独立）
npx wrangler deploy
```

## 주의 사항 및 자주 묻는 질문

- **전달 SMS가 수신되지 않을 때**: 순서대로 점검 ① SmsForwarder 일반 설정의 "转发短信广播" 총 스위치(가장 놓치기 쉬움, 꺼져 있으면 조용히 버려지고 채널 테스트는 모두 초록) → ② 전달 규칙의 token/URL이 Worker 시크릿과 일치하는지 → ③ Worker 실시간 로그에서 요청 도달 여부
- **알림 채널에 안 올 때**: 해당 채널 변수가 설정되어 있고 값이 올바른지 확인; Worker 실시간 로그에 `notify forward failed:`가 있는지 확인; `duplicated:true` 메시지는 전달되지 않음
- **Worker 무료 할당량**: 하루 10만 요청, 개인 사용에 충분; D1 무료 할당량은 하루 500만 행 읽기
- **롱 폴링**: 관리 페이지 `/api/wait`는 최대 25초 대기하며, Workers는 요청 시간 제한 문제가 없어 실시간성이 가장 좋음
- **데이터 마이그레이션**: 다른 플랫폼에서 CF로 되돌아올 때는 Turso 데이터를 내보낸 뒤 D1으로 가져오면 됩니다(테이블 구조 완전 동일)
