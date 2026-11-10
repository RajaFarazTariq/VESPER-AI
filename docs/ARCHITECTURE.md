# Architecture

Version 0.4 (Phase 4 complete). Research last checked November 2026. Free-tier numbers change often, so the app
discovers models live and treats every limit as dynamic.

## 1. Constraints that drove the design

- **Zero cost:** no paid service, no card on file, no automatic paid fallback.
- **Cloud-hosted and independent of any one computer:** code in GitHub; app, data and secrets in the cloud.
- **Sustainable free tier:** must not sleep, must not lose data on redeploy, must survive free-tier changes.

## 2. Hosting decision

| Option | Verdict | Why |
|---|---|---|
| **Cloudflare Workers + D1 + static assets** | ✅ **Chosen** | No card. 100k req/day. No sleep or cold-start penalty. HTTP streaming has no wall-clock limit, and time spent waiting on LLMs doesn't count toward the 10 ms CPU limit. D1 gives 5 GB of SQLite. Workers AI is an extra free model source. Limits **fail closed, never bill**. One vendor, one deploy. |
| Vercel Hobby + Neon/Supabase | ❌ | Function duration limits cut off long streams. Hobby is non-commercial only. Two vendors. |
| Render free | ❌ | Sleeps after 15 min (~1 min cold start), ephemeral disk, 5 GB bandwidth. |
| Oracle Always Free | ❌ | Requires a card, capacity is often unavailable, and the allowance was halved in 2026. |
| Hugging Face Spaces | ❌ | Sleeps when idle, and needs an external DB anyway. |

**Consequence:** the backend is **TypeScript on Cloudflare Workers (Hono)** instead of Python/FastAPI. Python Workers
exist but are less mature, and Python isn't required for anything in scope.

**Authentication:** Google OAuth for everyone (open sign-up, switchable by the admin), GitHub OAuth for administrators
only. Password hashing (PBKDF2 at OWASP strength) doesn't fit the free plan's 10 ms CPU budget, and email/password
would need a mail service for verification. No passwords are stored. Roles: `admin` is derived on every request
from `ADMIN_EMAILS` (verified email) or `ADMIN_GITHUB_USERS`; everyone else is a `user`.

**Accounts and linking:** one `users` row per person, with `google_sub` and/or `github_login`. A Google sign-in
links to an existing account with the same verified email, or (admin email only) to the single GitHub-only admin
account, and vice versa, so the admin's two sign-in methods open the same chats. Google-only accounts store a
negative placeholder in the legacy `github_id NOT NULL` column (the table isn't rebuilt; see the data-safety rule
in HANDOFF.md).

## 3. System overview

```
Browser (React SPA, served as static assets; CSP via public/_headers)
   │  same-origin fetch + Server-Sent Events                 ┌──────────────────────────┐
   ▼                                                          │ Ollama on the user's PC  │◄── optional, browser-direct
Cloudflare Worker (Hono)  /api/*                              └──────────────────────────┘
   ├─ middleware: request log + id, CSRF origin guard, session auth (+blocked check), admin gate, rate limits
   ├─ routes: auth (Google, GitHub) · chat (SSE) · conversations · models · settings · admin · health
   ├─ llm/
   │   ├─ registry     provider definitions (Groq, Gemini, OpenRouter, Mistral via one OpenAI-compatible adapter; Workers AI via binding)
   │   ├─ router       plan (auto / manual + fallback) → execute (retry, fallback, cooldown, usage)
   │   ├─ context      system prompt + history window within a character budget
   │   └─ catalog      live /models lists, cached in memory and D1 for 6 h
   └─ D1 (SQLite): users · sessions · conversations · messages · provider_state · usage_daily · rate_limits · model_cache
Cron (daily): purge expired sessions, old rate-limit windows, usage older than 90 days
```

## 4. Model routing & fallback

- **Auto:** configured providers in `PROVIDER_ORDER`, skipping any in cooldown. If every provider is cooling down,
  it tries them anyway, soonest-ready first, rather than failing.
- **Manual (`provider:model`):** validated against the provider (OpenRouter must end in `:free`). If the user setting
  *Fall back automatically* is on, the auto chain without that provider is appended.
- **Per attempt:** a 45 s first-byte timeout and a 60 s idle timeout. Transient errors (5xx/timeout/network) are retried
  once with jitter. Rate-limit, quota and auth errors move to the next provider immediately.
- **Cooldowns** (shared in D1): rate limit uses Retry-After or 60 s; quota uses Retry-After or 1 h (Workers AI: until
  00:00 UTC); bad key 15 min; unknown model 10 min. "Request too large" (Groq's 8K TPM) falls back with no cooldown.
- **No mid-stream switching:** once text has streamed, a failure is saved as a *partial* reply with a Retry button,
  because splicing two models' answers would be incoherent.
- Every attempt is counted in `usage_daily`, which the Providers screen shows.

## 5. Chat turn lifecycle

1. Validate input, apply the per-user rate limit, then **plan the route before writing anything**. Configuration
   errors return 4xx/503 and never leave half-created chats.
2. Create the conversation if new; insert the user message (or, on regenerate, delete the trailing reply).
3. Build the context: system prompt (app rules, date, user's custom instructions) plus the newest messages that fit
   `MAX_CONTEXT_CHARS`. Failed replies are dropped, same-role messages are merged, and the window never starts on an
   assistant turn.
4. Stream SSE events: `conversation`, `user_message`, `attempt`, `fallback`, `delta`, `reasoning`, `done | error`.
   A keep-alive comment is sent every 15 s.
5. If the client disconnects (Stop), the upstream request is aborted to save quota and the partial text is saved.
6. Save the assistant message with provider, model, status and token usage.

**Local models (Ollama):** `/api/chat/local/prepare` stores the user turn and returns the prompt. The browser streams
from Ollama directly, then `/api/chat/local/complete` stores the reply. The server never calls the user's machine.

## 5b. Agent loop & tools (Phase 5)

- `llm/agent.ts` runs **model → tools → model** for up to 5 rounds per message. The last round offers no tools, which
  forces a written answer. Every round goes through the same fallback router; once a provider works, the rest of the
  task sticks with it.
- **Tool calls stream:** fragments of `delta.tool_calls` are reassembled (`ToolCallAccumulator`). Provider-specific
  fields such as Gemini's `extra_content.thought_signature` are echoed back on the next request, as Gemini requires.
- **Providers without tools** (Workers AI) or models that reject them (some free OpenRouter models) get plain chat.
  If a fallback lands on one mid-task, the tool transcript is flattened into text (`flattenToolMessages`).
- **Tools** (`tools/registry.ts`): portable hand-written JSON Schema for the model and zod validation of every call.
  Bad input, unknown tools and invalid JSON become error results the model can recover from. They never crash the turn.
  - `calculator`: own recursive-descent parser (no `eval`, own-property lookups only, depth and length limits).
  - `current_datetime`: `Intl` with IANA timezones.
  - `remember` / `forget`: long-term memory (max 100 items × 500 chars, credential-looking text refused).
- **Risk levels:** `read` (looks things up) and `write` (changes the user's own data). Tools that act outside the
  account (send, create, delete elsewhere) will need explicit user approval, enforced in code. That flow ships with
  the first such tools (GitHub writes, Phase 6b), so it's tested against a real action instead of a stub.
- **Memory:** enabled memories (up to ~6k chars, newest first) go into the system prompt with their ids. Users manage them
  in Settings → Memory, and can switch memory and each tool off in Settings → Tools.
- Tool activity is stored on the assistant message (`messages.tools`, JSON) and shown in the UI. Later turns replay only
  the final text, not the tool transcript, which keeps prompts small for free-tier token limits.

## 6. Security model

| Threat | Control |
|---|---|
| Strangers using your quota | Per-user daily message limit (default 30, admins unlimited), sign-ups switch, Google *Testing* mode allows only listed test users, block button (checked **every request**, sessions deleted) |
| Non-admins reaching admin functions | `/api/admin/*` requires the admin role, derived from config on every request; admins can't be blocked or deleted through the API |
| Session theft | 256-bit random token, `HttpOnly; Secure; SameSite=Lax; __Host-` cookie, only the hash stored, sliding 30-day expiry, logout deletes the row |
| CSRF | Mutating requests must be same-origin (Origin / Sec-Fetch-Site) and `application/json` |
| OAuth CSRF | Random `state` in a short-lived HttpOnly cookie, compared in constant time |
| XSS / data exfiltration via model output | No raw HTML in Markdown, links forced to `http(s)`/`mailto`, remote images shown as links, strict CSP (`script-src 'self'`, `connect-src` limited to self + localhost) |
| Abuse / runaway cost | Per-user chat limit, per-IP auth limit, body size caps, message length caps, free-only providers |
| Secret leakage | Keys only in Cloudflare secrets; `.env`/`.dev.vars` git-ignored; never returned by the API |
| Data isolation | Every conversation query is scoped by `user_id`; foreign keys cascade on delete |
| Dev login in prod | Requires `DEV_LOGIN=true` **and** a localhost hostname, which a workers.dev request can't have |

Prompt injection becomes the main risk once tools exist (Phase 5+). The plan for that: tool results are wrapped
as untrusted data, every side-effecting tool needs explicit user approval enforced in code, and exfiltration-capable
tools are blocked once untrusted content is in context.

## 7. Testing

- `tests/units.test.ts`: SSE parser, error classification, cooldowns, context builder, config parsing, entry-module shape.
- `tests/router.test.ts`: planning and fallback behaviour with fake providers.
- `tests/migrations.test.ts`: data-safety guard: every migration is applied to a database full of user data and
  must not lose a single row.
- `tests/admin.test.ts`: multi-user flows: Google sign-up/sign-in, admin by email or GitHub, account linking,
  sign-ups switch, blocking, daily limits, admin API permissions, bot instructions and tools for everyone.
- `tests/api.test.ts`: full HTTP flows inside workerd with a real local D1: auth, OAuth callback, CSRF, streaming + fallback + persistence, regenerate, validation, rate limiting, isolation between
  users, settings, model lists, local-model endpoints.
- Manual/automated E2E: `wrangler dev` + `scripts/mock-llm.mjs` + a headless browser run (login, streaming,
  reload persistence, regenerate, model picker, settings, rename, dark mode, stop, mobile drawer, sign-out).

## 8. Known limitations

- Free-tier limits and model line-ups change without notice. Mitigated by live model lists, multi-provider fallback
  and env-overridable defaults.
- Groq's 8K tokens/minute caps request size, so `MAX_CONTEXT_CHARS` defaults to 16k. Long chats lose older context
  (rolling summaries are planned).
- Free tiers of Gemini/Mistral may train on prompts (documented in the UI).
- Workers AI can't be tested locally without a Cloudflare login, and Workers AI response formats vary by model (both
  known formats are handled).
- The JS bundle is ~190 KB gzipped (syntax highlighting is most of it). Fine for now; it can be code-split later.

## 9. Roadmap

| Phase | Scope | Free building blocks |
|---|---|---|
| ✅ 4 | Core chat, auth, history, multi-provider fallback, UI | Workers, D1, free LLM APIs |
| ✅ 5 | Agent loop, tool registry, calculator, date/time, long-term memory, tool & memory settings | Provider tool-calling APIs |
| ✅ 6.0 | Multi-user: Google sign-up/sign-in, admin role, admin panel (users, block, limits, sign-ups, bot instructions, tools, providers), per-user daily limits | Google OAuth (free) |
| 6a | Web search + page reading with citations; file upload, PDF/DOCX parsing, RAG | Tavily free / DuckDuckGo, D1 blobs (R2 needs a card, so it's avoided), Workers AI embeddings + Vectorize free tier |
| 6b | **GitHub** integration (repos, issues, PRs: read freely, write with approval) + the approval gate | GitHub REST API, incremental OAuth scopes |
| 6c | **Gmail** (draft-first, send with approval), **Google Calendar** | Google APIs (free) via OAuth |
| 6d | **Telegram** bot (webhook into the same Worker) | Telegram Bot API |
| 6e | Voice (Groq Whisper STT, browser TTS), images (Workers AI) | Free quotas |
| 8 | Hardening: rolling summaries, memory, export/import, more tests | — |
