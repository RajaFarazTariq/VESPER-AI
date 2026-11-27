import { memo, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AgentOverviewDto } from "../../shared/types";
import { api } from "../api/client";
import { notificationPermission, reminderTime, savedDeviceId } from "../lib/push";
import type { AgentCoreState } from "./AgentCore";

/**
 * VESPER Agent's HUD (v0.19.1): the console around the core, made only of real data. Behind everything: a faint hex
 * texture, slowly drifting points joined when close, and range rings with a slow sweep centred on the core. On wide
 * screens (≥ 1024 px): SYSTEM (clock, link, voice, hands-free, Google, alerts, messages left), ACTIVITY (this session's
 * steps) and BRIEF (next events, reminders, to-dos from `GET /api/agent/overview`). Above the message box: a waveform of
 * the microphone or VESPER's voice. Everything that moves is its own small component (the clock ticks alone, the
 * canvases draw outside React), so Agent mode itself doesn't re-render for any of it. With reduced motion nothing moves.
 * Downloaded with Agent mode (imported only by AgentMode.tsx).
 */

// ------------------------------------------------------------------ Small hooks

/** Whether a media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** The browser's own idea of whether it is online. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

// ------------------------------------------------------------------ The overview (BRIEF and parts of SYSTEM)

export interface OverviewState {
  data: AgentOverviewDto | null;
  /** The first load is under way (later refreshes keep showing the last data). */
  loading: boolean;
  /** When the data shown was loaded. */
  at: number | null;
}

const REFRESH_MS = 5 * 60_000;
const AFTER_TURN_MS = 1500;

/**
 * `GET /api/agent/overview`: on open, a moment after each finished turn (a reminder set, an item added), and every
 * five minutes while the page is visible. A failed refresh keeps the last data; a failed first load shows nothing.
 */
export function useAgentOverview(enabled: boolean, turns: number): OverviewState {
  const [state, setState] = useState<OverviewState>(() => ({ data: null, loading: enabled, at: null }));
  const controller = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    setState((s) => (s.data || s.loading ? s : { ...s, loading: true }));
    api.agentOverview(c.signal).then(
      (data) => {
        if (!c.signal.aborted) setState({ data, loading: false, at: Date.now() });
      },
      () => {
        if (!c.signal.aborted) setState((s) => (s.loading ? { ...s, loading: false } : s));
      },
    );
  }, []);

  useEffect(() => {
    if (!enabled) return;
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    return () => {
      clearInterval(timer);
      controller.current?.abort();
    };
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || turns === 0) return;
    const timer = setTimeout(load, AFTER_TURN_MS);
    return () => clearTimeout(timer);
  }, [enabled, turns, load]);

  return state;
}

// ------------------------------------------------------------------ Time formatting

const CLOCK = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
const SHORT_TIME = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const DATE = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** "04:33" */
export const shortTime = (t: number) => SHORT_TIME.format(t);

/** "Fri 27 Nov 2026" (built from parts: some browsers put commas in). */
function dateText(t: number): string {
  const parts = DATE.formatToParts(t);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;
}

/** "UTC+5", "UTC-3:30", "UTC" for this device at `t`. */
function utcOffset(t: number): string {
  const minutes = -new Date(t).getTimezoneOffset();
  if (minutes === 0) return "UTC";
  const abs = Math.abs(minutes);
  const rest = abs % 60;
  return `UTC${minutes > 0 ? "+" : "-"}${Math.floor(abs / 60)}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

/** The browser's time zone, readable ("Asia/Karachi", "America/New York"). */
function zoneName(): string {
  try {
    return (Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time").replace(/_/g, " ");
  } catch {
    return "Local time";
  }
}

// ------------------------------------------------------------------ SYSTEM

/** The clock ticks on its own (once a second, on the second), so nothing else redraws for it. Not a live region. */
const HudClock = memo(function HudClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      timer = setTimeout(tick, 1000 - (t % 1000) + 8);
    };
    timer = setTimeout(tick, 1000 - (Date.now() % 1000) + 8);
    return () => clearTimeout(timer);
  }, []);
  const [hours, minutes, seconds] = CLOCK.format(now).split(":");
  return (
    <div className="hud-clock">
      <time className="hud-clock__time" dateTime={new Date(now).toISOString()}>
        {hours}:{minutes}
        <span className="hud-clock__sec">:{seconds}</span>
      </time>
      <p className="hud-clock__date">{dateText(now)}</p>
    </div>
  );
});

type Tone = "ok" | "warn" | "off" | "wait";

function StatusRow({ label, value, tone, title }: { label: string; value: string; tone: Tone; title?: string }) {
  return (
    <div className="hud-row">
      <dt>{label}</dt>
      <dd title={title ?? value}>
        <span className={`hud-dot hud-dot--${tone}`} aria-hidden="true" />
        <span className="truncate">{value}</span>
      </dd>
    </div>
  );
}

export interface SystemPanelProps {
  online: boolean;
  /** "Luna · studio", a device voice's name, "Off". */
  voice: string;
  voiceOn: boolean;
  handsFree: "on" | "off" | "unavailable";
  /** Google may be connected at all (features), and what the overview says (null: not loaded yet). */
  googleAvailable: boolean;
  google: AgentOverviewDto["google"] | null;
  /** The user has a device with notifications (null: not loaded yet). */
  notifications: boolean | null;
  /** Messages left today (null: unlimited; undefined: not loaded). */
  messagesLeft: number | null | undefined;
}

export const SystemPanel = memo(function SystemPanel({ online, voice, voiceOn, handsFree, googleAvailable, google, notifications, messagesLeft }: SystemPanelProps) {
  const now = Date.now();
  const googleRow: [string, Tone] = !googleAvailable
    ? ["Unavailable", "off"]
    : google === null
      ? ["Checking…", "wait"]
      : google === "connected"
        ? ["Connected", "ok"]
        : google === "reconnect"
          ? ["Reconnect", "warn"]
          : ["Not connected", "off"];
  // Notifications on this browser: switched on here (its saved device), the user has a device, and still allowed.
  const here = notifications === true && savedDeviceId() !== null && notificationPermission() === "granted";
  const alertsRow: [string, Tone] =
    notifications === null ? ["Checking…", "wait"] : here ? ["On", "ok"] : notifications ? ["Other device", "off"] : ["Off", "off"];
  return (
    <section className="agent-panel hud-panel" aria-label="System">
      <header className="hud-head">
        <span className="hud-head__label">System</span>
        <span className="hud-head__meta">{utcOffset(now)}</span>
      </header>
      <HudClock />
      <p className="hud-zone" title="Time zone">
        {zoneName()}
      </p>
      <dl className="hud-rows">
        <StatusRow label="Link" value={online ? "Online" : "Offline"} tone={online ? "ok" : "warn"} />
        <StatusRow label="Voice" value={voice} tone={voiceOn ? "ok" : "off"} />
        <StatusRow
          label="Hands-free"
          value={handsFree === "on" ? "On" : handsFree === "off" ? "Off" : "Unavailable"}
          tone={handsFree === "on" ? "ok" : "off"}
        />
        <StatusRow label="Google" value={googleRow[0]} tone={googleRow[1]} />
        <StatusRow
          label="Alerts"
          value={alertsRow[0]}
          tone={alertsRow[1]}
          title={alertsRow[0] === "Other device" ? "Notifications are on for another device, not this browser" : undefined}
        />
        {typeof messagesLeft === "number" ? (
          <StatusRow label="Messages today" value={`${messagesLeft} left`} tone={messagesLeft === 0 ? "warn" : messagesLeft <= 5 ? "warn" : "ok"} />
        ) : null}
      </dl>
    </section>
  );
});

// ------------------------------------------------------------------ ACTIVITY

export interface ActivityEntry {
  id: number;
  at: number;
  text: string;
}

/** The most lines the log keeps (newest first; older ones fade). */
export const ACTIVITY_MAX = 6;

/** This session's steps, newest first. Not a live region: the reply itself is announced. */
export const ActivityLog = memo(function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  return (
    <section className="agent-panel hud-panel hud-panel--log" aria-label="Activity">
      <header className="hud-head">
        <span className="hud-head__label">Activity</span>
        <span className="hud-head__meta">This session</span>
      </header>
      {entries.length ? (
        <ol className="hud-log">
          {entries.map((e) => (
            <li key={e.id}>
              <time className="hud-log__time" dateTime={new Date(e.at).toISOString()}>
                {shortTime(e.at)}
              </time>
              <span className="hud-log__text">{e.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="hud-empty">Starting…</p>
      )}
    </section>
  );
});

// ------------------------------------------------------------------ BRIEF

function Skeleton() {
  return (
    <div className="hud-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="hud-skeleton__group">
          <span className="hud-skeleton__bar hud-skeleton__bar--label" />
          <span className="hud-skeleton__bar" />
          <span className="hud-skeleton__bar hud-skeleton__bar--short" />
        </div>
      ))}
    </div>
  );
}

function BriefSection({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <div className="hud-brief">
      <h3 className="hud-brief__head">
        <span>{title}</span>
        {meta ? <span className="hud-brief__meta">{meta}</span> : null}
      </h3>
      {children}
    </div>
  );
}

/** "Today, 17:00" → "Today 17:00" (the column is narrow). */
const compactWhen = (text: string) => text.replace(", ", " ");

export const BriefPanel = memo(function BriefPanel({ overview, googleAvailable }: { overview: OverviewState; googleAvailable: boolean }) {
  const { data, at } = overview;
  return (
    <section className="agent-panel hud-panel hud-panel--brief" aria-label="Brief" aria-busy={!data}>
      <header className="hud-head">
        <span className="hud-head__label">Brief</span>
        <span className="hud-head__meta">{at ? `Updated ${shortTime(at)}` : "Loading"}</span>
      </header>
      {!data ? (
        <Skeleton />
      ) : (
        <>
          {googleAvailable || data.google !== "off" ? (
            <BriefSection title="Next" meta={data.google === "connected" && data.events.length ? String(data.events.length) : undefined}>
              {data.google === "connected" ? (
                data.events.length ? (
                  <ul className="hud-timeline">
                    {data.events.map((e, i) => (
                      <li key={`${e.when}|${e.title}|${i}`}>
                        <span className="hud-timeline__when">{e.when}</span>
                        <span className="hud-timeline__text" title={e.title}>
                          {e.title || "(No title)"}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hud-empty">No upcoming events</p>
                )
              ) : (
                <p className="hud-empty">
                  {data.google === "reconnect" ? "Reconnect Google in Settings to see your calendar." : "Connect Google in Settings to see your calendar."}
                </p>
              )}
            </BriefSection>
          ) : null}

          <BriefSection title="Reminders" meta={data.reminders.length ? String(data.reminders.length) : undefined}>
            {data.reminders.length ? (
              <ul className="hud-timeline">
                {data.reminders.map((r, i) => (
                  <li key={`${r.dueAt}|${i}`}>
                    <span className="hud-timeline__when">{compactWhen(reminderTime(r.dueAt, data.timeZone))}</span>
                    <span className="hud-timeline__text" title={r.text}>
                      {r.text}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hud-empty">No reminders set</p>
            )}
          </BriefSection>

          <BriefSection title="To-do" meta={data.todos.open ? `${data.todos.open} open` : undefined}>
            {data.todos.open ? (
              data.todos.first.length ? (
                <ul className="hud-todos">
                  {data.todos.first.map((text, i) => (
                    <li key={`${i}|${text}`} title={text}>
                      <span className="hud-todos__box" aria-hidden="true" />
                      <span className="truncate">{text}</span>
                    </li>
                  ))}
                  {data.todos.open > data.todos.first.length ? (
                    <li className="hud-todos__more">+{data.todos.open - data.todos.first.length} more</li>
                  ) : null}
                </ul>
              ) : (
                <p className="hud-empty">{data.todos.open} open</p>
              )
            ) : (
              <p className="hud-empty">Nothing open</p>
            )}
          </BriefSection>
        </>
      )}
    </section>
  );
});

// ------------------------------------------------------------------ Background: hex texture, drifting points, vignette

const FRAME_MS = 1000 / 30;
const MAX_POINTS = 60;
const LINK = 132;

interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

/**
 * A few dozen points drifting slowly, joined by thin lines when close (≈ 30 fps, at most 60 points). Paused while the
 * tab is hidden, stopped when Agent mode closes; drawn once and left still with reduced motion.
 */
const NeuralField = memo(function NeuralField({ calm }: { calm: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let width = 0;
    let height = 0;
    let points: Point[] = [];
    let frame = 0;
    let last = 0;
    // Colours from styles.css (the HUD tokens on .agent-mode); the strength comes from globalAlpha.
    const css = getComputedStyle(canvas);
    const lineColour = css.getPropertyValue("--hud-line").trim() || "#38bdf8";
    const pointColour = css.getPropertyValue("--hud-point").trim() || "#67e8f9";
    const hubColour = css.getPropertyValue("--hud-hub").trim() || "#a5f3fc";

    const spawn = (): Point => {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.08 + Math.random() * 0.16; // px per frame: 2–7 px a second
      return { x: Math.random() * width, y: Math.random() * height, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, r: Math.random() < 0.12 ? 1.7 : 0.7 + Math.random() * 0.6 };
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = lineColour;
      for (let i = 0; i < points.length; i++) {
        const a = points[i]!;
        for (let j = i + 1; j < points.length; j++) {
          const b = points[j]!;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK * LINK) continue;
          const k = 1 - Math.sqrt(d2) / LINK;
          ctx.globalAlpha = k * k * 0.55;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
      for (const p of points) {
        const hub = p.r > 1.5;
        ctx.globalAlpha = hub ? 0.9 : 0.75;
        ctx.fillStyle = hub ? hubColour : pointColour;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const step = () => {
      for (const p of points) {
        p.x += p.vx;
        p.y += p.vy;
        // Off one edge, back in at the other (a margin, so lines don't pop).
        if (p.x < -20) p.x = width + 20;
        else if (p.x > width + 20) p.x = -20;
        if (p.y < -20) p.y = height + 20;
        else if (p.y > height + 20) p.y = -20;
      }
    };

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const sx = width ? w / width : 1;
      const sy = height ? h / height : 1;
      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const p of points) {
        p.x *= sx;
        p.y *= sy;
      }
      const count = Math.max(14, Math.min(MAX_POINTS, Math.round((w * h) / 26_000)));
      if (points.length > count) points = points.slice(0, count);
      while (points.length < count) points.push(spawn());
      draw();
    };

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      last = now;
      step();
      draw();
    };
    const start = () => {
      if (!calm && !frame && document.visibilityState === "visible") frame = requestAnimationFrame(loop);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [calm]);
  return <canvas ref={ref} className="hud-neural" />;
});

/** The still layers behind everything (texture, points, vignette, screen corners). */
export const HudTexture = memo(function HudTexture({ calm }: { calm: boolean }) {
  return (
    <>
      <div className="hud-hex" />
      <NeuralField calm={calm} />
      <div className="hud-vignette" />
      <span className="hud-corner hud-corner--tl" />
      <span className="hud-corner hud-corner--tr" />
      <span className="hud-corner hud-corner--bl" />
      <span className="hud-corner hud-corner--br" />
    </>
  );
});

// ------------------------------------------------------------------ Range rings and sweep behind the core

/** Where `el` is inside `root` (layout positions, so the view's grow-in scale doesn't throw it off), scrolling included. */
function offsetWithin(el: HTMLElement, root: Element | null): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    x += node.offsetLeft;
    y += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (parent && parent !== root) {
      x -= parent.scrollLeft;
      y -= parent.scrollTop;
    }
    node = parent;
  }
  return { x, y };
}

const ticks = (r: number, count: number, len: number, every = 1) =>
  Array.from({ length: count }, (_, i) => i)
    .filter((i) => i % every === 0)
    .map((i) => {
      const a = (i / count) * Math.PI * 2;
      const [c, s] = [Math.cos(a), Math.sin(a)];
      return `M${(c * r).toFixed(2)} ${(s * r).toFixed(2)}L${(c * (r - len)).toFixed(2)} ${(s * (r - len)).toFixed(2)}`;
    })
    .join("");
const arcPath = (r: number, from: number, to: number) => {
  const p = (deg: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  };
  return `M${p(from)}A${r} ${r} 0 0 1 ${p(to)}`;
};
const MINOR_TICKS = ticks(96, 72, 1.6);
const MAJOR_TICKS = ticks(96, 72, 3.6, 6);
const BRACKETS = [45, 135, 225, 315].map((deg) => arcPath(78, deg - 14, deg + 14)).join("");
const CROSS = [0, 90, 180, 270]
  .map((deg) => {
    const a = (deg * Math.PI) / 180;
    return `M${(Math.cos(a) * 82).toFixed(2)} ${(Math.sin(a) * 82).toFixed(2)}L${(Math.cos(a) * 91).toFixed(2)} ${(Math.sin(a) * 91).toFixed(2)}`;
  })
  .join("");

/**
 * Range rings and a slow sweep, kept centred on the core as the text around it changes (measured on resize and
 * scroll, written straight to the element: no re-render).
 */
export const HudRadar = memo(function HudRadar({
  target,
  content,
  scroller,
  size,
  state,
}: {
  target: RefObject<HTMLElement | null>;
  content: RefObject<HTMLElement | null>;
  scroller: RefObject<HTMLElement | null>;
  size: number;
  state: AgentCoreState;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // After the whole view is in place (the core comes later in the tree, so its ref isn't set during this component's
  // layout effects); hidden until then.
  useEffect(() => {
    const el = ref.current;
    const core = target.current;
    const layer = el?.offsetParent ?? null;
    if (!el || !core || !layer) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const root = (layer as HTMLElement).offsetParent;
      const at = offsetWithin(core, root);
      const base = offsetWithin(layer as HTMLElement, root);
      const x = at.x - base.x + core.offsetWidth / 2;
      const y = at.y - base.y + core.offsetHeight / 2;
      el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0) translate(-50%, -50%)`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    // Moves glide from now on (not the first placement).
    const settle = requestAnimationFrame(() => {
      el.dataset.placed = "";
    });
    const observer = new ResizeObserver(schedule);
    for (const node of [core, content.current, layer]) if (node) observer.observe(node);
    const scrolling = scroller.current;
    scrolling?.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(settle);
      cancelAnimationFrame(frame);
      observer.disconnect();
      scrolling?.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [target, content, scroller, size]);

  const box = Math.round(size * 2.1);
  return (
    <div ref={ref} className={`hud-radar hud-radar--${state}`} style={{ width: box, height: box }}>
      <div className="hud-radar__sweep" />
      <svg className="hud-radar__svg" viewBox="-100 -100 200 200" focusable="false">
        <circle r={60} className="hud-radar__ring hud-radar__ring--dash" />
        <circle r={78} className="hud-radar__ring" />
        <circle r={96} className="hud-radar__ring hud-radar__ring--outer" />
        <path d={MINOR_TICKS} className="hud-radar__tick" />
        <path d={MAJOR_TICKS} className="hud-radar__tick hud-radar__tick--major" />
        <path d={BRACKETS} className="hud-radar__bracket" />
        <path d={CROSS} className="hud-radar__tick hud-radar__tick--major" />
      </svg>
    </div>
  );
});

// ------------------------------------------------------------------ Waveform above the message box

export type WaveMode = "idle" | "listening" | "thinking" | "speaking";

interface LevelSource {
  get: () => number;
  subscribe: (listener: () => void) => () => void;
}

const BARS = 48;
const HALF = BARS / 2;
/** A fixed, uneven shape (so the bars move like a voice, not all together). */
const SHAPE = Array.from({ length: BARS }, (_, i) => 0.55 + 0.45 * Math.abs(Math.sin(i * 12.9898 + 4.1414)));

/**
 * ~48 bars: the microphone's level while listening, VESPER's voice while speaking (the studio voice's real loudness;
 * the device voice reports none, so a soft pulse shows it is talking), a moving packet while thinking, a faint
 * shimmer otherwise. Drawn on a canvas at ≈ 30 fps from the level store, outside React. Reduced motion: no shimmer,
 * the bars only follow the level.
 */
export const Waveform = memo(function Waveform({ levels, mode, calm }: { levels: LevelSource; mode: WaveMode; calm: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const redrawRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let width = 0;
    let height = 0;
    const history = new Float32Array(HALF);
    const shown = new Float32Array(BARS);
    let heardAt = 0;
    let frame = 0;
    let last = 0;
    // Colours from styles.css (HUD tokens); the strength comes from globalAlpha.
    const css = getComputedStyle(canvas);
    const waveColour = css.getPropertyValue("--hud-wave").trim() || "#22d3ee";
    const liveColour = css.getPropertyValue("--hud-wave-live").trim() || "#5eeaff";

    const resize = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (!w || !h) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      width = w;
      height = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render(performance.now(), true);
    };

    /** The target height (0..1) of bar `i` at time `t` (seconds). */
    const target = (i: number, t: number, m: WaveMode, live: boolean): number => {
      const d = Math.abs(i - (HALF - 0.5)) - 0.5; // 0 at the centre … 23 at the ends
      const edge = 1 - (d / HALF) ** 2 * 0.55;
      if (live) return Math.min(1, history[Math.round(d)]! * 1.6 * SHAPE[i]! * edge);
      if (calm) return 0;
      if (m === "speaking") return (0.18 + 0.22 * Math.abs(Math.sin(t * 5.2 + i * 0.9) * Math.sin(t * 2.1 + i * 0.37))) * edge;
      if (m === "thinking") {
        const at = (((t * 0.9) % 1.6) - 0.3) * BARS;
        return 0.05 + 0.45 * Math.exp(-(((i - at) / 3.2) ** 2)) * edge;
      }
      return (0.08 + 0.1 * (0.5 + 0.5 * Math.sin(t * 1.6 - d * 0.42))) * edge;
    };

    const render = (now: number, still = false) => {
      if (!width) return;
      const m = modeRef.current;
      const level = m === "listening" || m === "speaking" ? levels.get() : 0;
      if (level > 0.02) heardAt = now;
      const live = (m === "listening" || (m === "speaking" && now - heardAt < 700)) && !still;
      if (!still) {
        history.copyWithin(1, 0);
        history[0] = level;
      }
      const t = now / 1000;
      ctx.clearRect(0, 0, width, height);
      const step = width / BARS;
      const bar = Math.max(1.5, Math.min(3, step * 0.45));
      const mid = height / 2;
      ctx.fillStyle = m === "listening" ? liveColour : waveColour;
      for (let i = 0; i < BARS; i++) {
        const goal = calm && !live ? (m === "listening" || m === "speaking" ? level * SHAPE[i]! : 0) : target(i, t, m, live);
        shown[i] = calm ? goal : shown[i]! + (goal - shown[i]!) * 0.35;
        const h = Math.max(2, shown[i]! * height);
        ctx.globalAlpha = 0.22 + Math.min(0.78, shown[i]! * 1.4);
        const x = i * step + (step - bar) / 2;
        ctx.fillRect(x, mid - h / 2, bar, h);
      }
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      last = now;
      render(now);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    if (calm) {
      // Still: redrawn only when the level changes (or the mode, see below).
      const redraw = () => render(performance.now(), true);
      redrawRef.current = redraw;
      const unsubscribe = levels.subscribe(redraw);
      redraw();
      return () => {
        redrawRef.current = null;
        unsubscribe();
        observer.disconnect();
      };
    }
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [levels, calm]);

  // Reduced motion: a mode change redraws once (no loop is running).
  useEffect(() => {
    redrawRef.current?.();
  }, [mode]);

  return <canvas ref={ref} className={`hud-wave hud-wave--${mode}`} aria-hidden="true" />;
});
