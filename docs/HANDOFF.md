# VESPER: handoff notes for a new working session

Read this first when resuming work. Last updated: **2026-11-10**. No secrets are stored here.

## 1. What this is
**VESPER** is the owner's personal, ChatGPT-style AI assistant. It runs entirely on **free tiers** (strict zero-cost
requirement: no paid services, no card on file, no paid fallback).

| Item | Value |
|---|---|
| Owner | Raja Faraz Tariq (GitHub **RajaFarazTariq**). Personal project, not office work |
| Repo | https://github.com/RajaFarazTariq/VESPER-AI (private, branch `main`) |
| Live app | https://ai-assistant.vesper-ai.workers.dev |
| Health check | https://ai-assistant.vesper-ai.workers.dev/api/health (expects `version` 0.5.0+) |
| Cloudflare | Free plan. Worker name `ai-assistant`, workers.dev subdomain `vesper-ai` |
| D1 database | `ai-assistant`, id `726f21f4-8ef4-40b5-86ea-3676f2545c84` (not secret) |
| Sign-in | GitHub OAuth app "VESPER AI", callback `https://ai-assistant.vesper-ai.workers.dev/api/auth/github/callback` |

## 2. How the owner wants to work
- **The owner runs all git commands himself** (commit/push). Never push or commit on his behalf; give him the exact
  commands. He has asked that each set of push commands include his GitHub token; ask him for it, because it is
  deliberately not stored in this repo.
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
- **Tools** (`src/worker/tools/`): `calculator` (own safe parser), `current_datetime`, `remember`, `forget`.
  Risk levels: `read` / `write` (own data).
- **Memory**: `memories` table, injected into the system prompt; managed in Settings → Memory.
- **Auth**: GitHub OAuth + `ALLOWED_GITHUB_USERS` allowlist (rechecked every request). Opaque session tokens, stored as
  hashes. `DEV_LOGIN=true` gives a username-only login, and only on localhost.
- Full design: `docs/ARCHITECTURE.md`. Deployment guide: `docs/DEPLOYMENT.md`.

## 4. Configuration (names only; values live in Cloudflare → Worker → Settings → Variables and Secrets)
Set: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `ALLOWED_GITHUB_USERS` (= RajaFarazTariq), `GROQ_API_KEY`,
`GEMINI_API_KEY`, `APP_NAME` (= VESPER). Not set yet: `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`.
GitHub repo has Actions secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and variable `D1_DATABASE_ID`.
`wrangler.jsonc` has `keep_vars: true`, so deploys don't wipe dashboard variables.

## 5. Status
| Phase | State |
|---|---|
| 1–3 Research & architecture | ✅ |
| 4 Core chat (streaming, history, auth, multi-provider fallback, UI) | ✅ live |
| 5 Agent loop + tools + long-term memory + Tools/Memory settings | ✅ live (v0.5.0) |
| Fix: tool task switching provider mid-way (Groq → Gemini) | ✅ pushed |
| Math rendering (KaTeX → MathML, lazy-loaded) + stronger "use calculator" prompt | ✅ built & tested; **check that the owner pushed it** |
| **Next: owner to choose 6b or 6a** | ⏳ |

**Next options (recommended: 6b first, the owner's #1 integration):**
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
npm run check            # typecheck + 100 tests (Vitest inside workerd, real local D1) + build
npm run mock:llm         # offline mock of OpenAI-compatible APIs on :8790 (MOCK_FAIL=groq → 429s)
npm run dev              # wrangler dev (:8787, --local) + vite (:5173)
```
Local `.env` for keyless dev: `ALLOWED_GITHUB_USERS=<name>`, `DEV_LOGIN=true`, `WORKERS_AI_ENABLED=false`,
`GROQ_API_KEY=mock`, `GROQ_BASE_URL=http://127.0.0.1:8790/groq` (Gemini likewise with `/gemini`).
Browser checks were done with headless Edge via `playwright-core` installed in a temp folder, not in the project.

## 7. Gotchas learned the hard way
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
