# SMSToWeb マルチプラットフォーム デプロイ & 取り込みガイド

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

本システムは 2 つの部分から成ります：**送信側**（各プラットフォームのプッシュクライアント）+ **クラウドゲートウェイ**（6 プラットフォームから 1 つを選択：Cloudflare / Vercel / Deno / Netlify / EdgeOne Makers / Docker セルフホスト。[PLATFORMS.md](./PLATFORMS.md) 参照、取り込み方法は完全に同じです）。
SMS は取り込み経路の一つにすぎません — HTTP リクエストを送れるあらゆるデバイス / スクリプトが、同じ Web ページへ通知をプッシュして閲覧できます。

```
Android(SmsForwarder)──┐  SMS+アプリ通知
iOS(ショートカット)────┤
Linux(curl/ntfy)───────┼──→ POST /api/receive（SMS）または /api/push（汎用通知）
Windows(PowerShell)────┤         │
macOS(ショートカット)──┘         ▼
                        Cloudflare Worker ──→ D1 ストレージ ──→ 統合 Web ページ（ソースフィルター）
                              │
                              └──（任意）マルチチャネル通知 → Feishu/WeCom/DingTalk/TG/Bark/メール…
```

---

## 1. クラウド側の設定（Cloudflare）

### 1. 変数とシークレット

Worker をデプロイした後、**Workers と Pages → sms-gateway → 設定 → 変数とシークレット**で設定します：

| 名称 | タイプ | 必須 | 説明 |
|---|---|---|---|
| `RECEIVE_TOKEN` | シークレット | はい | プッシュ認証トークン。自分で長いランダム文字列を作る（サンプル値を使わないこと） |
| `ADMIN_PASSWORD` | シークレット | ログイン有効時に設定 | 管理画面のログインパスワード。強力なパスワードを推奨。設定漏れの場合は管理 API が一律アクセスを拒否し（設定欠落でも通さない）、アラートを出力します |
| `ENABLE_AUTH` | テキスト | いいえ | `"true"` でログインを有効化（**セキュリティ上強く推奨**：管理画面は SMS 認証コードなどの機密情報を扱うため、デフォルトのログインなしはドメインを知るすべての人に開放するのと同じ）；`"false"` または未設定ならログインなし |
| `FEISHU_WEBHOOK` | テキスト | いいえ | Feishu グループボットの Webhook。設定すると新着メッセージを Feishu グループへ自動転送（署名検証は別途 `FEISHU_SECRET`） |
| `FEISHU_SECRET` | シークレット | いいえ | Feishu ボットのセキュリティ設定で「署名検証」を選んだ場合のみ設定。プログラムが署名を自動計算します |
| `WECOM_WEBHOOK` | テキスト | いいえ | WeCom グループボットの Webhook |
| `DINGTALK_WEBHOOK` | テキスト | いいえ | DingTalk グループボットの Webhook（セキュリティ設定で署名追加＝「加签」を選んだ場合は別途 `DINGTALK_SECRET` が必要） |
| `SERVERCHAN_SENDKEY` | テキスト | いいえ | ServerChan の SendKey（WeChat プッシュ） |
| `PUSHPLUS_TOKEN` | テキスト | いいえ | PushPlus のトークン（WeChat プッシュ） |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | テキスト | いいえ | Telegram Bot トークン + チャット/グループ ID |
| `BARK_DEVICE_KEY` | テキスト | いいえ | Bark デバイス Key（自前サーバーは別途 `BARK_URL`、デフォルトは公式） |
| `NTFY_URL` | テキスト | いいえ | ntfy の完全なトピック URL。例：`https://ntfy.sh/my-sms`（保護トピックは別途 `NTFY_TOKEN`） |
| `NTFY_TOKEN` | テキスト | いいえ | ntfy 保護トピックのアクセストークン：Access Token はそのまま入力（Bearer）。自前サーバーは `user:password` 形式で入力（Basic） |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | テキスト | いいえ | Gotify サーバーのアドレス（`/message` を含まない）+ アプリトークン |
| `RESEND_API_KEY` + `MAIL_TO` | テキスト | いいえ | メール（Resend API）。任意 `MAIL_FROM`、デフォルトは `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS` | テキスト | いいえ | 汎用 Webhook。複数 URL はカンマ区切り。任意 `GENERIC_WEBHOOK_TEMPLATE` でリクエストボディ、`GENERIC_WEBHOOK_HEADERS` でリクエストヘッダーをカスタマイズ |
| `GENERIC_WEBHOOK_HEADERS` | テキスト | いいえ | 汎用 Webhook のカスタムリクエストヘッダー。JSON オブジェクト文字列。例：`{"Authorization":"Bearer xxx"}` |
| `NOTIFY_LINK` | テキスト | いいえ | 管理画面ホームのアドレス。設定するとすべての通知チャネルに「管理画面を開く」エントリ（Feishu ボタン、各チャネルのリンク行、Bark url、ntfy click など）が付きます。未設定時は自動的に省略 |
| `SESSION_SECRET` | Secret | ログイン有効時は必須 | ログインセッションの署名シークレット：**高エントロピーな乱数値（≥32 文字のランダム文字列を推奨）、管理パスワードとは完全に独立**。CF と EO（および各プラットフォーム）にはそれぞれ独立した値を設定。Git へのコミットやパスワードの流用は厳禁。欠落時はログインと認証が安全に失敗し（ログイン 500、管理 API 401）、パスワード派生へはフォールバックしません。ローテーション後はすべての旧セッションが即時無効になり再ログインが必要。セッションの有効期限は 30 分。ログアウトはブラウザの Cookie を消すだけで、コピーされたトークンは TTL 内であれば有効のままです |
| `RETENTION_DAYS` | テキスト | いいえ | データ保持日数。デフォルト 30、変更後は即時反映 |
| `WAIT_MAX_SECONDS` | テキスト | いいえ | ロングポーリング `/api/wait` の最大滞留秒数。デフォルト 25（3–25）。**Netlify Functions はデフォルトで 10 秒上限 → `8` を推奨**。Vercel Edge は `20` を推奨。フロントエンドは失敗時に指数バックオフするため、関数に殺到しません |

> **2 つのセキュリティ上のヒント**
> 1. 管理画面ログイン（`ENABLE_AUTH="true"`）は強く推奨します。強力なパスワード `ADMIN_PASSWORD` を設定してください。ログイン API にはレート制限が組み込まれています（同一 IP で連続 5 回失敗すると 10 分ロック）。`/api/receive`、`/api/push` は毎分 120 回を超える書き込みで 429 を返します（しばらくすると自動回復）。
> 2. プッシュトークンは `?token=` の URL パラメータに対応しています（SmsForwarder 向けのシナリオ）。トークンは URL に現れ、プラットフォームのアクセスログに入る可能性があります。気になる場合は POST + `Authorization: Bearer <RECEIVE_TOKEN>` リクエストヘッダーでの送信に切り替えてください。両方式ともサポートしています。

### 2. 通知転送チャネル（任意、設定したものだけ転送）

デプロイしたプラットフォームの「環境変数 / Variables」ページで対応する変数を追加すれば有効になります。**何も設定しなければ転送は行われず、メッセージの保存や Web ページでの閲覧には影響しません**。
複数チャネルは並列で転送され、単一チャネルの失敗は他のチャネルに影響しません。重複メッセージ（`duplicated:true`）は重複転送されません。

通知は内容に応じて自動的に**3 状態**でレンダリングされます（全チャネル共通）：認証コードを検出 → **認証コード通知**（認証コードはタイトル/カードの大きな文字に表示。Bark 通知はタップするだけでコードをコピー、Bark と ntfy は優先度を引き上げ）；認証コードのない SMS → **新着 SMS**；App/デバイスのプッシュ → **デバイス通知**。任意変数 `NOTIFY_LINK` を設定すると各チャネルに自動で「管理画面を開く」エントリが付き、未設定時は自動的に省略されます。

汎用 Webhook のデフォルトのリクエストボディは JSON で、新たに `type`（`verify`/`sms`/`notify`）と `code`（検出された認証コード。未検出は空文字列）フィールドが追加されています。`GENERIC_WEBHOOK_TEMPLATE` のテンプレートプレースホルダも `{{type}}`/`{{code}}` に対応しています。

各チャネルの申請手順：

**Feishu グループボット** — `FEISHU_WEBHOOK`（任意 `FEISHU_SECRET`）
1. Feishu の対象グループ → 設定 → グループボット → ボットを追加 → **カスタムボット**
2. `https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx` の形式の Webhook アドレスを取得し、変数に入力すれば完了
3. セキュリティ設定は 3 択：**カスタムキーワード**（推奨：キーワードに `SMS` などを設定すれば他の設定は不要）；**署名検証**（シークレットを `FEISHU_SECRET` に入力すればプログラムが署名を自動計算）；IP ホワイトリスト（Worker の送信元 IP は固定ではないため選ばないこと）

**WeCom グループボット** — `WECOM_WEBHOOK`
1. WeCom の対象グループ → 右上のグループ設定 → グループボット → ボットを追加 → 新規作成
2. `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx` の形式の Webhook アドレスをコピーし、変数に入力すれば完了

**DingTalk グループボット** — `DINGTALK_WEBHOOK`（任意 `DINGTALK_SECRET`）
1. DingTalk の対象グループ → グループ設定 → スマートグループアシスタント → ボットを追加 → **カスタム**（Webhook 接続）
2. セキュリティ設定は**加签（署名追加）**を推奨：ページに表示されるシークレット（SEC で始まる）を `DINGTALK_SECRET` に入力。未設定の場合は署名なしで直接接続します
3. Webhook アドレス（`https://oapi.dingtalk.com/robot/send?access_token=xxxx` の形式）をコピーして `DINGTALK_WEBHOOK` に入力

**ServerChan（WeChat プッシュ）** — `SERVERCHAN_SENDKEY`
1. [sct.ftqq.com](https://sct.ftqq.com) を開き、WeChat スキャンでログイン
2. トップページで **SendKey**（`SCTxxxxxxxxxxxx` の形式）をコピーして変数に入力。メッセージはあなたの WeChat「方糖」サービスアカウントへプッシュされます

**PushPlus（WeChat プッシュ）** — `PUSHPLUS_TOKEN`
1. [pushplus.plus](https://www.pushplus.plus) を開き、WeChat スキャンでログイン
2. トップページで **token** をコピーして変数に入力。公式アカウントをフォローすれば WeChat でプッシュを受信できます

**Telegram Bot** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`（両方設定して初めて有効）
1. TG で [@BotFather](https://t.me/BotFather) を検索 → `/newbot` の案内に従って作成 → Bot Token（`123456:ABC-xxx` の形式）を取得
2. `chat_id` の取得：まずあなたの Bot にメッセージを 1 件送り、ブラウザで `https://api.telegram.org/bot<あなたのToken>/getUpdates` を開くと、返ってきた JSON から `chat.id` を見つけられます（グループチャットでは Bot をグループに招待して 1 件送信すれば、同様にグループ ID を確認できます）
3. 2 つの値をそれぞれ `TELEGRAM_BOT_TOKEN` と `TELEGRAM_CHAT_ID` に入力

**Bark（iOS プッシュ）** — `BARK_DEVICE_KEY`（任意 `BARK_URL`）
1. App Store で [Bark](https://apps.apple.com/app/bark-customed-notifications/id1403753865) をインストールし、アプリを開いてサンプル URL の Key の部分をコピー（`https://api.day.app/<この部分がKey>/...`）
2. Key を `BARK_DEVICE_KEY` に入力。自前サーバーを使う場合はさらに `BARK_URL` を設定（デフォルトは公式 `https://api.day.app`）

**ntfy（Android/iOS/Web 購読）** — `NTFY_URL`（任意 `NTFY_TOKEN`）
1. スマホに ntfy アプリをインストール（または [ntfy.sh](https://ntfy.sh) の Web 版を使用）し、カスタムトピック名（topic）を購読します。例：`my-sms-9f2k`（名前はランダムなほどプライベートです）
2. `NTFY_URL` には完全なトピック URL を入力：`https://ntfy.sh/my-sms-9f2k`（自前サーバーはあなたのアドレスを入力。リバースプロキシのサブパスデプロイにも対応）
3. トピックでアクセス制御を有効にしている場合は `NTFY_TOKEN` を設定：Access Token（`tk_` で始まる）はそのまま入力。自前サーバーは `ユーザー名:パスワード` 形式で入力

**Gotify（自前プッシュサービス）** — `GOTIFY_URL` + `GOTIFY_TOKEN`
1. すでに Gotify を構築している場合、Web でログイン → **Apps** → アプリを作成 → **Token** をコピー
2. `GOTIFY_URL` にはサーバーアドレス（例：`https://push.example.com`。**`/message` は付けない**）、Token は `GOTIFY_TOKEN` に入力

**メール（Resend API）** — `RESEND_API_KEY` + `MAIL_TO`（任意 `MAIL_FROM`）
1. [resend.com](https://resend.com) を開いて登録（無料枠は 1 日 100 通、月 3000 通）
2. **API Keys** → Create API Key でコピーして `RESEND_API_KEY` に入力
3. `MAIL_TO` には受信メールアドレス（複数はカンマ区切り）を入力。`MAIL_FROM` 未入力時のデフォルトは `onboarding@resend.dev`（このデフォルト送信者は Resend に登録したあなたのメールアドレス宛にしか送れません。任意の宛先に送るには Resend で自分のドメインを認証し `MAIL_FROM` を設定してください）

**汎用 Webhook / サードパーティ API** — `GENERIC_WEBHOOKS`（任意 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`）
1. `GENERIC_WEBHOOKS` に 1 つ以上の URL を入力（**カンマ区切り**）。デフォルトは POST JSON：

```json
{"title":"【SMS】13800138000 ← 10086","content":"本文…","time":"2026-10-14 12:30:00（北京時間）","source":"sms","sender":"1069012345678","device":"私のスマホ"}
```

2. 相手側が特定の形式を要求する場合は `GENERIC_WEBHOOK_TEMPLATE` を設定し、プレースホルダ `{{title}}` / `{{content}}` / `{{time}}` / `{{source}}` / `{{sender}}` / `{{device}}` でリクエストボディをカスタマイズできます。テンプレートが JSON として解析できれば JSON で送信され、そうでなければプレーンテキストで送信されます。例：

```
{"phone":"13800138000","msg":"{{content}}","at":"{{time}}"}
```

3. 相手側が認証ヘッダー（シークレットを URL に載せない）を要求する場合は `GENERIC_WEBHOOK_HEADERS` を設定します。値は JSON オブジェクト文字列。例：

```json
{"Authorization":"Bearer sk-xxx","X-Api-Key":"yyy"}
```

この値が正当な JSON でない場合は無視され、デフォルトの転送には影響しません。SMS ゲートウェイ、Home Assistant、n8n、自作スクリプトなど、あらゆるサードパーティ API をこのテンプレートで接続できます。各チャネルの変数名と設定場所は上記「変数とシークレット」の表を参照。Cloudflare は Worker の「変数とシークレット」ページで設定し、その他のプラットフォームは各プラットフォームのチュートリアルにある対応する環境変数の箇所で設定します。

### 3. データベース

D1 の `messages` テーブルには `source`（SMS/通知の区別）と `deleted_at`（ソフトデリート/取り消し）カラムが必要です。新規デプロイでは [schema.sql](../../../schema.sql) をそのまま実行してください。既存 DB のアップグレードは以下を実行：

```sql
ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';
ALTER TABLE messages ADD COLUMN deleted_at TEXT;
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN read_at TEXT;
```

---

## 2. プッシュ API 仕様

2 つの公開 API は共通の `RECEIVE_TOKEN` で認証します（token は query でも body でも可）：

### 1. SMS 受信 `POST /api/receive`（Android アプリ専用）

```
POST https://<あなたのドメイン>/api/receive?token=<RECEIVE_TOKEN>
Content-Type: application/json

{
  "name": "私のスマホ",
  "sim": "13800138000",
  "from": "1069012345678",
  "content": "認証コードは 734752、5 分間有効です",
  "time": "2026-10-14 12:29:59"
}
```

### 2. 汎用プッシュ `POST /api/push`（各プラットフォームの通知）

```
POST https://<あなたのドメイン>/api/push
Content-Type: application/json

{
  "token": "<RECEIVE_TOKEN>",
  "source": "notify",
  "sender": "バックアップスクリプト",
  "name": "通知ゲートウェイ",
  "content": "データベースバックアップ完了、3 分 12 秒かかりました",
  "time": "2026-10-14 03:00:00"
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `token` | はい | 認証トークン |
| `content` | はい | メッセージ本文（`text`/`message`/`msg` も可） |
| `source` | いいえ | ソース識別子。デフォルト `notify`。Web ページの「ソースフィルター」で使用。カスタム可能（例：`cron`、`alert`） |
| `sender` | いいえ | ソースのタイトル（ホスト名 / アプリ名 / スクリプト名） |
| `name` | いいえ | デバイスラベル名（カスタム命名）。デフォルトは「通知ゲートウェイ」。SMS のラベルと並んで表示されます |
| `time` | いいえ | イベント時刻。省略時はサーバーの現在時刻。タイムスタンプまたは `YYYY-MM-DD HH:MM:SS` 形式のテキストに対応 |

レスポンス：`{"success":true,"device_id":17,"duplicated":false}`（`duplicated=true` は重複メッセージが無視されたことを意味し、通知チャネルへは重複転送されません）

---

## 3. プラットフォーム別の取り込み方法

### Android（SMS + アプリ通知）— SmsForwarder

1. オープンソースアプリ「SmsForwarder」をインストール ([pppscn/SmsForwarder](https://github.com/pppscn/SmsForwarder))
2. 一般設定で**「SMS ブロードキャスト転送」のマスタースイッチをオン**にする
3. 「Webhook チャネル」を新規作成：URL に `/api/receive?token=<RECEIVE_TOKEN>` を入力、メッセージテンプレート：

```json
{"name":"私のスマホ","sim":"13800138000","from":"{{FROM}}","content":"{{SMS}}","time":"{{DATE}}"}
```

> ポイント：`name` にはカスタムデバイス名を入力（Web ページのラベルに表示されます。改名すると新しいラベルになります）；`sim` には電話番号をそのまま入力（カードの右下に表示、ダブルタップでコピー）；`content` は必ず `{{SMS}}` 変数を使います。
> アプリ通知の転送：「アプリ通知」の転送ルールをもう 1 つ追加し、テンプレートの `sender` に `{{APP_NAME}}`、`content` に `{{MSG}}` を使い、送信先を `/api/push` に変更します。

### iOS — ショートカット（Shortcuts）

1. ショートカット → オートメーション → 新規「個人用オートメーション」→「SMS/メッセージの受信」を選択
2. アクションを追加 →「URL の内容を取得」：
   - URL：`https://<あなたのドメイン>/api/push`
   - メソッド：POST、リクエストボディは JSON：

```json
{"token":"<RECEIVE_TOKEN>","source":"sms","sender":"iPhone","name":"通知ゲートウェイ","content":"[メッセージ本文変数]"}
```

3. 「実行前に確認」をオフにすれば完全自動になります。定時系の通知（バッテリー、集中モードなど）も同様に、対応するトリガーを選択してください。

### Linux — curl / スクリプト / systemd

最もシンプルなワンライナー：

```bash
curl -s -X POST https://<あなたのドメイン>/api/push \
  -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"web-01","content":"Nginx を再起動しました"}'
```

定時/イベント通知の例（`/usr/local/bin/notify.sh`）：

```bash
#!/bin/bash
curl -s -X POST https://<あなたのドメイン>/api/push \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"<RECEIVE_TOKEN>\",\"sender\":\"$(hostname)\",\"source\":\"cron\",\"content\":\"$1\"}"
```

systemd timer や cron と組み合わせて呼び出します：`notify.sh "毎日のバックアップ完了"`。

高度な任意設定：[ntfy](https://ntfy.sh) をセルフホスト（単一バイナリ / Docker）し、複数マシンに同じイベントストリームを購読させ、小さなブリッジスクリプトで ntfy メッセージを本ゲートウェイへ転送することもできます。

### Windows — PowerShell / タスクスケジューラ

`C:\Tools\notify.ps1`：

```powershell
param([string]$Message = "通知")
$body = @{
  token  = "<RECEIVE_TOKEN>"
  sender = $env:COMPUTERNAME
  source = "notify"
  content = $Message
} | ConvertTo-Json
Invoke-RestMethod -Uri "https://<あなたのドメイン>/api/push" -Method Post -ContentType "application/json" -Body $body
```

呼び出し：`powershell -File C:\Tools\notify.ps1 -Message "ディスククリーンアップ完了"`。タスクスケジューラでシャットダウン前やバックアップ後などのイベントに登録できます。

### macOS — ショートカット / launchd

- ショートカット：iOS と同じ（オートメーションのトリガーを「特定の時刻」「ファイルの変更」などに替える）
- 定時スクリプト + launchd（`~/Library/LaunchAgents/local.notify.plist`）：

```bash
curl -s -X POST https://<あなたのドメイン>/api/push -H "Content-Type: application/json" \
  -d '{"token":"<RECEIVE_TOKEN>","sender":"MacBook","content":"Time Machine バックアップ完了"}'
```

- iPhone の SMS を Mac で受信したいユーザーは、AppleScript で Messages.app の SQLite DB をポーリングして差分をプッシュする方法もあります（上級者向け）

### サーバー/コンテナ共通 — Apprise（任意の集約レイヤー）

[Apprise](https://github.com/caronc/apprise) は 100 以上の通知先に対応しており、本ゲートウェイをその中の 1 つのカスタム Webhook として扱い、複数宛先へのプッシュを一元管理できます。

---

## 4. 検証チェックリスト

| 検証項目 | 方法 |
|---|---|
| API 認証 | token なしのリクエストは 403 unauthorized を返すはず |
| 汎用プッシュ | 上記のいずれかの例で 1 件送信。Web ページの「通知」ソースに表示され、設定済みの通知チャネルにも同時に届く |
| SMS 経路 | スマホで実際に SMS を 1 通送信 → Web ページの「SMS」ソースに表示 + 認証コード抽出 + 通知チャネルへの転送 |
| ソースフィルター | 管理画面ツールバーの「ソースフィルター」ドロップダウンで切替：すべて / SMS / 通知およびカスタムソース |
| 九言語切替 | 管理画面とログインページに 9 言語を内蔵（简体中文 / 繁體中文 / English / 日本語 / 한국어 / Español / Français / Deutsch / Português (BR)）。右上の「🌐」メニューで選択するとページ全体が切り替わり、選択はブラウザのローカルに記憶されます；`https://あなたのドメイン/?lang=ja` などで直接アクセスすることもできます。旧リンク `?lang=zh` / `?lang=en` も引き続き互換（自動的に zh-CN / en へ正規化） |
| エクスポートとフィルター | 「CSV / JSON エクスポート」をクリックすると現在のフィルター結果をダウンロード。「過去 7 日」「50 件/ページ」に切り替えるとリストとエクスポートも連動して変わる |
| 重複ブロック | 同一内容を数秒以内に再送するとレスポンスは `duplicated:true` となり、通知チャネルへの重複プッシュは行われない |

## 5. よくある質問

- **メッセージを送ったのに Web ページが更新されない？** 管理画面はロングポーリングで自動更新します（デフォルト最大 25 秒滞留、`WAIT_MAX_SECONDS` で調整可）。ページに戻ると即座に 1 回追加取得します。ソースフィルターを切り替えて読み込みを誘発することもできます。
- **スマホのブラウザで画面が窮屈 / ログイン欄が拡大される？** モバイル対応済みです（セーフエリア、iOS の自動ズームを防ぐ 16px 入力欄、大きめのタッチターゲット）。それでも異常な場合は、そのサイトのキャッシュを消してから再試行してください。
- **Netlify でロングポーリングが常にエラーになる？** `WAIT_MAX_SECONDS` を `8` に設定してください（Functions の 10 秒上限より小さい値）。
- **通知チャネルに届かない？** 該当チャネルの変数が設定済みで値が正しいか確認してください（Telegram/Gotify など 2 変数で 1 組のものは両方設定が必要）。デプロイプラットフォームのログに `notify forward failed:` がないか確認。`duplicated:true` のメッセージは転送されません。
- **ラベル名を変えたい？** デバイスラベル横の「✎」で改名（別名を設定）、または「⇄」でそのラベルのメッセージを別のデバイスへ統合します。メッセージのないラベルは「×」で直接削除できます。
- **メッセージはどれくらい保持される？** `RETENTION_DAYS` で制御されます。デフォルトは 30 日で、毎日 UTC 17:00（北京時間の午前 1 時）に自動クリーンアップされます。
