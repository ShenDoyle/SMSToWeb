# SMSToWeb 멀티플랫폼 연동 배포 가이드

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

본 시스템은 두 부분으로 구성됩니다: **수신단**(각 플랫폼의 푸시 클라이언트) + **클라우드 게이트웨이**(여섯 플랫폼 중 택1: Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker 셀프호스팅, [platforms/README.md](../../../platforms/README.md) 참조, 연동 방식은 완전히 동일).
SMS는 연동 경로 중 하나일 뿐입니다 — HTTP 요청을 보낼 수 있는 모든 기기/스크립트가 알림을 같은 웹페이지로 푸시해 확인할 수 있습니다.

```
안드로이드(SmsForwarder)──┐  SMS+앱 알림
iOS(단축어)──────────┤
Linux(curl/ntfy)────┼──→ POST /api/receive(SMS) 또는 /api/push(범용 알림)
Windows(PowerShell)─┤         │
macOS(단축어)───────┘         ▼
                        Cloudflare Worker ──→ D1 저장 ──→ 통합 웹페이지(소스 필터)
                              │
                              └──(선택) 멀티채널 알림 → Feishu/WeCom/DingTalk/TG/Bark/이메일…
```

---

## 1. 클라우드 설정(Cloudflare 측)

### 1. 변수와 시크릿

Worker 배포 후 **Workers 및 Pages → sms-gateway → 설정 → 변수 및 시크릿**에서 구성합니다:

| 이름 | 유형 | 필수 | 설명 |
|---|---|---|---|
| `RECEIVE_TOKEN` | 시크릿 | 예 | 푸시 인증 토큰, 임의 문자열을 직접 만드세요(예시 값 사용 금지) |
| `ADMIN_PASSWORD` | 시크릿 | 로그인 켤 때 설정 | 관리 페이지 로그인 비밀번호, 강한 비밀번호 권장; 누락 시 관리 API는 접근을 일괄 거부(설정 누락으로 허용되지 않음)하고 경고를 출력 |
| `ENABLE_AUTH` | 텍스트 | 아니요 | `"true"`이면 로그인 켬(**보안상 강력 권장**: 관리 페이지는 SMS 인증 코드 등 민감한 내용을 담으므로 기본 무로그인은 도메인을 아는 모든 사람에게 개방하는 것과 같음); `"false"` 또는 미설정은 무로그인 |
| `FEISHU_WEBHOOK` | 텍스트 | 아니요 | Feishu 그룹 봇 웹훅, 설정 후 새 메시지가 Feishu 그룹으로 자동 전달(서명 검증은 별도 `FEISHU_SECRET`) |
| `FEISHU_SECRET` | 시크릿 | 아니요 | Feishu 봇 보안 설정에서 "서명 검증"을 선택한 경우에만 설정, 프로그램이 자동으로 서명 계산 |
| `WECOM_WEBHOOK` | 텍스트 | 아니요 | WeCom 그룹 봇 웹훅 |
| `DINGTALK_WEBHOOK` | 텍스트 | 아니요 | DingTalk 그룹 봇 웹훅(서명 보안 설정 시 별도 `DINGTALK_SECRET` 필요) |
| `SERVERCHAN_SENDKEY` | 텍스트 | 아니요 | ServerChan SendKey(WeChat 푸시) |
| `PUSHPLUS_TOKEN` | 텍스트 | 아니요 | PushPlus 토큰(WeChat 푸시) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 텍스트 | 아니요 | Telegram Bot 토큰 + 채팅/그룹 ID |
| `BARK_DEVICE_KEY` | 텍스트 | 아니요 | Bark 기기 Key(자체 서버는 별도 `BARK_URL`, 기본 공식 서버) |
| `NTFY_URL` | 텍스트 | 아니요 | ntfy 전체 토픽 URL, 예: `https://ntfy.sh/my-sms`(보호 토픽은 별도 `NTFY_TOKEN`) |
| `NTFY_TOKEN` | 텍스트 | 아니요 | ntfy 보호 토픽 접근 토큰: Access Token은 그대로 입력(Bearer); 자체 서버는 `user:password` 형식(Basic) |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | 텍스트 | 아니요 | Gotify 서버 주소(`/message` 제외) + 앱 토큰 |
| `RESEND_API_KEY` + `MAIL_TO` | 텍스트 | 아니요 | 이메일(Resend API); 선택 `MAIL_FROM`, 기본 `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | 텍스트 | 아니요 | 범용 웹훅, 여러 URL은 쉼표로 구분; 선택 `GENERIC_WEBHOOK_TEMPLATE` 본문 커스텀, `GENERIC_WEBHOOK_HEADERS` 헤더 커스텀 |
| `GENERIC_WEBHOOK_HEADERS` | 텍스트 | 아니요 | 범용 웹훅 커스텀 요청 헤더, JSON 객체 문자열, 예: `{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | 텍스트 | 아니요 | 관리 페이지 홈 주소; 설정하면 모든 알림 채널에 "관리 페이지 열기" 항목이 붙음(Feishu 버튼, 각 채널 링크 행, Bark url, ntfy click 등), 미설정 시 자동 생략 |
| `SESSION_SECRET` | 시크릿 | 로그인 켤 때 필수 | 로그인 세션 서명 시크릿: **고엔트로피 임의 값(≥32자 임의 문자열 권장), 관리자 비밀번호와 완전히 독립**; CF와 EO(및 각 플랫폼)는 각각 별도 값을 구성, Git 커밋이나 비밀번호 재사용은 엄격 금지. 누락 시 로그인과 인증은 fail-closed(로그인 500, 관리 API 401), 비밀번호 파생으로 폴백하지 않음. 교체 후 모든 기존 세션은 즉시 무효화되어 재로그인 필요; 세션 유효기간 30분, 로그아웃은 브라우저 쿠키만 지우며 복사해 둔 토큰은 TTL 내 유효할 수 있음 |
| `RETENTION_DAYS` | 텍스트 | 아니요 | 데이터 보존 일수, 기본 30, 변경 즉시 적용 |
| `WAIT_MAX_SECONDS` | 텍스트 | 아니요 | 롱 폴링 `/api/wait` 최대 대기 초, 기본 25(3–25). **Netlify Functions 기본 10초 상한 → `8` 권장**; Vercel Edge는 `20` 권장. 프런트엔드는 실패 시 지수 백오프하므로 함수에 요청이 몰리지 않음 |

> **보안 참고 2가지**
> 1. 관리 페이지 로그인(`ENABLE_AUTH="true"`)은 강력히 켤 것을 권장하며 강한 비밀번호 `ADMIN_PASSWORD`를 설정하세요; 로그인 엔드포인트에는 속도 제한이 내장되어 있고(같은 IP 연속 5회 실패 시 10분 잠금), `/api/receive`와 `/api/push`는 분당 120회를 넘는 쓰기에 429를 반환합니다(잠시 후 자동 회복).
> 2. 푸시 토큰은 `?token=` URL 전달을 지원합니다(SmsForwarder 시나리오). 토큰은 URL에 나타나며 플랫폼 접근 로그에 기록될 수 있습니다; 꺼려진다면 POST + `Authorization: Bearer <RECEIVE_TOKEN>` 요청 헤더로 전달하세요. 두 방식 모두 지원됩니다.

### 2. 알림 전달 채널(선택, 설정한 채널만 전달)

배포 플랫폼의 "환경 변수 / Variables" 페이지에서 해당 변수를 추가하면 활성화됩니다. **하나도 설정하지 않으면 전달하지 않으며, 메시지 저장과 웹페이지 확인에는 영향이 없습니다.**
멀티채널 동시 전달이며 한 채널의 실패가 다른 채널에 영향을 주지 않습니다; 중복 메시지(`duplicated:true`)는 중복 전달되지 않습니다.

알림은 내용에 따라 자동으로 **세 가지 상태**로 렌더링됩니다(모든 채널 동일): 인증 코드 감지 → **인증 코드 알림**(인증 코드가 제목/카드 큰 글씨로 진입; Bark 알림은 탭하면 인증 코드 복사, Bark와 ntfy는 우선순위 상향); 인증 코드 없는 SMS → **새 SMS**; 앱/기기 푸시 → **기기 알림**. 선택 변수 `NOTIFY_LINK`를 설정하면 각 채널에 "관리 페이지 열기" 항목이 자동으로 붙고, 미설정 시 자동 생략됩니다.

범용 웹훅의 기본 요청 본문은 JSON이며, 새 필드 `type`(`verify`/`sms`/`notify`)과 `code`(감지된 인증 코드, 미감지 시 빈 문자열)가 추가되었습니다; `GENERIC_WEBHOOK_TEMPLATE` 템플릿 플레이스홀더도 `{{type}}`/`{{code}}`를 지원합니다.

각 채널 신청 절차:

**Feishu 그룹 봇** — `FEISHU_WEBHOOK`(선택 `FEISHU_SECRET`)
1. Feishu 대상 그룹 → 설정 → 그룹 봇 → 봇 추가 → **커스텀 봇**
2. `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx` 형태의 웹훅 주소를 받아 변수에 입력하면 끝
3. 보안 설정 3중 택1: **사용자 지정 키워드**(권장: 키워드에 `SMS` 등만 넣으면 되며 추가 설정 불필요); **서명 검증**(시크릿을 `FEISHU_SECRET`에 넣으면 프로그램이 자동 서명 계산); IP 화이트리스트(Worker 아웃바운드 IP는 고정되지 않으므로 선택 금지)

**WeCom 그룹 봇** — `WECOM_WEBHOOK`
1. WeCom 대상 그룹 → 오른쪽 위 그룹 설정 → 그룹 봇 → 봇 추가 → 새로 만들기
2. `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx` 형태의 웹훅 주소를 복사해 변수에 입력하면 끝

**DingTalk 그룹 봇** — `DINGTALK_WEBHOOK`(선택 `DINGTALK_SECRET`)
1. DingTalk 대상 그룹 → 그룹 설정 → 스마트 그룹 어시스턴트 → 봇 추가 → **커스텀**(웹훅 연동)
2. 보안 설정은 **서명(加签)** 권장: 페이지에 표시되는 시크릿(SEC로 시작)을 `DINGTALK_SECRET`에 입력; 미설정 시 무서명 직접 연결
3. 웹훅 주소(`https://oapi.dingtalk.com/robot/send?access_token=xxxx` 형태)를 복사해 `DINGTALK_WEBHOOK`에 입력

**ServerChan(WeChat 푸시)** — `SERVERCHAN_SENDKEY`
1. [sct.ftqq.com](https://sct.ftqq.com)을 열고 WeChat QR 로그인
2. 홈에서 **SendKey**(`SCTxxxxxxxxxxxx` 형태)를 복사해 변수에 입력; 메시지는 당신의 WeChat "方糖" 서비스 계정으로 푸시됩니다

**PushPlus(WeChat 푸시)** — `PUSHPLUS_TOKEN`
1. [pushplus.plus](https://www.pushplus.plus)를 열고 WeChat QR 로그인
2. 홈에서 **token**을 복사해 변수에 입력; 공식 계정을 팔로우하면 WeChat에서 푸시를 받을 수 있습니다

**Telegram Bot** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`(둘 다 설정해야 유효)
1. TG에서 [@BotFather](https://t.me/BotFather) 찾기 → `/newbot` 후 안내대로 생성 → Bot Token 획득(`123456:ABC-xxx` 형태)
2. `chat_id` 확보: 먼저 당신의 Bot에게 메시지를 하나 보내고, 브라우저로 `https://api.telegram.org/bot<당신의Token>/getUpdates`를 열어 반환 JSON에서 `chat.id` 찾기(그룹 채팅은 Bot을 그룹에 초대해 메시지를 하나 보낸 뒤 같은 방법으로 그룹 ID 확인 가능)
3. 두 값을 각각 `TELEGRAM_BOT_TOKEN`과 `TELEGRAM_CHAT_ID`에 입력

**Bark(iOS 푸시)** — `BARK_DEVICE_KEY`(선택 `BARK_URL`)
1. App Store에서 [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) 설치, 앱을 열어 예시 URL의 Key 부분 복사(`https://api.day.app/<이 부분이 Key>/...`)
2. Key를 `BARK_DEVICE_KEY`에 입력; 자체 서버라면 `BARK_URL`도 설정(기본 공식 `https://api.day.app`)

**ntfy(안드로이드/iOS/웹 구독)** — `NTFY_URL`(선택 `NTFY_TOKEN`)
1. 휴대폰에 ntfy 앱 설치(또는 [ntfy.sh](https://ntfy.sh) 웹 사용), 커스텀 토픽명(topic)을 구독, 예: `my-sms-9f2k`(이름이 무작위일수록 비공개)
2. `NTFY_URL`에 전체 토픽 URL 입력: `https://ntfy.sh/my-sms-9f2k`(자체 서버는 당신의 주소; 역프록시 하위 경로 배포 지원)
3. 토픽에 접근 제어가 켜져 있으면 `NTFY_TOKEN` 설정: Access Token(`tk_`으로 시작)은 그대로 입력; 자체 서버는 `사용자명:비밀번호` 형식으로 입력

**Gotify(자체 푸시 서비스)** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. Gotify를 이미 구축했다면 웹 로그인 → **Apps** → 앱 생성 → **Token** 복사
2. `GOTIFY_URL`에 서버 주소 입력(예: `https://push.example.com`, **`/message`는 붙이지 말 것**), Token은 `GOTIFY_TOKEN`에 입력

**이메일(Resend API)** — `RESEND_API_KEY` + `MAIL_TO`(선택 `MAIL_FROM`)
1. [resend.com](https://resend.com)에서 가입(무료 한도 매일 100통, 매월 3000통)
2. **API Keys** → Create API Key, 복사해 `RESEND_API_KEY`에 입력
3. `MAIL_TO`에 수신 이메일 입력(여러 개는 쉼표 구분); `MAIL_FROM` 미입력 시 기본 `onboarding@resend.dev`(이 기본 발신자는 Resend 가입 이메일로만 발송 가능; 임의 이메일로 보내려면 Resend에서 자신의 도메인을 검증하고 `MAIL_FROM`을 설정해야 함)

**범용 웹훅 / 서드파티 API** — `GENERIC_WEBHOOKS`(선택 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`)
1. `GENERIC_WEBHOOKS`에 URL을 하나 이상 입력(**쉼표 구분**). 기본 POST JSON:

```json
{"title":"【SMS】13800138000 ← 10086","content":"본문…","time":"2026-10-14 12:30:00(베이징 시간)","source":"sms","sender":"1069012345678","device":"내 휴대폰"}
```

2. 상대측이 특정 형식을 요구하면 `GENERIC_WEBHOOK_TEMPLATE`을 설정하고, 플레이스홀더 `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}`로 요청 본문을 커스텀합니다; 템플릿이 JSON으로 파싱되면 JSON으로, 아니면 순수 텍스트로 발송됩니다. 예:

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. 상대측이 인증 요청 헤더를 요구할 때(시크릿을 URL에 넣지 않기) `GENERIC_WEBHOOK_HEADERS`를 설정하고, 값은 JSON 객체 문자열입니다. 예:

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

이 값이 유효한 JSON이 아니면 무시되며 기본 전달에는 영향이 없습니다. SMS 게이트웨이, Home Assistant, n8n, 자체 스크립트 등 어떤 서드파티 API든 이 템플릿으로 연동할 수 있습니다. 각 채널의 변수 이름과 설정 위치는 위의 "변수와 시크릿" 표를 참조; Cloudflare는 Worker의 "변수 및 시크릿" 페이지에서, 그 외 플랫폼은 각 플랫폼 튜토리얼의 환경 변수 위치에서 설정합니다.

### 3. 데이터베이스

D1의 `messages` 테이블에는 `source`(SMS/알림 구분)와 `deleted_at`(소프트 삭제/실행 취소) 컬럼이 필요합니다. 새 배포는 [schema.sql](../../../schema.sql)을 그대로 실행; 기존 DB 업그레이드는 다음을 실행:

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## 2. 푸시 API 규격

두 개의 공개 API가 `RECEIVE_TOKEN` 인증을 공유합니다(토큰은 query 또는 body 어느 쪽이든 가능):

### 1. SMS 수신 `POST /api/receive`(안드로이드 앱 전용)

```
POST https://<여러분의 도메인>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "내 휴대폰",
  "sim": "13800138000",
  "from": "1069012345678",
  "content": "인증 코드는 734752이며, 5분간 유효합니다",
  "time": "2026-10-14 12:29:59"
}
```

### 2. 범용 푸시 `POST /api/push`(각 플랫폼 알림)

```
POST https://<여러분의 도메인>/api/push
Content-Type: application/json

{
  "token": "<RECEIVE_TOKEN>",
  "source": "notify",
  "sender": "백업 스크립트",
  "name": "알림 게이트웨이",
  "content": "데이터베이스 백업 완료, 3분 12초 소요",
  "time": "2026-10-14 03:00:00"
}
```

| 필드 | 필수 | 설명 |
|---|---|---|
| `token` | 예 | 인증 토큰 |
| `content` | 예 | 메시지 본문(`text`/`message`/`msg`도 가능) |
| `source` | 아니요 | 소스 식별자, 기본 `notify`; 웹페이지 "소스 필터"에 사용, 커스텀 가능(예: `cron`, `alert`) |
| `sender` | 아니요 | 소스 제목(호스트명/앱 이름/스크립트 이름) |
| `name` | 아니요 | 기기 라벨 이름(커스텀 명명), 기본 "알림 게이트웨이", SMS 라벨과 나란히 표시 |
| `time` | 아니요 | 이벤트 시각, 기본값은 서버 현재 시각; 타임스탬프 또는 `YYYY-MM-DD HH:MM:SS` 텍스트 지원 |

응답: `{"success":true,"device_id":17,"duplicated":false}` (`duplicated=true`는 중복 메시지가 무시되었음을 의미하며, 알림 채널로 중복 전달되지 않음)

---

## 3. 각 플랫폼 연동 방법

### 안드로이드(SMS + 앱 알림) — SmsForwarder

1. 오픈소스 앱 "SmsForwarder" 설치 ([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder))
2. 일반 설정에서 **"SMS 브로드캐스트 전달" 마스터 스위치 켜기**
3. "웹훅 채널" 새로 만들기: URL에 `/api/receive?token=<RECEIVE_TOKEN>` 입력, 메시지 템플릿:

```json
{"name":"내 휴대폰","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> 핵심: `name`에는 커스텀 기기 이름을 넣습니다(웹페이지 라벨에 표시되며, 이름을 바꾸면 새 라벨이 생성됨); `sim`에는 전화번호를 그대로 입력(카드 오른쪽 아래에 표시, 더블탭으로 복사); `content`에는 반드시 `{{SMS}}` 변수를 사용.
> 앱 알림 전달: "앱 알림" 전달 규칙을 하나 더 추가하고, 템플릿에서 `sender`는 `{{APP_NAME}}`, `content`는 `{{MSG}}`를 사용하며, 전송 대상을 `/api/push`로 변경.

### iOS — 단축어(Shortcuts)

1. 단축어 → 자동화 → 새 "개인 자동화" → "메시지 수신 시" 선택
2. 액션 추가 → "URL 콘텐츠 가져오기":
   - URL: `https://<여러분의 도메인>/api/push`
   - 방법: POST, 요청 본문 JSON:

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"알림 게이트웨이","content":"[메시지 본문 변수]"}
```

3. "실행 전 묻기"를 끄면 완전 자동입니다. 배터리·집중 모드 등 예약형 알림도 같은 방법으로 해당 트리거를 선택하세요.

### Linux — curl / 스크립트 / systemd

가장 간단한 한 줄:

```bash
curl -s -X POST https://<여러분의 도메인>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx 재시작됨"}'
```

예약/이벤트 알림 예시(`/usr/local/bin/notify.sh`):

```bash
#!/bin/bash
curl -s -X POST https://<여러분의 도메인>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$(hostname)\",\"source\":\"cron\",\"content\":\"$1\"}"
```

systemd timer 또는 cron과 함께 사용: `notify.sh "매일 백업 완료"`.

심화 선택: [ntfy](https://ntfy.sh)를 자체 호스팅(단일 바이너리/Docker)하여 여러 대의 기기가 같은 이벤트 스트림을 구독하게 하고, 작은 브리지 스크립트가 ntfy 메시지를 이 게이트웨이로 전달하도록 할 수 있습니다.

### Windows — PowerShell / 작업 스케줄러

`C:\Tools\notify.ps1`:

```powershell
param([string]$Message = "알림")
$body = @{
  token  = "<RECEIVE_TOKEN>"
  sender = $env:COMPUTERNAME
  source = "notify"
  content = $Message
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://<여러분의 도메인>/api/push" -Method Post -ContentType "application/json" -Body $body
```

호출: `powershell -File C:\Tools\notify.ps1 -Message "디스크 정리 완료"`; 작업 스케줄러에서 종료 전, 백업 후 등의 이벤트에 걸 수 있습니다.

### macOS — 단축어 / launchd

- 단축어: iOS와 동일(자동화 트리거를 "특정 시간", "파일 변경" 등으로 교체)
- 예약 스크립트 + launchd(`~/Library/LaunchAgents/local.notify.plist`):

```bash
curl -s -X POST https://<여러분의 도메인>/api/push -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"MacBook","content":"Time Machine 백업 완료"}'
```

- iPhone SMS를 Mac으로 받는 사용자: AppleScript로 Messages.app SQLite DB의 증분을 폴링하여 푸시(심화 활용)

### 서버/컨테이너 공통 — Apprise(선택적 통합 계층)

[Apprise](https://github.com/caronc/apprise)는 100+ 알림 대상을 지원하며, 이 게이트웨이를 그중 하나의 커스텀 웹훅으로 사용해 다중 대상 푸시를 통합 관리할 수 있습니다.

---

## 4. 검증 체크리스트

| 검증 항목 | 방법 |
|---|---|
| API 인증 | 토큰 없는 요청은 403 unauthorized를 반환해야 함 |
| 범용 푸시 | 위 예시 중 하나로 발송, 웹페이지 "알림" 소스에서 보이고, 설정된 알림 채널도 동시 수신 |
| SMS 경로 | 휴대폰으로 실제 SMS 발송 → 웹페이지 "SMS" 소스에서 보임 + 인증 코드 인식 + 알림 채널 전달 |
| 소스 필터 | 관리 페이지 툴바 "소스 필터" 드롭다운 전환: 전체 / SMS / 알림 및 커스텀 소스 |
| 9개 언어 전환 | 관리 페이지와 로그인 페이지에 9개 언어 내장(简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)). 오른쪽 위 "🌐" 메뉴에서 선택하면 페이지 전체가 전환되고 선택은 브라우저 로컬에 기록됨; `https://여러분의 도메인/?lang=ja` 등으로 직접 접근도 가능. 기존 링크 `?lang=zh` / `?lang=en`도 계속 호환(자동으로 zh-CN / en으로 정규화) |
| 내보내기와 필터 | "CSV / JSON 내보내기" 클릭으로 현재 필터 결과 다운로드; "최근 7일", "페이지당 50개" 전환 시 목록과 내보내기도 함께 변경 |
| 중복 차단 | 같은 내용을 초 단위로 재발송하면 응답 `duplicated:true`, 알림 채널로 중복 푸시되지 않음 |

## 5. 자주 묻는 질문

- **푸시했는데 웹페이지가 갱신되지 않나요?** 관리 페이지는 롱 폴링으로 자동 갱신됩니다(기본 최대 25초 대기, `WAIT_MAX_SECONDS`로 조정 가능); 페이지로 돌아오면 즉시 한 번 더 가져옵니다; 소스 필터를 한 번 바꿔 로딩을 트리거할 수도 있습니다.
- **모바일 브라우저에서 화면이 좁거나 로그인 창이 확대되나요?** 모바일에 맞춰 조정되어 있습니다(세이프 에어리어, iOS 자동 확대 방지 16px 입력창, 확대된 터치 타깃); 여전히 이상하면 해당 사이트 캐시를 지우고 재시도하세요.
- **Netlify에서 롱 폴링이 자꾸 실패하나요?** `WAIT_MAX_SECONDS`를 `8`로 설정하세요(Functions의 10초 상한보다 낮게).
- **알림 채널에 안 오나요?** 해당 채널 변수가 설정되어 있고 값이 올바른지 확인하세요(Telegram/Gotify처럼 두 변수가 한 쌍인 것은 전부 설정 필요); 배포 플랫폼 로그에 `notify forward failed:`가 있는지 확인; `duplicated:true` 메시지는 전달되지 않습니다.
- **라벨 이름을 바꾸고 싶나요?** 기기 라벨 뒤의 "✎"을 눌러 이름을 바꾸고(별칭 설정), "⇄"로 해당 라벨의 메시지를 다른 기기로 병합; 메시지가 없는 라벨은 "×"로 바로 삭제할 수 있습니다.
- **메시지는 얼마나 보관되나요?** `RETENTION_DAYS`가 제어하며 기본 30일, 매일 UTC 17:00(베이징 시간 새벽 1시)에 자동 정리됩니다.
