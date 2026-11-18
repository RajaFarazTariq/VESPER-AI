#!/usr/bin/env node
/**
 * Accuracy test: asks the real questions in tests/accuracy/questions.json through a running local server and
 * scores the answers. Uses real AI and search keys (from .dev.vars), so it costs free-tier quota: about one web
 * search per web question. Not part of `npm test`.
 *
 *   npm run dev                      (or: npx wrangler dev --port 8787 --local) with real keys in .dev.vars
 *   node scripts/accuracy.mjs --provider groq   --pdf "path/to/AI in Software Engineering.pdf" --out groq.json
 *   node scripts/accuracy.mjs --provider gemini --pdf "…" --out gemini.json
 *   node scripts/accuracy.mjs --compare before-groq.json before-gemini.json after-groq.json after-gemini.json
 *   node scripts/accuracy.mjs --rescore before-groq.json …   (re-check saved answers after a scoring-rule fix)
 *
 * Options: --base http://127.0.0.1:8787  --login admin (an ADMIN_GITHUB_USERS name)  --only id1,id2
 *          --setup (only sign in, apply the test settings and load the PDF, then stop)
 *          --pause <seconds between questions> (default 45 for Groq: its free tier allows ~8K tokens a minute)
 * Each question is asked in a new chat with the chosen provider only (fallback off), so a Groq score is Groq's.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
let live = {}; // reference values read live from official sources (or taken from a saved run when re-scoring)

if (args.compare) {
  await compare([args.compare, ...args._]);
  process.exit(0);
}
if (args.rescore) {
  await rescore([args.rescore, ...args._]);
  process.exit(0);
}

const base = (args.base ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const provider = args.provider;
if (provider !== "groq" && provider !== "gemini") fail('Pass --provider groq or --provider gemini.');
const pause = Number(args.pause ?? (provider === "groq" ? 45 : 8)) * 1000;
const set = JSON.parse(await readFile(join(root, "tests/accuracy/questions.json"), "utf8"));
const only = args.only ? new Set(String(args.only).split(",")) : null;
const questions = set.questions.filter((q) => !only || only.has(q.id));

// ---------------------------------------------------------------- live expected values

live = await liveValues();
console.log(`Live values: ${Object.entries(live).filter(([k]) => !k.endsWith("_re")).map(([k, v]) => `${k}=${v}`).join(", ")}`);

// ---------------------------------------------------------------- sign in and prepare the local app

let cookie = "";
async function api(path, init = {}) {
  const response = await fetch(base + path, {
    ...init,
    headers: { Origin: base, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} → HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response;
}
const json = async (path, init) => (await api(path, init)).json();

const login = await api("/api/auth/dev-login", { method: "POST", body: JSON.stringify({ login: args.login ?? "admin" }) });
cookie = (login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie") ?? ""]).map((c) => c.split(";")[0]).join("; ");
const health = await json("/api/health");
console.log(`Server ${base}: version ${health.version}`);

// Enough searches for the run (local counter only), tools on, memory off (no carry-over between questions),
// and no fallback so each run measures one provider.
await json("/api/admin/settings", { method: "PUT", body: JSON.stringify({ webSearchDailyLimit: 1000, disabledTools: [] }) });
await json("/api/settings", { method: "PUT", body: JSON.stringify({ fallback: false, toolsEnabled: true, memoryEnabled: false, disabledTools: [] }) });
await ensureDocument();
if (args.setup) {
  console.log("Setup done (signed in, settings applied, test document ready).");
  process.exit(0);
}

const models = await json("/api/models");
const status = models.providers.find((p) => p.id === provider);
if (!status?.defaultModel) fail(`${provider} isn't configured on this server: add its key to .dev.vars and restart.`);
const selection = `${provider}:${status.defaultModel}`;
console.log(`Asking ${questions.length} questions with ${selection} (fallback off), ${pause / 1000}s apart.\n`);

// ---------------------------------------------------------------- ask and score

const results = [];
for (const [i, q] of questions.entries()) {
  if (i > 0) await sleep(pause);
  const reply = await ask(q.question);
  const scored = score(q, reply);
  results.push(scored);
  const mark = scored.error ? "ERROR" : `${scored.passed}/${scored.total}`;
  console.log(`${String(i + 1).padStart(2)}. ${q.id.padEnd(24)} ${mark.padEnd(6)} ${scored.failed.length ? `missed: ${scored.failed.join("; ")}` : ""}`);
}

const summary = summarize(results);
console.log(`\nScore: ${summary.score}% (${summary.checksPassed}/${summary.checks} checks; ${summary.fullMarks}/${results.length} questions fully right; ${summary.errors} errors)`);
const out = { label: args.label ?? "", version: health.version, provider, model: selection, ranAt: new Date().toISOString(), live, summary, results };
if (args.out) {
  await writeFile(args.out, JSON.stringify(out, null, 2));
  console.log(`Saved ${args.out}`);
}

// ---------------------------------------------------------------- helpers

async function ask(message) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let text;
    try {
      text = await (await api("/api/chat", { method: "POST", body: JSON.stringify({ message, model: selection, timeZone: "Asia/Karachi" }) })).text();
    } catch (error) {
      if (attempt < 4 && /HTTP (429|5\d\d)/.test(String(error))) {
        await sleep(65_000);
        continue;
      }
      return { error: String(error) };
    }
    const events = parseSse(text);
    const done = events.find((e) => e.type === "done");
    const problem = events.find((e) => e.type === "error");
    const errorText = problem ? String(problem.message ?? problem.error?.message ?? JSON.stringify(problem)) : done?.message?.error;
    const content = done?.message?.content ?? "";
    // Free-tier limits: wait for the minute window and ask again (fallback is off on purpose).
    if ((!content || done?.message?.status === "error") && /rate limit|429|quota|too many|free provider/i.test(errorText ?? "") && attempt < 4) {
      console.log(`    (${provider} limit reached; waiting 65s and asking again)`);
      await sleep(65_000);
      continue;
    }
    if (!done) return { error: errorText ?? "No answer received." };
    return { content, tools: done.message.tools ?? [], provider: done.message.provider, model: done.message.model, error: content ? null : (errorText ?? "Empty answer.") };
  }
  return { error: "Still rate-limited after 4 tries." };
}

function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // keep-alive or partial line
    }
  }
  return events;
}

/** The answer as it's matched: odd spaces made normal, 【 】 shown as ( ) (as the app displays it). */
function plain(text) {
  return text.replace(/[    ]/g, " ").replace(/【([^【】\n]{1,300})】/g, "($1)");
}

function fill(text) {
  return String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => (key in live ? String(live[key]) : m));
}

function score(q, reply) {
  const base = { id: q.id, kind: q.kind, question: q.question, expected: fill(q.expected) };
  if (reply.error && !reply.content) {
    return { ...base, passed: 0, total: q.checks.length, failed: q.checks.map((c) => fill(c.name)), error: reply.error, answer: "" };
  }
  const text = plain(reply.content);
  const failed = [];
  for (const check of q.checks) {
    let ok = false;
    if (check.type === "includes") ok = new RegExp(fill(check.pattern), "i").test(text);
    else if (check.type === "excludes") ok = !new RegExp(fill(check.pattern), "i").test(text);
    else if (check.type === "tool") ok = reply.tools.some((t) => t.name === check.tool && t.status === "done");
    else if (check.type === "number-near") {
      const target = Number(fill(check.value));
      const numbers = [...text.replace(/(\d),(\d{3})/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
      ok = Number.isFinite(target) && numbers.some((n) => Math.abs(n - target) <= target * (check.tolerance ?? 0.01));
    }
    if (!ok) failed.push(fill(check.name));
  }
  const numberCheck = reply.tools.find((t) => t.name === "answer_check");
  return {
    ...base,
    passed: q.checks.length - failed.length,
    total: q.checks.length,
    failed,
    error: null,
    answeredBy: reply.model ? `${reply.provider}:${reply.model}` : reply.provider,
    tools: reply.tools.filter((t) => t.name !== "answer_check").map((t) => `${t.name}${t.status === "done" ? "" : ` (${t.status})`}`),
    ...(numberCheck ? { numberCheck: numberCheck.summary } : {}),
    answer: reply.content.slice(0, 6000),
  };
}

/** Scores saved answers again with the current questions.json (after a scoring-rule fix): no new questions are asked. */
async function rescore(files) {
  const current = JSON.parse(await readFile(join(root, "tests/accuracy/questions.json"), "utf8"));
  for (const file of files) {
    const run = JSON.parse(await readFile(file, "utf8"));
    live = run.live;
    const results = run.results.map((r) => {
      const q = current.questions.find((x) => x.id === r.id);
      if (!q) return r;
      if (r.error && !r.answer) return score(q, { error: r.error });
      const tools = (r.tools ?? []).map((t) => {
        const m = /^(\S+)(?: \((\w+)\))?$/.exec(t);
        return { name: m?.[1] ?? t, status: m?.[2] ?? "done" };
      });
      const again = score(q, { content: r.answer, tools, provider: r.answeredBy, model: null });
      return { ...again, ...(r.numberCheck ? { numberCheck: r.numberCheck } : {}) };
    });
    const originalSummary = run.originalSummary ?? run.summary;
    const out = { ...run, rescoredAt: new Date().toISOString(), originalSummary, summary: summarize(results), results };
    const target = file.replace(/(\.rescored)?\.json$/, ".rescored.json");
    await writeFile(target, JSON.stringify(out, null, 2));
    console.log(`${file.split(/[\\/]/).pop()}: first scoring ${originalSummary.score}% → re-scored ${out.summary.score}% (${target.split(/[\\/]/).pop()})`);
  }
}

function summarize(results) {
  const checks = results.reduce((n, r) => n + r.total, 0);
  const checksPassed = results.reduce((n, r) => n + r.passed, 0);
  const perQuestion = results.map((r) => (r.total ? r.passed / r.total : 0));
  return {
    score: Math.round((perQuestion.reduce((a, b) => a + b, 0) / Math.max(1, results.length)) * 1000) / 10,
    checks,
    checksPassed,
    fullMarks: results.filter((r) => r.total && r.passed === r.total).length,
    errors: results.filter((r) => r.error).length,
  };
}

async function liveValues() {
  const get = async (url, kind = "json") => {
    const response = await fetch(url, { headers: { "User-Agent": "accuracy-test" } });
    if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
    return kind === "json" ? response.json() : response.text();
  };
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const values = {};
  const python = /Download Python (\d+\.\d+\.\d+)/.exec(await get("https://www.python.org/downloads/", "text"))?.[1];
  const node = (await get("https://nodejs.org/dist/index.json")).find((r) => r.lts)?.version.replace(/^v/, "");
  const kernel = (await get("https://www.kernel.org/releases.json")).latest_stable?.version;
  const rate = (await get("https://api.frankfurter.app/latest?from=USD&to=EUR")).rates?.EUR;
  if (!python || !node || !kernel || !rate) fail("Couldn't read one of the live reference values.");
  Object.assign(values, {
    python,
    python_re: `\\b${escape(python)}\\b`,
    node_lts: node,
    node_lts_re: `\\bv?${escape(node)}\\b`,
    kernel,
    kernel_re: `\\b${escape(kernel)}\\b`,
    usd_eur_100: Math.round(rate * 100 * 100) / 100,
  });
  return values;
}

/** Puts the test PDF into the local knowledge base (read the same way the browser reads it), once. */
async function ensureDocument() {
  const title = set.document;
  const { collections } = await json("/api/admin/knowledge");
  if (collections.some((c) => c.documents.some((d) => d.title === title && d.status === "ready"))) return;
  if (!args.pdf) fail(`The local knowledge base has no "${title}". Pass --pdf <path to the PDF> once.`);
  const pdfjs = await import(pathToFileURL(join(root, "node_modules/pdfjs-dist/legacy/build/pdf.mjs")).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const { chunkUnits, normalizeText } = await import(pathToFileURL(join(root, "src/shared/chunking.ts")).href);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(args.pdf)), isEvalSupported: false, useSystemFonts: true }).promise;
  const units = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    let text = "";
    for (const item of (await page.getTextContent()).items) if ("str" in item) text += item.str + (item.hasEOL ? "\n" : "");
    const clean = normalizeText(text);
    if (clean) units.push({ location: `page ${n}`, text: clean });
  }
  const chunks = chunkUnits(units);
  let folder = collections.find((c) => c.name === "AI in Software Engineering");
  if (!folder) {
    folder = (
      await json("/api/admin/knowledge/collections", {
        method: "POST",
        body: JSON.stringify({
          name: "AI in Software Engineering",
          description:
            "Research on how large language models are used in software engineering: code generation, testing, bug fixing, code review, documentation, and their risks and open problems",
        }),
      })
    ).collection;
  }
  const { document } = await json("/api/admin/knowledge/documents", {
    method: "POST",
    body: JSON.stringify({ collectionId: folder.id, title, kind: "pdf", pages: doc.numPages, expectedChunks: chunks.length, totalChars: chunks.reduce((n, c) => n + c.text.length, 0) }),
  });
  for (let i = 0; i < chunks.length; i += 40) {
    await json(`/api/admin/knowledge/documents/${document.id}/chunks`, { method: "POST", body: JSON.stringify({ chunks: chunks.slice(i, i + 40) }) });
  }
  await json(`/api/admin/knowledge/documents/${document.id}/complete`, { method: "POST", body: "{}" });
  console.log(`Added "${title}" to the local knowledge base (${doc.numPages} pages, ${chunks.length} passages).`);
}

async function compare(files) {
  const runs = await Promise.all(files.map(async (f) => JSON.parse(await readFile(f, "utf8"))));
  const name = (r) => `${r.label || r.version} ${r.provider}`.trim();
  const ids = runs[0].results.map((r) => r.id);
  const width = 24;
  console.log(["question".padEnd(width), ...runs.map((r) => name(r).padStart(16))].join(" "));
  for (const id of ids) {
    const cells = runs.map((run) => {
      const r = run.results.find((x) => x.id === id);
      return (r ? (r.error ? "error" : `${r.passed}/${r.total}`) : "-").padStart(16);
    });
    console.log([id.padEnd(width), ...cells].join(" "));
  }
  console.log(["SCORE".padEnd(width), ...runs.map((r) => `${r.summary.score}%`.padStart(16))].join(" "));
  console.log(["fully right".padEnd(width), ...runs.map((r) => `${r.summary.fullMarks}/${r.results.length}`.padStart(16))].join(" "));
}

function parseArgs(list) {
  const out = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = list[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
