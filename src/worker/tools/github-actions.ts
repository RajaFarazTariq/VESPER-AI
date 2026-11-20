/**
 * GitHub changes with the user's approval (v0.13.0), through the separate Actions app.
 *
 * The three tools only PREPARE a change: they check the repository (and, for a pull request, the files), work out
 * exactly what would be sent, store it as a pending change and show it on a card. Nothing reaches GitHub until the
 * user presses Approve (routes/github-actions.ts → executeGithubAction), which sends exactly what was stored, once.
 *
 * Pull requests always go on a NEW branch made from the default branch. Existing branches are never written to,
 * nothing is merged, and nothing is deleted (except VESPER's own half-made branch when sending fails part-way).
 * Before sending, if the default branch moved and any of the changed files changed on GitHub meanwhile, nothing is
 * sent and the user is told to prepare it again, so no one's newer work is overwritten.
 */
import { z } from "zod";
import type { GithubActionFileDto, GithubActionKind, GithubActionPreviewDto } from "../../shared/types";
import { countPendingGithubActions, createGithubAction } from "../db/github";
import { decodeBase64Utf8, enc, parseRepo } from "./github";
import { GithubError, type GithubWriter } from "./github-client";
import { clip } from "./net";
import { define, ToolInputError, type AgentTool, type ToolContext, type ToolOutput } from "./types";

export const GITHUB_ACTION_TOOL_NAMES = new Set(["github_create_issue", "github_comment", "github_open_pr"]);
/** Changes one answer may prepare, and changes that may wait for a decision at once. */
const MAX_PER_ANSWER = 3;
const MAX_PENDING = 10;
const MAX_TITLE = 256;
const MAX_BODY = 20_000;
const MAX_FILES = 5;
const MAX_EDITS = 10;
/** Existing files up to this size can be edited; new files up to the smaller size can be created. */
const MAX_FILE_CHARS = 100_000;
const MAX_NEW_FILE_CHARS = 50_000;
/** The card shows the whole change; bigger changes are refused rather than shown in part. */
const MAX_DIFF_LINES = 1_500;
const CONTEXT_LINES = 3;

/** Tools whose results hold text written by other people, where a planted instruction could hide. */
const OTHERS_TEXT = new Set(["web_search", "read_page", "wikipedia", "github_issues", "github_pr_changes"]);

// ---------------------------------------------------------------- exact edits and the diff shown on the card (pure)

export interface FileEdit {
  find: string;
  replace: string;
}

/** Text as lines without their endings ("" → no lines; one trailing line ending doesn't make an extra line). */
const toLines = (text: string) => (text === "" ? [] : text.replace(/\r?\n$/, "").split("\n").map((l) => l.replace(/\r$/, "")));

/**
 * Applies exact find → replace edits to a file and describes the change as a unified diff (3 lines of context).
 * Each `find` must appear exactly once and edits may not overlap, so the result is never a guess. Line endings in
 * `find`/`replace` follow the file's own (CRLF files stay CRLF).
 */
export function applyEdits(original: string, edits: FileEdit[], path: string): { content: string; diff: string; additions: number; deletions: number } {
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const toFile = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n/g, eol);
  const located = edits
    .map((edit, i) => {
      const find = toFile(edit.find);
      if (!find) throw new ToolInputError(`Edit ${i + 1} for ${path} has an empty "find".`);
      const at = original.indexOf(find);
      if (at < 0) {
        throw new ToolInputError(
          `In ${path}, the "find" text of edit ${i + 1} isn't in the file exactly as given: "${clip(edit.find, 120)}". ` +
            "Read the file again (github_file) and copy the text exactly, including spaces and indentation.",
        );
      }
      if (original.indexOf(find, at + 1) >= 0) {
        throw new ToolInputError(`In ${path}, the "find" text of edit ${i + 1} appears more than once. Include a few more lines around it so it matches one place only.`);
      }
      return { at, end: at + find.length, replace: toFile(edit.replace) };
    })
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < located.length; i++) {
    if (located[i]!.at < located[i - 1]!.end) throw new ToolInputError(`In ${path}, two edits overlap. Combine them into one edit.`);
  }
  let content = "";
  let pos = 0;
  for (const e of located) {
    content += original.slice(pos, e.at) + e.replace;
    pos = e.end;
  }
  content += original.slice(pos);
  if (content === original) throw new ToolInputError(`The edits for ${path} don't change anything.`);

  // Line starts of the original; a final line ending doesn't start a real line.
  const starts = [0];
  for (let i = 0; i < original.length; i++) if (original[i] === "\n") starts.push(i + 1);
  const total = original.endsWith("\n") ? starts.length - 1 : starts.length;
  const lineOf = (p: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineEnd = (line: number) => (line + 1 < starts.length ? starts[line + 1]! : original.length); // after its "\n"
  const lineText = (line: number) => original.slice(starts[line]!, lineEnd(line)).replace(/\r?\n$/, "");

  // Each edit widened to whole lines; edits sharing a line become one block.
  type Block = { from: number; to: number; edits: typeof located };
  const blocks: Block[] = [];
  for (const e of located) {
    const from = starts[lineOf(e.at)]!;
    const to = lineEnd(lineOf(Math.max(e.at, e.end - 1)));
    const last = blocks.at(-1);
    if (last && from < last.to) {
      last.to = Math.max(last.to, to);
      last.edits.push(e);
    } else blocks.push({ from, to, edits: [e] });
  }
  const newText = (b: Block) => {
    let s = "";
    let p = b.from;
    for (const e of b.edits) {
      s += original.slice(p, e.at) + e.replace;
      p = e.end;
    }
    return s + original.slice(p, b.to);
  };
  // When a block's new text no longer ends with a line ending, it joins the next line: show that line too.
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    while (b.to < original.length) {
      const text = newText(b);
      if (text === "" || text.endsWith("\n")) break;
      b.to = lineEnd(lineOf(b.to));
      const next = blocks[i + 1];
      if (next && next.from < b.to) {
        b.to = Math.max(b.to, next.to);
        b.edits.push(...next.edits);
        blocks.splice(i + 1, 1);
      }
    }
  }

  const out: string[] = [];
  let additions = 0;
  let deletions = 0;
  let delta = 0;
  type Hunk = { oldStart: number; newStart: number; oldCount: number; newCount: number; end: number; lines: string[] };
  let hunk: Hunk | null = null;
  const context = (h: Hunk, from: number, to: number) => {
    for (let i = from; i < to; i++) {
      h.lines.push(` ${lineText(i)}`);
      h.oldCount++;
      h.newCount++;
    }
  };
  const flush = () => {
    if (!hunk) return;
    context(hunk, hunk.end, Math.min(total, hunk.end + CONTEXT_LINES));
    out.push(`@@ -${hunk.oldStart + 1},${hunk.oldCount} +${hunk.newStart + 1},${hunk.newCount} @@`, ...hunk.lines);
    hunk = null;
  };
  for (const b of blocks) {
    const start = lineOf(b.from);
    const oldLines = toLines(original.slice(b.from, b.to));
    const newLines = toLines(newText(b));
    if (hunk && start - CONTEXT_LINES <= hunk.end + CONTEXT_LINES) {
      context(hunk, hunk.end, start);
    } else {
      flush();
      const from = Math.max(0, start - CONTEXT_LINES);
      hunk = { oldStart: from, newStart: from + delta, oldCount: 0, newCount: 0, end: from, lines: [] };
      context(hunk, from, start);
    }
    const h: Hunk = hunk!;
    for (const l of oldLines) h.lines.push(`-${l}`);
    for (const l of newLines) h.lines.push(`+${l}`);
    h.oldCount += oldLines.length;
    h.newCount += newLines.length;
    h.end = start + oldLines.length;
    deletions += oldLines.length;
    additions += newLines.length;
    delta += newLines.length - oldLines.length;
  }
  flush();
  return { content, diff: out.join("\n"), additions, deletions };
}

/** The diff of a new file: every line added. */
export function newFileDiff(content: string): { diff: string; additions: number; deletions: number } {
  const lines = toLines(content);
  return { diff: [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join("\n"), additions: lines.length, deletions: 0 };
}

/** A repository file path: no "..", no leading "/", nothing in .github/workflows (needs a permission VESPER doesn't have). */
export function cleanFilePath(input: string): string {
  const path = input.trim().replace(/^\/+/, "");
  if (!path || path.length > 300 || /[\0\\]/.test(path) || path.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new ToolInputError(`"${clip(input, 80)}" isn't a valid file path in the repository.`);
  }
  if (/^\.github\/workflows\//i.test(path)) {
    throw new ToolInputError("Files in .github/workflows can't be changed by VESPER (GitHub needs an extra permission for workflow files).");
  }
  return path;
}

/** A short, safe branch name: vesper/<words-from-title>-<4 random hex>. */
export function branchName(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  const random = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `vesper/${words || "change"}-${random}`;
}

// ---------------------------------------------------------------- preparing (the tools)

interface WritableRepo {
  repo: string;
  publicRepo: boolean;
  defaultBranch: string;
}

/** The user's own GitHub account may write to this repository (owner, collaborator with write, maintainer or admin). */
const canWrite = (data: Record<string, any>) => data.permissions?.push === true || data.permissions?.maintain === true || data.permissions?.admin === true;

/**
 * The repository, if VESPER may prepare a change there. Every kind of change (issues and comments too) needs the
 * user's own write access (v0.13.1): on someone else's public repo GitHub would let anyone open issues, but VESPER
 * doesn't, so nobody can use VESPER to post in a repository they don't look after.
 */
async function writableRepo(gh: GithubWriter, input: string, need: "issues" | "push"): Promise<WritableRepo> {
  const repo = parseRepo(input);
  let data: Record<string, any>;
  try {
    data = (await gh.request<Record<string, any>>("GET", `/repos/${repo}`)) ?? {};
  } catch (error) {
    if (error instanceof GithubError && (error.code === "not_found" || error.code === "forbidden")) throw new ToolInputError(await gh.explainNoAccess(repo));
    throw error;
  }
  const fullName = String(data.full_name ?? repo);
  if (data.archived === true) throw new ToolInputError(`${fullName} is archived (read-only on GitHub), so nothing can be changed there.`);
  if (!canWrite(data)) {
    throw new ToolInputError(
      `The user's GitHub account can't write to ${fullName}. VESPER only prepares changes (issues, comments and pull requests) in repositories the user can write to.`,
    );
  }
  if (need === "issues" && data.has_issues === false) throw new ToolInputError(`Issues are switched off in ${fullName}.`);
  return {
    repo: fullName,
    publicRepo: !(data.private === true || data.visibility === "private" || data.visibility === "internal"),
    defaultBranch: String(data.default_branch ?? "main"),
  };
}

/** The Actions connection, within the limits on how many changes may be prepared and left waiting. */
async function begin(ctx: ToolContext): Promise<GithubWriter> {
  if (!ctx.githubWriter) {
    throw new ToolInputError('GitHub changes aren\'t connected. Tell the user to connect "GitHub changes" in Settings → Connections.');
  }
  if ((ctx.turn?.prepared ?? 0) >= MAX_PER_ANSWER) {
    throw new ToolInputError(`At most ${MAX_PER_ANSWER} changes can be prepared in one answer. Tell the user to decide on these first.`);
  }
  if ((await countPendingGithubActions(ctx.db, ctx.userId)) >= MAX_PENDING) {
    throw new ToolInputError(`${MAX_PENDING} GitHub changes are already waiting for the user's decision. Ask them to approve or reject those first.`);
  }
  return ctx.githubWriter;
}

/** Cautions for the card: text by other people was read in this answer; private code was read before a public change. */
export function actionWarnings(used: readonly string[], privateRead: boolean, publicRepo: boolean): string[] {
  const warnings: string[] = [];
  if (used.some((name) => OTHERS_TEXT.has(name))) {
    warnings.push(
      "While preparing this, VESPER read text written by other people (an issue, a pull request or a web page). Check that this is what you asked for and that it contains nothing you didn't expect.",
    );
  }
  if (publicRepo && privateRead) {
    warnings.push("This repository is public, and this answer also read your private code. Make sure none of it appears below before you approve.");
  }
  return warnings;
}

/** Stores the prepared change and tells the model it waits for the user (never that it's done). */
async function prepared(
  ctx: ToolContext,
  target: WritableRepo,
  change: { kind: GithubActionKind; title: string; what: string; payload: unknown; preview: GithubActionPreviewDto },
): Promise<ToolOutput> {
  const action = await createGithubAction(ctx.db, {
    userId: ctx.userId,
    conversationId: ctx.conversationId ?? null,
    kind: change.kind,
    repo: target.repo,
    title: clip(change.title, 200),
    publicRepo: target.publicRepo,
    warnings: actionWarnings(ctx.turn?.used ?? [], ctx.turn?.privateRead ?? false, target.publicRepo),
    payload: change.payload,
    preview: change.preview,
  });
  if (ctx.turn) ctx.turn.prepared++;
  return {
    content: JSON.stringify({
      status: "waiting_for_the_users_approval",
      prepared: change.what,
      note:
        "Nothing has been sent to GitHub. The user now sees a card with the exact change and chooses Approve or Reject. " +
        "Tell them in one or two sentences what you prepared and that it is waiting for their approval. Never say it was created, posted or sent.",
    }),
    summary: `Prepared ${change.what} (waiting for approval)`,
    action: { id: action.id, kind: action.kind, repo: action.repo, title: action.title },
  };
}

const ISSUE_DESCRIPTION =
  "Prepare a new issue in the user's GitHub repository. Nothing is sent: the user sees the exact issue on a card and approves or rejects it. " +
  "Use only when the user asked for an issue.";

const issueTool = define({
  name: "github_create_issue",
  label: "Prepare a GitHub issue",
  description: ISSUE_DESCRIPTION,
  risk: "approval",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.githubActions),
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      title: { type: "string", description: "Issue title." },
      body: { type: "string", description: "Issue text (Markdown)." },
    },
    required: ["repo", "title"],
  },
  schema: z.object({
    repo: z.string().trim().min(3).max(200),
    title: z.string().trim().min(1).max(MAX_TITLE),
    body: z.string().max(MAX_BODY).optional(),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const gh = await begin(ctx);
    const target = await writableRepo(gh, args.repo, "issues");
    const body = args.body?.trim() ?? "";
    return prepared(ctx, target, {
      kind: "issue",
      title: args.title,
      what: `a new issue "${clip(args.title, 80)}" in ${target.repo}`,
      payload: { title: args.title, body },
      preview: { title: args.title, body },
    });
  },
});

const commentTool = define({
  name: "github_comment",
  label: "Prepare a GitHub comment",
  description:
    "Prepare a comment on an issue or pull request in the user's GitHub repository. Nothing is sent: the user sees the exact comment on a card " +
    "and approves or rejects it. Use only when the user asked for a comment.",
  risk: "approval",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.githubActions),
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      number: { type: "integer", description: "The issue or pull request number." },
      body: { type: "string", description: "Comment text (Markdown)." },
    },
    required: ["repo", "number", "body"],
  },
  schema: z.object({
    repo: z.string().trim().min(3).max(200),
    number: z.number().int().min(1).max(10_000_000),
    body: z.string().trim().min(1).max(MAX_BODY),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const gh = await begin(ctx);
    const target = await writableRepo(gh, args.repo, "issues");
    let issue: Record<string, any>;
    try {
      issue = (await gh.request<Record<string, any>>("GET", `/repos/${target.repo}/issues/${args.number}`)) ?? {};
    } catch (error) {
      if (error instanceof GithubError && error.code === "not_found") throw new ToolInputError(`There's no issue or pull request #${args.number} in ${target.repo}.`);
      throw error;
    }
    if (issue.locked === true) throw new ToolInputError(`#${args.number} in ${target.repo} is locked: new comments aren't allowed.`);
    const kind = issue.pull_request ? "pr" : "issue";
    const title = clip(String(issue.title ?? ""), 200);
    const url = typeof issue.html_url === "string" && issue.html_url.startsWith("https://github.com/") ? issue.html_url : `https://github.com/${target.repo}/issues/${args.number}`;
    return prepared(ctx, target, {
      kind: "comment",
      // The issue's own title (written by others) stays on the card only, never in the log or the prompt.
      title: `Comment on #${args.number}`,
      what: `a comment on ${kind === "pr" ? "pull request" : "issue"} #${args.number} in ${target.repo}`,
      payload: { number: args.number, body: args.body },
      preview: { body: args.body, target: { number: args.number, kind, title, url } },
    });
  },
});

const fileChange = z
  .object({
    path: z.string().trim().min(1).max(300),
    edits: z.array(z.object({ find: z.string().min(1).max(10_000), replace: z.string().max(20_000) })).max(MAX_EDITS).optional(),
    new_content: z.string().max(MAX_NEW_FILE_CHARS).optional(),
  })
  .refine((c) => (c.edits?.length ? 1 : 0) + (c.new_content !== undefined ? 1 : 0) === 1, "Give either edits (existing file) or new_content (new file)");

interface PrPayload {
  base: string;
  baseSha: string;
  branch: string;
  title: string;
  body: string;
  files: { path: string; content: string; sha: string | null }[];
}

const prTool = define({
  name: "github_open_pr",
  label: "Prepare a pull request",
  description:
    "Prepare a pull request that changes files in the user's GitHub repository: a NEW branch from the default branch with these changes, and a " +
    "pull request into the default branch (existing branches are never changed). Nothing is sent: the user sees every changed line on a card " +
    "and approves or rejects it. Use only when the user asked for the change. Read each file first with github_file. For an existing file give " +
    "edits: each find is text copied exactly from the file that appears once (include enough surrounding lines), and replace is its new text. " +
    `For a new file give new_content. At most ${MAX_FILES} files.`,
  risk: "approval",
  requiresMemory: false,
  isAvailable: (server) => Boolean(server.githubActions),
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name" },
      title: { type: "string", description: "Pull request title." },
      body: { type: "string", description: "Pull request description (Markdown): what changes and why." },
      changes: {
        type: "array",
        description: `The files to change (at most ${MAX_FILES}).`,
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path in the repository, e.g. src/app.ts" },
            edits: {
              type: "array",
              description: "For an existing file: exact replacements.",
              items: {
                type: "object",
                properties: {
                  find: { type: "string", description: "Text copied exactly from the file (must appear once)." },
                  replace: { type: "string", description: "The new text for it." },
                },
                required: ["find", "replace"],
              },
            },
            new_content: { type: "string", description: "For a new file: its whole content." },
          },
          required: ["path"],
        },
      },
    },
    required: ["repo", "title", "changes"],
  },
  schema: z.object({
    repo: z.string().trim().min(3).max(200),
    title: z.string().trim().min(1).max(MAX_TITLE),
    body: z.string().max(MAX_BODY).optional(),
    changes: z.array(fileChange).min(1).max(MAX_FILES),
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const gh = await begin(ctx);
    const target = await writableRepo(gh, args.repo, "push");
    const paths = args.changes.map((c) => cleanFilePath(c.path));
    if (new Set(paths).size !== paths.length) throw new ToolInputError("Each file may appear only once in changes; put all its edits together.");
    const ref = await gh.request<{ object?: { sha?: string } }>("GET", `/repos/${target.repo}/git/ref/heads/${enc(target.defaultBranch)}`);
    const baseSha = String(ref?.object?.sha ?? "");
    if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new ToolInputError(`Couldn't find the latest commit of ${target.defaultBranch} in ${target.repo}.`);

    const files: PrPayload["files"] = [];
    const shown: GithubActionFileDto[] = [];
    let diffLines = 0;
    for (const [i, change] of args.changes.entries()) {
      const path = paths[i]!;
      let data: Record<string, any> | Record<string, any>[] | null = null;
      try {
        data = await gh.request<Record<string, any> | Record<string, any>[]>("GET", `/repos/${target.repo}/contents/${enc(path)}?ref=${baseSha}`);
      } catch (error) {
        if (!(error instanceof GithubError && error.code === "not_found")) throw error;
      }
      let entry: GithubActionFileDto;
      if (!data) {
        if (change.new_content === undefined) throw new ToolInputError(`${path} doesn't exist in ${target.repo}. To create it, give new_content instead of edits.`);
        const diff = newFileDiff(change.new_content);
        files.push({ path, content: change.new_content, sha: null });
        entry = { path, status: "added", ...diff };
      } else {
        if (Array.isArray(data) || data.type !== "file") throw new ToolInputError(`${path} is a folder in ${target.repo}, not a file.`);
        if (!change.edits?.length) throw new ToolInputError(`${path} already exists in ${target.repo}. Change it with edits (exact find/replace), not new_content.`);
        const size = Number(data.size ?? 0);
        if (size > MAX_FILE_CHARS || data.encoding !== "base64" || typeof data.content !== "string") {
          throw new ToolInputError(`${path} is too large for VESPER to change (over ${MAX_FILE_CHARS / 1000} KB).`);
        }
        const decoded = decodeBase64Utf8(data.content);
        if (decoded.binary) throw new ToolInputError(`${path} isn't a text file, so VESPER can't change it.`);
        const edited = applyEdits(decoded.text, change.edits, path);
        if (edited.content.length > MAX_FILE_CHARS) throw new ToolInputError(`${path} would become too large (over ${MAX_FILE_CHARS / 1000} KB).`);
        files.push({ path, content: edited.content, sha: String(data.sha ?? "") || null });
        entry = { path, status: "modified", diff: edited.diff, additions: edited.additions, deletions: edited.deletions };
      }
      diffLines += entry.diff.split("\n").length;
      shown.push(entry);
    }
    if (diffLines > MAX_DIFF_LINES) {
      throw new ToolInputError(`This change is too big to review on one card (${diffLines} lines). Split it into smaller pull requests.`);
    }
    const branch = branchName(args.title);
    const body = args.body?.trim() ?? "";
    const payload: PrPayload = { base: target.defaultBranch, baseSha, branch, title: args.title, body, files };
    return prepared(ctx, target, {
      kind: "pull_request",
      title: args.title,
      what: `a pull request "${clip(args.title, 80)}" in ${target.repo} (${files.length} file${files.length === 1 ? "" : "s"})`,
      payload,
      preview: { title: args.title, body, base: target.defaultBranch, branch, files: shown },
    });
  },
});

export const GITHUB_ACTION_TOOLS: AgentTool[] = [issueTool, commentTool, prTool];

// ---------------------------------------------------------------- sending an approved change

const issuePayload = z.object({ title: z.string().min(1).max(MAX_TITLE), body: z.string().max(MAX_BODY) });
const commentPayload = z.object({ number: z.number().int().min(1), body: z.string().min(1).max(MAX_BODY) });
const prPayload = z.object({
  base: z.string().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/i),
  branch: z.string().regex(/^vesper\/[a-z0-9-]+$/),
  title: z.string().min(1).max(MAX_TITLE),
  body: z.string().max(MAX_BODY),
  files: z.array(z.object({ path: z.string().min(1), content: z.string(), sha: z.string().nullable() })).min(1).max(MAX_FILES),
});

/** A change that couldn't be sent, in words for the card. */
export class ActionFailed extends Error {}

const githubPage = (url: unknown): string => {
  if (typeof url === "string" && /^https:\/\/github\.com\/[^\s<>"']+$/.test(url)) return url;
  throw new ActionFailed("GitHub didn't send back a link to the result. Check the repository on GitHub.");
};

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Sends exactly what was approved; returns the link to the new issue, comment or pull request. */
export async function executeGithubAction(gh: GithubWriter, kind: GithubActionKind, repo: string, raw: unknown): Promise<string> {
  try {
    // Write access is checked again: it may have been taken away since the change was prepared.
    const current = (await gh.request<Record<string, any>>("GET", `/repos/${repo}`)) ?? {};
    if (!canWrite(current) || current.archived === true) {
      throw new ActionFailed(`Your GitHub account can no longer write to ${repo}${current.archived === true ? " (it was archived)" : ""}. Nothing was sent.`);
    }
    if (kind === "issue") {
      const p = issuePayload.parse(raw);
      const created = await gh.request<{ html_url?: unknown }>("POST", `/repos/${repo}/issues`, { title: p.title, body: p.body });
      return githubPage(created?.html_url);
    }
    if (kind === "comment") {
      const p = commentPayload.parse(raw);
      const created = await gh.request<{ html_url?: unknown }>("POST", `/repos/${repo}/issues/${p.number}/comments`, { body: p.body });
      return githubPage(created?.html_url);
    }
    return await openPullRequest(gh, repo, prPayload.parse(raw));
  } catch (error) {
    if (error instanceof ActionFailed) throw error;
    if (error instanceof z.ZodError) throw new ActionFailed("This change couldn't be read back. Nothing was sent; ask VESPER to prepare it again.");
    throw new ActionFailed(error instanceof GithubError ? error.message : "Something went wrong while sending it to GitHub.");
  }
}

async function openPullRequest(gh: GithubWriter, repo: string, p: z.infer<typeof prPayload>): Promise<string> {
  // Work from the newest commit, but never over someone else's newer change to the same files.
  const ref = await gh.request<{ object?: { sha?: string } }>("GET", `/repos/${repo}/git/ref/heads/${enc(p.base)}`);
  const head = String(ref?.object?.sha ?? "");
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new ActionFailed(`Couldn't find ${p.base} in ${repo} any more. Nothing was sent.`);
  let from = p.baseSha;
  if (head.toLowerCase() !== p.baseSha.toLowerCase()) {
    const compare = await gh.request<{ status?: string; files?: { filename?: string }[] }>("GET", `/repos/${repo}/compare/${p.baseSha}...${head}`);
    const touched = new Set((compare?.files ?? []).map((f) => String(f.filename ?? "")));
    const clash = p.files.map((f) => f.path).filter((path) => touched.has(path));
    if (compare?.status !== "ahead" || clash.length) {
      throw new ActionFailed(
        clash.length
          ? `${clash.join(", ")} changed on GitHub after VESPER prepared this. Nothing was sent, so no one's newer work was overwritten; ask VESPER to prepare it again.`
          : `${p.base} in ${repo} was rewritten after VESPER prepared this. Nothing was sent; ask VESPER to prepare it again.`,
      );
    }
    from = head; // the files VESPER changes are the same there, so their versions still match
  }
  await gh.request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${p.branch}`, sha: from });
  try {
    for (const file of p.files) {
      await gh.request("PUT", `/repos/${repo}/contents/${enc(file.path)}`, {
        message: p.files.length === 1 ? p.title : `${p.title} (${file.path})`,
        content: toBase64(file.content),
        branch: p.branch,
        ...(file.sha ? { sha: file.sha } : {}),
      });
    }
    const pr = await gh.request<{ html_url?: unknown }>("POST", `/repos/${repo}/pulls`, { title: p.title, body: p.body, head: p.branch, base: p.base });
    return githubPage(pr?.html_url);
  } catch (error) {
    // Remove VESPER's own half-made branch (best effort); nothing else was touched.
    await gh.request("DELETE", `/repos/${repo}/git/refs/heads/${enc(p.branch)}`).catch(() => {});
    const reason = error instanceof GithubError || error instanceof ActionFailed ? error.message : "Something went wrong while sending it to GitHub.";
    throw new ActionFailed(`${reason} Nothing was merged; VESPER removed the new branch it had started.`);
  }
}
