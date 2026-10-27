# API 문서(API)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

모든 API는 `/`를 루트로 하며, 응답은 JSON(`Content-Type: application/json`)이고 CORS를 지원합니다. "공개 API"를 제외하고 로그인 토글의 보호를 받습니다(보안 설정 권장 사항은 루트 README의 "보안 권고" 참조).

## 인증 방식

| API 유형 | 인증 |
|---|---|
| 인바운드 푸시(`/api/receive`, `/api/push`) | `?token=<RECEIVE_TOKEN>`(query 또는 폼 필드), **로그인 토글의 영향 없음** |
| 관리 API | 쿠키 세션 `sms_auth`(`POST /api/login`으로 획득; `ENABLE_AUTH=true`일 때 활성화). 세션은 **무상태 서명 토큰**(`nonce.exp.HMAC-SHA256` 3세그먼트 형식, 서명 시크릿 `SESSION_SECRET`)이며 유효 기간은 30분; `SESSION_SECRET` 누락 시 안전하게 실패(로그인 500, 관리 API는 일괄 401, 비밀번호 파생으로 폴백하지 않음), 설정 누락 시 일체 허용하지 않음. `SESSION_SECRET` 교체 후 모든 기존 세션은 즉시 무효화됨 |
| 예약 정리(`GET /api/cron`) | `?token=<RECEIVE_TOKEN>` 또는 `Authorization: Bearer <RECEIVE_TOKEN>` |

## 1. 인바운드 푸시(공개)

### POST/GET `/api/receive` — SMS 저장(SmsForwarder 호환)

매개변수(JSON body, GET일 때는 query):

| 필드 | 필수 | 설명 |
|---|---|---|
| `token` | 예 | RECEIVE_TOKEN(query에 넣어도 됨) |
| `name` | 아니요 | 기기 이름(앱 템플릿 name 필드), 기본 `unknown` |
| `sim` | 아니요 | 수신 전화번호, 그대로 저장·표시 |
| `from` | 아니요 | 발신인 |
| `content` | 예 | SMS 본문(서버가 8000자로 절단) |
| `time` | 아니요 | 클라이언트 시각; 기본값은 서버 베이징 시간 |

```bash
curl -X POST "https://<your-site>/api/receive?token=<RECEIVE_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"name":"내 휴대폰","sim":"13800000000","from":"10086","content":"인증 코드 123456"}'
```

응답: `{ "success": true, "device_id": 1, "duplicated": false }`. 같은 기기+발신인+내용+초 단위 시각으로 중복 푸시 → `duplicated: true`(저장 건너뜀, **알림 전달도 하지 않음**).

### POST `/api/push` — 범용 푸시(임의 플랫폼 소스 연동)

| 필드 | 필수 | 설명 |
|---|---|---|
| `token` | 예 | RECEIVE_TOKEN(query) |
| `content` | 예 | 본문(8000자로 절단) |
| `name` / `sender` | 아니요 | 기기 이름 / 발신 측(앱 이름, 스크립트 이름 등) |
| `source` | 아니요 | 소스 분류(기본 `notify`; 예: `alert`, `jd`, 프런트엔드에서 소스별 필터 가능) |
| `time` | 아니요 | 클라이언트 시각, 기본값은 서버 현재 시각 |

메시지를 받으면 같은 방식으로 11개 채널 알림 전달을 트리거합니다(3상태 렌더링: 인증 코드 없는 push → 🔔 기기 알림).

## 2. 메시지 조회와 관리(로그인 상태 필요)

### GET `/api/messages` — 메시지 목록

Query 매개변수:

| 매개변수 | 설명 |
|---|---|
| `q` | 키워드 검색(sender/content 매칭) |
| `source` | 소스 필터(예: `sms` / `notify` / 커스텀 소스) |
| `device_id` | 기기별 필터 |
| `range` | 시간 범위: `1d` / `7d` / `30d` |
| `limit` / `page` | 페이지 매김(기본 50/페이지) |
| `starred` | `1`이면 별표만 보기 |

응답: `{ "total": 123, "limit": 50, "page": 1, "list": [ { "id", "device_id", "display_name", "sim_number", "sender", "source", "content", "received_at", "starred", "read_at", "deleted_at" } ] }`

### 메시지 작업

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/messages/remove` | 소프트 삭제(body: `{ ids: [..] }`, deleted_at 기록) |
| POST | `/api/messages/restore` | 소프트 삭제 복구(body: `{ ids: [..] }`) |
| POST | `/api/messages/clear` | 휴지통/전체 비우기(body: `{ scope: "trash" \| "all" }`) |
| POST | `/api/messages/star` | 별표 토글(body: `{ id, starred }`) |
| POST | `/api/messages/read` | 읽음 표시(body: `{ id }`) |
| DELETE | `/api/messages/{id}` | 단건 물리 삭제 |

### GET `/api/export?format=csv|json` — 내보내기

목록과 같은 필터 매개변수 지원; CSV는 BOM과 `attachment` 다운로드 헤더를 갖고 수식 주입 방지(`=/+-@`로 시작하는 셀 앞에 작은따옴표 삽입).

### GET `/api/stats` — 통계

오늘/전체/기기 수 등 집계. GET `/api/sources` — 소스 목록(`[{ source, count }]`).

## 3. 기기 관리(로그인 상태 필요)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/devices` | 기기 목록(`display_name` 포함: 별칭 > 기기 이름, 메시지 수) |
| POST | `/api/devices/alias` | 별칭 설정(body: `{ id, alias }`; 빈 문자열이면 해제) |
| POST | `/api/devices/merge` | 기기 병합(body: `{ from, to }`, 모든 메시지를 옮긴 뒤 원본 기기 삭제; 원본→자기 자신은 400) |
| DELETE | `/api/devices/{id}` | 기기 삭제(메시지가 있으면 `has messages`로 거부) |

## 4. 실시간과 보조

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/wait?last_id=N` | 롱 폴링: N보다 새 메시지가 있으면 즉시 `{ changed: true }` 반환, 없으면 대기(기본 25초, `WAIT_MAX_SECONDS`로 조정 가능) |
| GET | `/api/phone?number=` | 번호 지역 조회(`PHONE_AREA_ENABLED=false`로 끔; 업스트림 속도 제한 프록시, 별도 분당 120회 버킷) |
| POST | `/api/login` | 로그인(body: `{ password }` → `Set-Cookie: sms_auth=<서명 세션>`, 무상태 HMAC-SHA256 3세그먼트 토큰, TTL 30분, HttpOnly + SameSite=Lax; 5회 실패 시 10분 잠금; 비밀번호 오류는 403, `SESSION_SECRET` 누락은 500 설정 오류) |
| POST | `/api/logout` | 로그아웃 |
| GET | `/api/cron?token=` | 예약 정리 트리거(`RETENTION_DAYS`를 초과한 오래된 메시지 삭제) |
| GET | `/` `/manifest.webmanifest` `/sw.js` | 관리 페이지 / PWA 매니페스트 / Service Worker |

## 5. 범용 웹훅 전달 형식(아웃바운드)

`GENERIC_WEBHOOKS`를 설정하면 메시지마다 기본 JSON으로 POST합니다:

```json
{
  "title": "🔐 인증 코드 726418 · Gitee",
  "content": "인증 코드는 726418이며, 5분간 유효합니다",
  "time": "2026-10-27 14:23:45",
  "source": "sms",
  "sender": "Gitee",
  "device": "내 휴대폰",
  "type": "verify",
  "code": "726418"
}
```

`type` ∈ `verify | sms | notify`; `code`는 서버가 경량 감지한 인증 코드(미감지 시 빈 문자열). `GENERIC_WEBHOOK_TEMPLATE`를 설정하면 템플릿대로 렌더링(플레이스홀더 `{{title}} {{content}} {{time}} {{source}} {{sender}} {{device}} {{type}} {{code}}`)하며, JSON으로 파싱되면 JSON으로, 아니면 순수 텍스트로 발송; `GENERIC_WEBHOOK_HEADERS`로 요청 헤더 커스텀 가능(JSON 객체 문자열).
