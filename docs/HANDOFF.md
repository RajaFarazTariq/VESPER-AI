# VESPER: handoff notes for a new working session

Read this first when resuming work. Last updated: **2026-11-24**. No secrets are stored here.

## ⏩ Quick resume (2026-11-24, end of session)
- **Live:** v0.14.1 charts + CSV download (PR #18, merge `fcbb551`; /api/health 0.14.1; the owner's live test with
  Gemini showed the line chart, bars and correct totals). **v0.15.0 Google Calendar + Gmail (send only): built
  2026-11-24, handed to the owner to push** on branch `release/v0.15.0-google`. Check
  https://ai-assistant.vesper-ai.workers.dev/api/health: `0.15.0` means it was merged and deployed. Then the
  owner's setup (section 0, "v0.15.0 setup", one step at a time), then the live test.
- **Owner's live tests still to do:** v0.14.0 steps (b)–(g); v0.14.1 (Download CSV in Excel, Table switch, phone,
  Check); v0.15.0 after setup.
- **Small fixes noted for later (from the v0.14.1 live test):** "Jan 26" axis labels can read as a day (use "Jan 2026"
  or the year at year changes); the AI added "$" to amounts without a currency (prompt: never add a unit the column
  doesn't have).
- **Owner decided (2026-11-24):** data analysis with the recommended defaults (10 MB / 50,000 rows / 100 columns per
  file, 10 files per user per day, 20 kept per user, 5 per chat, on for everyone), then "go with your recommendation"
  for v0.14.1 (charts + CSV download). He asks for work to be "perfect and accurate".
- **GitHub set-up (unchanged):** "VESPER AI Reader" (read-only) and "VESPER AI Actions" (public since 2026-11-21);
  GitHub for users ON, GitHub changes for users ON (10/day). Test PR #15 and issue #14 are closed (owner, 2026-11-24).
- **Next (owner to choose):** (1) the two small fixes above as v0.15.1; (2) Excel files in the knowledge base (reuse
  the v0.14.0 reader); (3) Google: change/cancel events VESPER added; (4) fixes from the live tests or testers.
- **How he works (details in section 2 and "How the owner wants each task run"):** numbered plan first, then report
  each step; plain words; dashboard tasks one step at a time; he runs all git himself; **git commands only for larger
  changes** (small fixes wait unless he asks); every release on its own branch + PR; no assistant/AI mentions in
  commits or PRs; personal project: nothing saved in the assistant's memory, no EOD logging, this file is the memory.

## 0. ▶ Resume here (where we stopped on 2026-11-24)

**v0.15.0 Google Calendar + Gmail built 2026-11-24, handed to the owner to push** (branch `release/v0.15.0-google`).
Owner chose Gmail **send only** (reading the inbox needs Google's restricted scopes and a paid yearly assessment, and
Google forbids passing mail to AI services that may train on it). Details: ARCHITECTURE 5k. What was built:
1. **Connect Google** (Settings → Connections): separate OAuth on client "VESPER web" with PKCE, `access_type=offline`,
   scopes `openid email calendar.events.owned gmail.send`; Google's tick boxes decide what's offered; tokens encrypted
   with new secret `GOOGLE_TOKEN_KEY`; reconnect when Google ends it (7 days in testing); disconnect revokes.
2. **Calendar reading**: `calendar_events` (the user's zone; declined / free / all-day marked) and `calendar_free_time`
   (worked out by the server: busy events merged and subtracted from the day's hours).
3. **Events and emails with approval**: `calendar_create_event` (clashes, guests → invitations only on Approve, Meet)
   and `gmail_send` (editable on the card); cautions for addresses not typed, others' text, private data; at most 3 per
   answer, 10 pending; 24 h expiry; log line 90 days; daily limits 20 + 20 (admin settings); admin switch
   "Google Calendar and Gmail for users" **off** until the owner has tried it.
4. **Migration `0014_google.sql`** (add-only), prompt rules, admin section + Users tab counts, tool icons and wording.
5. **Tests**: 294 (12 new: 11 in `tests/google.test.ts`, which uses a fake Google, and the migration guard's check for
   0014; the tool-list test updated). Also fixed: "refuses OpenRouter models that are not free" (tests/api.test.ts)
   made a real internet request, which made it slow and sometimes time out; it is faked now. Headless Edge against
   `wrangler dev` + `scripts/mock-llm.mjs` (now also a fake Google under `/google`): connect through the real pages,
   free time (correct: skipped the fake 10:00 standup and 14:00 call), event card with the clash → Approve → the fake
   Google got 14:30 Asia/Karachi, 1 guest, sendUpdates=all; email edited on the card → the edited subject arrived
   (UTF-8 encoded); phone light after reload; only the usual pre-login 401. Fixed during the check: edits made while
   the answer was still being written were lost when the message was saved (now kept per card).
6. Docs (README, ARCHITECTURE 5k, CONFIGURATION, this file), version 0.15.0.

**v0.15.0 setup (owner, one step at a time; no billing anywhere):**
1. Google Cloud → project **VESPER-AI** → APIs & Services → Library → enable **Gmail API**, then **Google Calendar API**.
2. Google Auth Platform → Clients → **VESPER web** → Authorized redirect URIs → add
   `https://ai-assistant.vesper-ai.workers.dev/api/connections/google/callback` → Save.
3. Google Auth Platform → Data access → Add or remove scopes → add `…/auth/calendar.events.owned` and
   `…/auth/gmail.send` → Update → Save (note which tier the console shows for each).
4. On the PC: make a key with the PowerShell line in CONFIGURATION section 5; Cloudflare → Workers → ai-assistant →
   Settings → Variables and Secrets → add **Secret** `GOOGLE_TOKEN_KEY` = that value → Deploy.
5. Live test: Settings → Connections → Connect Google (pick the account, tick both) → "Connected as …"; ask "what's on
   my calendar this week?" and "when am I free tomorrow for an hour?" (compare with Google Calendar); "add a test event
   tomorrow at 15:00" → card → Approve → it appears in Google Calendar; "email <your other address> a test" → edit the
   subject on the card → Approve → it arrives with the edited subject. Then decide on "for users".

**v0.14.1 charts + CSV download (live since 2026-11-24, PR #18, merge `fcbb551`).** Owner: "go with your
recommendation". What was built (details in ARCHITECTURE 5j, "Charts and CSV downloads"):
1. **Whole result with the answer:** `query_table` returns `table` (TableResultDto: columns with kind/type/by/op/unit,
   exact rows, `total`, `matched`, notes); the agent puts it on the tool step, so it streams, is saved in
   `messages.tools` and comes back on reload. No migration. Up to 500 groups (default 100) or 200 listed rows (default
   20); the model still sees ≤ 7,000 characters. Caps: 40,000 JSON characters per result (`MAX_KEPT_RESULT_CHARS`),
   120,000 per answer (`MAX_TABLE_RESULTS_CHARS`; a later result keeps only its chip).
2. **Chart choice** (`web/lib/table-result.ts`, plain logic): date periods complete or in order → a line (empty
   periods 0 for counts/sums, gaps for averages/medians/lowest/highest; > 1,500 periods → table); rankings and other
   single groupings → bars; a date period × ≤ 4 values, complete → one line per value with a legend; single figures
   get no card; listed rows → table.
3. **Card** (`components/TableResultCard.tsx`, own SVG/HTML, no chart library): title = what was calculated,
   "file · from N rows", Chart/Table switch, figure picker, hover/tap crosshair readout, arrow keys + spoken readout,
   "Show all" for > 15 bars, notes ("Showing the first N of M groups", empty cells), **Download CSV**. Colours
   `--chart-1…4` in styles.css (violet accent, orange, aqua, yellow), validated for colour-blind separation on the
   card surface in light and dark.
4. **CSV:** exact values, Yes/No, ISO dates ("2026-03-05 14:30"), weekdays by name, hours as 14:00, quoting, formula
   guard (leading apostrophe on text starting with = + - @), CRLF, byte-order mark (Excel + Urdu), file name
   "file - what was calculated.csv".
5. **Prompt + tool description:** the model is told results appear under its answer as a chart/table with a download,
   so "make a chart" / "give me a file" means running the right calculation, never drawing in text or saying it can't.
6. **Tests:** 282 in all (8 new: kept result and units, size caps through a chat turn, which results get a card, chart
   choice, period filling, wording, CSV and file name). Headless Edge against `wrangler dev` + mock (regular user):
   bars, line with picker + hover readout, one line per region, rows table, Table view, both CSV downloads checked
   byte for byte (BOM, CRLF, exact values), phone light, keyboard readout, reload keeps the cards; only console error
   the usual pre-login 401. Typecheck + build ✔️. Fixed during the check: phone heading squeezed by the switch (now
   wraps), "no figure" widening the bar column (now "–", read out as "no figure").
7. Docs (README, ARCHITECTURE 5j, CONFIGURATION, this file) and version 0.14.1.

**v0.14.1 live test (after the merge):** (a) /api/health shows 0.14.1; (b) in a chat with a real file ask "total
<amount> by month": a line chart under the answer, hover a point, switch to Table; (c) "total <amount> by <text
column>": bars; (d) "list the rows where …": a table; press **Download CSV** and open the file in Excel: same values,
Urdu/accents readable; (e) on the phone: card fits, Chart/Table switch below the title; (f) reload the chat: the
cards come back.

**v0.14.0 data analysis (live since 2026-11-24, PR #17, merge `a60b5ce`).** Plan approved by the owner (10 steps,
defaults above). What was built:
1. **Reading** in the browser (`web/lib/table-read.ts` pure logic, `table-file.ts` file + SheetJS, `table-reader.worker.ts`
   background worker, `lib/tables.ts` worker + upload): CSV/TSV (separator sniffed, `sep=` hint, quotes, UTF-8 /
   UTF-16 / Windows-1252), Excel .xlsx/.xlsm/.xls and .ods (SheetJS CE **0.20.3 from cdn.sheetjs.com**, pinned with
   its integrity hash; the npm copy is outdated). Header row found (title rows skipped), one type per column (number,
   date, yes/no, text; ≥ 90% fit, ≤ 1 or 2% misfits left empty and counted), "$1,200" / "(45)" / "12,5%" / "1.234,50"
   (decimal comma per column) / ISO, slashed (day-month order per column; ambiguous → browser language) and named-month
   dates; codes like "00123" stay text; "n/a", "-" empty; trailing "Total" row left out with a note; subtotals noted.
   Excel day numbers converted without time zones (1900 leap-year bug, 1904 system), % formats → percent units,
   currency formats → unit. Rows stored as `[row number, cells…]` in blocks of ≤ 500 rows and ≤ 200,000 **bytes**.
2. **Storage**: migration `0013_data_tables.sql` (add-only): `data_files`, `data_tables`, `data_chunks`,
   `messages.files`, `user_usage_daily.tables`. Deleting a chat deletes its files; unsent ones go after 24 h (cron) or
   at once when removed from the composer (today's count given back).
3. **Upload API** (`routes/files.ts`): create (overview, 512 KB cap) → chunks (≤ 240 KB, 3 at a time, retried, safe to
   repeat) → complete (all blocks and the exact row count) → linked to the chat when the message is sent. Owner only.
4. **Composer**: the paperclip takes images and spreadsheets (one per message, 5 per chat); chip shows Reading… →
   Uploading n% (bar) → "N rows · M sheets"; the sent message keeps a chip. Cloud models only (Ollama and deep
   research refuse files with a message).
5. **Tool `query_table`** ("Table analysis", `tools/tables.ts`): filters, grouping (value; dates by year, quarter,
   month, week starting Monday, day, weekday, hour), count / count distinct / sum / average / min / max / median,
   sorting, limits, or listing rows with their spreadsheet row numbers. SQL built from fixed parts over
   `json_each(data_chunks.rows)`, every value bound; text matching ignores case; "2026" / "2026-03" filter whole
   periods. Results ≤ 7,000 characters (rows dropped from the end with a note).
6. **Prompt**: "Files in this chat" with each table's overview (T1, T2…; ≤ 6,000 characters for all, shortened step by
   step), marked as data; rules: every figure from the tool, say what it covers, use the units. Without the tool the
   prompt says it can't calculate. No automatic web search in chats with a table ("sales in 2026" is about the file).
7. **Under the answer**: a source chip "file · what was calculated" (kind `table`, always listed, visible to users);
   results kept as evidence, so Check and the admin number check work.
8. **Admin**: Spreadsheets switch (on), per user per day (10), **rows read for calculations per day (2,000,000)** with
   "Used today"; Users tab shows today's spreadsheets. Found while measuring: D1 counts every JSON row a query walks as
   a row read and grouping reads them again (50,000 rows → ~100,000 rows read, 135 ms locally). D1's free 5 million
   reads a day are shared by the whole app and every query fails once they're used, so calculations got this share
   (estimate checked before, real `meta.rows_read` counted after; counter `tables:rows_read` in `rate_limits`).
9. **Tests**: 274 in all (16 new in `tests/tables.test.ts`; two tool-list tests updated; the migration guard adds one
   for 0013). Headless Edge against `wrangler dev` + `scripts/mock-llm.mjs` (which can now call the table tool):
   attach CSV → "8 rows" chip → question → exact grouped sums, source chip, message chip; desktop dark, phone light,
   admin section; no console errors (the worker runs under the strict CSP). Typecheck + build ✔️.
10. Docs (README, ARCHITECTURE 5j, CONFIGURATION, this file) and version 0.14.0.
Also fixed on the way: the admin Save button now also waits for a valid "GitHub changes per user per day".

**v0.14.0 live test (owner: "later"; one step at a time):** (a) /api/health shows 0.14.0 ✔️ (2026-11-24); (b) Admin panel → App
settings: "Spreadsheets (CSV and Excel)" on, 10 per day, rows read 2,000,000, "Used today: 0"; (c) in a new chat attach
a small real Excel or CSV file (a few hundred rows, with a date and an amount column): chip shows the right row count;
(d) ask "total <amount> by month" and "top 5 <names> by <amount>": compare with Excel's own totals (SUM / a pivot
table); the chip under the answer says what was calculated; (e) ask a follow-up in the same chat (no re-upload); (f)
press Check on one answer; (g) delete the chat (its file goes with it). Note "Used today" in the admin panel after.

**v0.13.1 (live since 2026-11-24, PR #16, merge `1370123`)**: (1) **write-access rule** (branch `release/v0.13.1-write-access-rule`): (1) **write-access rule** (owner asked, after opening GitHub changes to users): every change, issues and comments too, is prepared only in repos the user's own account can write to (`canWrite` in `tools/github-actions.ts`: push/maintain/admin), and `executeGithubAction` checks it again before sending ("can no longer write … Nothing was sent"); so nobody can use VESPER to post in someone else's public repo, VESPER-AI included. (2) **No automatic web search for GitHub code requests** (`planPrefetch` skips when GitHub tools are offered and the message names a repo: owner/name, github.com link, repo/PR/commit/branch/README words, #number or a file name). 257 tests (1 new GitHub test, 1 new unit test), typecheck, build.
**State:** Live is **v0.13.1** (since 2026-11-24). Before it v0.13.0 (GitHub changes with approval; PR #13, merge `cacce3d`, deployed 2026-11-21). Actions app
set up by the owner 2026-11-21: app "VESPER AI Actions" (slug `vesper-ai-actions`, first only on his account, made public the same day; private key under Credentials → Key pairs, unused), 3 Cloudflare settings added, connected as @RajaFarazTariq with VESPER-AI chosen. **Live test ✔️ (2026-11-21):** (a) issue #14 "Test from VESPER" approved → created; (b) comment on #14 rejected → nothing sent (card showed the "text by others" warning after github_issues, as designed); (c) PR #15 from `vesper/update-readme-version-for-approval-test-7f21`, one-line README diff, CI green (owner to close it unmerged and delete the branch, and close #14); (d) Recent changes listed all three. **Found:** (c) also ran the automatic web search (prefetch) because "Current version" looks time-sensitive (`planPrefetch` → `isTimeSensitive`), adding 3 unrelated chips and using a search. Small fix proposed (v0.13.1): no prefetch when the message names a GitHub repo (owner/name or github.com link) and GitHub tools are offered.
Before it: v0.12.4 (cleaner sources + GitHub line links; PR #12, merge `d08213f`, deployed 2026-11-20).
Owner decided 2026-11-21 (after comparing security, users, accuracy and admin control): a **separate "Actions" GitHub
App**, installable **only on the owner's account** at first. The workers.dev address stays as it is (owner, 2026-11-21:
renaming was discussed and dropped).
Before v0.12.4: v0.12.3 (sign-in orbit animation; PR #11, merge `f94ffa3`; owner looked: "it's good"). The README
rewrite PR #10 is merged (`3cbcfd1`).

**v0.13.0 (owner approved the 10 steps + "separate app", 2026-11-21):**
1. **Two apps, two connections.** Reading stays on "VESPER AI Reader" (`github_connections`). Changes use a second app
   (`GITHUB_ACTIONS_APP_*`, table `github_action_connections`, tokens sealed with owner `actions:<userId>` so the two
   kinds can't be swapped). Settings → Connections has two parts ("GitHub" and "GitHub changes (with your approval)",
   each with its own Connect / Choose repositories / Disconnect) plus **Recent changes** (last 20). Routes:
   `/api/connections/github-actions/{start,callback,disconnect}`; back to `/?github=actions-connected`.
   `routes/connections.ts` handles both kinds; `tools/github-client.ts` shares the token renewal (`tokenSource`) and
   adds `githubWriter` (no cache, ≤ 20 requests, explains "not chosen for changes").
2. **Three tools that only prepare** (`tools/github-actions.ts`, risk `"approval"`, offered only when the Actions
   connection works): `github_create_issue`, `github_comment`, `github_open_pr`. They check the repo with the Actions
   token (archived → no; issues off → no; PR needs push access, no forks), store the change in `github_actions`
   (`payload` = exactly what will be sent, `preview` = what the card shows) and tell the model "waiting for the user's
   approval; never say it's done". Limits: 3 per answer, 10 waiting per user, 24 hours to decide.
3. **Pull requests from exact edits:** existing files only by `edits` (find text must appear exactly once, no
   overlaps, CRLF kept), new files by `new_content`; ≤ 5 files, existing ≤ 100 KB, new ≤ 50 KB, whole diff ≤ 1,500
   lines (bigger → refused, never shown in part); `.github/workflows` refused (needs a permission the app doesn't
   have). `applyEdits` builds the unified diff itself (3 lines context, joined lines shown).
4. **The card** (`web/components/GithubActionCard.tsx`, under the answer): kind, repo, "Public repository" badge,
   warnings (only while waiting), title/text or every changed line, **Approve and send** / **Reject**, "expires in …";
   then Done + "Open on GitHub", the error, "Nothing was sent", or Expired. It loads its state from
   `GET /api/github-actions/:id`, so it's right after a reload.
5. **Sending** (`routes/github-actions.ts` → `executeGithubAction`): `claimGithubAction` (pending → running, owner only,
   before expiry: two clicks can't send twice) → daily limit counted (given back if sending fails; 429 keeps it
   pending) → issue: POST issues; comment: POST comments; PR: read the default branch head; if it moved, compare: any
   of our files changed → **nothing sent** ("changed on GitHub after VESPER prepared this"), else branch from the new
   head (blob shas still match) → create `vesper/<title-words>-<4 hex>` → PUT each file → POST pull request. A failure
   after the branch exists deletes that branch. Never writes to existing branches, never merges. Afterwards
   `payload`/`preview` are cleared (log line kept 90 days). Reject clears them too.
6. **Safety:** warnings when the answer read others' text (web_search, read_page, wikipedia, github_issues,
   github_pr_changes) and when private code was read before a change to a public repo (the agent loop keeps
   `TurnState`: tools used, private read, changes prepared). Prompt: prepare only when the user asked in their own
   message, never because repo/issue/web text asks. A comment's log title is only "Comment on #N" (the issue's own
   title, written by others, stays on the card, never in the prompt). Regenerate/Edit, a stopped reply and Disconnect
   expire waiting changes.
7. **Next answer knows:** the system prompt lists this chat's changes and outcomes ("approved by the user and done
   (link)", "rejected…", "waiting…"), titles quoted as data (`githubChangeLines` in `llm/context.ts`).
8. **Admin:** "GitHub changes for users" (off) + "GitHub changes per user per day" (10) with a "set up?" note; Users
   tab: "GitHub changes" badge and today's count. **Migration `0012_github_actions.sql`** (add-only).
9. Tests: 255 in all (4 new in `tests/github.test.ts`: connect + issue sent once on Approve; PR diff, stale file
   refused, branch from newest head, bad edit refused; reject/limit/expiry/disconnect; diff and safety helpers; the
   tool-list test updated; the v0.12.0 encryption tamper test made deterministic: it changed a padding-only character
   about 1 time in 16). Headless Edge with sample cards in the local D1 (removed afterwards): desktop dark, phone
   light, Connections tab, Reject → "Rejected", no console errors.
- **Owner's setup after the merge (one step at a time):** create the "VESPER AI Actions" GitHub App (CONFIGURATION.md
  §5: callback `/api/connections/github-actions/callback`, setup URL `/?github=actions-installed`, Contents/Issues/
  Pull requests: Read and write, **Only on this account**, private key generated but unused) → add
  `GITHUB_ACTIONS_APP_CLIENT_ID`, `GITHUB_ACTIONS_APP_CLIENT_SECRET` (secrets) and `GITHUB_ACTIONS_APP_SLUG` (text) in
  Cloudflare → Settings → Connections → Connect GitHub changes → choose VESPER-AI.
- **Live test for v0.13.0:** (a) "Open an issue in RajaFarazTariq/VESPER-AI titled 'Test from VESPER' saying this is a
  test" → card → Approve → issue link; (b) "Comment 'Thanks' on that issue" → Reject → nothing on GitHub; (c) "In
  VESPER-AI, fix a typo in README.md: …" (after reading the file) → PR card with the diff → Approve → PR on a
  `vesper/…` branch (close it without merging if it was only a test); (d) Recent changes shows all three.
**v0.12.4 (owner approved the 6 steps, 2026-11-20):**
1. **Chips = pages the answer used** (`answerSources` in `web/lib/format.ts`, browser only, also for old answers):
   search results (`web_search`, `github_search`) show only when the answer links to them; sources from tools that
   fetch one thing (read_page, Wikipedia, weather, currency, GitHub file/issue/PR, the research plan's cited list)
   always show; a search result that was also read counts as used. The rest fold behind **"+N other results
   checked"** (click → shown fainter, "Show fewer"). An answer that links none of its sources keeps them all.
   The same page found twice (www., trailing slash, `utm_*` differences) is listed once; GitHub line ranges stay
   separate. Document pages still follow `citedSources`.
2. **Same site twice** (`chipLabels`): "pbs.gov.pk · Census 2023" (page title without its site-name ending; the
   address's last part when the titles are the same). Single sites still show just the site.
3. **GitHub line links** (`githubLineLinks`, applied when an answer is shown): `#L9-13` → `#L9-L13`; a plain
   reference next to a file the answer read ("path L9–13", "`file.ts` (lines 9-13)", "path:42"; a bare "L9–13" or
   "(L7)" only when one file was read and not right after another file's name) becomes a link at the exact commit.
   Code blocks, inline code and existing links are left alone. Prompt line in `llm/context.ts` now says to keep the
   URL and change only the ending to `#L<first>-L<last>`, and to write every line reference as a link.
4. The Check button / fact check and the stored data are unchanged (display only, plus the prompt line).
5. Tests: 250 in all (8 new in `tests/units.test.ts`; one caught "other.ts L4–5" being linked to the wrong file; fixed). Checked
   in headless Edge with a saved sample chat in the local D1 (removed afterwards): census answer → 3 chips
   (pbs.gov.pk ×2 with titles, Wikipedia) + "+3 other results checked" (Instagram, Dawn, PBS home); GitHub answer →
   `#L9-L13` repaired, "src/worker/llm/verify.ts L20–31" and "L125–140" linked; phone width fine; no errors.
- **Live check for v0.12.4** (after it's pushed): ask the census question → only the linked pages as chips, the rest
  behind "+N other results checked"; ask about a file in VESPER-AI → line links open GitHub with the lines highlighted.
**README rewritten** (docs only, no version change; branch `docs/readme-rewrite` + PR #10): what VESPER is, how it
differs, features, how it works (diagram), install/setup (incl. the GitHub App), using it, development, security,
troubleshooting; `.env.example` lists the 4 GitHub App settings. **GitHub App set up by the owner (2026-11-20):**
"VESPER AI Reader" (slug `vesper-ai-reader`, owned by RajaFarazTariq, installable by any account; a private key had to
be generated for installation, VESPER doesn't use it), 4 Cloudflare settings added (`GITHUB_APP_SLUG` as a plain
variable, the others as secrets), the owner connected and chose only **VESPER-AI**. First live test ✔️: "What does
src/worker/llm/verify.ts do?" answered correctly from commit `8781ec4` with line links (two links used `#L9-13`
instead of `#L9-L13`, one line reference was plain text → small fix planned with the source-chip cleanup).
Earlier: v0.12.2 via PR #9, v0.12.1 via PR #8, v0.12.0 via PR #7 (migration 0011), v0.11.0 via PR #6 (migration 0010), v0.10.1 via PR #5,
v0.10.0 via PR #4 (migration 0009), v0.9.10 via PR #3, v0.9.9 via PR #2, v0.9.8 via PR #1.
**How the owner pushes (his preference, 2026-11-20):** git asks for the username and token; nothing is typed into the
command: `git -c credential.helper= push -u origin <branch>` → Username `RajaFarazTariq`, Password = the token. If it
fails with "No anonymous write access" without asking (VS Code's terminal swallowed the prompt), use
`$env:GIT_ASKPASS = ""; git -c credential.helper= -c core.askPass= push -u origin <branch>`. Always run git from the
project folder (a new VS Code terminal may open in `C:\Projects`, another project).

**Logo (owner's choice, 2026-11-20): "Mark V5 · faceted blades"**, built in **v0.12.1**: a dark rounded-square tile
with a thin light border; the V is two blades (left white/light lavender, right violet), hollow cyan circuit nodes at
both top ends, a solid cyan orbit ring across the middle (tilted, a cyan node at its left end) with a dotted second
orbit, a white four-point sparkle at the orbit's right end, tiny corner dots. Wordmark: VESPER in widely spaced
capitals; under it a cyan ring, a teal line and "AI AGENT" in small spaced warm-orange capitals. Files:
`public/logo.svg` (full mark, 120 viewBox: sign-in brand panel 120 px, welcome screen 56 px) and `public/favicon.svg`
(simplified for small sizes: wider blades, thinner single orbit, no dotted orbit or corner dots; browser tab, sidebar,
mobile header, message avatar). The brand name uses letter-spacing 0.16em in the app, 0.32em in the sign-in wordmark
(`.auth-wordmark`, `.auth-tagline` in `styles.css`). Redrawn as SVG from the owner's chat pictures (no source files).
**v0.12.2 (owner, 2026-11-20: "in light mode, its interior should be bright"):** the mark is now drawn inline by
`components/VesperMark.tsx` (`full` = detailed, default = simplified) with colours from the `--vm-*` variables in
`styles.css`: light mode = bright tile (#fff → #e9e7f7), dark-ink left blade, violet right blade, deeper cyan,
violet sparkle; dark mode and the always-dark sign-in brand panel = the dark version. `public/favicon.svg` (browser
tab) switches by the browser's own light/dark setting (`prefers-color-scheme` inside the SVG; works for the tab icon,
checked as an image; opening the file directly shows it black because of the site's style-src policy, which doesn't
matter). `public/logo.svg` stays as a standalone dark brand file (not used by the app).
**v0.12.3 (owner, 2026-11-20: "animate the logo on the sign-in page: small circles orbiting around it; keep the
logo unchanged and centred, the animation around it, not over it"):** the three small circles of the brand panel
(`BrandPanel` in `LoginPage.tsx`) each sit in a `<g class="auth-orbiter">` that turns around the centre of the
340 × 340 drawing (`transform-box: view-box; transform-origin: 50% 50%`, keyframes `auth-orbit-turn` in
`styles.css`): inner line 32 s per turn, middle 50 s, outer 76 s, all clockwise (about the same speed on screen).
One small violet circle (`--sc-violet`, `.auth-planet-violet`) was added on the middle line, travelling with the
bright cyan one, to fill the empty lower right. The logo, the lines and the halo don't move; the circles never
cross the logo (inner line r 80 px, the tile reaches about 73 px from the centre). Reduced motion → the circles
stay where they always were. CSS only, so the strict CSP is untouched. Checked in headless Edge at 1366 px under
the live CSP (`wrangler dev` after `npm run build`): circles stay on their lines and move at the planned speeds,
the logo's position is unchanged, no console or CSP errors; reduced motion keeps them still. Typecheck + build ✔️.

**Owner decision (2026-11-21, updated the same day): GitHub changes open to users.** After asking whether others could touch his repo (answer: no; each user acts only through their own GitHub account, on repos GitHub lets them change; nobody else can write to VESPER-AI; on a public repo anyone can already open issues/comments on GitHub itself), he chose to: make "VESPER AI Actions" public (Advanced → Danger zone → Make public; can't be made private again once others install it), and switch on "GitHub for users" + "GitHub changes for users" (limit 10/day).
**Rules in force:** a **branch protection rule for `main`** (exact ticks not confirmed yet; see section 2), so
**`main` can't be pushed to directly**: every change, docs included, goes on a branch + PR. The owner replaced the
GitHub token (confirmed 2026-11-19). `.dev.vars` key lines were empty on 2026-11-20.
**Order (owner, 2026-11-20):** v0.10.1 ✅ → v0.11.0 ✅ → v0.12.0 GitHub read-only ✅ → v0.12.1 new logo ✅ → v0.12.2
logo in light mode ✅ → README rewrite (PR #10) ✅ → v0.12.3 sign-in orbit animation (owner's request) ✅ → v0.12.4
cleaner source chips + GitHub line links (PR #12) ✅ → v0.13.0 GitHub changes with approval, separate Actions app
(PR #13) ✅, set up + live-tested ✅ → v0.13.1 write-access rule + search fix (PR #16) ✅ → v0.14.0 data analysis
(PR #17) ✅ → v0.14.1 charts + CSV download (PR #18) ✅ → v0.15.0 Google Calendar + Gmail send (built 2026-11-24, to
push). Proposed next (owner to choose): two small v0.14.1 fixes, Excel in the knowledge base, changing/cancelling
events.
**Pending owner checks:** v0.15.0 setup + live test (section 0); v0.14.1 live test (Download CSV in Excel, Table, phone, Check); v0.14.0 live test steps (b)–(g) (above); v0.13.0 setup + live test (above); v0.12.4 live check; GitHub live test steps 2–4 (closed PRs list, review PR #9, Check), then switch on "GitHub for users"; v0.12.2 quick look in light and dark mode; v0.11.0 live test steps (b)–(d), v0.10.1 quick look at a table, v0.9.9 live research test, v0.9.10
quick look, 👍/👎 (v0.9.7), 🎤 voice input (v0.9.6), branch-protection ticks.

**v0.10.0 live test (owner, 2026-11-20):** ✔️ phone number refused with the reason; memories "planning a trip to
Skardu in Dec or Jan" (edited) and "favourite colour is Black" (saved in chat); "What should I pack for my trip?" →
a winter packing list for Skardu Dec/Jan using the weather tool (−0.2 °C, lows −3.6 °C) and suggesting black gear
(both memories sent: the list is short, ≤ 800 chars). Found: (1) the model's `<br>` in table cells showed as text;
(2) table columns broke words mid-word ("Catego ry"); (3) admin number check flagged general-knowledge numbers
("SPF 30", "230 V") → to be handled in v0.11.0.

**v0.10.1 (built 2026-11-20, owner approved):** `remarkLineBreakTags` (`web/lib/markdown.ts`, used by both Markdown
renderers) turns only `<br>`/`<br/>` into real line breaks (other raw HTML still shows as text); table cells use
`overflow-wrap: break-word` + `min-width: 6.5rem` (`.md th/td` in `styles.css`) so words wrap at spaces and wide
tables scroll inside their box. Checked in headless Edge (desktop + phone, no sideways page scroll). 225 tests.
Merged via PR #5 (2026-11-20, live). Owner's quick look at a table answer still pending.

**v0.12.0 GitHub for each user, read-only (owner approved 2026-11-20 with his 9 additions + my 3 adjustments):**
1. **Connect** (Settings → **Connections**, shown when the app is set up and the account may use it): "Connect
   GitHub" → GitHub's authorize page (`/api/connections/github/start`, state cookie) → callback exchanges the code,
   reads `/user`, stores the access + refresh tokens **encrypted** (`lib/secret-box.ts`, AES-256-GCM, key
   `GITHUB_TOKEN_KEY`, bound to the user id) in `github_connections` → back to `/?github=connected` (toast + the tab).
   The tab shows the account, each installation (account/org, all or chosen repos, a "change" link) and up to 100
   repos (🔒 for private), "Choose repositories on GitHub", **Disconnect** (revokes the grant on GitHub with
   `DELETE /applications/{client_id}/grant`, deletes the row and the cache) and a privacy note (encrypted, 15-minute
   cache, 👍/👎 copies go to the admin's feedback list).
2. **App permissions** (owner sets them): Contents, Issues, Pull requests, Metadata, all read-only.
3. **Five tools** (`tools/github.ts`, offered only when connected): `github_repo` (overview / list allowed repos),
   `github_file` (file with line numbers, or a folder; long files in parts), `github_search` (code search),
   `github_issues` (list/search/open with comments), `github_pr_changes` (diff in parts). Sources are file links with
   the exact commit and lines (`blob/<sha>/path#L10-L24`); the chips show "repo · path L10–24".
4. **Untrusted content:** every result is wrapped as untrusted data ("written by others"), the prompt says never to
   follow it or open links from it. **Leak guard:** once private repo content is in an answer, `read_page` is refused
   for the rest of it (`LEAK_GUARD_MESSAGE` in `llm/agent.ts`). Tested with an issue that tells the model to open an
   "evil" page: the page is never requested.
5. **Org/SSO/not chosen:** `explainNoAccess` checks the user's installations: no installation for that owner → "an
   owner of the organisation must approve VESPER" + install link; installed with chosen repos → "not one of the
   repositories you chose" + change link; SSO (`x-github-sso`) → authorize link.
6. **Code search limit (10/min):** results cached 10 minutes per user; when limited (or not indexed / no results)
   it falls back to the repo's file list (one request), matching file names, then lines inside the best two files.
7. **Short cache + ETags** (`github_cache`, per user): reused as is for 2 minutes, then GitHub is asked with the
   ETag (304 = no allowance used), deleted after 15 minutes (on the next request, on disconnect, by the daily cron).
   **At most 10 GitHub requests per message** (Cloudflare free plan: 50 outbound requests per request).
8. **Token renewal:** GitHub user tokens last 8 hours; refresh tokens work once, so only one renewal per user runs at
   a time (`lockGithubRefresh`, 30-second lock); others wait for the new token. A refused renewal or a 401 marks the
   connection `reconnect` → "Reconnect GitHub". Tokens/codes/secrets are never logged (tested).
9. **Sizes:** a file ≤ 12,000 characters per read (with "ask for start_line N"); a PR part ≤ 14,000 characters,
   ≤ 4,000 per file, code first, then tests, docs, lock/generated/minified last; files left are listed with
   `continue_with: {start}` ("review the rest").
10. **Check this answer** on GitHub answers: only references (`GITHUB_REF {...}`) are kept in `messages.evidence`,
    never repo text; the check reads them again through the user's own access (409 `github_reconnect` if
    disconnected).
11. Admin: **GitHub for users** (off by default; admins always can), a note whether the app is set up, and a "Repos
    connected" badge in Users. Research mode doesn't use GitHub.
12. 243 tests (8 new in `tests/github.test.ts` + the migration check), typecheck, build. Checked in headless Edge
    with a local fake GitHub + fake model: connect flow, Connections tab (desktop + phone), a file answer with its
    chip, admin switch.
- **Live test for v0.12.0** (after the owner creates the GitHub App and adds the 4 secrets): as admin, Settings →
  Connections → Connect GitHub → authorize → "Choose repositories on GitHub" → pick VESPER-AI → ask "What does
  src/worker/llm/verify.ts do in RajaFarazTariq/VESPER-AI?", "List the open pull requests in …", "Review PR #6 in
  …" → press Check under one answer. To confirm live: whether repos that weren't chosen but are public can be read.
  Then switch on "GitHub for users" if wanted.
- **Write actions:** built in v0.13.0 with a separate Actions app (see the top of this section); the reading app stays
  read-only.

**v0.11.0 Answer verification (approved and built 2026-11-20):**
1. **Sources kept with the answer:** an answer that used a look-up tool (web search, read page, Wikipedia, knowledge
   base, weather, currency; plus the calculator/date results of that turn) or deep research keeps what those sources
   returned in `messages.evidence` (≤ 20,000 chars, each source a fair share, `packEvidence` in `llm/verify.ts`).
   Never sent to the browser; the browser only gets `checkable: true`.
2. **"Check" button** under such answers (action row, shield icon) → `POST /api/answer-check/:messageId`: 1 model
   request (Auto chain, **non-Groq first**, no tools, answer + sources as data, ≤ 14,000 chars of sources) lists the key
   claims (≤ 8) as JSON; each is **Supported / Contradicted (with what the source says) / Not in the sources**, with
   its source. A named source is shown only if the answer really used it (or its address is in the kept sources):
   no made-up links. The result is saved (`messages.verification`); asking again returns it free. Shown as a
   "Fact check" card under the sources (open right after checking, folded when the chat is reopened). Users don't
   see which model checked (`by`, admins only). Only your own, finished answers; 400 `no_sources` when nothing to check.
3. **Deep-research reports checked automatically** (step "Fact check"; +1 model request per run; doesn't use the
   user's daily checks). If the check fails, the report is still saved (step shows it couldn't check).
4. **Smarter number check** (admin-only): a figure no source has is flagged only when its sentence/list item/table
   cell is about the sources (≥ 2 topic words shared with what the tools returned, 1 for a part of ≤ 3 words), cites
   [S1], or has another supported figure. "SPF 30" / "230 V" in a weather-based packing list are skipped and
   counted as "(N general numbers not checked)".
5. **Admin settings** (App settings): **Check this answer** (on), **Answer checks per user per day** (10; admins
   unlimited; counted before the check, given back if it fails), **Check research reports automatically** (on).
   Users tab shows "N answer checks" today. **Migration `0010_answer_verification.sql`** (add-only, revert-safe:
   `messages.evidence`, `messages.verification` NULL-able; `user_usage_daily.answer_checks` DEFAULT 0).
6. 234 tests (9 new + the automatic migration check), typecheck, build. Checked in headless Edge with a local fake
   model (knowledge-base answer → Check → card with 3 verdicts; reopened chat; phone width; admin settings).
- **Live test for v0.11.0:** (a) ask something that searches the web (e.g. "What was Pakistan's population in the 2023
  census?"), press **Check** under the answer, read the Fact check card and open a source chip; (b) a deep-research
  question: the report should end with a "Fact check" card without pressing anything; (c) a plain question ("hello")
  shows no Check button; (d) as admin, the packing-list question no longer flags "SPF 30"-type numbers.
- Answers written before v0.11.0 kept no sources, so they show no Check button (by design).
- **Live test (owner, 2026-11-20), step (a) ✔️:** census question (answered by Gemini after Groq's rate limit;
  number check "All 3 numbers found") → Check → "3 of 3 claims supported": 241.49 million (pbs.gov.pk), 207.68
  million in 2017 (pbs.gov.pk), Wikipedia's 247,541,947 (en.wikipedia.org); checked by gemini-3.5-flash-lite (shown to
  the admin only). Noticed: 9 source chips under that normal-chat answer, incl. pbs.gov.pk three times and
  instagram.com (possible later tidy-up). Steps (b)–(d) still to do.

**v0.10.0 "smarter memory" (built 2026-11-20; owner approved the 6 steps):**
1. **Only relevant memories** go with each message (`selectMemories` in `db/memories.ts`, word matching, no model
   call): pinned ones always + up to 8 that share words with the message and the last 3 user messages (2,000
   characters max). Everything is sent when all memories together are ≤ 800 characters, or when the message is
   about memory itself ("remember", "forget", "what do you know about me"). The prompt says "(Showing N of M saved
   notes…)" so the model knows more exist.
2. Settings → Memory: **pin** ("always use"), **edit** the text, **export** (a .txt made in the browser),
   pinned first. API `PATCH /api/memories/:id` (`content`, `pinned`).
3. **Sensitive data refused** (`lib/sensitive.ts`, used by the remember tool, POST and PATCH): passwords/PINs/keys,
   card numbers (Luhn check), IBAN/account numbers, CNIC/ID numbers, phone numbers (+/0/bracket-shaped 10–15
   digits, or 7+ digits next to "phone/mobile/WhatsApp"). Message: "Not saved: it looks like a phone number…";
   dates, years and prices pass.
4. **Long chats keep context** (`llm/summary.ts`): when the unsummarised messages outgrow the history room
   (MAX_CONTEXT_CHARS 16,000 minus the system prompt minus 1,600), everything but the newest ~60% is summarised
   into ≤ 12 bullet points (≤ 1,600 chars, **1 model request**, Gemini/others before Groq so Groq's minute budget
   is left for the answer), saved on the conversation (`conversations.summary`, `summary_until`) and put in the
   system prompt from then on. Shown as a step "Summarised the earlier conversation". Next summary only after
   several more turns. If it fails, the turn goes ahead the old way (older messages dropped). Not for local models.
5. Memories and summaries are labelled data, not instructions, in the prompt; memories stay per user.
6. 224 tests (8 new: 5 unit + 3 API, plus the automatic migration check), typecheck, build. **Still to do: branch + PR + merge, then the live test.**
- Live test for v0.10.0: Settings → Memory: add "I'm planning a trip to Skardu in June" and "My phone is 0300 1234567"
  (refused with the reason); pin one, edit one, Export; then ask "What should I pack for my trip?" (uses the Skardu
  memory) and "What do you remember about me?" (lists all).

**v0.9.10 (built and merged 2026-11-20 via PR #3, live), from his regular-user screenshots:**
1. **Tools menu cut off** at the top on the welcome screen (it opened upward with no height limit inside the scroll
   area). Now it fits the room on screen, scrolls inside, opens downward when there's more room, and keeps "Manage
   tools" visible. The model menu's measuring code moved into `web/hooks/useMenuLayout.ts`, used by both menus.
   Checked in headless Edge as a regular user (short window and phone width).
2. **Local models (Ollama) hidden from regular users** (owner asked what it is: open models on the user's own
   computer via the Ollama app; too technical for normal users). New admin setting **"Local models (Ollama) for
   users"** (App settings, default **off**). Off: no "Local models" tab in users' Settings
   (`FeaturesDto.localModels`), users' `ollamaEnabled` is treated as off (`effectiveSettings`, also in the save
   response), `ollama:` models aren't allowed for users (`userMayUseModel`), and `/api/chat/local/prepare` refuses
   (`local_models_off`). Admins can always use them. Revert-safe (a settings key; older code ignores it).
3. Tests: 1 new in `tests/api.test.ts`. Quick live look by the owner still pending (Tools menu on the welcome
   screen; a regular user has no "Local models" tab).

**v0.9.8 live research test (owner, 2026-11-19), census question:** ✔️ worked end to end, answered by **Groq**
(gpt-oss-120b); 3 searches, 3 pages read (GHDx, PBS ×2), knowledge base "nothing relevant"; figures right
(241.49 million 2023 vs 207.68 million 2017, +33.8 million ≈ 16%, from PBS); Wikipedia's 247.5 million correctly put
under "Where sources disagree"; every source "date unknown" (none gave a date: honest). Problems found → v0.9.9:
(1) the model cited "(S1)", which wasn't clickable or matched to the list; (2) 16 source chips (every search result,
incl. an unrelated Yahoo article about another country's census, also item 7 in the Sources list); (3) the admin
number check flagged the correct calculation "33.8 million".

**v0.9.9 "research sources" (built 2026-11-20, owner approved):**
1. The model cites with ids ([S2], [S1, S3]); the app turns them into links and renumbers them S1, S2… in reading
   order (`linkCitations` in `llm/research.ts`; 【S1】 and (S1) handled; unknown ids stay plain; a source linked by
   its address counts as cited).
2. The Sources list shows **only cited sources**, labelled S1… to match, plus "N other sources were checked but not
   cited" (if the brief cites nothing, all are listed with a note). The chips under the answer are exactly those
   sources in the same order (they ride on the "Planning the research" step; search/page steps carry none).
3. Number check: a figure that is the difference, sum, percentage change or share of **two figures stated in the
   same answer and supported by the sources** is accepted (`derived` in `llm/number-check.ts`); anything else is
   still flagged (e.g. "35 million", or "33.8 million" when the answer doesn't state the two inputs).
4. 214 tests (2 new: citation linking, calculation check; the research test updated), typecheck, build.
   **Still to do: branch + PR + merge, then the live test** (same census question: [S1] links, only cited sources,
   fewer chips, number check clean).

**v0.9.8 "deep research" (built 2026-11-19; owner approved the plan + 7 additions + my adjustments):**
1. **Research** button in the composer (next to Tools; one-shot, turns off after sending). Admin → App settings →
   Deep research: on/off (on), research runs per user per day (3; admins unlimited), web searches kept for normal
   chat (10). The panel shows how many searches research can use and warns when it's effectively off.
2. **Plan** (model request 1): 2–4 focused queries as JSON (`llm/research.ts`, `parsePlan`; unreadable → the question).
3. **Search**: before the run, 4 searches are **set aside** atomically on the shared daily counter
   (`holdResearchSearches`, never touching the last N kept for chat); < 2 available → refused before anything starts,
   nothing counted. Searches run within the hold; saved results cost nothing; unused ones are **given back**
   (`releaseResearchSearches`). Searches really made stay spent even if the run fails. Knowledge base searched once.
4. **Read**: up to **3** pages (official/trusted first), passages picked by word matching (**no model call**).
5. **Write** (model request 2): **no tools offered**; material wrapped as untrusted; research rules in the system
   prompt (`RESEARCH_RULES` in `llm/context.ts`). The app appends the **Sources** list itself: type, published date
   (Tavily's date or the page's own `article:published_time`-style meta; otherwise "date unknown"; never the
   date-in-snippet guess), checked date (saved searches keep their first date, `search_cache.checked_at`), and
   research notes (e.g. "Only 3 of the 4 planned searches ran…").
6. Progress shown as steps (Planning the research → Web search ×N → Read a web page ×N → answer streams); the
   admin-only number check runs on the brief.
7. Counting: the run is counted at the start (`consumeDailyResearch`) and given back if it fails or is stopped, so
   only finished reports count; the message counts like any message. Regenerate/Edit of a research answer research
   again.
8. **Model requests per run: 2** (plan + write); a provider failure adds one per extra provider tried (+1 retry for
   temporary errors). Cloudflare calls per run ≈ 10–20 (≤ 4 searches, ≤ 3 pages, 2 model calls), under the free
   plan's 50.
9. **Dark theme is now the default** (owner's request 2026-11-19): `web/lib/theme.ts` `DEFAULT_THEME = "dark"`,
   `<html class="dark">` in `index.html` (no white flash); a theme someone picked in Settings is kept.
10. 212 tests (4 new in `tests/web.test.ts` + the automatic migration check) (search and pages faked: full run with dates/no tools/untrusted material,
    10-search reserve + running out partway, atomic hold + give back, failed run not counted). **Still to do: branch
    + PR + merge, then the short live test** (one research question, see below).
- Live test for v0.9.8: new chat → **Research** on → "What was Pakistan's population in the 2023 census, and how does
  it compare with the 2017 census?" → expect the steps, a brief with Short answer / Key findings / What's uncertain,
  and a Sources list with published/checked dates; Admin → Users shows "1 research run"; App settings shows
  searches used today (2–4 more than before).
- Live status of v0.9.7 (pushed 2026-11-19): not yet confirmed by the owner ("checking").

**v0.9.7 "answer feedback" (built 2026-11-19, owner approved the 6 steps):**
1. 👍/👎 under each answer (after Copy / Read aloud), saved at once; clicking the same thumb again takes it back.
2. 👎 opens a small optional box: Wrong facts / Out of date / Didn't answer the question / Other + a note (≤ 1,000
   characters); Skip keeps the 👎 without details.
3. Table `message_feedback` (one row per answer). Each row keeps its **own copy** of the question, answer, provider,
   model and sources, so a 👎 survives Regenerate (which deletes the old answer). Rows go when their chat or user is
   deleted. `PUT /api/feedback/:messageId` (`rating` 1 / -1 / 0), own answers only, 60/min per user.
4. Admin panel → **Feedback** tab: Good/Bad counts per model, filter Bad / Good / All (Bad first), each entry with
   user, date, model, reason, note, question, "Show answer" + its sources, "Load more" (30 at a time).
   `GET /api/admin/feedback?rating=down|up|all&before=`.
5. Users only rate their own answers; only the admin sees the list.
6. 207 tests (1 new + the automatic migration check), typecheck, build. **Still to do: push, then the short live test** (rate an answer 👎 with a
   reason, open Admin → Feedback, check it's listed; press 👍 on another).
- Live status of v0.9.6 (owner, 2026-11-19): image question ✔️, Read aloud ✔️, 🎤 voice input not tested yet.

**v0.9.6 live test (owner, 2026-11-19):** image question ✔️ (the "AUTOMATION" wolf wallpaper read and described
correctly, preview shown in the chat); 🔊 Read aloud ✔️. 🎤 voice input: **not tested yet** (owner will test later).
Docs-only change after the push: this live-test note (push with the next release).

**v0.9.6 "images + voice" (built 2026-11-19, owner approved the 11 steps and defaults):**
1. 📎 attach button + paste + drag-and-drop, up to 3 images per message, previews with ✕ (`Composer.tsx`).
2. The browser shrinks each image to ~1280 px JPEG (and a ~384 px, ~16–20 KB preview) before sending (`web/lib/images.ts`).
3. `/api/chat` accepts up to 4 MB (other routes still 256 KB); the server checks each image's type and first bytes.
4. Image questions go only to models that can see images: Gemini first, then a free OpenRouter vision model
   (picked from the live list). Groq/Mistral/Workers AI are skipped; a manually picked model that can't see images is
   replaced by that chain automatically. Text questions are routed exactly as before.
5. Only the preview is stored (`messages.images`); Regenerate/Edit re-send the preview; older images become a note.
6. Limit: 10 images per user per day (admin setting; admins unlimited but counted, like messages).
7. 🎤 mic: records up to 2 minutes → Groq `whisper-large-v3-turbo` → Workers AI Whisper as backup → text in the box.
   Each user picks the language in Settings → **Voice** (Detect / English / Urdu; Urdu avoids Hindi-script output).
8. `public/_headers`: `microphone=(self)`.
9. 🔊 "Read aloud" under answers (device voices) + optional "Read answers aloud automatically" (Settings → Voice).
10. Limit: 15 minutes of speech per user per day (admin setting; admins unlimited but counted).
11. Done locally: 205 tests (3 new in `tests/api.test.ts`), typecheck, build; headless Edge check with the mock AI:
    image attached (preview 15.9 KB) → answered by Gemini, preview shown in the chat, Read aloud button, fake-mic
    recording → text in the box, phone width without sideways scrolling. **Still to do: push, then the short live test.**
- My own choices within the agreed plan (tell the owner if asked): both switches default **on**; the Voice switch also
  hides Read aloud; welcome screen got two chips ("Understands images", "Voice input"); Admin → Users shows today's
  images and voice minutes; the offline mock (`npm run mock:llm`) now answers speech-to-text too.
- Checked before building (2026-11-19): Groq free STT = 20 requests/min, 2,000/day, 28,800 audio s/day, min 10 s
  billed per request, 25 MB files; Workers AI Whisper turbo takes base64 `audio` and returns `text` +
  `transcription_info.duration`.
- No privacy note in the app (owner's decision). For the record: Gemini's free tier may use uploaded images; Groq
  processes voice recordings; VESPER stores neither the full image nor the audio.

**Live test for v0.9.6 (after the push, ~2 minutes):** new chat, Auto → 📎 a photo + "What is in this picture?"
(expect a Gemini answer and the preview in the chat) → 🎤 say one short question, check the text, send → press 🔊
Read aloud under the answer. On a phone the browser asks for microphone permission the first time.

**Previous release, v0.9.5** (commit `208b3a8`, deployed 2026-11-19; 201 tests at the time). The deploy applied
migration `0005_search_cache.sql` (add-only).

**v0.9.5 "fewer tokens" (built 2026-11-19, owner approved all 10 steps):**
1. **Search first, one request** (`llm/prefetch.ts`): questions that clearly need a look-up ("latest", "current",
   prices, versions, population, years 2024+, "According to X", "does X say") are searched before the first model
   request, and "my PDF/document" questions search the knowledge base first; the results go under the question, so
   the answer takes one request (~9,400 characters ≈ 2,400 tokens measured; fits Groq's 8,000 tokens/min with the
   2,048-token reply allowance). Writing, sums, weather/currency and everything else are left to the model.
2. **Trimmed:** snippets 450 chars (was 600), document passages 800 (was 1,100), shorter tool descriptions and rules.
3. **"Private folders"** (owner accepted this reading): the paired document search keeps only passages sharing ≥ 2
   of the question's topic words; otherwise nothing is added (no tokens on unrelated passages).
4. **Search cache** (migration 0005, table `search_cache`): same search reused for 1 h ("latest" questions) or 6 h;
   saved results cost no search and don't count against the daily cap; the daily cron deletes expired rows.
5. **Dates in text:** when Tavily has no publish date, the first plausible date in the snippet is used
   (`date_in_text`, never a future date).
6. **Fewer weak results:** when an official/government/trusted result has the figure, at most 2 "other website"
   results go to the model.
7. **Warning inside quoting passages:** "[This document quotes X; it is not X's own publication]".
8. **Organisation's own sites:** "According to GitHub…" with none of GitHub's pages in the results → one extra search
   limited to github.com/.org/.blog/.co/.net (counts as a search unless saved).
9. **Welcome screen** (owner's request, same release): the 4 suggestion cards were removed; the greeting, message box
   and capability chips stay.

**v0.9.5 accuracy (local, same PDF, fallback off, same scoring rules):**
| Run | 0.9.4 | 0.9.5 |
|---|---|---|
| Gemini (`gemini-3.5-flash-lite`) | 87.3%, 13/18 fully right | **91.2%, 14/18** |
| Groq (`openai/gpt-oss-120b`) | not measurable (search questions never finished) | **measurable now, first 8 questions only: 95.8% (23/24 checks), 7/8 fully right** (Gemini on the same 8: 87.5%, 5/8). Copilot 5/5, CodeCompose 3/3, Regression Oracle 3/3, PDF Java 2/3, HumanEval 4/4, no-answer 2/2, Python 2/2, Node.js 2/2. Questions 9–18 not scored: Groq's **daily** allowance (200,000 tokens/day, shared with the live site) ran out after question 8, so the run was stopped. |
- Copilot/Java is now right with Gemini too: 46% and **61% from GitHub's own blog** (found by the organisation-site
  search), the PDF's 62% as a correctly attributed note.
- Still imprecise with Gemini: Linux kernel ("7.3" though it cited kernel.org) and Node.js (called Node 22 the main
  LTS line). Groq got Node.js right.

**v0.9.4 live re-test (2026-11-19):**
- Copilot (Gemini Flash-Lite): still says "GitHub's official figures state … 62%" citing the PDF, and puts GitHub's
  real 61% in a note as "third-party reporting". No GitHub page was among the 6 search results (Medium, statistics
  sites, a magazine, arXiv), so the official-page step had nothing to open. The PDF citation is plain text now ✔️.
- "What does my PDF say (Java)" (**Groq** answered: small request, no search, used the earlier messages): "The PDF
  states … 62% (page 4)" ✔️.
- Latest Python (Gemini Flash-Lite): "Python 3.15" citing Wikipedia although python.org was result #1 (its snippet
  already had a figure, so the page wasn't opened); last time 3.15.2 from python.org. No needless "Note:" ✔️.
- Conclusion: the smallest model ignores some rules (R1, R3b) now that the instructions are long; Groq does answer
  when requests are small. **Proposed for v0.9.5** (server-enforced): when an official/government result contains the
  figure, pass at most 1–2 "other website" results; put "[This document quotes X; it is not X's own publication]"
  inside quoting passages' text; optional extra search limited to the organisation's own site when none of its pages
  came back (costs 1 search). Awaiting the owner's decision.

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
1. Health check. `0.9.10` means v0.10.0 isn't merged yet: give him the branch + PR commands (section 0 "How the
   owner wants each task run"). After the merge, watch `/api/health` until `0.10.0`, then the live test (above).
   Ask for the pending checks (v0.9.9 research, v0.9.10 quick look, 👍/👎, 🎤). Ask him to confirm the branch
   protection rule's ticks (section 2), especially that "Require approvals" is **off**. Check the **`.dev.vars` key
   lines are still empty**.
2. Next per the roadmap (propose numbered steps first, as always): **answer verification** (a second look at
   important claims before/after answering), then **GitHub integration** (read repos/issues/PRs; write behind an
   approval gate), then Gmail/Calendar/Telegram.
3. (Done: v0.10.0 Smarter memory, see the top of this section.)
4. Owner said he'll do these later: re-ask on the live site (new chat, model Auto) the Copilot question, "What is the
   latest stable version of Python?" and "What was Pakistan's population in the 2023 census?". Expect Groq (not
   Gemini) to answer most of them, 61% for Java from GitHub's own blog, 3.15.2 from python.org, 241.49 million.
   (Don't re-test on the same day as a local Groq accuracy run: they share Groq's daily allowance.)
   Optional: finish the Groq score for questions 9–18 on a fresh day (the 8 done are in the table above).
4. Older re-test reference (knowledge-base questions; pages checked against the PDF):
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
not built (so no buttons): projects, agents. Images: Regenerate/Edit use the stored ~384 px preview (weak for small
text); image questions never use Groq or Ollama. Open-Meteo's free tier is non-commercial (a
public commercial launch would need their paid plan). Before opening the app to the public: check each AI provider's
free-tier terms for serving other users (not done yet; fine for a few testers).

**How the owner wants each task run (agreed in this session):**
- Before starting: give a **numbered list of steps**; then report each step as done; say at once if a step fails
  or is skipped; never work around problems quietly.
- **Testing: minimal and to the point** (his explicit request): run only the essential checks for what changed,
  fix obvious issues, report what's left. No exhaustive or repeated suites.
- **Document every stage**: update this file, docs/CONFIGURATION.md (every setting/secret/service + the stage log)
  and README/ARCHITECTURE as needed, and bump the version (`src/worker/version.ts`, package.json, package-lock.json).
- **Git commands only for larger changes (his rule, 2026-11-20):** don't give git commands for minor tasks or quick
  fixes. Those stay in the working folder (version bumped, docs updated, marked "built, not pushed" in this file) and
  go out together with the next larger change, unless he asks for the commands. Then the release branch is named
  after the larger change and the commit/PR description lists everything it carries.
- He pushes himself. **Since 2026-11-19 (his rule): every release goes on its own branch** so any release can be
  reverted. Never give "commit straight to main" commands again. The commands, in the project folder (not
  `C:\Projects`):
  1. `git switch main` → `git -c credential.helper= pull origin main` (start from the live code)
  2. `git switch -c release/v<version>-<short-name>` (e.g. `release/v0.9.8-deep-research`)
  3. `git add --all -- . ":(exclude)AI_Assistant_Feature_Roadmap.pdf"` → `git status`
  4. `git commit -m "<accurate title, ≤ 72 chars>" -m "<description paragraph(s): what changed, why, migrations, how
     it was tested>"` (one `-m` per paragraph; no tool/assistant attribution lines)
  5. `git -c credential.helper= push -u origin <branch>` (asks Username `RajaFarazTariq` and the token as password).
     A branch push does **not** deploy.
  6. Open the pull-request link git prints → paste the **PR title and description** given with the commands → wait
     for the green CI check (typecheck + tests + build) → **Merge pull request** (keep "Create a merge commit") →
     that merge to `main` deploys.
  7. `git switch main` → `git -c credential.helper= pull origin main`.
  **To revert a release:** on GitHub open the merged PR → **Revert** → merge the revert PR (deploys the previous
  version). Code only: add-only migrations stay in the database, which is harmless (older code ignores new
  tables/columns). Releases up to v0.9.7 were committed straight to `main` (commits `2fb0c09` = v0.9.6,
  `f01ec7e` = v0.9.7); revert those with `git revert <commit>` on a branch if ever needed.
- After the merge: watch `/api/health` until the new version shows, then confirm.
- This is a **personal project**: don't save anything about it in the assistant's memory system, and no EOD/history
  logging; this file is the memory. Don't touch his office work.
- Explain in **easy, plain words** (no jargon); he asked for that explicitly. Work **fast**: he prefers short status
  updates and few round-trips. Never ask him to paste a token or key into the chat.
- **UI style:** professional, enterprise-grade (see the design rule in section 5).

**Local machine notes:** `.dev.vars` exists in the project folder (git-ignored) with `DEV_LOGIN=true` /
`ADMIN_GITHUB_USERS=admin`. On 2026-11-19 the owner put his Groq, Gemini, OpenRouter and Tavily keys in it for the
accuracy runs and emptied them the same day; he **re-added Groq, Gemini and Tavily keys for the 0.9.5 runs** (later
on 2026-11-19), to be emptied once the Groq run ends: check next session. For each accuracy run he adds them back
temporarily, then empties them. The accuracy runs used two temporary local
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
- Deploys happen automatically: a push to `main` (including merging a PR) triggers GitHub Actions → tests → D1
  migrations → `wrangler deploy`. Release branches don't deploy; pull requests run CI (typecheck, tests, build).
  Release workflow: section 0, "How the owner wants each task run".
- **Branch protection on `main`** (steps given 2026-11-19, to do after the first PR's CI has run once, so the `check`
  status exists): GitHub → VESPER-AI → Settings → Branches → Add classic branch protection rule → pattern `main` →
  tick "Require a pull request before merging" (leave **Require approvals unticked**: he can't approve his own PR) →
  tick "Require status checks to pass before merging" + "Require branches to be up to date", add the check `check`
  (the CI job) → tick "Do not allow bypassing the above settings" → leave force pushes and deletions off → Save.
  Effect: direct pushes to `main` are refused; merges need green CI; merging still deploys. Emergency rollback = the
  PR's Revert button (also a PR). Status: rule for `main` created 2026-11-19; ticks not confirmed yet.
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
| **Source fixes (v0.9.4)**: server reads official pages, "quoting X" labels + R3b, plain document citations, Note only for disagreements, Groq ≤10 s wait | ✅ live (v0.9.4, commit `4758a66`, deployed 2026-11-19; 184 tests); Gemini accuracy 87.3% (section 0); live re-test pending |
| **Fewer tokens (v0.9.5)**: search first / one request, trimmed passages, relevant-only document passages, search cache, dates in text, fewer weak results, quoting warning, organisation-site search; welcome cards removed | ✅ live (v0.9.5, commit `208b3a8`, deployed 2026-11-19; 201 tests); Gemini 91.2%, Groq 95.8% on the first 8 questions (section 0); live re-test pending |
| **Images + voice (v0.9.6)**: 📎/paste/drop images → Gemini/OpenRouter vision, previews kept; 🎤 Groq Whisper → Workers AI backup; 🔊 read aloud; admin switches + daily limits; migration 0006 | ✅ live (v0.9.6, deployed 2026-11-19; 205 tests); live-checked: image question ✔️, Read aloud ✔️, voice input not yet tested |
| **Answer feedback (v0.9.7)**: 👍/👎 + optional reason/note under answers; Admin → Feedback (per-model counts, list with question/answer/sources); migration 0007 | ✅ live (v0.9.7, pushed 2026-11-19, commit `f01ec7e`; 207 tests); owner's live check pending |
| **Deep research (v0.9.8)** + dark theme default: Research button → plan (1 model request) → 2–4 searches set aside/given back, last 10 kept for chat → ≤ 3 pages (no model calls) → brief written with no tools + app-made Sources list with exact dates; per-user daily runs (failed runs don't count); migration 0008 | ✅ live (v0.9.8, PR #1, merge commit `7131695`, deployed 2026-11-19; 212 tests); live research test ✔️ (2026-11-19, problems fixed in v0.9.9) |
| **Research sources (v0.9.9)**: [S1] citations become links (renumbered in reading order); Sources list + chips show only cited sources; number check accepts simple calculations from stated, supported figures | ✅ live (v0.9.9, PR #2, merge commit `65ab220`, deployed 2026-11-20; 214 tests); live research test pending |
| **Menu fix + local models for users (v0.9.10)**: Tools menu fits the screen (shared `useMenuLayout`); admin switch "Local models (Ollama) for users" (off) hides and refuses local models for users | ✅ live (v0.9.10, PR #3, merge commit `ba2b34a`, deployed 2026-11-20; 215 tests) |
| **Smarter memory (v0.10.0)**: relevant + pinned memories per message; pin/edit/export; sensitive data refused; long chats summarised once into kept notes; migration 0009 | ✅ live (v0.10.0, PR #4, deployed 2026-11-20; 224 tests); live test ✔️ (2026-11-20) |
| **Table display fix (v0.10.1)**: `<br>` in tables becomes a line break; no mid-word breaks in table columns | ✅ live (v0.10.1, PR #5, merge `e752cb9`, deployed 2026-11-20; 225 tests) |
| **Answer verification (v0.11.0)**: "Check" under answers that used sources → claims rated Supported / Contradicted / Not in the sources with the source; research reports checked automatically; number check skips general-knowledge numbers; admin switches + daily checks; migration 0010 | ✅ live (v0.11.0, PR #6, merge `d2a7a46`, deployed 2026-11-20; 234 tests); live Check ✔️ (3 of 3 supported) |
| **GitHub for each user, read-only (v0.12.0)**: Settings → Connections (GitHub App, encrypted tokens, one renewal at a time), 5 read-only tools, untrusted-content + leak guard, org/SSO messages, code-search fallback, 15-min cache with ETags, 10 requests per message, PR review in parts, Check via references; migration 0011 | ✅ live (v0.12.0, PR #7, merge `de648de`, deployed 2026-11-20; 243 tests); needs the GitHub App + 4 secrets before use |
| **New logo (v0.12.1)**: "Mark V5 · faceted blades" as `public/logo.svg` (full) + `public/favicon.svg` (small sizes); sign-in wordmark (VESPER / AI AGENT); spaced brand name | ✅ live (v0.12.1, PR #8, merge `762917d`, deployed 2026-11-20) |
| **Logo follows the theme (v0.12.2)**: inline `VesperMark` with `--vm-*` colours (bright tile in light mode); tab icon follows the browser's light/dark setting | ✅ live (v0.12.2, PR #9, merge `8781ec4`, deployed 2026-11-20) |
| **README rewrite** (docs only): what/how-different/features/how it works/install/use/dev/security/troubleshooting | ✅ merged (PR #10, merge `3cbcfd1`, 2026-11-20) |
| **Sign-in orbit animation (v0.12.3)**: the small circles travel slowly along the orbit lines around the logo (32/50/76 s per turn), one violet circle added; logo still; still for reduced motion; CSS only | ✅ live (v0.12.3, PR #11, merge `f94ffa3`, deployed 2026-11-20); owner checked ✔️ |
| **Cleaner sources + GitHub line links (v0.12.4)**: chips = pages the answer used (other search results behind "+N other results checked"); site + page title when a site repeats; `#L9-13` → `#L9-L13`, plain line references linked; prompt line for line links | ✅ live (v0.12.4, PR #12, merge `d08213f`, deployed 2026-11-20; 250 tests); owner's live check pending |
| **GitHub changes with approval (v0.13.0)**: separate Actions app + connection; 3 prepare-only tools (issue, comment, PR from exact edits); approval card with the exact text / every changed line; Approve sends once (stale files refused, new `vesper/…` branch, never merges); warnings; limits (3/answer, 10 waiting, 24 h, daily per user); admin switch + limit; next answer knows outcomes; migration 0012 | ✅ live (v0.13.0, PR #13, merge `cacce3d`, deployed 2026-11-21; 255 tests); hidden until the Actions app is set up; live test pending |
| **Write-access rule + GitHub search fix (v0.13.1)**: changes only in repos the user can write to (checked again at Approve); no automatic web search for messages about the user's GitHub code | ✅ live (v0.13.1, PR #16, merge `1370123`; confirmed 2026-11-24) |
| **Spreadsheets in chat: data analysis (v0.14.0)**: CSV/Excel/ODS read in the browser (worker, SheetJS), rows in D1 per chat, `query_table` calculates in the database over every row, source chip says what was calculated, daily share of D1 reads, migration 0013 | ✅ live (v0.14.0, PR #17, merge `a60b5ce`; /api/health confirmed 2026-11-24); owner's live test pending |
| **Charts + CSV download (v0.14.1)**: each calculation under the answer as a line/bars/table card with Chart/Table switch, figure picker, hover and keyboard readouts, and an exact, Excel-safe CSV download; up to 500 groups / 200 listed rows | ✅ live (v0.14.1, PR #18, merge `fcbb551`); owner's live test with Gemini OK (chart, bars, totals) |
| **Google Calendar + Gmail with approval (v0.15.0)**: connect Google (Calendar and/or sending email, PKCE, encrypted tokens), read the calendar and find free time exactly, events and emails prepared on cards (email editable) and added/sent only on Approve, daily limits, migration 0014 | 🔨 built 2026-11-24 (294 tests, typecheck, build, headless check with a fake Google); to push; then the setup + live test in section 0 |
| **Next: to propose** (small v0.14.1 fixes, Excel in the knowledge base, change/cancel events) | ⏳ |
| Knowledge base Part 2 (daily web-page refresh) | ⏸ postponed (2026-11-19: the web is the main source) |

**Design system (v0.8.0)** — keep new UI consistent with it:
- All colours, surfaces, borders and shadows are CSS variables in `src/web/styles.css` (`--bg`, `--bg-elevated`,
  `--text-soft`, `--text-faint`, `--accent`, `--accent-soft`, `--accent-2`, `--user-bubble`, `--shadow-sm/md/lg`…),
  defined for light (`:root`) and dark (`.dark`). Never hard-code colours in components.
- Signature classes: `dusk-glow` (welcome/sign-in background), `dusk-text` (gradient greeting word), `shimmer-text`
  ("Thinking…"), `rise-in` (entry animation). Animations are disabled for `prefers-reduced-motion`.
- System fonts only (`--font-sans`, `--font-display`): the CSP allows fonts from the site itself, no web fonts.
- Logo (v0.12.1/0.12.2): `<VesperMark full />` for large spots, `<VesperMark />` (simplified) for ≤ 48 px, colours from `--vm-*` (bright tile in light mode, dark tile in dark mode); `public/favicon.svg` is the tab icon (follows the browser's light/dark). Radii: cards `rounded-2xl`, dialogs `rounded-3xl`,
  composer `rounded-[26px]`, pills `rounded-full`.
- Layout: `Sidebar.tsx` (search, date groups, collapsible rail saved in localStorage `vesper-sidebar-collapsed`,
  account menu with Settings/Admin/Theme/Sign out); welcome screen + docked composer in `App.tsx`; `Composer.tsx`
  holds the model picker (`placement="up"`) and `ToolsButton`; `MessageItem.tsx` (assistant mark, actions, Edit on
  the last user message → `POST /api/chat` with `edit: true`).
- Not built (no fake buttons): projects, agents. (Document upload exists only in the admin panel → Knowledge, since
  v0.9.0.) Since v0.9.6 the composer has 📎 (left of the model picker) and 🎤 (left of Send); they appear only when
  `GET /api/media/features` says so.
- **Owner's design rule (2026-11-17): professional, enterprise-grade, globally competitive.** No playful decoration
  (stars, typing animations, gradient text, glow effects, oversized rounded cards); restrained colour, standard 8px
  corners, clear hierarchy, minimal motion. Applies to new UI work.
- **Sign-in page (v0.8.1)** (`LoginPage.tsx`): split layout. The form side uses the app tokens (follows light/dark); the
  brand panel (wide screens only) is always dark with its own tokens (`.auth-showcase`, `--sc-*` in `styles.css`):
  the logo inside fine SVG orbit lines, headline "Clear answers. Trusted sources.". The only motion (v0.12.3, owner's
  request): small circles travelling slowly along the orbit lines (`.auth-orbiter`); the logo stays still, and the
  circles stay still for reduced motion.

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
npm run check            # typecheck + 294 tests (Vitest inside workerd, real local D1) + build
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
- **Revert-safe database changes (owner's rule, 2026-11-19).** Every new column must allow NULL or have a DEFAULT,
  and older code must never need a new table, so reverting the code to the previous release keeps working against
  the newer database (older code doesn't mention the new columns in its INSERTs, and `getAppSettings` ignores
  settings keys it doesn't know). Never rename or retype a column; add a new one instead. Reverting code never
  removes migrations (they stay applied, which is harmless under this rule).
- **Worker entry module may only export handlers.** Keep the Hono app in `src/worker/app.ts`; `index.ts` exports only
  `default`. There's a regression test for this.
- **Gemini rejects tool history it didn't create** (thought signatures in `extra_content`). Tool calls carry `origin`, and
  foreign history is flattened into a neutral note (`flattenToolMessages`). Never use a `[Used tool …]` format; models copy it.
- **Groq free tier is 8K tokens/min**, so two-step tool tasks can hit 429 and fall back. That's expected.
  It also has a **200,000 tokens/day** limit (gpt-oss-120b; rolling, shared by every use of the same Groq account,
  about 70 search questions a day). A full 18-question Groq accuracy run plus retries can use it up; then the live
  site falls back to Gemini until it frees up.
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
  The same happens to any doubled backslash (2026-11-24: `\\b` in a regex became an invisible backspace character in
  `scripts/mock-llm.mjs`, found and fixed). Put scripts with backslashes in a file (editor), never inline.
- **SheetJS turns JavaScript dates into Excel day numbers using the machine's time zone**, and the Workers test
  runtime uses the PC's zone (UTC+5): build test workbooks from Excel day numbers (46037 = 2026-01-15), not `Date`s.
  Real Excel files are unaffected (VESPER converts day numbers itself, without time zones).
- **D1 counts every row `json_each()` walks as a row read**, and GROUP BY / ORDER BY read them again (measured
  2026-11-24). Keep the spreadsheet read budget (`tablesRowsPerDay`) well under the free 5,000,000 a day.
- **Local server against the mock without touching `.dev.vars`** (its key lines are empty):
  `npx wrangler dev --port 8787 --local --var GROQ_API_KEY:mock --var GROQ_BASE_URL:http://127.0.0.1:8790/groq`, with
  `node scripts/mock-llm.mjs` running. On Windows, stopping the background command leaves wrangler's `node`/`workerd`
  children running: end the tree (`taskkill /PID <npx pid> /T /F`) and check that ports 8787/8790 are free.
- **Headless chat checks:** while an answer streams, the Send button is a Stop button; wait for "Send message" to come
  back before the next question (the mock streams long answers slowly). Click card buttons with `element.click()`:
  a card at the very bottom can sit under the message box, where a simulated mouse click lands on the box.
- **Local Google:** `wrangler dev … --var GOOGLE_CLIENT_ID:local-test --var GOOGLE_CLIENT_SECRET:local-test --var
  GOOGLE_TOKEN_KEY:<random base64> --var GOOGLE_OAUTH_BASE_URL:http://127.0.0.1:8790/google --var
  GOOGLE_TOKEN_URL:…/google/token --var GOOGLE_USERINFO_URL:…/google/userinfo --var GOOGLE_API_BASE_URL:…/google
  --var GOOGLE_REVOKE_URL:…/google/revoke`; apply migrations to the local D1 first (`npx wrangler d1 migrations apply
  ai-assistant --local`). Dev sign-in as `admin` is the admin.
- **Headless downloads:** send `Browser.setDownloadBehavior` (`allow`, a download folder, `eventsEnabled`) on the
  browser's own DevTools connection (`/json/version`) and keep that connection open; closing it resets the setting.
- **Code under `src/web/lib` that tests import must not use `document`/`window`**: the worker typecheck also reads the
  tests (no DOM types there). Keep page code in components (e.g. the CSV save lives in `TableResultCard.tsx`).
- Model IDs and free limits change often: lists are fetched live; defaults can be overridden with `*_MODEL` variables.
- The OpenRouter guard (`:free` only) and "no paid provider in code" are the zero-cost guarantees. Keep them.

## 8. Housekeeping the owner planned
- Delete the GitHub fine-grained token (VESPER-AI only) and its Windows Credential Manager entry when the project is done.
- ~~Replace the GitHub token pasted into a chat on 2026-11-17~~: **done** (owner confirmed 2026-11-19). Note the new
  token's expiry date and renew it before then (fine-grained, VESPER-AI only, Contents: read and write).
- Delete `.dev.vars` when local testing is done, so no keys stay on the PC (keys used for the 2026-11-19 accuracy
  runs were emptied the same day).
- **OpenRouter key "VESPER AI" expires 2027-02-17** (created 2026-11-19, 90 days): before then create a new one
  (credit limit at the minimum) and replace the Cloudflare secret `OPENROUTER_API_KEY`. Until it's replaced, VESPER
  just skips OpenRouter. If OpenRouter answers "No endpoints found matching your data policy", allow free models in
  OpenRouter → Settings → Privacy.
- Mistral: skipped (its Free plan now needs an upgrade before keys can be created; no card allowed).
- The local project folder on the office PC can be deleted at any time; everything lives in GitHub + Cloudflare.
