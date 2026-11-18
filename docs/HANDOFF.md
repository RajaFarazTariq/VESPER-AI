# VESPER: handoff notes for a new working session

Read this first when resuming work. Last updated: **2026-11-19**. No secrets are stored here.

## 0. ▶ Resume here (where we stopped on 2026-11-19)

**State:** **v0.9.3 is live** (commit `f2a676b`, verified 2026-11-19: `/api/health` → `0.9.3`). **v0.9.4 is ready
locally, not pushed yet** (if `/api/health` shows `0.9.4`, it's deployed).

**v0.9.3 live re-test (2026-11-19, all answered by Gemini Flash-Lite after Groq's rate limit):** Python ✔️ 3.15.2
from python.org; census ✔️ 241.49 million from PBS + Finance Division, Wikipedia's 247.5 million kept as a note;
Copilot ⚠️ 46% right, but Java figures reversed: it called the PDF's 62% "GitHub's formal report" and put GitHub's
real 61% in a note as "third-party blogs"; a github.com result was present but not opened; the PDF citation rendered
as a link.

**v0.9.4 (built 2026-11-19, owner's spec):** (1) the server reads the organisation's own page when the question names
it, its result is present and its snippet lacks a figure, and passes only the 2–3 most relevant passages
(`official_page_passages`); (2) document passages that quote an organisation are labelled "your document (quoting
X)" + rule R3b (X's own site wins for X's figures); (3) document citations are never links (renderer) and "Note:"
lines only for real disagreements; (A) Groq waits once if its rate-limit wait is ≤ 10 s, otherwise falls back at once
(today's waits were 16–27 s, so this will rarely trigger). 184 tests. Accuracy: see "Accuracy scores".

**Next (agreed): v0.9.5 = the full token-reduction plan**: one call, trimmed passages, private folders, cache,
dates. Aim: make answers fit Groq's 8,000 tokens per minute so the stronger model can answer search questions.

**v0.9.3 (decided and built 2026-11-19).** Owner's goal, restated: *accurate, verified and latest answers, with the
live web as the main source and minimal dependence on manually maintained documents.* Decisions: the web is the main
source; the knowledge base is only for the admin's own/private material (don't upload public papers); Knowledge base
Part 2 (daily web-page refresh) is **postponed**. Built, with the owner's 5 changes to the plan:
- **Trusted / blocked websites** (Admin panel → App settings). Source labels + ranking: government (.gov/.int and
  country versions gov.pk, gov.uk, gob.mx… = biggest boost), the organisation's own site on an **exact** name match
  only, universities (.edu, edu.pk, ac.uk = smaller boost), other. 8 results asked (still 1 search), best 6 kept,
  near-duplicates dropped, dates shown. **No hard date filter**: for changing facts newer results rank higher, but
  official/trusted results never lose rank for age.
- **Rules R1–R7** in the system prompt (R6 "say so if nothing found" only for factual look-ups).
- **Number check** (admin-only step under answers): numbers vs tool results, whole document passages, the question
  and the chat; % / K / M / commas / currency normalised; years, dates, list numbers ignored; never changes answers.
- **Accuracy test set** `tests/accuracy/questions.json` (18 questions, sources checked 2026-11-19) + `npm run
  accuracy`; scores before/after and Groq vs Gemini are in "Accuracy scores" below.
- Tests no longer pick up real keys from `.dev.vars` (`vitest.config.ts` blanks them).
- Not built (agreed): rewriting/deleting answer text after it's written, extra model calls to classify questions.
- Full design: docs/ARCHITECTURE.md §5d.

**Accuracy scores (2026-11-19, local, same PDF, one provider each, fallback off, same corrected scoring rules):**
| Run | 0.9.2 | 0.9.3 | 0.9.4 |
|---|---|---|---|
| Gemini (`gemini-3.5-flash-lite`) | **83.6%**, 12/18 fully right | **90.1%**, 14/18 | **87.3%**, 13/18 |
| Groq (`openai/gpt-oss-120b`) | not measurable (see below) | not run | not run |
- 0.9.4 vs 0.9.3 differs by one question (Node.js LTS: the search returned the 26.13.0 release page instead of
  26.13.1; nodejs.org cited both times): run-to-run variation in search results, not the code. Single runs, so a
  one-question difference is noise.
- **Copilot/Java question** (4/5 in all three runs): 0.9.4 leads with **61%** for Java and says "the research
  document … cites GitHub's February 2023 report giving … 62%" (the PDF correctly described as quoting GitHub, R3b);
  still no GitHub page among the search results, so nothing official to open: it cited a statistics site
  (companieshistory.com) for 61%. The model wrote the PDF citation as `[…](AI in Software Engineering.pdf)`, which
  the renderer now shows as plain text (pattern fixed to allow spaces). Python on 0.9.4 had no needless "Note:".
- Scoring-rule fix after the 0.9.4 run (applied to all runs): "no invented PR count" also failed an answer that gave
  GitHub's official yearly average ("3.5 million pull requests merged per day", found in sources); the rule now only
  fails a count claimed for 3 March 2026 itself. Raw 0.9.4 score before that fix: 84.5%.
- Open finding for v0.9.5: since 0.9.3 the Linux-kernel question gets Wikipedia's "7.3" instead of kernel.org's
  7.3.5 (0.9.2 found kernel.org). Likely cause: `time_range` is no longer sent to Tavily (owner's "no hard date
  filter" rule), so evergreen pages come back for "latest" questions. Idea: when a "latest"/organisation question has
  no official result, one extra search limited to that organisation's site (costs 1 search).
- Scores use the corrected scoring rules (first scoring was 81.8% / 83.1%; fixed afterwards and applied to both runs
  equally: plural "pages 4 and 7" citations, any official Pakistani source, Stack Overflow's company site, census must
  lead with the official figure). Gains on 0.9.3: latest Python (3.15.2 from python.org instead of "3.15" from
  Wikipedia), Node.js LTS, census (official 241.49 million from finance.gov.pk instead of leading with Wikipedia's
  247.5 million). Still missed in both: Copilot cites a magazine, not GitHub's blog (GitHub's blog wasn't among the
  search results at all); the docs-only Java question doesn't add GitHub's 61% note; HumanEval's "updated 80%".
  0.9.3 missed the latest Linux kernel once (said "7.3" from Wikipedia; 0.9.2 found 7.3.5 on kernel.org): normal
  run-to-run variation in search results.
- **Groq finding (important):** Groq's free plan allows **8,000 tokens per minute** for gpt-oss-120b, and a question
  that uses a search needs two requests of ~4,500–6,000 tokens each (question + tools, then the results). The second
  one is always refused ("Rate limit reached … tokens per minute (TPM): Limit 8000, Used 5547, Requested 5988"). So on
  the live site practically **every search question is answered by Gemini Flash-Lite** after "Groq: rate limit
  reached. Switched to the next free provider". With fallback off, Groq finished only the 5 document questions it
  reached on 0.9.2 (3/3, 3/3, 2/3, 3/4, 1/2) and failed both web questions; the runs were stopped so they wouldn't use
  up the Groq allowance the live site shares. Options discussed: wait-and-retry on Groq when its wait is short, or
  make requests smaller, or keep Gemini answering search questions (see the owner's decision, when made).

**Owner's goal (stated 2026-11-19): give users accurate and *latest* information from the internet.** So the
knowledge base must not override the web blindly. Agreed source rule (now in the system prompt, `llm/context.ts`):
1. The original source beats second-hand ones (an organisation's own site/blog/docs > a paper or news quoting it >
   blogs and "statistics"/aggregator sites). If a key fact comes only from a weak source, open the original (read_page).
2. For things that change over time, the newest reliable source wins ("as of <date>").
3. For what a document says, definitions and the admin's own rules/policies, the knowledge base wins.
4. When sources disagree, never pick silently: best-supported answer first, then one line with the other figure,
   its source and date.
Real example from the test: the PDF says Copilot wrote **62%** of Java code; GitHub's own blog (Feb 2023, the original
source) says **61%**. The document was wrong, the web answer was right.

**First live knowledge-base test (2026-11-19).** Live test data: folder **"AI in Software Engineering"** with
**"AI in Software Engineering.pdf"** (arXiv 2310.03533, Fan et al., "LLMs for Software Engineering: Survey and Open
Problems", 23 pages). Upload, folder, space meter, search, re-ranker and page citations all work live.
- On v0.9.0 the assistant used web search instead of the documents, and Groq's gpt-oss once sent only a thinking
  note and stopped ("returned an empty response (response was cut off)"). **Fixed in v0.9.1:** thinking notes alone
  no longer count as "answer started", so the router falls back (`llm/router.ts`); the composer's Tools menu reloads
  when the admin panel closes (`App.tsx`); an empty knowledge base shows 0 pages used (`KnowledgeTab.tsx`).
- On v0.9.1: 3 of 4 questions answered from the PDF with correct pages. "According to GitHub, what share of code was
  written by Copilot?" still went to the web only (Gemini Flash-Lite). Answers listed page chips for every passage
  read, even "the document doesn't cover this". Groq writes citations in 【 】 brackets.
- **v0.9.2 re-test of the Copilot question (live, Gemini Flash-Lite after a Groq rate limit):** both steps ran (Web
  search + Knowledge base, 3 passages); answer 46% with citations to the web and the PDF page 4; chips = 5 web links +
  only page 4. **Still weak:** it blended the conflict into "around 61% to 62%" instead of naming who says which, and it
  relied on statistics sites instead of opening GitHub's own blog. **Planned (with the next release, agreed to batch):**
  sharper prompt rule with an example ("never merge different figures into a range; say which source gives which"),
  and, if the PDF citation renders as a dead link, a rule not to turn document citations into links. Not planned:
  a bigger default Gemini model (fewer free requests per day).
- **v0.9.2 (live):** (A) whenever the model calls `web_search` or `wikipedia` before the documents were
  checked in that reply, the server also runs `search_knowledge` with the same query in parallel (3 passages, hidden
  `limit` arg) and appends them to that web result, shown as its own "Knowledge base" step (`llm/agent.ts`); plus the
  4 source rules above. (B) Under answers, document pages are listed only when the answer cites them; web links
  always (`citedSources` in `web/lib/format.ts`). (C) 【 】 citations are shown as ( ) (`tidyCitations`).

**First thing to do next session (in this order):**
1. Health check. If still `0.9.3`, give him the push commands for 0.9.4 (section "How the owner wants each task run"
   below). Ask whether he **replaced the GitHub token** (pasted into a chat on 2026-11-17, see section 8) and whether
   he **deleted the keys from `.dev.vars`** after the accuracy runs.
2. After the 0.9.4 deploy: re-ask on the live site (new chat, model Auto) the Copilot question; "According to my PDF,
   what does GitHub say about Copilot's share of Java code?"; and "What is the latest stable version of Python?".
   Expect 61% from GitHub's own page with the PDF's 62% as a note, the PDF cited as quoting GitHub, no link on the
   PDF citation, and no needless "Note:" on the Python answer.
3. Then start v0.9.5 (token reduction, above).
3. Older re-test reference (knowledge-base questions; pages checked against the PDF):
   | Question | Correct answer | Page |
   |---|---|---|
   | At Meta, what was the developer acceptance rate for the CodeCompose code completion tool? | 22%; 4.5M suggestions in 15 days; 92% positive | 6 |
   | According to GitHub, what share of developers' code was written by Copilot? | 46% overall; Java: GitHub's blog 61% vs the PDF 62%: expect both sources and the difference noted | 4 |
   | What is the Automated Regression Oracle? | Uses the existing version of the software as the reference for new changes | 2 (14 also relevant) |
   | What does the document say about Kubernetes deployment costs? | Not covered; no PDF page chips under the answer | — |
   If answers miss obvious passages, check the admin view of the tool call (query used, passages found) first.
4. Next per the roadmap PDF: deep-research mode, answer quality (👍/👎), smarter memory, then 6b GitHub (approval
   gate), Gmail/Calendar/Telegram. **Postponed:** Knowledge base Part 2 (daily refresh of saved web pages: the daily
   cron exists; re-read web documents in small batches within the 10 ms CPU / 50-query limits; replace passages only
   when the text changed). Optional later: test a bigger Gemini model for accuracy (fewer free requests per day).
5. Still never checked **live** (low priority): weather/currency/Wikipedia answers, Edit on the last
   message, user vs admin view, Block / Unblock, Sign-ups switch, GitHub backup login.

**Knowledge base (v0.9.0), in short:** Admin panel → Knowledge: folders; upload PDF/Word (.docx)/TXT/MD/CSV (read in
the admin's browser, only text stored, files not kept); "Add web page" (read once by the server); space meter
(~15,000 pages free). Every user's assistant gets the tool `search_knowledge` once a document is ready; it cites
"(document, page X)". Full design, limits and why no Vectorize: docs/ARCHITECTURE.md §5c. Not supported yet: scanned
PDFs (no OCR), .xlsx/.doc (save as CSV/.docx).

**Decisions made 2026-11-17:** sign-in page = professional split layout (playful "night sky" rejected; design rule in
section 5); **no** privacy notice anywhere (removed from the sign-in page, not added under the message box); the rest of
the app UI stays as it is for now; knowledge base built zero-setup (FTS5 + re-ranker, no Vectorize); **no setup on any
PC**: everything the owner does happens on the live site. Confirmed live: `TAVILY_API_KEY` is active.

**Open decisions / known limits:** Edit works on the last user message only; chat search matches loaded titles only;
not built (so no buttons): image upload in chat, voice, projects, agents. Open-Meteo's free tier is non-commercial (a
public commercial launch would need their paid plan). Before opening the app to the public: check each AI provider's
free-tier terms for serving other users (not done yet; fine for a few testers).

**How the owner wants each task run (agreed in this session):**
- Before starting: give a **numbered list of steps**; then report each step as done; say at once if a step fails
  or is skipped; never work around problems quietly.
- **Testing: minimal and to the point** (his explicit request): run only the essential checks for what changed,
  fix obvious issues, report what's left. No exhaustive or repeated suites.
- **Document every stage**: update this file, docs/CONFIGURATION.md (every setting/secret/service + the stage log)
  and README/ARCHITECTURE as needed, and bump the version (`src/worker/version.ts`, package.json, package-lock.json).
- He pushes himself. Give commands like:
  `git add --all -- . ":(exclude)AI_Assistant_Feature_Roadmap.pdf"` → `git status` → `git commit -m "…"` →
  `git -c credential.helper= push origin main` (git then asks Username `RajaFarazTariq` and the token as password).
  Run them in the project folder, not in `C:\Projects` (his office projects live there).
- After his push: watch `/api/health` until the new version shows, then confirm.
- This is a **personal project**: don't save anything about it in the assistant's memory system, and no EOD/history
  logging; this file is the memory. Don't touch his office work.
- Explain in **easy, plain words** (no jargon); he asked for that explicitly. Work **fast**: he prefers short status
  updates and few round-trips. Never ask him to paste a token or key into the chat.
- **UI style:** professional, enterprise-grade (see the design rule in section 5).

**Local machine notes:** `.dev.vars` exists in the project folder (git-ignored) with `DEV_LOGIN=true` /
`ADMIN_GITHUB_USERS=admin`. On 2026-11-19 the owner put his **Groq, Gemini and Tavily keys** in it for the accuracy
runs; remind him to empty those lines (or delete the file) when done. The accuracy runs used two temporary local
servers (0.9.2 copy on :8788, 0.9.3 on :8787) with fresh databases in the session's temporary folder; they are
stopped at the end. To re-run: start `npx wrangler dev --port 8787 --local --persist-to <empty folder>`, then
`npm run accuracy -- --setup --provider groq --pdf <the PDF>` once, then one run per provider. Screenshot/browser-test
scripts lived in a temporary folder and are gone; how to recreate them is in section 7.

## 1. What this is
**VESPER** is the owner's ChatGPT-style AI assistant. Since v0.6.0 it's **multi-user**: anyone can sign up with
Google and chat; the owner is the **admin** and manages everything (users, limits, features) from the admin panel.
Currently in the **testing stage** with a few testers. It runs entirely on **free tiers** (strict zero-cost
requirement: no paid services, no card on file, no paid fallback).

| Item | Value |
|---|---|
| Owner | Raja Faraz Tariq (GitHub **RajaFarazTariq**). Personal project, not office work |
| Repo | https://github.com/RajaFarazTariq/VESPER-AI (**public** since about 2026-11-17, branch `main`; files and full history scanned for secrets that day: none) |
| Live app | https://ai-assistant.vesper-ai.workers.dev |
| Health check | https://ai-assistant.vesper-ai.workers.dev/api/health (expects `version` 0.8.1+) |
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
`GEMINI_API_KEY`, `APP_NAME` (= VESPER), `OPENROUTER_API_KEY` (added 2026-11-19, key expires 2027-02-17; confirmed
"Configured" in Admin panel → Providers). Not set: `MISTRAL_API_KEY` (skipped: Mistral's Free plan now needs an upgrade).
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
| **6a Live information** (web search, read page, weather, Wikipedia, currency, sources) | ✅ live (v0.7.0, commit `758f0b0`); owner adding `TAVILY_API_KEY`; live check pending |
| **UI redesign (v0.8.0)**: new design system, sidebar, welcome screen, composer, messages, Edit last message | ✅ live (v0.8.0, commit `940b218`, verified 2026-11-11); live look with a real AI reply still to do |
| **Sign-in page redesign (v0.8.1)**: professional split layout, brand panel; notice removed; local dev fix | ✅ live (v0.8.1, commit `59f34c8`); live-checked 2026-11-17: new page shows, Google sign-in lands in the app as admin |
| **Knowledge base Part 1 (v0.9.0)**: folders, uploads (PDF/Word/TXT/MD/CSV), web pages, FTS5 + re-ranker, citations; model-menu fix | ✅ live (v0.9.0, commit `19434d7`, deployed 2026-11-17; 154 tests; real-browser upload of a PDF + .docx under the live CSP); owner's first live test 2026-11-19 (see section 0) |
| **Knowledge base fixes (v0.9.1)**: thinking-only replies fall back; Tools menu refresh; 0-page meter; "documents first" prompt | ✅ live (v0.9.1, commit `f48b00e`, deployed 2026-11-19; 155 tests) |
| **Search both + source rules (v0.9.2)**: paired knowledge search on web look-ups, 4 conflict rules, cited-only page chips, 【 】 → ( ) | ✅ live (v0.9.2, commit `a665288`, deployed 2026-11-19; 158 tests); live re-test: both searches run, cited-only chips work; conflict wording still weak with Flash-Lite |
| **Trusted sources (v0.9.3)**: source labels + ranking, trusted/blocked sites, R1–R7, admin-only number check, accuracy test set | ✅ live (v0.9.3, commit `f2a676b`, deployed 2026-11-19; 175 tests); live re-test: Python and census right, Copilot Java figures reversed |
| **Source fixes (v0.9.4)**: server reads official pages, "quoting X" labels + R3b, plain document citations, Note only for disagreements, Groq ≤10 s wait | ⏳ ready locally (184 tests), not pushed; accuracy in section 0 |
| **Next: token reduction (v0.9.5)** so Groq can answer search questions | ⏳ |
| Knowledge base Part 2 (daily web-page refresh) | ⏸ postponed (2026-11-19: the web is the main source) |

**Design system (v0.8.0)** — keep new UI consistent with it:
- All colours, surfaces, borders and shadows are CSS variables in `src/web/styles.css` (`--bg`, `--bg-elevated`,
  `--text-soft`, `--text-faint`, `--accent`, `--accent-soft`, `--accent-2`, `--user-bubble`, `--shadow-sm/md/lg`…),
  defined for light (`:root`) and dark (`.dark`). Never hard-code colours in components.
- Signature classes: `dusk-glow` (welcome/sign-in background), `dusk-text` (gradient greeting word), `shimmer-text`
  ("Thinking…"), `rise-in` (entry animation). Animations are disabled for `prefers-reduced-motion`.
- System fonts only (`--font-sans`, `--font-display`): the CSP allows fonts from the site itself, no web fonts.
- Logo: `public/favicon.svg` (evening-star mark, indigo→violet). Radii: cards `rounded-2xl`, dialogs `rounded-3xl`,
  composer `rounded-[26px]`, pills `rounded-full`.
- Layout: `Sidebar.tsx` (search, date groups, collapsible rail saved in localStorage `vesper-sidebar-collapsed`,
  account menu with Settings/Admin/Theme/Sign out); welcome screen + docked composer in `App.tsx`; `Composer.tsx`
  holds the model picker (`placement="up"`) and `ToolsButton`; `MessageItem.tsx` (assistant mark, actions, Edit on
  the last user message → `POST /api/chat` with `edit: true`).
- Not built (no fake buttons): image upload in chat, voice, projects, agents. (Document upload exists only in the
  admin panel → Knowledge, since v0.9.0.)
- **Owner's design rule (2026-11-17): professional, enterprise-grade, globally competitive.** No playful decoration
  (stars, typing animations, gradient text, glow effects, oversized rounded cards); restrained colour, standard 8px
  corners, clear hierarchy, minimal motion. Applies to new UI work.
- **Sign-in page (v0.8.1)** (`LoginPage.tsx`): split layout. The form side uses the app tokens (follows light/dark); the
  brand panel (wide screens only) is always dark with its own tokens (`.auth-showcase`, `--sc-*` in `styles.css`):
  the logo inside fine SVG orbit lines, headline "Clear answers. Trusted sources.". Static, no animation.

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
npm run check            # typecheck + 184 tests (Vitest inside workerd, real local D1) + build
npm run mock:llm         # offline mock of OpenAI-compatible APIs on :8790 (MOCK_FAIL=groq → 429s)
npm run dev              # wrangler dev (:8787, --local) + vite (:5173)
```
Local `.env` for keyless dev: `ADMIN_GITHUB_USERS=<name>`, `DEV_LOGIN=true`, `WORKERS_AI_ENABLED=false`,
`GROQ_API_KEY=mock`, `GROQ_BASE_URL=http://127.0.0.1:8790/groq` (Gemini likewise with `/gemini`).
Browser checks (since 2026-11-17): headless Edge driven over the DevTools protocol with Node's built-in `WebSocket`
(no packages): `--remote-debugging-port`, `Emulation.setDeviceMetricsOverride` (phone sizes), `DOM.setFileInputFiles`
(uploads), `Runtime.evaluate` with `fetch('/api/auth/dev-login', …)` to sign in. To test under the live CSP, run
`npm run build` and use `wrangler dev` on :8787 (it applies `public/_headers`); restart wrangler after each build.
Apply new migrations locally first: `npx wrangler d1 migrations apply DB --local`.

## 7. Gotchas learned the hard way
- **`git commit` → "could not open '.git/COMMIT_EDITMSG': Permission denied"** (2026-11-11): every file inside `.git`
  had the Windows *Hidden* attribute, and git can't overwrite hidden files. Fix (in the project folder):
  `attrib -h ".git\*" /s /d` (the `.git` folder itself stays hidden, which is normal).
- **Local `wrangler dev` returns 404 for `/` after `npm run build`/`npm run check`**: the build empties and recreates
  `dist/`, and a running `wrangler dev` doesn't pick that up. Restart `wrangler dev` after building. (Not an issue in
  production: deploys upload the built files.)
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
- **Full test run on the office PC: a random test sometimes fails with "Test timed out in 5000ms"** (2026-11-19; a
  different test each run, e.g. in admin.test.ts / api.test.ts). They pass when their file is run alone
  (`npx vitest run tests/<file>.ts`) and GitHub CI passes; it's the PC being slow under the parallel run, not a bug.
  Re-run the file alone before suspecting the code. If CI ever fails this way, re-run the job.
- **Windows: stopping a background task leaves `workerd.exe`/`node` children running** on the port. Check
  `netstat -ano | findstr 8787` and stop those PIDs. Stopping only `workerd.exe` isn't enough: its parent wrangler
  `node` process restarts it on the same port, and two servers on 8787 make every request hang. Stop the whole
  tree: `taskkill /PID <wrangler node pid> /T /F` (2026-11-17).
- **`npm run dev` showed a blank page** (fixed 2026-11-17): Vite's `/api` proxy also caught `/api/client.ts`, the app's
  own source file in `src/web/api/`, and sent it to the Worker (404). The proxy key in `vite.config.ts` is now a regex
  that leaves `.ts`/`.tsx` requests to Vite.
- **Previewing the real sign-in buttons locally:** start the API with
  `npx wrangler dev --port 8787 --local --var GOOGLE_CLIENT_ID:local-preview --var GOOGLE_CLIENT_SECRET:local-preview`
  (GitHub likewise) plus `npx vite`. The buttons then show, but don't click them (placeholder IDs).
- **Phone-width screenshots:** headless Edge won't make a window narrower than ~500px, so `--window-size=390,…`
  silently lays out at ~500px. Use DevTools-protocol emulation (`Emulation.setDeviceMetricsOverride`, mobile: true;
  `Emulation.setEmulatedMedia` for dark mode) via Node's built-in `WebSocket` with `--remote-debugging-port`.
- Shell heredocs/Python one-liners turned `\n` escapes into real newlines; write multi-line code with a file editor instead.
- Model IDs and free limits change often: lists are fetched live; defaults can be overridden with `*_MODEL` variables.
- The OpenRouter guard (`:free` only) and "no paid provider in code" are the zero-cost guarantees. Keep them.

## 8. Housekeeping the owner planned
- Delete the GitHub fine-grained token (VESPER-AI only) and its Windows Credential Manager entry when the project is done.
- **Replace the current GitHub token** (it was pasted into a chat on 2026-11-17; it expires 2026-12-09): delete it on
  GitHub and create a new fine-grained token (VESPER-AI only, Contents: read and write).
- Delete `.dev.vars` when local testing is done, so no keys stay on the PC (on 2026-11-19 it holds his Groq,
  Gemini and Tavily keys for the accuracy runs).
- **OpenRouter key "VESPER AI" expires 2027-02-17** (created 2026-11-19, 90 days): before then create a new one
  (credit limit at the minimum) and replace the Cloudflare secret `OPENROUTER_API_KEY`. Until it's replaced, VESPER
  just skips OpenRouter. If OpenRouter answers "No endpoints found matching your data policy", allow free models in
  OpenRouter → Settings → Privacy.
- Mistral: skipped (its Free plan now needs an upgrade before keys can be created; no card allowed).
- The local project folder on the office PC can be deleted at any time; everything lives in GitHub + Cloudflare.
