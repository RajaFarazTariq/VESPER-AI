/**
 * Spreadsheet results under an answer (v0.14.1): each calculation as a chart (when one suits it) or a table, with a
 * CSV download. The chart rules and the CSV live in lib/table-result.ts; this file draws them.
 *
 * Charts follow a few fixed rules: one figure per chart (a picker switches between several, never two scales on one
 * chart), thin marks on hairline gridlines, series colors in a fixed order (checked for color-blind separation and
 * contrast on the card in light and dark), text in the normal text colors, a hover/tap and keyboard readout, and a
 * Table view with every value.
 */
import { ChartBar, ChartLine, Download, Table2 } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import type { TableResultColumnDto, TableResultDto, ToolEventDto } from "../../shared/types";
import {
  axisLabel,
  cellText,
  chartMetrics,
  chartPlan,
  columnHeading,
  csvFileName,
  niceScale,
  resultCsv,
  resultHeading,
  resultNotes,
  shownResults,
  type BarsPlan,
  type ChartPlan,
  type LinePlan,
} from "../lib/table-result";

/** Series colors, in this order only (defined per theme in styles.css). */
const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
/** The line chart's whole height, the date labels under it included. */
const CHART_HEIGHT = 224;
/** Average width of an 11px label character: spaces the axis labels without measuring text. */
const CHAR = 6.6;
/** Bars shown before "Show all". */
const BAR_ROWS = 15;

export function TableResults({ tools }: { tools: ToolEventDto[] | null | undefined }) {
  const results = useMemo(() => shownResults(tools), [tools]);
  if (results.length === 0) return null;
  return (
    <div className="flex flex-col gap-2.5">
      {results.map((r, i) => (
        <ResultCard key={`${i}:${r.table}:${r.title}`} result={r} />
      ))}
    </div>
  );
}

/** Saves the result as a CSV file; a byte-order mark first, so Excel reads Urdu and other non-English text correctly. */
function downloadCsv(r: TableResultDto): void {
  const blob = new Blob(["﻿", resultCsv(r)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = csvFileName(r);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const chartValue = (v: number | null, column: TableResultColumnDto) => (v === null ? "no figure" : cellText(v, column, "chart"));
const clipText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function ResultCard({ result }: { result: TableResultDto }) {
  const charts = useMemo(
    () =>
      chartMetrics(result).flatMap((metric) => {
        const plan = chartPlan(result, metric);
        return plan ? [{ metric, plan }] : [];
      }),
    [result],
  );
  const [chosen, setChosen] = useState(0);
  const [view, setView] = useState<"chart" | "table">(charts.length ? "chart" : "table");
  const chart = charts[Math.min(chosen, charts.length - 1)];
  const showChart = view === "chart" && chart !== undefined;
  const heading = resultHeading(result);
  const notes = [...resultNotes(result), ...(showChart ? chart.plan.notes : [])];
  const Icon = !showChart ? Table2 : chart.plan.kind === "line" ? ChartLine : ChartBar;

  return (
    <section className="rise-in rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] text-sm" aria-label={heading.title}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 pt-2.5">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
          <Icon size={15} aria-hidden="true" />
        </span>
        {/* At least 11rem for the heading: on a phone the Chart/Table switch moves to its own line instead of squeezing it. */}
        <div className="min-w-[11rem] flex-1">
          <p className="break-words font-medium leading-snug">{heading.title}</p>
          <p className="truncate text-xs text-[var(--text-soft)]" title={heading.detail}>
            {heading.detail}
          </p>
        </div>
        {charts.length ? (
          <div className="ml-auto inline-flex shrink-0 rounded-lg border border-[var(--border)] p-0.5" role="group" aria-label="Show as">
            {(
              [
                ["chart", "Chart", chart?.plan.kind === "line" ? ChartLine : ChartBar],
                ["table", "Table", Table2],
              ] as const
            ).map(([value, label, ViewIcon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setView(value)}
                aria-pressed={view === value}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${
                  view === value ? "bg-[var(--bg-hover)] font-medium text-[var(--text)]" : "text-[var(--text-soft)] hover:text-[var(--text)]"
                }`}
              >
                <ViewIcon size={13} aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="px-3 py-2.5">
        {showChart && charts.length > 1 ? (
          <div className="mb-2.5 flex flex-wrap gap-1.5" role="group" aria-label="Figure shown">
            {charts.map((c, i) => (
              <button
                key={c.metric}
                type="button"
                onClick={() => setChosen(i)}
                aria-pressed={c === chart}
                className={`max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs ${
                  c === chart
                    ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "border-[var(--border)] text-[var(--text-soft)] hover:text-[var(--text)]"
                }`}
              >
                {columnHeading(result.columns[c.metric]!)}
              </button>
            ))}
          </div>
        ) : null}
        {showChart ? (
          <Chart plan={chart.plan} column={result.columns[chart.metric]!} title={heading.title} />
        ) : (
          <DataTable result={result} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--border)] px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-[var(--text-soft)]">{notes.join(" ")}</p>
        <button
          type="button"
          onClick={() => downloadCsv(result)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
          title={`Download ${result.rows.length.toLocaleString()} row${result.rows.length === 1 ? "" : "s"} as a CSV file (opens in Excel)`}
        >
          <Download size={13} aria-hidden="true" />
          Download CSV
        </button>
      </div>
    </section>
  );
}

function Chart({ plan, column, title }: { plan: ChartPlan; column: TableResultColumnDto; title: string }) {
  return plan.kind === "line" ? <LineChart plan={plan} column={column} title={title} /> : <BarList plan={plan} column={column} title={title} />;
}

// ------------------------------------------------------------------ line chart

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** An SVG path through the values; a gap (null) lifts the pen. */
function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** Values with no neighbor on either side: drawn as dots, since a line needs two points. */
const lonely = (values: (number | null)[]) =>
  values.flatMap((v, i) => (v !== null && (i === 0 || values[i - 1] === null) && (i === values.length - 1 || values[i + 1] === null) ? [i] : []));

function LineChart({ plan, column, title }: { plan: LinePlan; column: TableResultColumnDto; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const width = useWidth(box);
  const [active, setActive] = useState<number | null>(null);
  const n = plan.points.length;
  const last = n - 1;
  const multi = plan.series.length > 1;
  const metricName = columnHeading(column);

  const g = useMemo(() => {
    const values = plan.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
    let min = Math.min(...values);
    let max = Math.max(...values);
    // Counts and sums start at 0 (an honest size), as does anything near or below 0; averages may zoom in.
    const zero = plan.additive || min <= 0 || min < max / 2;
    if (zero) {
      min = Math.min(0, min);
      max = Math.max(0, max);
    }
    const scale = niceScale(min, max);
    const maxAbs = Math.max(Math.abs(scale.lo), Math.abs(scale.hi));
    const ticks = scale.ticks.map((t) => ({ value: t, text: axisLabel(t, maxAbs, column.unit) }));
    const top = 10;
    const plotH = CHART_HEIGHT - top - 26;
    const y = (v: number) => top + ((scale.hi - v) / (scale.hi - scale.lo)) * plotH;
    const left = Math.ceil(Math.max(...ticks.map((t) => t.text.length)) * CHAR) + 12;
    // At the right end: the series names (several lines) or the last value (one line), when there's room and they
    // don't run into each other; otherwise the legend and the readout carry them.
    let ends: { text: string; y: number }[] = [];
    if (width >= 440) {
      const found = plan.series.map((s) => {
        const v = s.values[last];
        return v === null || v === undefined ? null : { text: multi ? clipText(s.name ?? "", 16) : chartValue(v, column), y: y(v) };
      });
      const all = found.filter((e): e is { text: string; y: number } => e !== null);
      const sorted = [...all].sort((a, b) => a.y - b.y);
      if (all.length === found.length && sorted.every((e, i) => i === 0 || e.y - sorted[i - 1]!.y >= 14)) ends = all;
    }
    const right = ends.length ? Math.ceil(Math.max(...ends.map((e) => e.text.length)) * CHAR) + 16 : 14;
    const plotW = Math.max(40, width - left - right);
    const spacing = plotW / Math.max(1, last);
    const x = (i: number) => left + i * spacing;
    // Date labels: as many as fit side by side, evenly spaced; the last one too when it has room.
    const labelW = Math.max(...plan.points.map((p) => p.short.length)) * CHAR + 16;
    const step = Math.max(1, Math.ceil(labelW / spacing));
    const xLabels: number[] = [];
    for (let i = 0; i <= last; i += step) xLabels.push(i);
    if (xLabels.at(-1) !== last && (last - xLabels.at(-1)!) * spacing >= labelW) xLabels.push(last);
    const area = !multi && zero && plan.series[0]!.values.every((v) => v !== null);
    return { scale, ticks, top, plotH, y, left, plotW, spacing, x, ends, xLabels, area };
  }, [plan, column, width, last, multi]);

  const pick = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    setActive(Math.max(0, Math.min(last, Math.round((e.clientX - rect.left - g.left) / g.spacing))));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (move) {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(last, a === null ? (move > 0 ? 0 : last) : a + move)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : last);
    } else if (e.key === "Escape") setActive(null);
  };
  const readout = (i: number) =>
    `${plan.points[i]!.label}: ${plan.series.map((s) => `${s.name ? `${s.name} ` : ""}${chartValue(s.values[i] ?? null, column)}`).join(", ")}`;
  const zeroY = g.y(Math.max(g.scale.lo, Math.min(0, g.scale.hi)));

  return (
    <div>
      {multi ? (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-soft)]" aria-label="Lines">
          {plan.series.map((s, k) => (
            <li key={k} className="flex min-w-0 items-center gap-1.5">
              <span className="h-0.5 w-3.5 shrink-0 rounded-full" style={{ background: SERIES[k] }} aria-hidden="true" />
              <span className="truncate">{s.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <div
        ref={box}
        className="relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        style={{ height: CHART_HEIGHT }}
        tabIndex={0}
        role="group"
        aria-label={`Line chart: ${title}. ${n} points from ${plan.points[0]!.label} to ${plan.points[last]!.label}. Use the left and right arrow keys to read the values, or switch to Table.`}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
      >
        {width > 0 ? (
          <svg width={width} height={CHART_HEIGHT} className="block overflow-visible" aria-hidden="true">
            {g.ticks.map((t) => (
              <g key={t.value}>
                <line
                  x1={g.left}
                  x2={g.left + g.plotW}
                  y1={g.y(t.value)}
                  y2={g.y(t.value)}
                  style={{ stroke: t.value === 0 || t.value === g.scale.lo ? "var(--border-strong)" : "var(--border)" }}
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text x={g.left - 8} y={g.y(t.value)} textAnchor="end" dominantBaseline="middle" fontSize={11} className="tabular-nums" style={{ fill: "var(--text-soft)" }}>
                  {t.text}
                </text>
              </g>
            ))}
            {g.xLabels.map((i) => (
              <text
                key={i}
                x={g.x(i)}
                y={g.top + g.plotH + 17}
                textAnchor={i === 0 && last > 0 ? "start" : i === last ? "end" : "middle"}
                fontSize={11}
                style={{ fill: "var(--text-soft)" }}
              >
                {plan.points[i]!.short}
              </text>
            ))}
            {g.area ? (
              <path
                d={`${linePath(plan.series[0]!.values, g.x, g.y)}L${g.x(last).toFixed(1)} ${zeroY.toFixed(1)}L${g.x(0).toFixed(1)} ${zeroY.toFixed(1)}Z`}
                style={{ fill: SERIES[0], fillOpacity: 0.1 }}
              />
            ) : null}
            {plan.series.map((s, k) => (
              <g key={k} style={{ color: SERIES[k] }}>
                <path d={linePath(s.values, g.x, g.y)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                {lonely(s.values).map((i) => (
                  <circle key={i} cx={g.x(i)} cy={g.y(s.values[i]!)} r={3} fill="currentColor" />
                ))}
                {s.values[last] !== null && active === null ? (
                  <circle cx={g.x(last)} cy={g.y(s.values[last]!)} r={4} fill="currentColor" strokeWidth={2} style={{ stroke: "var(--bg-elevated)" }} />
                ) : null}
              </g>
            ))}
            {g.ends.map((e, k) => (
              <text key={k} x={g.x(last) + 9} y={e.y} dominantBaseline="middle" fontSize={11} className="tabular-nums" style={{ fill: "var(--text-soft)" }}>
                {e.text}
              </text>
            ))}
            {active !== null ? (
              <g>
                <line x1={g.x(active)} x2={g.x(active)} y1={g.top} y2={g.top + g.plotH} strokeWidth={1} style={{ stroke: "var(--border-strong)" }} />
                {plan.series.map((s, k) =>
                  s.values[active] === null ? null : (
                    <circle key={k} cx={g.x(active)} cy={g.y(s.values[active]!)} r={4} strokeWidth={2} style={{ fill: SERIES[k], stroke: "var(--bg-elevated)" }} />
                  ),
                )}
              </g>
            ) : null}
            <rect
              x={g.left}
              y={g.top}
              width={g.plotW}
              height={g.plotH}
              fill="transparent"
              className="touch-pan-y"
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={(e) => {
                if (e.pointerType === "mouse") setActive(null);
              }}
            />
          </svg>
        ) : null}
        {active !== null && width > 0 ? (
          <div
            className="pointer-events-none absolute top-1 z-10 max-w-[min(18rem,75%)] rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs shadow-[var(--shadow-md)]"
            style={g.x(active) > width / 2 ? { left: g.x(active) - 12, transform: "translateX(-100%)" } : { left: g.x(active) + 12 }}
          >
            <div className="mb-0.5 text-[var(--text-soft)]">{plan.points[active]!.label}</div>
            {plan.series.map((s, k) => (
              <div key={k} className="flex items-center gap-2">
                <span className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: SERIES[k] }} />
                <span className="shrink-0 font-semibold tabular-nums text-[var(--text)]">{chartValue(s.values[active] ?? null, column)}</span>
                <span className="min-w-0 truncate text-[var(--text-soft)]">{s.name ?? metricName}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="sr-only" aria-live="polite">
          {active !== null ? readout(active) : ""}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ bars

function BarList({ plan, column, title }: { plan: BarsPlan; column: TableResultColumnDto; title: string }) {
  const [all, setAll] = useState(false);
  const items = all ? plan.items : plan.items.slice(0, BAR_ROWS);
  const numbers = plan.items.map((i) => i.value).filter((v): v is number => v !== null);
  const lo = Math.min(0, ...numbers);
  const hi = Math.max(0, ...numbers);
  const span = hi - lo || 1;
  const zero = (-lo / span) * 100;
  const texts = items.map((i) => chartValue(i.value, column));
  // An empty figure shows as "–" (read out as "no figure"), so it doesn't widen the column of figures.
  const valueWidth = Math.max(...items.map((item, k) => (item.value === null ? 1 : texts[k]!.length))) + 1;

  return (
    <div>
      <ul className="flex flex-col" aria-label={`Bar chart: ${title}`}>
        {items.map((item, k) => {
          const v = item.value;
          const width = v === null ? 0 : (Math.abs(v) / span) * 100;
          const start = v !== null && v < 0 ? zero - width : zero;
          return (
            <li
              key={k}
              className="grid items-center gap-x-3 rounded-md px-1.5 py-[5px] hover:bg-[var(--bg-hover)]"
              style={{ gridTemplateColumns: `minmax(0, 34%) minmax(0, 1fr) ${valueWidth}ch` }}
              title={`${item.label}: ${texts[k]}`}
            >
              <span className={`truncate text-[13px] ${item.label === "(empty)" ? "italic text-[var(--text-soft)]" : ""}`}>{item.label}</span>
              <span className="relative block h-3.5" aria-hidden="true">
                {lo < 0 ? <span className="absolute -inset-y-1 w-px bg-[var(--border-strong)]" style={{ left: `${zero}%` }} /> : null}
                {v !== null && v !== 0 ? (
                  <span
                    className={`absolute inset-y-0 bg-[var(--chart-1)] ${v < 0 ? "rounded-l-[4px]" : "rounded-r-[4px]"}`}
                    style={{ left: `${start}%`, width: `max(2px, ${width}%)` }}
                  />
                ) : null}
              </span>
              {v === null ? (
                <span className="text-right text-[13px] text-[var(--text-faint)]">
                  <span aria-hidden="true">–</span>
                  <span className="sr-only">{texts[k]}</span>
                </span>
              ) : (
                <span className="text-right text-[13px] font-medium tabular-nums">{texts[k]}</span>
              )}
            </li>
          );
        })}
      </ul>
      {plan.items.length > BAR_ROWS ? (
        <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 rounded-md px-1.5 py-0.5 text-xs text-[var(--accent)] hover:underline">
          {all ? "Show fewer" : `Show all ${plan.items.length.toLocaleString()}`}
        </button>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ table

const alignRight = (c: TableResultColumnDto) => c.type === "number" && !(c.kind === "group" && c.by && c.by !== "value");

function DataTable({ result }: { result: TableResultDto }) {
  return (
    <div className="thin-scroll max-h-80 overflow-auto rounded-lg border border-[var(--border)]">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 z-[1] bg-[var(--bg-soft)]">
          <tr>
            {result.columns.map((c, i) => (
              <th
                key={i}
                scope="col"
                className={`whitespace-nowrap border-b border-[var(--border)] px-3 py-1.5 font-medium ${alignRight(c) ? "text-right" : "text-left"}`}
              >
                {columnHeading(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, r) => (
            <tr key={r} className="border-b border-[var(--border)] last:border-0">
              {result.columns.map((c, i) => {
                const v = row[i] ?? null;
                const text = cellText(v, c, "table");
                const empty = v === null && c.kind === "group";
                return (
                  <td
                    key={i}
                    className={`max-w-[20rem] truncate px-3 py-1 ${alignRight(c) ? "text-right tabular-nums" : ""} ${empty ? "italic text-[var(--text-soft)]" : ""}`}
                    title={text.length > 40 ? text : undefined}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
