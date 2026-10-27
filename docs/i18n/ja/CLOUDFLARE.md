# Cloudflare デプロイチュートリアル（主力版、全操作をブラウザで完結）

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

これがプロジェクトの主力版です：スマホの SMS/通知 → Cloudflare Worker → D1 データベース → Web 管理画面。
サーバー不要、無料枠が十分で、すべてブラウザ操作で完結し、ツールのインストールも不要です。

このディレクトリは**完全に自己完結**しています：[`worker.js`](../../../platforms/cloudflare/worker.js)（デプロイ用ソース）+ [`schema.sql`](../../../platforms/cloudflare/schema.sql)（テーブル作成スクリプト）+ [`wrangler.toml`](../../../platforms/cloudflare/wrangler.toml)（CLI デプロイ時の任意設定）。リポジトリの他のファイルには依存しません。その他のプラットフォームは[プラットフォーム概要](./PLATFORMS.md)を参照してください。

---

## ワンクリックデプロイ（初心者に推奨）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ShenDoyle/SMSToWeb/tree/main/platforms/cloudflare)

上のボタンをクリックすると、Cloudflare が自動で実行します：コードをあなたの GitHub へクローン → **D1 データベースを自動作成しテーブル作成を実行** → リソースのバインド → CI の設定（以後、リポジトリへの push ごとに自動再デプロイ）→ 公開。途中で案内に従って以下のシークレットを入力します：

- `RECEIVE_TOKEN`：プッシュ認証シークレット。十分に長いランダム文字列を自分で作成（スマホ側の接続 URL の `token=` と一致させておく）
- `ADMIN_PASSWORD`：管理画面のログインパスワード（**設定を強く推奨** — 管理画面は SMS 認証コードなどの機密情報を扱うため。`ENABLE_AUTH="true"` なのに設定漏れの場合、管理 API は一律アクセスを拒否し、ログインなしで通ることはありません）
- `SESSION_SECRET`：ログインセッションの署名シークレット、**ログイン有効時は必須** — 高エントロピーな乱数値（≥32 文字のランダム文字列。例：`node -e "console.log(crypto.randomBytes(32).toString('hex'))"` で生成）、パスワードとは完全に独立。欠落時はログインと認証が安全に失敗（ログイン 500、管理 API 401）し、パスワード派生へフォールバックしません。ローテーション後はすべての旧セッションが即時無効になります

> カスタムドメインのバインド（例：`sms.example.com`）：デプロイ完了後、Worker → 設定 → ドメインとルート → カスタムドメインを追加。
> 以下の手動チュートリアルは、ワンクリックの手順を使いたくないユーザーや、各ステップを順に理解したいユーザーのために残しています。

## 事前準備

1. Cloudflare アカウント 1 つ（[登録入口](https://dash.cloudflare.com/sign-up)。無料、メールアドレスだけで OK）
2. 本プロジェクトのコード（このディレクトリの [`worker.js`](../../../platforms/cloudflare/worker.js) が貼り付けるべきコードのすべて）

## ステップ 1：D1 データベースの作成

1. [dash.cloudflare.com](https://dash.cloudflare.com) にログイン
2. 左メニュー **ストレージとデータベース → D1 SQL データベース**
3. **データベースを作成**をクリックし、名前に `sms-gateway-db` を入力（他はデフォルト）、作成をクリック
4. 作成したばかりのデータベースに入る → **コンソール**タブ
5. このディレクトリの [`schema.sql`](../../../platforms/cloudflare/schema.sql) の全内容をコピーして入力欄に貼り付け、**実行**をクリック
6. 実行成功と表示されます（`messages` と `devices` の 2 つのテーブルが作成されます）

## ステップ 2：Worker の作成とコードの貼り付け

1. 左メニュー **コンピューティング（Workers）→ Workers と Pages**
2. **アプリケーションを作成**をクリックし、**Start with Hello World!**（Hello World テンプレートから開始）を選択、名前に `sms-gateway` を入力、**デプロイ**をクリック（まずデフォルトコードでデプロイ成功すれば OK）
3. **コードを編集**をクリックし、エディタ内のデフォルトコードをすべて削除
4. このディレクトリの [`worker.js`](../../../platforms/cloudflare/worker.js) を開いて全選択・コピーし、エディタに貼り付け
5. 右上の**デプロイ**をクリックし、デプロイ成功と表示されれば完了

## ステップ 3：D1 データベースのバインド

1. Worker の概要ページに戻る → **バインディング（Bindings）**タブ
2. **追加 → D1 データベース**をクリック
3. 変数名に `DB` と入力（完全に同じである必要があります。大文字）、作成したばかりの `sms-gateway-db` を選択
4. **デプロイ/保存**をクリック

## ステップ 4：変数とシークレットの設定

同じ場所の **設定 → 変数とシークレット（Variables and Secrets）** で 1 つずつ追加します：

1. **変数を追加**（タイプは「テキスト」を選択）：
   - 名称 `RETENTION_DAYS`、値 `30`（90 日保持したい場合は `90`）
   - 名称 `ENABLE_AUTH`、値 `false`（**セキュリティのため `true` にしてログインを有効化することを強く推奨**：管理画面は SMS 認証コードなどの機密情報を扱うため、ログインなしはドメインを知るすべての人に開放するのと同じです。Workers Builds でリポジトリ連携の自動デプロイをする場合、この値はリポジトリ内の `wrangler.toml` が優先されます — 現在はデフォルトで `true` です）
   - 名称 `SITE_NAME`（任意）、値は任意のサイト名。例：`私の SMS ステーション`
   - 名称 `SITE_ICON`（任意）、値はアイコンの URL（`http(s)://` で始まる）。未入力または URL が無効な場合は内蔵アイコンを自動使用
   - 名称 `NOTIFY_LINK`（任意）、値は管理画面ホームのアドレス（`http(s)://` で始まる）。設定するとすべての通知チャネルに「管理画面を開く」エントリが付きます
2. **シークレットを追加**（タイプは「シークレット/Secret」を選択）：
   - 名称 `RECEIVE_TOKEN`、値は自分で作った十分に長いランダム文字列（チュートリアルのサンプル値は絶対に使わない。長いほど良い）
   - 名称 `ADMIN_PASSWORD`、値は自分で作った管理画面のログインパスワード（`ENABLE_AUTH="true"` のときだけ必要）
   - 名称 `SESSION_SECRET`、値は高エントロピーなランダム文字列（≥32 文字のランダム値、パスワードとは独立。`ENABLE_AUTH="true"` のときだけ必要）
3. 追加のたびに **デプロイ/保存**をクリック

> これらの値はいつ変更しても即時反映され、コードの再貼り付けは不要です。`RECEIVE_TOKEN` を変更したら、スマホ側 URL の `token=` の更新を忘れずに。

## ステップ 5（任意）：通知転送チャネルの設定

新着メッセージが保存された後、外部チャネルへ自動転送できます。**設定したチャネルの変数だけが転送され、何も設定しなければ転送しません**。
同じ「変数とシークレット」ページで対応する変数を追加するだけです：

| チャネル | 変数 | 説明 |
|---|---|---|
| Feishu グループボット | `FEISHU_WEBHOOK`（任意 `FEISHU_SECRET`） | グループボットの Webhook アドレス。セキュリティ設定で「署名検証」を選んだ場合は別途 `FEISHU_SECRET` |
| WeCom グループボット | `WECOM_WEBHOOK` | グループボットの Webhook アドレス |
| DingTalk グループボット | `DINGTALK_WEBHOOK`（任意 `DINGTALK_SECRET`） | 加签（署名追加）のセキュリティ設定では `DINGTALK_SECRET` が必要 |
| ServerChan | `SERVERCHAN_SENDKEY` | SendKey（WeChat プッシュ） |
| PushPlus | `PUSHPLUS_TOKEN` | トークン（WeChat プッシュ） |
| Telegram Bot | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Bot トークン + チャット/グループ ID |
| Bark | `BARK_DEVICE_KEY`（任意 `BARK_URL`） | 自前サーバーの場合は `BARK_URL` を設定。デフォルトは公式 |
| ntfy | `NTFY_URL`（任意 `NTFY_TOKEN`） | 完全なトピック URL。例：`https://ntfy.sh/my-sms`。保護トピックは別途 `NTFY_TOKEN`（Token または user:password） |
| Gotify | `GOTIFY_URL` + `GOTIFY_TOKEN` | サーバーアドレス（`/message` を含まない）+ アプリトークン |
| メール（Resend） | `RESEND_API_KEY` + `MAIL_TO`（任意 `MAIL_FROM`） | `MAIL_FROM` のデフォルトは `onboarding@resend.dev` |
| 汎用 Webhook | `GENERIC_WEBHOOKS`（任意 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） | 複数 URL はカンマ区切り。テンプレートでリクエストボディ、JSON でヘッダーをカスタマイズ。サードパーティ API（SMS ゲートウェイなど）はここから接続 |

各チャネルの申請・取得手順とリクエストボディの形式は、[マルチプラットフォームデプロイ & 取り込みガイド · 通知転送チャネル](./DEPLOYMENT.md)を参照してください。
複数チャネルは並列転送され、単一チャネルの失敗は他のチャネルやメッセージの保存に影響しません。重複メッセージ（`duplicated`）は重複転送されません。
通知は内容に応じて自動的に 3 状態でレンダリングされます（🔐 認証コード通知 / 💬 新着 SMS / 🔔 デバイス通知）：認証コードは自動でタイトルに入り、各プラットフォームの強化機能を発動させます（Bark 通知はタップでコピー、Bark/ntfy は優先度を引き上げ、Feishu は violet のカードヘッダーなど）。

## ステップ 6：定期クリーンアップタスクの設定

1. Worker → **設定 → トリガー（Triggers）→ Cron トリガー**
2. **Cron トリガーを追加**をクリックし、`0 17 * * *` を入力して保存
3. 意味：毎日 UTC 17:00（北京時間の午前 1 時）に保持日数を超えたデータを自動削除します

## ステップ 7：ドメインのバインド（任意、推奨）

1. Worker → **設定 → ドメインとルート**
2. **追加 → カスタムドメイン**をクリックし、サブドメインを 1 つ入力（例：`sms.あなたのドメイン.com`）
3. Cloudflare が DNS レコードを自動作成し HTTPS 証明書を発行します。数分で有効になります
4. 以後、ブラウザで直接 `https://sms.あなたのドメイン.com` にアクセスすればそれが管理画面です

> ドメインがなくても、デフォルトの `https://sms-gateway.<あなたのサブドメイン>.workers.dev` アドレスを使用できます。

## ステップ 8：デプロイの検証

ブラウザで管理画面を開くと、あなたのサイト名のページが表示されるはずです（デフォルトは「短信网关」。`SITE_NAME` で変更可。ログインを有効にしている場合は先にログインページが表示されます）。次に受信 API を検証します（`<ドメイン>` と `<シークレット>` を自分のものに置き換えてください）：

```
curl "https://<ドメイン>/api/receive?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"name\":\"test\",\"sim\":\"13800138000\",\"from\":\"10086\",\"content\":\"部署测试\"}"
```

`{"success":true,...}` が返れば接続 OK です。このテスト SMS は Web ページ上で削除できます。

## スマホと各デバイスの接続

[マルチプラットフォームデプロイ & 取り込みガイド](./DEPLOYMENT.md)に従って Android SmsForwarder と各デバイスの通知プッシュを設定し、API ドメインをあなたの Worker アドレスに置き換えてください。

## CLI デプロイ（代替手段、wrangler を使える人向け）

このディレクトリで実行します（`wrangler.toml` あり、`main` はこのディレクトリの `worker.js` を指しています）：

```bash
npm install wrangler        # 公式推奨はプロジェクト内インストール。グローバルの npm install -g wrangler でも可
npx wrangler login
npx wrangler d1 execute sms-gateway-db --file=schema.sql --remote
npx wrangler secret put RECEIVE_TOKEN
npx wrangler secret put ADMIN_PASSWORD   # ログイン有効時のみ必要
npx wrangler secret put SESSION_SECRET   # ログイン有効時のみ必要（高エントロピーな乱数値、パスワードとは独立）
npx wrangler deploy
```

## 注意事項とよくある質問

- **転送 SMS が届かない**：① SmsForwarder 一般設定の「SMS ブロードキャスト転送」マスタースイッチ（最も見落としやすい。オフだと無音で破棄され、チャネルテストはすべて正常に見える）→ ② 転送ルールの token/URL が Worker のシークレットと一致しているか → ③ Worker のリアルタイムログでリクエストが到達しているか、の順に確認
- **通知チャネルに届かない**：該当チャネルの変数が設定済みで値が正しいか確認；Worker のリアルタイムログに `notify forward failed:` がないか確認；`duplicated:true` のメッセージは転送されません
- **Worker の無料枠**：1 日 10 万リクエストで、個人利用には十分すぎます。D1 の無料枠は 1 日 500 万行の読み取り
- **ロングポーリング**：管理画面の `/api/wait` は最大 25 秒滞留して新着メッセージを待ちます。Workers にはリクエスト時間の問題がなく、リアルタイム性は最良です
- **データ移行**：他のプラットフォームから CF へ戻す場合は、Turso データをエクスポートして D1 へインポートするだけです（テーブル構造は完全に一致）
