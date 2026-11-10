# Deployment guide (free)

This puts the assistant online at `https://ai-assistant.<your-subdomain>.workers.dev`, owned by your GitHub and
Cloudflare accounts. Nothing depends on the computer you build it on.

Total cost: **$0**. No credit card is required by Cloudflare, GitHub, Groq, Google AI Studio or OpenRouter.
Time: about 30–45 minutes the first time.

---

## Step 1: Push the code to your GitHub

1. Create an **empty** repository at <https://github.com/new>. Public or private both work: Actions minutes are
   unlimited for public repos and 2,000 min/month free for private ones; a deploy uses about 2–3 minutes.
   Don't add a README or .gitignore there.
2. In the project folder:

   ```bash
   git init
   git add .
   git commit -m "Initial commit: AI assistant (phase 4)"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git push -u origin main
   ```

3. Check that `.env`, `.dev.vars`, `node_modules/`, `dist/` and `.wrangler/` were **not** pushed (they're in
   `.gitignore`). Only `.env.example` should be there.

The **CI** workflow runs automatically. The **Deploy** workflow is skipped until Step 3 is done.

## Step 2: Cloudflare account, database and API token

1. Sign up at <https://dash.cloudflare.com/sign-up> (Free plan, no card).
2. Open **Workers & Pages** once. Cloudflare asks you to pick your free `*.workers.dev` subdomain.
3. **Create the database:** **Storage & Databases → D1 SQL Database → Create**. Name it `ai-assistant` and choose
   any location. Copy the **Database ID** (a UUID).
4. **Find your Account ID:** it's on the right side of **Workers & Pages → Overview** (or in the URL
   `dash.cloudflare.com/<account-id>/...`).
5. **Create an API token for GitHub Actions:** **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"
   template**. Under *Permissions* click **+ Add more** and add **Account → D1 → Edit**. Under *Account Resources*
   pick your account. Create it and copy the token (it is shown once).

## Step 3: Connect GitHub to Cloudflare

In your GitHub repo: **Settings → Secrets and variables → Actions**.

- **Secrets** tab → *New repository secret*:
  - `CLOUDFLARE_API_TOKEN` = the token from Step 2.5
  - `CLOUDFLARE_ACCOUNT_ID` = your account ID
- **Variables** tab → *New repository variable*:
  - `D1_DATABASE_ID` = the database ID from Step 2.3

Now go to **Actions → Deploy to Cloudflare → Run workflow** (or push any commit to `main`). The workflow runs
the tests, creates the database tables, and deploys. When it finishes, the log shows your URL, e.g.
`https://ai-assistant.<subdomain>.workers.dev`. Open `/api/health` on it; you should see `{"ok":true,...}`.

> The Worker name (`ai-assistant`) comes from `wrangler.jsonc`. Change `"name"` there if you want a different URL.

## Step 4: GitHub sign-in (OAuth app)

1. Go to <https://github.com/settings/developers> → **OAuth Apps → New OAuth App**.
   - Application name: anything (e.g. "My Assistant")
   - Homepage URL: `https://ai-assistant.<subdomain>.workers.dev`
   - Authorization callback URL: `https://ai-assistant.<subdomain>.workers.dev/api/auth/github/callback`
2. Register it, copy the **Client ID**, then **Generate a new client secret** and copy it.

The app requests no GitHub permissions (scopes). It only reads your public profile to know who you are.
GitHub sign-in is accepted **only for administrators** (`ADMIN_GITHUB_USERS`); everyone else uses Google.

## Step 4b: Google sign-in (for everyone)

Free; no billing account is needed. Google renames menus now and then, so look for the closest match.

1. Open <https://console.cloud.google.com/> and create a new project (e.g. "VESPER AI"). Don't enable billing.
2. Open **Google Auth Platform** (or **APIs & Services → OAuth consent screen**) → **Get started**: app name, your
   support email, audience **External**, your contact email → **Create**.
3. **Audience → Test users → Add users**: add your own Gmail and each tester's Gmail. While the app is in
   **Testing**, only these addresses can sign in (up to 100).
4. **Clients → Create client** → type **Web application**. Under *Authorized redirect URIs* add exactly
   `https://ai-assistant.<subdomain>.workers.dev/api/auth/google/callback` → **Create**.
5. Copy the **Client ID** and **Client secret**.

The app asks only for `openid email profile` (name, photo, verified email). These basic scopes don't need Google's
app review. To open sign-in to everyone later, press **Publish app** under *Audience*.

## Step 5: Free AI API keys

Get at least one; two or more make automatic fallback useful.

| Provider | Where | Keep it free by… |
|---|---|---|
| **Groq** (recommended) | <https://console.groq.com/keys> | Staying on the Free plan. Never add a payment method. |
| **Google Gemini** (recommended) | <https://aistudio.google.com/apikey> | Creating the key in a project **without billing**. If AI Studio shows a "Paid" tier for the key, make a new project. |
| **OpenRouter** | <https://openrouter.ai/settings/keys> | Nothing needed: the app only calls `:free` models. Don't buy credits unless you want 1,000 instead of 50 free requests/day. |
| **Mistral** | <https://console.mistral.ai/api-keys> | Choosing the free **Experiment** plan (phone verification). |
| **Cloudflare Workers AI** | built in | Nothing: it's on by default and capped at the free 10,000 neurons/day. |

## Step 6: Add the secrets to Cloudflare

**Workers & Pages → ai-assistant → Settings → Variables and Secrets → + Add**. Use type **Secret** for each:

| Name | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from Step 4b |
| `GOOGLE_CLIENT_SECRET` | from Step 4b |
| `ADMIN_EMAILS` | your Google email (comma-separate several admins) |
| `GITHUB_CLIENT_ID` | from Step 4 |
| `GITHUB_CLIENT_SECRET` | from Step 4 |
| `ADMIN_GITHUB_USERS` | your GitHub username (older setups: `ALLOWED_GITHUB_USERS` still works) |
| `GROQ_API_KEY` | from Step 5 |
| `GEMINI_API_KEY` | from Step 5 |
| `OPENROUTER_API_KEY` | optional |
| `MISTRAL_API_KEY` | optional |

Click **Deploy** if the dashboard asks. Changes apply within seconds; no rebuild is needed. Later deployments from
GitHub keep these values (`keep_vars` is set in `wrangler.jsonc`).

CLI alternative: `npx wrangler login` and then `npx wrangler secret put GROQ_API_KEY` (and so on).

## Step 7: Use it

Open `https://ai-assistant.<subdomain>.workers.dev`, click **Continue with Google**, and chat. As an administrator you
get the **shield icon** next to Settings: the admin panel (users, block, daily limits, sign-ups open/closed,
instructions for the assistant, tools, and provider status with today's usage and cooldowns).

## Step 8: Remove the project from this computer (optional)

Once Step 7 works, everything lives in GitHub (code) and Cloudflare (app, database, secrets). You can delete the local
folder. To work on it again elsewhere: `git clone`, `npm install`, `cp .env.example .env`, `npm run dev`.

---

## Updating

Push to `main`. The Deploy workflow tests, migrates (new files in `migrations/`) and redeploys. If tests fail,
nothing is deployed. The tests include a data-safety check (`tests/migrations.test.ts`) that fails if a database
change would lose any user's chats, sessions or memories.

## Manual deploy (without GitHub Actions)

```bash
npx wrangler login
npx wrangler d1 create ai-assistant      # paste the printed database_id into wrangler.jsonc
npm run deploy                           # build + remote migrations + deploy
npx wrangler secret put GITHUB_CLIENT_ID # ...and the other secrets from Step 6
```

## Backups

Export the database anytime (free): `npx wrangler d1 export ai-assistant --remote --output backup.sql`.
D1 also offers point-in-time recovery (**D1 → your database → Time Travel**; 7 days on the Free plan).

## Limits to know about

- **Cloudflare Workers Free:** 100,000 requests/day. One chat message is about 1–3 requests. A
  reply that is still streaming keeps going for as long as you're connected.
- **D1 Free:** 100,000 row writes/day. A chat turn writes about 6–10 rows, so roughly 10,000+ messages a day.
- **Provider limits** are the real ceiling (e.g. Groq ~1,000 requests/day, OpenRouter 50/day). Auto mode spreads the
  load across every configured provider.
- All Cloudflare limits **fail closed** (errors until the daily reset), never charges, as long as the account stays
  on the Free plan.
