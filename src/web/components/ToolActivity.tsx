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
  GitPullRequestArrow,
  CircleDot,
  FileSpreadsheet,
  Library,
  ListChecks,
  Loader2,
  MessageSquare,
  ScrollText,
  Search,
  SearchCode,
  ShieldCheck,
  Telescope,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import type { SourceDto, ToolEventDto } from "../../shared/types";
import { chipLabels } from "../lib/format";

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
  query_table: FileSpreadsheet, // exact figures from an attached spreadsheet (v0.14.0)
  answer_check: ShieldCheck, // admin-only number check
  research_plan: Telescope, // deep research: planning the searches
  context_summary: ScrollText, // a long chat's older part kept as short notes
  fact_check: ListChecks, // a research report checked against its sources (v0.11.0)
  github_repo: FolderGit2, // the user's own GitHub, read-only (v0.12.0)
  github_file: FileCode,
  github_search: SearchCode,
  github_issues: CircleDot,
  github_pr_changes: GitPullRequest,
  // Prepared GitHub changes, sent only after the user approves the card (v0.13.0).
  github_create_issue: CircleDot,
  github_comment: MessageSquare,
  github_open_pr: GitPullRequestArrow,
};

/**
 * Numbered source links under an answer (shown to everyone). `more` are search results the answer didn't link to
 * (v0.12.4): folded behind "+N other results checked", shown fainter when opened.
 */
export function SourceList({ sources, more = [] }: { sources: SourceDto[]; more?: SourceDto[] }) {
  const [showMore, setShowMore] = useState(false);
  if (sources.length === 0 && more.length === 0) return null;
  const visible = showMore ? [...sources, ...more] : sources;
  const labels = chipLabels(visible);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Sources">
      <span className="text-[var(--text-soft)]">Sources:</span>
      {visible.map((s, i) => {
        const faint = i >= sources.length ? "opacity-70" : "";
        return s.url ? (
          <a
            key={`${s.url}|${s.location ?? ""}`}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={`${s.title}\n${s.url}`}
            className={`inline-flex max-w-[20rem] items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] ${faint}`}
          >
            <span className="shrink-0 font-medium">{i + 1}</span>
            <span className="truncate">{labels[i]}</span>
          </a>
        ) : (
          <span
            key={`doc:${s.title}|${s.location ?? ""}`}
            title={s.location ? `${s.title}, ${s.location}` : s.title}
            className={`inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--text-soft)] ${faint}`}
          >
            <span className="shrink-0 font-medium">{i + 1}</span>
            {s.kind === "table" ? <FileSpreadsheet size={11} className="shrink-0" /> : <FileText size={11} className="shrink-0" />}
            <span className="truncate">{labels[i]}</span>
          </span>
        );
      })}
      {more.length ? (
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          aria-expanded={showMore}
          title={showMore ? undefined : "Search results that were checked but not used in this answer"}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
        >
          {showMore ? "Show fewer" : `+${more.length} other result${more.length === 1 ? "" : "s"} checked`}
        </button>
      ) : null}
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
  query_table: ["Calculating from the spreadsheet…", "Calculated from the spreadsheet"],
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
