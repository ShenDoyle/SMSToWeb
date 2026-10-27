# 데이터베이스 설계 문서(DATABASE)

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | [日本語](../ja/README.md) | **한국어** | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 영어 원본에서 동기화됨（한국어판）

데이터베이스는 단일 소스의 표준 SQLite DDL(루트 `schema.sql`)을 사용하며, 전 플랫폼에서 유일한 테이블 구조를 공유합니다: 클라우드 버전은 SQLite 호환 데이터베이스(D1 / Turso), 셀프호스팅 버전은 동일한 파일을 로컬 SQLite에 직접 적용합니다.

## 테이블 구조(단일 소스: 루트 schema.sql)

### `messages` — SMS와 알림 통합 메시지 테이블

| 컬럼 | 유형 | 설명 |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | 증분 기본 키 |
| `device_id` | INTEGER | 발신 기기, `devices.id` 참조(외래키 없음) |
| `sim_number` | TEXT | 수신 전화번호(원본 보존) |
| `sender` | TEXT | 발신인 |
| `content` | TEXT | 본문(최대 8000자) |
| `source` | TEXT | 소스 분류(예: `sms` / `notify` / `jd`), 소스별 필터용 |
| `received_at` | TEXT | 수신 시각(UTC ISO 형식) |
| `deleted_at` | TEXT | 소프트 삭제 시각(NULL이면 미삭제) |
| `starred` | INTEGER(0/1) | 별표 |
| `read_at` | TEXT | 읽음 시각 |
| created_at 기본값 | | 레코드 생성 시각 |

인덱스: `idx_messages_device`, `idx_messages_received`(received_at), `idx_messages_source`. 쿼리 패턴(시간 내림차순 + 기기/소스 필터 + 페이지 매김)에 맞춤; 유니크 인덱스 `idx_messages_dedup`은 메시지 중복 방지 담당(같은 기기+발신인+본문+초 단위 시각은 한 번만 기록, 중복 푸시는 `duplicated:true`).

### `devices` — 기기 테이블

| 컬럼 | 유형 | 설명 |
|---|---|---|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | 기기 ID |
| `display_name` | TEXT | 기기 이름(앱 템플릿 name 필드; 설정하지 않으면 SMS는 sim_number에서 파생, 알림은 display_name 사용) |
| `sim_number` | TEXT | 대표 전화번호 |
| `last_seen` | TEXT | 최근 메시지 시각 |
| `created_at` | TEXT | 생성 시각 |

인덱스: `idx_devices_sim`.

## 데이터베이스 어댑터 계층(db.js)

비즈니스 코드는 단 하나의 추상 인터페이스만 사용하고, 각 플랫폼 디렉터리의 `db.js`가 이를 구현합니다:

| 플랫폼 | 구현 | 바인딩 |
|---|---|---|
| Cloudflare | `db.js`(Worker에서 직접 export) | `env.DB`(D1 바인딩) |
| Vercel / Netlify / Deno / EdgeOne | 각 디렉터리의 `db.js` | `libsql` HTTP 클라이언트(`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, 결과의 conn fingerprint로 캐시 키잉) |
| node/ | `db.js`(듀얼 모드 어댑터, 이 플랫폼 전용) | `SQLITE_PATH`가 있으면 로컬 `node:sqlite`, 없으면 Turso; 시작 시 idempotent 마이그레이션 컬럼 추가 수행 |

`db.js`는 `query(sql, params)` / `exec(sql)` 두 함수만 노출하며, `openAsyncDb(env)`가 인스턴스를 캡슐화합니다. SQL은 모두 매개변수 바인딩으로 SQL 인젝션을 방지합니다.

## 마이그레이션 정책

- **새 배포**: `schema.sql`을 한 번 실행하면 끝(원클릭 버튼에서 자동 완료);
- **기존 배포 업그레이드**: `ALTER TABLE ... ADD COLUMN`만 수동 실행(README의 FAQ "구버전에서 업그레이드" 참조); 셀프호스팅 버전은 시작 시 자동 수행;
- **플랫폼 간 마이그레이션**: D1 ↔ Turso는 테이블 구조가 완전히 동일해 데이터 내보내기/가져오기로 직접 마이그레이션.

## 데이터 생명주기

1. **기록**: `POST /api/receive`(SMS) 또는 `/api/push`(알림) — 유니크 인덱스가 중복 방지 담보, 본문 8000자로 절단;
2. **조회**: `/api/messages`(필터 + 페이지 매김), `/api/export`(CSV/JSON);
3. **변경**: 별표 토글, 읽음, 별칭, 기기 병합(모든 메시지 device_id 마이그레이션);
4. **삭제**: 두 단계 — 소프트 삭제(deleted_at 설정, 복구 가능) → 하루 보존 후 물리 삭제(백엔드 단일 SQL이 배치 완료: 만료 지우기 + 만료된 소프트 삭제 오래된 것 정리);
5. **만료**: 매일 UTC 17:00(베이징 01:00) cron이 `RETENTION_DAYS`를 초과한 데이터를 정리 — `/api/cron` HTTP 엔드포인트(모든 플랫폼)가 cron이 없는 플랫폼용 백업 트리거 역할을 함.

## 데이터베이스 운영 명령 예시

```bash
# Cloudflare D1（schema.sql 已含全部表结构与索引）
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote

# Turso
turso db shell sms-gateway < schema.sql
turso db shell sms-gateway "SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL"

# 查看过期待清理数据量
turso db shell sms-gateway "SELECT COUNT(*) FROM messages WHERE received_at < datetime('now','-30 days')"
```

## 완전한 테이블 생성 SQL(schema.sql 전문)

```sql
-- SMSToWeb schema: SMS/通知统一消息网关
-- 单一来源，所有平台共用；改表结构必须同步此处与 node/db.js 的迁移逻辑

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT,
  sim_number TEXT,
  last_seen TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_devices_sim ON devices(sim_number);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id INTEGER NOT NULL,
  sim_number TEXT,
  sender TEXT,
  content TEXT,
  source TEXT DEFAULT 'sms',
  received_at TEXT,
  deleted_at TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_dedup
  ON messages(device_id, sender, content, received_at);
```
