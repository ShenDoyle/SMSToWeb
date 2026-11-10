# SMSToWeb — SMS/알림 클라우드 게이트웨이

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

여러 경로(SMS 전달, 앱 알림, 스크립트, 웹훅, 사용자 지정 연동)의 메시지를 공통 HTTP API와 데이터 형식으로 한곳에 모아, 단일 웹 페이지에서 조회·검색·전달할 수 있습니다.

- **멀티플랫폼 지원**: Cloudflare Workers / Vercel / Deno Deploy / Netlify / Tencent EdgeOne Makers / Docker 셀프호스팅 — 환경에 맞는 플랫폼을 골라 배포하세요.
- **실시간 수신**: 웹훅 푸시가 몇 초 만에 데이터베이스에 기록; 웹페이지가 스스로 갱신, 수동 작업 불필요
- **범용 푸시**: HTTP 요청을 보낼 수 있는 모든 기기(Linux / Windows / macOS / iOS / NAS / 스크립트)가 같은 페이지로 알림을 푸시할 수 있음
- **소스 & 필터**: 소스별 동적 필터(SMS / 알림 및 사용자 지정 소스 자동 집계), 키워드 검색과 오늘 / 최근 7일 / 최근 30일 범위를 겹쳐 사용; 페이지 크기 조절 가능
- **멀티채널 전달**: 새 메시지를 Feishu / WeCom / DingTalk / Telegram / ServerChan / PushPlus / Bark / ntfy / Gotify / 이메일 / 범용 웹훅으로 자동 전달 — 사용하는 것만 설정(선택 사항)
- **선택적 보안**: 관리자 로그인 토글, 다양한 형식의 OTP 코드 추출(코드 우선 / 키워드 우선 / 분리형 / 혼합형, 오탐 방지)과 원탭 복사, 다크 모드
- **데이터 & 알림**: 현재 필터 기준 CSV / JSON 내보내기; 페이지가 보이는 동안 새 메시지에 토스트 / 선택적 사운드 / 플로팅 필, 백그라운드에서는 브라우저 알림 + 읽지 않음 타이틀; 초장문 자동 접기
- **번호 인식**: 주요 기관 번호 디렉터리(통신사 / 은행 / 택배 / 정부) 내장, 자동 라벨링; 모르는 모바일 번호는 선택적으로 통신사 지역 조회(기본 켜짐, 끌 수 있음)
- **9개 언어**: 관리 페이지와 로그인 페이지에 zh-CN / zh-TW / en / ja / ko / es / fr / de / pt-BR 내장; 헤더 🌐 메뉴에서 전환(`?lang=` 딥링크 지원, 선택은 로컬에 기억); 날짜·상대 시간·디렉터리 라벨도 함께 전환
- **모바일 친화적**: 노치와 제스처 바를 위한 `viewport-fit` 세이프 에어리어, iOS 자동 확대 방지 16px 입력창, 더 큰 터치 타깃, 바텀시트 다이얼로그, PWA 홈 화면 추가
- **일괄 & 실행 취소**: 다중 선택 삭제, 현재 필터 한 번에 비우기; 삭제 후 5초 내 실행 취소(소프트 삭제); 다크 모드는 자동 / 라이트 / 다크
- **즐겨찾기 / 읽지 않음 / 통계**: 별표 고정, 즐겨찾기만 / 읽지 않음만 보기, 통계 패널(소스 분포 + 최근 7일); 사용자 지정 번호 라벨; 검색 하이라이트와 기록; 설정에서 방해 금지와 사운드; PWA

```
[SMS] Android(SmsForwarder) ──POST /api/receive──┐
                                                 ├─→ cloud gateway (any platform) ─→ database
[notify] scripts / shortcuts ──POST /api/push────┘        │
                                                browser ◀── web admin (embedded in gateway)
```

**Cloudflare 원클릭 배포**:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

버튼을 클릭하면 데이터베이스·테이블 생성, 리소스 바인딩, CI 설정이 자동으로 완료됩니다. 안내에 따라 `RECEIVE_TOKEN`(푸시 인증 시크릿)만 채우면 바로 사용할 수 있습니다. Vercel / Netlify 원클릭 버튼은 각 플랫폼 가이드에 있습니다.

| 플랫폼 | 배포 방식 | 예약 정리 | 가이드 |
|---|---|---|---|
| **Cloudflare**(추천) | Worker + D1 | 플랫폼 cron | [platforms/cloudflare/README.md](../../../platforms/cloudflare/README.md) |
| Vercel | Edge Function + Turso | 플랫폼 cron | [platforms/vercel/README.md](../../../platforms/vercel/README.md) |
| Deno Deploy | Deno 네이티브 + Turso | Deno.cron | [platforms/deno/README.md](../../../platforms/deno/README.md) |
| Netlify | Functions v2 + Turso | Scheduled Function | [platforms/netlify/README.md](../../../platforms/netlify/README.md) |
| Tencent EdgeOne Makers | Functions + Turso | 외부 cron | [platforms/edgeone/README.md](../../../platforms/edgeone/README.md) |
| Fly.io / Railway / VPS | Docker(Node 22) + Turso / 로컬 SQLite | 프로세스 내장 | [platforms/node/README.md](../../../platforms/node/README.md) |

> 모든 플랫폼 디렉터리는 **완전히 자기완결형**입니다(코드 + 스키마 + 독립 문서, npm 의존성 0, 빌드 불필요). 위 표의 가이드를 열어 단계대로 진행하세요. 기능과 데이터 스키마는 전 플랫폼에서 동일하며 언제든 서로 마이그레이션할 수 있습니다.
> 플랫폼 비교와 공통 준비(Turso 데이터베이스)는 [platforms/README.md](../../../platforms/README.md)를 참조하세요.

---

## 휴대폰 설정 & 멀티디바이스 연동

모든 플랫폼은 메시지를 같은 웹페이지로 보냅니다: 휴대폰 SMS는 `/api/receive`(안드로이드 SmsForwarder), 그 외 모든 알림은 범용 `/api/push`를 사용합니다.

단계별 설정(플랫폼별 복사 가능한 명령/스크립트 포함): **[배포 & 연동 가이드](./DEPLOYMENT.md)**

**범용 푸시 빠른 참조**(전체 필드는 가이드 참조):

```
POST https://<your-domain>/api/push?token=<RECEIVE_TOKEN>
{"source":"notify","sender":"demo","content":"hello from anywhere"}
```

`{"success":true,...}` 응답이면 저장된 것입니다. 완전히 같은 페이로드를 다시 푸시하면 `duplicated:true`가 반환됩니다.

## 환경 변수(모든 플랫폼)

| 변수 | 필수 | 설명 |
|---|---|---|
| `RECEIVE_TOKEN` | 예 | 푸시 인증 시크릿; 충분히 긴 임의 문자열을 직접 만드세요 |
| `ENABLE_AUTH` | 아니요 | `"true"`이면 관리 페이지에 로그인 필요(**강력 권장**, 아래 보안 권고 참조); 기본은 로그인 없음 |
| `ADMIN_PASSWORD` | 아니요 | 로그인 비밀번호(`ENABLE_AUTH="true"`일 때 설정; 누락 시 관리 API는 접근을 일괄 거부하고 경고를 기록 — 설정 누락으로 문이 열리는 일은 없음) |
| `RETENTION_DAYS` | 아니요 | 데이터 보존 일수, 기본 30 |
| `WAIT_MAX_SECONDS` | 아니요 | `/api/wait` 롱 폴링 최대 대기 초, 기본 25(범위 3–25). **Netlify Functions**(10초 상한) 등 짧은 타임아웃 플랫폼에서는 `8`로 설정해 요청이 플랫폼에 강제 종료되지 않게 하세요 |
| `PHONE_AREA_ENABLED` / `PHONE_AREA_API` | 아니요 | 번호 지역 조회: 기본 켜짐(무료 360 API, 키 불필요, 백엔드 24시간 캐시, 11자리 모바일 번호만 조회); `false`로 끔; 사용자 지정 소스는 `PHONE_AREA_API`(URL에 `{number}` 플레이스홀더 포함) |
| 알림 채널 변수 | 아니요 | `FEISHU_WEBHOOK`(Feishu) / `WECOM_WEBHOOK`(WeCom) / `DINGTALK_WEBHOOK`(DingTalk, 선택 `DINGTALK_SECRET` 서명) / `SERVERCHAN_SENDKEY` / `PUSHPLUS_TOKEN` / `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` / `BARK_DEVICE_KEY`(선택 `BARK_URL`) / `NTFY_URL`(선택 `NTFY_TOKEN`) / `GOTIFY_URL`+`GOTIFY_TOKEN` / `RESEND_API_KEY`+`MAIL_TO`(이메일, 선택 `MAIL_FROM`) / `GENERIC_WEBHOOKS`(범용 웹훅, 선택 `GENERIC_WEBHOOK_TEMPLATE` 본문 / `GENERIC_WEBHOOK_HEADERS` 헤더). 사용하는 것만 설정하며, 하나도 설정하지 않으면 전달하지 않음. 알림은 내용에 따라 세 가지 모드로 자동 렌더링(🔐 OTP / 💬 SMS / 🔔 알림) |
| `SITE_NAME` / `SITE_ICON` | 아니요 | 사이트 이름 / 아이콘 URL; 미설정 시 기본값 적용 |
| `NOTIFY_LINK` | 아니요 | 관리 페이지 홈 URL; 설정하면 모든 알림 채널에 "관리 페이지 열기" 항목이 추가됨(버튼/링크/클릭); 미설정 시 자동 생략 |
| `SESSION_SECRET` | 로그인 켤 때 필수 | 세션 서명 시크릿: **고엔트로피 임의 값(≥32자 임의 문자열 권장), 관리자 비밀번호와 완전히 독립**; Cloudflare와 EdgeOne(및 모든 플랫폼)은 각각 별도 값을 가져야 함; Git에 커밋하거나 비밀번호를 재사용하는 일은 금물. 누락 시 로그인과 인증은 **fail-closed**(로그인 500 반환, 관리 API 401 반환, 비밀번호 파생 폴백 없음). 값을 교체하면 기존 세션은 즉시 무효화됩니다. 세션은 30분 유지; 로그아웃은 브라우저 쿠키만 지움 — 복사해 둔 세션 토큰은 TTL 내(최대 30분) 유효할 수 있음 |

Cloudflare는 추가로 `DB`(D1 바인딩)가 필요하고, 그 외 플랫폼은 `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`(Turso 데이터베이스, 각 플랫폼 가이드 참조)이 필요합니다. Node 셀프호스팅은 `SQLITE_PATH` 로컬 SQLite 모드도 지원합니다(platforms/node/README.md 참조).

> **보안 권고**
> 1. **관리자 로그인 켜기**(`ENABLE_AUTH="true"` + `ADMIN_PASSWORD`): 관리 페이지에는 SMS OTP 코드 등 민감한 내용이 있습니다. 로그인이 없으면 도메인만 아는 사람이 모든 메시지를 읽고 데이터를 삭제할 수 있습니다. 로그인 엔드포인트는 속도 제한이 내장되어 있고(IP당 연속 5회 실패 시 10분 잠금), `/api/receive`와 `/api/push`는 IP당 분당 120회 쓰기 제한이 있습니다(초과 시 429).
> 2. **URL의 `?token=` 트레이드오프**: SmsForwarder 등 클라이언트와의 호환성을 위해 `/api/receive`와 `/api/push`는 `?token=` 쿼리 파라미터 인증을 허용합니다 — 토큰이 플랫폼 접근 로그와 브라우저 기록에 남을 수 있습니다. 우려된다면 POST + `Authorization: Bearer <RECEIVE_TOKEN>` 헤더 방식으로 전환하세요(두 방식 모두 지원).

## License

[MIT](../../../LICENSE) © 2026 [左立方 (ZuoLifang)](https://cbm.im/)
