# VESPER: configuration, accounts and setup log

Everything the live app depends on, in one place: every **variable and secret** (name, purpose, where it's stored,
where it came from, how to replace it), every **external account/console**, and a **log of what was set up at each
stage**. Update this file whenever something is added or changed.

> **Secret values are never written here (or anywhere in the repo).** This file records *names* and *where each
> value lives*. Keep the actual values in a password manager or private note. If a value is lost, it can be replaced:
> see "How to replace" in each row.

---

## 1. Where things live (overview)

| Place | What it holds | Who can see it |
|---|---|---|
| **Cloudflare** → Workers & Pages → `ai-assistant` → Settings → Variables and Secrets | All app settings and API keys used at runtime (section 2) | Only you (Cloudflare login). Secrets are write-only: once saved, even you can't read them back |
| **GitHub repo** → Settings → Secrets and variables → Actions | What GitHub Actions needs to deploy to Cloudflare (section 3) | Only you |
| **D1 database** `ai-assistant` (table `app_settings`) | Admin-panel settings: sign-ups open, daily limit, bot instructions, tools (section 4) | Changed from the admin panel in the app |
| **Google Cloud** project `VESPER-AI` | "Sign in with Google" client + test-user list (section 5) | Only you (Google login) |
| **GitHub** → Settings → Developer settings → OAuth Apps | "VESPER AI" OAuth app for the admin GitHub login (section 5) | Only you |
| **Office PC** project folder | Nothing secret: the GitHub token is **not** saved in git settings; the owner pastes it at push time (section 6) | n/a |
| **Your password manager / private note** | The actual secret values | You |

---

## 2. Cloudflare Worker variables and secrets (runtime)

Set in **Cloudflare → Workers & Pages → ai-assistant → Settings → Variables and Secrets** (type *Secret* unless
noted). Deploys from GitHub keep these, because `wrangler.jsonc` has `keep_vars: true`.

### Currently set

| Name | Type | What it does | Value / where it came from | Added | How to replace |
|---|---|---|---|---|---|
| `GOOGLE_CLIENT_ID` | Secret | Identifies the app to Google for "Continue with Google" | Google Cloud → project **VESPER-AI** → Google Auth Platform → Clients → **VESPER web** (ends in `.apps.googleusercontent.com`) | 2026-11-11 (6.0) | Copy again from that client page (it stays visible there) |
| `GOOGLE_CLIENT_SECRET` | Secret | Lets the server prove it's the real app when finishing a Google sign-in | Same client, shown when the client was created (starts `GOCSPX-`) | 2026-11-11 (6.0) | Client page → **Add secret** → save the new one here → delete the old secret in Google |
| `ADMIN_EMAILS` | Plain text | Who is **admin** when signing in with Google (admin panel, no daily limit). Comma-separate several | `thisismefaraz@gmail.com` | 2026-11-11 (6.0) | Edit the value; takes effect on the next request |
| `ALLOWED_GITHUB_USERS` | Secret | Since 6.0: who is **admin** when signing in with GitHub (older name for `ADMIN_GITHUB_USERS`, still honoured) | `RajaFarazTariq` | Phase 4 | Edit the value. Optional tidy-up: add `ADMIN_GITHUB_USERS` with the same value, then delete this one |
| `GITHUB_CLIENT_ID` | Secret | Identifies the app to GitHub for the admin backup login | GitHub → Settings → Developer settings → OAuth Apps → **VESPER AI** | Phase 4 | Copy again from the OAuth app page |
| `GITHUB_CLIENT_SECRET` | Secret | Server proof for finishing a GitHub sign-in | Same OAuth app → "Generate a new client secret" | Phase 4 | Generate a new secret there, save it here, delete the old one |
| `GROQ_API_KEY` | Secret | AI provider #1 (Groq free tier) | <https://console.groq.com/keys> | Phase 4 | Create a new key there, save it here, revoke the old key |
| `GEMINI_API_KEY` | Secret | AI provider #2 (Google Gemini free tier) | <https://aistudio.google.com/apikey> (Google AI Studio; keep it in a project **without billing**) | Phase 4 | Create a new key in AI Studio, save it here, delete the old key |
| `APP_NAME` | Plain text | Name shown in the app and used in the assistant's instructions | `VESPER` | Phase 4 | Edit the value |

### Supported but not set (optional)

| Name | What it would do | Default when not set |
|---|---|---|
| `ADMIN_GITHUB_USERS` | New name for the GitHub admin list (replaces `ALLOWED_GITHUB_USERS`) | Falls back to `ALLOWED_GITHUB_USERS` |
| `DEFAULT_DAILY_LIMIT` | Starting value for messages per user per day | `30` (the admin panel value wins once saved) |
| `OPENROUTER_API_KEY` | AI provider (OpenRouter, `:free` models only) | Provider skipped |
| `MISTRAL_API_KEY` | AI provider (Mistral free "Experiment" plan) | Provider skipped |
| `PROVIDER_ORDER` | Order of automatic provider fallback | `groq,gemini,openrouter,mistral,workers-ai` |
| `GROQ_MODEL`, `GEMINI_MODEL`, `OPENROUTER_MODEL`, `MISTRAL_MODEL`, `WORKERS_AI_MODEL`, `WORKERS_AI_MODELS` | Override default models | Built-in defaults / live model lists |
| `WORKERS_AI_ENABLED` | Turn Cloudflare's built-in models off | `true` |
| `MAX_CONTEXT_CHARS`, `MAX_OUTPUT_TOKENS` | Prompt/answer size | `16000`, `2048` |
| `CHAT_RATE_LIMIT_PER_MINUTE` | Per-user messages per minute | `20` |
| `SESSION_TTL_DAYS` | How long a sign-in lasts (renews while used) | `30` |
| `DEV_LOGIN`, `*_BASE_URL`, `*_OAUTH_*`, `GOOGLE_TOKEN_URL`, `GOOGLE_USERINFO_URL` | **Local development / tests only.** Never set in production | Off / real services |

The full list with comments is in [`.env.example`](../.env.example).

---

## 3. GitHub Actions secrets and variables (deployment)

Set in **GitHub → RajaFarazTariq/VESPER-AI → Settings → Secrets and variables → Actions**. Used only by
`.github/workflows/deploy.yml`.

| Name | Kind | What it does | Where it came from | How to replace |
|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | Lets GitHub Actions deploy the Worker and apply D1 migrations | Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" template **+ Account → D1 → Edit** | Create a new token with the same permissions, paste it here, delete the old token |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Which Cloudflare account to deploy to | Cloudflare → Workers & Pages → Overview (right side), or the dashboard URL | Not really secret; copy again |
| `D1_DATABASE_ID` | Variable | Which D1 database to use (written into `wrangler.jsonc` during the deploy) | `726f21f4-8ef4-40b5-86ea-3676f2545c84` (not secret) | Cloudflare → Storage & databases → D1 → ai-assistant |

---

## 4. Admin-panel settings (stored in the database, not in Cloudflare settings)

Changed in the app: **shield icon → Admin panel**. Stored in the D1 table `app_settings`; survive deploys.

| Setting | What it does | Default |
|---|---|---|
| Sign-ups open | When off, nobody new can create an account; existing users still sign in | On |
| Show the assistant's thinking notes to users | Off: users see only the answer (no "Reasoning" box). Tool use shows as one plain line ("Checked the date & time"); tool inputs/results and provider/model names are always hidden from users. Admins always see everything | Off |
| **Models** tab: models available to users | Users always have **Auto**; the admin adds up to 20 more, each with a friendly name (e.g. "Smart"). Users' model menu and Settings list only these; the server refuses any other model from a user. A user's saved default that is later removed becomes Auto | None (Auto only) |
| Messages per user per day | Daily limit for everyone without a personal limit. Admins unlimited (but counted). Resets 00:00 UTC (05:00 PKT) | 30 |
| Instructions for the assistant | Added to every user's conversations | Empty |
| Tools available to everyone | Tools switched off here are removed for all users | All on |
| Per-user (Users tab) | Personal daily limit, Block/Unblock, Delete (deletes their chats and memories too) | n/a |

---

## 5. External accounts and consoles

### Cloudflare (hosting, database)
- Account: the owner's Cloudflare login, **Free plan** (never upgrade to Workers Paid: the free plan can't bill).
- Worker: `ai-assistant`, workers.dev subdomain `vesper-ai` → <https://ai-assistant.vesper-ai.workers.dev>
- D1 database: `ai-assistant`, id `726f21f4-8ef4-40b5-86ea-3676f2545c84`. Backups: D1 → Time Travel (7 days), or
  `npx wrangler d1 export ai-assistant --remote --output backup.sql`.

### Google Cloud (Google sign-in), set up 2026-11-11
- Project **VESPER-AI**, id `gen-lang-client-0242499252` (originally created by Google AI Studio). **No billing**:
  never click "Start free" / "Try for free" (the $300 trial asks for a card).
- Google Auth Platform → **Branding**: app name `VESPER`, support/contact email = the owner's Gmail.
- **Audience**: *External*, publishing status **Testing**. Only emails under **Test users** can sign in (max 100).
  - Test users: `thisismefaraz@gmail.com` (admin), `FarazTariq7563@gmail.com` (regular tester account).
  - To let a new tester in: Audience → Test users → **+ Add users** → their Gmail → Save.
  - To open sign-in to everyone later: Audience → **Publish app** (basic scopes need no Google review).
- **Clients**: `VESPER web`, type *Web application*.
  - Authorized redirect URI: `https://ai-assistant.vesper-ai.workers.dev/api/auth/google/callback`
  - JavaScript origins: none. "AI-powered agent": unticked.
- **Data access** (scopes): only `openid email profile`, requested by the app at sign-in.

### GitHub OAuth app (admin backup sign-in), Phase 4
- GitHub → Settings → Developer settings → OAuth Apps → **VESPER AI**.
- Callback URL: `https://ai-assistant.vesper-ai.workers.dev/api/auth/github/callback`. No scopes requested.

### AI providers
- Groq (<https://console.groq.com>): free plan, no payment method.
- Google AI Studio (<https://aistudio.google.com>): Gemini key in a project without billing.

---

## 6. Local office-PC items (temporary)

| Item | Where | Note |
|---|---|---|
| GitHub fine-grained access token (VESPER-AI repo only) | **Not stored on the PC.** The owner keeps it elsewhere and supplies it at push time: `git -c credential.helper= push https://<TOKEN>@github.com/RajaFarazTariq/VESPER-AI.git main` (the `-c credential.helper=` part stops Windows' Git Credential Manager from silently saving the token) | Since 2026-11-11 the `origin` URL is plain `https://github.com/RajaFarazTariq/VESPER-AI.git` (token removed). If Git Credential Manager ever offers to save it, decline; check Windows Credential Manager for a `git:https://github.com` entry. When the project is done, delete the token on GitHub (Settings → Developer settings → Fine-grained tokens) |
| Local test data | `.wrangler/` in the project folder (git-ignored) | Safe to delete |

---

## 7. Setup log by stage

| Date | Stage | What was set up / changed |
|---|---|---|
| 2026-11-10 | Phase 4: core chat | Repo created; Cloudflare account, Worker `ai-assistant`, D1 `ai-assistant`; GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) + variable (`D1_DATABASE_ID`); GitHub OAuth app "VESPER AI"; Worker secrets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `APP_NAME`. Migration `0001_initial.sql` |
| 2026-11-10 | Phase 5: tools + memory | Migration `0002_tools_and_memory.sql`. No new settings |
| 2026-11-10 | Math rendering fix | No new settings |
| 2026-11-11 | **Phase 6.0: multi-user + admin** | Google Cloud project VESPER-AI: Google Auth Platform configured (External, Testing), test users added, client "VESPER web" created. Worker secrets added: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, text `ADMIN_EMAILS`. Migration `0003_multi_user.sql` (add-only: new user columns, `app_settings`, `user_usage_daily`). New data-safety test guards every future migration. `ALLOWED_GITHUB_USERS` kept and now means "GitHub admins". Deployed as v0.6.0 (commit `41a770b`); live-checked: Google admin sign-in linked to the existing account, admin panel |
| 2026-11-11 | **Phase 6.1: clean replies, model list, time zone** | No new Cloudflare/Google settings and no database migration. New admin-panel settings (stored in `app_settings`): "Show thinking notes to users" (default off) and the **Models** tab list (default empty = Auto only). The browser now sends its time zone name with each message (not stored). UI fixes: admin/settings tab bar no longer squashed; subtle keyboard focus ring |

---

## 8. Rules

- Never commit a secret value. `.env`, `.dev.vars` and `.env.*` (except `.env.example`) are git-ignored.
- Database migrations only **add** (columns, tables, indexes); see the data-safety rule in [HANDOFF.md](HANDOFF.md).
- When you add or change a setting anywhere above, add a row to section 2/3/4/5 and a line to the log in section 7.
