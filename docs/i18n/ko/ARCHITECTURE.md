# 아키텍처 문서(ARCHITECTURE)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

SMSToWeb은 "단일 코어 + 멀티플랫폼 엔트리" 구조의 SMS/알림 통합 시스템입니다: npm 의존성 0의 비즈니스 코어(`src/worker.js`) 하나를 생성 스크립트로 여섯 배포 플랫폼에 동기화하고, 각 플랫폼은 자체 런타임과 데이터베이스에 연결하는 얇은 어댑터 계층만 유지합니다.

## 1. 전체 토폴로지

```
휴대폰(SmsForwarder / 임의 스크립트)
   │  POST /api/receive(SMS) 또는 /api/push(범용 푸시) + token
   ▼
┌─────────────────────────── 임의의 플랫폼 하나에 배포 ────────────────────────────┐
│  Cloudflare Workers (D1)   Vercel Edge   Deno Deploy                     │
│  Netlify Functions         EdgeOne (Turso)   Node 셀프호스팅 (Docker)         │
│                                                                           │
│  엔트리 계층(얇은 어댑터): 요청 수신 → buildEnv로 환경 변수 통과 → fetchApp()          │
│  비즈니스 코어(단일 파일 app.js): 인증 → 저장 → 조회 → 롱 폴링 → 알림 전달        │
└──────────────────────────────────────────────────────────────────────────┘
   │                                  │
   ▼                                  ▼
관리 페이지(내장 HTML, 로그인 인증)      11개 채널 알림 전달(Feishu/WeCom/DingTalk/…)
```

핵심 설계 원칙: **비즈니스 코드와 플랫폼 엔트리의 분리**. 코어 로직은 배포 플랫폼에 따라 수정되지 않으며, 얇은 어댑터 계층으로만 각 플랫폼의 런타임과 데이터베이스 인터페이스에 연결됩니다; 6개 플랫폼의 기능은 엄격히 동일합니다.

## 2. 디렉터리 구조

```
src/worker.js                 # 유일한 비즈니스 소스 파일(Cloudflare Worker 형태: export default { fetch, scheduled })
platforms/
  gen_app.py                 # 동기화 생성 스크립트(§3 참조)
  shared/app.js               # 생성물: src/worker.js의 비즈니스 부분과 바이트 단위로 일치, export 형태만 교체
  cloudflare/                 # CF 메인 버전 사본 + wrangler.toml(정적 유지보수)
  vercel/  netlify/  deno/    # 각 플랫폼 자기완결 디렉터리: 엔트리 + app.js + db.js + schema.sql + README
  edgeone/ node/              # EdgeOne은 Turso 사용; node/db.js는 Turso + 로컬 SQLite 듀얼 어댑터(별도 유지)
tests/run.mjs                 # 종속성 제로 테스트 스위트(node:sqlite, 204개 항목)
docs/                         # 문서(이 디렉터리)
schema.sql                    # 데이터베이스 테이블 생성 스크립트(단일 소스)
```

각 플랫폼 디렉터리는 **완전히 자기완결적**입니다: 엔트리는 해당 디렉터리 내의 `app.js` / `db.js`만 참조하므로 독립 배포 가능하고 서로 의존하지 않습니다.

## 3. 동기화 메커니즘(platforms/gen_app.py)

`python platforms/gen_app.py`는 한 번에 완료합니다(멱등, 재실행 시 드리프트 없음):

1. `src/worker.js`를 유일한 소스로 삼아 `export default {` 이전의 전체 비즈니스 코드를 잘라내고, 공통 export 꼬리(`fetchApp` / `runCron` / `handleCronRequest`)를 붙여 생성한 뒤 `platforms/shared/app.js`에 기록;
2. shared 사본을 `shared/db.js`와 루트 `schema.sql`과 함께 각 플랫폼 디렉터리로 복사(`node/db.js`는 예외, 별도 유지);
3. 스크립트 내 **ENV_KEYS 화이트리스트**(단일 목록, 31개 환경 변수)로 각 엔트리 파일의 `/* ==== ENV_KEYS BEGIN ==== */ … /* ==== ENV_KEYS END ==== */` 마커 블록 사이 내용을 교체하여, 6개 플랫폼이 통과시키는 환경 변수 집합을 동일하게 유지하고 드리프트를 방지합니다.

철칙: **모든 비즈니스 변경은 `src/worker.js`(및 gen_app.py의 ENV_KEYS)만 수정하고, 수정 후 반드시 gen_app.py를 재실행**; platforms/ 아래의 생성물은 직접 손으로 수정 금지(node/db.js와 wrangler.toml 제외).

## 4. 요청 생명주기

`POST /api/receive`를 예로:

1. **엔트리 계층**: 플랫폼 엔트리(예: `platforms/edgeone/functions/index.js`)가 요청을 받고 `env = buildEnv(vars)`를 구성(화이트리스트 변수 통과 + 데이터베이스 자격 증명 분기)한 뒤 `fetchApp(request, env[, ctx])` 호출;
2. **인증**: `/api/receive`, `/api/push`, `/api/login`, `/api/logout`, `/api/cron`, 정적 리소스는 공개 경로; 그 외 관리·페이지 API는 로그인 토글(`ENABLE_AUTH`)의 제어를 받음 — 로그인 후 **무상태 서명 세션**(`nonce.exp.HMAC-SHA256` 3세그먼트 형식, Cookie `sms_auth`, TTL 30분)을 발급하며, `SESSION_SECRET` 누락 시 안전하게 실패(로그인 500, 관리 API는 일괄 401, 비밀번호 파생으로 폴백하지 않음), 설정 누락 시 일체 허용하지 않음;
3. **저장**: token 검증(`safeEqual`로 타이밍 공격 방지) → device+sim으로 기기 조회/생성 → messages에 기록(데이터베이스 고유 인덱스가 중복 방지를 담보, 중복 푸시는 `duplicated:true` 반환 후 전달하지 않음);
4. **알림 전달**: 중복이 아닌 메시지는 `bgRun(ctx, dispatchNotify(env, msg))`로 백그라운드 진입 — Cloudflare는 실제 `ctx.waitUntil`을 전달해 응답 후에도 계속 발송을 보장; 다른 플랫폼은 ctx가 기본 제공되지 않아 인라인 `await`로 저하되어 엣지 함수가 백그라운드 작업을 일찍 잘라내지 않도록 함;
5. **응답**: 즉시 JSON 반환(`success/device_id/duplicated`), 전달 완료를 기다리지 않음(CF 플랫폼).

## 5. 알림 전달 서브시스템

`dispatchNotify(env, msg)`는 전 채널의 유일한 조립 계층입니다:

- `extractCodeLite(content)`: 서버 경량 인증 코드 감지(캐스케이드 순서는 프런트엔드 `extractCode`와 일치, 코드가 앞서면 키워드보다 우선; 감지 전에 전화번호/날짜/시각/금액/주문번호 제거);
- `buildNotifyInfo(env, msg)`: 인증 코드 감지 + `NOTIFY_LINK`를 전 채널에서 한 번만 읽어 `verify/sms/notify` 3상태와 통일된 제목을 산출;
- 각 채널 renderer가 `info`를 소비해 자체 형식으로 렌더링(Feishu Interactive 카드 / WeCom·DingTalk markdown / Telegram HTML / Bark / ntfy / Gotify / Resend 이메일 / 범용 웹훅 템플릿 등), 길이 상한·서명·이스케이프는 모두 renderer 내에서 처리;
- `Promise.allSettled` 동시 스케줄링, 단일 채널 실패는 로그만 남기고 다른 채널과 메인 흐름에 영향을 주지 않음.

## 6. 프런트엔드(내장 관리 페이지)

관리 페이지 HTML은 `String.raw` 템플릿 리터럴로 `src/worker.js`에 내장되어 있습니다(서버 렌더링, 별도 프런트엔드 프로젝트 없음): 로그인 페이지와 관리 페이지가 라우트 `/`를 공유하며 로그인 토글이 렌더링 형태를 결정; 9개 언어 지원(zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR, `data-i18n` 내장 사전 + `?lang=` 직접 접속, 누락된 키는 en으로 폴백), 다크 모드, 인증 코드 자동 복사, 롱 폴링 자동 갱신(`/api/wait`), 소스 필터, 기기 관리를 지원합니다.

## 7. 멀티플랫폼 차이 요약

| 플랫폼 | 엔트리 파일 | 데이터베이스 | cron |
|---|---|---|---|
| Cloudflare | `export default`(worker.js 본체) | D1(`env.DB`) | 네이티브 `scheduled` + `/api/cron` HTTP |
| Vercel | `api/[[...route]].js` | Turso | Vercel Cron(Bearer `CRON_SECRET`) |
| Netlify | `functions/api.mjs` + `functions/cron.mjs` | Turso | Scheduled Functions |
| Deno | `main.js`(`Deno.serve`) | Turso | 외부 스케줄러 |
| EdgeOne | `functions/index.js`(루트 경로는 반드시 index.js) | Turso(클라이언트는 자격 증명 지문으로 키잉한 캐시) | 외부 스케줄러 |
| Node | `server.mjs`(node:http) | Turso / 로컬 SQLite(듀얼 어댑터) | 외부 스케줄러 / Docker |

모든 플랫폼의 `/api/cron` HTTP 트리거 의미론은 동일합니다: `?token=<RECEIVE_TOKEN>` 또는 `Authorization: Bearer <RECEIVE_TOKEN>`.
