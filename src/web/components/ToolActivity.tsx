import { Bookmark, BookmarkMinus, Calculator, ChevronRight, CircleAlert, Clock, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import type { ToolEventDto } from "../../shared/types";

const ICONS: Record<string, typeof Wrench> = {
  calculator: Calculator,
  current_datetime: Clock,
  remember: Bookmark,
  forget: BookmarkMinus,
};

function ToolRow({ tool }: { tool: ToolEventDto }) {
  const [open, setOpen] = useState(false);
  const Icon = tool.status === "running" ? Loader2 : tool.status === "error" ? CircleAlert : (ICONS[tool.name] ?? Wrench);
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
};

function PlainToolLine({ tool }: { tool: ToolEventDto }) {
  const Icon = tool.status === "running" ? Loader2 : tool.status === "error" ? CircleAlert : (ICONS[tool.name] ?? Wrench);
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
