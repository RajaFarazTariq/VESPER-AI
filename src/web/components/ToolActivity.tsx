import {
  BookOpen,
  BookOpenText,
  Bookmark,
  BookmarkMinus,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  Calculator,
  ChevronRight,
  CircleAlert,
  Clock,
  CloudSun,
  Coins,
  FileCode,
  FileSearch,
  FileText,
  FolderGit2,
  GitPullRequest,
  GitPullRequestArrow,
  CircleDot,
  FileSpreadsheet,
  Library,
  ListChecks,
  Loader2,
  Mail,
  MessageSquare,
  ScrollText,
  Search,
  SearchCode,
  ShieldCheck,
  Telescope,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SourceDto, ToolEventDto } from "../../shared/types";
import { useMenuLayout } from "../hooks/useMenuLayout";
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
  // Google Calendar and Gmail (v0.15.0): reading, and events and emails prepared for the user's approval.
  calendar_events: CalendarDays,
  calendar_free_time: CalendarClock,
  calendar_create_event: CalendarPlus,
  gmail_send: Mail,
  // Documents the user attached to the chat (v0.16.0): find passages, or read a document in order.
  search_documents: FileSearch,
  read_document: BookOpenText,
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
        ) : s.kind === "document" && s.excerpt ? (
          <DocumentSourceChip key={`doc:${s.title}|${s.location ?? ""}`} source={s} number={i + 1} label={labels[i]!} faint={faint} />
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

const POPOVER_WIDTH = 320;

/**
 * A passage of a document the user attached to the chat (v0.16.0): the chip opens a small panel with the start of
 * the passage the answer used, so the user can see what it says without the file. Escape, a click outside or the
 * close button closes it; focus then goes back to the chip.
 */
function DocumentSourceChip({ source, number, label, faint }: { source: SourceDto; number: number; label: string; faint: string }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const root = useRef<HTMLSpanElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  // Opens below the chip, or above it when there's more room there (measured inside the scrolling chat).
  const layout = useMenuLayout(root, open, "down", 200);
  const place = source.location ? `${source.title}, ${source.location}` : source.title;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) chip.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    // Keep the panel on screen: move it left when the chip is near the right edge (phones).
    const rect = root.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 32);
      setShift(Math.min(0, window.innerWidth - 16 - width - rect.left));
    }
    panel.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Focus goes back to the chip only when it was in the chip or the panel (not when typing elsewhere).
      close(Boolean(root.current?.contains(document.activeElement)));
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={root}
      className="relative inline-flex max-w-[18rem]"
      // Tabbing on past the panel closes it (switching to another window doesn't).
      onBlur={(e) => {
        if (open && e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={chip}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        title={place}
        className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] ${
          open ? "border-[var(--accent)] text-[var(--text)]" : "border-[var(--border)]"
        } ${faint}`}
      >
        <span className="shrink-0 font-medium">{number}</span>
        <FileText size={11} className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open ? (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={`From the document: ${place}`}
          tabIndex={-1}
          className={`absolute z-30 flex w-80 max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] text-left shadow-[var(--shadow-lg)] outline-none ${
            layout.up ? "bottom-full mb-1.5" : "top-full mt-1.5"
          }`}
          style={{ left: shift, maxHeight: layout.maxHeight }}
        >
          <div className="flex shrink-0 items-start gap-2 border-b border-[var(--border)] px-3 pb-2 pt-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">From the document</p>
              <p className="mt-0.5 truncate text-xs font-medium text-[var(--text)]" title={place}>
                {label}
              </p>
            </div>
            <button
              type="button"
              onClick={() => close(true)}
              className="-mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
              aria-label="Close"
              title="Close"
            >
              <X size={13} />
            </button>
          </div>
          <p className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2.5 text-[13px] leading-relaxed text-[var(--text-soft)] thin-scroll">
            {source.excerpt}
          </p>
        </div>
      ) : null}
    </span>
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
  calendar_events: ["Reading your calendar…", "Read your calendar"],
  calendar_free_time: ["Finding free time…", "Found free time"],
  calendar_create_event: ["Preparing the event…", "Prepared an event for your approval"],
  gmail_send: ["Preparing the email…", "Prepared an email for your approval"],
  search_documents: ["Searching your documents…", "Searched your documents"],
  read_document: ["Reading the document…", "Read the document"],
};

/** One step in plain words, e.g. "Reading your calendar…" while it runs (also VESPER Agent's step line, v0.17.0). */
export function plainToolText(tool: ToolEventDto): string {
  const [running, done] = PLAIN[tool.name] ?? [`${tool.label}…`, tool.label];
  return tool.status === "running" ? running : tool.status === "error" ? `${tool.label}: didn't work` : done;
}

function PlainToolLine({ tool }: { tool: ToolEventDto }) {
  const Icon = tool.status === "running" ? Loader2 : tool.status === "error" ? CircleAlert : (TOOL_ICONS[tool.name] ?? Wrench);
  const text = plainToolText(tool);
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
