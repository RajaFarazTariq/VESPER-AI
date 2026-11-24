import { useEffect, useId, useRef, type CSSProperties, type ReactNode, type Ref, type RefObject, type SVGProps } from "react";

/**
 * VESPER Agent's animated core and the floating launcher orb that opens Agent mode (v0.17.0).
 *
 * The core is a stack of full-size SVG layers on a 320 × 320 drawing (1 unit = 1 px at the default size): a still
 * outer scale with the "VESPER" and status labels, four rings turning at different speeds and directions, a scanning
 * arc (thinking), a voice ring that follows the microphone level (listening), ripples (speaking) and the glowing core.
 * Each turning ring is its own <svg>, so the browser turns it as a whole (cheap) instead of redrawing it every frame.
 * All colours, glow and motion live in styles.css ("Agent mode" block): the state only changes a class, and the
 * colours are registered custom properties, so one state blends into the next. Ring speeds change smoothly through
 * the animations' playback rate (see useSpinRate). With reduced motion nothing moves; the state shows by colour.
 */

export type AgentCoreState = "booting" | "idle" | "listening" | "thinking" | "speaking" | "error";

/** The small status word printed along the bottom of the scale. */
const STATE_LABEL: Record<AgentCoreState, string> = {
  booting: "INITIALIZING",
  idle: "ONLINE",
  listening: "LISTENING",
  thinking: "PROCESSING",
  speaking: "SPEAKING",
  error: "ERROR",
};

/** How fast the rings turn in each state, relative to their resting speed (booting spins down into idle). */
const SPIN_RATE: Record<AgentCoreState, number> = {
  booting: 1.8,
  idle: 1,
  listening: 1.4,
  thinking: 3.6,
  speaking: 1.7,
  error: 0.35,
};

// ---------- Geometry (computed once) ----------

const C = 160; // centre of the drawing
const VIEW = "0 0 320 320";
const LABEL_R = 136; // radius the two labels run along
const LABEL_FONT = 9; // keep in step with .ag-label in styles.css (font-size and letter-spacing 0.3em)

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A point `r` from the centre, `deg` degrees clockwise from 12 o'clock, as "x y". */
function point(r: number, deg: number): string {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${round(C + r * Math.cos(a))} ${round(C + r * Math.sin(a))}`;
}

/** An arc from `from`° to `to`°, clockwise. */
function arc(r: number, from: number, to: number): string {
  return `M${point(r, from)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${point(r, to)}`;
}

/** A short radial line at `deg`° from radius r1 to r2. */
function spoke(r1: number, r2: number, deg: number): string {
  return `M${point(r1, deg)}L${point(r2, deg)}`;
}

/** A stroke-dasharray that splits a circle of radius `r` into `count` equal marks, each `mark` units long. */
function marks(r: number, count: number, mark: number): string {
  const step = (2 * Math.PI * r) / count;
  return `${round(mark)} ${round(step - mark)}`;
}

/** A repeating dash pattern (relative lengths in `parts`), scaled so `reps` copies fill the circle exactly. */
function pattern(r: number, reps: number, parts: number[]): string {
  const scale = (2 * Math.PI * r) / reps / parts.reduce((a, b) => a + b, 0);
  return parts.map((p) => round(p * scale)).join(" ");
}

/** Half the angle a label of `text` covers along the label circle (monospace, letter-spacing 0.3em), in degrees. */
function labelHalfAngle(text: string): number {
  return ((text.length * LABEL_FONT * 0.9) / 2 / LABEL_R) * (180 / Math.PI);
}

// The labels' baselines: the top one runs left → right over the top, the bottom one left → right under the bottom.
const TOP_PATH = `M${C - LABEL_R} ${C}A${LABEL_R} ${LABEL_R} 0 0 1 ${C + LABEL_R} ${C}`;
const BOTTOM_PATH = `M${C - LABEL_R} ${C}A${LABEL_R} ${LABEL_R} 0 0 0 ${C + LABEL_R} ${C}`;
// Letter-spacing also follows the last letter, which would push a centred label off-centre by half of it.
const LABEL_OFFSET = `${round(50 + ((LABEL_FONT * 0.3) / 2 / (Math.PI * LABEL_R)) * 100)}%`;

const TOP_HALF = labelHalfAngle("VESPER");
const TOP_FLANKS = [arc(LABEL_R, -TOP_HALF - 30, -TOP_HALF - 6), arc(LABEL_R, TOP_HALF + 6, TOP_HALF + 30)];
const TOP_FLANK_DOTS = [-TOP_HALF - 34, TOP_HALF + 34];

// Ring 1 (outer HUD arcs): uneven arcs with end caps, two hatched blocks and a few dots in the gaps.
const R1 = 124;
const R1_ARCS: [number, number][] = [
  [6, 64],
  [76, 96],
  [124, 198],
  [210, 222],
  [246, 334],
];
const R1_CAPS = R1_ARCS.flatMap(([a, b]) => [spoke(R1 - 4, R1 + 4, a), spoke(R1 - 4, R1 + 4, b)]);
const R1_DOTS = [70, 204, 340];
const R1_HATCH = [arc(R1, 102, 118), arc(R1, 227, 241)];

// Ring 2: a segmented band (groups of four blocks) with two bright arcs on its inner edge.
const R2 = 108;
const R2_BAND = pattern(R2, 12, [5, 2.6, 5, 2.6, 5, 2.6, 5, 9]);
const R2_BRIGHT: [number, number][] = [
  [18, 74],
  [198, 254],
];

// Thinking: a comet-like arc that sweeps round fast (segments fading in towards the head).
const SCAN_R = 95;
const SCAN_SEGMENTS = Array.from({ length: 16 }, (_, i) => ({
  d: arc(SCAN_R, i * 5.5, i * 5.5 + 5.6),
  opacity: round(((i + 1) / 16) ** 1.6),
}));
const SCAN_HEAD = point(SCAN_R, 16 * 5.5).split(" ").map(Number);

// Ring 3: a thin circle with fine inner ticks and a bright arc.
const R3 = 86;

// Voice ring (listening): short radial bars that grow with the microphone level, each by its own amount.
const VOICE_IN = 63;
const VOICE_LEN = 6;
const VOICE_BARS = Array.from({ length: 60 }, (_, i) => ({
  deg: i * 6,
  // An irregular but fixed pattern (digits of pi), so the bars move like a voice rather than all together.
  k: (Number("314159265358979323846264338327950288419716939937510582097494"[i]) % 5) + 1,
}));

// The core's still details.
const SHELL_R = 56;
const SHELL = pattern(SHELL_R, 4, [80, 10]);
const IRIS_SPOKES = Array.from({ length: 24 }, (_, i) => spoke(21, i % 2 ? 29 : 33, i * 15));
const IRIS_ARCS = [arc(41, 0, 46), arc(41, 120, 166), arc(41, 240, 286)];

// ---------- Components ----------

/** A circle around the centre. */
function Ring({ r, className, ...rest }: { r: number; className: string } & SVGProps<SVGCircleElement>) {
  return <circle cx={C} cy={C} r={r} className={className} {...rest} />;
}

/** One full-size layer of the core. `spin` turns it (its own animation speed and direction come from the class). */
function Layer({ name, spin, children }: { name: string; spin?: string; children: ReactNode }) {
  return (
    <div className={`ag-layer ag-layer--${name}`}>
      <svg className={`ag-svg${spin ? ` ag-spin ag-spin--${spin}` : ""}`} viewBox={VIEW} focusable="false">
        {children}
      </svg>
    </div>
  );
}

/**
 * Ease the rings' speed towards the state's rate. Changing animation-duration would make the rings jump to a new
 * angle; changing the playback rate keeps each ring where it is and only changes how fast it turns.
 */
function useSpinRate(root: RefObject<HTMLDivElement | null>, state: AgentCoreState) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof el.getAnimations !== "function") return;
    const spins = el
      .getAnimations({ subtree: true })
      .filter((a) => a instanceof CSSAnimation && a.animationName.startsWith("ag-spin"));
    const first = spins[0];
    if (!first) return; // reduced motion: nothing turns
    const from = first.playbackRate;
    const to = SPIN_RATE[state];
    if (from === to) return;
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      const rate = from + (to - from) * (1 - (1 - t) ** 3);
      for (const a of spins) a.playbackRate = rate;
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [root, state]);
}

/** The animated core. `level`: loudness 0..1 of the microphone while listening, or of the studio voice while speaking (v0.17.1); ignored otherwise. */
export function AgentCore({
  state,
  level = 0,
  size = 320,
  className = "",
}: {
  state: AgentCoreState;
  level?: number;
  size?: number;
  className?: string;
}) {
  const id = `ag${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const root = useRef<HTMLDivElement>(null);
  useSpinRate(root, state);

  const loudness = (state === "listening" || state === "speaking") && Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const style = { width: size, height: size, "--ag-level": round(loudness) } as CSSProperties;
  const label = STATE_LABEL[state];
  const half = labelHalfAngle(label);
  const glow = `url(#${id}-glow)`;

  return (
    <div ref={root} className={`agent-core agent-core--${state} ${className}`} style={style} aria-hidden="true">
      <div className="ag-layer ag-bloom" />

      {/* Still frame: the outer scale, index marks and the two labels. */}
      <div className="ag-layer ag-layer--frame">
        <svg className="ag-svg" viewBox={VIEW} focusable="false">
          <defs>
            <path id={`${id}-top`} d={TOP_PATH} />
            <path id={`${id}-bottom`} d={BOTTOM_PATH} />
          </defs>
          <Ring r={152} className="ag-line ag-scale" strokeWidth={0.8} transform={`rotate(-90 ${C} ${C})`} />
          <Ring r={149.5} className="ag-line ag-ticks" strokeWidth={5} strokeDasharray={marks(149.5, 120, 0.7)} strokeDashoffset={0.35} />
          <Ring r={148} className="ag-line ag-ticks ag-ticks--major" strokeWidth={8} strokeDasharray={marks(148, 24, 1.2)} strokeDashoffset={0.6} />
          <Ring r={140} className="ag-line ag-faint" strokeWidth={0.5} strokeDasharray={marks(140, 180, 0.5)} />
          <path className="ag-fill ag-index" d={`M${C} 11.5l-3.6-6h7.2z`} />
          <path className="ag-fill ag-index ag-index--soft" d={`M${C} 308.5l-3.6 6h7.2z`} />
          <path className="ag-fill ag-index ag-index--soft" d={`M11.5 ${C}l-6-3.6v7.2z`} />
          <path className="ag-fill ag-index ag-index--soft" d={`M308.5 ${C}l6-3.6v7.2z`} />
          <g className="ag-label-group">
            {TOP_FLANKS.map((d) => (
              <path key={d} className="ag-line ag-flank" d={d} strokeWidth={0.9} />
            ))}
            {TOP_FLANK_DOTS.map((deg) => {
              const [x, y] = point(LABEL_R, deg).split(" ");
              return <circle key={deg} className="ag-fill ag-flank-dot" cx={x} cy={y} r={1.3} />;
            })}
            <path className="ag-line ag-flank" d={arc(LABEL_R, 180 - half - 26, 180 - half - 6)} strokeWidth={0.9} />
            <path className="ag-line ag-flank" d={arc(LABEL_R, 180 + half + 6, 180 + half + 26)} strokeWidth={0.9} />
            <text className="ag-label">
              <textPath href={`#${id}-top`} startOffset={LABEL_OFFSET}>
                VESPER
              </textPath>
            </text>
            <text key={state} className="ag-label ag-label--state">
              <textPath href={`#${id}-bottom`} startOffset={LABEL_OFFSET}>
                {label}
              </textPath>
            </text>
          </g>
        </svg>
      </div>

      {/* Ring 1: outer HUD arcs, slow, clockwise. */}
      <Layer name="r1" spin="r1">
        <Ring r={R1 - 7} className="ag-line ag-faint" strokeWidth={0.6} />
        {R1_ARCS.map(([a, b]) => (
          <path key={a} className="ag-line ag-r1-arc" d={arc(R1, a, b)} strokeWidth={1.4} />
        ))}
        <path className="ag-line ag-r1-caps" d={R1_CAPS.join("")} strokeWidth={1} />
        {R1_HATCH.map((d) => (
          <path key={d} className="ag-line ag-r1-hatch" d={d} strokeWidth={5} strokeDasharray="0.7 2.1" />
        ))}
        {R1_DOTS.map((deg) => {
          const [x, y] = point(R1, deg).split(" ");
          return <circle key={deg} className="ag-fill ag-r1-dot" cx={x} cy={y} r={1.5} />;
        })}
      </Layer>

      {/* Ring 2: segmented band, counter-clockwise, with two glowing arcs. */}
      <Layer name="r2" spin="r2">
        <defs>
          <filter id={`${id}-glow`} filterUnits="userSpaceOnUse" x="0" y="0" width="320" height="320">
            <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <Ring r={R2} className="ag-band" strokeWidth={3.6} strokeDasharray={R2_BAND} />
        <Ring r={R2 + 5.5} className="ag-line ag-faint" strokeWidth={0.5} />
        {R2_BRIGHT.map(([a, b]) => (
          <path key={a} className="ag-line ag-bright" d={arc(R2 - 7, a, b)} strokeWidth={1.8} strokeLinecap="round" filter={glow} />
        ))}
      </Layer>

      {/* Thinking: the scanning arc (hidden in other states). */}
      <div className="ag-layer ag-layer--scan">
        <svg className="ag-svg ag-scan" viewBox={VIEW} focusable="false">
          <defs>
            <filter id={`${id}-scan-glow`} filterUnits="userSpaceOnUse" x="0" y="0" width="320" height="320">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g filter={`url(#${id}-scan-glow)`}>
            {SCAN_SEGMENTS.map((s) => (
              <path key={s.d} className="ag-hot" d={s.d} strokeWidth={2} strokeOpacity={s.opacity} />
            ))}
            <circle className="ag-hot-fill" cx={SCAN_HEAD[0]} cy={SCAN_HEAD[1]} r={2.2} />
          </g>
        </svg>
      </div>

      {/* Ring 3: thin circle, fine ticks, one bright arc; clockwise. */}
      <Layer name="r3" spin="r3">
        <Ring r={R3} className="ag-line ag-r3" strokeWidth={0.9} />
        <Ring r={R3 - 5} className="ag-line ag-ticks" strokeWidth={4} strokeDasharray={marks(R3 - 5, 90, 0.6)} />
        <path className="ag-line ag-bright" d={arc(R3, 292, 404)} strokeWidth={2} strokeLinecap="round" filter={glow} />
        <path className="ag-accent ag-r3-arc" d={arc(R3, 150, 178)} strokeWidth={2} />
        <path className="ag-fill" d={`M${point(R3 + 3, 0)}l-2.6 -4.6h5.2z`} transform={`rotate(110 ${C} ${C})`} />
      </Layer>

      {/* Voice ring: grows with the microphone level while listening; counter-clockwise. */}
      <div className="ag-layer ag-layer--voice">
        <div className="ag-voice">
          <svg className="ag-svg ag-spin ag-spin--r4" viewBox={VIEW} focusable="false">
            {VOICE_BARS.map((b) => (
              <g key={b.deg} transform={`rotate(${b.deg} ${C} ${C})`}>
                <rect className={`ag-bar ag-bar--${b.k}`} x={C - 0.7} y={C - VOICE_IN - VOICE_LEN} width={1.4} height={VOICE_LEN} rx={0.7} />
              </g>
            ))}
          </svg>
        </div>
      </div>

      {/* Speaking: rings of light leaving the core. */}
      <div className="ag-layer ag-layer--ripples">
        <span className="ag-ripple" />
        <span className="ag-ripple ag-ripple--late" />
      </div>

      {/* The core itself: shell, glowing sphere, a slowly turning iris and the bright nucleus. */}
      <div className="ag-layer ag-layer--heart">
        <div className="ag-heart">
          <svg className="ag-svg" viewBox={VIEW} focusable="false">
            <defs>
              <radialGradient id={`${id}-sphere`} cx={C} cy={C} r={SHELL_R - 2} gradientUnits="userSpaceOnUse">
                <stop offset="0" className="ag-stop-white" />
                <stop offset="0.16" className="ag-stop-hot" />
                <stop offset="0.42" className="ag-stop-line" stopOpacity={0.78} />
                <stop offset="0.74" className="ag-stop-accent" stopOpacity={0.28} />
                <stop offset="1" className="ag-stop-accent" stopOpacity={0} />
              </radialGradient>
              <radialGradient id={`${id}-nucleus`} cx={C} cy={C} r={12} gradientUnits="userSpaceOnUse">
                <stop offset="0" className="ag-stop-white" />
                <stop offset="0.48" className="ag-stop-white" />
                <stop offset="0.72" className="ag-stop-hot" stopOpacity={0.8} />
                <stop offset="1" className="ag-stop-hot" stopOpacity={0} />
              </radialGradient>
              <filter id={`${id}-soft`} filterUnits="userSpaceOnUse" x="0" y="0" width="320" height="320">
                <feGaussianBlur stdDeviation="6" />
              </filter>
            </defs>
            <Ring r={SHELL_R} className="ag-line ag-shell" strokeWidth={1} strokeDasharray={SHELL} transform={`rotate(-50 ${C} ${C})`} />
            <Ring r={SHELL_R - 5} className="ag-hot ag-shell-inner" strokeWidth={0.5} />
            <Ring r={SHELL_R - 2} fill={`url(#${id}-sphere)`} className="ag-sphere" />
            <Ring r={17} className="ag-hot-fill ag-nucleus-glow" filter={`url(#${id}-soft)`} />
            <Ring r={12} fill={`url(#${id}-nucleus)`} className="ag-nucleus" />
          </svg>
          <svg className="ag-svg ag-spin ag-spin--iris" viewBox={VIEW} focusable="false">
            <path className="ag-hot ag-iris" d={IRIS_SPOKES.join("")} strokeWidth={0.7} />
            {IRIS_ARCS.map((d) => (
              <path key={d} className="ag-line ag-iris-arc" d={d} strokeWidth={1.1} />
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}

/** The floating launcher orb (a <button>). Positioned by its user through `className`. */
export function AgentLauncher({
  onClick,
  hidden = false,
  className = "",
  ref,
}: {
  onClick: () => void;
  hidden?: boolean;
  className?: string;
  /** Optional, so Agent mode can give focus back to the orb when it closes. */
  ref?: Ref<HTMLButtonElement>;
}) {
  const id = `agl${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className={`agent-launcher${hidden ? " agent-launcher--hidden" : ""} ${className}`}
      aria-label="Open VESPER Agent"
      title="VESPER Agent"
      inert={hidden}
    >
      <span className="agent-launcher__body" aria-hidden="true">
        <span className="agent-launcher__beacon" />
        <svg className="agent-launcher__svg agent-launcher__core" viewBox="0 0 64 64" focusable="false">
          <defs>
            <radialGradient id={`${id}-core`} cx="32" cy="32" r="18" gradientUnits="userSpaceOnUse">
              <stop offset="0" className="agl-stop-white" />
              <stop offset="0.22" className="agl-stop-hot" />
              <stop offset="0.5" className="agl-stop-cyan" stopOpacity={0.75} />
              <stop offset="1" className="agl-stop-blue" stopOpacity={0} />
            </radialGradient>
          </defs>
          <circle cx="32" cy="32" r="18" fill={`url(#${id}-core)`} />
          <circle cx="32" cy="32" r="4.4" className="agent-launcher__nucleus" />
        </svg>
        <svg className="agent-launcher__svg" viewBox="0 0 64 64" focusable="false">
          <circle cx="32" cy="32" r="26.5" className="agent-launcher__line" strokeWidth={0.7} strokeOpacity={0.35} />
          <circle
            cx="32"
            cy="32"
            r="24.5"
            className="agent-launcher__line"
            strokeWidth={2}
            strokeOpacity={0.4}
            strokeDasharray={`0.6 ${round((2 * Math.PI * 24.5) / 40 - 0.6)}`}
          />
        </svg>
        <svg className="agent-launcher__svg agent-launcher__ring" viewBox="0 0 64 64" focusable="false">
          <path
            className="agent-launcher__line"
            d="M32 11a21 21 0 0 1 18.19 10.5M50.19 42.5A21 21 0 0 1 13.81 42.5M13.81 21.5A21 21 0 0 1 22.6 13.2"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </svg>
      </span>
    </button>
  );
}
