import { AlertTriangle, CalendarPlus, Check, ExternalLink, Loader2, Mail, RotateCcw, Video, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { GoogleActionDto, GoogleActionKind, GoogleActionRefDto, GoogleActionStatus, GoogleEventPreviewDto } from "../../shared/types";
import { api, ApiError } from "../api/client";

export const GOOGLE_KIND_LABEL: Record<GoogleActionKind, string> = { email: "Email", event: "Calendar event" };
export const GOOGLE_STATUS_LABEL: Record<GoogleActionKind, Record<GoogleActionStatus, string>> = {
  email: { pending: "Waiting for your approval", running: "Sending…", done: "Sent", failed: "Couldn't be sent", rejected: "Rejected", expired: "Expired" },
  event: { pending: "Waiting for your approval", running: "Adding…", done: "Added", failed: "Couldn't be added", rejected: "Rejected", expired: "Expired" },
};
export const googleStatusTone = (status: GoogleActionStatus) =>
  status === "done"
    ? "text-emerald-700 dark:text-emerald-400"
    : status === "failed"
      ? "text-[var(--danger)]"
      : status === "pending" || status === "running"
        ? "text-amber-700 dark:text-amber-300"
        : "text-[var(--text-soft)]";

const timeLeft = (until: number) => {
  const minutes = Math.max(0, Math.round((until - Date.now()) / 60_000));
  return minutes >= 120 ? `${Math.round(minutes / 60)} hours` : minutes >= 60 ? "1 hour" : `${minutes} minutes`;
};

/** "Tue, 2 Dec 2026" for a YYYY-MM-DD date, in the reader's language (the date is a calendar date: no time zone moves it). */
const dayText = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

/** When the event is, as written on the card. */
export function eventWhen(e: Pick<GoogleEventPreviewDto, "start" | "end" | "allDay">): string {
  if (e.allDay) return e.start === e.end ? `${dayText(e.start)} · all day` : `${dayText(e.start)} – ${dayText(e.end)} · all day`;
  const [sd, st] = e.start.split("T") as [string, string];
  const [ed, et] = e.end.split("T") as [string, string];
  return sd === ed ? `${dayText(sd)} · ${st}–${et}` : `${dayText(sd)} ${st} – ${dayText(ed)} ${et}`;
}

/** "1 hour before", "1 day 2 hours before", "at the start". */
export function beforeText(minutes: number): string {
  if (minutes === 0) return "at the start";
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  const parts = [d ? `${d} day${d === 1 ? "" : "s"}` : "", h ? `${h} hour${h === 1 ? "" : "s"}` : "", m ? `${m} minute${m === 1 ? "" : "s"}` : ""].filter(Boolean);
  return `${parts.join(" ")} before`;
}

const splitAddresses = (text: string) =>
  text
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

const field = "w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-[13px] focus:border-[var(--accent)] focus:outline-none";

type Draft = { to: string; cc: string; subject: string; body: string };
/**
 * Edits in progress, by card. The card is drawn again when the answer finishes (it then gets its saved id), so edits
 * made while the answer was still being written are kept here instead of in the card alone.
 */
const drafts = new Map<string, Draft>();

/**
 * An email or calendar event VESPER prepared (v0.15.0): exactly what will happen, with Approve / Reject. Nothing is
 * sent or added before Approve; an email can still be edited here first. The card loads its current state, so it is
 * right after a reload or on another device too.
 */
export function GoogleActionCard({ action: ref }: { action: GoogleActionRefDto }) {
  const [action, setAction] = useState<GoogleActionDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [draft, setDraftState] = useState<Draft | null>(() => drafts.get(ref.id) ?? null);
  const setDraft = (next: Draft | null) => {
    if (next) drafts.set(ref.id, next);
    else drafts.delete(ref.id);
    setDraftState(next);
  };

  const load = useCallback(() => {
    api.googleAction(ref.id).then(
      (r) => setAction(r.action),
      (e: unknown) => setError(e instanceof ApiError && e.status === 404 ? "This is no longer available." : "Couldn't load this."),
    );
  }, [ref.id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (action?.status !== "running") return;
    const timer = setTimeout(load, 2_000);
    return () => clearTimeout(timer);
  }, [action, load]);

  const original = action?.email
    ? { to: action.email.to.join(", "), cc: action.email.cc.join(", "), subject: action.email.subject, body: action.email.body }
    : null;
  const current = draft ?? original;
  const edited = Boolean(draft && original && JSON.stringify(draft) !== JSON.stringify(original));

  const decide = async (decision: "approve" | "reject") => {
    setBusy(decision);
    setError(null);
    try {
      const r =
        decision === "reject"
          ? await api.rejectGoogleAction(ref.id)
          : await api.approveGoogleAction(
              ref.id,
              edited && current ? { to: splitAddresses(current.to), cc: splitAddresses(current.cc), subject: current.subject, body: current.body } : undefined,
            );
      setAction(r.action);
      setDraft(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Something went wrong. Please try again.");
      if (!(e instanceof ApiError && e.status === 400)) load();
    } finally {
      setBusy(null);
    }
  };

  const Icon = ref.kind === "email" ? Mail : CalendarPlus;
  const status = action?.status ?? null;
  const pending = status === "pending" && action !== null;
  const account = action?.email?.from ?? action?.event?.account ?? null;
  return (
    <section
      className="rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] text-sm shadow-[var(--shadow-sm)]"
      aria-label={`${GOOGLE_KIND_LABEL[ref.kind]}: ${ref.title}`}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] px-3.5 py-2.5">
        <Icon size={15} className="shrink-0 text-[var(--accent)]" />
        <span className="font-medium">{GOOGLE_KIND_LABEL[ref.kind]}</span>
        {account ? (
          <span className="min-w-0 truncate text-[var(--text-soft)]" title={account}>
            {ref.kind === "email" ? `from ${account}` : `in ${account}'s calendar`}
          </span>
        ) : null}
        <span className={`ml-auto text-xs font-medium ${status ? googleStatusTone(status) : "text-[var(--text-soft)]"}`} aria-live="polite">
          {status ? GOOGLE_STATUS_LABEL[ref.kind][status] : "Loading…"}
        </span>
      </header>

      <div className="space-y-3 px-3.5 py-3">
        {(pending ? action.warnings : []).map((w) => (
          <div key={w} className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{w}</span>
          </div>
        ))}

        {current && action?.email ? (
          pending ? (
            <div className="space-y-2">
              <Labelled label="To">
                <input className={field} value={current.to} onChange={(e) => setDraft({ ...current, to: e.target.value })} aria-label="To" spellCheck={false} />
              </Labelled>
              <Labelled label="Cc">
                <input className={field} value={current.cc} onChange={(e) => setDraft({ ...current, cc: e.target.value })} aria-label="Cc" placeholder="(none)" spellCheck={false} />
              </Labelled>
              <Labelled label="Subject">
                <input className={field} value={current.subject} onChange={(e) => setDraft({ ...current, subject: e.target.value })} aria-label="Subject" maxLength={200} />
              </Labelled>
              <Labelled label="Message">
                <AutoTextarea value={current.body} onChange={(body) => setDraft({ ...current, body })} />
              </Labelled>
              {edited ? (
                <button type="button" onClick={() => setDraft(null)} className="inline-flex items-center gap-1 text-xs text-[var(--text-soft)] hover:text-[var(--text)]">
                  <RotateCcw size={12} /> Undo my edits
                </button>
              ) : null}
            </div>
          ) : (
            <EmailView email={action.email} />
          )
        ) : null}

        {action?.event ? <EventView event={action.event} /> : null}

        {!action?.email && !action?.event ? (
          <div>
            <p className="font-medium [overflow-wrap:anywhere]">{action?.title ?? ref.title}</p>
            {action?.target ? <p className="text-xs text-[var(--text-soft)]">{action.target}</p> : null}
          </div>
        ) : null}

        {status === "done" && action?.resultUrl ? (
          <a href={action.resultUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-[var(--accent)] hover:underline">
            {ref.kind === "email" ? "Open Sent mail in Gmail" : "Open in Google Calendar"} <ExternalLink size={13} />
          </a>
        ) : null}
        {status === "failed" && action?.error ? <p className="text-[var(--danger)]">{action.error}</p> : null}
        {status === "rejected" ? <p className="text-[var(--text-soft)]">{ref.kind === "email" ? "Nothing was sent." : "Nothing was added to your calendar."}</p> : null}
        {status === "expired" ? (
          <p className="text-[var(--text-soft)]">
            Not approved in time, so {ref.kind === "email" ? "nothing was sent" : "nothing was added"}. Ask VESPER to prepare it again if you still want it.
          </p>
        ) : null}
        {error ? <p className="text-[var(--danger)]">{error}</p> : null}

        {pending ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => decide("approve")}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2 font-medium text-[var(--accent-text)] hover:bg-[var(--accent-strong)] disabled:opacity-60"
            >
              {busy === "approve" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}{" "}
              {ref.kind === "email" ? (edited ? "Send my edited email" : "Approve and send") : "Approve and add"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => decide("reject")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3.5 py-2 hover:bg-[var(--bg-hover)] disabled:opacity-60"
            >
              {busy === "reject" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Reject
            </button>
            <span className="text-xs text-[var(--text-soft)]">
              Nothing is {ref.kind === "email" ? "sent" : "added"} until you approve · expires in {timeLeft(action.expiresAt)}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid items-start gap-x-3 gap-y-0.5 sm:grid-cols-[4.5rem_minmax(0,1fr)]">
      <span className="pt-1.5 text-xs text-[var(--text-soft)]">{label}</span>
      {children}
    </label>
  );
}

function AutoTextarea({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 360)}px`;
  }, [value]);
  return <textarea ref={box} className={`${field} thin-scroll resize-y leading-relaxed`} value={value} onChange={(e) => onChange(e.target.value)} rows={5} aria-label="Message" />;
}

function EmailView({ email }: { email: NonNullable<GoogleActionDto["email"]> }) {
  return (
    <div className="space-y-1.5">
      <p className="[overflow-wrap:anywhere]">
        <span className="text-xs text-[var(--text-soft)]">To </span>
        {email.to.join(", ")}
        {email.cc.length ? <span className="text-[var(--text-soft)]"> · Cc {email.cc.join(", ")}</span> : null}
      </p>
      <p className="font-medium [overflow-wrap:anywhere]">{email.subject}</p>
      <pre className="thin-scroll max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-soft)] px-3 py-2 font-sans text-[13px] [overflow-wrap:anywhere]">{email.body}</pre>
    </div>
  );
}

function EventView({ event }: { event: GoogleEventPreviewDto }) {
  const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="space-y-2.5">
      <p className="font-medium [overflow-wrap:anywhere]">{event.title}</p>
      <dl className="grid gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[4.5rem_minmax(0,1fr)]">
        <dt className="text-xs text-[var(--text-soft)] sm:pt-px">When</dt>
        <dd>
          {eventWhen(event)}
          {!event.allDay && event.timeZone !== deviceZone ? <span className="text-[var(--text-soft)]"> ({event.timeZone})</span> : null}
          {event.calendarTimeZone && !event.allDay ? (
            <span className="block text-xs text-[var(--text-soft)]">
              Your Google Calendar is set to {event.calendarTimeZone}, so it shows this at the same moment in that time zone. To see your local times
              there, change the time zone in Google Calendar's settings.
            </span>
          ) : null}
        </dd>
        {event.reminders?.length ? (
          <>
            <dt className="text-xs text-[var(--text-soft)] sm:pt-px">Reminder{event.reminders.length === 1 ? "" : "s"}</dt>
            <dd>
              {event.reminders.map((r) => (
                <span key={r.minutes} className="block">
                  {eventWhen({ start: r.at, end: r.at, allDay: false }).replace(/–.*$/, "")}{" "}
                  <span className="text-[var(--text-soft)]">({beforeText(r.minutes)})</span>
                </span>
              ))}
            </dd>
          </>
        ) : null}
        {event.location ? (
          <>
            <dt className="text-xs text-[var(--text-soft)] sm:pt-px">Where</dt>
            <dd className="[overflow-wrap:anywhere]">{event.location}</dd>
          </>
        ) : null}
        {event.attendees.length ? (
          <>
            <dt className="text-xs text-[var(--text-soft)] sm:pt-px">Guests</dt>
            <dd className="[overflow-wrap:anywhere]">
              {event.attendees.join(", ")}
              <span className="block text-xs text-[var(--text-soft)]">Google emails each guest an invitation when you approve.</span>
            </dd>
          </>
        ) : null}
        {event.meet ? (
          <>
            <dt className="text-xs text-[var(--text-soft)] sm:pt-px">Video</dt>
            <dd className="inline-flex items-center gap-1.5">
              <Video size={13} className="text-[var(--text-soft)]" /> A Google Meet link is added
            </dd>
          </>
        ) : null}
      </dl>
      {event.description ? (
        <pre className="thin-scroll max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-soft)] px-3 py-2 font-sans text-[13px] [overflow-wrap:anywhere]">{event.description}</pre>
      ) : null}
      {event.clashes.length ? (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle size={13} /> Clashes with {event.clashes.length === 1 ? "an event" : `${event.clashes.length} events`} already in your calendar
          </p>
          <ul className="mt-1 space-y-0.5 pl-5">
            {event.clashes.map((c, i) => (
              <li key={i} className="list-disc [overflow-wrap:anywhere]">
                {c.title} · {eventWhen(c)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
