# Vercel デプロイチュートリアル

[English](../../../README.md) | [简体中文](../zh-CN/README.md) | [繁體中文](../zh-TW/README.md) | **日本語** | [한국어](../ko/README.md) | [Español](../es/README.md) | [Français](../fr/README.md) | [Deutsch](../de/README.md) | [Português (BR)](../pt-BR/README.md)

> 英語原文から同期（日本語版）

SMSToWeb を Vercel（Edge Function + Turso データベース）へデプロイします。無料枠で個人利用には十分で、全体の所要時間は約 15 分です。

**このディレクトリのファイル**：`api/[[...route]].js`（エントリ）、`app.js`（コアアプリ）、`db.js`（Turso アダプタ）、`schema.sql`（テーブル作成）、`vercel.json`（定時タスクの設定を含む）。

---

## ワンクリックデプロイ（推奨）

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb%2Ftree%2Fmain%2Fplatforms%2Fvercel&env=RECEIVE_TOKEN%2CTURSO_DATABASE_URL%2CTURSO_AUTH_TOKEN&project-name=sms-gateway&envDescription=%E6%8E%A8%E9%80%81%E9%89%B4%E6%9D%83%E5%AF%86%E9%92%A5%E4%B8%8E%20Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E8%BF%9E%E6%8E%A5%E4%BF%A1%E6%81%AF&envLink=https%3A%2F%2Fgithub.com%2FShenDoyle%2FSMSToWeb)

**まず下記のステップ 2（Turso データベースの作成）を完了して接続情報を取得してから**、ボタンをクリックすることを推奨します：Vercel はこのプラットフォームのサブディレクトリをあなたのリポジトリとしてクローンしプロジェクトを作成します。案内に従って `RECEIVE_TOKEN`（プッシュ認証シークレット、自作の長いランダム文字列）と Turso の URL / Token を入力すればデプロイできます。デプロイ成功後、**必ずステップ 3 のテーブル作成 SQL を一度実行してください**（Vercel はテーブルを自動作成できません）。実行しないとページを開いてもデータが表示されません。

---

## 事前準備

1. GitHub アカウント 1 つ（Vercel は GitHub リポジトリ経由でデプロイします）
2. Vercel アカウント 1 つ（[登録入口](https://vercel.com/signup)。GitHub でそのままログインできます）

## ステップ 1：コードリポジトリの準備

1. プロジェクトの GitHub リポジトリを開き、右上の **Fork** をクリック（または自分がすでに Push 済みのリポジトリを使用）
2. Fork が完了すれば、自由に変更できるプロジェクトのコピーが手に入ります

## ステップ 2：Turso データベースの作成

Turso は SQLite 互換のデータベースを提供します（無料枠：データベース 100 個、5GB ストレージ、月 5 億行の読み取り）。

1. [turso.tech](https://turso.tech) を開き、**Start for free now** をクリックして GitHub でログイン
2. コンソールに入る → **Create Database**（データベースを作成）：
   - Name：`sms-gateway`
   - Location：自分に近いリージョンを選択（例：Singapore / Hong Kong）
   - Type：Free
3. 作成後、データベースの詳細ページに入る：
   - **Database URL**（`libsql://sms-gateway-xxxx.turso.io` の形式）を控える
   - **Create Token**（または Turso Platform Tokens）をクリックしてアクセストークンを作成し、**すぐにコピーして保存**（一度しか表示されません）
4. テーブル構造の初期化：データベース詳細ページ → **Console**（Web 版 SQL コンソール）→ このディレクトリの [`schema.sql`](../../../platforms/vercel/schema.sql) の全内容を貼り付け → 実行 → 成功と表示されます（`messages` と `devices` の 2 つのテーブルが作成されます）

> Turso CLI も使えます：`turso db create sms-gateway` → `turso db shell sms-gateway < schema.sql` → `turso db tokens create sms-gateway`。

## ステップ 3：リポジトリを Vercel へインポート

1. [vercel.com](https://vercel.com) にログイン → **Add New → Project**
2. **Import Git Repository** のリストで Fork したリポジトリを見つけ、**Import** をクリック
3. 設定ページで **Root Directory**（ルートディレクトリ）を展開し、`platforms/vercel` を選択
   —— Vercel はディレクトリ内の `vercel.json` と `api/` ディレクトリを自動認識するため、他の設定は不要です
4. まだ Deploy を押さずに、先にステップ 4 の環境変数を設定します（同じページの **Environment Variables** 欄で追加）

## ステップ 4：環境変数の設定

デプロイ設定ページの **Environment Variables** で 1 つずつ追加します（後から Project → Settings で変更することもできます）：

| 名称 | 値 | 説明 |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://sms-gateway-xxxx.turso.io` | ステップ 2 で控えた URL |
| `TURSO_AUTH_TOKEN` | （ステップ 2 のトークン） | 一度しか表示されないあのトークン |
| `RECEIVE_TOKEN` | 自作の長いランダム文字列 | プッシュ認証。サンプル値は使わないこと |
| `ENABLE_AUTH` | `false` | ログインが必要なら `true` に変更 |
| `ADMIN_PASSWORD` | 自作のパスワード | `ENABLE_AUTH="true"` のときだけ必要 |
| `SESSION_SECRET` | 高エントロピーな乱数値（≥32 文字のランダム文字列） | `ENABLE_AUTH="true"` のときだけ必要。パスワードとは独立し、他のプラットフォームとは別々の独立した値を設定。欠落時はログイン/認証が安全に失敗し、ローテーション後はすべての旧セッションが無効になる |
| `RETENTION_DAYS` | `30` | データ保持日数 |
| `CRON_SECRET` | **RECEIVE_TOKEN と同じ値** | Vercel Cron が /api/cron を呼ぶとき自動で `Bearer $CRON_SECRET` を付与 |
| `FEISHU_WEBHOOK`（任意 `FEISHU_SECRET`） | （任意）Feishu グループボットの Webhook | 設定すると新着メッセージを Feishu グループへ自動転送。ボットのセキュリティ設定で「署名検証」を選んだ場合は別途 `FEISHU_SECRET` |
| `WECOM_WEBHOOK` | （任意）WeCom グループボットの Webhook | 設定すると新着メッセージを WeCom グループへ自動転送 |
| `DINGTALK_WEBHOOK` | （任意）DingTalk グループボットの Webhook | 加签（署名追加）のセキュリティ設定では別途 `DINGTALK_SECRET` |
| `SERVERCHAN_SENDKEY` | （任意）ServerChan の SendKey | WeChat プッシュ |
| `PUSHPLUS_TOKEN` | （任意）PushPlus のトークン | WeChat プッシュ |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | （任意）Telegram Bot | 両方設定して初めて有効 |
| `BARK_DEVICE_KEY` | （任意）Bark デバイス Key | 自前サーバーは別途 `BARK_URL`、デフォルトは公式 |
| `NTFY_URL`（任意 `NTFY_TOKEN`） | （任意）ntfy のトピック URL | 完全な URL。例：`https://ntfy.sh/my-sms`。保護トピックは別途 `NTFY_TOKEN`（Token または user:password） |
| `GOTIFY_URL` + `GOTIFY_TOKEN` | （任意）Gotify | サーバーアドレス + アプリトークン |
| `RESEND_API_KEY` + `MAIL_TO` | （任意）メール（Resend） | 任意 `MAIL_FROM`、デフォルトは `onboarding@resend.dev` |
| `GENERIC_WEBHOOKS`（任意 `GENERIC_WEBHOOK_TEMPLATE` / `GENERIC_WEBHOOK_HEADERS`） | （任意）汎用 Webhook | 複数 URL はカンマ区切り。任意のテンプレートでリクエストボディをカスタマイズ、`GENERIC_WEBHOOK_HEADERS`（JSON 文字列）でリクエストヘッダーをカスタマイズ |
| `SITE_NAME` / `SITE_ICON` | （任意） | サイト名 / アイコン URL |
| `NOTIFY_LINK` | （任意） | 管理画面ホームのアドレス。設定するとすべての通知チャネルに「管理画面を開く」エントリが付く。未設定時は自動的に省略 |

すべて入力し終えたら **Deploy** をクリックし、約 1 分でデプロイが完了します。

## ステップ 5：デプロイの検証

1. デプロイ完了ページで **Continue to Dashboard** をクリックし、上部に割り当てられたドメイン（`https://xxx.vercel.app` の形式）を控える
2. ブラウザでそのドメインを開くと、管理画面が表示されるはずです（デフォルトは「短信网关」。ログイン有効時は先にログインページ）
3. プッシュ API を検証します（`<ドメイン>` と `<シークレット>` を自分のものに置き換えてください）：

```
curl "https://<ドメイン>/api/push?token=<RECEIVE_TOKEN>" -H "Content-Type: application/json" -d "{\"source\":\"notify\",\"sender\":\"deploy-test\",\"content\":\"Vercel 部署成功\"}"
```

`{"success":true,...}` が返れば接続 OK で、Web ページにすぐこのメッセージが現れます。

## ステップ 6：スマホとデバイスの接続

[マルチプラットフォームデプロイ & 取り込みガイド](./DEPLOYMENT.md)に従って Android SmsForwarder（SMS は `/api/receive` 経由）と各デバイスの通知プッシュ（`/api/push` 経由）を設定し、ドメインはあなたの `xxx.vercel.app`（またはバインドしたカスタムドメイン）を使用してください。

カスタムドメインのバインド：Project → **Settings → Domains** → Add で追加し、案内に従ってドメインの DNS に CNAME レコードを 1 件追加します — ターゲット値は Domains ページに表示されているものを基準にしてください（Vercel はプロジェクトごとに専用の `xxxxxx.vercel-dns.com` アドレスを割り当てます）。

## 注意事項とよくある質問

- **定期クリーンアップ**：`vercel.json` には毎日 UTC 17:00（北京時間 01:00）に `/api/cron` を呼んで期限切れデータをクリーンアップする設定が済んでいます。Vercel Cron は自動で `Authorization: Bearer $CRON_SECRET` を付与するため、`CRON_SECRET` は `RECEIVE_TOKEN` と一致している必要があります
- **Hobby（無料）プランの制限**：cron は 1 日 1 回のみ対応（本プロジェクトはちょうど 1 日 1 回なので問題ありません。実際の発火時刻は設定した時間帯の中で前後することがありますが、正常な挙動です）。Edge 関数は **25 秒以内にレスポンスの返却を開始する**必要があります（その後は 300 秒間ストリーミングを継続できます）。管理画面のロングポーリング `/api/wait` はちょうど 25 秒滞留するため境界上にあります — 途中で切断されても、フロントエンドのポーリングループが自動リトライするため**機能には影響せず**、新着メッセージの通知が少し遅れるだけです
- **Edge Runtime**：エントリで `runtime = "edge"` を宣言済み。コールドスタートが速く、世界中のエッジノードで実行されます
- **デプロイ失敗の排查**：多くは環境変数の入力漏れです — `TURSO_*` が欠けると 500 で "config error" になります。Root Directory で `platforms/vercel` を正しく選んでいるか確認してください
- **コードの更新**：Fork したリポジトリへ push すると、Vercel が自動で再デプロイします
