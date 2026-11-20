/**
 * GitHub tools (read-only, v0.12.0): the user's own repositories through their GitHub connection.
 *
 * Everything read from a repository (files, README, issues, pull requests, comments) was written by other people and
 * is passed to the model as untrusted data. Results from private repositories switch off opening other web pages for
 * the rest of the answer (see llm/agent.ts), so text in a repo can't make the model send the code to another site.
 * Answers keep only references (repo, commit, file, lines) for "Check this answer", never the repository text.
 */
import { z } from "zod";
import { clip, wrapUntrusted } from "./net";
import { GithubError } from "./github-client";
import { define, ToolInputError, type AgentTool, type GithubAccess, type ToolContext, type ToolOutput } from "./types";

/** Most text of one file, and of one pull request part, sent to the model (characters). */
export const MAX_FILE_CHARS = 12_000;
export const MAX_DIFF_CHARS = 14_000;
export const MAX_FILE_DIFF_CHARS = 4_000;
const MAX_ISSUE_CHARS = 4_000;
const MAX_COMMENT_CHARS = 1_200;
const MAX_COMMENTS = 15;
export const GITHUB_REF = "GITHUB_REF ";
export const GITHUB_TOOL_NAMES = new Set(["github_repo", "github_file", "github_search", "github_issues", "github_pr_changes"]);

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** "owner/name" from "owner/name", "https://github.com/owner/name(.git)/…" or "github.com/owner/name". */
export function parseRepo(input: string): string {
  const text = input.trim().replace(/^https?:\/\//i, "").replace(/^(www\.)?github\.com\//i, "");
  const [owner, name] = text.split(/[/#?]/);
  const repo = `${owner ?? ""}/${(name ?? "").replace(/\.git$/i, "")}`;
  if (!REPO.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) {
    throw new ToolInputError(`"${clip(input, 80)}" isn't a GitHub repository. Use owner/name, e.g. octocat/hello-world.`);
  }
  return repo;
}

export const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const cleanPath = (path: string) => path.trim().replace(/^\/+|\/+$/g, "");
export const fileUrl = (repo: string, sha: string, path: string, from?: number, to?: number) =>
  `https://github.com/${repo}/blob/${sha}/${enc(path)}${from ? `#L${from}${to && to !== from ? `-L${to}` : ""}` : ""}`;
const ref = (data: Record<string, unknown>) => GITHUB_REF + JSON.stringify(data);
const need = (ctx: ToolContext): GithubAccess => {
  if (!ctx.github) throw new ToolInputError("GitHub isn't connected. Tell the user to connect GitHub in Settings → Connections.");
  return ctx.github;
};

interface RepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  language: string | null;
  htmlUrl: string;
  pushedAt: string | null;
  archived: boolean;
}

/** The repository's basics (once per message), or a plain explanation of why it can't be read. */
export function repoInfo(gh: GithubAccess, repo: string): Promise<RepoInfo> {
  return gh.memo(`repo:${repo.toLowerCase()}`, async () => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse((await gh.get(`/repos/${repo}`, { fresh: 5 * 60_000 })).body) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GithubError && (error.code === "not_found" || error.code === "forbidden")) {
        throw new ToolInputError(await gh.explainNoAccess(repo));
      }
      throw error;
    }
    return {
      fullName: String(data.full_name ?? repo),
      private: data.private === true || data.visibility === "private" || data.visibility === "internal",
      defaultBranch: String(data.default_branch ?? "main"),
      description: typeof data.description === "string" ? data.description : null,
      language: typeof data.language === "string" ? data.language : null,
      htmlUrl: `https://github.com/${String(data.full_name ?? repo)}`,
      pushedAt: typeof data.pushed_at === "string" ? data.pushed_at.slice(0, 10) : null,
      archived: data.archived === true,
    };
  });
}

/** The exact commit a branch, tag or sha points at now (links and references stay correct later). */
export function commitSha(gh: GithubAccess, repo: string, branchOrSha: string): Promise<string> {
  if (/^[0-9a-f]{40}$/i.test(branchOrSha)) return Promise.resolve(branchOrSha.toLowerCase());
  return gh.memo(`sha:${repo.toLowerCase()}@${branchOrSha}`, async () => {
    const { body } = await gh.get(`/repos/${repo}/commits/${encodeURIComponent(branchOrSha)}`, { accept: "application/vnd.github.sha", fresh: 60_000 });
    const sha = body.trim();
    if (!/^[0-9a-f]{40}$/i.test(sha)) throw new ToolInputError(`"${branchOrSha}" isn't a branch, tag or commit in ${repo}.`);
    return sha.toLowerCase();
  });
}

type Contents =
  | { type: "dir"; entries: { name: string; path: string; type: string; size: number }[] }
  | { type: "file"; text: string | null; size: number; binary: boolean };

export function decodeBase64Utf8(data: string): { text: string; binary: boolean } {
  const bytes = Uint8Array.from(atob(data.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  if (bytes.subarray(0, 8_000).includes(0)) return { text: "", binary: true };
  return { text: new TextDecoder().decode(bytes), binary: false };
}

async function readContents(gh: GithubAccess, repo: string, path: string, sha: string): Promise<Contents> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse((await gh.get(`/repos/${repo}/contents/${enc(path)}?ref=${sha}`, { accept: "application/vnd.github.object+json", fresh: 10 * 60_000 })).body);
  } catch (error) {
    if (error instanceof GithubError && error.code === "not_found") throw new ToolInputError(`There's no "${path || "/"}" in ${repo} at that version.`);
    throw error;
  }
  if (data.type === "dir" || Array.isArray(data.entries)) {
    const entries = (Array.isArray(data.entries) ? data.entries : []) as { name: string; path: string; type: string; size: number }[];
    return { type: "dir", entries };
  }
  if (data.type !== "file") throw new ToolInputError(`"${path}" is a ${String(data.type)} (only files and folders can be read).`);
  const size = Number(data.size ?? 0);
  if (data.encoding !== "base64" || typeof data.content !== "string" || (!data.content && size > 0)) {
    return { type: "file", text: null, size, binary: false }; // over 1 MB: GitHub sends no content
  }
  const decoded = decodeBase64Utf8(data.content);
  return { type: "file", text: decoded.binary ? null : decoded.text, size, binary: decoded.binary };
}

/** Lines `from`–`to` with their numbers, within MAX_FILE_CHARS. */
export function numberedLines(text: string, from = 1, to?: number, max = MAX_FILE_CHARS): { text: string; from: number; to: number; total: number } {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const total = lines.length;
  const start = Math.min(Math.max(1, from), total);
  const end = Math.min(total, Math.max(start, to ?? total));
  const out: string[] = [];
  let used = 0;
  let last = start - 1;
  for (let i = start; i <= end; i++) {
    const line = `${i}: ${lines[i - 1]!.length > 400 ? `${lines[i - 1]!.slice(0, 400)}…` : lines[i - 1]}`;
    if (used + line.length + 1 > max && out.length > 0) break;
    out.push(line);
    used += line.length + 1;
    last = i;
  }
  return { text: out.join("\n"), from: start, to: last, total };
}

// ---------------------------------------------------------------- pull request review planning (pure)

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

const LOW_PRIORITY = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|Gemfile\.lock|go\.sum)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|node_modules|__snapshots__|generated)\//i;
const TESTS = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/i;
const DOCS = /\.(md|mdx|txt|rst)$|(^|\/)docs\//i;

/** Review order: code first, then tests, then docs/config, then lock files, generated and minified files. */
export function orderPrFiles(files: PrFile[]): PrFile[] {
  const rank = (f: PrFile) => (LOW_PRIORITY.test(f.filename) ? 3 : DOCS.test(f.filename) ? 2 : TESTS.test(f.filename) ? 1 : 0);
  return files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
    .map((x) => x.f);
}

export interface PrPart {
  /** Files in this part, each with its (possibly shortened) diff. */
  included: { file: PrFile; diff: string; cut: boolean }[];
  /** 1-based position (in review order) to continue from, or null when this part reaches the end. */
  next: number | null;
  /** Files after this part, not reviewed yet. */
  remaining: PrFile[];
  /** Low-priority files in the whole pull request (lock files, generated, minified). */
  lowPriority: string[];
}

/** One part of a pull request review: as many files as fit `budget`, starting at `start` (in review order). */
export function planPrPart(files: PrFile[], start = 1, budget = MAX_DIFF_CHARS, perFile = MAX_FILE_DIFF_CHARS): PrPart {
  const ordered = orderPrFiles(files);
  const included: PrPart["included"] = [];
  let used = 0;
  let i = Math.max(1, start) - 1;
  for (; i < ordered.length; i++) {
    const file = ordered[i]!;
    const full = file.patch ?? "";
    const cut = full.length > perFile;
    const diff = full ? (cut ? `${full.slice(0, perFile)}\n… (diff cut here: ${full.length - perFile} more characters)` : full) : "(GitHub shows no diff for this file: binary, renamed or too large)";
    if (included.length > 0 && used + diff.length > budget) break;
    included.push({ file, diff, cut });
    used += diff.length;
  }
  return {
    included,
    next: i < ordered.length ? i + 1 : null,
    remaining: ordered.slice(i),
    lowPriority: ordered.filter((f) => LOW_PRIORITY.test(f.filename)).map((f) => f.filename),
  };
}

// ---------------------------------------------------------------- code search fallback (pure)

const words = (query: string) => [...new Set(query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [])].slice(0, 6);

/** Paths that look like they're about the query (file names and folders), best first. */
export function matchPaths(paths: string[], query: string, max = 8): string[] {
  const terms = words(query);
  if (terms.length === 0) return [];
  return paths
    .map((path) => {
      const lower = path.toLowerCase();
      const name = lower.split("/").pop() ?? lower;
      const score = terms.reduce((n, t) => n + (name.includes(t) ? 3 : lower.includes(t) ? 1 : 0), 0);
      return { path, score };
    })
    .filter((p) => p.score > 0 && !LOW_PRIORITY.test(p.path))
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length)
    .slice(0, max)
    .map((p) => p.path);
}

/** Lines of a file that contain any query word, with line numbers. */
export function grepLines(text: string, query: string, max = 12): string[] {
  const terms = words(query);
  const out: string[] = [];
  text.replace(/\r\n?/g, "\n").split("\n").forEach((line, i) => {
    if (out.length < max && terms.some((t) => line.toLowerCase().includes(t))) out.push(`${i + 1}: ${clip(line, 200)}`);
  });
  return out;
}

// ---------------------------------------------------------------- shared readers (tools and the answer check)

async function readFile(gh: GithubAccess, repo: string, path: string, sha: string, from?: number, to?: number) {
  const contents = await readContents(gh, repo, path, sha);
  return { contents, numbered: contents.type === "file" && contents.text !== null ? numberedLines(contents.text, from, to) : null };
}

async function readIssue(gh: GithubAccess, repo: string, number: number) {
  let issue: Record<string, any>;
  try {
    issue = JSON.parse((await gh.get(`/repos/${repo}/issues/${number}`)).body);
  } catch (error) {
    if (error instanceof GithubError && error.code === "not_found") throw new ToolInputError(`There's no issue or pull request #${number} in ${repo}.`);
    throw error;
  }
  const comments = issue.comments > 0 ? (JSON.parse((await gh.get(`/repos/${repo}/issues/${number}/comments?per_page=${MAX_COMMENTS}`)).body) as Record<string, any>[]) : [];
  return {
    number,
    kind: issue.pull_request ? "pull request" : "issue",
    title: String(issue.title ?? ""),
    state: String(issue.state ?? ""),
    author: String(issue.user?.login ?? ""),
    created: String(issue.created_at ?? "").slice(0, 10),
    url: String(issue.html_url ?? `https://github.com/${repo}/issues/${number}`),
    body: clip(String(issue.body ?? ""), MAX_ISSUE_CHARS),
    comments: comments.slice(0, MAX_COMMENTS).map((c) => ({ author: String(c.user?.login ?? ""), date: String(c.created_at ?? "").slice(0, 10), text: clip(String(c.body ?? ""), MAX_COMMENT_CHARS) })),
    total_comments: Number(issue.comments ?? 0),
  };
}

async function readPrPart(gh: GithubAccess, repo: string, number: number, start: number) {
  let pr: Record<string, any>;
  try {
    pr = JSON.parse((await gh.get(`/repos/${repo}/pulls/${number}`)).body);
  } catch (error) {
    if (error instanceof GithubError && error.code === "not_found") throw new ToolInputError(`There's no pull request #${number} in ${repo}.`);
    throw error;
  }
  const changed = Number(pr.changed_files ?? 0);
  const files: PrFile[] = [];
  for (let page = 1; page <= Math.min(3, Math.ceil(changed / 100) || 1); page++) {
    files.push(...(JSON.parse((await gh.get(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`)).body) as PrFile[]));
  }
  return { pr, files, part: planPrPart(files, start), changed };
}

const repoSource = (info: RepoInfo) => ({ title: info.fullName, url: info.htmlUrl });

// ---------------------------------------------------------------- tools

const repoTool = define({
  name: "github_repo",
  label: "GitHub repository",
  description:
    "Look at one of the user's GitHub repositories: description, main language, default branch, README and top-level files. " +
    "Without repo, lists the repositories the user allowed VESPER to read. Read-only.",
  risk: "read",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.github),
  parameters: {
    type: "object",
    properties: { repo: { type: "string", description: 'owner/name, e.g. "octocat/hello-world". Leave out to list the allowed repositories.' } },
  },
  schema: z.object({ repo: z.string().trim().max(200).optional() }),
  async run({ repo: input }, ctx): Promise<ToolOutput> {
    const gh = need(ctx);
    if (!input) {
      const installs = (JSON.parse((await gh.get("/user/installations?per_page=100")).body) as { installations?: Record<string, any>[] }).installations ?? [];
      const repos: { repo: string; private: boolean }[] = [];
      for (const install of installs.slice(0, 2)) {
        const list = JSON.parse((await gh.get(`/user/installations/${Number(install.id)}/repositories?per_page=100`)).body) as { repositories?: Record<string, any>[] };
        for (const r of list.repositories ?? []) repos.push({ repo: String(r.full_name), private: r.private === true });
      }
      return {
        content: JSON.stringify({ repositories: repos, choose_more: gh.installUrl, note: repos.length ? undefined : "The user hasn't chosen any repositories for VESPER yet." }),
        summary: repos.length ? `${repos.length} repositories VESPER can read` : "No repositories chosen yet",
        // Private repository names are private content too (leak guard).
        private: repos.some((r) => r.private),
      };
    }
    const repo = parseRepo(input);
    const info = await repoInfo(gh, repo);
    const sha = await commitSha(gh, repo, info.defaultBranch);
    let readme: string | null = null;
    try {
      readme = clip((await gh.get(`/repos/${repo}/readme?ref=${sha}`, { accept: "application/vnd.github.raw+json", fresh: 10 * 60_000 })).body, 4_000);
    } catch (error) {
      if (!(error instanceof GithubError) || error.code !== "not_found") throw error;
    }
    const root = await readContents(gh, repo, "", sha);
    const files = root.type === "dir" ? root.entries.map((e) => `${e.path}${e.type === "dir" ? "/" : ""}`).slice(0, 80) : [];
    return {
      content: wrapUntrusted(`GitHub repository ${repo} (written by others)`, {
        repo: info.fullName,
        private: info.private,
        description: info.description,
        language: info.language,
        default_branch: info.defaultBranch,
        commit: sha,
        last_push: info.pushedAt,
        archived: info.archived,
        top_level: files,
        readme,
      }),
      summary: `${info.fullName}${info.private ? " (private)" : ""}: ${files.length} top-level entries${readme ? ", README" : ""}`,
      sources: [repoSource(info)],
      keep: ref({ t: "repo", repo: info.fullName, sha }),
      private: info.private,
    };
  },
});

const fileTool = define({
  name: "github_file",
  label: "GitHub file",
  description:
    "Read a file from the user's GitHub repository (with line numbers), or list a folder. Long files come in parts: use start_line/end_line. Read-only.",
  risk: "read",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.github),
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      path: { type: "string", description: 'File or folder path, e.g. "src/app.ts" or "src". Empty for the top folder.' },
      ref: { type: "string", description: "Branch, tag or commit. Defaults to the default branch." },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    },
    required: ["repo", "path"],
  },
  schema: z.object({
    repo: z.string().trim().min(3).max(200),
    path: z.string().max(500),
    ref: z.string().trim().max(200).optional(),
    start_line: z.number().int().min(1).max(1_000_000).optional(),
    end_line: z.number().int().min(1).max(1_000_000).optional(),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const gh = need(ctx);
    const repo = parseRepo(args.repo);
    const path = cleanPath(args.path);
    const info = await repoInfo(gh, repo);
    const sha = await commitSha(gh, repo, args.ref?.trim() || info.defaultBranch);
    const { contents, numbered } = await readFile(gh, repo, path, sha, args.start_line, args.end_line);
    if (contents.type === "dir") {
      const entries = contents.entries.map((e) => `${e.path}${e.type === "dir" ? "/" : ""}`).slice(0, 200);
      return {
        content: wrapUntrusted(`GitHub repository ${repo} (written by others)`, { repo, folder: path || "/", commit: sha, entries }),
        summary: `${repo}/${path}: ${entries.length} entries`,
        sources: [{ title: `${repo} · ${path || "/"}`, url: `https://github.com/${repo}/tree/${sha}/${enc(path)}` }],
        keep: ref({ t: "dir", repo, sha, path }),
        private: info.private,
      };
    }
    if (!numbered) {
      const why = contents.binary ? "it's a binary file" : `it's too large for GitHub to send (${Math.round(contents.size / 1024)} KB)`;
      throw new ToolInputError(`${path} can't be shown: ${why}.`);
    }
    const more = numbered.to < numbered.total ? `Lines ${numbered.from}–${numbered.to} of ${numbered.total}; ask for start_line ${numbered.to + 1} to read on.` : undefined;
    return {
      content: wrapUntrusted(`GitHub repository ${repo} (written by others)`, {
        repo,
        path,
        commit: sha,
        lines: `${numbered.from}-${numbered.to} of ${numbered.total}`,
        link_for_these_lines: fileUrl(repo, sha, path, numbered.from, numbered.to),
        ...(more ? { more } : {}),
        text: numbered.text,
      }),
      summary: `${path} lines ${numbered.from}–${numbered.to} of ${numbered.total}`,
      sources: [{ title: `${repo} · ${path} L${numbered.from}–${numbered.to}`, url: fileUrl(repo, sha, path, numbered.from, numbered.to) }],
      keep: ref({ t: "file", repo, sha, path, from: numbered.from, to: numbered.to }),
      private: info.private,
    };
  },
});

const searchTool = define({
  name: "github_search",
  label: "GitHub code search",
  description:
    "Search the code of the user's GitHub repository for words or identifiers (main branch). Returns matching files and lines. Read-only.",
  risk: "read",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.github),
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      query: { type: "string", description: 'Words or identifiers, e.g. "verifyAnswer" or "rate limit"' },
    },
    required: ["repo", "query"],
  },
  schema: z.object({ repo: z.string().trim().min(3).max(200), query: z.string().trim().min(2).max(200) }),
  async run(args, ctx): Promise<ToolOutput> {
    const gh = need(ctx);
    const repo = parseRepo(args.repo);
    const info = await repoInfo(gh, repo);
    const query = args.query.replace(/\b(?:repo|org|user):\S+/gi, "").trim() || args.query;
    let items: { path: string; url: string; lines: string[] }[] = [];
    let note: string | undefined;
    let sha: string | null = null;
    try {
      const { body } = await gh.get(`/search/code?q=${encodeURIComponent(`${query} repo:${info.fullName}`)}&per_page=10`, {
        accept: "application/vnd.github.text-match+json",
        fresh: 10 * 60_000,
      });
      const data = JSON.parse(body) as { items?: Record<string, any>[] };
      items = (data.items ?? []).slice(0, 10).map((item) => ({
        path: String(item.path),
        url: String(item.html_url),
        lines: ((item.text_matches ?? []) as { fragment?: string }[]).map((m) => clip(String(m.fragment ?? ""), 300)).slice(0, 3),
      }));
    } catch (error) {
      if (!(error instanceof GithubError) || !["rate_limited", "invalid"].includes(error.code)) throw error;
      note = error.code === "rate_limited" ? "GitHub's code search limit was reached, so matching file names were searched instead." : "GitHub can't search this repository's code yet, so matching file names were searched instead.";
    }
    if (items.length === 0) {
      // Fallback: match the repository's file names, then look inside the best two files.
      sha = await commitSha(gh, repo, info.defaultBranch);
      const tree = JSON.parse((await gh.get(`/repos/${repo}/git/trees/${sha}?recursive=1`, { fresh: 10 * 60_000 })).body) as { tree?: { path: string; type: string }[] };
      const paths = matchPaths((tree.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path), query);
      items = paths.map((path) => ({ path, url: fileUrl(repo, sha!, path), lines: [] }));
      for (const item of items.slice(0, 2)) {
        try {
          const { numbered, contents } = await readFile(gh, repo, item.path, sha);
          if (numbered && contents.type === "file" && contents.text) item.lines = grepLines(contents.text, query);
        } catch (error) {
          if (error instanceof GithubError && error.code === "call_limit") break;
          if (!(error instanceof ToolInputError)) throw error;
        }
      }
      note ??= items.length ? "No code search results, so matching file names were searched instead." : undefined;
    }
    return {
      content: wrapUntrusted(`GitHub repository ${repo} (written by others)`, { repo, query, ...(note ? { note } : {}), results: items }),
      summary: `${items.length} result${items.length === 1 ? "" : "s"} for "${clip(query, 60)}"${note ? " (file names)" : ""}`,
      sources: items.slice(0, 5).map((i) => ({ title: `${repo} · ${i.path}`, url: i.url })),
      keep: items
        .slice(0, 3)
        .map((i) => ref({ t: "file", repo, sha: /\/blob\/([0-9a-f]{40})\//.exec(i.url)?.[1] ?? sha ?? info.defaultBranch, path: i.path, from: 1, to: 200 }))
        .join("\n"),
      private: info.private,
    };
  },
});

const issuesTool = define({
  name: "github_issues",
  label: "GitHub issues",
  description:
    "List or search issues and pull requests in the user's GitHub repository, or open one by number (with its comments). Read-only.",
  risk: "read",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.github),
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "integer", description: "Open this issue or pull request (with comments)." },
      query: { type: "string", description: "Search words (title and text)." },
      state: { type: "string", enum: ["open", "closed", "all"], description: 'Default "open".' },
      kind: { type: "string", enum: ["issue", "pr", "any"], description: 'Default "any".' },
    },
    required: ["repo"],
  },
  schema: z.object({
    repo: z.string().trim().min(3).max(200),
    number: z.number().int().min(1).max(10_000_000).optional(),
    query: z.string().trim().max(200).optional(),
    state: z.enum(["open", "closed", "all"]).optional(),
    kind: z.enum(["issue", "pr", "any"]).optional(),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const gh = need(ctx);
    const repo = parseRepo(args.repo);
    const info = await repoInfo(gh, repo);
    if (args.number) {
      const issue = await readIssue(gh, repo, args.number);
      return {
        content: wrapUntrusted(`GitHub ${issue.kind} in ${repo} (written by others)`, issue),
        summary: `#${issue.number} ${clip(issue.title, 80)} (${issue.state}, ${issue.comments.length} comment${issue.comments.length === 1 ? "" : "s"})`,
        sources: [{ title: `${repo} #${issue.number}: ${clip(issue.title, 80)}`, url: issue.url }],
        keep: ref({ t: "issue", repo, number: issue.number }),
        private: info.private,
      };
    }
    const state = args.state ?? "open";
    const kind = args.kind ?? "any";
    let list: Record<string, any>[];
    if (args.query) {
      const q = [`repo:${info.fullName}`, args.query, kind === "pr" ? "is:pr" : kind === "issue" ? "is:issue" : "", state === "all" ? "" : `is:${state}`].filter(Boolean).join(" ");
      list = (JSON.parse((await gh.get(`/search/issues?q=${encodeURIComponent(q)}&per_page=15`)).body) as { items?: Record<string, any>[] }).items ?? [];
    } else {
      list = JSON.parse((await gh.get(`/repos/${repo}/issues?state=${state}&per_page=20`)).body) as Record<string, any>[];
      list = list.filter((i) => (kind === "pr" ? i.pull_request : kind === "issue" ? !i.pull_request : true));
    }
    const items = list.slice(0, 15).map((i) => ({
      number: Number(i.number),
      kind: i.pull_request ? "pr" : "issue",
      title: clip(String(i.title ?? ""), 150),
      state: String(i.state ?? ""),
      author: String(i.user?.login ?? ""),
      updated: String(i.updated_at ?? "").slice(0, 10),
      comments: Number(i.comments ?? 0),
      url: String(i.html_url ?? ""),
    }));
    return {
      content: wrapUntrusted(`GitHub issues in ${repo} (written by others)`, { repo, state, kind, ...(args.query ? { query: args.query } : {}), items }),
      summary: `${items.length} ${kind === "pr" ? "pull requests" : kind === "issue" ? "issues" : "issues/pull requests"} (${state})`,
      sources: [{ title: `${repo} issues`, url: `https://github.com/${repo}/${kind === "pr" ? "pulls" : "issues"}` }],
      keep: ref({ t: "issues", repo, state, kind, query: args.query ?? null }),
      private: info.private,
    };
  },
});

const prTool = define({
  name: "github_pr_changes",
  label: "Pull request changes",
  description:
    "See what a pull request in the user's GitHub repository changes (the diff), for reviews and explanations. Big pull requests come in parts: " +
    "the result says which files are left; call again with start to continue. Read-only.",
  risk: "read",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.github),
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "integer", description: "Pull request number" },
      start: { type: "integer", minimum: 1, description: "Continue from this file (from a previous part). Default 1." },
    },
    required: ["repo", "number"],
  },
  schema: z.object({ repo: z.string().trim().min(3).max(200), number: z.number().int().min(1).max(10_000_000), start: z.number().int().min(1).max(10_000).optional() }),
  async run(args, ctx): Promise<ToolOutput> {
    const gh = need(ctx);
    const repo = parseRepo(args.repo);
    const info = await repoInfo(gh, repo);
    const { pr, files, part, changed } = await readPrPart(gh, repo, args.number, args.start ?? 1);
    const start = args.start ?? 1;
    const shownTo = start + part.included.length - 1;
    return {
      content: wrapUntrusted(`GitHub pull request in ${repo} (written by others)`, {
        repo,
        number: args.number,
        title: clip(String(pr.title ?? ""), 200),
        state: pr.merged_at ? "merged" : String(pr.state ?? ""),
        author: String(pr.user?.login ?? ""),
        base: String(pr.base?.ref ?? ""),
        head: String(pr.head?.ref ?? ""),
        description: clip(String(pr.body ?? ""), 2_000),
        changed_files: changed,
        additions: Number(pr.additions ?? 0),
        deletions: Number(pr.deletions ?? 0),
        ...(changed > files.length ? { note_on_size: `Only the first ${files.length} of ${changed} files can be listed.` } : {}),
        this_part: `files ${start}–${shownTo} of ${files.length} (code first; tests, docs, then lock/generated files last)`,
        files: part.included.map((f) => ({ file: f.file.filename, status: f.file.status, additions: f.file.additions, deletions: f.file.deletions, diff: f.diff })),
        ...(part.next
          ? {
              not_reviewed_in_this_part: part.remaining.map((f) => f.filename).slice(0, 100),
              continue_with: { start: part.next },
              instruction: "Tell the user which files weren't reviewed yet and that they can ask you to review the rest.",
            }
          : {}),
        low_priority_files: part.lowPriority.slice(0, 50),
      }),
      summary: `#${args.number}: files ${start}–${shownTo} of ${files.length}${part.next ? `, ${part.remaining.length} left` : ""}`,
      sources: [{ title: `${repo} PR #${args.number}: ${clip(String(pr.title ?? ""), 80)}`, url: `https://github.com/${repo}/pull/${args.number}/files` }],
      keep: ref({ t: "pr", repo, number: args.number, start }),
      private: info.private,
    };
  },
});

export const GITHUB_TOOLS: AgentTool[] = [repoTool, fileTool, searchTool, issuesTool, prTool];

// ---------------------------------------------------------------- "Check this answer": read the references again

/**
 * Replaces each GitHub reference kept with an answer by the text it points at, read again through the user's own
 * access (the same commit for files, so the check sees what the answer saw). At most `max` references are read.
 */
export async function resolveGithubRefs(evidence: string, gh: GithubAccess, max = 6): Promise<string> {
  const refs = [...evidence.matchAll(/GITHUB_REF (\{[^\n]*\})/g)];
  const texts = new Map<string, string>();
  for (const [whole, json] of refs.slice(0, max)) {
    if (texts.has(whole)) continue;
    let text: string;
    try {
      const r = JSON.parse(json!) as Record<string, any>;
      const repo = parseRepo(String(r.repo));
      if (r.t === "file") {
        const { numbered } = await readFile(gh, repo, String(r.path), String(r.sha), Number(r.from) || 1, Number(r.to) || undefined);
        text = numbered ? `${repo}/${r.path} (${fileUrl(repo, String(r.sha), String(r.path))}):\n${numbered.text}` : `${repo}/${r.path}: not a text file`;
      } else if (r.t === "issue") {
        text = JSON.stringify(await readIssue(gh, repo, Number(r.number)));
      } else if (r.t === "pr") {
        const { part } = await readPrPart(gh, repo, Number(r.number), Number(r.start) || 1);
        text = JSON.stringify(part.included.map((f) => ({ file: f.file.filename, diff: f.diff })));
      } else if (r.t === "repo" || r.t === "dir") {
        const contents = await readContents(gh, repo, String(r.path ?? ""), String(r.sha));
        text = contents.type === "dir" ? `${repo} files: ${contents.entries.map((e) => e.path).join(", ")}` : "";
      } else {
        text = `(GitHub ${String(r.t)} in ${repo}: listed when the answer was written)`;
      }
    } catch (error) {
      text = `(couldn't read this GitHub source again: ${error instanceof Error ? error.message : "error"})`;
    }
    texts.set(whole, wrapUntrusted("GitHub repository (written by others)", text));
  }
  return evidence.replace(/GITHUB_REF (\{[^\n]*\})/g, (whole) => texts.get(whole) ?? "(more GitHub sources not read again)");
}
