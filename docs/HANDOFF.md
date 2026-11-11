# VESPER: handoff notes for a new working session

Read this first when resuming work. Last updated: **2026-11-11**. No secrets are stored here.

## 1. What this is
**VESPER** is the owner's ChatGPT-style AI assistant. Since v0.6.0 it's **multi-user**: anyone can sign up with
Google and chat; the owner is the **admin** and manages everything (users, limits, features) from the admin panel.
Currently in the **testing stage** with a few testers. It runs entirely on **free tiers** (strict zero-cost
requirement: no paid services, no card on file, no paid fallback).

| Item | Value |
|---|---|
| Owner | Raja Faraz Tariq (GitHub **RajaFarazTariq**). Personal project, not office work |
| Repo | https://github.com/RajaFarazTariq/VESPER-AI (private, branch `main`) |
| Live app | https://ai-assistant.vesper-ai.workers.dev |
| Health check | https://ai-assistant.vesper-ai.workers.dev/api/health (expects `version` 0.7.0+) |
| Cloudflare | Free plan. Worker name `ai-assistant`, workers.dev subdomain `vesper-ai` |
| D1 database | `ai-assistant`, id `726f21f4-8ef4-40b5-86ea-3676f2545c84` (not secret) |
| Sign-in (everyone) | Google OAuth client, callback `https://ai-assistant.vesper-ai.workers.dev/api/auth/google/callback` (Google app in *Testing* mode: only listed test users can sign in) |
| Sign-in (admin backup) | GitHub OAuth app "VESPER AI", callback `https://ai-assistant.vesper-ai.workers.dev/api/auth/github/callback` |

## 2. How the owner wants to work
- **The owner runs all git commands himself** (commit/push). Never push or commit on his behalf; give him the exact
  commands. The GitHub token is **not stored** anywhere on the PC (removed from the `origin` URL on 2026-11-11);
  he keeps it elsewhere and pastes it into the push command himself, so give push commands with a `<TOKEN>`
  placeholder (see docs/CONFIGURATION.md §6). Never ask him to paste it into the chat.
- Wants **step-by-step, one step at a time** instructions for anything he does in a dashboard.
- Explain in plain words; he's not deep in this stack.
- Deploys happen automatically: a push to `main` triggers GitHub Actions → tests → D1 migrations → `wrangler deploy`.
- An untracked `AI_Assistant_Feature_Roadmap.pdf` in his local folder is **his** file. Don't add it to git unless he asks.

## 3. Architecture (short)
- **Cloudflare Worker (TypeScript, Hono)** serves `/api/*`; the **React + Vite + Tailwind** SPA is served as static assets
  from `dist/`. **D1 (SQLite)** stores everything. Cloudflare's Free plan returns errors at its limits; it never bills.
- **LLM providers** (all free tiers, OpenAI-compatible except Workers AI): Groq → Gemini → OpenRouter (`:free` models
  only, enforced) → Mistral → Workers AI (binding). `PROVIDER_ORDER` controls auto fallback.
- **Router** (`src/worker/llm/router.ts`): plans auto/manual routes and retries transient errors once. Rate-limit and quota
  errors fall back to the next provider, with cooldowns stored in D1 (`provider_state`) and usage in `usage_daily`.
- **Agent loop** (`src/worker/llm/agent.ts`): model → tools → model, max 5 rounds; the last round offers no tools.
- **Tools** (`src/worker/tools/`): `calculator` (own safe parser), `current_datetime`, `remember`, `forget`, and since
  v0.7.0 the live-information tools in `web.ts`: `web_search` (Tavily, needs `TAVILY_API_KEY`, capped per day),
  `read_page` (direct fetch + HTMLRewriter), `weather` (Open-Meteo), `wikipedia`, `currency` (Frankfurter).
  Outbound requests go through `net.ts` (timeouts, size caps, User-Agent, public-URL check on every redirect hop);
  web text is wrapped as untrusted. Tools return `sources`, shown as links under answers (to users too).
  Shared tool types are in `types.ts` (keeps registry ↔ tool files free of circular imports). Risk levels: `read` / `write` (own data).
- **Memory**: `memories` table, injected into the system prompt; managed in Settings → Memory.
- **Auth**: Google OAuth for everyone (open sign-up; admin can close sign-ups), GitHub OAuth for admins only. Admin role
  = verified email in `ADMIN_EMAILS` or GitHub username in `ADMIN_GITHUB_USERS` (falls back to the old
  `ALLOWED_GITHUB_USERS`), re-derived on every request. Google and GitHub link to the same account for the admin.
  Blocked users are refused on every request. Opaque session tokens, stored as hashes. `DEV_LOGIN=true` gives a
  username-only login (any name; admin names become admin), and only on localhost.
- **Admin panel** (`src/web/components/AdminDialog.tsx`, API `src/worker/routes/admin.ts`): users (block/unblock,
  per-user daily limit, delete), app settings stored in D1 `app_settings` (sign-ups open, default daily limit,
  instructions added to every system prompt, tools disabled for everyone, show thinking notes to users), **Models**
  (which models users may pick, with friendly names), provider status.
- **Clean replies for users** (`src/worker/lib/present.ts`): what each viewer is sent. Admin: everything. Users: no
  reasoning (unless the admin switch is on), tool names only (no inputs/results), no provider/model, no
  provider-switch notices. Stored data is untouched. Local (Ollama) replies are shown as they are.
- **Model list for users**: `userModels` in `app_settings`; enforced in `/api/chat` (403 `model_not_allowed`),
  `/api/settings` and `/api/models` (users get only their list); a stale saved default becomes Auto.
- **Time zone**: the browser sends `timeZone` (IANA) with each chat request; validated with `normalizeTimeZone`, used in
  the system prompt ("user's current local date and time") and as the date tool's default. Not stored.
- **Daily limit**: `user_usage_daily` counts messages per user per UTC day (atomic check-and-count before anything is
  written). Default 30; admins unlimited; local Ollama chats don't count.
- Full design: `docs/ARCHITECTURE.md`. Deployment guide: `docs/DEPLOYMENT.md`.

## 4. Configuration (names only; values live in Cloudflare → Worker → Settings → Variables and Secrets)
Set: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS` (= RajaFarazTariq), `GROQ_API_KEY`,
`GEMINI_API_KEY`, `APP_NAME` (= VESPER). Not set yet: `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`.
Added 2026-11-11 for v0.6.0: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (secrets), `ADMIN_EMAILS` (text, the owner's
Gmail). `ALLOWED_GITHUB_USERS` still keeps him admin on GitHub sign-in (optional rename to `ADMIN_GITHUB_USERS`).
**Full register of every setting, secret, account and console, with a setup log per stage:
[`docs/CONFIGURATION.md`](CONFIGURATION.md). Keep it updated whenever anything is added or changed.**
GitHub repo has Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and variable `D1_DATABASE_ID`.
`wrangler.jsonc` has `keep_vars: true`, so deploys don't wipe dashboard variables.

## 5. Status
| Phase | State |
|---|---|
| 1–3 Research & architecture | ✅ |
| 4 Core chat (streaming, history, auth, multi-provider fallback, UI) | ✅ live |
| 5 Agent loop + tools + long-term memory + Tools/Memory settings | ✅ live (v0.5.0) |
| Fix: tool task switching provider mid-way (Groq → Gemini) | ✅ pushed |
| Math rendering (KaTeX → MathML, lazy-loaded) + stronger "use calculator" prompt | ✅ live (verified 2026-11-11) |
| **6.0 Multi-user + admin** (Google sign-in, admin panel, daily limits, block, sign-ups switch) | ✅ live (v0.6.0, commit `41a770b`); Google setup done; live checks 1–2 passed (Google admin sign-in linked to the old account; admin panel) |
| **6.1 Clean replies, model list, time zone, UI fixes** | ✅ live (v0.6.1, commit `b41e514`); live checks 1–5 passed, 6 partly (counting), block / sign-ups / GitHub backup not yet re-checked live |
| **6a Live information** (web search, read page, weather, Wikipedia, currency, sources) | ✅ built & tested locally (143 tests; browser 22/22 with the real keyless services); **owner: Tavily key → Cloudflare, push, live check** |
| **Next: UI redesign (owner's brief, 2026-11-11), then admin-managed RAG knowledge base, then 6b GitHub** | ⏳ |

**Options (the roadmap PDF puts knowledge/reliability before integrations, so 6a comes first):**
- **6b GitHub**: read repos/files/issues/PRs; create issues, comments and PRs behind an **Approve/Reject gate**
  (pending-action table, resume endpoint, UI card). The gate gets reused by Gmail/Calendar/Telegram.
  Needs incremental OAuth scopes (the login currently requests none).
- **6a Web search + documents**: Tavily free key (1,000 credits/month) + DuckDuckGo fallback; URL reader with
  citations; PDF/DOCX upload. R2 needs a card, so store files in D1/KV instead. Untrusted web content must be wrapped
  against prompt injection.
- Later: Gmail, Calendar, Telegram, voice (Groq Whisper), images (Workers AI), rolling summaries.

## 6. Developing & testing locally
```bash
npm install
npm run check            # typecheck + 143 tests (Vitest inside workerd, real local D1) + build
npm run mock:llm         # offline mock of OpenAI-compatible APIs on :8790 (MOCK_FAIL=groq → 429s)
npm run dev              # wrangler dev (:8787, --local) + vite (:5173)
```
Local `.env` for keyless dev: `ADMIN_GITHUB_USERS=<name>`, `DEV_LOGIN=true`, `WORKERS_AI_ENABLED=false`,
`GROQ_API_KEY=mock`, `GROQ_BASE_URL=http://127.0.0.1:8790/groq` (Gemini likewise with `/gemini`).
Browser checks were done with headless Edge via `playwright-core` installed in a temp folder, not in the project.

## 7. Gotchas learned the hard way
- **`git commit` → "could not open '.git/COMMIT_EDITMSG': Permission denied"** (2026-11-11): every file inside `.git`
  had the Windows *Hidden* attribute, and git can't overwrite hidden files. Fix (in the project folder):
  `attrib -h ".git\*" /s /d` (the `.git` folder itself stays hidden, which is normal).
- **Focus styles live in `@layer base`** (styles.css). Unlayered CSS beats Tailwind utilities, so a global
  `:focus-visible` rule outside the layer overrode `outline-none` and drew a box inside the message box.
- **Database changes must never delete user data.** Migrations may only ADD (columns, tables, indexes).
  Never DROP or rebuild `users` or any table that others reference: D1 cascades the DROP into
  sessions/conversations/messages/memories even with `PRAGMA defer_foreign_keys = on` (tested 2026-11-11).
  `tests/migrations.test.ts` seeds data before each migration and fails if any row disappears; since the deploy
  workflow runs tests first, such a change can't reach production. Wiping data on purpose is a separate,
  explicit step the owner must ask for, never part of a migration.
- **Worker entry module may only export handlers.** Keep the Hono app in `src/worker/app.ts`; `index.ts` exports only
  `default`. There's a regression test for this.
- **Gemini rejects tool history it didn't create** (thought signatures in `extra_content`). Tool calls carry `origin`, and
  foreign history is flattened into a neutral note (`flattenToolMessages`). Never use a `[Used tool …]` format; models copy it.
- **Groq free tier is 8K tokens/min**, so two-step tool tasks can hit 429 and fall back. That's expected.
- **CSP is strict** (`public/_headers`: no inline styles, fonts 'self' only). That's why KaTeX outputs MathML with no KaTeX CSS.
- **Windows: stopping a background task leaves `workerd.exe`/`node` children running** on the port. Check
  `netstat -ano | findstr 8787` and stop those PIDs.
- Shell heredocs/Python one-liners turned `\n` escapes into real newlines; write multi-line code with a file editor instead.
- Model IDs and free limits change often: lists are fetched live; defaults can be overridden with `*_MODEL` variables.
- The OpenRouter guard (`:free` only) and "no paid provider in code" are the zero-cost guarantees. Keep them.

## 8. Housekeeping the owner planned
- Delete the GitHub fine-grained token (VESPER-AI only) and its Windows Credential Manager entry when the project is done.
- The local project folder on the office PC can be deleted at any time; everything lives in GitHub + Cloudflare.
