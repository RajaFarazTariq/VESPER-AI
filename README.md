# AI Assistant (free-tier, multi-provider)

A private, ChatGPT-style AI assistant that runs entirely on **free tiers**: Cloudflare Workers + D1 for hosting
and storage, and free AI APIs (Groq, Google Gemini, OpenRouter `:free` models, Mistral, Cloudflare Workers AI) with
**automatic fallback** when a free limit is reached. Optional **local models** through Ollama.

- 💬 Streaming chat with Markdown, code highlighting, tables, and collapsible model reasoning
- 🛠️ Tool-using agent: exact calculator, date/time in any timezone, long-term memory (multi-step, streamed live)
- 🧠 Long-term memory you control: view, add and delete in Settings → Memory
- 🔁 Automatic free-provider fallback with cooldowns, retries and clear error messages
- 🎛️ Manual model picker with live model lists from every provider
- 🗂️ Conversation history stored in a cloud database (rename, delete, deep links, regenerate, stop)
- 🔐 GitHub sign-in restricted to an allowlist of usernames; no passwords stored
- 🖥️ Optional local models (Ollama) called directly from your browser
- 🌗 Light/dark/system themes and a responsive mobile layout
- 💸 **No paid services, no credit card, no automatic billing**

> Status: **Phase 5 (tools & agent loop) complete.** Web search, documents and integrations (GitHub, Gmail, Calendar,
> Telegram) come in later phases. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## How it stays free

| Piece | Service | Free allowance | What happens at the limit |
|---|---|---|---|
| Hosting + API | Cloudflare Workers (Free plan) | 100,000 requests/day, 10 ms CPU per request | Requests fail with error 1027 until 00:00 UTC. **No billing.** |
| Web app files | Workers static assets | Unlimited requests | n/a |
| Database | Cloudflare D1 | 5 GB storage, 5M rows read/day, 100k rows written/day | Queries fail until 00:00 UTC. **No billing.** |
| AI | Groq free plan | ~30 req/min, ~1,000 req/day, 8K tokens/min per model | 429 → app switches provider |
| AI | Google Gemini free tier | Per-project limits (shown in AI Studio); Flash-Lite allows the most | 429 → app switches provider |
| AI | OpenRouter `:free` models | 20 req/min, 50 req/day | 429 → app switches provider |
| AI | Mistral "Experiment" plan | Conservative rate limits | 429 → app switches provider |
| AI | Cloudflare Workers AI | 10,000 neurons/day | Fails until 00:00 UTC. **No billing.** |
| CI/CD | GitHub Actions | Unlimited for public repos; 2,000 min/month for private | Workflow waits until next month |

Guarantees built into the code:
- The app **refuses any OpenRouter model whose id doesn't end in `:free`**, so it can't spend credits.
- There is **no paid provider** in the code, so fallback only ever moves between free providers.
- Cloudflare's Free plan can't bill you. Stay on it (don't upgrade to Workers Paid).

Things **you** must keep free: don't add a card to Groq, use a Gemini key from a Google Cloud project **without
billing enabled**, and stay on Mistral's free Experiment plan. Free-tier numbers above were checked in November 2026
and change often. The app reads live model lists and handles limits dynamically.

**Privacy:** Gemini's and Mistral's free tiers may use your prompts to improve their models. Don't send sensitive data
to them, or use only Groq or local models for private work.

---

## Quick start (local development)

Requirements: Node.js 22.12+ and Git. No Cloudflare account is needed for local development.

```bash
git clone https://github.com/<you>/<repo>.git
cd <repo>
npm install
cp .env.example .env        # then edit .env (see below)
npm run dev                 # API on :8787, web app with hot reload on http://localhost:5173
```

Minimum `.env` for local use **without any API keys** (uses the bundled mock LLM server):

```ini
ALLOWED_GITHUB_USERS=your-github-username
DEV_LOGIN=true
WORKERS_AI_ENABLED=false
GROQ_API_KEY=mock
GROQ_BASE_URL=http://127.0.0.1:8790/groq
```

Then in a second terminal run `npm run mock:llm` and sign in with the "local development login" form. To use real
models locally, put real keys in `.env` instead (and remove the `*_BASE_URL` lines).

Local data (the SQLite file behind D1) lives in `.wrangler/` inside the project and is git-ignored.

## Deploying (free, from your own GitHub account)

Follow **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. In short:

1. Push this project to your GitHub repository.
2. Create a free Cloudflare account, a D1 database and an API token.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets and a `D1_DATABASE_ID` variable to the GitHub repo.
4. Push to `main`. GitHub Actions tests, migrates the database and deploys.
5. Create a GitHub OAuth app and add your keys as Cloudflare secrets.

After that, the app runs entirely in Cloudflare. You can delete the project from your computer.

## Configuration

All configuration is environment variables. In production, set them in **Cloudflare → Workers & Pages → your Worker →
Settings → Variables and Secrets** (type *Secret* for anything sensitive). Locally, set them in `.env`.

| Variable | Required | Description |
|---|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | yes | GitHub OAuth app used for sign-in |
| `ALLOWED_GITHUB_USERS` | yes | Comma-separated GitHub usernames allowed in. Empty means nobody. |
| `GROQ_API_KEY` | one AI key | [console.groq.com/keys](https://console.groq.com/keys) |
| `GEMINI_API_KEY` | recommended | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | optional | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| `MISTRAL_API_KEY` | optional | [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) |
| `APP_NAME` | no | Display name (default `Assistant`) |
| `PROVIDER_ORDER` | no | Auto-fallback order (default `groq,gemini,openrouter,mistral,workers-ai`) |
| `GROQ_MODEL`, `GEMINI_MODEL`, `OPENROUTER_MODEL`, `MISTRAL_MODEL`, `WORKERS_AI_MODEL` | no | Default model per provider used by Auto |
| `WORKERS_AI_ENABLED` | no | `false` to disable the built-in Cloudflare models |
| `WORKERS_AI_MODELS` | no | Comma-separated `@cf/...` ids to show instead of the built-in list |
| `MAX_CONTEXT_CHARS` | no | Conversation history sent per request (default 16000, sized for Groq's 8K tokens/min) |
| `MAX_OUTPUT_TOKENS` | no | Max reply length (default 2048) |
| `CHAT_RATE_LIMIT_PER_MINUTE` | no | Per-user chat requests per minute (default 20) |
| `SESSION_TTL_DAYS` | no | Sign-in lifetime with sliding renewal (default 30) |
| `DEV_LOGIN` | dev only | Enables a username-only login, and only on `localhost` |

## Using local models (optional)

Install [Ollama](https://ollama.com/download) on your computer, `ollama pull llama3.2`, and start it with
`OLLAMA_ORIGINS=https://<your-app>.workers.dev`. In the app go to **Settings → Local models**, enable them and press
**Test**. Local models then appear in the model menu. Your browser calls Ollama directly; the cloud server never
contacts your machine, and local chats still save to your history.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local D1 migrations + API (`wrangler dev`) + web app (`vite`) with hot reload |
| `npm run mock:llm` | Offline mock of the AI APIs (`MOCK_FAIL=groq` makes Groq return 429 to test fallback) |
| `npm run typecheck` | TypeScript checks for the Worker and the web app |
| `npm test` | Unit + integration tests inside the Workers runtime with a real local D1 |
| `npm run build` | Builds the web app into `dist/` |
| `npm run check` | typecheck + test + build |
| `npm run deploy` | Build, apply remote migrations and deploy (needs `npx wrangler login`) |

## Project structure

```
├─ .github/workflows/      ci.yml (checks on every push/PR), deploy.yml (deploy on push to main)
├─ migrations/             D1 (SQLite) schema migrations
├─ public/                 static files copied as-is (_headers = security headers/CSP, favicon)
├─ scripts/                dev launcher, mock LLM server
├─ src/
│  ├─ shared/              types and the SSE parser used by both server and browser
│  ├─ worker/              Cloudflare Worker (Hono)
│  │  ├─ index.ts          entry: fetch + daily cron cleanup
│  │  ├─ app.ts            routes, error handling
│  │  ├─ routes/           auth, chat (SSE), conversations, models, settings
│  │  ├─ middleware/       session auth, CSRF/origin guard, rate limiting, request logging
│  │  ├─ db/               D1 queries
│  │  ├─ llm/              providers, fallback router, agent loop, prompt/context builder, model catalogue
│  │  └─ tools/            tool registry + tools (calculator, date/time, memory)
│  └─ web/                 React app (Vite + Tailwind)
├─ tests/                  Vitest suites (run inside workerd)
├─ docs/                   ARCHITECTURE.md, DEPLOYMENT.md
├─ wrangler.jsonc          Worker configuration
└─ .env.example            every supported variable, documented
```

## Security

- Sign-in is GitHub OAuth with a server-side username allowlist, re-checked on every request. Removing a name revokes access immediately.
- Sessions are random 256-bit tokens in `HttpOnly`, `Secure`, `SameSite=Lax` cookies (`__Host-` prefix). Only their SHA-256 hash is stored.
- CSRF protection: state-changing requests must be same-origin JSON. A strict Content-Security-Policy is applied to the web app.
- Input validation (zod) on every endpoint, request size limits, and per-user and per-IP rate limits.
- API keys exist only as Cloudflare secrets. They are never sent to the browser or committed.
- Model output is rendered without raw HTML. Remote images are shown as links, so injected content can't leak data via image URLs.
- Conversations are scoped to their owner in every query.

## Troubleshooting

- **"Every available free provider failed"**: all configured providers are rate-limited or out of daily quota.
  Rate limits clear in minutes; daily quotas reset the next day. Adding more free keys improves resilience.
- **Error 1027 page**: the Cloudflare free daily request limit (100k) was reached. It resets at 00:00 UTC.
- **"That GitHub account isn't allowed"**: add the username to `ALLOWED_GITHUB_USERS` in Cloudflare.
- **GitHub sign-in fails right after redirect**: the OAuth app's callback URL must be exactly
  `https://<your-app>.workers.dev/api/auth/github/callback`.
- **Gemini 429 immediately**: newer/Pro models may have no free quota. Pick a Flash-Lite model or leave Auto on.
