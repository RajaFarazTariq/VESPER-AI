import { useId, type CSSProperties } from "react";

/**
 * The VESPER mark (faceted-blade V, v0.12.1), drawn inline so it follows the app theme (v0.12.2): a bright tile with
 * dark-ink and violet blades in light mode, the dark tile with white and violet blades in dark mode. Colours are the
 * --vm-* variables in styles.css (the sign-in brand panel, always dark, uses the dark ones).
 * `full` is the detailed mark for large sizes (dotted second orbit, corner dots); the default is simplified so it
 * still reads at 16–32 px.
 */
export function VesperMark({ full = false, className = "" }: { full?: boolean; className?: string }) {
  const gradient = `vm-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const fill = (name: string): CSSProperties => ({ fill: `var(--vm-${name})` });
  const stroke = (name: string): CSSProperties => ({ stroke: `var(--vm-${name})` });
  const tile = (
    <defs>
      <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" style={{ stopColor: "var(--vm-tile-a)" }} />
        <stop offset="1" style={{ stopColor: "var(--vm-tile-b)" }} />
      </linearGradient>
    </defs>
  );

  if (full) {
    return (
      <svg viewBox="0 0 120 120" className={`vmark ${className}`} aria-hidden="true" focusable="false">
        {tile}
        <rect x="1.5" y="1.5" width="117" height="117" rx="27" fill={`url(#${gradient})`} strokeWidth="1.5" style={stroke("edge")} />
        <g style={fill("dot")}>
          <circle cx="19" cy="21" r="1.2" />
          <circle cx="24" cy="17" r=".9" />
          <circle cx="101" cy="99" r="1.2" />
          <circle cx="96" cy="103" r=".9" />
        </g>
        <ellipse cx="62" cy="71" rx="37" ry="9" transform="rotate(-12 62 71)" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeDasharray=".1 4" style={stroke("cyan-soft")} />
        <path d="M33 30h4l22 65-2 1z" style={fill("blade-l1")} />
        <path d="M37 30h4l20 64-2 1z" style={fill("blade-l2")} />
        <path d="M74 30h7L60 95l-2-1z" style={fill("blade-r1")} />
        <path d="M81 30h7L62 96l-2-1z" style={fill("blade-r2")} />
        <path d="M37 24.5V30M81 24.5V30" strokeWidth="2" strokeLinecap="round" style={stroke("cyan")} />
        <circle cx="37" cy="19.5" r="4.8" strokeWidth="2.6" style={{ ...fill("node"), ...stroke("cyan") }} />
        <circle cx="81" cy="19.5" r="4.8" strokeWidth="2.6" style={{ ...fill("node"), ...stroke("cyan") }} />
        <ellipse cx="60" cy="62" rx="45" ry="12" transform="rotate(-12 60 62)" fill="none" strokeWidth="2.6" style={stroke("cyan")} />
        <circle cx="16" cy="71.4" r="3.2" style={fill("cyan")} />
        <path d="M104 46.1Q105.2 51.4 110.5 52.6Q105.2 53.8 104 59.1Q102.8 53.8 97.5 52.6Q102.8 51.4 104 46.1Z" style={fill("spark")} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 64 64" className={`vmark ${className}`} aria-hidden="true" focusable="false">
      {tile}
      <rect x="1" y="1" width="62" height="62" rx="14" fill={`url(#${gradient})`} strokeWidth="1" style={stroke("edge")} />
      <path d="M13.5 14H19l12.5 38.5-2 .7z" style={fill("blade-l1")} />
      <path d="M19 14h5l9 37.8-1.5.7z" style={fill("blade-l2")} />
      <path d="M38 14h6.5L32 52.5l-1.6-.7z" style={fill("blade-r1")} />
      <path d="M44.5 14H51L33.6 53.2 32 52.5z" style={fill("blade-r2")} />
      <circle cx="19" cy="9" r="3" strokeWidth="2" style={{ ...fill("node"), ...stroke("cyan") }} />
      <circle cx="44.5" cy="9" r="3" strokeWidth="2" style={{ ...fill("node"), ...stroke("cyan") }} />
      <ellipse cx="32" cy="34" rx="25" ry="6.5" transform="rotate(-12 32 34)" fill="none" strokeWidth="1.9" style={stroke("cyan")} />
      <path d="M55.5 24.5Q56.1 27.4 59 28Q56.1 28.6 55.5 31.5Q54.9 28.6 52 28Q54.9 27.4 55.5 24.5Z" style={fill("spark")} />
    </svg>
  );
}
