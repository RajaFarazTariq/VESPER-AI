import {
  BookOpen,
  Bookmark,
  BookmarkMinus,
  Calculator,
  ChevronRight,
  CircleAlert,
  Clock,
  CloudSun,
  Coins,
  FileCode,
  FileText,
  FolderGit2,
  GitPullRequest,
  CircleDot,
  Library,
  ListChecks,
  Loader2,
  ScrollText,
  Search,
  SearchCode,
  ShieldCheck,
  Telescope,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type { SourceDto, ToolEventDto } from "../../shared/types";

export const TOOL_ICONS: Record<string, typeof Wrench> = {
  calculator: Calculator,
  current_datetime: Clock,
  remember: Bookmark,
  forget: BookmarkMinus,
  web_search: Search,
  read_page: FileText,
  weather: CloudSun,
  wikipedia: BookOpen,
  currency: Coins,
  search_knowledge: Library,
  answer_check: ShieldCheck, // admin-only number check
  research_plan: Telescope, // deep research: planning the searches
  context_summary: ScrollText, // a long chat's older part kept as short notes
  fact_check: ListChecks, // a research report checked against its sources (v0.11.0)
  github_repo: FolderGit2, // the user's own GitHub, read-only (v0.12.0)
  github_file: FileCode,
  github_search: SearchCode,
  github_issues: CircleDot,
  github_pr_changes: GitPullRequest,
};

/** Every source used for a reply, once each, in the order the tools found them. */
export function collectSources(tools: ToolEventDto[] | null | undefined): SourceDto[] {
  const seen = new Set<string>();
  const out: SourceDto[] = [];
  for (const tool of tools ?? []) {
    for (const source of tool.sources ?? []) {
      // Web pages need an http(s) link; knowledge-base documents are identified by title + location.
      if (source.url !== undefined && !/^https?:\/\//i.test(source.url)) continue;
      const key = source.url ? `${source.url}|${source.location ?? ""}` : `doc:${source.title}|${source.location ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(source);
    }
  }
  return out;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Numbered source links under an answer (shown to everyone). */
export function SourceList({ sources }: { sources: SourceDto[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Sources">
      <span className="text-[var(--text-soft)]">Sources:</span>
      {sources.map((s, i) =>
        s.url ? (
          <a
            key={`${s.url}|${s.location ?? ""}`}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={`${s.title}\n${s.url}`}
            className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <span className="shrink-0 font-medium">{i + 1}</span>
            {/* GitHub sources are all on github.com: show which repo, file and lines instead. */}
            <span className="truncate">{hostOf(s.url) === "github.com" ? s.title : hostOf(s.url)}</span>
          </a>
        ) : (
          <span
            key={`doc:${s.title}|${s.location ?? ""}`}
            title={s.location ? `${s.title}, ${s.location}` : s.title}
            className="inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--text-soft)]"
          >
            <span className="shrink-0 font-medium">{i + 1}</span>
            <FileText size={11} className="shrink-0" />
            <span className="truncate">{s.location ? `${s.title} · ${s.location}` : s.title}</span>
          </span>
        ),
      )}
    </div>
  );
}

function ToolRow({ tool }: { tool: ToolEventDto }) {
  const [open, setOpen] = useState(false);
  const Icon = tool.status === "running" ? Loader2 : tool.status === "error" ? CircleAlert : (TOOL_ICONS[tool.name] ?? Wrench);
  const hasArgs = Object.keys(tool.args).length > 0;
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => hasArgs && setOpen((o) => !o)}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${hasArgs ? "hover:bg-[var(--bg-hover)]" : "cursor-default"}`}
        aria-expanded={hasArgs ? open : undefined}
      >
        <Icon
          size={13}
          className={`shrink-0 ${tool.status === "running" ? "animate-spin" : ""} ${tool.status === "error" ? "text-[var(--danger)]" : "text-[var(--accent)]"}`}
        />
        <span className="shrink-0 font-medium text-[var(--text)]">{tool.label}</span>
        <span className={`min-w-0 flex-1 truncate ${tool.status === "error" ? "text-[var(--danger)]" : "text-[var(--text-soft)]"}`}>
          {tool.status === "running" ? "working…" : tool.summary}
        </span>
        {hasArgs ? <ChevronRight size={13} className={`shrink-0 text-[var(--text-soft)] transition-transform ${open ? "rotate-90" : ""}`} /> : null}
      </button>
      {open ? (
        <pre className="mx-2 mt-1 overflow-x-auto rounded-md bg-[var(--bg-soft)] p-2 font-mono text-[11px] text-[var(--text-soft)]">
          {JSON.stringify(tool.args, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

/** Plain wording for regular users: what the assistant did, without technical details. */
const PLAIN: Record<string, [running: string, done: string]> = {
  calculator: ["Calculating…", "Calculated"],
  current_datetime: ["Checking the date & time…", "Checked the date & time"],
  remember: ["Saving to memory…", "Saved to memory"],
  forget: ["Updating memory…", "Removed from memory"],
  web_search: ["Searching the web…", "Searched the web"],
  read_page: ["Reading a page…", "Read a page"],
  weather: ["Checking the weather…", "Checked the weather"],
  wikipedia: ["Looking it up on Wikipedia…", "Looked it up on Wikipedia"],
  currency: ["Checking exchange rates…", "Checked exchange rates"],
  search_knowledge: ["Searching the knowledge base…", "Searched the knowledge base"],
  fact_check: ["Checking the facts against the sources…", "Checked the facts against the sources"],
  github_repo: ["Looking at the repository…", "Looked at the repository"],
  github_file: ["Reading code…", "Read code"],
  github_search: ["Searching the code…", "Searched the code"],
  github_issues: ["Reading issues…", "Read issues"],
  github_pr_changes: ["Reading the pull request…", "Read the pull request"],
};

function PlainToolLine({ tool }: { tool: ToolEventDto }) {
  const Icon = tool.status === "running" ? Loader2 : tool.status === "error" ? CircleAlert : (TOOL_ICONS[tool.name] ?? Wrench);
  const [running, done] = PLAIN[tool.name] ?? [`${tool.label}…`, tool.label];
  const text = tool.status === "running" ? running : tool.status === "error" ? `${tool.label}: didn't work` : done;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon size={12} className={`shrink-0 ${tool.status === "running" ? "animate-spin" : ""}`} />
      {text}
    </span>
  );
}

/**
 * Tools used while producing a reply. Admins get the detailed, expandable list; regular users
 * (`plain`) get one quiet line such as "Checked the date & time".
 */
export function ToolActivity({ tools, plain = false }: { tools: ToolEventDto[]; plain?: boolean }) {
  if (plain) {
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-soft)]" aria-label="What the assistant did">
        {tools.map((t) => (
          <PlainToolLine key={t.id} tool={t} />
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-[var(--border)] py-1" aria-label="Tools used">
      {tools.map((t) => (
        <ToolRow key={t.id} tool={t} />
      ))}
    </div>
  );
}
