"use client";

import { useId, useMemo, useState } from "react";

/**
 * Inline-SVG chart set.
 *
 * Conventions applied throughout (see docs/DECISIONS.md):
 *  - single measure per chart, one axis — never a dual y-scale
 *  - recessive grid and axes, thin marks, 2px strokes, >=8px hover targets
 *  - 4px rounded data-ends on bars, anchored to the baseline
 *  - direct labels on the values that matter rather than a number on every point
 *  - a crosshair + tooltip on every plotted form
 *  - colour comes from CSS variables so light/dark swap in one place; the
 *    palette was validated against this app's own surfaces with the dataviz
 *    validator (blue #2a78d6/#3987e5 primary, status hues fixed)
 *  - every chart degrades to an explicit empty state rather than an empty box
 */

const AXIS = "var(--chart-axis)";
const GRID = "var(--chart-grid)";
const MUTED = "var(--chart-muted)";
const SERIES = "var(--chart-series-1)";

export function ChartTheme({ children }: { children: React.ReactNode }) {
  return <div className="viz-root">{children}</div>;
}

function EmptyChart({ height, message }: { height: number; message: string }) {
  return (
    <div
      style={{
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--text-subtle)",
        fontSize: 12.5,
        border: "1px dashed var(--border)",
        borderRadius: 8,
      }}
    >
      {message}
    </div>
  );
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * Value formatting is selected by name, not by passing a function.
 *
 * These charts are rendered from React Server Components, and a function prop
 * cannot cross the server/client boundary — passing one throws at request time.
 * A string discriminant keeps the props serialisable.
 */
export type ValueFormat = "number" | "percent" | "currency" | "compact";

function formatValue(value: number, format: ValueFormat): string {
  switch (format) {
    case "percent":
      return `${Math.round(value * 100)}%`;
    case "currency":
      return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
    case "compact":
      return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
    default:
      return String(Math.round(value));
  }
}

function shortDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Line chart — change over time, one series
// ---------------------------------------------------------------------------

export interface LinePoint {
  label: string;
  value: number;
}

export function LineChart({
  data,
  height = 180,
  format = "number",
  yMax,
  emptyMessage = "No data for this period yet",
  areaFill = true,
}: {
  data: LinePoint[];
  height?: number;
  format?: ValueFormat;
  yMax?: number;
  emptyMessage?: string;
  areaFill?: boolean;
}) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);

  const geometry = useMemo(() => {
    if (data.length === 0) return null;
    const padding = { top: 12, right: 14, bottom: 24, left: 38 };
    const width = 640;
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const max = yMax ?? niceMax(Math.max(...data.map((d) => d.value), 0.0001));

    const x = (index: number) =>
      data.length === 1
        ? padding.left + plotWidth / 2
        : padding.left + (index / (data.length - 1)) * plotWidth;
    const y = (value: number) => padding.top + plotHeight - (value / max) * plotHeight;

    const points = data.map((d, i) => ({ ...d, x: x(i), y: y(d.value) }));
    const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const area =
      points.length > 1
        ? `${path} L${points[points.length - 1].x.toFixed(1)},${(padding.top + plotHeight).toFixed(1)} L${points[0].x.toFixed(1)},${(padding.top + plotHeight).toFixed(1)} Z`
        : "";

    return { padding, width, plotWidth, plotHeight, max, points, path, area };
  }, [data, height, yMax]);

  if (!geometry) return <EmptyChart height={height} message={emptyMessage} />;

  const { padding, width, plotHeight, max, points, path, area } = geometry;
  const ticks = [0, 0.5, 1].map((t) => ({
    value: max * t,
    y: padding.top + plotHeight - t * plotHeight,
  }));
  const active = hover !== null ? points[hover] : null;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height, display: "block", overflow: "visible" }}
      role="img"
      aria-label={`Line chart, ${data.length} points, latest ${formatValue(data[data.length - 1].value, format)}`}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={SERIES} stopOpacity="0.22" />
          <stop offset="100%" stopColor={SERIES} stopOpacity="0" />
        </linearGradient>
      </defs>

      {ticks.map((tick) => (
        <g key={tick.y}>
          <line
            x1={padding.left}
            x2={width - padding.right}
            y1={tick.y}
            y2={tick.y}
            stroke={GRID}
            strokeWidth="1"
          />
          <text x={padding.left - 7} y={tick.y + 3.5} textAnchor="end" fontSize="10" fill={MUTED}>
            {formatValue(tick.value, format)}
          </text>
        </g>
      ))}

      {areaFill && area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
      <path d={path} fill="none" stroke={SERIES} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

      {points.length <= 24
        ? points.map((point, i) => (
            <circle
              key={point.label}
              cx={point.x}
              cy={point.y}
              r={hover === i ? 4.5 : 3}
              fill="var(--surface)"
              stroke={SERIES}
              strokeWidth="2"
            />
          ))
        : null}

      {/* x labels: first, middle, last only — a label per point collides */}
      {[0, Math.floor(points.length / 2), points.length - 1]
        .filter((i, idx, arr) => points[i] && arr.indexOf(i) === idx)
        .map((i) => (
          <text
            key={`x-${i}`}
            x={points[i].x}
            y={height - 6}
            textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}
            fontSize="10"
            fill={MUTED}
          >
            {shortDay(points[i].label)}
          </text>
        ))}

      {active ? (
        <>
          <line
            x1={active.x}
            x2={active.x}
            y1={padding.top}
            y2={padding.top + plotHeight}
            stroke={AXIS}
            strokeWidth="1"
            strokeDasharray="3 3"
          />
          <circle cx={active.x} cy={active.y} r="5" fill={SERIES} stroke="var(--surface)" strokeWidth="2" />
          <g transform={`translate(${Math.min(Math.max(active.x, 60), width - 60)}, ${Math.max(active.y - 14, 14)})`}>
            <rect x="-56" y="-19" width="112" height="20" rx="5" fill="var(--surface)" stroke="var(--border-strong)" />
            <text x="0" y="-5" textAnchor="middle" fontSize="10.5" fill="var(--text)">
              {shortDay(active.label)} · {formatValue(active.value, format)}
            </text>
          </g>
        </>
      ) : null}

      {/* Invisible wide hit targets — bigger than the marks themselves */}
      {points.map((point, i) => (
        <rect
          key={`hit-${point.label}`}
          x={point.x - Math.max(8, geometry.plotWidth / points.length / 2)}
          y={padding.top}
          width={Math.max(16, geometry.plotWidth / points.length)}
          height={plotHeight}
          fill="transparent"
          onMouseEnter={() => setHover(i)}
        />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Bar chart — magnitude by category, one series
// ---------------------------------------------------------------------------

export function BarChart({
  data,
  height = 180,
  format = "number",
  emptyMessage = "No activity recorded yet",
  horizontal = false,
}: {
  data: LinePoint[];
  height?: number;
  format?: ValueFormat;
  emptyMessage?: string;
  horizontal?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (data.length === 0) return <EmptyChart height={height} message={emptyMessage} />;

  if (horizontal) {
    const max = Math.max(...data.map((d) => d.value), 1);
    return (
      <div style={{ display: "grid", gap: 8 }}>
        {data.map((item) => (
          <div key={item.label} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 12, marginBottom: 3, color: "var(--text)" }}>{item.label}</div>
              <div style={{ height: 8, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${Math.max(2, (item.value / max) * 100)}%`,
                    height: "100%",
                    background: SERIES,
                    borderRadius: 4,
                  }}
                />
              </div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: "tabular-nums", minWidth: 42, textAlign: "right" }}>
              {formatValue(item.value, format)}
            </span>
          </div>
        ))}
      </div>
    );
  }

  const padding = { top: 14, right: 10, bottom: 24, left: 34 };
  const width = 640;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const max = niceMax(Math.max(...data.map((d) => d.value), 1));
  // A 2px surface gap between adjacent bars.
  const slot = plotWidth / data.length;
  const barWidth = Math.max(3, Math.min(38, slot - 2));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", height, display: "block", overflow: "visible" }}
      role="img"
      aria-label={`Bar chart of ${data.length} periods`}
      onMouseLeave={() => setHover(null)}
    >
      {[0, 0.5, 1].map((t) => {
        const y = padding.top + plotHeight - t * plotHeight;
        return (
          <g key={t}>
            <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke={GRID} strokeWidth="1" />
            <text x={padding.left - 7} y={y + 3.5} textAnchor="end" fontSize="10" fill={MUTED}>
              {formatValue(max * t, format)}
            </text>
          </g>
        );
      })}

      {data.map((item, i) => {
        const barHeight = (item.value / max) * plotHeight;
        const x = padding.left + i * slot + (slot - barWidth) / 2;
        const y = padding.top + plotHeight - barHeight;
        return (
          <g key={item.label} onMouseEnter={() => setHover(i)}>
            <rect x={x - 1} y={padding.top} width={barWidth + 2} height={plotHeight} fill="transparent" />
            {item.value > 0 ? (
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(2, barHeight)}
                rx="4"
                fill={SERIES}
                opacity={hover === null || hover === i ? 1 : 0.45}
              />
            ) : null}
          </g>
        );
      })}

      {[0, Math.floor(data.length / 2), data.length - 1]
        .filter((i, idx, arr) => data[i] && arr.indexOf(i) === idx)
        .map((i) => (
          <text
            key={`x-${i}`}
            x={padding.left + i * slot + slot / 2}
            y={height - 6}
            textAnchor="middle"
            fontSize="10"
            fill={MUTED}
          >
            {shortDay(data[i].label)}
          </text>
        ))}

      {hover !== null ? (
        <g
          transform={`translate(${Math.min(
            Math.max(padding.left + hover * slot + slot / 2, 58),
            width - 58,
          )}, ${padding.top + plotHeight - (data[hover].value / max) * plotHeight - 8})`}
        >
          <rect x="-54" y="-19" width="108" height="20" rx="5" fill="var(--surface)" stroke="var(--border-strong)" />
          <text x="0" y="-5" textAnchor="middle" fontSize="10.5" fill="var(--text)">
            {shortDay(data[hover].label)} · {formatValue(data[hover].value, format)}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — trend shape inside a stat tile, no axes
// ---------------------------------------------------------------------------

export function Sparkline({
  values,
  width = 84,
  height = 24,
  tone = SERIES,
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: string;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const path = values
    .map((value, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((value - min) / range) * height;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} style={{ display: "block", overflow: "visible" }} aria-hidden="true">
      <path d={path} fill="none" stroke={tone} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Mastery meter — magnitude for one concept, with the value always labelled
// ---------------------------------------------------------------------------

export function MasteryMeter({
  level,
  previous,
  height = 8,
  showValue = true,
}: {
  level: number;
  previous?: number;
  height?: number;
  showValue?: boolean;
}) {
  const percent = Math.round(level * 100);
  const previousPercent = previous !== undefined ? Math.round(previous * 100) : null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <div
        style={{
          flex: 1,
          height,
          background: "var(--surface-2)",
          borderRadius: height / 2,
          position: "relative",
          overflow: "hidden",
        }}
        role="meter"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Mastery ${percent} percent`}
      >
        <div
          style={{
            width: `${Math.max(1.5, percent)}%`,
            height: "100%",
            background: SERIES,
            borderRadius: height / 2,
            transition: "width 400ms ease",
          }}
        />
        {previousPercent !== null && Math.abs(previousPercent - percent) > 2 ? (
          <div
            title={`Was ${previousPercent}%`}
            style={{
              position: "absolute",
              left: `${previousPercent}%`,
              top: 0,
              bottom: 0,
              width: 2,
              background: "var(--border-strong)",
            }}
          />
        ) : null}
      </div>
      {showValue ? (
        <span
          style={{
            fontSize: 12,
            fontWeight: 620,
            fontVariantNumeric: "tabular-nums",
            minWidth: 34,
            textAlign: "right",
          }}
        >
          {percent}%
        </span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Donut — one proportion against a whole, used for a single headline share
// ---------------------------------------------------------------------------

export function Donut({
  value,
  size = 96,
  label,
}: {
  value: number;
  size?: number;
  label?: string;
}) {
  const stroke = 9;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, value)) * circumference;

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={SERIES}
          strokeWidth={stroke}
          strokeDasharray={`${filled} ${circumference - filled}`}
          strokeLinecap="round"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span style={{ fontSize: 19, fontWeight: 660, fontVariantNumeric: "tabular-nums" }}>
          {Math.round(value * 100)}%
        </span>
        {label ? <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{label}</span> : null}
      </div>
    </div>
  );
}
