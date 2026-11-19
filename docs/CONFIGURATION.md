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

### To add for v0.7.0 (live information)

| Name | Type | What it does | Where it comes from | How to replace |
|---|---|---|---|---|
| `TAVILY_API_KEY` | Secret | Turns on **web search** for the assistant. Without it, web search is simply not offered (weather, Wikipedia, currency and page reading still work: they need no key) | <https://app.tavily.com> → API keys (free "Researcher" plan: 1,000 credits/month, no card; a basic search = 1 credit) | Create a new key in Tavily, save it here, delete the old key |

### Supported but not set (optional)

| Name | What it would do | Default when not set |
|---|---|---|
| `ADMIN_GITHUB_USERS` | New name for the GitHub admin list (replaces `ALLOWED_GITHUB_USERS`) | Falls back to `ALLOWED_GITHUB_USERS` |
| `DEFAULT_DAILY_LIMIT` | Starting value for messages per user per day | `30` (the admin panel value wins once saved) |
| `OPENROUTER_API_KEY` | AI provider (OpenRouter, `:free` models only). **Key "VESPER AI" created 2026-11-19** (90 days, expires **2027-02-17**, credit limit set to the minimum, account balance $0). **Set as a Cloudflare Secret on 2026-11-19**; confirmed live: Admin panel → Providers shows "Configured", default model `google/gemma-4-26b-a4b-it:free` | Provider skipped |
| `MISTRAL_API_KEY` | AI provider (Mistral). **Skipped by the owner on 2026-11-19:** Mistral's console now says the Free plan must be upgraded before keys can be created | Provider skipped |
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
| Web searches per day (whole app) | Shared daily allowance for web search (all users, admins included), so Tavily's free 1,000/month can't run out. Shows "Used today: X of Y". 0 = web search off. Resets 00:00 UTC | 30 |
| **Models** tab: models available to users | Users always have **Auto**; the admin adds up to 20 more, each with a friendly name (e.g. "Smart"). Users' model menu and Settings list only these; the server refuses any other model from a user. A user's saved default that is later removed becomes Auto | None (Auto only) |
| Messages per user per day | Daily limit for everyone without a personal limit. Admins unlimited (but counted). Resets 00:00 UTC (05:00 PKT) | 30 |
| Instructions for the assistant | Added to every user's conversations | Empty |
| Trusted websites (v0.9.3) | One per line (e.g. `who.int`; subdomains included). Web search ranks them first and labels them "trusted". Government sites (.gov, gov.pk, .int…) and the organisation's own site are already ranked first without being listed | Empty |
| Blocked websites (v0.9.3) | One per line. Never used: Tavily is asked to skip them and any that still come back are removed | Empty |
| Image attachments (v0.9.6) | 📎 button, paste and drag-and-drop in the message box (up to 3 per message). Images go only to models that can see them (Gemini, then a free OpenRouter vision model); only a ~20 KB preview is kept with the chat. The button shows only when this is on **and** Gemini or OpenRouter is configured | On |
| Images per user per day (v0.9.6) | Daily image limit for every user (admins unlimited but counted; shown in Users). 0 = images paused for users. Resets 00:00 UTC | 10 |
| Voice (v0.9.6) | 🎤 microphone button (speech → text in the box, checked before sending; Groq Whisper, Workers AI Whisper as backup) and 🔊 "Read aloud" on answers (the device's own voices, no server cost). The mic shows only when Groq or Workers AI is available | On |
| Minutes of speech per user per day (v0.9.6) | Daily voice-input limit for every user (admins unlimited but counted). 0 = voice input paused for users. Resets 00:00 UTC | 15 |
| Tools available to everyone | Tools switched off here are removed for all users | All on |
| Per-user (Users tab) | Personal daily limit, Block/Unblock, Delete (deletes their chats and memories too). Shows today's messages, images and minutes of voice | n/a |
| Local models (Ollama) for users (v0.9.10) | Lets regular users run open models on their own computer with the Ollama app (Settings → Local models). Off: the tab is hidden for users, their local-model setting is ignored, and the server refuses their local chats. Admins can always use local models | Off |
| Deep research (v0.9.8) | Research button in the message box: 2–4 planned web searches, up to 3 pages read, a written brief with an app-made Sources list (published/checked dates). 2 model requests per run. Shown only when on **and** web search is available (Tavily key, web_search not switched off, daily cap above the searches kept for chat) | On |
| Research runs per user per day (v0.9.8) | Finished runs per user per UTC day (admins unlimited but counted; shown in Users). Failed or stopped runs don't count. 0 = paused for users | 3 |
| Web searches kept for normal chat (v0.9.8) | Research can't use the last N of the day's web searches. Research gets "Web searches per day" minus this (default 30 − 10 = 20, about 5–10 runs a day for the whole app). The panel warns when fewer than 2 are left for research | 10 |
| Check this answer (v0.11.0) | "Check" button under answers that used sources (web, documents, weather, currency, research): 1 more model request lists the answer's key claims and rates each Supported / Contradicted / Not in the sources, with the source. Other providers are tried before Groq. Each answer is checked once; the result is saved with it | On |
| Answer checks per user per day (v0.11.0) | Checks per user per UTC day (admins unlimited but counted; shown in Users). Failed checks don't count. 0 = paused for users | 10 |
| Check research reports automatically (v0.11.0) | Every finished deep-research report is checked the same way right after it's written (1 more model request per run; doesn't use the user's daily checks) | On |
| **Feedback** tab (v0.9.7) | Read-only list of 👍/👎 on answers (Bad answers first) with Good/Bad counts per model; each entry shows the user, date, model, reason, note, question, answer and sources. Nothing to configure | n/a |
| Per-user (each user's Settings → **Voice** tab, v0.9.6) | "Language you speak" (Detect automatically / English / Urdu) and "Read answers aloud automatically" (default off). Shown only when Voice is on | n/a |

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

### Images and voice (v0.9.6; free terms checked 2026-11-19)
| Service | Used for | Key | Free terms / notes |
|---|---|---|---|
| Google Gemini (existing key) | Image questions (first choice) | `GEMINI_API_KEY` | Same free tier as chat. On the free tier Google may use uploaded images to improve its products |
| OpenRouter (existing key) | Image questions (backup): a `:free` model whose model list says it accepts images | `OPENROUTER_API_KEY` | Same free limits as chat (50 requests/day). Picked from the live list (Gemma, Qwen-VL, Llama 4, Mistral Small preferred) |
| Groq Whisper `whisper-large-v3-turbo` (existing key) | Microphone: speech → text | `GROQ_API_KEY` | Free plan: 20 requests/min, 2,000/day, 28,800 audio seconds/day (8 hours) for the whole app; each request counts as at least 10 s; 25 MB per file. Recordings are processed by Groq and not stored by VESPER |
| Cloudflare Workers AI `@cf/openai/whisper-large-v3-turbo` | Microphone backup when Groq fails | none (`AI` binding) | Shares the 10,000 free neurons/day (~46 per audio minute). Not used when `WORKERS_AI_ENABLED=false` |
| The device's own voices (Web Speech API) | 🔊 Read aloud | none | Runs in the browser; nothing is sent anywhere. Urdu needs an Urdu voice installed on the device |

### Live-information services (v0.7.0; free terms checked 2026-11-11)
| Service | Used for | Key | Free terms / notes |
|---|---|---|---|
| Tavily (<https://tavily.com>) | `web_search` | `TAVILY_API_KEY` | 1,000 credits/month, no card; basic search = 1 credit. Capped by "Web searches per day" (default 30) |
| Direct fetch + Cloudflare HTMLRewriter | `read_page` | none | No third party. Only public http(s) pages; private/local addresses refused (every redirect re-checked); PDFs not supported |
| Open-Meteo (<https://open-meteo.com>) | `weather` (geocoding + forecast) | none | Free for **non-commercial** use (10,000 calls/day); attribution required (CC BY 4.0), shown as a source. Commercial/public launch would need their paid plan |
| Wikipedia (MediaWiki API + REST summary) | `wikipedia` | none | Free; requests identify the app with a User-Agent, as Wikimedia asks |
| Frankfurter (<https://frankfurter.dev>) | `currency` | none | Free, no quotas; central-bank reference rates (`api.frankfurter.dev/v2`) |
| Jina Reader | not used | — | Considered and dropped: keyless limit is 20 requests/minute **per IP**, and Cloudflare Workers share outgoing IPs |

---

## 6. Local office-PC items (temporary)

| Item | Where | Note |
|---|---|---|
| GitHub fine-grained access token (VESPER-AI repo only) | **Not stored on the PC.** The owner keeps it elsewhere and supplies it at push time: `git -c credential.helper= push https://<TOKEN>@github.com/RajaFarazTariq/VESPER-AI.git main` (the `-c credential.helper=` part stops Windows' Git Credential Manager from silently saving the token) | Since 2026-11-11 the `origin` URL is plain `https://github.com/RajaFarazTariq/VESPER-AI.git` (token removed). If Git Credential Manager ever offers to save it, decline; check Windows Credential Manager for a `git:https://github.com` entry. When the project is done, delete the token on GitHub (Settings → Developer settings → Fine-grained tokens) |
| Local test data | `.wrangler/` in the project folder (git-ignored) | Safe to delete |
| Local settings for `npm run dev` | `.dev.vars` in the project folder (git-ignored, created 2026-11-17) | Username login on localhost (`admin` = admin) and empty lines for the owner's own AI/Tavily keys, pasted by him, never via chat. Delete it when local testing is done so no keys stay on the PC |

---

## 7. Setup log by stage

| Date | Stage | What was set up / changed |
|---|---|---|
| 2026-11-10 | Phase 4: core chat | Repo created; Cloudflare account, Worker `ai-assistant`, D1 `ai-assistant`; GitHub Actions secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) + variable (`D1_DATABASE_ID`); GitHub OAuth app "VESPER AI"; Worker secrets `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `APP_NAME`. Migration `0001_initial.sql` |
| 2026-11-10 | Phase 5: tools + memory | Migration `0002_tools_and_memory.sql`. No new settings |
| 2026-11-10 | Math rendering fix | No new settings |
| 2026-11-11 | **Phase 6.0: multi-user + admin** | Google Cloud project VESPER-AI: Google Auth Platform configured (External, Testing), test users added, client "VESPER web" created. Worker secrets added: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, text `ADMIN_EMAILS`. Migration `0003_multi_user.sql` (add-only: new user columns, `app_settings`, `user_usage_daily`). New data-safety test guards every future migration. `ALLOWED_GITHUB_USERS` kept and now means "GitHub admins". Deployed as v0.6.0 (commit `41a770b`); live-checked: Google admin sign-in linked to the existing account, admin panel |
| 2026-11-11 | **Phase 6.1: clean replies, model list, time zone** | No new Cloudflare/Google settings and no database migration. New admin-panel settings (stored in `app_settings`): "Show thinking notes to users" (default off) and the **Models** tab list (default empty = Auto only). The browser now sends its time zone name with each message (not stored). UI fixes: admin/settings tab bar no longer squashed; subtle keyboard focus ring. Deployed as v0.6.1 (commit `b41e514`); live-checked: local date, memory, tester clean view, usage counting |
| 2026-11-11 | **Phase 6a: live information** | New tools: web search (Tavily), read a page, weather (Open-Meteo), Wikipedia, currency (Frankfurter); answers show source links. New Cloudflare secret to add: `TAVILY_API_KEY`. New admin setting: "Web searches per day" (default 30). No database migration (the daily search counter uses the existing `rate_limits` table). Deployed as v0.7.0 (commit `758f0b0`) |
| 2026-11-11 | **UI redesign (v0.8.0)** | No new settings, secrets or migrations. New look (design tokens in `styles.css`, new logo), sidebar search/collapse/account menu, welcome screen, composer with model picker and Tools button, Edit last message (`edit` flag on `/api/chat`). The browser remembers the collapsed sidebar in localStorage (`vesper-sidebar-collapsed`). Deployed as v0.8.0 (commit `940b218`) |
| 2026-11-17 | **Knowledge base (v0.9.0)** | No new Cloudflare settings, secrets or bindings (re-ranking uses the existing `AI` binding). Migration `0004_knowledge_base.sql` (add-only: `kb_collections`, `kb_documents`, `kb_chunks`, FTS5 table `kb_chunks_fts` + triggers). New admin-panel tab **Knowledge** (folders, upload, add web page, space meter); new tool `search_knowledge` (admins can switch it off for everyone in App settings). New dev dependencies `pdfjs-dist` 6.5.438 and `mammoth` 1.13.0 (browser only, lazy-loaded). Also fixed: the model menu no longer runs off the top of the screen |
| 2026-11-19 | **Knowledge base fixes (v0.9.1)** | No new settings, secrets or migrations. After the first live test: a model that sends only thinking notes and no answer now falls back to the next free provider; the composer's Tools menu refreshes when the admin panel closes; an empty knowledge base shows 0 pages used; stronger "search the documents" instruction. Live test data added through the admin panel: folder "AI in Software Engineering" with one 23-page PDF. Deployed as v0.9.1 (commit `f48b00e`) |
| 2026-11-19 | **Documents + web together (v0.9.2)** | No new settings, secrets or migrations. Web look-ups also search the knowledge base (same query, in parallel); source rules for conflicts (original source first, newest wins for changing facts, documents win for their own content and the admin's rules, disagreements shown). Under answers only cited document pages are listed; 【 】 citations shown as ( ). Uses a few more web searches (still capped by the admin's "Web searches per day") |
| 2026-11-19 | **Trusted sources (v0.9.3)** | No new Cloudflare settings, secrets or migrations. Two new admin-panel settings (stored in `app_settings`): **Trusted websites** and **Blocked websites**. Web search asks for 8 results (still 1 search) and gives the best 6, labelled by source type with dates; no hard date filter. Source rules R1–R7 in the system prompt; admin-only number check under answers. New `npm run accuracy` script + `tests/accuracy/questions.json` (needs real keys in `.dev.vars`, runs locally only). Tests now ignore keys in `.dev.vars` (`vitest.config.ts`) |
| 2026-11-19 | **Source fixes (v0.9.4)** | No new settings, secrets or migrations. After the live re-test (the Copilot answer called the PDF's 62% "GitHub's report"): the server reads an organisation's own page when its search snippet has no figure (2–3 short passages, no extra search); document passages that quote an organisation are labelled "your document (quoting X)" + rule R3b; document citations are never links; "Note:" lines only for real disagreements; Groq waits once when its rate-limit wait is 10 s or less, otherwise falls back at once. OpenRouter key added as a Cloudflare secret the same day |
| 2026-11-19 | **Fewer tokens (v0.9.5)** | No new settings or secrets. **Migration `0005_search_cache.sql`** (add-only: new table `search_cache`, public search results only, expires after 1 h for "latest" questions / 6 h otherwise; the daily cron deletes expired rows). Questions that clearly need a look-up are searched first so the model answers in one request (fits Groq's 8,000 tokens/min); shorter snippets (450) and passages (800); the paired document search keeps only passages about the question; dates read from snippet text; at most 2 "other website" results when an official one has the figure; quoting passages carry a warning in their text; one extra search limited to the organisation's own sites when an "According to X" question gets none of X's pages |
| 2026-11-19 | **Images + voice (v0.9.6)** | No new Cloudflare settings, secrets or bindings (uses the existing Gemini/OpenRouter/Groq keys and the `AI` binding). **Migration `0006_images_voice.sql`** (add-only: `messages.images` for ~20 KB previews; `user_usage_daily.images` and `.speech_seconds` counters). Four new admin-panel settings: Image attachments (on), Images per user per day (10), Voice (on), Minutes of speech per user per day (15). Two new per-user settings (Settings → Voice): speech language, read answers aloud automatically. `public/_headers`: `Permissions-Policy` now allows the microphone for VESPER's own pages (`microphone=(self)`). `/api/chat` accepts bodies up to 4 MB (other routes keep 256 KB); new endpoints `GET /api/media/features`, `POST /api/media/transcribe`. The offline mock (`npm run mock:llm`) answers speech-to-text too |
| 2026-11-20 | **Answer verification (v0.11.0)** | No secrets or bindings (uses the existing AI providers). **Migration `0010_answer_verification.sql`** (add-only, revert-safe: `messages.evidence` and `messages.verification` NULL-able; `user_usage_daily.answer_checks` DEFAULT 0). Answers that used sources keep a copy of what the sources said (≤ 20,000 characters, never sent to the browser). Three new admin-panel settings: **Check this answer** (on), **Answer checks per user per day** (10, admins unlimited), **Check research reports automatically** (on). Each check is 1 model request (other providers before Groq). The admin-only number check no longer flags general-knowledge numbers. New endpoint `POST /api/answer-check/:messageId` |
| 2026-11-20 | **Table display fix (v0.10.1)** | No settings, secrets or migrations. A `<br>` a model writes inside a table now shows as a line break (other HTML still shows as text); table columns no longer break words mid-word |
| 2026-11-20 | **Smarter memory (v0.10.0)** | No new settings, secrets or bindings. **Migration `0009_smarter_memory.sql`** (add-only, revert-safe: `memories.pinned` DEFAULT 0, `memories.updated_at`, `conversations.summary`, `conversations.summary_until`, all NULL-able or defaulted). Each message gets only pinned + related memories; Settings → Memory gets pin, edit and export; passwords, card/bank numbers, ID card numbers and phone numbers are refused; long chats are summarised once (1 model request) into notes kept on the conversation. New endpoint `PATCH /api/memories/:id` |
| 2026-11-20 | **Menu fix + local models for users (v0.9.10)** | No secrets or migrations. New admin-panel setting **Local models (Ollama) for users** (default off): when off, users don't see Settings → Local models, can't pick `ollama:` models and the server refuses their local chats; admins always can. The composer's Tools menu no longer runs off the top of the screen |
| 2026-11-20 | **Research sources tidy-up (v0.9.9)** | No new settings, secrets or migrations. Research briefs cite sources as [S1]… which become links; the Sources list and the chips under the answer show only cited sources (renumbered to match); the admin-only number check accepts simple calculations from two figures the answer states and the sources support |
| 2026-11-19 | **Deep research + dark default (v0.9.8)** | No new secrets or bindings (uses the existing Tavily key and AI providers). **Migration `0008_deep_research.sql`** (add-only, revert-safe: `user_usage_daily.research_runs` DEFAULT 0; `search_cache.checked_at` NULL-able). Three new admin-panel settings: Deep research (on), Research runs per user per day (3), Web searches kept for normal chat (10). `/api/chat` accepts `research: true`; research searches are set aside on the shared `tool:web_search` counter and unused ones given back. Saved web searches now show the date they were first made (normal chat too). **Dark theme is the default** for anyone who hasn't picked a theme (browser setting, nothing stored on the server). First release delivered on a branch + pull request |
| 2026-11-19 | **Answer feedback (v0.9.7)** | No new settings, secrets or bindings. **Migration `0007_message_feedback.sql`** (add-only: table `message_feedback`, one row per rated answer with its own copy of the question, answer, model and sources; removed when the chat or user is deleted). 👍/👎 under answers with an optional reason and note; new admin-panel tab **Feedback**. New endpoints `PUT /api/feedback/:messageId`, `GET /api/admin/feedback` |
| 2026-11-17 | **Sign-in page redesign (v0.8.1)** | No new settings, secrets or migrations. Professional split layout: sign-in form on the left (follows the app theme), dark brand panel on wide screens (logo in orbit lines, headline). The third-party-AI notice was removed from the sign-in page at the owner's request. Local-dev fix: `vite.config.ts` no longer proxies the app's own `/api/*.ts` source files to the Worker (that left `npm run dev` on a blank page) |

---

## 8. Rules

- Never commit a secret value. `.env`, `.dev.vars` and `.env.*` (except `.env.example`) are git-ignored.
- Database migrations only **add** (columns, tables, indexes); see the data-safety rule in [HANDOFF.md](HANDOFF.md).
- When you add or change a setting anywhere above, add a row to section 2/3/4/5 and a line to the log in section 7.
