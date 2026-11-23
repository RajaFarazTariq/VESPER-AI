import {
  AlertTriangle,
  Brain,
  ChevronDown,
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  FileSpreadsheet,
  FileText,
  Info,
  Loader2,
  Pencil,
  RotateCcw,
  ShieldCheck,
  Square,
  ThumbsDown,
  ThumbsUp,
  Volume2,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import {
  FEEDBACK_REASONS,
  type ClaimVerdict,
  type FeedbackReason,
  type MessageFeedbackDto,
  type VerificationDto,
} from "../../shared/types";
import { api, ApiError } from "../api/client";
import type { UiMessage } from "../hooks/useChat";
import {
  answerSources,
  FEEDBACK_LABELS,
  githubLineLinks,
  hostOf,
  plainDocumentLinks,
  providerLabel,
  tidyCitations,
} from "../lib/format";
import { canSpeak, speak, stopSpeaking, useSpeakingId } from "../lib/voice";
import { CopyButton, Markdown } from "./Markdown";
import { GithubActionCard } from "./GithubActionCard";
import { TableResults } from "./TableResultCard";
import { SourceList, ToolActivity } from "./ToolActivity";
import { VesperMark } from "./VesperMark";

interface Props {
  message: UiMessage;
  isLast: boolean;
  canRetry: boolean;
  onRetry: () => void;
  /** Admins see technical details (tool inputs, provider/model). The server also filters for users. */
  isAdmin?: boolean;
  /** Only the last message you sent can be edited (the reply after it is replaced). */
  canEdit?: boolean;
  onEdit?: (text: string) => Promise<boolean>;
  /** Show "Read aloud" on answers (the admin's Voice switch). */
  readAloud?: boolean;
  /** Offer "Check this answer" on answers that used sources (the admin's switch, v0.11.0). */
  answerCheck?: boolean;
}

const actionButton =
  "inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]";

export const MessageItem = memo(function MessageItem(props: Props) {
  const { message, canEdit = false, onEdit } = props;
  if (message.role === "user") return <UserMessage message={message} canEdit={canEdit} onEdit={onEdit} />;
  return <AssistantMessage {...props} />;
});

function AssistantMessage({ message, isLast, canRetry, onRetry, isAdmin = false, readAloud = false, answerCheck = false }: Props) {
  const feedback = useFeedback(message);
  const check = useAnswerCheck(message, answerCheck);
  const working = message.streaming && !message.content;
  const runningTool = message.tools?.some((t) => t.status === "running");
  const failed = message.status === "error" || message.status === "partial";
  const documentTitles = (message.tools ?? []).flatMap((t) => t.sources ?? []).filter((s) => !s.url).map((s) => s.title);
  const content = githubLineLinks(plainDocumentLinks(tidyCitations(message.content), documentTitles), message.tools);
  const sources = message.streaming ? { shown: [], unused: [] } : answerSources(message.tools, content);

  return (
    <div className="rise-in group flex gap-3 sm:gap-4">
      <VesperMark className="mt-0.5 h-7 w-7 shrink-0 rounded-lg shadow-[var(--shadow-sm)]" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        {message.notices?.map((notice, i) => (
          <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>{notice}</span>
          </div>
        ))}

        {message.reasoning ? <Reasoning text={message.reasoning} streaming={Boolean(message.streaming && !message.content)} /> : null}

        {message.tools?.length ? <ToolActivity tools={message.tools} plain={!isAdmin} /> : null}

        {working && !runningTool && !message.reasoning ? (
          <div className="flex h-7 items-center gap-2 text-sm" role="status">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
            </span>
            <span className="shimmer-text font-medium">{isAdmin && message.provider ? `Asking ${providerLabel(message.provider)}…` : "Thinking…"}</span>
          </div>
        ) : message.content ? (
          <div className={message.streaming ? "streaming-caret" : undefined}>
            <Markdown text={content} />
          </div>
        ) : null}

        {/* Spreadsheet results: a chart or table each, with a CSV download (v0.14.1). After the answer is written. */}
        {!message.streaming ? <TableResults tools={message.tools} /> : null}

        {/* GitHub changes this answer prepared: sent only when the user approves the card (v0.13.0). */}
        {(message.tools ?? []).flatMap((t) => (t.action ? [<GithubActionCard key={t.action.id} action={t.action} />] : []))}

        <SourceList sources={sources.shown} more={sources.unused} />

        {check.value ? <VerificationCard verification={check.value} defaultOpen={check.justChecked} isAdmin={isAdmin} /> : null}

        {failed && message.error ? (
          <div className="flex flex-col gap-2 rounded-xl border border-[var(--danger)]/30 bg-[var(--danger)]/5 px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-[var(--danger)]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{message.error}</span>
            </div>
            {canRetry && isLast ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
              >
                <RotateCcw size={13} /> Try again
              </button>
            ) : null}
          </div>
        ) : null}

        {!message.streaming && (message.content || message.provider) ? (
          <div
            className={`-ml-2 flex flex-wrap items-center gap-0.5 transition-opacity ${
              isLast ? "opacity-100" : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
            }`}
          >
            {message.content ? <CopyButton text={content} /> : null}
            {readAloud && message.content && canSpeak() ? <ReadAloudButton id={message.id} text={content} /> : null}
            {feedback.available ? (
              <>
                <button
                  type="button"
                  onClick={() => feedback.rate(1)}
                  className={`${actionButton} ${feedback.value?.rating === 1 ? "text-[var(--accent)]" : ""}`}
                  title={feedback.value?.rating === 1 ? "Take back “Good answer”" : "Good answer"}
                  aria-label="Good answer"
                  aria-pressed={feedback.value?.rating === 1}
                >
                  <ThumbsUp size={14} fill={feedback.value?.rating === 1 ? "currentColor" : "none"} />
                </button>
                <button
                  type="button"
                  onClick={() => feedback.rate(-1)}
                  className={`${actionButton} ${feedback.value?.rating === -1 ? "text-[var(--accent)]" : ""}`}
                  title={feedback.value?.rating === -1 ? "Take back “Bad answer”" : "Bad answer"}
                  aria-label="Bad answer"
                  aria-pressed={feedback.value?.rating === -1}
                >
                  <ThumbsDown size={14} fill={feedback.value?.rating === -1 ? "currentColor" : "none"} />
                </button>
              </>
            ) : null}
            {check.available ? (
              <button
                type="button"
                onClick={() => void check.run()}
                disabled={check.running}
                className={`${actionButton} disabled:opacity-60`}
                title="Check this answer against the sources it used"
              >
                {check.running ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                <span className="sr-only sm:not-sr-only">{check.running ? "Checking…" : "Check"}</span>
              </button>
            ) : null}
            {canRetry && isLast && !failed ? (
              <button type="button" onClick={onRetry} className={actionButton} title="Regenerate">
                <RotateCcw size={14} />
                <span className="sr-only sm:not-sr-only">Regenerate</span>
              </button>
            ) : null}
            {message.provider ? (
              <span className="ml-1 truncate text-xs text-[var(--text-faint)]" title={`${message.provider}:${message.model}`}>
                {providerLabel(message.provider)} · {message.model}
              </span>
            ) : null}
            {feedback.notice ? (
              <span className="ml-1 text-xs text-[var(--text-soft)]" role="status">
                {feedback.notice}
              </span>
            ) : null}
            {check.notice ? (
              <span className="ml-1 text-xs text-[var(--danger)]" role="status">
                {check.notice}
              </span>
            ) : null}
          </div>
        ) : null}

        {feedback.panelOpen ? <FeedbackPanel onSend={feedback.sendDetails} onSkip={feedback.closePanel} /> : null}
      </div>
    </div>
  );
}

/** "Check this answer": one request; the result is saved with the answer, so it shows again when the chat is reopened. */
function useAnswerCheck(message: UiMessage, enabled: boolean) {
  const [value, setValue] = useState<VerificationDto | null>(message.verification ?? null);
  const [running, setRunning] = useState(false);
  const [justChecked, setJustChecked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setValue(message.verification ?? null), [message.verification]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return {
    available:
      enabled &&
      !value &&
      Boolean(message.checkable) &&
      !message.streaming &&
      message.status === "complete" &&
      !message.id.startsWith("local-"),
    value,
    running,
    justChecked,
    notice,
    run: async () => {
      setRunning(true);
      setNotice(null);
      try {
        const { verification } = await api.checkAnswer(message.id);
        setValue(verification);
        setJustChecked(true);
      } catch (e) {
        setNotice(e instanceof ApiError ? e.message : "Couldn't check the answer.");
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setNotice(null), 8000);
      } finally {
        setRunning(false);
      }
    },
  };
}

const VERDICT: Record<ClaimVerdict, { label: string; Icon: typeof CircleCheck; tone: string }> = {
  supported: { label: "Supported", Icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  contradicted: { label: "Contradicted", Icon: CircleX, tone: "text-[var(--danger)]" },
  not_found: { label: "Not in the sources", Icon: CircleQuestionMark, tone: "text-amber-600 dark:text-amber-400" },
};

/** "4 of 5 claims supported · 1 not in the sources" */
function checkSummary(v: VerificationDto): string {
  if (v.claims.length === 0) return "No specific facts to check in this answer";
  const count = (verdict: ClaimVerdict) => v.claims.filter((c) => c.verdict === verdict).length;
  const parts = [`${count("supported")} of ${v.claims.length} claim${v.claims.length === 1 ? "" : "s"} supported`];
  if (count("contradicted")) parts.push(`${count("contradicted")} contradicted`);
  if (count("not_found")) parts.push(`${count("not_found")} not in the sources`);
  return parts.join(" · ");
}

/** The answer's key claims, each rated against the sources it used (open right after "Check"; otherwise folded). */
function VerificationCard({ verification, defaultOpen, isAdmin }: { verification: VerificationDto; defaultOpen: boolean; isAdmin: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const flagged = verification.claims.some((c) => c.verdict !== "supported");
  return (
    <div className="rise-in rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <ShieldCheck size={15} className={`shrink-0 ${flagged ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`} />
        <span className="shrink-0 font-medium">Fact check</span>
        <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-soft)]">{checkSummary(verification)}</span>
        <ChevronDown size={14} className={`shrink-0 text-[var(--text-soft)] transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="border-t border-[var(--border)] px-3 py-2">
          {verification.claims.length ? (
            <ul className="flex flex-col gap-2">
              {verification.claims.map((c, i) => {
                const { label, Icon, tone } = VERDICT[c.verdict];
                return (
                  <li key={i} className="flex gap-2">
                    <Icon size={15} className={`mt-0.5 shrink-0 ${tone}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="break-words leading-snug">{c.claim}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-[var(--text-soft)]">
                        <span className={`font-medium ${tone}`}>{label}</span>
                        {c.source?.url ? (
                          <a
                            href={c.source.url}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            title={`${c.source.title}\n${c.source.url}`}
                            className="inline-flex max-w-[14rem] items-center rounded-full border border-[var(--border)] px-2 py-px hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                          >
                            <span className="truncate">{hostOf(c.source.url)}</span>
                          </a>
                        ) : c.source ? (
                          <span
                            title={c.source.location ? `${c.source.title}, ${c.source.location}` : c.source.title}
                            className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-[var(--border)] px-2 py-px"
                          >
                            <FileText size={11} className="shrink-0" />
                            <span className="truncate">{c.source.location ? `${c.source.title} · ${c.source.location}` : c.source.title}</span>
                          </span>
                        ) : null}
                      </p>
                      {c.note ? <p className="mt-0.5 break-words text-xs text-[var(--text-soft)]">{c.note}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[var(--text-soft)]">The answer makes no specific factual claims to check.</p>
          )}
          <p className="mt-2 text-xs text-[var(--text-faint)]">
            Checked automatically against the sources this answer used{verification.trigger === "auto" ? ", right after it was written" : ""}. The
            check can make mistakes too: open a source to be sure.
            {isAdmin && verification.by ? ` · ${verification.by}` : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** 👍/👎 for one answer: saved at once; a 👎 then asks (optionally) what was wrong. Clicking the same thumb again takes it back. */
function useFeedback(message: UiMessage) {
  const [value, setValue] = useState<MessageFeedbackDto | null>(message.feedback ?? null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setValue(message.feedback ?? null), [message.feedback]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const flash = (text: string) => {
    setNotice(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setNotice(null), 3500);
  };

  const save = async (body: { rating: 1 | -1 | 0; reason?: FeedbackReason | null; note?: string | null }, optimistic: MessageFeedbackDto | null) => {
    const previous = value;
    setValue(optimistic);
    try {
      const { feedback } = await api.feedback(message.id, body);
      setValue(feedback);
      return true;
    } catch (e) {
      setValue(previous);
      flash(e instanceof ApiError && e.status === 429 ? "Too many clicks; try again in a minute." : "Couldn't save your feedback.");
      return false;
    }
  };

  return {
    // Only finished answers saved on the server (not the temporary ones still streaming).
    available: !message.streaming && Boolean(message.content) && !message.id.startsWith("local-"),
    value,
    panelOpen,
    notice,
    rate: async (rating: 1 | -1) => {
      if (value?.rating === rating) {
        setPanelOpen(false);
        await save({ rating: 0 }, null);
        return;
      }
      setPanelOpen(rating === -1);
      const ok = await save({ rating }, { rating, reason: null, note: null });
      if (!ok) setPanelOpen(false);
      else if (rating === 1) flash("Thanks for your feedback.");
    },
    sendDetails: async (reason: FeedbackReason | null, note: string) => {
      setPanelOpen(false);
      if (await save({ rating: -1, reason, note: note.trim() || null }, { rating: -1, reason, note: note.trim() || null })) {
        flash("Thanks for your feedback.");
      }
    },
    closePanel: () => {
      setPanelOpen(false);
      flash("Thanks for your feedback.");
    },
  };
}

function FeedbackPanel({ onSend, onSkip }: { onSend: (reason: FeedbackReason | null, note: string) => void; onSkip: () => void }) {
  const [reason, setReason] = useState<FeedbackReason | null>(null);
  const [note, setNote] = useState("");
  return (
    <div className="rise-in rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-3 text-sm" role="group" aria-label="What was wrong with this answer?">
      <div className="mb-2 font-medium">
        What was wrong? <span className="font-normal text-[var(--text-soft)]">(optional)</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {FEEDBACK_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setReason(reason === r ? null : r)}
            aria-pressed={reason === r}
            className={`rounded-full border px-3 py-1 text-xs ${
              reason === r
                ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                : "border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-soft)] hover:text-[var(--text)]"
            }`}
          >
            {FEEDBACK_LABELS[r]}
          </button>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={1000}
        rows={2}
        placeholder="Add details, e.g. the correct figure or source (optional)"
        aria-label="Feedback details"
        className="mt-2 w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-sm"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" onClick={onSkip} className="rounded-lg px-3 py-1.5 text-xs text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
          Skip
        </button>
        <button
          type="button"
          onClick={() => onSend(reason, note)}
          disabled={!reason && !note.trim()}
          className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)] disabled:opacity-40"
        >
          Send
        </button>
      </div>
    </div>
  );
}

function UserMessage({ message, canEdit, onEdit }: { message: UiMessage; canEdit: boolean; onEdit?: (text: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing || !box.current) return;
    const el = box.current;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [draft, editing]);

  const submit = async () => {
    const text = draft.trim();
    if (!text || !onEdit) return;
    setEditing(false);
    if (text === message.content.trim()) return;
    const ok = await onEdit(text);
    if (!ok) setDraft(message.content);
  };

  if (editing) {
    return (
      <div className="rise-in ml-auto w-full max-w-[85%]">
        <div className="rounded-3xl border border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-[var(--bg-elevated)] p-3 shadow-[var(--shadow-md)]">
          <textarea
            ref={box}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Escape") {
                setEditing(false);
                setDraft(message.content);
              }
            }}
            aria-label="Edit your message"
            className="block w-full resize-none bg-transparent px-1 leading-relaxed outline-none"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(message.content);
              }}
              className="rounded-full px-3.5 py-1.5 text-sm text-[var(--text-soft)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim()}
              className="rounded-full bg-[var(--accent)] px-3.5 py-1.5 text-sm font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)] disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rise-in group flex flex-col items-end gap-1">
      {message.files?.length ? (
        <ul className="flex max-w-[85%] flex-wrap justify-end gap-2" aria-label="Attached spreadsheets">
          {message.files.map((f) => (
            <li
              key={f.id}
              className="flex max-w-[18rem] items-center gap-2.5 rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] py-2 pl-2.5 pr-3.5"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
                <FileSpreadsheet size={16} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium" title={f.name}>
                  {f.name}
                </span>
                <span className="block text-xs text-[var(--text-soft)]">
                  {f.rows.toLocaleString()} row{f.rows === 1 ? "" : "s"}
                  {f.sheets > 1 ? ` · ${f.sheets} sheets` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {message.images?.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {message.images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`Attached image ${i + 1}`}
              className="h-32 w-32 rounded-xl border border-[var(--border)] object-cover sm:h-36 sm:w-36"
            />
          ))}
        </div>
      ) : null}
      {message.content ? (
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-3xl rounded-br-lg bg-[var(--user-bubble)] px-4 py-2.5 text-[15px] leading-relaxed">
          {message.content}
        </div>
      ) : null}
      <div className="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        {message.content ? <CopyButton text={message.content} /> : null}
        {canEdit && onEdit ? (
          <button
            type="button"
            onClick={() => {
              setDraft(message.content);
              setEditing(true);
            }}
            className={actionButton}
            title="Edit and resend"
          >
            <Pencil size={13} />
            <span className="sr-only sm:not-sr-only">Edit</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Reads the answer with the device's built-in voice; press again to stop. */
function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const speaking = useSpeakingId() === id;
  return (
    <button
      type="button"
      onClick={() => (speaking ? stopSpeaking() : speak(id, text))}
      className={actionButton}
      title={speaking ? "Stop reading" : "Read aloud"}
      aria-pressed={speaking}
    >
      {speaking ? <Square size={12} fill="currentColor" /> : <Volume2 size={14} />}
      <span className="sr-only sm:not-sr-only">{speaking ? "Stop" : "Read aloud"}</span>
    </button>
  );
}

function Reasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] text-sm">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[var(--text-soft)] hover:text-[var(--text)]"
        aria-expanded={open}
      >
        <Brain size={14} className="text-[var(--accent)]" />
        <span className={streaming ? "shimmer-text font-medium" : ""}>{streaming ? "Thinking…" : "Thought process"}</span>
        <ChevronDown size={14} className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="max-h-72 overflow-y-auto whitespace-pre-wrap border-t border-[var(--border)] px-3 py-2 text-xs leading-relaxed text-[var(--text-soft)] thin-scroll">
          {text}
        </div>
      ) : null}
    </div>
  );
}
