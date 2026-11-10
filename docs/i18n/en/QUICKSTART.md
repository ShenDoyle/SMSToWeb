# Quick start (English)

> This is the short English path. The [complete Chinese user guide](../../guide/README.md) has per-platform click-by-click steps, screenshots references, and a fuller FAQ.

## What you need

1. A platform account — **Cloudflare recommended** (free, no server, no credit card).
2. A GitHub account (deploy buttons clone the repo into your own account).
3. A long random string for `RECEIVE_TOKEN` (32+ chars, from a password manager).

You do **not** need to buy a server or a domain. Platforms give you a free URL.

## Steps

1. **Pick a platform** → [deployment capability matrix](../../guide/10-部署能力矩阵.md). Short version: no platform is truly "one click and done" — all five serverless buttons are *template deploys* that still need you to fill in secrets. Only Cloudflare's button auto-creates and binds the database (D1); **table creation is done by the app on the first request, not by the button**.
2. **Deploy** using the platform guide: [Cloudflare](../../../platforms/cloudflare/README.md) · [Vercel](../../../platforms/vercel/README.md) · [Netlify](../../../platforms/netlify/README.md) · [Deno](../../../platforms/deno/README.md) · [EdgeOne](../../../platforms/edgeone/README.md) · [Node self-hosting](../../../platforms/node/README.md).
   - Vercel / Netlify / Deno / EdgeOne additionally need a [Turso](https://turso.tech) database: create it, copy the URL and token (shown once), and run the platform's `schema.sql`.
   - Node self-hosting: **first set a ≥90s stop grace**, see [stop-grace configuration](../../guide/07-停止宽限与部署配置.md) (Chinese; the config snippets are language-independent).
3. **Fill in credentials** in the platform's environment variables / secrets page:

   | Field | Example | Note |
   |---|---|---|
   | `RECEIVE_TOKEN` | `tK8mQ2xV7pL...` | required; used by every push client |
   | `ENABLE_AUTH` | `true` | strongly recommended |
   | `ADMIN_PASSWORD` | generated | required when login is on |
   | `SESSION_SECRET` | **another** random 32+ char string | must differ from the password |

   Missing `ADMIN_PASSWORD` / `SESSION_SECRET` fails closed (login 500, admin APIs 401) — it does not silently allow access.

4. **Open the site**: seeing the admin page (even empty) means the deploy worked. Turn on login and verify you can sign in.
5. **Send your first test message** (replace domain and token):

   ```bash
   curl "https://your-domain/api/push?token=YOUR_RECEIVE_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"source":"notify","sender":"deploy-test","content":"first test"}'
   ```

   `{"success":true,...}` means it was stored; sending the identical payload again returns `duplicated:true` (normal de-duplication).
   **Known gap**: there is currently **no button in the UI** to send a test message into the page. The settings page's "Send test notification" only tests forwarding channels. This is tracked as B-6 in the [UI issue list](../../guide/08-界面交互问题清单.md) and needs approval before implementation.
6. **Confirm success**: the message appears in the list, the page refreshes automatically, and the footer shows a version string.

## If something goes wrong

| Symptom | Where to look |
|---|---|
| Deploy fails | platform build logs; zero-build project (Vercel: Framework `Other`, empty build command; Netlify Base directory `platforms/netlify`) |
| No messages | check domain, token, phone background-survival, filters, dedup, and self-heal status — see the [Chinese FAQ](../../guide/05-常见问题.md) |
| Notifications not arriving | "test notification sent" only means the request was sent — **check the destination channel**; see [usage guide](../../guide/04-使用指南.md) |
| Node restarts lose notifications | container stop grace must be ≥90s — [stop-grace config](../../guide/07-停止宽限与部署配置.md) |

## Honest limitations

- The deploy buttons deploy the **public `main` branch**. Check the footer version for the code actually running in your instance.
- No serverless platform was deployed for real in this pass; platform capabilities come from official documentation, not measurement.
- Local verification: 850 automated tests and five real Docker shutdown scenarios (WSL2). Production stop-grace configuration is **your** responsibility.
